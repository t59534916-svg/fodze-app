"""
train_m3_xg.py — Train m3_xg (LightGBM Tweedie + 5-seed Bayesian Ensemble).

Per V4-BACKTESTING-PROTOCOL §"m3_xg":
  - Data: team_xg_history from local SQLite, cutoff at --cutoff date
  - Features: m2_lambda outputs (λ_h, λ_a) + per-Liga categorical
  - Target: actual goals_for / goals_against (Tweedie objective)
  - Architecture: 5-seed bagged LightGBM (one ensemble for home_goals,
                  one for away_goals)
  - Output: artifacts/m3_xg-home-{tag}.pkl, m3_xg-away-{tag}.pkl, manifest JSON

Usage:
  tools/venv/bin/python3 -I tools/v4/train_m3_xg.py
  tools/venv/bin/python3 -I tools/v4/train_m3_xg.py --cutoff 2025-08-01 --leagues bundesliga,epl
  tools/venv/bin/python3 -I tools/v4/train_m3_xg.py --since 2022-01-01 --tag v0.1.0

Exit codes:
  0 — training complete, artifacts saved
  1 — training failed (insufficient data, fit error, etc.)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.modules.m3_xg import (
    BayesianEnsemble,
    DEFAULT_LGB_PARAMS,
    MarketDisagreementCalculator,
    NUMERIC_FEATURES,
    PlayerLineupCalculator,
    build_features_for_corpus,
    extract_X,
)
from v4.modules.m3_xg.market_disagreement import HIGH_DISAGREEMENT_THRESHOLD

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train m3_xg Bayesian Ensemble")
    p.add_argument("--cutoff", default="2025-08-01",
                   help="Train on matches with match_date < cutoff (default 2025-08-01)")
    p.add_argument("--since", default="2017-01-01",
                   help="Train on matches with match_date >= since (default 2017-01-01)")
    p.add_argument("--leagues", default=None,
                   help="Comma-separated list of leagues (default: all 22)")
    p.add_argument("--tag", default=None,
                   help="Artifact tag (default: timestamp YYYYMMDD-HHMM)")
    p.add_argument("--n-models", type=int, default=5,
                   help="Number of bagged models in ensemble (default 5)")
    p.add_argument("--seed-offset", type=int, default=0,
                   help="Add this offset to the default seed-list [42, 43, 44, 45, 46]. "
                        "Used by dev03_multi_seed_bootstrap.py to produce N independent "
                        "ensembles for empirical inter-seed Brier variance measurement. "
                        "Example: --seed-offset 100 → seeds=[142,143,144,145,146].")
    p.add_argument("--features-locked", action="store_true",
                   help="Constrain feature set to dev-03 production schema "
                        "(16 numeric + league = 17 total). Required for compatibility "
                        "with export_dev03_to_json.py::FEATURES_LOCKED. "
                        "Excludes 4 dev-04/05 additions (market_disagreement_*, "
                        "lineup_quality_player_*) which need 5-Gate-Falsification first.")
    p.add_argument("--dry-run", action="store_true",
                   help="Build features but skip training + save (verify data flow only)")
    return p.parse_args()


# dev-03 production schema (mirrors tools/v4/export_dev03_to_json.py::FEATURES_LOCKED).
# Keep this list in sync with that constant. Adding a feature requires:
#   1. Add to FEATURES_LOCKED (export script)
#   2. Add to dev03-features.ts (TS runtime)
#   3. Regenerate golden fixtures via stage_1_m3_xg.py
#   4. Run 5-Gate Falsification before claiming improvement
DEV_03_LOCKED_FEATURES = [
    "home_attack_ratio",
    "home_defense_ratio",
    "away_attack_ratio",
    "away_defense_ratio",
    "home_ess",
    "away_ess",
    "league_home_avg",
    "league_away_avg",
    "league_home_advantage",
    "lambda_h_naive",
    "lambda_a_naive",
    "attack_defense_ratio_h",
    "attack_defense_ratio_a",
    "elo_diff",
    "lineup_quality_diff",
    "form_streak_diff",
]


def main() -> int:
    args = parse_args()
    leagues = args.leagues.split(",") if args.leagues else None
    tag = args.tag or datetime.now().strftime("%Y%m%d-%H%M")

    print("=" * 70)
    print(f"V4 m3_xg training run · tag={tag}")
    print("=" * 70)
    print(f"  cutoff:  {args.cutoff}")
    print(f"  since:   {args.since}")
    print(f"  leagues: {leagues if leagues else 'ALL'}")
    print(f"  n_models: {args.n_models}")
    print(f"  dry_run: {args.dry_run}")
    print()

    # ─────────── Load data ───────────
    t0 = time.time()
    history = load_team_xg_history(leagues=leagues)
    matches = load_match_pairs(cutoff=args.cutoff, since=args.since, leagues=leagues)
    matches = matches.dropna(subset=["home_goals", "away_goals"])
    print(f"  Loaded: {len(history):,} history rows, {len(matches):,} settled matches  "
          f"({time.time()-t0:.1f}s)")

    if len(matches) < 500:
        print(f"  ✗ ERROR: only {len(matches)} settled matches — need ≥ 500 to train")
        return 1

    # ─────────── Build features (with Elo on full history) ───────────
    from v4.modules.m3_xg.elo import EloCalculator
    t0 = time.time()
    print(f"  Fitting EloCalculator on {len(history):,} history rows...")
    elo = EloCalculator().fit(history)
    elo_stats = elo.stats()
    print(f"    Elo stats: mean={elo_stats['mean']:.0f}, "
          f"std={elo_stats['std']:.0f}, range=[{elo_stats['min']:.0f}, "
          f"{elo_stats['max']:.0f}], n_teams={elo_stats['n_team_league_pairs']}")
    print(f"    Done in {time.time()-t0:.1f}s")

    # Market disagreement calculator (dev-04+) — loads Pinnacle closing odds from parquets
    t0 = time.time()
    odds_paths = [
        REPO_ROOT / "tools" / "backtest" / "odds-close-oot.parquet",
        REPO_ROOT / "tools" / "backtest" / "odds-close-24-25.parquet",
        REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet",
    ]
    print(f"  Fitting MarketDisagreementCalculator on {len(odds_paths)} odds parquets...")
    mdc = MarketDisagreementCalculator().fit(odds_paths=odds_paths)
    mdc_stats = mdc.stats()
    print(f"    MDC stats: n_loaded={mdc_stats['n_loaded']:,}, "
          f"n_unique={mdc_stats['n_unique']:,}, threshold={mdc_stats['threshold']}")
    print(f"    Done in {time.time()-t0:.1f}s")

    # Player-lineup calculator (dev-05+) — loads from local SQLite mirror
    t0 = time.time()
    sqlite_mirror = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
    print(f"  Fitting PlayerLineupCalculator on {sqlite_mirror.name}...")
    plc = PlayerLineupCalculator(sqlite_mirror)
    if sqlite_mirror.exists():
        plc.fit()
        plc_stats = plc.stats()
        print(f"    PlayerLineup stats: n_players={plc_stats['n_players']:,}, "
              f"n_team_matches={plc_stats['n_team_match_pairs']:,}, "
              f"leagues_normed={plc_stats['leagues_with_norms']}")
    else:
        print(f"    ⚠ SQLite mirror not found — player_lineup features will be all-zero")
        plc._fitted = True
    print(f"    Done in {time.time()-t0:.1f}s")

    t0 = time.time()
    features = build_features_for_corpus(
        matches, history,
        elo_calculator=elo,
        disagreement_calculator=mdc,
        player_lineup_calculator=plc,
        verbose=True,
    )
    print(f"  Built {len(features):,} feature rows in {time.time()-t0:.1f}s")
    # Diagnostic: how many training matches got a non-zero disagreement signal?
    n_with_disag = int((features["market_disagreement_flag"] > 0.0).sum())
    n_high_disag = int((features["market_disagreement_high"] > 0.0).sum())
    print(f"  Disagreement coverage: {n_with_disag:,}/{len(features):,} "
          f"({100*n_with_disag/len(features):.1f}%) have market odds; "
          f"{n_high_disag:,} flagged HIGH (>{HIGH_DISAGREEMENT_THRESHOLD*100:.0f}%)")
    n_plq_avail = int((features["lineup_quality_player_available"] > 0.0).sum())
    print(f"  Player-lineup coverage: {n_plq_avail:,}/{len(features):,} "
          f"({100*n_plq_avail/len(features):.1f}%) have player-level signal (Top-5 + history)")
    # Select feature schema: locked (dev-03 prod, 17 cols) or full (current, 21 cols)
    if args.features_locked:
        active_numeric = DEV_03_LOCKED_FEATURES
        schema_label = "LOCKED (dev-03 prod schema, 16 numeric + league)"
    else:
        active_numeric = NUMERIC_FEATURES
        schema_label = f"FULL (current evolving schema, {len(NUMERIC_FEATURES)} numeric + league)"
    print(f"  Feature schema: {schema_label}")
    print(f"  Feature stats (numeric):")
    summary = features[active_numeric].describe().loc[["mean", "min", "max"]].round(3)
    for col in active_numeric:
        print(f"    {col:<28} mean={summary.loc['mean', col]:>7.3f}  "
              f"min={summary.loc['min', col]:>7.3f}  max={summary.loc['max', col]:>7.3f}")
    print(f"  Target stats: home_goals mean={features['home_goals'].mean():.2f}, "
          f"away_goals mean={features['away_goals'].mean():.2f}")
    print()

    # ─────────── Prepare X / y / categorical ───────────
    # When --features-locked: hand-build X with locked schema. Otherwise use canonical
    # extract_X (defends against accidental match_date / future-col leakage).
    if args.features_locked:
        X = features[active_numeric + ["league"]].copy()
    else:
        X = extract_X(features)
    y_h = features["home_goals"].values
    y_a = features["away_goals"].values

    if args.dry_run:
        print("  --dry-run: skipping training + save")
        return 0

    # ─────────── Train home-goals ensemble ───────────
    t0 = time.time()
    print(f"  Training home-goals ensemble (n_models={args.n_models})...")
    ens_h = BayesianEnsemble(n_models=args.n_models, seeds=[42 + i + args.seed_offset for i in range(args.n_models)])
    ens_h.fit(X, y_h, categorical_columns=["league"])
    print(f"    Done in {time.time()-t0:.1f}s")

    # In-sample sanity check
    mean_h, var_h = ens_h.predict(X)
    print(f"    In-sample home λ: mean={mean_h.mean():.2f}, "
          f"avg-σ²={var_h.mean():.4f}, p95-σ²={np.percentile(var_h, 95):.4f}")

    # ─────────── Train away-goals ensemble ───────────
    t0 = time.time()
    print(f"  Training away-goals ensemble (n_models={args.n_models})...")
    ens_a = BayesianEnsemble(n_models=args.n_models, seeds=[42 + i + args.seed_offset for i in range(args.n_models)])
    ens_a.fit(X, y_a, categorical_columns=["league"])
    print(f"    Done in {time.time()-t0:.1f}s")

    mean_a, var_a = ens_a.predict(X)
    print(f"    In-sample away λ: mean={mean_a.mean():.2f}, "
          f"avg-σ²={var_a.mean():.4f}, p95-σ²={np.percentile(var_a, 95):.4f}")

    # ─────────── Save artifacts ───────────
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    manifest_path = ARTIFACTS_DIR / f"m3_xg-{tag}.json"

    ens_h.save(home_path)
    ens_a.save(away_path)

    manifest = {
        "tag": tag,
        "trained_at": datetime.now().isoformat(),
        "cutoff": args.cutoff,
        "since": args.since,
        "leagues": leagues if leagues else "ALL",
        "n_models": args.n_models,
        "n_train_matches": len(matches),
        "features_locked": bool(args.features_locked),
        "n_features": len(active_numeric),
        "feature_names": active_numeric + ["league"],
        "categorical_features": ["league"],
        "lgb_params": DEFAULT_LGB_PARAMS,
        # NOTE: these are TRAINING-SET diagnostics (in-sample), not validation.
        # Honest evaluation lives in pipeline/stage_1_m3_xg.py against 25/26 holdout.
        # Use these only for sanity (mean λ close to mean goals; non-degenerate σ²).
        "training_set_diagnostics": {
            "_warning": "in-sample only — NOT a validation metric. See stage_1_m3_xg.py.",
            "home_lambda_mean": float(mean_h.mean()),
            "home_target_mean": float(y_h.mean()),
            "home_avg_variance": float(var_h.mean()),
            "home_p95_variance": float(np.percentile(var_h, 95)),
            "away_lambda_mean": float(mean_a.mean()),
            "away_target_mean": float(y_a.mean()),
            "away_avg_variance": float(var_a.mean()),
            "away_p95_variance": float(np.percentile(var_a, 95)),
        },
        "artifacts": {
            "home_ensemble": str(home_path.relative_to(REPO_ROOT)),
            "away_ensemble": str(away_path.relative_to(REPO_ROOT)),
        },
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print()
    print(f"  ✓ Artifacts saved:")
    print(f"    {home_path.relative_to(REPO_ROOT)}")
    print(f"    {away_path.relative_to(REPO_ROOT)}")
    print(f"    {manifest_path.relative_to(REPO_ROOT)}")
    print()
    print("=" * 70)
    print(f"✓ Training complete · tag={tag}")
    print(f"  Next: run pipeline/stage_1_m3_xg.py to evaluate vs v2 baseline")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

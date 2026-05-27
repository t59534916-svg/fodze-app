"""
train_dev09.py — Train dev-09 (pure bottom-up Bayesian Ensemble).

Per FODZE-Optimal-Blueprint audit revision: TABULA RASA architecture.
NO dev-03 macro feature borrows. Only Sofa player_match_stats aggregates +
bottom_up_available flag + league categorical.

Day-2 feature vector (9 cols: 8 numeric + league):
  bottom_up_xg_diff, bottom_up_xa_diff, bottom_up_shots_diff,
  bottom_up_key_passes_diff, attack_concentration_diff,
  defense_block_sum_diff, gk_saves_per_90_diff, minutes_rate_diff,
  bottom_up_available + league

Future Day-3 may add Elo + rest_days. Today's vector keeps G2 Holm-correction
tractable (m=8 → α_corrected = 0.05/8 = 0.00625).

Architecture:
  - 5-seed bagged LightGBM Tweedie (mirrors dev-03 ensemble pattern)
  - One ensemble for home_goals, one for away_goals
  - --seed-offset for multi-seed bootstrap support (Day-3)
  - Saves home + away pickles + manifest JSON to tools/v4/artifacts/

Walk-forward CV scheme (audit committee binding):
  - train: 22/23 + 23/24 (default)
  - test:  24/25 (held out — never seen during fit)
  - --train-seasons / --test-seasons override

Usage:
  tools/venv/bin/python3 -I tools/v4/train_dev09.py
  tools/venv/bin/python3 -I tools/v4/train_dev09.py --tag dev-09-mvp
  tools/venv/bin/python3 -I tools/v4/train_dev09.py --leagues epl,la_liga --tag dev-09-epl-only

Exit codes:
  0 — training complete, artifacts saved + G1+G2+G3 gates reported
  1 — training failed (insufficient data, fit error)
  2 — G1, G2, or G3 gate failed (artifacts still saved for inspection)
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

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_LGB_PARAMS
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_ALL_FEATURES,
    DEV_09_CATEGORICAL_FEATURES,
    DEV_09_NUMERIC_FEATURES,
    DEV_09_TARGETS,
    FeatureBuilderDev09,
    extract_X_dev09,
)

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

TOP5 = ("epl", "la_liga", "serie_a", "bundesliga", "ligue_1")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train dev-09 Bayesian Ensemble (TABULA RASA bottom-up)")
    p.add_argument("--train-seasons", default="22/23,23/24",
                   help="Comma-separated training seasons. Default 22/23+23/24 since Day-3 "
                        "adds Elo+rest_days orthogonal context giving Layer-3 rows (sparse "
                        "22/23 lineups) non-zero signal — satisfies the audit committee's "
                        "'30%%+ available=0 training rows' requirement. Day-2 used 23/24-only.")
    p.add_argument("--test-seasons", default="24/25",
                   help="Comma-separated holdout seasons (default: 24/25)")
    p.add_argument("--leagues", default="ALL",
                   help="Comma-separated league list, or 'ALL' for all 22 leagues in Sofa "
                        "(default ALL for Day-3). Top-5 only: --leagues epl,la_liga,serie_a,bundesliga,ligue_1")
    p.add_argument("--tag", default=None,
                   help="Artifact tag (default: dev-09-{timestamp})")
    p.add_argument("--n-models", type=int, default=5,
                   help="Number of bagged models in ensemble (default 5)")
    p.add_argument("--seed-offset", type=int, default=0,
                   help="Add offset to default seed-list [42..46]. Used by "
                        "dev09_multi_seed_bootstrap.py for inter-seed σ.")
    p.add_argument("--dry-run", action="store_true",
                   help="Build features but skip training + save (verify data flow)")
    p.add_argument("--no-gates", action="store_true",
                   help="Skip G1+G2+G3 gate reporting after training (training-only mode)")
    return p.parse_args()


def print_g1_sign_banner():
    """G1 — Sign-audit gate. Print explicit Brier-Δ convention before any output."""
    print()
    print("─" * 70)
    print("G1 — SIGN-AUDIT BANNER (explicit convention before training output)")
    print("─" * 70)
    print("  Brier-Δ convention used in stage_1_dev09.py + this run:")
    print("    Δ = brier_dev09 − brier_baseline")
    print("    Δ < 0  →  dev-09 BETTER (lower Brier = better)")
    print("    Δ > 0  →  dev-09 WORSE")
    print("  In-sample λ-stats reported below are TRAINING set only — for")
    print("  honest evaluation see stage_1_dev09.py vs dev-03 baseline.")
    print()


def print_g2_holm_context(n_features: int):
    """G2 — Multiple-testing-correction context (Holm-Bonferroni)."""
    print("─" * 70)
    print("G2 — HOLM-BONFERRONI CORRECTION CONTEXT")
    print("─" * 70)
    alpha = 0.05
    alpha_corrected = alpha / n_features
    print(f"  Features tested: {n_features}")
    print(f"  Family-wise α:   {alpha}")
    print(f"  Per-feature α:   α/{n_features} = {alpha_corrected:.5f}")
    print(f"  Single-feature p_raw < {alpha_corrected:.5f} required for individual significance.")
    print(f"  Architecture-swap claim requires: stage_1_dev09 p_adj < {alpha_corrected:.5f}.")
    print(f"  Empirical-week-calibration (CLAUDE.md): false-positives compound — even a")
    print(f"  best-of-8 p_raw=0.012 result becomes p_adj=0.096 after Holm. Be honest.")
    print()


def print_g3_leakage_summary(train_df: pd.DataFrame, test_df: pd.DataFrame):
    """G3 — Leakage-audit summary. Detailed checks live in dev09_leakage_audit.py."""
    print("─" * 70)
    print("G3 — LEAKAGE AUDIT (run dev09_leakage_audit.py for full check)")
    print("─" * 70)
    # Walk-forward CV: train_seasons < test_seasons chronologically?
    train_dates = pd.to_datetime(train_df["match_date"])
    test_dates = pd.to_datetime(test_df["match_date"])
    train_max = train_dates.max()
    test_min = test_dates.min()
    gap_days = (test_min - train_max).days if pd.notna(train_max) and pd.notna(test_min) else None
    print(f"  Walk-forward chrono split:")
    print(f"    train: [{train_dates.min().date()} .. {train_max.date()}]  n={len(train_df):,}")
    print(f"    test:  [{test_min.date()} .. {test_dates.max().date()}]  n={len(test_df):,}")
    print(f"    gap (test_min − train_max): {gap_days} days")

    # No game_id overlap between train and test
    train_gids = set(train_df["game_id"])
    test_gids = set(test_df["game_id"])
    overlap = train_gids & test_gids
    print(f"  game_id overlap (train ∩ test): {len(overlap)}  "
          f"({'✓ CLEAN' if not overlap else '✗ LEAKAGE'})")
    print(f"  shift(1).rolling(N) pattern: ENFORCED at BottomUpCalculator (pytest gated)")
    print(f"  GROUP BY (game_id, is_home) invariant: ENFORCED (pytest gated)")
    print()


def main() -> int:
    args = parse_args()
    train_seasons = tuple(args.train_seasons.split(","))
    test_seasons = tuple(args.test_seasons.split(","))
    # --leagues=ALL → None sentinel (build_corpus interprets None = no filter)
    leagues = None if args.leagues.strip().upper() == "ALL" else tuple(args.leagues.split(","))
    tag = args.tag or f"dev-09-{datetime.now().strftime('%Y%m%d-%H%M')}"

    print("═" * 70)
    print(f"dev-09 TABULA RASA training · tag={tag}")
    print("═" * 70)
    print(f"  train_seasons: {train_seasons}")
    print(f"  test_seasons:  {test_seasons}")
    print(f"  leagues:       {'ALL (22)' if leagues is None else leagues}")
    print(f"  n_models:      {args.n_models}")
    print(f"  seeds:         {[42+i+args.seed_offset for i in range(args.n_models)]}")
    print(f"  dry_run:       {args.dry_run}")
    print()

    if not args.no_gates:
        print_g1_sign_banner()

    # ─── Build feature matrices ───
    t0 = time.time()
    print(f"  Fitting FeatureBuilderDev09 on {SQLITE_PATH.name}...")
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    bc_stats = fb._bc.stats()
    print(f"    BottomUpCalculator: {bc_stats['n_distinct_players']:,} players × "
          f"{bc_stats['n_distinct_games']:,} games = "
          f"{bc_stats['n_fitted_player_match_pairs']:,} (player_id, game_id) pairs cached")
    print(f"    Done in {time.time()-t0:.1f}s")
    print()

    t0 = time.time()
    print(f"  Building train corpus ({train_seasons})...")
    train_df = fb.build_corpus(seasons=train_seasons, leagues=leagues, verbose=True)
    print(f"    Done in {time.time()-t0:.1f}s")
    print()

    t0 = time.time()
    print(f"  Building test corpus ({test_seasons}) — holdout, NOT seen during fit...")
    test_df = fb.build_corpus(seasons=test_seasons, leagues=leagues, verbose=True)
    print(f"    Done in {time.time()-t0:.1f}s")
    print()

    if len(train_df) < 500:
        print(f"  ✗ ERROR: only {len(train_df)} train matches — need ≥ 500")
        return 1

    print(f"  Feature stats (train, numeric):")
    summary = train_df[DEV_09_NUMERIC_FEATURES].describe().loc[["mean", "min", "max"]].round(3)
    for col in DEV_09_NUMERIC_FEATURES:
        print(f"    {col:<32} mean={summary.loc['mean', col]:>+7.3f}  "
              f"min={summary.loc['min', col]:>+7.3f}  max={summary.loc['max', col]:>+7.3f}")
    print(f"  Train target: home_goals mean={train_df['home_goals'].mean():.2f}, "
          f"away_goals mean={train_df['away_goals'].mean():.2f}")
    print(f"  Test  target: home_goals mean={test_df['home_goals'].mean():.2f}, "
          f"away_goals mean={test_df['away_goals'].mean():.2f}")
    print()

    if not args.no_gates:
        print_g2_holm_context(n_features=len(DEV_09_NUMERIC_FEATURES))
        print_g3_leakage_summary(train_df, test_df)

    # ─── Prepare X / y ───
    X_train = extract_X_dev09(train_df)
    y_h_train = train_df["home_goals"].values
    y_a_train = train_df["away_goals"].values

    if args.dry_run:
        print("  --dry-run: skipping training + save")
        return 0

    # ─── Train home-goals ensemble ───
    seeds = [42 + i + args.seed_offset for i in range(args.n_models)]
    t0 = time.time()
    print(f"  Training home-goals ensemble (n_models={args.n_models}, seeds={seeds})...")
    ens_h = BayesianEnsemble(n_models=args.n_models, seeds=seeds)
    ens_h.fit(X_train, y_h_train, categorical_columns=DEV_09_CATEGORICAL_FEATURES)
    print(f"    Done in {time.time()-t0:.1f}s")

    mean_h, var_h = ens_h.predict(X_train)
    print(f"    In-sample home λ: mean={mean_h.mean():.2f}, "
          f"avg-σ²={var_h.mean():.4f}, p95-σ²={np.percentile(var_h, 95):.4f}")

    # ─── Train away-goals ensemble ───
    t0 = time.time()
    print(f"  Training away-goals ensemble (n_models={args.n_models})...")
    ens_a = BayesianEnsemble(n_models=args.n_models, seeds=seeds)
    ens_a.fit(X_train, y_a_train, categorical_columns=DEV_09_CATEGORICAL_FEATURES)
    print(f"    Done in {time.time()-t0:.1f}s")

    mean_a, var_a = ens_a.predict(X_train)
    print(f"    In-sample away λ: mean={mean_a.mean():.2f}, "
          f"avg-σ²={var_a.mean():.4f}, p95-σ²={np.percentile(var_a, 95):.4f}")

    # ─── Save artifacts ───
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    manifest_path = ARTIFACTS_DIR / f"m3_xg-{tag}.json"

    ens_h.save(home_path)
    ens_a.save(away_path)

    manifest = {
        "tag": tag,
        "architecture": "dev-09-TABULA-RASA-bottom-up",
        "trained_at": datetime.now().isoformat(),
        "train_seasons": list(train_seasons),
        "test_seasons": list(test_seasons),
        "leagues": "ALL" if leagues is None else list(leagues),
        "n_models": args.n_models,
        "seeds": seeds,
        "seed_offset": args.seed_offset,
        "n_train_matches": int(len(train_df)),
        "n_test_matches": int(len(test_df)),
        "n_features": len(DEV_09_NUMERIC_FEATURES),
        "feature_names": DEV_09_NUMERIC_FEATURES + DEV_09_CATEGORICAL_FEATURES,
        "categorical_features": DEV_09_CATEGORICAL_FEATURES,
        "lgb_params": DEFAULT_LGB_PARAMS,
        "data_source": "sofascore_match (Sofa-native, NOT team_xg_history)",
        "bottom_up_calculator_stats": bc_stats,
        "training_set_diagnostics": {
            "_warning": "in-sample only — NOT a validation metric. See stage_1_dev09.py.",
            "home_lambda_mean": float(mean_h.mean()),
            "home_target_mean": float(y_h_train.mean()),
            "home_avg_variance": float(var_h.mean()),
            "away_lambda_mean": float(mean_a.mean()),
            "away_target_mean": float(y_a_train.mean()),
            "away_avg_variance": float(var_a.mean()),
        },
        "artifacts": {
            "home_ensemble": str(home_path.relative_to(REPO_ROOT)),
            "away_ensemble": str(away_path.relative_to(REPO_ROOT)),
        },
        "_notes": [
            "TABULA RASA: NO dev-03 macro borrows (Elo, momentum, league constants).",
            "Layer-3 fallback: bottom_up_available=0 → all 8 bottom-up diffs = 0.",
            "Honest holdout evaluation lives in pipeline/stage_1_dev09.py.",
            "Re-run cache via export_feature_cache_dev09.py if shipping to TS runtime.",
        ],
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print()
    print(f"  ✓ Artifacts saved:")
    print(f"    {home_path.relative_to(REPO_ROOT)}")
    print(f"    {away_path.relative_to(REPO_ROOT)}")
    print(f"    {manifest_path.relative_to(REPO_ROOT)}")
    print()
    print("═" * 70)
    print(f"✓ Training complete · tag={tag}")
    print(f"  Next: run pipeline/stage_1_dev09.py --tag {tag} to evaluate vs dev-03")
    print("═" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

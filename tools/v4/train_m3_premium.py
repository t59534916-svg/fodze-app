"""
train_m3_premium.py — Train m3_premium (specialist) on the 7-league × 3-season
Tier-A Sofa-extras-stack matches.

Architecture (Option C, see m3_xg/coverage_router.py):
  m3_premium = LightGBM Tweedie ensemble (analog dev-03) trained on
  16 lean features (m3_xg.feature_builder) + 9 Sofa-extras premium features
  (m3_xg.feature_builder_premium) = 25 features total.

Training corpus:
  • Leagues:  always-premium-7  (epl, la_liga, bundesliga, serie_a, ligue_1,
                                  championship, liga3)
  • Seasons:  23/24, 24/25 (25/26 reserved for stage-1 holdout eval)
  • Coverage: ~5000 matches (24/25-half + 23/24)
  • All matches MUST have sofascore_match.game_id linkage (else premium
    features are None → row dropped)

Output:
  tools/v4/artifacts/m3_xg-home-dev-06-premium.pkl
  tools/v4/artifacts/m3_xg-away-dev-06-premium.pkl
  tools/v4/artifacts/m3_xg-dev-06-premium.json  (manifest)

Usage:
  tools/venv/bin/python3 -I tools/v4/train_m3_premium.py
  tools/venv/bin/python3 -I tools/v4/train_m3_premium.py --dry-run
  tools/venv/bin/python3 -I tools/v4/train_m3_premium.py --tag dev-06b

Exit codes:
  0 — training complete, artifacts saved
  1 — insufficient data or fit error
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import (
    BayesianEnsemble,
    DEFAULT_LGB_PARAMS,
    NUMERIC_FEATURES,
    build_features_for_corpus,
    extract_X,
)
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.feature_builder_premium import (
    PREMIUM_FEATURE_ORDER,
    build_premium_features_for_corpus,
)

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

# Always-premium leagues from coverage_router — must stay in sync.
PREMIUM_LEAGUES_TRAIN = (
    "epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3",
)
PREMIUM_SEASONS_TRAIN = ("23/24", "24/25")  # 25/26 = holdout


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train m3_premium specialist (Option C)")
    p.add_argument("--tag", default="dev-06-premium",
                   help="Artifact tag (default: dev-06-premium)")
    p.add_argument("--n-models", type=int, default=5,
                   help="Bagged ensemble size (default 5)")
    p.add_argument("--dry-run", action="store_true",
                   help="Build features but skip training + save")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap training matches (smoke testing). Default: no limit.")
    p.add_argument("--verbose", action="store_true",
                   help="Per-1000-match progress in feature building.")
    return p.parse_args()


def load_premium_training_matches() -> pd.DataFrame:
    """Load all (game_id, league, match_date, home, away, home_goals, away_goals)
    for the always-premium-7 × {23/24, 24/25} subset, JOINED to sofascore_match
    so we have game_id available for the premium-feature lookups.

    Returns DataFrame with columns:
      game_id, league, match_date, home, away, home_goals, away_goals
    """
    sql = """
    SELECT
      sm.game_id        AS game_id,
      sm.league         AS league,
      DATE(sm.start_timestamp, 'unixepoch') AS match_date,
      sm.home_team      AS home,
      sm.away_team      AS away,
      sm.home_score     AS home_goals,
      sm.away_score     AS away_goals
    FROM sofascore_match sm
    WHERE sm.league IN ({lps})
      AND sm.season IN ({sps})
      AND sm.status = 'Ended'
      AND sm.home_score IS NOT NULL
      AND sm.away_score IS NOT NULL
    ORDER BY sm.start_timestamp
    """.format(
        lps=",".join("?" * len(PREMIUM_LEAGUES_TRAIN)),
        sps=",".join("?" * len(PREMIUM_SEASONS_TRAIN)),
    )
    with sqlite3.connect(LOCAL_DB) as con:
        df = pd.read_sql_query(
            sql, con,
            params=(*PREMIUM_LEAGUES_TRAIN, *PREMIUM_SEASONS_TRAIN),
        )
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def fuzzy_team_normalize(s: str) -> str:
    """Bridge team-naming between footystats/understat (which prefix 'AFC',
    'FC', 'SC' etc.) and sofascore (which sometimes does, sometimes doesn't).

    Strategy: lowercase, strip common club-prefixes, drop whitespace, drop
    diacritics. Empirically lifts the match-rate from ~58% (raw exact) to
    ~85-90% — enough to use footystats/understat-source rows.
    """
    import unicodedata
    if not s:
        return ""
    # Strip diacritics: 'Almería' → 'Almeria'
    s_norm = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    s_low = s_norm.lower()
    # Strip leading club-prefixes (whole-token only)
    tokens = s_low.split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.", "rcd",
                "sd", "ud", "ca", "us", "ssc", "as", "ud", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


def main() -> int:
    args = parse_args()
    tag = args.tag
    print("=" * 70)
    print(f"V4 m3_premium training run · tag={tag}")
    print("=" * 70)
    print(f"  leagues: {', '.join(PREMIUM_LEAGUES_TRAIN)} (7)")
    print(f"  seasons: {', '.join(PREMIUM_SEASONS_TRAIN)} (training; 25/26 = holdout)")
    print(f"  n_models: {args.n_models}")
    print(f"  dry_run: {args.dry_run}")
    print()

    # ─────────── Load premium training matches (with game_id) ───────────
    t0 = time.time()
    premium_matches = load_premium_training_matches()
    print(f"  premium-training-matches: {len(premium_matches):,}  ({time.time()-t0:.1f}s)")
    if len(premium_matches) < 500:
        print(f"  ✗ ERROR: only {len(premium_matches)} premium matches found — need ≥500")
        return 1

    # ─────────── Load team_xg_history (for lean features) ───────────
    t0 = time.time()
    history = load_team_xg_history(leagues=list(PREMIUM_LEAGUES_TRAIN))
    print(f"  team_xg_history: {len(history):,} rows  ({time.time()-t0:.1f}s)")

    # ─────────── Bridge: match team-naming between sofascore_match and team_xg_history ───────────
    # sofa names should align with team_xg_history.team for sofa-bridged rows
    # but other sources (footystats, understat) may use different canonicalization.
    # Build a (league, match_date, normalized_home, normalized_away) → game_id index,
    # then look up each match_pair against it.
    t0 = time.time()
    print(f"  Bridging sofa game_ids ↔ team_xg_history match_pairs...")

    # Approach: use a match_pairs-style self-join on team_xg_history, then
    # for each (league, date, home, away) try to find the matching sofa game_id
    # by exact (league, match_date, home, away) tuple equality with normalized
    # team names.
    sofa_index = {
        (row.league, row.match_date.strftime("%Y-%m-%d"),
         fuzzy_team_normalize(row.home), fuzzy_team_normalize(row.away)): row.game_id
        for row in premium_matches.itertuples()
    }

    # Get match_pairs from team_xg_history for the same league/date range
    # then join via the index above.
    from v4.data.loaders import load_match_pairs
    cutoff = "2025-08-01"   # before 25/26 starts
    since = "2023-07-01"    # capture 23/24 from start
    pairs = load_match_pairs(
        cutoff=cutoff, since=since, leagues=list(PREMIUM_LEAGUES_TRAIN),
    ).dropna(subset=["home_goals", "away_goals"])
    pairs["match_date_str"] = pairs["match_date"].dt.strftime("%Y-%m-%d")
    pairs["home_norm"] = pairs["home"].apply(fuzzy_team_normalize)
    pairs["away_norm"] = pairs["away"].apply(fuzzy_team_normalize)
    pairs["game_id"] = pairs.apply(
        lambda r: sofa_index.get(
            (r["league"], r["match_date_str"], r["home_norm"], r["away_norm"])
        ),
        axis=1,
    )
    matched = pairs.dropna(subset=["game_id"]).copy()
    matched["game_id"] = matched["game_id"].astype(int)
    n_matched = len(matched)
    n_unmatched = len(pairs) - n_matched
    print(f"    matched: {n_matched:,} / {len(pairs):,}  unmatched: {n_unmatched:,}")
    print(f"    bridge done in {time.time()-t0:.1f}s")

    if args.limit and len(matched) > args.limit:
        matched = matched.iloc[:args.limit].copy()
        print(f"    [--limit] subsampled to first {len(matched):,} matches")

    if n_matched < 500:
        print(f"  ✗ ERROR: only {n_matched} sofa-linked matches — bridge failure?")
        return 1

    # ─────────── Build lean features (16) ───────────
    t0 = time.time()
    print(f"  Fitting EloCalculator + TeamMomentumCalculator on history...")
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)
    print(f"    Elo + momentum fit in {time.time()-t0:.1f}s")

    t0 = time.time()
    print(f"  Building lean features ({len(matched):,} matches)...")
    # build_features_for_corpus expects raw match_pairs columns (league, match_date,
    # home, away, home_goals, away_goals). Pass the matched DF directly.
    lean_features = build_features_for_corpus(
        matched,
        history,
        elo_calculator=elo,
        momentum_calculator=momentum,
        verbose=args.verbose,
    )
    print(f"    lean features: shape={lean_features.shape}  ({time.time()-t0:.1f}s)")

    # ─────────── Build premium features (9) ───────────
    t0 = time.time()
    print(f"  Building premium features ({len(matched):,} matches)...")
    premium_features = build_premium_features_for_corpus(
        matched["game_id"].tolist(),
        impute_zero_on_missing=True,
    )
    # Drop rows where ALL 9 premium features were None pre-impute
    keep_mask = ~premium_features["_skip"]
    print(f"    premium features: shape={premium_features.shape}  "
          f"_skip={int((~keep_mask).sum())}  ({time.time()-t0:.1f}s)")

    # ─────────── Combine + clean ───────────
    # lean_features has its own row order; align by adding game_id then merging
    lean_features = lean_features.reset_index(drop=True)
    matched_reset = matched.reset_index(drop=True)
    lean_features["game_id"] = matched_reset["game_id"].values
    combined = lean_features.merge(
        premium_features.drop(columns=["_skip"]),
        on="game_id", how="inner",
    )
    combined = combined.loc[~combined["game_id"].isin(
        premium_features.loc[premium_features["_skip"], "game_id"]
    )].reset_index(drop=True)
    print(f"  combined feature-matrix: {combined.shape}")

    # ─────────── X / y / categorical ───────────
    # All 25 features: 16 NUMERIC_FEATURES + 9 PREMIUM_FEATURE_ORDER, plus league cat
    all_numeric = NUMERIC_FEATURES + list(PREMIUM_FEATURE_ORDER)
    X = combined[all_numeric + ["league"]].copy()
    X["league"] = X["league"].astype("category")
    y_h = combined["home_goals"].values
    y_a = combined["away_goals"].values

    print(f"  Feature stats (premium only):")
    for col in PREMIUM_FEATURE_ORDER:
        s = combined[col]
        print(f"    {col:<32s} mean={s.mean():>7.3f}  std={s.std():>6.3f}  "
              f"non-zero={(s != 0).sum():>5d}/{len(s)}")
    print(f"  Target: home_goals μ={y_h.mean():.2f}, away_goals μ={y_a.mean():.2f}")

    if args.dry_run:
        print("\n  --dry-run: skipping training + save")
        return 0

    # ─────────── Train ensembles ───────────
    t0 = time.time()
    print(f"\n  Training home-goals ensemble (n_models={args.n_models}, 25 features)...")
    ens_h = BayesianEnsemble(n_models=args.n_models)
    ens_h.fit(X, y_h, categorical_columns=["league"])
    print(f"    Done in {time.time()-t0:.1f}s")
    mean_h, var_h = ens_h.predict(X)
    print(f"    In-sample home λ: μ={mean_h.mean():.2f}  σ²={var_h.mean():.4f}")

    t0 = time.time()
    print(f"  Training away-goals ensemble...")
    ens_a = BayesianEnsemble(n_models=args.n_models)
    ens_a.fit(X, y_a, categorical_columns=["league"])
    print(f"    Done in {time.time()-t0:.1f}s")
    mean_a, var_a = ens_a.predict(X)
    print(f"    In-sample away λ: μ={mean_a.mean():.2f}  σ²={var_a.mean():.4f}")

    # ─────────── Save ───────────
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    manifest_path = ARTIFACTS_DIR / f"m3_xg-{tag}.json"
    ens_h.save(home_path)
    ens_a.save(away_path)

    manifest = {
        "tag": tag,
        "trained_at": datetime.now().isoformat(),
        "architecture": "Option C — Specialist (premium-7 × {23/24, 24/25})",
        "leagues": list(PREMIUM_LEAGUES_TRAIN),
        "seasons": list(PREMIUM_SEASONS_TRAIN),
        "n_models": args.n_models,
        "n_train_matches": len(combined),
        "n_lean_features": len(NUMERIC_FEATURES),
        "n_premium_features": len(PREMIUM_FEATURE_ORDER),
        "n_features_total": len(all_numeric),
        "feature_names_lean": list(NUMERIC_FEATURES),
        "feature_names_premium": list(PREMIUM_FEATURE_ORDER),
        "categorical_features": ["league"],
        "lgb_params": DEFAULT_LGB_PARAMS,
        "training_set_diagnostics": {
            "_warning": "in-sample only — see stage_1_m3_xg.py for honest holdout eval.",
            "home_lambda_mean": float(mean_h.mean()),
            "home_target_mean": float(y_h.mean()),
            "home_avg_variance": float(var_h.mean()),
            "away_lambda_mean": float(mean_a.mean()),
            "away_target_mean": float(y_a.mean()),
            "away_avg_variance": float(var_a.mean()),
        },
        "artifacts": {
            "home_ensemble": str(home_path.relative_to(REPO_ROOT)),
            "away_ensemble": str(away_path.relative_to(REPO_ROOT)),
        },
        "notes": (
            "Pair with m3_lean (dev-03) via m3_xg.coverage_router. "
            "Holdout (25/26) Brier evaluation in pipeline/stage_1_m3_xg.py."
        ),
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
    print(f"✓ Training complete · tag={tag} · n_train={len(combined):,}")
    print(f"  Next: Sprint 3 — predictor.py blend + stage 1.m3 holdout eval")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Smoke-predict for the m3_premium artifact (dev-06).

Loads the trained ensemble pickles, picks 5 recent 25/26 Tier-A matches,
runs them through the full feature stack (16 lean + 9 premium = 25 features),
and prints predicted λ_home, λ_away vs. actual goals.

Purpose: verify the artifact is valid + the inference path mirrors the
training path. NOT a Brier/ROI evaluation — that's Stage 1 / Stage 5 in
Sprint 3.

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/dev06_smoke_predict.py
  tools/venv/bin/python3 tools/v4/diagnostics/dev06_smoke_predict.py --tag dev-06-premium
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history, load_match_pairs
from v4.modules.m3_xg import (
    BayesianEnsemble,
    NUMERIC_FEATURES,
    build_features_for_corpus,
)
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.feature_builder_premium import (
    PREMIUM_FEATURE_ORDER,
    build_premium_features_for_corpus,
)

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


def fuzzy_team_normalize(s: str) -> str:
    """Mirror of train_m3_premium.py for inference-time consistency."""
    import unicodedata
    if not s:
        return ""
    s_norm = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    tokens = s_norm.lower().split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.",
                "rcd", "sd", "ud", "ca", "us", "ssc", "as", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tag", default="dev-06-premium")
    p.add_argument("--n", type=int, default=5)
    args = p.parse_args()

    # ── Load artifacts ──
    manifest_path = ARTIFACTS_DIR / f"m3_xg-{args.tag}.json"
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.tag}.pkl"

    if not all(p.exists() for p in (manifest_path, home_path, away_path)):
        print(f"❌ Missing artifacts for tag={args.tag}")
        print(f"   manifest: {manifest_path.exists()}")
        print(f"   home: {home_path.exists()}")
        print(f"   away: {away_path.exists()}")
        return 1

    with open(manifest_path) as f:
        manifest = json.load(f)
    print(f"Loaded manifest: {args.tag}")
    print(f"  trained_at: {manifest['trained_at']}")
    print(f"  n_train_matches: {manifest['n_train_matches']:,}")
    print(f"  features: {manifest['n_features_total']} ({manifest['n_lean_features']} lean + {manifest['n_premium_features']} premium)")

    ens_h = BayesianEnsemble.load(home_path)
    ens_a = BayesianEnsemble.load(away_path)
    print(f"  ensembles loaded")

    # ── Pick 5 recent 25/26 Tier-A matches with full premium data ──
    con = sqlite3.connect(LOCAL_DB)
    rows = con.execute("""
        SELECT m.game_id, m.league, DATE(m.start_timestamp, 'unixepoch') as md,
               m.home_team, m.away_team, m.home_score, m.away_score
        FROM sofascore_match m
        WHERE m.league IN ('epl','la_liga','bundesliga','serie_a','ligue_1')
          AND m.season = '25/26' AND m.status = 'Ended'
          AND m.home_score IS NOT NULL
        ORDER BY m.start_timestamp DESC
        LIMIT ?
    """, (args.n,)).fetchall()
    con.close()

    if not rows:
        print("❌ No 25/26 Tier-A finished matches available")
        return 1

    # Build a tiny match_pairs DF for feature builder
    pairs = pd.DataFrame([{
        "league": r[1],
        "match_date": pd.Timestamp(r[2]),
        "home": r[3],
        "away": r[4],
        "home_goals": r[5],
        "away_goals": r[6],
    } for r in rows])
    game_ids = [r[0] for r in rows]
    print(f"\nLoaded {len(pairs)} test matches from 25/26 Top-5:")
    for r in rows:
        print(f"  {r[1]:10s} {r[2]} {r[3]} {r[5]}-{r[6]} {r[4]} (gid={r[0]})")

    # ── Build features (mirror training pipeline) ──
    history = load_team_xg_history(leagues=list({r[1] for r in rows}))
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)

    lean = build_features_for_corpus(
        pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    )
    premium = build_premium_features_for_corpus(game_ids, impute_zero_on_missing=True)

    # Combine
    lean = lean.reset_index(drop=True)
    lean["game_id"] = game_ids
    combined = lean.merge(premium.drop(columns=["_skip"]), on="game_id", how="inner")

    all_numeric = NUMERIC_FEATURES + list(PREMIUM_FEATURE_ORDER)
    X = combined[all_numeric + ["league"]].copy()
    X["league"] = X["league"].astype("category")

    # ── Predict ──
    mean_h, var_h = ens_h.predict(X)
    mean_a, var_a = ens_a.predict(X)

    print(f"\n{'Match':50s} {'pred λ_h':>10s} {'pred λ_a':>10s}  actual")
    print("-" * 85)
    for i, r in enumerate(rows):
        if i >= len(mean_h):  # in case _skip dropped a row
            continue
        match_str = f"{r[3][:22]:22s} vs {r[4][:22]:22s}"
        print(f"{match_str:50s} {mean_h[i]:>10.2f} {mean_a[i]:>10.2f}  ({r[5]}-{r[6]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

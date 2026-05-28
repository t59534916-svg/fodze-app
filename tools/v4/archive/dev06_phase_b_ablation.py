#!/usr/bin/env python3
"""
Phase B: per-feature ablation study.

For each of the 9 premium features:
  • Train an m3 ensemble with lean_20 + JUST THIS premium feature = 21 features
  • Evaluate Brier on 25/26 Tier-A holdout (same as Stage 1)
  • Compare to lean-alone baseline (Brier 0.6089)

If ANY single feature crosses Brier 0.6089 - 0.001 = 0.6079 on the holdout,
that feature has real signal beyond what lean already captures.
If NONE do, the dev-06 architecture is confirmed dead — premium info is
fully redundant with lean.

Reuses the bridge + feature-build pipeline from train_m3_premium.py. To
avoid re-building features 9× we build them ONCE and re-train 9 different
ensemble configurations.

Run: tools/venv/bin/python3 tools/v4/diagnostics/dev06_phase_b_ablation.py
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MIN, LAMBDA_MAX
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

LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
TIER_A = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")


def fuzzy_team_normalize(s):
    import unicodedata
    if not s: return ""
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    tokens = s.lower().split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.",
                "rcd", "sd", "ud", "ca", "us", "ssc", "as", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


def bridge_game_ids(pairs, season_filter):
    """Add game_id column via fuzzy-team-bridge to sofascore_match."""
    with sqlite3.connect(LOCAL_DB) as con:
        sofa = pd.read_sql_query(
            f"SELECT game_id, league, DATE(start_timestamp,'unixepoch') AS md, "
            f"home_team, away_team FROM sofascore_match "
            f"WHERE season IN ({','.join('?' for _ in season_filter)}) AND status='Ended'",
            con, params=season_filter,
        )
    idx = {
        (r.league, r.md, fuzzy_team_normalize(r.home_team),
         fuzzy_team_normalize(r.away_team)): r.game_id
        for r in sofa.itertuples()
    }
    out = pairs.copy()
    out["match_date_str"] = out["match_date"].dt.strftime("%Y-%m-%d")
    out["game_id"] = out.apply(lambda r: idx.get(
        (r["league"], r["match_date_str"],
         fuzzy_team_normalize(r["home"]), fuzzy_team_normalize(r["away"]))
    ), axis=1)
    return out.drop(columns=["match_date_str"])


def _build_score_grid(lh, la, rho=-0.094):
    """Mirror of XGPredictor._build_score_grid."""
    try:
        return DixonColesModel(lh, la, rho=rho).matrix(normalize=True), False
    except ValueError:
        return PoissonGoalModel(lh, la).matrix(normalize=True), True


def predict_probs(ens_h, ens_a, X, league_col_name="league"):
    """Run ensembles on X, return Nx3 1x2 prob matrix."""
    X = X.copy()
    if league_col_name in X.columns:
        X[league_col_name] = X[league_col_name].astype("category")
    X_aligned = X[ens_h.feature_names]
    mean_h, _ = ens_h.predict(X_aligned)
    mean_a, _ = ens_a.predict(X_aligned)
    lh = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    la = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    probs = np.empty((len(X), 3))
    for i in range(len(X)):
        M, _ = _build_score_grid(lh[i], la[i])
        p = get_1x2(M)
        probs[i] = [p["H"], p["D"], p["A"]]
    return probs


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--n-models", type=int, default=5)
    args = p.parse_args()

    t_total = time.time()
    print("=" * 70)
    print("Phase B: per-feature ablation study (dev-06 premium features)")
    print("=" * 70)

    # ── Load + bridge train + holdout ──
    print("Loading training corpus (23/24+24/25 Tier-A)...")
    train_pairs = load_match_pairs(
        cutoff="2025-08-01", since="2023-07-01", leagues=list(TIER_A),
    ).dropna(subset=["home_goals", "away_goals"])
    train_pairs = bridge_game_ids(train_pairs, ["23/24", "24/25"])
    train_pairs = train_pairs.dropna(subset=["game_id"]).reset_index(drop=True)
    train_pairs["game_id"] = train_pairs["game_id"].astype(int)
    print(f"  train: {len(train_pairs):,} matches")

    print("Loading holdout (25/26 Tier-A)...")
    holdout_pairs = load_match_pairs(
        since="2025-08-01", leagues=list(TIER_A),
    ).dropna(subset=["home_goals", "away_goals"])
    holdout_pairs = bridge_game_ids(holdout_pairs, ["25/26"])
    holdout_pairs = holdout_pairs.dropna(subset=["game_id"]).reset_index(drop=True)
    holdout_pairs["game_id"] = holdout_pairs["game_id"].astype(int)
    print(f"  holdout: {len(holdout_pairs):,} matches")

    # ── Build features for BOTH sets ──
    history = load_team_xg_history(leagues=list(TIER_A))
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)

    print(f"Building lean features (train+holdout, ~{len(train_pairs) + len(holdout_pairs):,} matches)...")
    t0 = time.time()
    lean_train = build_features_for_corpus(
        train_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    lean_hold = build_features_for_corpus(
        holdout_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    print(f"  lean features built in {time.time()-t0:.1f}s")

    print(f"Building premium features (train+holdout)...")
    t0 = time.time()
    prem_train = build_premium_features_for_corpus(
        train_pairs["game_id"].tolist(), impute_zero_on_missing=True,
    ).reset_index(drop=True)
    prem_hold = build_premium_features_for_corpus(
        holdout_pairs["game_id"].tolist(), impute_zero_on_missing=True,
    ).reset_index(drop=True)
    print(f"  premium features built in {time.time()-t0:.1f}s")

    # Drop _skip rows for training (consistent with train_m3_premium.py)
    keep_train = ~prem_train["_skip"]
    keep_hold = ~prem_hold["_skip"]
    print(f"  train: keep {keep_train.sum():,}/{len(prem_train):,} after _skip drop")
    print(f"  holdout: keep {keep_hold.sum():,}/{len(prem_hold):,} after _skip drop")

    lean_train = lean_train[keep_train.values].reset_index(drop=True)
    prem_train = prem_train[keep_train.values].reset_index(drop=True)
    lean_hold = lean_hold[keep_hold.values].reset_index(drop=True)
    prem_hold = prem_hold[keep_hold.values].reset_index(drop=True)

    # ── Build y_true for holdout ──
    # lean_hold has match_date column we don't want as feature
    train_pairs_kept = train_pairs[keep_train.values].reset_index(drop=True)
    holdout_pairs_kept = holdout_pairs[keep_hold.values].reset_index(drop=True)
    def y_idx(h, a): return 0 if h > a else (2 if h < a else 1)
    y_true = np.array([y_idx(h, a) for h, a in zip(
        holdout_pairs_kept["home_goals"], holdout_pairs_kept["away_goals"]
    )])
    y_h_train = train_pairs_kept["home_goals"].values
    y_a_train = train_pairs_kept["away_goals"].values

    # ── Helper: train + predict for an arbitrary feature subset ──
    def train_and_score(extra_features: list, label: str):
        feature_cols = list(NUMERIC_FEATURES) + extra_features
        X_tr = pd.concat([lean_train[NUMERIC_FEATURES]] + [prem_train[[f]] for f in extra_features], axis=1)
        X_tr["league"] = lean_train["league"].values
        X_ho = pd.concat([lean_hold[NUMERIC_FEATURES]] + [prem_hold[[f]] for f in extra_features], axis=1)
        X_ho["league"] = lean_hold["league"].values

        ens_h = BayesianEnsemble(n_models=args.n_models)
        ens_h.fit(X_tr, y_h_train, categorical_columns=["league"])
        ens_a = BayesianEnsemble(n_models=args.n_models)
        ens_a.fit(X_tr, y_a_train, categorical_columns=["league"])

        probs = predict_probs(ens_h, ens_a, X_ho)
        b = brier_multiclass(y_true, probs)
        return b

    # ── Baseline: lean alone (no premium feature) ──
    print()
    print("Training baselines...")
    t0 = time.time()
    brier_lean = train_and_score([], "lean alone")
    print(f"  Baseline lean-only Brier on holdout: {brier_lean:.4f}  ({time.time()-t0:.1f}s)")

    # ── 9 single-feature additions ──
    print()
    print("=" * 70)
    print(f"{'Premium feature added':<35s} {'Brier':>10s} {'Δ vs lean':>12s}  verdict")
    print("-" * 75)
    results = {}
    for f in PREMIUM_FEATURE_ORDER:
        t0 = time.time()
        b = train_and_score([f], f)
        delta = b - brier_lean
        results[f] = (b, delta)
        marker = "✅" if delta < -0.001 else ("⚠" if delta < 0 else "✗")
        print(f"{f:<35s} {b:.4f}    {delta:+.4f}    {marker} {(time.time()-t0):.1f}s")

    # ── Plus: all 9 together (sanity — should reproduce dev-06) ──
    t0 = time.time()
    b_all = train_and_score(list(PREMIUM_FEATURE_ORDER), "all 9")
    print(f"{'all 9 premium features':<35s} {b_all:.4f}    {b_all - brier_lean:+.4f}    {'  (' + f'{time.time()-t0:.1f}' + 's)':>15s}")

    print()
    print("=" * 70)
    winners = sorted(
        [(f, b, d) for f, (b, d) in results.items() if d < -0.001],
        key=lambda x: x[2],
    )
    if winners:
        print(f"✅ {len(winners)} feature(s) PASS the Brier-Gate (Δ ≤ -0.001):")
        for f, b, d in winners:
            print(f"  {f:<32s} Brier={b:.4f}  Δ={d:+.4f}")
        print(f"\nRecommendation: add those features to a NEW dev-07 specialist model.")
    else:
        print(f"✗ ZERO premium features improve lean on the holdout.")
        print(f"  All 9 are either neutral (Δ > -0.001) or worse.")
        print(f"  Verdict: premium-features architecture is confirmed dead — info redundant with lean.")
        print(f"  Recommend: stop investing in m3_premium; focus on other v4 modules or v3 features.")

    print(f"\nTotal time: {(time.time() - t_total)/60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Six validations for the line-movement Δ -0.0046 result. Tests:

  1. Bootstrap CI on Δ Brier (statistical significance)
  2. 5 random-seed re-runs (variance vs effect-size)
  3. dev-03 production model + drift vs dev-03 alone (does it add beyond production?)
  4. Per-league Brier breakdown (signal-location)
  5. Permutation test (shuffle drift values → confirms signal vs randomness)
  6. Out-of-season holdout: train 23/24+24/25, test 22/23 (OOD)

Run: tools/venv/bin/python3 tools/v4/diagnostics/line_movement_validation.py
"""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
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
from v4.modules.m3_xg import BayesianEnsemble, NUMERIC_FEATURES, build_features_for_corpus
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

CACHE = REPO_ROOT / "tools/v4/diagnostics/.line_movement_odds_cache.parquet"
LEAN_CACHE = REPO_ROOT / "tools/v4/diagnostics/.line_movement_features_cache.parquet"
ARTIFACTS = REPO_ROOT / "tools/v4/artifacts"


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


def shin_vig_remove_3way(odds):
    if not (odds > 1.0).all():
        return np.array([np.nan, np.nan, np.nan])
    raw = 1.0 / odds
    s = raw.sum()
    if s <= 1.0:
        return raw / s
    z = (s - 1.0) / (1.0 + raw.max() / s)
    z = float(np.clip(z, 0.001, 0.5))
    p = raw.copy()
    for _ in range(20):
        p_new = (np.sqrt(z * z + 4 * (1 - z) * p * raw / (1 - z + 2 * z * p)) - z) / (2 * (1 - z))
        p_new = np.clip(p_new, 1e-6, 1 - 1e-6)
        p_new = p_new / p_new.sum()
        if np.allclose(p, p_new, atol=1e-8):
            break
        p = p_new
    return p


def y_idx(h, a): return 0 if h > a else (2 if h < a else 1)


def lambdas_to_1x2(lh, la):
    n = len(lh)
    probs = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(float(lh[i]), float(la[i]), rho=-0.094).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(float(lh[i]), float(la[i])).matrix(normalize=True)
        p = get_1x2(M)
        probs[i] = [p["H"], p["D"], p["A"]]
    return probs


def train_and_predict(X_train, y_train_h, y_train_a, X_test, seed=42):
    ens_h = BayesianEnsemble(n_models=5, seeds=[seed + i for i in range(5)])
    ens_h.fit(X_train, y_train_h, categorical_columns=["league"])
    ens_a = BayesianEnsemble(n_models=5, seeds=[seed + 5 + i for i in range(5)])
    ens_a.fit(X_train, y_train_a, categorical_columns=["league"])
    mean_h, _ = ens_h.predict(X_test[ens_h.feature_names])
    mean_a, _ = ens_a.predict(X_test[ens_a.feature_names])
    lh = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    la = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    return lambdas_to_1x2(lh, la), ens_h


def prep_data():
    """Load cached odds, recompute drift, bridge to match_pairs, build features."""
    print("Loading cached odds...")
    odds_df = pd.read_parquet(CACHE)
    odds_df["match_date"] = pd.to_datetime(odds_df["match_date"]).dt.date

    print("Computing drift...")
    open_probs = np.array([
        shin_vig_remove_3way(odds_df.iloc[i][["psh", "psd", "psa"]].astype(float).values)
        for i in range(len(odds_df))
    ])
    close_probs = np.array([
        shin_vig_remove_3way(odds_df.iloc[i][["psch", "pscd", "psca"]].astype(float).values)
        for i in range(len(odds_df))
    ])
    odds_df["drift_h"] = close_probs[:, 0] - open_probs[:, 0]
    odds_df["drift_d"] = close_probs[:, 1] - open_probs[:, 1]
    odds_df["drift_a"] = close_probs[:, 2] - open_probs[:, 2]
    odds_df = odds_df.dropna(subset=["drift_h", "drift_d", "drift_a"])

    print("Loading match_pairs + bridging...")
    pairs = load_match_pairs(
        since="2022-07-01", cutoff="2025-08-01",
    ).dropna(subset=["home_goals", "away_goals"])
    odds_df["home_norm"] = odds_df["home_team"].apply(fuzzy_team_normalize)
    odds_df["away_norm"] = odds_df["away_team"].apply(fuzzy_team_normalize)
    pairs["home_norm"] = pairs["home"].apply(fuzzy_team_normalize)
    pairs["away_norm"] = pairs["away"].apply(fuzzy_team_normalize)
    pairs["match_date_d"] = pairs["match_date"].dt.date
    odds_keyed = odds_df.rename(columns={"match_date": "match_date_d"})
    odds_keyed = odds_keyed[
        ["league", "match_date_d", "home_norm", "away_norm",
         "drift_h", "drift_d", "drift_a"]
    ].drop_duplicates(subset=["league", "match_date_d", "home_norm", "away_norm"])
    merged = pairs.merge(odds_keyed, on=["league", "match_date_d", "home_norm", "away_norm"], how="left")
    merged = merged.dropna(subset=["drift_h"]).reset_index(drop=True)
    print(f"  bridged: {len(merged):,} matches")

    if LEAN_CACHE.exists():
        print("Loading cached lean features...")
        lean_all = pd.read_parquet(LEAN_CACHE)
        # Sanity: match by index alignment
        if len(lean_all) != len(merged):
            print(f"  cache size mismatch ({len(lean_all)} vs {len(merged)}) — rebuilding")
            LEAN_CACHE.unlink()
            return prep_data()
    else:
        print("Building lean features (one-time, ~50s)...")
        history = load_team_xg_history()
        elo = EloCalculator().fit(history)
        momentum = TeamMomentumCalculator().fit(history)
        lean_all = build_features_for_corpus(
            merged[["league", "match_date", "home", "away", "home_goals", "away_goals"]],
            history, elo_calculator=elo, momentum_calculator=momentum,
        ).reset_index(drop=True)
        lean_all.to_parquet(LEAN_CACHE)

    lean_all["drift_h"] = merged["drift_h"].values
    lean_all["drift_d"] = merged["drift_d"].values
    lean_all["drift_a"] = merged["drift_a"].values
    lean_all["match_date"] = merged["match_date"].values

    return lean_all, merged


def main():
    t_all = time.time()
    print("=" * 76)
    print("Line-Movement Validation — six tests")
    print("=" * 76)
    data, merged = prep_data()
    print(f"  total rows with drift + lean features: {len(data):,}")

    # Standard train/holdout split: 22/23+23/24+24/25-H1 vs 24/25-H2
    SPLIT = pd.Timestamp("2025-01-01")
    train_mask = pd.to_datetime(data["match_date"]) < SPLIT
    train = data[train_mask].reset_index(drop=True)
    holdout = data[~train_mask].reset_index(drop=True)
    print(f"  train: {len(train):,}   holdout: {len(holdout):,}")

    y_train_h = train["home_goals"].values
    y_train_a = train["away_goals"].values
    y_test = np.array([y_idx(h, a) for h, a in zip(holdout["home_goals"], holdout["away_goals"])])

    def Xt(df, with_drift):
        cols = list(NUMERIC_FEATURES) + (["drift_h", "drift_d", "drift_a"] if with_drift else [])
        X = df[cols + ["league"]].copy()
        X["league"] = X["league"].astype("category")
        return X

    # ── Standard run (re-do to confirm) ──
    print()
    print(">>> Re-running baseline to confirm original Δ ...")
    t0 = time.time()
    probs_lean_base, _ = train_and_predict(Xt(train, False), y_train_h, y_train_a, Xt(holdout, False), seed=42)
    brier_lean_base = brier_multiclass(y_test, probs_lean_base)
    probs_drift_base, _ = train_and_predict(Xt(train, True), y_train_h, y_train_a, Xt(holdout, True), seed=42)
    brier_drift_base = brier_multiclass(y_test, probs_drift_base)
    delta_base = brier_drift_base - brier_lean_base
    print(f"  lean:        {brier_lean_base:.4f}")
    print(f"  lean+drift:  {brier_drift_base:.4f}   Δ = {delta_base:+.4f}   ({time.time()-t0:.1f}s)")

    # ── TEST 1: Bootstrap CI ──
    print()
    print("=" * 76)
    print("TEST 1: Bootstrap CI on Δ Brier")
    print("=" * 76)
    rng = np.random.RandomState(42)
    n = len(y_test)
    boot_deltas = []
    for b in range(2000):
        idx = rng.randint(0, n, size=n)
        b_lean = brier_multiclass(y_test[idx], probs_lean_base[idx])
        b_drift = brier_multiclass(y_test[idx], probs_drift_base[idx])
        boot_deltas.append(b_drift - b_lean)
    boot_deltas = np.array(boot_deltas)
    ci_lo, ci_hi = np.percentile(boot_deltas, [2.5, 97.5])
    p_better = (boot_deltas < 0).mean()
    print(f"  Δ_observed = {delta_base:+.4f}")
    print(f"  Bootstrap 95% CI: [{ci_lo:+.4f}, {ci_hi:+.4f}]")
    print(f"  P(Δ < 0) = {p_better:.3f}   (= prob that drift truly improves)")
    if ci_hi < 0:
        print(f"  ✅ CI entirely below 0 — statistically significant improvement")
    elif p_better >= 0.95:
        print(f"  ✅ P ≥ 0.95 — likely improvement (CI touches zero)")
    elif p_better >= 0.80:
        print(f"  ⚠ marginal evidence (P {p_better:.2f}, CI straddles 0)")
    else:
        print(f"  ✗ NOT significant (P = {p_better:.2f})")

    # ── TEST 2: 5 random-seed re-runs ──
    print()
    print("=" * 76)
    print("TEST 2: 5 random-seed re-runs (variance check)")
    print("=" * 76)
    seeds = [42, 123, 456, 789, 1234]
    deltas_seeds = []
    for s in seeds:
        t0 = time.time()
        p_l, _ = train_and_predict(Xt(train, False), y_train_h, y_train_a, Xt(holdout, False), seed=s)
        b_l = brier_multiclass(y_test, p_l)
        p_d, _ = train_and_predict(Xt(train, True), y_train_h, y_train_a, Xt(holdout, True), seed=s)
        b_d = brier_multiclass(y_test, p_d)
        delta = b_d - b_l
        deltas_seeds.append(delta)
        print(f"  seed={s:>5}:  lean={b_l:.4f}  drift={b_d:.4f}  Δ={delta:+.4f}   ({time.time()-t0:.1f}s)")
    arr = np.array(deltas_seeds)
    print(f"  Δ mean: {arr.mean():+.4f}  std: {arr.std():.4f}")
    print(f"  all 5 negative? {(arr < 0).all()}  all 5 below -0.001 gate? {(arr < -0.001).all()}")

    # ── TEST 3: dev-03 full-corpus baseline ──
    print()
    print("=" * 76)
    print("TEST 3: dev-03 (full-corpus) vs dev-03 + drift on this holdout")
    print("=" * 76)
    # Load dev-03 artifact, predict on our holdout. dev-03 was trained on 27k matches
    # but our holdout has 979 matches. Use the same X structure as dev-03 expects.
    home_p = ARTIFACTS / "m3_xg-home-dev-03.pkl"
    away_p = ARTIFACTS / "m3_xg-away-dev-03.pkl"
    if home_p.exists():
        ens_h_03 = BayesianEnsemble.load(home_p)
        ens_a_03 = BayesianEnsemble.load(away_p)
        X_ho_dev03 = holdout[list(ens_h_03.feature_names[:-1]) + ["league"]].copy()
        X_ho_dev03["league"] = X_ho_dev03["league"].astype("category")
        mean_h, _ = ens_h_03.predict(X_ho_dev03[ens_h_03.feature_names])
        mean_a, _ = ens_a_03.predict(X_ho_dev03[ens_a_03.feature_names])
        lh = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
        la = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
        probs_dev03 = lambdas_to_1x2(lh, la)
        brier_dev03 = brier_multiclass(y_test, probs_dev03)
        print(f"  dev-03 (27k matches trained) Brier on our holdout: {brier_dev03:.4f}")
        print(f"  Small-lean baseline (4k matches trained):           {brier_lean_base:.4f}")
        print(f"  Lean+drift (4k matches trained):                    {brier_drift_base:.4f}")
        print()
        if brier_drift_base < brier_dev03 - 0.001:
            print(f"  ✅ lean+drift beats dev-03 (full corpus) by {brier_dev03 - brier_drift_base:.4f}")
            print(f"     Drift signal is real beyond what training-corpus-size alone explains.")
        elif brier_drift_base < brier_dev03:
            print(f"  ⚠ lean+drift slightly beats dev-03 ({brier_dev03 - brier_drift_base:+.4f}) — marginal")
        else:
            print(f"  ✗ lean+drift does NOT beat dev-03 alone — improvement was just corpus-size effect")
            print(f"     The Δ-0.0046 from earlier reflects 'small model gets help' not 'drift adds info'")
    else:
        print(f"  ⚠ dev-03 artifact not at {home_p}")

    # ── TEST 4: Per-league Brier breakdown ──
    print()
    print("=" * 76)
    print("TEST 4: Per-league Brier breakdown (where does drift help?)")
    print("=" * 76)
    print(f"  {'league':<20s} {'n':>5s} {'lean':>9s} {'drift':>9s} {'Δ':>9s}")
    for lg, g in holdout.groupby("league"):
        if len(g) < 20:
            continue
        idx = g.index.values
        b_l = brier_multiclass(y_test[idx], probs_lean_base[idx])
        b_d = brier_multiclass(y_test[idx], probs_drift_base[idx])
        d = b_d - b_l
        marker = "✅" if d < -0.001 else ("⚠" if d < 0 else "✗")
        print(f"  {lg:<20s} {len(g):>5d} {b_l:>9.4f} {b_d:>9.4f} {d:>+9.4f}  {marker}")

    # ── TEST 5: Permutation test ──
    print()
    print("=" * 76)
    print("TEST 5: Permutation test — shuffle drift values within train")
    print("=" * 76)
    perm_rng = np.random.RandomState(7)
    train_perm = train.copy()
    perm_idx = perm_rng.permutation(len(train_perm))
    train_perm["drift_h"] = train_perm["drift_h"].values[perm_idx]
    train_perm["drift_d"] = train_perm["drift_d"].values[perm_idx]
    train_perm["drift_a"] = train_perm["drift_a"].values[perm_idx]
    p_perm, _ = train_and_predict(Xt(train_perm, True), y_train_h, y_train_a, Xt(holdout, True), seed=42)
    b_perm = brier_multiclass(y_test, p_perm)
    delta_perm = b_perm - brier_lean_base
    print(f"  permuted drift Brier:  {b_perm:.4f}   Δ = {delta_perm:+.4f}")
    print(f"  real drift Brier:      {brier_drift_base:.4f}   Δ = {delta_base:+.4f}")
    print(f"  signal-vs-noise gap:   {delta_perm - delta_base:+.4f}")
    if b_perm > brier_lean_base + 0.0005:
        print(f"  ✅ permuted drift HURTS (Δ {delta_perm:+.4f}) — real drift contains genuine info")
    elif abs(b_perm - brier_lean_base) < 0.001:
        print(f"  ⚠ permuted drift ≈ lean ({delta_perm:+.4f}) — tree ignored random feature, good guard")
    else:
        print(f"  ✗ permuted drift IMPROVES lean too — original gain might be variance, not signal")

    # ── TEST 6: OOD season holdout ──
    print()
    print("=" * 76)
    print("TEST 6: Out-of-season holdout (train 23/24+24/25, test 22/23)")
    print("=" * 76)
    md = pd.to_datetime(data["match_date"])
    is_2223 = (md >= "2022-07-01") & (md < "2023-07-01")
    train_ood = data[~is_2223].reset_index(drop=True)
    test_ood = data[is_2223].reset_index(drop=True)
    print(f"  train (23/24+24/25): {len(train_ood):,}    test (22/23): {len(test_ood):,}")
    y_train_ood_h = train_ood["home_goals"].values
    y_train_ood_a = train_ood["away_goals"].values
    y_test_ood = np.array([y_idx(h, a) for h, a in zip(test_ood["home_goals"], test_ood["away_goals"])])

    t0 = time.time()
    p_l_ood, _ = train_and_predict(Xt(train_ood, False), y_train_ood_h, y_train_ood_a, Xt(test_ood, False), seed=42)
    b_l_ood = brier_multiclass(y_test_ood, p_l_ood)
    p_d_ood, _ = train_and_predict(Xt(train_ood, True), y_train_ood_h, y_train_ood_a, Xt(test_ood, True), seed=42)
    b_d_ood = brier_multiclass(y_test_ood, p_d_ood)
    delta_ood = b_d_ood - b_l_ood
    print(f"  lean OOD Brier:       {b_l_ood:.4f}")
    print(f"  lean+drift OOD Brier: {b_d_ood:.4f}   Δ = {delta_ood:+.4f}   ({time.time()-t0:.1f}s)")
    if delta_ood <= -0.001:
        print(f"  ✅ improvement REPLICATES out-of-season — feature generalizes")
    elif delta_ood <= 0:
        print(f"  ⚠ marginal OOD improvement")
    else:
        print(f"  ✗ NO OOD improvement — Δ went positive — original might overfit to 24/25 holdout")

    print()
    print("=" * 76)
    print(f"Total runtime: {(time.time() - t_all)/60:.1f} min")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

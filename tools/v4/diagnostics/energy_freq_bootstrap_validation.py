#!/usr/bin/env python3
"""
energy_freq_bootstrap_validation.py — Phase A Step 2.

Phase A step 1 (energy_freq_signal_discovery.py) found 2 candidates that
pass the Brier-Gate on the 25/26 Tier-A holdout:
  - frequenz_total_goals_diff:        Δ = -0.0012
  - energie_match_intensity_diff:     Δ = -0.0019
  (plus all-5 together: Δ = -0.0014)

But: SINGLE-seed ablation. We know from line_movement_validation.py that
run-to-run Brier-variance for 5-bagged ensembles is ~0.002 std. So a Δ of
-0.0019 is barely 1σ above the noise floor.

This script extends the validation in three orthogonal ways:

  TEST 1 (Bootstrap): Re-train each ensemble with 5 alternative seed sets:
    [42-46] (default), [10-14], [100-104], [200-204], [500-504]
    If Δ stays consistently negative across all 5 → real signal.
    If Δ flips sign or straddles 0 → run-variance.

  TEST 2 (Top-2 combo): lean + 2 winners only. If their information is
    additive, expect Δ ≈ -0.0031. If correlated/redundant, expect ≈ -0.0019.

  TEST 3 (Per-league): Per-league Brier-Gate for the best single feature
    (energie_match_intensity). Is the gain concentrated in 1 league
    (analog dev-03+m6_benter eredivisie-luck) or spread across all 7
    Tier-A?

Output: tools/v4/diagnostics/energy_freq_bootstrap.json
"""
from __future__ import annotations

import argparse
import json
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
from v4.modules.m3_xg import BayesianEnsemble, NUMERIC_FEATURES, build_features_for_corpus
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

# Reuse feature computations from Phase A step 1
sys.path.insert(0, str(REPO_ROOT / "tools/v4/diagnostics"))
from energy_freq_signal_discovery import (
    ENERGY_FEATURE_FUNCS,
    ENERGY_FEATURE_NAMES,
    build_energy_features_for_corpus,
)

TIER_A = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")
SEED_SETS = [
    [42, 43, 44, 45, 46],     # default (Phase A step 1)
    [10, 11, 12, 13, 14],
    [100, 101, 102, 103, 104],
    [200, 201, 202, 203, 204],
    [500, 501, 502, 503, 504],
]


def _build_score_grid(lh, la, rho=-0.094):
    try:
        return DixonColesModel(lh, la, rho=rho).matrix(normalize=True), False
    except ValueError:
        return PoissonGoalModel(lh, la).matrix(normalize=True), True


def predict_probs(ens_h, ens_a, X):
    X = X.copy()
    if "league" in X.columns:
        X["league"] = X["league"].astype("category")
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


def y_index(h, a):
    return 0 if h > a else (2 if h < a else 1)


def train_and_score(
    lean_train: pd.DataFrame, lean_hold: pd.DataFrame,
    energy_train: pd.DataFrame, energy_hold: pd.DataFrame,
    y_h_train: np.ndarray, y_a_train: np.ndarray, y_true_hold: np.ndarray,
    extra_features: list, seeds: list[int],
) -> tuple[float, np.ndarray]:
    """Train ensembles with given seeds, return (overall Brier, per-match probs)."""
    X_tr_parts = [lean_train[NUMERIC_FEATURES]]
    X_ho_parts = [lean_hold[NUMERIC_FEATURES]]
    for f in extra_features:
        X_tr_parts.append(energy_train[[f]])
        X_ho_parts.append(energy_hold[[f]])
    X_tr = pd.concat(X_tr_parts, axis=1).copy()
    X_ho = pd.concat(X_ho_parts, axis=1).copy()
    X_tr["league"] = lean_train["league"].values
    X_ho["league"] = lean_hold["league"].values

    ens_h = BayesianEnsemble(n_models=len(seeds), seeds=seeds)
    ens_h.fit(X_tr, y_h_train, categorical_columns=["league"])
    ens_a = BayesianEnsemble(n_models=len(seeds), seeds=seeds)
    ens_a.fit(X_tr, y_a_train, categorical_columns=["league"])

    probs = predict_probs(ens_h, ens_a, X_ho)
    return brier_multiclass(y_true_hold, probs), probs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all-leagues", action="store_true",
                    help="Run on ALL leagues (not just Tier-A) for cross-tier confirmation")
    args = ap.parse_args()

    t_total = time.time()
    print("=" * 78)
    print("Phase A Step 2: Bootstrap Stability + Per-League Validation")
    print("=" * 78)

    leagues = None if args.all_leagues else list(TIER_A)
    label = "all-22-leagues" if args.all_leagues else "tier-a"
    print(f"Scope: {label}")

    # ── Load corpus ──
    print(f"\nLoading match pairs ({label})...")
    train_pairs = (
        load_match_pairs(cutoff="2025-08-01", since="2023-07-01", leagues=leagues)
        .dropna(subset=["home_goals", "away_goals"])
        .reset_index(drop=True)
    )
    holdout_pairs = (
        load_match_pairs(since="2025-08-01", leagues=leagues)
        .dropna(subset=["home_goals", "away_goals"])
        .reset_index(drop=True)
    )
    print(f"  train: {len(train_pairs):,}, holdout: {len(holdout_pairs):,}")

    print("Loading team_xg_history...")
    history = load_team_xg_history(leagues=leagues)
    history["match_date"] = pd.to_datetime(history["match_date"])

    print("Fitting calculators...")
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)

    print("Building features...")
    t0 = time.time()
    lean_train = build_features_for_corpus(
        train_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    lean_hold = build_features_for_corpus(
        holdout_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    print(f"  lean done in {time.time() - t0:.0f}s")
    t0 = time.time()
    energy_train = build_energy_features_for_corpus(train_pairs, history)
    energy_hold = build_energy_features_for_corpus(holdout_pairs, history)
    print(f"  energy done in {time.time() - t0:.0f}s")

    y_true_hold = np.array(
        [y_index(h, a) for h, a in zip(holdout_pairs["home_goals"], holdout_pairs["away_goals"])]
    )
    y_h_train = train_pairs["home_goals"].values
    y_a_train = train_pairs["away_goals"].values

    # Configurations to test
    # `frequenz_total_goals_diff` showed strong holdout-correlation (ρ=+0.10)
    # `energie_match_intensity_diff` showed the largest Δ (-0.0019)
    CONFIGS = [
        ("lean_only", []),
        ("+frequenz", ["frequenz_total_goals_diff"]),
        ("+energie", ["energie_match_intensity_diff"]),
        ("+top2", ["frequenz_total_goals_diff", "energie_match_intensity_diff"]),
        ("+all5", ENERGY_FEATURE_NAMES),
    ]

    # ─── TEST 1: Bootstrap with 5 seed-sets ───
    print()
    print("=" * 78)
    print("TEST 1: Bootstrap stability across 5 seed-sets")
    print("=" * 78)
    print(f"  {'Config':<14s} " + " ".join(f"{'seed%d'%i:>8s}" for i in range(len(SEED_SETS))) + "    mean  std")
    print("  " + "-" * 75)

    bootstrap_results = {}
    for name, extras in CONFIGS:
        briers = []
        for seeds in SEED_SETS:
            b, _ = train_and_score(
                lean_train, lean_hold, energy_train, energy_hold,
                y_h_train, y_a_train, y_true_hold,
                extras, seeds,
            )
            briers.append(b)
        mean = float(np.mean(briers))
        std = float(np.std(briers, ddof=0))
        bootstrap_results[name] = {
            "briers": [float(b) for b in briers],
            "mean": mean,
            "std": std,
            "extras": extras,
        }
        print(f"  {name:<14s} " + " ".join(f"{b:>8.4f}" for b in briers) + f"   {mean:.4f}  {std:.4f}")

    # Compute Δ vs lean_only mean across seeds
    baseline_mean = bootstrap_results["lean_only"]["mean"]
    print(f"\n  Δ vs lean_only (mean of {len(SEED_SETS)} seeds):")
    for name, r in bootstrap_results.items():
        if name == "lean_only":
            continue
        delta = r["mean"] - baseline_mean
        # SE of delta (assuming independent paired seeds)
        delta_se = np.sqrt(r["std"] ** 2 + bootstrap_results["lean_only"]["std"] ** 2) / np.sqrt(len(SEED_SETS))
        sig = "🟢 stable" if abs(delta) > 2 * delta_se else ("🟡 within-noise" if abs(delta) > delta_se else "🔴 noise")
        print(f"    {name:<14s} Δ = {delta:+.4f}  (~SE = {delta_se:.4f})    {sig}")
        bootstrap_results[name]["delta_vs_lean"] = float(delta)
        bootstrap_results[name]["delta_se"] = float(delta_se)

    # ─── TEST 3: Per-league Brier for top-2 ───
    print()
    print("=" * 78)
    print("TEST 3: Per-league Brier (lean vs lean+top2) — concentration check")
    print("=" * 78)

    # Re-train with default seeds, take per-match probs
    b_lean, probs_lean = train_and_score(
        lean_train, lean_hold, energy_train, energy_hold,
        y_h_train, y_a_train, y_true_hold,
        [], SEED_SETS[0],
    )
    b_top2, probs_top2 = train_and_score(
        lean_train, lean_hold, energy_train, energy_hold,
        y_h_train, y_a_train, y_true_hold,
        ["frequenz_total_goals_diff", "energie_match_intensity_diff"], SEED_SETS[0],
    )

    print(f"  {'League':<18s} {'n':>5s} {'B_lean':>8s} {'B_top2':>8s} {'Δ':>10s}")
    print("  " + "-" * 60)
    per_league = {}
    for liga in sorted(holdout_pairs["league"].unique()):
        mask = holdout_pairs["league"].values == liga
        n = int(mask.sum())
        if n < 30:
            continue
        bl = brier_multiclass(y_true_hold[mask], probs_lean[mask])
        bt = brier_multiclass(y_true_hold[mask], probs_top2[mask])
        delta = bt - bl
        per_league[liga] = {"n": n, "B_lean": float(bl), "B_top2": float(bt), "delta": float(delta)}
        marker = "🟢" if delta < -0.001 else ("🟡" if abs(delta) < 0.001 else "🔴")
        print(f"  {liga:<18s} {n:>5d} {bl:>8.4f} {bt:>8.4f}  {delta:+8.4f}  {marker}")

    # ─── Final Verdict ───
    print()
    print("=" * 78)
    print("VERDICT")
    print("=" * 78)

    top2_mean_delta = bootstrap_results["+top2"]["delta_vs_lean"]
    top2_se = bootstrap_results["+top2"]["delta_se"]
    energie_mean_delta = bootstrap_results["+energie"]["delta_vs_lean"]
    energie_se = bootstrap_results["+energie"]["delta_se"]

    helps_n = sum(1 for r in per_league.values() if r["delta"] < -0.001)
    hurts_n = sum(1 for r in per_league.values() if r["delta"] > 0.001)
    flat_n = len(per_league) - helps_n - hurts_n

    print(f"Bootstrap (5 seed sets, n_models=5 each):")
    print(f"  +energie alone:   Δ = {energie_mean_delta:+.4f} ± {energie_se:.4f}")
    print(f"  +top-2 combined:  Δ = {top2_mean_delta:+.4f} ± {top2_se:.4f}")
    print(f"Per-league (n_leagues = {len(per_league)}):")
    print(f"  helps (Δ<-0.001):  {helps_n}")
    print(f"  flat (|Δ|<0.001):  {flat_n}")
    print(f"  hurts (Δ>+0.001):  {hurts_n}")

    if top2_mean_delta < -0.001 and abs(top2_mean_delta) > 2 * top2_se and helps_n >= 4:
        verdict = "🟢 PROCEED to dev-08 training (signal stable across seeds + spread across leagues)"
    elif top2_mean_delta < -0.0005 and helps_n >= 3:
        verdict = "🟡 MARGINAL — train dev-08 BUT plan for Money-Eval ROI test before shipping"
    else:
        verdict = "🔴 ARCHIVE — signal is run-variance OR concentrated in 1-2 leagues (luck pattern)"
    print(f"\n{verdict}")

    out = {
        "scope": label,
        "n_train_matches": len(train_pairs),
        "n_holdout_matches": len(holdout_pairs),
        "bootstrap": bootstrap_results,
        "per_league": per_league,
        "summary": {
            "helps": helps_n, "flat": flat_n, "hurts": hurts_n,
            "top2_mean_delta": float(top2_mean_delta),
            "top2_se": float(top2_se),
            "verdict": verdict,
        },
        "duration_min": (time.time() - t_total) / 60.0,
    }
    out_path = REPO_ROOT / f"tools/v4/diagnostics/energy_freq_bootstrap_{label.replace('-', '_')}.json"
    with open(out_path, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nReport: {out_path.relative_to(REPO_ROOT)}")
    print(f"Total time: {(time.time() - t_total) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())

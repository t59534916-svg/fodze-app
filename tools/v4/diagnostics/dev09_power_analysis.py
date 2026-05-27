#!/usr/bin:/env python3
"""dev-09 G4 power analysis — required sample size for given Brier-Δ.

Per FODZE-Optimal-Blueprint audit committee binding: G4 must verify n_observed
≥ n_required for 80% power at α=0.05/m (m = number of features tested).

Day-3 dev-09 vector has m=11 numeric features → α_corrected = 0.05/11 = 0.00455.

Two independent power calculations:
  1. INTER-SEED stability — using std measured by dev09_multi_seed_bootstrap.py.
     This asks: "How many SEEDS would I need to detect a real architectural
     improvement?" Relevant for declaring "dev-09 architecture is better than
     dev-03 architecture" across multiple runs.
  2. PER-MATCH paired diff — using std of per-match Brier-diff between dev-09
     and a baseline (uniform 1/3 prior). Relevant for the actual G4 test
     "does THIS dev-09 vs THIS baseline have enough statistical power?"

What this answers:
  - Is n=7,018 matches in 24/25 holdout enough for 80% power?
  - For a target Δ=-0.005 (audit's directional bar), how many matches needed?
  - For the OBSERVED Δ=-0.0224 vs v2_benter, is current n sufficient?

Run:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_power_analysis.py \
    --tag dev-09-day3
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_NUMERIC_FEATURES,
    FeatureBuilderDev09,
    extract_X_dev09,
)
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.utils.falsification_protocol import (
    per_match_brier_stats,
    required_n_for_brier_delta,
    power_for_brier_delta,
)

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
BOOTSTRAP_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_multi_seed_bootstrap.json"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_power_analysis.json"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="dev-09-day3")
    ap.add_argument("--test-seasons", default="24/25")
    ap.add_argument("--top5-only", action="store_true",
                    help="Restrict to Top-5 leagues only (default: all 22)")
    args = ap.parse_args()

    print("═" * 70)
    print(f"dev-09 G4 POWER ANALYSIS · tag={args.tag}")
    print("═" * 70)

    # ─── (1) Inter-seed power from bootstrap ─────
    print()
    print("─" * 70)
    print("(1) INTER-SEED power (from dev09_multi_seed_bootstrap.json)")
    print("─" * 70)
    if not BOOTSTRAP_PATH.exists():
        print(f"  ⚠ Bootstrap not found at {BOOTSTRAP_PATH.name} — skipping inter-seed power")
        inter_seed_section = {"status": "skipped_no_bootstrap"}
    else:
        bootstrap = json.loads(BOOTSTRAP_PATH.read_text())
        sigma_seed = bootstrap["brier_std"]
        n_seeds = bootstrap["n_seeds"]
        brier_mean = bootstrap["brier_mean"]
        print(f"  σ_inter_seed (from {n_seeds} seeds): {sigma_seed:.5f}")
        print(f"  Brier mean across seeds:          {brier_mean:.4f}")
        print()
        # Question: if we observed Δ between two DIFFERENT runs (each = ensemble
        # mean of 5 seeds), how many seeds would we need to detect it?
        for delta_target in [-0.005, -0.002, -0.001, -0.0005]:
            n_req = required_n_for_brier_delta(
                delta=abs(delta_target), std_diff=sigma_seed, alpha=0.05/11, power=0.80
            )
            power_at_5 = power_for_brier_delta(
                delta=abs(delta_target), std_diff=sigma_seed, n=n_seeds,
                alpha=0.05/11,
            )
            print(f"  Target Δ={delta_target:+.4f}: needs n≥{n_req:>3} seeds for 80% power "
                  f"(observed n={n_seeds} gives power={power_at_5:.1%})")
        inter_seed_section = {
            "sigma_inter_seed": sigma_seed,
            "n_seeds_observed": n_seeds,
            "brier_mean": brier_mean,
            "required_n_for_delta_-0.005": required_n_for_brier_delta(0.005, sigma_seed, alpha=0.05/11),
            "required_n_for_delta_-0.002": required_n_for_brier_delta(0.002, sigma_seed, alpha=0.05/11),
            "required_n_for_delta_-0.001": required_n_for_brier_delta(0.001, sigma_seed, alpha=0.05/11),
        }

    # ─── (2) Per-match paired Brier-diff power ────
    print()
    print("─" * 70)
    print("(2) PER-MATCH paired Brier-diff power (dev-09 vs uniform baseline)")
    print("─" * 70)
    print("  Loading dev-09 + building holdout corpus...")

    home_pkl = ARTIFACTS_DIR / f"m3_xg-home-{args.tag}.pkl"
    away_pkl = ARTIFACTS_DIR / f"m3_xg-away-{args.tag}.pkl"
    if not home_pkl.exists() or not away_pkl.exists():
        print(f"  ✗ Missing artifacts for tag={args.tag}")
        return 1

    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    leagues = ("epl","la_liga","serie_a","bundesliga","ligue_1") if args.top5_only else None
    test_df = fb.build_corpus(seasons=tuple(args.test_seasons.split(",")),
                              leagues=leagues, verbose=True)
    X_test = extract_X_dev09(test_df)
    y_outcomes = np.array([_outcome_label(h, a) for h, a in
                            zip(test_df["home_goals"], test_df["away_goals"])], dtype=int)
    y_onehot = np.eye(3)[y_outcomes]

    ens_h = BayesianEnsemble.load(home_pkl)
    ens_a = BayesianEnsemble.load(away_pkl)
    X_aligned_h = X_test[ens_h.feature_names]
    X_aligned_a = X_test[ens_a.feature_names]
    mean_h, _ = ens_h.predict(X_aligned_h)
    mean_a, _ = ens_a.predict(X_aligned_a)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)

    n = len(X_test)
    p_dev09 = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(lambda_h[i], lambda_a[i], rho=DEFAULT_RHO).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lambda_h[i], lambda_a[i]).matrix(normalize=True)
        p1 = get_1x2(M)
        p_dev09[i] = [p1["H"], p1["D"], p1["A"]]

    p_uniform = np.full_like(p_dev09, 1.0/3.0)

    # Per-match Brier
    brier_dev09_per = ((p_dev09 - y_onehot) ** 2).sum(axis=1)
    brier_unif_per = ((p_uniform - y_onehot) ** 2).sum(axis=1)
    diff = brier_dev09_per - brier_unif_per  # negative = dev-09 better
    n_obs = len(diff)
    mean_d = float(diff.mean())
    std_d = float(diff.std(ddof=1))
    se_d = std_d / np.sqrt(n_obs)
    t_stat = mean_d / se_d

    print(f"  n_test:            {n_obs:,}")
    print(f"  Mean diff:         {mean_d:+.5f}  (dev-09 better when negative)")
    print(f"  σ_per_match:       {std_d:.5f}")
    print(f"  SE:                {se_d:.5f}")
    print(f"  t-stat:            {t_stat:+.2f}")
    print()

    print(f"  Power at observed n={n_obs:,}:")
    for delta_target in [-0.005, -0.002, -0.001, -0.0005]:
        p_obs = power_for_brier_delta(abs(delta_target), std_d, n_obs, alpha=0.05/11)
        n_req = required_n_for_brier_delta(abs(delta_target), std_d, alpha=0.05/11, power=0.80)
        suff = "✓ sufficient" if n_obs >= n_req else "✗ underpowered"
        print(f"    Target Δ={delta_target:+.4f}: power={p_obs:.1%}, "
              f"need n≥{n_req:,}  {suff}")
    print()

    # ─── (3) Decision summary ────
    print("─" * 70)
    print("(3) DECISION SUMMARY (per audit committee binding)")
    print("─" * 70)
    n_req_for_audit_threshold = required_n_for_brier_delta(
        0.0014, std_d, alpha=0.05/11, power=0.80,
    )
    print(f"  Audit-required min: 80% power at α=0.05/11=0.00455 to detect Δ=0.0014")
    print(f"  Required n:         {n_req_for_audit_threshold:,}")
    print(f"  Observed n:         {n_obs:,}  "
          f"{'(✓ POWERED)' if n_obs >= n_req_for_audit_threshold else '(✗ UNDERPOWERED)'}")

    # Save
    out = {
        "tag": args.tag,
        "test_seasons": args.test_seasons.split(","),
        "top5_only": args.top5_only,
        "n_test_matches": int(n_obs),
        "n_features_holm": len(DEV_09_NUMERIC_FEATURES),
        "alpha_corrected": 0.05 / len(DEV_09_NUMERIC_FEATURES),
        "inter_seed": inter_seed_section,
        "per_match": {
            "mean_brier_diff_vs_uniform": mean_d,
            "std_per_match_brier_diff": std_d,
            "se_per_match": se_d,
            "t_stat": float(t_stat),
            "n_test": int(n_obs),
            "power_at_observed_n": {
                f"delta_{abs(d):.4f}": power_for_brier_delta(abs(d), std_d, n_obs, alpha=0.05/11)
                for d in [-0.005, -0.002, -0.001, -0.0005]
            },
            "required_n_for_80pct_power": {
                f"delta_{abs(d):.4f}": required_n_for_brier_delta(abs(d), std_d, alpha=0.05/11, power=0.80)
                for d in [-0.005, -0.002, -0.001, -0.0005]
            },
        },
        "audit_decision": {
            "required_n_for_delta_0.0014": int(n_req_for_audit_threshold),
            "observed_n": int(n_obs),
            "powered": bool(n_obs >= n_req_for_audit_threshold),
        },
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\n  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

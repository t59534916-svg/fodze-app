"""
fit_rho.py — Fit Dixon-Coles ρ via MLE on a trained m3_xg predictor's training corpus.

Currently the XGPredictor uses DEFAULT_RHO=-0.094 (v2's Optuna value). That ρ
was tuned for v2's λ distribution. v4's m3_xg produces a different λ distribution,
so the optimal ρ may differ.

This script:
  1. Loads the trained m3_xg ensembles (home + away)
  2. Generates in-sample predictions on the training corpus
  3. Fits ρ via MLE (using m1_score.optimizer.fit_dixon_coles_rho)
  4. Saves fitted ρ to artifacts/m3_xg-rho-{tag}.json

Run:
  tools/venv/bin/python3 -I tools/v4/fit_rho.py --tag dev-01

Output JSON:
  {
    "tag": "dev-01",
    "fitted_rho": -0.0653,
    "rho_bounds": [-0.20, 0.13],
    "default_rho": -0.094,
    "nll_at_fitted": 12345.6,
    "nll_at_default": 12350.1,
    "n_training_matches": 27333,
    "fitted_at": "2026-05-12T..."
  }
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
from v4.modules.m1_score.optimizer import dixon_coles_nll, fit_dixon_coles_rho
from v4.modules.m2_lambda import LAMBDA_MAX, LAMBDA_MIN
from v4.modules.m3_xg import (
    BayesianEnsemble,
    DEFAULT_RHO,
    build_features_for_corpus,
    extract_X,
)

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fit Dixon-Coles ρ on m3 training corpus")
    p.add_argument("--tag", default="dev-02-elo",
                   help="Artifact tag (loads m3_xg-home-{tag}.pkl + m3_xg-away-{tag}.pkl)")
    p.add_argument("--cutoff", default="2025-08-01",
                   help="Training corpus cutoff (default: 2025-08-01)")
    p.add_argument("--since", default="2017-01-01",
                   help="Training corpus start (default: 2017-01-01)")
    p.add_argument("--rho-min", type=float, default=-0.20)
    p.add_argument("--rho-max", type=float, default=0.13)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.tag

    print("=" * 70)
    print(f"V4 m3_xg — Fit Dixon-Coles ρ · tag={tag}")
    print("=" * 70)

    # ───── Load trained ensembles ─────
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    if not home_path.exists() or not away_path.exists():
        print(f"✗ Missing artifacts. Run: tools/v4/train_m3_xg.py --tag {tag}")
        return 1

    t0 = time.time()
    ens_h = BayesianEnsemble.load(home_path)
    ens_a = BayesianEnsemble.load(away_path)
    print(f"  Loaded ensembles ({time.time()-t0:.1f}s)")

    # ───── Build training corpus features ─────
    t0 = time.time()
    history = load_team_xg_history()
    matches = load_match_pairs(cutoff=args.cutoff, since=args.since)
    matches = matches.dropna(subset=["home_goals", "away_goals"]).reset_index(drop=True)
    print(f"  Training matches: {len(matches):,} ({time.time()-t0:.1f}s)")

    t0 = time.time()
    features = build_features_for_corpus(matches, history, verbose=True)
    print(f"  Built features in {time.time()-t0:.1f}s")

    # ───── Generate predictions ─────
    X = extract_X(features)
    t0 = time.time()
    mean_h, _ = ens_h.predict(X)
    mean_a, _ = ens_a.predict(X)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    print(f"  Predicted λs in {time.time()-t0:.1f}s · "
          f"home_λ avg={lambda_h.mean():.2f}, away_λ avg={lambda_a.mean():.2f}")

    goals_h = features["home_goals"].astype(int).values
    goals_a = features["away_goals"].astype(int).values

    # ───── Compare NLL at default ρ vs fitted ρ ─────
    nll_default = dixon_coles_nll(DEFAULT_RHO, lambda_h, lambda_a, goals_h, goals_a)
    print(f"  NLL at default ρ={DEFAULT_RHO:+.4f}: {nll_default:.2f}")

    # ───── Fit ρ via MLE ─────
    t0 = time.time()
    result = fit_dixon_coles_rho(
        lambda_h, lambda_a, goals_h, goals_a,
        rho_bounds=(args.rho_min, args.rho_max),
        initial_rho=DEFAULT_RHO,
    )
    fitted_rho = float(result.x[0])
    nll_fitted = float(result.fun)
    print(f"  Fit complete in {time.time()-t0:.1f}s")
    print(f"  Fitted ρ: {fitted_rho:+.4f} (NLL={nll_fitted:.2f})")
    print(f"  Delta NLL: {nll_fitted - nll_default:+.4f} "
          f"(negative = fitted ρ better)")
    print(f"  Optimizer converged: {result.success}")

    # ───── Save ─────
    output_path = ARTIFACTS_DIR / f"m3_xg-rho-{tag}.json"
    payload = {
        "tag": tag,
        "fitted_rho": fitted_rho,
        "rho_bounds": [args.rho_min, args.rho_max],
        "default_rho": DEFAULT_RHO,
        "nll_at_fitted": nll_fitted,
        "nll_at_default": float(nll_default),
        "nll_delta": float(nll_fitted - nll_default),
        "n_training_matches": int(len(matches)),
        "lambda_h_mean": float(lambda_h.mean()),
        "lambda_a_mean": float(lambda_a.mean()),
        "optimizer_converged": bool(result.success),
        "fitted_at": datetime.now().isoformat(),
    }
    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"  Saved: {output_path.relative_to(REPO_ROOT)}")
    print()
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

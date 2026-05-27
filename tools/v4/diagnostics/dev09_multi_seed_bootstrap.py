#!/usr/bin/env python3
"""dev-09 multi-seed bootstrap — empirical inter-seed Brier variance.

Phase 4.1 refactor (audit-binding 2026-05-28): in-process execution.
  - BottomUpCalculator + FeatureBuilderDev09.fit() called ONCE
  - Feature matrices built ONCE for train + test
  - Loop trains N ensembles with seed-offsets [0, 100, ..., (N-1)*100]
  - Each ensemble evaluated on the SAME pre-built test matrix
  - Per-seed manifests written for reproducibility

Eliminates the Day-3 subprocess-overhead bug (BC.fit() was running 10×
across train+eval subprocess calls per ensemble, ~3 min wasted per run).

What this does:
  1. Trains N independent dev-09 ensembles with disjoint seed-sets
     (default: 5 ensembles × 5 bagged models = 25 models total)
  2. Evaluates each on the holdout via Dixon-Coles score-grid + Brier
  3. Aggregates Brier mean / std / 95% bootstrap-CI across ensembles
  4. Reports the empirical inter-seed noise floor for dev-09 architecture

Output:
  tools/v4/diagnostics/dev09_multi_seed_bootstrap.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_multi_seed_bootstrap.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_multi_seed_bootstrap.py \
    --train-seasons 22/23,23/24,24/25 --test-seasons 25/26 --tag-prefix dev-09-phase42
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Sequence

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_LGB_PARAMS, DEFAULT_RHO
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_CATEGORICAL_FEATURES,
    DEV_09_NUMERIC_FEATURES,
    FeatureBuilderDev09,
    extract_X_dev09,
)
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.eval.metrics import brier_multiclass

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_multi_seed_bootstrap.json"

LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0
TOP5 = ("epl", "la_liga", "serie_a", "bundesliga", "ligue_1")


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def _predict_brier(ens_h, ens_a, X_test: pd.DataFrame, y_outcomes: np.ndarray,
                   leagues: pd.Series) -> dict:
    """Compute Brier 1X2 + per-Liga breakdown given fitted ensembles."""
    X_aligned_h = X_test[ens_h.feature_names]
    X_aligned_a = X_test[ens_a.feature_names]
    mean_h, _ = ens_h.predict(X_aligned_h)
    mean_a, _ = ens_a.predict(X_aligned_a)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    n = len(X_test)
    p1x2 = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(lambda_h[i], lambda_a[i], rho=DEFAULT_RHO).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lambda_h[i], lambda_a[i]).matrix(normalize=True)
        p = get_1x2(M)
        p1x2[i] = [p["H"], p["D"], p["A"]]
    brier = float(brier_multiclass(y_outcomes, p1x2))
    per_liga = {}
    for lg in sorted(leagues.cat.categories):
        mask = (leagues == lg).values
        if mask.sum() < 10:
            continue
        per_liga[lg] = {
            "n": int(mask.sum()),
            "brier": float(brier_multiclass(y_outcomes[mask], p1x2[mask])),
        }
    return {"brier": brier, "per_liga": per_liga}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-seeds", type=int, default=5)
    ap.add_argument("--seed-offsets", default=None,
                    help="Comma-separated offsets (overrides --n-seeds). Default: 0,100,200,300,400")
    ap.add_argument("--train-seasons", default="22/23,23/24",
                    help="Comma-separated training seasons (default: 22/23,23/24 — Day-3 corpus)")
    ap.add_argument("--test-seasons", default="24/25",
                    help="Comma-separated test seasons (default: 24/25 — Day-3 holdout)")
    ap.add_argument("--leagues", default="ALL",
                    help="Comma-separated leagues for train, or ALL")
    ap.add_argument("--test-leagues", default=None,
                    help="Comma-separated leagues for test; default = same as --leagues")
    ap.add_argument("--tag-prefix", default="dev-09-seed",
                    help="Artifact tag prefix (default: dev-09-seed) — full tag = "
                         "{prefix}-{offset:03d}")
    args = ap.parse_args()

    if args.seed_offsets:
        offsets = [int(x) for x in args.seed_offsets.split(",")]
    else:
        offsets = [i * 100 for i in range(args.n_seeds)]

    train_seasons = tuple(args.train_seasons.split(","))
    test_seasons = tuple(args.test_seasons.split(","))
    leagues = None if args.leagues.strip().upper() == "ALL" else tuple(args.leagues.split(","))
    test_leagues = (tuple(args.test_leagues.split(",")) if args.test_leagues else leagues)
    # If test_leagues was inherited from leagues=None (ALL), keep it None
    if test_leagues is leagues and leagues is None:
        test_leagues = None

    print("═" * 70)
    print(f"dev-09 multi-seed bootstrap (in-process) · {len(offsets)} ensembles")
    print("═" * 70)
    print(f"  Train seasons: {train_seasons}")
    print(f"  Test seasons:  {test_seasons}")
    print(f"  Train leagues: {'ALL' if leagues is None else leagues}")
    print(f"  Test leagues:  {'ALL' if test_leagues is None else test_leagues}")
    print(f"  Seed offsets:  {offsets}")
    print(f"  Each ensemble uses 5 bagged LightGBM with seeds [42+o, 43+o, ..., 46+o]")
    print()

    # ─── Build features ONCE (cache reused across all seeds) ─────
    t0 = time.time()
    print(f"  Fitting FeatureBuilderDev09 (BC + sofa_context) ONCE...")
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    print(f"    BC stats: {fb._bc.stats()}")
    print(f"    Done in {time.time()-t0:.1f}s")

    t0 = time.time()
    print(f"  Building train corpus ({train_seasons})...")
    train_df = fb.build_corpus(seasons=train_seasons, leagues=leagues, verbose=True)
    print(f"    Done in {time.time()-t0:.1f}s")

    t0 = time.time()
    print(f"  Building test corpus ({test_seasons})...")
    test_df = fb.build_corpus(seasons=test_seasons, leagues=test_leagues, verbose=True)
    print(f"    Done in {time.time()-t0:.1f}s")
    print()

    X_train = extract_X_dev09(train_df)
    y_h_train = train_df["home_goals"].values
    y_a_train = train_df["away_goals"].values

    X_test = extract_X_dev09(test_df)
    y_outcomes = np.array([_outcome_label(h, a) for h, a in
                            zip(test_df["home_goals"], test_df["away_goals"])], dtype=int)
    test_leagues_col = test_df["league"]

    # ─── Train + evaluate each seed-offset ensemble ──────
    results = {}
    for offset in offsets:
        tag = f"{args.tag_prefix}-{offset:03d}"
        print(f"  → Seed-offset {offset:3d} (tag={tag})...")
        seeds = [42 + i + offset for i in range(5)]
        t0 = time.time()
        ens_h = BayesianEnsemble(n_models=5, seeds=seeds)
        ens_h.fit(X_train, y_h_train, categorical_columns=DEV_09_CATEGORICAL_FEATURES)
        ens_a = BayesianEnsemble(n_models=5, seeds=seeds)
        ens_a.fit(X_train, y_a_train, categorical_columns=DEV_09_CATEGORICAL_FEATURES)
        train_time = time.time() - t0

        t0 = time.time()
        evals = _predict_brier(ens_h, ens_a, X_test, y_outcomes, test_leagues_col)
        eval_time = time.time() - t0

        # Save pickles + per-seed manifest
        ARTIFACTS_DIR.mkdir(exist_ok=True)
        home_pkl = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
        away_pkl = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
        manifest_pkl = ARTIFACTS_DIR / f"m3_xg-{tag}.json"
        ens_h.save(home_pkl)
        ens_a.save(away_pkl)
        manifest_pkl.write_text(json.dumps({
            "tag": tag,
            "architecture": "dev-09-TABULA-RASA-bottom-up",
            "trained_at": datetime.now().isoformat(),
            "train_seasons": list(train_seasons),
            "test_seasons": list(test_seasons),
            "leagues": "ALL" if leagues is None else list(leagues),
            "seeds": seeds,
            "seed_offset": offset,
            "n_models": 5,
            "n_train_matches": int(len(train_df)),
            "n_test_matches": int(len(test_df)),
            "feature_names": DEV_09_NUMERIC_FEATURES + DEV_09_CATEGORICAL_FEATURES,
            "holdout_brier": evals["brier"],
            "per_liga": evals["per_liga"],
            "train_time_sec": train_time,
            "eval_time_sec": eval_time,
        }, indent=2))

        results[tag] = {
            "status": "ok",
            "seed_offset": offset,
            "seeds": seeds,
            "holdout_brier": evals["brier"],
            "per_liga": evals["per_liga"],
        }
        print(f"    Brier={evals['brier']:.4f}  ({train_time:.1f}s train, {eval_time:.1f}s eval)")

    ok = [r for r in results.values() if r.get("status") == "ok"]
    if len(ok) < 2:
        print(f"\n  ✗ Only {len(ok)} successful ensembles")
        return 1

    briers = [r["holdout_brier"] for r in ok]
    mean = float(np.mean(briers))
    std = float(np.std(briers, ddof=1))
    ci_low = float(mean - 1.96 * std / np.sqrt(len(briers)))
    ci_high = float(mean + 1.96 * std / np.sqrt(len(briers)))

    print()
    print("═" * 70)
    print("BOOTSTRAP RESULT (dev-09 in-process)")
    print("═" * 70)
    print(f"  Successful ensembles: {len(ok)}/{len(offsets)}")
    for r in sorted(ok, key=lambda x: x["seed_offset"]):
        print(f"    seed-offset {r['seed_offset']:03d}: Brier={r['holdout_brier']:.4f}")
    print()
    print(f"  Brier mean:        {mean:.4f}")
    print(f"  Brier std:         {std:.4f}")
    print(f"  95% CI on mean:    [{ci_low:.4f}, {ci_high:.4f}]")
    print(f"  Range (max−min):   {max(briers)-min(briers):.4f}")
    print()
    print(f"  EMPIRICAL NOISE FLOOR for dev-09 (1σ): {std:.4f}")
    print(f"  dev-03's empirical σ (CLAUDE.md):     0.000456")
    print(f"  Ratio dev-09 / dev-03: {std/0.000456:.2f}×")

    # Per-league bootstrap analysis
    per_lg_stats: dict = {}
    if all(r.get("per_liga") for r in ok):
        print()
        print("─" * 70)
        print(f"  Per-league Brier across {len(ok)} seeds:")
        print("─" * 70)
        per_lg: dict = {}
        for r in ok:
            for lg, m in r["per_liga"].items():
                per_lg.setdefault(lg, []).append(m["brier"])
        for lg, vals in sorted(per_lg.items(), key=lambda x: np.std(x[1], ddof=1) if len(x[1]) > 1 else 0):
            if len(vals) >= 2:
                m_v, s_v = float(np.mean(vals)), float(np.std(vals, ddof=1))
                per_lg_stats[lg] = {"mean": m_v, "std": s_v, "n_seeds": len(vals)}
                print(f"    {lg:<18} mean={m_v:.4f}  std={s_v:.4f}  (range {max(vals)-min(vals):.4f})")

    OUT_PATH.write_text(json.dumps({
        "architecture": "dev-09-TABULA-RASA-bottom-up",
        "phase": "4.1+",
        "train_seasons": list(train_seasons),
        "test_seasons": list(test_seasons),
        "leagues": "ALL" if leagues is None else list(leagues),
        "test_leagues": "ALL" if test_leagues is None else list(test_leagues),
        "n_seeds": len(ok),
        "seed_offsets": offsets,
        "feature_names": DEV_09_NUMERIC_FEATURES + DEV_09_CATEGORICAL_FEATURES,
        "ensemble_briers": [
            {"seed_offset": r["seed_offset"], "brier": r["holdout_brier"], "seeds": r["seeds"]}
            for r in sorted(ok, key=lambda x: x["seed_offset"])
        ],
        "brier_mean": mean,
        "brier_std": std,
        "brier_ci_95": [ci_low, ci_high],
        "brier_range": max(briers) - min(briers),
        "empirical_noise_floor_1sigma": std,
        "dev03_noise_floor_for_comparison": 0.000456,
        "interpretation": (
            f"For dev-09 architecture: any single-seed Brier-improvement Δ < {std:.4f} "
            f"is indistinguishable from run-noise. Per-feature G2 Holm correction requires "
            f"Δ > ~2σ ({2*std:.4f}) for individual feature claims to survive correction at "
            f"α=0.05/11 = 0.00455."
        ),
        "per_league_stats": per_lg_stats,
    }, indent=2))
    print(f"\n  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

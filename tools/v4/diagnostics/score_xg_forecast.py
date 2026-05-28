#!/usr/bin/env python3
"""score_xg_forecast — the NEW-objective scoreboard (2026-05-28).

Objective change: we now optimize/score for FORECAST QUALITY, not betting edge.
  PRIMARY (coupled): predicted λ (expected goals) vs REALIZED xG  →  xG-RMSE/MAE/bias
                     + the 1X2-Brier derived from the SAME λ via the DC matrix.
  SECONDARY (tiebreaker, NOT a veto): Pinnacle ROI (handled by dev09_g5_directional_roi.py).

This harness scores each engine's λ_home/λ_away against the realized home_xg/away_xg
from team_xg_history (via load_match_pairs — 100% coverage on 25/26) on the exact
same 25/26 holdout the dev-03-vs-dev-09 H2H used. Both engines use RAW DC→1X2
(no isotonic) so the comparison is model-vs-model, not pipeline-vs-pipeline.

Caveat (documented): "realized xG" is itself a model output (Understat/Sofa), not
ground truth like goals. Scoring λ against it is lower-variance than scoring against
goals, but measures agreement with another model's chance-quality estimate.

Output: tools/v4/diagnostics/score_xg_forecast.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/score_xg_forecast.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/score_xg_forecast.py \
    --dev09-tag dev-09-phase42-seed-000 --dev03-tag dev-03
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.eval.metrics import xg_forecast_report, bootstrap_ci
from v4.data.loaders import load_team_xg_history, load_match_pairs

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "score_xg_forecast.json"

LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0


def _outcome_label(h: float, a: float) -> int:
    if h > a:
        return 0
    if h < a:
        return 2
    return 1


def _lambdas_to_1x2(lambda_h: np.ndarray, lambda_a: np.ndarray, rho: float) -> np.ndarray:
    """λ pair → DC score grid → 1X2 probabilities (Poisson fallback on ValueError)."""
    n = len(lambda_h)
    p1x2 = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(lambda_h[i], lambda_a[i], rho=rho).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lambda_h[i], lambda_a[i]).matrix(normalize=True)
        p = get_1x2(M)
        p1x2[i] = [p["H"], p["D"], p["A"]]
    return p1x2


def _dev09_lambdas(ens_h, ens_a, X: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
    mean_h, _ = ens_h.predict(X[ens_h.feature_names])
    mean_a, _ = ens_a.predict(X[ens_a.feature_names])
    return (
        np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX),
        np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX),
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dev09-tag", default="dev-09-phase42-seed-000")
    p.add_argument("--dev03-tag", default="dev-03")
    p.add_argument("--test-seasons", default="25/26")
    p.add_argument("--rho", type=float, default=DEFAULT_RHO)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    test_seasons = tuple(args.test_seasons.split(","))

    print("═" * 72)
    print(f"xG-FORECAST SCOREBOARD · {test_seasons} holdout · NEW objective")
    print("  PRIMARY: λ vs realized xG (RMSE/MAE/bias) + 1X2-Brier (coupled)")
    print("  ROI = secondary tiebreaker (see dev09_g5_directional_roi.py)")
    print("═" * 72)

    # ─── Load engines ───
    d09_h = BayesianEnsemble.load(ARTIFACTS_DIR / f"m3_xg-home-{args.dev09_tag}.pkl")
    d09_a = BayesianEnsemble.load(ARTIFACTS_DIR / f"m3_xg-away-{args.dev09_tag}.pkl")
    d03 = XGPredictor.from_artifacts(
        home_path=ARTIFACTS_DIR / f"m3_xg-home-{args.dev03_tag}.pkl",
        away_path=ARTIFACTS_DIR / f"m3_xg-away-{args.dev03_tag}.pkl",
        rho=args.rho,
    )
    print(f"  ✓ dev-09 ({d09_h.n_models} bagged) + dev-03 loaded")

    # ─── Build 25/26 holdout corpus (Sofa-native) + canonicalize ───
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    test = fb.build_corpus(seasons=test_seasons, leagues=None, verbose=False)
    test["canonical_home"] = test.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    test["canonical_away"] = test.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    test["match_date_d"] = pd.to_datetime(test["match_date"]).dt.normalize()
    print(f"  ✓ holdout corpus: {len(test):,} matches")

    # ─── Realized xG lookup (team_xg_history via load_match_pairs) ───
    pairs = load_match_pairs(since="2025-07-01")
    pairs = pairs.dropna(subset=["home_xg", "away_xg"])
    xg_lookup: Dict[tuple, Tuple[float, float]] = {}
    for r in pairs.itertuples(index=False):
        key = (r.league, pd.Timestamp(r.match_date).date(), r.home, r.away)
        xg_lookup[key] = (float(r.home_xg), float(r.away_xg))

    real_h = np.full(len(test), np.nan)
    real_a = np.full(len(test), np.nan)
    for i, r in enumerate(test.itertuples(index=False)):
        key = (r.league, pd.Timestamp(r.match_date_d).date(), r.canonical_home, r.canonical_away)
        hit = xg_lookup.get(key)
        if hit is not None:
            real_h[i], real_a[i] = hit
    has_xg = ~np.isnan(real_h) & ~np.isnan(real_a)
    print(f"  ✓ realized-xG matched: {has_xg.sum():,}/{len(test):,} ({100*has_xg.mean():.1f}%)")
    print()

    # ─── dev-03 input + predictions (raw DC, no isotonic) ───
    d03_input = pd.DataFrame({
        "league": test["league"].astype(str),
        "match_date": test["match_date_d"],
        "home": test["canonical_home"],
        "away": test["canonical_away"],
        "home_goals": test["home_goals"],
        "away_goals": test["away_goals"],
    })
    history = load_team_xg_history()
    d03_preds = d03.predict_batch(d03_input, history, verbose=False)
    if len(d03_preds) != len(test):
        print(f"  ✗ dev-03 row-order contract broken ({len(d03_preds)} vs {len(test)})")
        return 1
    lam_h_03 = d03_preds["lambda_h"].to_numpy(dtype=float)
    lam_a_03 = d03_preds["lambda_a"].to_numpy(dtype=float)
    p03 = np.column_stack([d03_preds["prob_h"], d03_preds["prob_d"], d03_preds["prob_a"]])

    # ─── dev-09 predictions ───
    X_test = extract_X_dev09(test)
    lam_h_09, lam_a_09 = _dev09_lambdas(d09_h, d09_a, X_test)
    p09 = _lambdas_to_1x2(lam_h_09, lam_a_09, args.rho)

    # ─── Ground truth ───
    y = np.array([_outcome_label(h, a) for h, a in zip(test["home_goals"], test["away_goals"])], dtype=int)
    y1h = np.eye(3)[y]
    brier09_pm = ((p09 - y1h) ** 2).sum(axis=1)
    brier03_pm = ((p03 - y1h) ** 2).sum(axis=1)

    # ─── xG-forecast reports (stacked home+away, only matched rows) ───
    def _xg_report(lam_h, lam_a):
        pred = np.concatenate([lam_h[has_xg], lam_a[has_xg]])
        real = np.concatenate([real_h[has_xg], real_a[has_xg]])
        return xg_forecast_report(pred, real)

    rep09 = _xg_report(lam_h_09, lam_a_09)
    rep03 = _xg_report(lam_h_03, lam_a_03)

    # Per-match abs-error (stacked) for paired delta + bootstrap CI
    ae09 = np.abs(np.concatenate([lam_h_09[has_xg], lam_a_09[has_xg]]) -
                  np.concatenate([real_h[has_xg], real_a[has_xg]]))
    ae03 = np.abs(np.concatenate([lam_h_03[has_xg], lam_a_03[has_xg]]) -
                  np.concatenate([real_h[has_xg], real_a[has_xg]]))
    se09 = ae09 ** 2
    se03 = ae03 ** 2
    rmse_delta = float(np.sqrt(se09.mean()) - np.sqrt(se03.mean()))  # <0 = dev-09 better
    mae_delta = float(ae09.mean() - ae03.mean())
    # Bootstrap CI of the paired RMSE delta (resample match-side index)
    rng = np.random.default_rng(42)
    idx = np.arange(len(se09))
    boot = []
    for _ in range(2000):
        s = rng.choice(idx, size=len(idx), replace=True)
        boot.append(np.sqrt(se09[s].mean()) - np.sqrt(se03[s].mean()))
    rmse_delta_ci = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]

    brier_delta = float(brier09_pm.mean() - brier03_pm.mean())

    # ─── Report ───
    print("─" * 72)
    print(f"{'ENGINE':<10} {'xG-RMSE':>8} {'xG-MAE':>8} {'xG-bias':>8} {'pearson_r':>9} {'Brier':>8}")
    print("─" * 72)
    print(f"{'dev-03':<10} {rep03['rmse']:>8.4f} {rep03['mae']:>8.4f} {rep03['bias']:>+8.4f} "
          f"{rep03['pearson_r']:>9.4f} {brier03_pm.mean():>8.4f}")
    print(f"{'dev-09':<10} {rep09['rmse']:>8.4f} {rep09['mae']:>8.4f} {rep09['bias']:>+8.4f} "
          f"{rep09['pearson_r']:>9.4f} {brier09_pm.mean():>8.4f}")
    print("─" * 72)
    print(f"  Realized-xG mean: {rep03['mean_realized']:.4f}  (n={rep03['n']:,} team-sides)")
    print()
    print(f"  PAIRED dev-09 − dev-03:")
    print(f"    xG-RMSE Δ:  {rmse_delta:+.4f}  95%CI [{rmse_delta_ci[0]:+.4f}, {rmse_delta_ci[1]:+.4f}]  "
          f"({'dev-09 better' if rmse_delta < 0 else 'dev-03 better'})")
    print(f"    xG-MAE  Δ:  {mae_delta:+.4f}")
    print(f"    Brier   Δ:  {brier_delta:+.5f}  ({'dev-09 better' if brier_delta < 0 else 'dev-03 better'})")
    print()

    # ─── Per-league xG-RMSE + Brier ───
    per_league = []
    for lg in sorted(test["league"].astype(str).unique()):
        m = (test["league"].astype(str) == lg).to_numpy() & has_xg
        if m.sum() < 10:
            continue
        n_lg = int(m.sum())
        pr09 = np.concatenate([lam_h_09[m], lam_a_09[m]])
        pr03 = np.concatenate([lam_h_03[m], lam_a_03[m]])
        rl = np.concatenate([real_h[m], real_a[m]])
        rmse09 = float(np.sqrt(np.mean((pr09 - rl) ** 2)))
        rmse03 = float(np.sqrt(np.mean((pr03 - rl) ** 2)))
        # Brier on the 1X2 axis uses the match-level mask
        bm = (test["league"].astype(str) == lg).to_numpy() & has_xg
        b09 = float(brier09_pm[bm].mean())
        b03 = float(brier03_pm[bm].mean())
        per_league.append({
            "league": lg, "n": n_lg,
            "xg_rmse_dev03": rmse03, "xg_rmse_dev09": rmse09, "xg_rmse_delta": rmse09 - rmse03,
            "brier_dev03": b03, "brier_dev09": b09, "brier_delta": b09 - b03,
        })

    print("─" * 72)
    print(f"  {'league':<16} {'n':>4} {'RMSE03':>7} {'RMSE09':>7} {'Δrmse':>7} {'Bri03':>7} {'Bri09':>7}")
    for h in per_league:
        print(f"  {h['league']:<16} {h['n']:>4} {h['xg_rmse_dev03']:>7.4f} {h['xg_rmse_dev09']:>7.4f} "
              f"{h['xg_rmse_delta']:>+7.4f} {h['brier_dev03']:>7.4f} {h['brier_dev09']:>7.4f}")
    print()

    # ─── Verdict (forecast-primary; ROI is a separate secondary tiebreaker) ───
    rmse_better = rmse_delta < 0 and rmse_delta_ci[1] < 0   # CI strictly < 0
    brier_better = brier_delta < 0
    if rmse_better and brier_better:
        verdict = "dev-09 wins BOTH axes (xG-RMSE CI<0 + Brier) — strong forecast candidate"
    elif (rmse_delta < 0) and brier_better:
        verdict = "dev-09 better on both point-estimates (RMSE CI straddles 0) — lean dev-09"
    elif brier_better and rmse_delta >= 0:
        verdict = "split: dev-09 better Brier but NOT better xG-RMSE — investigate"
    elif rmse_delta < 0 and not brier_better:
        verdict = "split: dev-09 better xG-RMSE but NOT Brier — investigate"
    else:
        verdict = "dev-03 holds both axes — keep dev-03"

    out = {
        "objective": "xg-forecast primary (RMSE/MAE/bias) + 1x2-brier coupled; ROI secondary tiebreaker",
        "test_seasons": list(test_seasons),
        "dev09_tag": args.dev09_tag,
        "dev03_tag": args.dev03_tag,
        "rho": args.rho,
        "n_test": int(len(test)),
        "n_with_realized_xg": int(has_xg.sum()),
        "realized_xg_coverage_pct": float(100 * has_xg.mean()),
        "calibration": "RAW DC→1X2 for both engines (no isotonic/benter) — model-vs-model",
        "engines": {
            "dev-03": {"xg": rep03, "brier": float(brier03_pm.mean())},
            "dev-09": {"xg": rep09, "brier": float(brier09_pm.mean())},
        },
        "paired_dev09_minus_dev03": {
            "xg_rmse_delta": rmse_delta,
            "xg_rmse_delta_ci95": rmse_delta_ci,
            "xg_mae_delta": mae_delta,
            "brier_delta": brier_delta,
        },
        "per_league": per_league,
        "verdict": verdict,
        "_caveats": [
            "Realized xG is a model output (Understat/Sofa), not ground truth like goals.",
            "Both engines scored on RAW DC→1X2 (no isotonic) — model quality, not pipeline.",
            "ROI is a SECONDARY tiebreaker (not scored here): see dev09_g5_directional_roi.py.",
        ],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print("═" * 72)
    print(f"VERDICT: {verdict}")
    print(f"  ✓ {OUT_PATH.relative_to(REPO_ROOT)}")
    print("═" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())

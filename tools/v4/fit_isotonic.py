"""
fit_isotonic.py — Fit isotonic post-calibration on a held-out calibration window.

Calibration set design (compromise between rigor and simplicity):
  - Training corpus: 2017-08 → 2025-07 (model trained on this)
  - Calibration window: last 12 months of training corpus (2024-08 → 2025-07)
  - The model HAS seen the calibration window during training (no clean OOF preds
    available without re-training with k-fold). This is "soft-leakage": the model
    has fit to these labels, so its predictions are slightly optimistic.
  - Net effect: fitted isotonic may slightly OVER-correct, but evaluation on
    true OOS holdout (25/26) tells us if it generalizes.

Run: tools/venv/bin/python3 -I tools/v4/fit_isotonic.py --tag dev-01

Output: artifacts/m3_xg-isotonic-{tag}.pkl + manifest entry

Alternative cleaner design (deferred): proper k-fold ensemble where each fold's
training set excludes the calibration window, giving true OOF predictions.
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
from v4.eval.metrics import brier_multiclass, ece
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.isotonic_calibrator import IsotonicCalibrator

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fit isotonic post-calibration on m3 outputs")
    p.add_argument("--tag", default="dev-02-elo")
    p.add_argument("--calibration-window-months", type=int, default=12,
                   help="How many months before cutoff to use for calibration (default 12)")
    p.add_argument("--cutoff", default="2025-08-01",
                   help="Train/holdout boundary")
    return p.parse_args()


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def main() -> int:
    args = parse_args()
    tag = args.tag

    print("=" * 70)
    print(f"V4 m3_xg — Fit Isotonic Calibration · tag={tag}")
    print("=" * 70)

    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    if not (home_path.exists() and away_path.exists()):
        print(f"✗ Missing artifacts. Run train_m3_xg.py --tag {tag}")
        return 1

    # Load predictor (use default ρ for consistency with Stage 1)
    predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
    print(f"  Predictor loaded (ρ={predictor.rho:+.4f})")

    # Calibration window
    cal_end = pd.Timestamp(args.cutoff)
    cal_start = cal_end - pd.DateOffset(months=args.calibration_window_months)
    print(f"  Calibration window: {cal_start.date()} → {cal_end.date()}")
    print(f"  (these matches WERE seen by the model during training — soft-leakage)")

    # Load data
    history = load_team_xg_history()
    cal_matches = load_match_pairs(since=cal_start.strftime("%Y-%m-%d"),
                                    cutoff=cal_end.strftime("%Y-%m-%d"))
    cal_matches = cal_matches.dropna(subset=["home_goals", "away_goals"]).reset_index(drop=True)
    print(f"  Calibration matches: {len(cal_matches):,}")

    # Predict
    t0 = time.time()
    preds = predictor.predict_batch(cal_matches, history, verbose=True)
    print(f"  Predicted in {time.time()-t0:.1f}s")

    # Outcomes
    outcomes_1x2 = np.array([
        _outcome_label(h, a)
        for h, a in zip(cal_matches["home_goals"].values, cal_matches["away_goals"].values)
    ], dtype=int)
    total_goals = cal_matches["home_goals"].values + cal_matches["away_goals"].values
    outcomes_o25 = (total_goals > 2.5).astype(float)
    outcomes_btts = (
        (cal_matches["home_goals"].values >= 1)
        & (cal_matches["away_goals"].values >= 1)
    ).astype(float)

    # Pre-calibration metrics
    p_pre = preds[["prob_h", "prob_d", "prob_a"]].values
    p_pre = p_pre / p_pre.sum(axis=1, keepdims=True)
    brier_pre = brier_multiclass(outcomes_1x2, p_pre)
    ece_h_pre = ece((outcomes_1x2 == 0).astype(float), preds["prob_h"].values, n_bins=10)
    ece_d_pre = ece((outcomes_1x2 == 1).astype(float), preds["prob_d"].values, n_bins=10)
    ece_a_pre = ece((outcomes_1x2 == 2).astype(float), preds["prob_a"].values, n_bins=10)
    ece_o_pre = ece(outcomes_o25, preds["prob_over25"].values, n_bins=10)
    ece_btts_pre = ece(outcomes_btts, preds["prob_btts_yes"].values, n_bins=10)

    print()
    print(f"  Pre-cal metrics (calibration set, in-training):")
    print(f"    1X2 Brier: {brier_pre:.4f}")
    print(f"    ECE P(H):  {ece_h_pre:.4f}")
    print(f"    ECE P(D):  {ece_d_pre:.4f}")
    print(f"    ECE P(A):  {ece_a_pre:.4f}")
    print(f"    ECE P(O25):{ece_o_pre:.4f}")
    print(f"    ECE P(BTTS):{ece_btts_pre:.4f}")

    # Fit isotonic
    probs_dict = {
        "H": preds["prob_h"].values,
        "D": preds["prob_d"].values,
        "A": preds["prob_a"].values,
        "over25": preds["prob_over25"].values,
        "btts_yes": preds["prob_btts_yes"].values,
    }
    calib = IsotonicCalibrator().fit(
        probs_dict,
        outcomes_1x2=outcomes_1x2,
        outcomes_o25=outcomes_o25,
        outcomes_btts=outcomes_btts,
    )

    # Post-calibration metrics (in-sample sanity)
    cal_probs = calib.calibrate_probs(probs_dict)
    p_post = np.column_stack([cal_probs["H"], cal_probs["D"], cal_probs["A"]])
    brier_post = brier_multiclass(outcomes_1x2, p_post)
    ece_h_post = ece((outcomes_1x2 == 0).astype(float), cal_probs["H"], n_bins=10)
    ece_d_post = ece((outcomes_1x2 == 1).astype(float), cal_probs["D"], n_bins=10)
    ece_a_post = ece((outcomes_1x2 == 2).astype(float), cal_probs["A"], n_bins=10)
    ece_o_post = ece(outcomes_o25, cal_probs["over25"], n_bins=10)
    ece_btts_post = ece(outcomes_btts, cal_probs["btts_yes"], n_bins=10)

    print()
    print(f"  Post-cal metrics (calibration set — IN-SAMPLE, expect over-improvement):")
    print(f"    1X2 Brier: {brier_post:.4f}  (Δ {brier_post - brier_pre:+.4f})")
    print(f"    ECE P(H):  {ece_h_post:.4f}  (Δ {ece_h_post - ece_h_pre:+.4f})")
    print(f"    ECE P(D):  {ece_d_post:.4f}  (Δ {ece_d_post - ece_d_pre:+.4f})")
    print(f"    ECE P(A):  {ece_a_post:.4f}  (Δ {ece_a_post - ece_a_pre:+.4f})")
    print(f"    ECE P(O25):{ece_o_post:.4f}  (Δ {ece_o_post - ece_o_pre:+.4f})")
    print(f"    ECE P(BTTS):{ece_btts_post:.4f} (Δ {ece_btts_post - ece_btts_pre:+.4f})")

    # Save
    out_path = ARTIFACTS_DIR / f"m3_xg-isotonic-{tag}.pkl"
    calib.save(out_path)
    print(f"  Saved: {out_path.relative_to(REPO_ROOT)}")

    # Manifest
    manifest = {
        "tag": tag,
        "calibration_window": {
            "from": cal_start.strftime("%Y-%m-%d"),
            "to": cal_end.strftime("%Y-%m-%d"),
            "n_matches": int(len(cal_matches)),
        },
        "in_sample_metrics_pre_cal": {
            "brier_1x2": float(brier_pre),
            "ece_h": float(ece_h_pre), "ece_d": float(ece_d_pre), "ece_a": float(ece_a_pre),
            "ece_o25": float(ece_o_pre), "ece_btts": float(ece_btts_pre),
        },
        "in_sample_metrics_post_cal": {
            "brier_1x2": float(brier_post),
            "ece_h": float(ece_h_post), "ece_d": float(ece_d_post), "ece_a": float(ece_a_post),
            "ece_o25": float(ece_o_post), "ece_btts": float(ece_btts_post),
            "_warning": "in-sample. TRUE evaluation via stage_1_m3_xg.py --use-isotonic",
        },
        "fitted_at": datetime.now().isoformat(),
    }
    manifest_path = ARTIFACTS_DIR / f"m3_xg-isotonic-{tag}.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"  Manifest: {manifest_path.relative_to(REPO_ROOT)}")
    print()
    print("=" * 70)
    print("✓ Isotonic calibrator fit. Next: re-run Stage 1.m3 --use-isotonic")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

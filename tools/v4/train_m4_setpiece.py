"""
train_m4_setpiece.py — Train m4_set_pieces XGBoost on sofascore_shotmap.

Per V4-BACKTESTING-PROTOCOL §"m4_set_pieces":
  - Data: sofascore_shotmap filtered to situation IN
          ('corner','free-kick','set-piece','penalty')
  - Features: situation (one-hot), body_part (one-hot), shooter_x/y normalized,
              minute_bucket (one-hot) — 16 features after one-hot
  - Target: goal_outcome (derived from goal_type IS NOT NULL)
  - Architecture: XGBoost binary, max_depth=4, n_estimators=200, lr=0.05
  - Train/test split: chronological 75/25 within available date range

Pass criteria (Stage 1.m4):
  - Log-loss < league-avg-conversion baseline by ≥ 5% relative
  - ECE < 0.03 (binned by predicted-prob deciles)
  - Per-situation calibration within tolerance

Usage:
  tools/venv/bin/python3 -I tools/v4/train_m4_setpiece.py
  tools/venv/bin/python3 -I tools/v4/train_m4_setpiece.py --tag dev-01 --test-frac 0.25
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

from v4.data.loaders import load_shotmap
from v4.eval.metrics import brier_binary, ece, log_loss
from v4.modules.m4_set_pieces import (
    ALL_FEATURES,
    DEFAULT_XGB_PARAMS,
    SETPIECE_SITUATIONS,
    SetPiecePredictor,
    build_shot_features,
    extract_X,
)

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train m4_set_pieces XGBoost")
    p.add_argument("--tag", default=None,
                   help="Artifact tag (default: timestamp YYYYMMDD-HHMM)")
    p.add_argument("--test-frac", type=float, default=0.25,
                   help="Chronological tail used as held-out TEST set (default 0.25). "
                        "NEVER seen by training or early-stopping.")
    p.add_argument("--val-frac", type=float, default=0.15,
                   help="Chronological tail of REMAINING (after removing test) used as "
                        "validation set for early stopping. NOTE: this is a fraction "
                        "of the REMAINING data, not of the total. With defaults "
                        "(test=0.25, val=0.15), actual split is ≈64%% train / 11%% val "
                        "/ 25%% test (val = 0.15 × 0.75 = 11.25%% of total). "
                        "Pass val=0.20 to get true 60/15/25.")
    p.add_argument("--since", default=None,
                   help="Earliest match_date to include (default: all available)")
    p.add_argument("--cutoff", default=None,
                   help="Latest match_date to include (default: all available)")
    p.add_argument("--dry-run", action="store_true",
                   help="Build features but skip training + save (verify data flow only)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.tag or datetime.now().strftime("%Y%m%d-%H%M")

    print("=" * 70)
    print(f"V4 m4_set_pieces training run · tag={tag}")
    print("=" * 70)
    print(f"  test_frac:  {args.test_frac}")
    print(f"  since:      {args.since or 'all'}")
    print(f"  cutoff:     {args.cutoff or 'all'}")
    print(f"  dry_run:    {args.dry_run}")
    print()

    # ───── Load setpiece shots ─────
    t0 = time.time()
    shots = load_shotmap(
        situations=list(SETPIECE_SITUATIONS),
        since=args.since,
        cutoff=args.cutoff,
    )
    print(f"  Loaded {len(shots):,} setpiece shots in {time.time()-t0:.1f}s")
    print(f"  Date range: {shots['match_date'].min().date()} → {shots['match_date'].max().date()}")

    if len(shots) < 1000:
        print(f"  ✗ Insufficient data: {len(shots)} shots (need ≥ 1000)")
        return 1

    # ───── Per-situation distribution ─────
    print()
    print("  Per-situation distribution:")
    for sit in SETPIECE_SITUATIONS:
        sub = shots[shots["situation"] == sit]
        n = len(sub)
        g = int((sub["goal_outcome"] == 1).sum())
        rate = g / n if n else 0
        print(f"    {sit:<12}  n={n:>6,}  goals={g:>5,}  rate={rate:.4f}")

    # ───── Build features ─────
    t0 = time.time()
    features = build_shot_features(shots, include_target=True)
    print(f"  Built features: {features.shape} in {time.time()-t0:.1f}s")

    # ───── 3-way chronological split (NO leakage between val/test) ─────
    # By default (test_frac=0.25, val_frac=0.15):
    #   train: first 64% of total (chrono earliest)
    #   val:   next 11% (= val_frac × (1 - test_frac) of total)
    #   test:  last 25% (chrono latest, NEVER seen by training or ES)
    # val_frac is a fraction of REMAINING after test is removed. Use val=0.20
    # for the canonical 60/15/25 split.
    features_sorted = features.sort_values("match_date").reset_index(drop=True)
    n_total = len(features_sorted)
    n_test = int(args.test_frac * n_total)
    n_remaining = n_total - n_test
    n_val = int(args.val_frac * n_remaining)
    n_train = n_remaining - n_val

    train_features = features_sorted.iloc[:n_train].copy()
    val_features = features_sorted.iloc[n_train:n_train + n_val].copy()
    test_features = features_sorted.iloc[n_train + n_val:].copy()

    print()
    print(f"  3-way chronological split:")
    print(f"    Train: n={len(train_features):>6,}  "
          f"({train_features['match_date'].min().date()} → "
          f"{train_features['match_date'].max().date()})")
    print(f"    Val:   n={len(val_features):>6,}  "
          f"({val_features['match_date'].min().date()} → "
          f"{val_features['match_date'].max().date()})  "
          f"[for early stopping ONLY]")
    print(f"    Test:  n={len(test_features):>6,}  "
          f"({test_features['match_date'].min().date()} → "
          f"{test_features['match_date'].max().date()})  "
          f"[HELD OUT — evaluation only]")
    print()

    X_train = extract_X(train_features)
    y_train = train_features["goal_outcome"].values
    X_val = extract_X(val_features)
    y_val = val_features["goal_outcome"].values
    X_test = extract_X(test_features)
    y_test = test_features["goal_outcome"].values

    print(f"  Goal rates: train={y_train.mean():.4f}, val={y_val.mean():.4f}, "
          f"test={y_test.mean():.4f}")
    print()

    if args.dry_run:
        print("  --dry-run: skipping training + save")
        return 0

    # ───── Train (early stopping on val, NOT test) ─────
    t0 = time.time()
    print(f"  Training XGBoost (early-stopping on VAL set, test held-out)...")
    predictor = SetPiecePredictor()
    predictor.fit(X_train, y_train, eval_set=(X_val, y_val))
    print(f"    Done in {time.time()-t0:.1f}s")

    # ───── Evaluation on truly-held-out test ─────
    p_train = predictor.predict_proba(X_train)
    p_test = predictor.predict_proba(X_test)
    train_brier = brier_binary(y_train.astype(float), p_train)
    test_brier = brier_binary(y_test.astype(float), p_test)
    test_ll = log_loss(
        y_test, np.column_stack([1 - p_test, p_test])
    )

    # Baseline 1: constant prediction = train overall mean (trivial baseline)
    base_pred = np.full(len(y_test), y_train.mean())
    baseline_ll_overall = log_loss(
        y_test, np.column_stack([1 - base_pred, base_pred])
    )
    baseline_brier_overall = brier_binary(y_test.astype(float), base_pred)

    # Baseline 2: per-situation mean (strong baseline — captures situation structure)
    # For each test shot, predict the train-set mean of its situation
    situation_means = {}
    for sit in SETPIECE_SITUATIONS:
        col = f"situation_{sit}"
        mask = (train_features[col].values == 1)
        situation_means[sit] = float(train_features.loc[mask, "goal_outcome"].mean())
    # Map each test row to its situation's training mean
    sit_pred = np.zeros(len(y_test))
    for sit in SETPIECE_SITUATIONS:
        col = f"situation_{sit}"
        mask = (test_features[col].values == 1)
        sit_pred[mask] = situation_means[sit]
    baseline_ll_sit = log_loss(
        y_test, np.column_stack([1 - sit_pred, sit_pred])
    )
    baseline_brier_sit = brier_binary(y_test.astype(float), sit_pred)

    print()
    print(f"  Training (in-sample) Brier: {train_brier:.5f}")
    print(f"  Test (held-out) Brier:      {test_brier:.5f}")
    print()
    print(f"  Test LogLoss comparisons:")
    print(f"    m4 model:                 {test_ll:.5f}")
    print(f"    vs constant baseline:     {baseline_ll_overall:.5f}  "
          f"(model {(baseline_ll_overall - test_ll) / baseline_ll_overall * 100:+.2f}%)")
    print(f"    vs per-situation mean:    {baseline_ll_sit:.5f}  "
          f"(model {(baseline_ll_sit - test_ll) / baseline_ll_sit * 100:+.2f}%)")
    print()
    print(f"  Test Brier comparisons:")
    print(f"    m4 model:                 {test_brier:.5f}")
    print(f"    vs constant baseline:     {baseline_brier_overall:.5f}  "
          f"(model {(baseline_brier_overall - test_brier) / baseline_brier_overall * 100:+.2f}%)")
    print(f"    vs per-situation mean:    {baseline_brier_sit:.5f}  "
          f"(model {(baseline_brier_sit - test_brier) / baseline_brier_sit * 100:+.2f}%)")

    # Per-situation calibration
    print()
    print(f"  Per-situation calibration (predicted vs actual goal rate):")
    print(f"    {'situation':<12}  {'n':>5}  {'pred_avg':>8}  {'actual':>7}  {'|diff|':>7}")
    for sit in SETPIECE_SITUATIONS:
        # Find test_features rows where this situation is 1
        col = f"situation_{sit}"
        mask = (test_features[col].values == 1)
        n = int(mask.sum())
        if n < 10:
            continue
        pred_avg = float(p_test[mask].mean())
        actual_avg = float(y_test[mask].mean())
        print(f"    {sit:<12}  {n:>5}  {pred_avg:>8.4f}  {actual_avg:>7.4f}  "
              f"{abs(pred_avg - actual_avg):>7.4f}")

    # ECE
    e = ece(y_test.astype(float), p_test, n_bins=10, strategy="quantile")
    print(f"  ECE (10 quantile bins): {e:.4f}")

    # ───── Save artifact ─────
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    model_path = ARTIFACTS_DIR / f"m4_setpiece-{tag}.pkl"
    manifest_path = ARTIFACTS_DIR / f"m4_setpiece-{tag}.json"

    predictor.save(model_path)

    manifest = {
        "tag": tag,
        "trained_at": datetime.now().isoformat(),
        "training_window": {
            "from": str(train_features["match_date"].min().date()),
            "to": str(train_features["match_date"].max().date()),
            "n": int(len(train_features)),
        },
        "val_window": {
            "from": str(val_features["match_date"].min().date()),
            "to": str(val_features["match_date"].max().date()),
            "n": int(len(val_features)),
            "purpose": "early-stopping only",
        },
        "test_window": {
            "from": str(test_features["match_date"].min().date()),
            "to": str(test_features["match_date"].max().date()),
            "n": int(len(test_features)),
            "purpose": "evaluation only — NEVER seen by training or early-stopping",
        },
        "split_fracs": {
            "test": float(args.test_frac),
            "val": float(args.val_frac),
        },
        "n_features": len(ALL_FEATURES),
        "feature_names": ALL_FEATURES,
        "xgb_params": DEFAULT_XGB_PARAMS,
        "training_set_diagnostics": {
            "_warning": "in-sample only, NOT for gate evaluation",
            "train_brier": float(train_brier),
        },
        "test_metrics_held_out": {
            "brier": float(test_brier),
            "log_loss": float(test_ll),
            "ece": float(e),
            "baseline_constant": {
                "brier": float(baseline_brier_overall),
                "log_loss": float(baseline_ll_overall),
                "log_loss_improvement_pct": float(
                    (baseline_ll_overall - test_ll) / baseline_ll_overall * 100
                ),
                "brier_improvement_pct": float(
                    (baseline_brier_overall - test_brier) / baseline_brier_overall * 100
                ),
            },
            "baseline_per_situation_mean": {
                "brier": float(baseline_brier_sit),
                "log_loss": float(baseline_ll_sit),
                "log_loss_improvement_pct": float(
                    (baseline_ll_sit - test_ll) / baseline_ll_sit * 100
                ),
                "brier_improvement_pct": float(
                    (baseline_brier_sit - test_brier) / baseline_brier_sit * 100
                ),
                "_note": "stronger baseline — knows situation type, captures coarse structure",
            },
        },
        "situation_train_means": situation_means,
        "artifacts": {
            "model": str(model_path.relative_to(REPO_ROOT)),
        },
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print()
    print(f"  ✓ Artifacts saved:")
    print(f"    {model_path.relative_to(REPO_ROOT)}")
    print(f"    {manifest_path.relative_to(REPO_ROOT)}")
    print()
    print("=" * 70)
    print(f"✓ Training complete · tag={tag}")
    print(f"  Next: run pipeline/stage_1_m4_setpiece.py to validate gates")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

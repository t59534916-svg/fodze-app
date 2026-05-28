"""
Stage 1.m4_set_pieces — validate trained SetPiecePredictor against protocol gates.

Per V4-BACKTESTING-PROTOCOL §"m4_set_pieces":
  Pass criteria:
    1. Log-loss < league-avg-conversion baseline by ≥ 5% relative
    2. ECE < 0.03 (binned by predicted-prob deciles)
    3. Per-situation calibration:
         penalty:   ~0.78 actual vs predicted (±0.05)
         corner:    ~0.09 actual vs predicted (±0.02)
         set-piece: ~0.09 actual vs predicted (±0.02)
         free-kick: ~0.05 actual vs predicted (±0.02)

Tests (10 total):
  1.  Artifact loads + has correct feature schema
  2.  predict_proba returns finite values in [0, 1]
  3.  ECE on test set ≤ 0.03
  4.  Per-situation calibration: penalty Δ ≤ 0.05
  5.  Per-situation calibration: corner Δ ≤ 0.02
  6.  Per-situation calibration: set-piece Δ ≤ 0.02
  7.  Per-situation calibration: free-kick Δ ≤ 0.02
  8.  Test LogLoss ≤ constant baseline × 0.95 (≥ 5% improvement — weak baseline)
  9.  Test LogLoss ≤ per-situation baseline × 0.97 (≥ 3% — STRONG baseline)
  10. expected_goals_per_match aggregation works

Note on baselines:
  • Constant baseline = predict overall train mean for every shot (trivially beatable)
  • Per-situation baseline = predict situation-specific train mean (much stronger;
    captures the "penalties convert 78%, corners 9%, FKs 5%" structure for free)
  The per-situation baseline is the more meaningful comparison: it answers
  "does m4 add value beyond knowing which kind of setpiece it is?"

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m4_setpiece.py [--tag dev-01]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_shotmap
from v4.eval.metrics import brier_binary, ece, log_loss
from v4.modules.m4_set_pieces import (
    ALL_FEATURES,
    SETPIECE_SITUATIONS,
    SetPiecePredictor,
    build_shot_features,
    extract_X,
)

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"


# Protocol thresholds
ECE_THRESHOLD = 0.03
LOG_LOSS_IMPROVEMENT_VS_CONSTANT_MIN = 0.05    # 5% vs constant (weak gate)
LOG_LOSS_IMPROVEMENT_VS_PER_SITUATION_MIN = 0.03  # 3% vs per-situation (strong gate)
CAL_TOLERANCE = {
    "penalty": 0.05,
    "corner": 0.02,
    "set-piece": 0.02,
    "free-kick": 0.02,
}


class SanityCheckFailed(AssertionError):
    pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage 1 m4_set_pieces evaluation")
    p.add_argument("--tag", default="dev-01",
                   help="Artifact tag to load (default dev-01)")
    p.add_argument("--test-frac", type=float, default=0.25,
                   help="Holdout fraction by chronological order (default 0.25)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.tag

    print("=" * 70)
    print(f"V4 m4_set_pieces — Stage 1 Evaluation · tag={tag}")
    print("=" * 70)
    print(f"  ECE threshold:               ≤ {ECE_THRESHOLD}")
    print(f"  LogLoss improvement min:     ≥ {LOG_LOSS_IMPROVEMENT_VS_CONSTANT_MIN:.0%} vs constant baseline")
    print(f"                               ≥ {LOG_LOSS_IMPROVEMENT_VS_PER_SITUATION_MIN:.0%} vs per-situation baseline (STRONG)")
    print(f"  Per-situation cal tolerance: {CAL_TOLERANCE}")
    print()

    n_pass = 0
    n_fail = 0
    failures = []

    def _check(label: str, fn):
        nonlocal n_pass, n_fail
        try:
            note = fn()
            print(f"  ✓ {label:50} {note}")
            n_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:50} FAILED: {e}")
            failures.append((label, str(e)))
            n_fail += 1
        except Exception as e:
            print(f"  ✗ {label:50} CRASH: {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            n_fail += 1

    # ───── Test 1: Artifact loads ─────
    artifact_path = ARTIFACTS_DIR / f"m4_setpiece-{tag}.pkl"

    def test_1_load():
        if not artifact_path.exists():
            raise SanityCheckFailed(f"missing artifact: {artifact_path}")
        predictor = SetPiecePredictor.load(artifact_path)
        if not predictor.is_fitted:
            raise SanityCheckFailed("predictor not fitted")
        if set(predictor.feature_names) != set(ALL_FEATURES):
            extra = set(predictor.feature_names) - set(ALL_FEATURES)
            missing = set(ALL_FEATURES) - set(predictor.feature_names)
            raise SanityCheckFailed(
                f"feature schema mismatch — extra: {extra}, missing: {missing}"
            )
        test_1_load.predictor = predictor  # type: ignore
        return f"loaded, {len(predictor.feature_names)} features"

    _check("[1] Load artifact", test_1_load)

    if n_fail > 0:
        print()
        print("=" * 70)
        print("✗ Artifact failed to load — skipping evaluation")
        print(f"  Run: tools/venv/bin/python3 -I tools/v4/train_m4_setpiece.py --tag {tag}")
        print("=" * 70)
        return 1

    predictor: SetPiecePredictor = test_1_load.predictor  # type: ignore

    # ───── Load + split holdout ─────
    shots = load_shotmap(situations=list(SETPIECE_SITUATIONS))
    features = build_shot_features(shots, include_target=True)
    features_sorted = features.sort_values("match_date").reset_index(drop=True)
    n_total = len(features_sorted)
    n_test = int(args.test_frac * n_total)
    n_train = n_total - n_test
    test_features = features_sorted.iloc[n_train:].copy()
    X_test = extract_X(test_features)
    y_test = test_features["goal_outcome"].values

    print()
    print(f"  Test set: n={len(X_test):,} "
          f"({test_features['match_date'].min().date()} → "
          f"{test_features['match_date'].max().date()})")
    print()

    # ───── Test 2: predict_proba returns finite [0, 1] ─────
    def test_2_predict_proba():
        p = predictor.predict_proba(X_test)
        if p.shape != (len(X_test),):
            raise SanityCheckFailed(f"shape mismatch: {p.shape}")
        if not np.all(np.isfinite(p)):
            raise SanityCheckFailed("non-finite predictions")
        if np.any(p < 0) or np.any(p > 1):
            raise SanityCheckFailed(
                f"predictions outside [0,1]: min={p.min()}, max={p.max()}"
            )
        test_2_predict_proba.preds = p  # type: ignore
        return f"all in [{p.min():.4f}, {p.max():.4f}], mean={p.mean():.4f}"

    _check("[2] predict_proba finite + in [0,1]", test_2_predict_proba)
    preds = test_2_predict_proba.preds  # type: ignore

    # ───── Test 3: ECE ≤ 0.03 ─────
    def test_3_ece():
        e = ece(y_test.astype(float), preds, n_bins=10, strategy="quantile")
        if e > ECE_THRESHOLD:
            raise SanityCheckFailed(f"ECE {e:.4f} > {ECE_THRESHOLD}")
        return f"ECE {e:.4f} (target ≤ {ECE_THRESHOLD})"

    _check("[3] ECE ≤ 0.03 (10 quantile bins)", test_3_ece)

    # ───── Tests 4-7: Per-situation calibration ─────
    for sit, tol in CAL_TOLERANCE.items():
        col = f"situation_{sit}"

        def test_cal(sit_name=sit, tolerance=tol, col_name=col):
            mask = (test_features[col_name].values == 1)
            n = int(mask.sum())
            if n < 30:
                return f"n={n} (too small for cal, skipping)"
            pred_avg = float(preds[mask].mean())
            actual_avg = float(y_test[mask].mean())
            delta = abs(pred_avg - actual_avg)
            if delta > tolerance:
                raise SanityCheckFailed(
                    f"{sit_name} cal Δ={delta:.4f} > tolerance {tolerance} "
                    f"(pred={pred_avg:.4f}, actual={actual_avg:.4f})"
                )
            return f"n={n}, pred={pred_avg:.4f}, actual={actual_avg:.4f}, Δ={delta:.4f}"

        test_idx = list(CAL_TOLERANCE).index(sit) + 4
        _check(f"[{test_idx}] {sit} calibration (Δ ≤ {tol})", test_cal)

    # Recompute m4 model LogLoss + baselines once (shared by tests 8 + 9)
    y_pred_2col = np.column_stack([1 - preds, preds])
    ll_model_test = log_loss(y_test, y_pred_2col)
    train_features_sorted = features_sorted.iloc[:n_train]

    # Baseline 1: constant prediction = train overall mean
    base_rate = float(train_features_sorted["goal_outcome"].mean())
    const_pred = np.full(len(y_test), base_rate)
    ll_const = log_loss(y_test, np.column_stack([1 - const_pred, const_pred]))

    # Baseline 2: per-situation mean (much stronger — captures situation structure)
    situation_means = {}
    for sit in SETPIECE_SITUATIONS:
        col = f"situation_{sit}"
        mask = (train_features_sorted[col].values == 1)
        situation_means[sit] = float(train_features_sorted.loc[mask, "goal_outcome"].mean())
    sit_pred = np.zeros(len(y_test))
    for sit in SETPIECE_SITUATIONS:
        col = f"situation_{sit}"
        mask = (test_features[col].values == 1)
        sit_pred[mask] = situation_means[sit]
    ll_sit = log_loss(y_test, np.column_stack([1 - sit_pred, sit_pred]))

    # ───── Test 8: LogLoss vs CONSTANT baseline (weak gate) ─────
    def test_8_log_loss_vs_constant():
        improvement = (ll_const - ll_model_test) / ll_const
        if improvement < LOG_LOSS_IMPROVEMENT_VS_CONSTANT_MIN:
            raise SanityCheckFailed(
                f"LogLoss improvement vs constant {improvement:.2%} "
                f"< required {LOG_LOSS_IMPROVEMENT_VS_CONSTANT_MIN:.0%}"
            )
        return (
            f"LL model={ll_model_test:.4f} vs const={ll_const:.4f}, "
            f"improvement {improvement:+.2%}"
        )

    _check(
        f"[8] LogLoss vs constant ≥ {LOG_LOSS_IMPROVEMENT_VS_CONSTANT_MIN:.0%}",
        test_8_log_loss_vs_constant,
    )

    # ───── Test 9: LogLoss vs PER-SITUATION baseline (STRONG gate) ─────
    def test_9_log_loss_vs_per_situation():
        improvement = (ll_sit - ll_model_test) / ll_sit
        if improvement < LOG_LOSS_IMPROVEMENT_VS_PER_SITUATION_MIN:
            raise SanityCheckFailed(
                f"LogLoss improvement vs per-situation {improvement:.2%} "
                f"< required {LOG_LOSS_IMPROVEMENT_VS_PER_SITUATION_MIN:.0%}"
            )
        return (
            f"LL model={ll_model_test:.4f} vs per-sit={ll_sit:.4f}, "
            f"improvement {improvement:+.2%} ← HONEST signal"
        )

    _check(
        f"[9] LogLoss vs per-situation ≥ {LOG_LOSS_IMPROVEMENT_VS_PER_SITUATION_MIN:.0%}",
        test_9_log_loss_vs_per_situation,
    )

    # ───── Test 10: expected_goals_per_match aggregation ─────
    def test_9_aggregation():
        sample_shots = shots.iloc[:1000]
        sample_features = features.iloc[:1000]
        try:
            agg = predictor.expected_goals_per_match(sample_shots, sample_features)
        except Exception as e:
            raise SanityCheckFailed(f"aggregation failed: {e}")
        if not isinstance(agg, pd.Series):
            raise SanityCheckFailed(f"expected Series, got {type(agg).__name__}")
        if len(agg) == 0:
            raise SanityCheckFailed("aggregation returned empty")
        # All values should be positive (sum of probs ≥ 0)
        if (agg < 0).any():
            raise SanityCheckFailed("negative expected_goals values")
        if not np.all(np.isfinite(agg.values)):
            raise SanityCheckFailed("non-finite aggregation values")
        return f"aggregated {len(agg)} team-match keys, range [{agg.min():.3f}, {agg.max():.3f}]"

    _check("[10] expected_goals_per_match aggregation", test_9_aggregation)

    # ───── Summary ─────
    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{n_pass} TESTS PASSED")
        print(f"  → m4_set_pieces Stage 1 cleared.")
        print(f"  → Next: integrate expected_setpiece_goals as m3 feature (β3.2)")
    else:
        print(f"✗ {n_fail}/{n_pass + n_fail} TESTS FAILED")
        for label, err in failures:
            print(f"    {label}: {err}")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

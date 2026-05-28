"""Pytest unit tests for eval/metrics.py.

Mirrors the _self_test() in metrics.py but as discrete pytest cases so failures
report individually. Don't add untested code here — sync with metrics.py if its
self-test grows.
"""
from __future__ import annotations

import numpy as np
import pytest

from v4.eval.metrics import (
    bootstrap_ci,
    brier_binary,
    brier_multiclass,
    brier_skill_score,
    ece,
    log_loss,
    reliability_diagram,
    xg_bias,
    xg_forecast_report,
    xg_mae,
    xg_rmse,
)


def test_brier_perfect_prediction_is_zero():
    y_true = np.array([0, 1, 2, 0, 1])
    y_perfect = np.array(
        [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float
    )
    assert abs(brier_multiclass(y_true, y_perfect)) < 1e-9


def test_brier_skill_score_uniform_baseline_yields_zero():
    rng = np.random.default_rng(42)
    y = rng.integers(0, 3, size=1000)
    p_unif = np.full((1000, 3), 1 / 3)
    bss = brier_skill_score(y, p_unif)
    assert abs(bss) < 0.001


def test_log_loss_clips_zero_probs():
    y_bin = np.array([0, 1])
    p_extreme = np.array([[1.0, 0.0], [0.0, 1.0]])
    ll = log_loss(y_bin, p_extreme)
    assert np.isfinite(ll)


def test_ece_synthetic_perfectly_calibrated():
    rng = np.random.default_rng(42)
    n = 10000
    p_cal = rng.uniform(0, 1, n)
    y_cal = (rng.uniform(0, 1, n) < p_cal).astype(float)
    e = ece(y_cal, p_cal, n_bins=10, strategy="quantile")
    # ECE on truly-calibrated probs is bounded by within-bin sampling noise
    # (~sqrt(0.25 / bin_size) = 0.016 for n=1000/bin). 0.02 is generous tolerance.
    assert e < 0.02


def test_bootstrap_ci_contains_true_mean():
    rng = np.random.default_rng(42)
    samples = rng.normal(loc=0.6, scale=0.1, size=200)
    lo, med, hi = bootstrap_ci(samples, np.mean, n_resamples=500)
    assert lo < 0.6 < hi
    assert 0.55 < med < 0.65


def test_brier_rejects_nan():
    y_t = np.array([0, 1])
    y_p_nan = np.array([[0.5, 0.5], [np.nan, np.nan]])
    with pytest.raises(ValueError, match="non-finite"):
        brier_multiclass(y_t, y_p_nan)


def test_brier_rejects_unnormalized_rows():
    y_t = np.array([0, 1])
    y_p_unnorm = np.array([[0.5, 0.5], [0.3, 0.3]])
    with pytest.raises(ValueError, match="sum to"):
        brier_multiclass(y_t, y_p_unnorm)


def test_brier_rejects_out_of_range():
    y_t = np.array([0, 1])
    y_p_oor = np.array([[1.5, -0.5], [0.5, 0.5]])
    with pytest.raises(ValueError, match=r"outside \[0, 1\]"):
        brier_multiclass(y_t, y_p_oor)


def test_log_loss_rejects_nan():
    y_t = np.array([0, 1])
    y_p_nan = np.array([[0.5, 0.5], [np.nan, np.nan]])
    with pytest.raises(ValueError):
        log_loss(y_t, y_p_nan)


def test_brier_binary_rejects_nan():
    y_t = np.array([0.0, 1.0])
    y_p_nan = np.array([0.5, np.nan])
    with pytest.raises(ValueError):
        brier_binary(y_t, y_p_nan)


def test_reliability_diagram_returns_tuples():
    rng = np.random.default_rng(42)
    n = 1000
    p = rng.uniform(0, 1, n)
    y = (rng.uniform(0, 1, n) < p).astype(float)
    centers, observed, expected, counts = reliability_diagram(y, p, n_bins=10)
    assert centers.shape == observed.shape == expected.shape == counts.shape
    assert int(counts.sum()) == n


def test_reliability_diagram_rejects_nan():
    """Defensive consistency: reliability_diagram should validate like other metrics."""
    y_t = np.array([0.0, 1.0])
    y_p_nan = np.array([0.5, np.nan])
    with pytest.raises(ValueError, match="non-finite"):
        reliability_diagram(y_t, y_p_nan)


def test_reliability_diagram_rejects_out_of_range():
    y_t = np.array([0.0, 1.0])
    y_p_oor = np.array([0.5, 1.5])
    with pytest.raises(ValueError, match=r"outside \[0, 1\]"):
        reliability_diagram(y_t, y_p_oor)


def test_reliability_diagram_rejects_shape_mismatch():
    with pytest.raises(ValueError, match="shape mismatch"):
        reliability_diagram(np.array([0, 1, 0]), np.array([0.5, 0.5]))


def test_ece_rejects_nan_input():
    y_t = np.array([0.0, 1.0])
    y_p_nan = np.array([0.5, np.nan])
    with pytest.raises(ValueError):
        ece(y_t, y_p_nan)


# ─── xG-forecast regression metrics (λ vs realized xG) ──────────────

def test_xg_rmse_perfect_is_zero():
    lam = np.array([1.2, 0.8, 2.1, 1.5])
    assert xg_rmse(lam, lam.copy()) == 0.0
    assert xg_mae(lam, lam.copy()) == 0.0


def test_xg_rmse_known_value():
    pred = np.array([1.0, 2.0, 3.0])
    real = np.array([1.5, 1.5, 4.0])  # errors: -0.5, +0.5, -1.0
    # RMSE = sqrt((0.25 + 0.25 + 1.0)/3) = sqrt(0.5) ≈ 0.70711
    assert xg_rmse(pred, real) == pytest.approx(np.sqrt(0.5))
    # MAE = (0.5 + 0.5 + 1.0)/3 = 0.6667
    assert xg_mae(pred, real) == pytest.approx(2.0 / 3.0)


def test_xg_bias_sign_convention():
    # Over-estimate → positive bias.
    assert xg_bias(np.array([2.0, 2.0]), np.array([1.0, 1.0])) == pytest.approx(1.0)
    # Under-estimate → negative bias.
    assert xg_bias(np.array([1.0, 1.0]), np.array([2.0, 2.0])) == pytest.approx(-1.0)


def test_xg_forecast_report_fields_and_correlation():
    rng = np.random.default_rng(7)
    real = rng.uniform(0.3, 3.0, size=500)
    pred = real + rng.normal(0, 0.2, size=500) + 0.1  # noisy + slight over-estimate
    rep = xg_forecast_report(pred, real)
    assert set(rep) == {"n", "rmse", "mae", "bias", "mean_pred", "mean_realized", "pearson_r"}
    assert rep["n"] == 500
    assert rep["bias"] > 0  # we added +0.1
    assert rep["pearson_r"] > 0.9  # strong correlation by construction
    assert rep["rmse"] >= rep["mae"]  # RMSE ≥ MAE always


def test_xg_forecast_report_zero_variance_pred_gives_nan_r():
    # Degenerate: constant prediction → correlation undefined, not a crash.
    rep = xg_forecast_report(np.full(20, 1.4), np.linspace(0.5, 2.5, 20))
    assert np.isnan(rep["pearson_r"])
    assert np.isfinite(rep["rmse"])


def test_xg_metrics_reject_nan_and_shape_mismatch():
    with pytest.raises(ValueError):
        xg_rmse(np.array([1.0, np.nan]), np.array([1.0, 1.0]))
    with pytest.raises(ValueError, match="shape mismatch"):
        xg_rmse(np.array([1.0, 2.0, 3.0]), np.array([1.0, 2.0]))
    with pytest.raises(ValueError):
        xg_rmse(np.array([]), np.array([]))

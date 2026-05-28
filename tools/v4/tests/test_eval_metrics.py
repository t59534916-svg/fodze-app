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

"""
v4.eval.metrics — scoring metrics + bootstrap CIs for v4 backtest stages.

API surface:
  brier_multiclass(y_true, y_pred_proba) → float
      Multiclass Brier (sum-of-squared errors over classes, mean over samples).
      For 1X2: y_true ∈ {0=H, 1=D, 2=A}, y_pred_proba shape (n, 3).

  brier_binary(y_true, y_pred) → float
      Binary Brier = mean((p - y)²). For markets like O25, BTTS.

  log_loss(y_true, y_pred_proba, *, eps=1e-15) → float
      Cross-entropy / negative log-likelihood. Clipping at eps avoids log(0).

  ece(y_true_binary, y_pred_binary, *, n_bins=10, strategy='quantile') → float
      Expected Calibration Error. Strategy 'quantile' = equal-mass bins
      (per V4-BACKTESTING-PROTOCOL §"Stage 4 calibration plots").

  brier_skill_score(y_true, y_pred_proba, *, base_rates=None) → float
      BSS = 1 - Brier(model) / Brier(climatology).
      base_rates: per-class prior (None → computed from y_true).

  bootstrap_ci(values, statistic_fn, *, n_resamples=1000, ci=0.95, seed=42)
      → (lower, median, upper)
      Bootstrap percentile CI for any statistic computable on a 1D array.

  reliability_diagram(y_true_binary, y_pred_binary, *, n_bins=10) → (bin_centers, observed, expected, counts)
      Data tuples for reliability/calibration plot (matplotlib/plotly downstream).

All metrics are pure numpy/scipy — no sklearn dependency (keeps v4 deps minimal).
"""
from __future__ import annotations

from typing import Callable, Optional, Tuple

import numpy as np


# ═════════════════════════════════════════════════════════════════════
# Single source of truth for probability-input tolerance.
#
# DESIGN RATIONALE (locked 2026-05-12, value set 1e-6):
#
#   Why 1e-6 (not 1e-9)?  IEEE float epsilon depends on precision:
#     float64 (np default):      ε ≈ 2.22e-16   →  per-op drift trivial
#     float32 (xgboost binary):  ε ≈ 1.19e-7    →  per-op drift NOT trivial
#
#   XGBoost's binary:logistic predict_proba returns float32 by default.
#   When we construct y_pred_2col = [1-p, p] in float32, row-sum drifts
#   to within ~1e-7 of 1.0. A 1e-9 tolerance falsely rejects this — even
#   though the values are arithmetically correct given float32 precision.
#
#   1e-6 gives ~10× margin over float32 epsilon (still tight enough to
#   catch real bugs: any deviation of -0.01 or +1.01 is 10^4× this).
#   For float64 callers, the actual drift is ~1e-15, so 1e-6 is overly
#   generous — but that's fine; the contract is "your probability must
#   be within 1e-6 of valid," not "your float64 drift must be detectable."
#
#   Single source of truth across:
#     - eval/metrics.py  (brier_*, log_loss, ece, reliability_diagram)
#     - m6_market/benter.py (input validation)
#     - pipeline/stage_*  (prob-sum checks in Stage-1 evaluators)
#
#   DO NOT introduce a different default in any other module. If a caller
#   needs looser tolerance, pass an explicit `tol=` argument — never set
#   a NEW default. The single-source-of-truth invariant prevents the
#   "1e-9 in one file, 0.01 in another" landmine.
#
#   Lock test: tests/test_tolerance_consistency.py guards this value +
#   verifies all known validation sites import it (not redefine).
# ═════════════════════════════════════════════════════════════════════
PROBABILITY_TOLERANCE: float = 1e-6


# ═════════════════════════════════════════════════════════════════════
# Single source of truth for math-identity tolerance.
#
# DESIGN RATIONALE (locked 2026-05-12):
#   Distinct from PROBABILITY_TOLERANCE because IDENTITY checks have
#   different precision requirements:
#
#     PROBABILITY_TOLERANCE = 1e-6 — "is this a valid probability?"
#                                    Must absorb float32 IEEE drift.
#     IDENTITY_TOLERANCE    = 1e-9 — "should these two computations match?"
#                                    Float64-tight; float32 inputs shouldn't
#                                    hit this path.
#
#   Used by:
#     - Math-identity tests: AH(0) == 1X2 (m1_score sanity)
#     - No-future-leakage tests: poisoned-row δ must be exactly 0 modulo drift
#       (Stage 1.m2_lambda, Stage 1.m3_xg)
#     - Team-swap symmetry: attack_ratio invariant under home↔away swap
#
#   Why two constants, not one?
#     Loosening identity tests to 1e-6 would let real bugs slip through:
#     a leakage test where δ = 5e-7 wouldn't fire alarm — but 5e-7 is
#     5000× over IEEE drift for float64 computation, indicating real
#     contamination. We need to catch that.
# ═════════════════════════════════════════════════════════════════════
IDENTITY_TOLERANCE: float = 1e-9


# ─────────────────────────────────────────────────────────────────────
# Input validation helpers (used by all metrics)
# ─────────────────────────────────────────────────────────────────────


def _check_no_nan(arr: np.ndarray, name: str) -> None:
    """Raise ValueError if arr contains NaN/inf. Tweedie regression can emit
    these silently; metrics should fail loudly rather than return NaN."""
    if not np.all(np.isfinite(arr)):
        n_bad = int(np.sum(~np.isfinite(arr)))
        raise ValueError(
            f"{name} contains {n_bad} non-finite value(s) (NaN/inf). "
            "Upstream prediction layer likely degenerate — fix before scoring."
        )


def _check_proba_rows_sum_to_one(
    proba: np.ndarray,
    *,
    tol: float = PROBABILITY_TOLERANCE,
    name: str = "y_pred_proba",
) -> None:
    """Raise ValueError if rows of proba don't sum to ~1 within tol. Catches
    callers who pass un-normalized scores by mistake.

    Default tol = PROBABILITY_TOLERANCE (1e-9). Pass explicit tol= ONLY if
    you have a documented reason for looser tolerance.
    """
    if proba.ndim != 2:
        return  # only applicable to 2D multiclass arrays
    rowsums = proba.sum(axis=1)
    max_dev = float(np.max(np.abs(rowsums - 1.0)))
    if max_dev > tol:
        bad_idx = int(np.argmax(np.abs(rowsums - 1.0)))
        raise ValueError(
            f"{name} rows must sum to ~1.0 (tol={tol}). "
            f"Max row-deviation: {max_dev:.4e} at row {bad_idx} (sum={rowsums[bad_idx]:.6f}). "
            "Caller likely passed un-normalized scores instead of probabilities."
        )


def _check_proba_in_range(
    proba: np.ndarray,
    *,
    tol: float = PROBABILITY_TOLERANCE,
    name: str = "y_pred",
) -> None:
    """Probabilities must live in [0, 1]. Negative or >1 values indicate bugs.

    Default tol = PROBABILITY_TOLERANCE (1e-9). Same single-source-of-truth.
    """
    if proba.size == 0:
        return
    lo, hi = float(proba.min()), float(proba.max())
    if lo < -tol or hi > 1.0 + tol:
        raise ValueError(
            f"{name} contains values outside [0, 1] (tol={tol}): "
            f"min={lo:.6f}, max={hi:.6f}. "
            "Upstream layer produced invalid probabilities."
        )


# ─────────────────────────────────────────────────────────────────────
# Brier
# ─────────────────────────────────────────────────────────────────────


def brier_multiclass(y_true: np.ndarray, y_pred_proba: np.ndarray) -> float:
    """Multiclass Brier = mean_i sum_k (p_ik - δ(y_i, k))².

    Args:
        y_true: shape (n,) integer class labels ∈ {0, ..., K-1}
        y_pred_proba: shape (n, K) predicted probabilities, rows sum to ~1

    Returns: scalar Brier score (lower = better, 0 = perfect, 2*(K-1)/K = random)

    Raises:
        ValueError if y_pred_proba contains NaN, has rows not summing to ~1,
        contains values outside [0,1], or shape mismatches y_true.
    """
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred_proba, dtype=float)
    if y_pred.ndim != 2:
        raise ValueError(f"y_pred_proba must be 2D, got ndim={y_pred.ndim}")
    n, k = y_pred.shape
    if len(y_true) != n:
        raise ValueError(f"length mismatch: y_true={len(y_true)}, y_pred={n}")
    _check_no_nan(y_pred, "y_pred_proba")
    _check_proba_in_range(y_pred, name="y_pred_proba")
    _check_proba_rows_sum_to_one(y_pred, name="y_pred_proba")
    one_hot = np.zeros_like(y_pred)
    one_hot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((y_pred - one_hot) ** 2, axis=1)))


def brier_binary(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Binary Brier = mean((p - y)²) for y ∈ {0, 1}, p ∈ [0, 1].

    For markets like O25 (y=1 if total > 2.5, else 0) and BTTS.

    Raises:
        ValueError if y_pred contains NaN or values outside [0, 1].
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    if y_true.shape != y_pred.shape:
        raise ValueError(f"shape mismatch: y_true={y_true.shape}, y_pred={y_pred.shape}")
    _check_no_nan(y_pred, "y_pred")
    _check_proba_in_range(y_pred, name="y_pred")
    return float(np.mean((y_pred - y_true) ** 2))


def brier_skill_score(
    y_true: np.ndarray,
    y_pred_proba: np.ndarray,
    *,
    base_rates: Optional[np.ndarray] = None,
) -> float:
    """BSS = 1 - Brier(model) / Brier(climatology).

    Positive BSS = model beats climatology. ~0.05-0.08 is good for 1X2 football.
    """
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred_proba, dtype=float)
    n, k = y_pred.shape

    if base_rates is None:
        # Compute base rate from y_true
        base_rates = np.bincount(y_true, minlength=k).astype(float) / n

    base_pred = np.tile(base_rates, (n, 1))
    brier_model = brier_multiclass(y_true, y_pred)
    brier_base = brier_multiclass(y_true, base_pred)
    if brier_base <= 0:
        return float("nan")  # degenerate baseline
    return float(1.0 - brier_model / brier_base)


# ─────────────────────────────────────────────────────────────────────
# Log-loss / cross-entropy
# ─────────────────────────────────────────────────────────────────────


def log_loss(
    y_true: np.ndarray,
    y_pred_proba: np.ndarray,
    *,
    eps: float = 1e-15,
) -> float:
    """Negative log-likelihood. Clipping at eps avoids log(0).

    Raises:
        ValueError if y_pred_proba contains NaN, values outside [0, 1], or has
        rows that don't sum to ~1.
    """
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred_proba, dtype=float)
    _check_no_nan(y_pred, "y_pred_proba")
    _check_proba_in_range(y_pred, name="y_pred_proba")
    _check_proba_rows_sum_to_one(y_pred, name="y_pred_proba")
    y_pred = np.clip(y_pred, eps, 1.0 - eps)
    n = len(y_true)
    selected = y_pred[np.arange(n), y_true]
    return float(-np.mean(np.log(selected)))


# ─────────────────────────────────────────────────────────────────────
# ECE (Expected Calibration Error)
# ─────────────────────────────────────────────────────────────────────


def ece(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    *,
    n_bins: int = 10,
    strategy: str = "quantile",
) -> float:
    """Expected Calibration Error for binary predictions.

    Args:
        y_true: shape (n,) ∈ {0, 1}
        y_pred: shape (n,) ∈ [0, 1] — predicted P(y=1)
        n_bins: number of bins (default 10)
        strategy:
            "uniform" — equal-width bins on [0, 1]
            "quantile" — equal-mass bins (preferred for ECE accuracy, per protocol)

    Returns: weighted-mean absolute calibration gap (lower = better calibrated).
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    if y_true.shape != y_pred.shape:
        raise ValueError(f"shape mismatch: y_true={y_true.shape}, y_pred={y_pred.shape}")
    _check_no_nan(y_true, "y_true")
    _check_no_nan(y_pred, "y_pred")
    _check_proba_in_range(y_pred, name="y_pred")
    n = len(y_true)
    if n == 0:
        return 0.0

    if strategy == "uniform":
        bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    elif strategy == "quantile":
        bin_edges = np.quantile(y_pred, np.linspace(0, 1, n_bins + 1))
        bin_edges[0] = 0.0
        bin_edges[-1] = 1.0
        # Ensure strictly increasing (handle ties)
        bin_edges = np.unique(bin_edges)
    else:
        raise ValueError(f"strategy must be 'uniform' or 'quantile', got {strategy!r}")

    total_ece = 0.0
    for i in range(len(bin_edges) - 1):
        if i == len(bin_edges) - 2:
            # Include right edge for last bin
            in_bin = (y_pred >= bin_edges[i]) & (y_pred <= bin_edges[i + 1])
        else:
            in_bin = (y_pred >= bin_edges[i]) & (y_pred < bin_edges[i + 1])
        if not np.any(in_bin):
            continue
        bin_size = np.sum(in_bin)
        observed = np.mean(y_true[in_bin])
        expected = np.mean(y_pred[in_bin])
        total_ece += (bin_size / n) * abs(observed - expected)

    return float(total_ece)


def reliability_diagram(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    *,
    n_bins: int = 10,
    strategy: str = "quantile",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (bin_centers, observed_freq, expected_prob, bin_counts) for plotting.

    bin_centers: x-axis (mean predicted prob in each bin)
    observed_freq: y-axis (actual outcome rate in each bin)
    expected_prob: same as bin_centers (for the 45° reference line)
    bin_counts: sample size per bin (for stderr or marker-size)

    Raises:
        ValueError if y_true/y_pred have NaN, mismatched shapes, or y_pred ∉ [0, 1].
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    if y_true.shape != y_pred.shape:
        raise ValueError(f"shape mismatch: y_true={y_true.shape}, y_pred={y_pred.shape}")
    _check_no_nan(y_true, "y_true")
    _check_no_nan(y_pred, "y_pred")
    _check_proba_in_range(y_pred, name="y_pred")

    if strategy == "uniform":
        bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    elif strategy == "quantile":
        bin_edges = np.quantile(y_pred, np.linspace(0, 1, n_bins + 1))
        bin_edges[0] = 0.0
        bin_edges[-1] = 1.0
        bin_edges = np.unique(bin_edges)
    else:
        raise ValueError(f"strategy must be 'uniform' or 'quantile', got {strategy!r}")

    centers = []
    observed = []
    expected = []
    counts = []
    for i in range(len(bin_edges) - 1):
        if i == len(bin_edges) - 2:
            in_bin = (y_pred >= bin_edges[i]) & (y_pred <= bin_edges[i + 1])
        else:
            in_bin = (y_pred >= bin_edges[i]) & (y_pred < bin_edges[i + 1])
        if not np.any(in_bin):
            continue
        centers.append(float(np.mean(y_pred[in_bin])))
        observed.append(float(np.mean(y_true[in_bin])))
        expected.append(float(np.mean(y_pred[in_bin])))
        counts.append(int(np.sum(in_bin)))

    return np.array(centers), np.array(observed), np.array(expected), np.array(counts)


# ─────────────────────────────────────────────────────────────────────
# Bootstrap CI
# ─────────────────────────────────────────────────────────────────────


def bootstrap_ci(
    values: np.ndarray,
    statistic_fn: Callable[[np.ndarray], float] = np.mean,
    *,
    n_resamples: int = 1000,
    ci: float = 0.95,
    seed: int = 42,
) -> Tuple[float, float, float]:
    """Percentile bootstrap CI for any statistic on a 1D array.

    Args:
        values: 1D numpy array
        statistic_fn: function taking 1D array → scalar (default: mean)
        n_resamples: bootstrap iterations (default 1000, protocol-recommended)
        ci: confidence level (default 0.95 → 2.5%/97.5% percentiles)
        seed: numpy RNG seed for reproducibility

    Returns: (lower, median, upper)
    """
    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return (float("nan"), float("nan"), float("nan"))

    rng = np.random.default_rng(seed)
    n = len(values)
    stats = np.empty(n_resamples, dtype=float)
    for i in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        stats[i] = statistic_fn(values[idx])

    alpha = (1.0 - ci) / 2.0
    lower = float(np.percentile(stats, 100 * alpha))
    median = float(np.percentile(stats, 50))
    upper = float(np.percentile(stats, 100 * (1.0 - alpha)))
    return (lower, median, upper)


# ─────────────────────────────────────────────────────────────────────
# Self-test
# ─────────────────────────────────────────────────────────────────────


def _self_test() -> None:
    """Sanity-check: well-known identities should hold."""
    rng = np.random.default_rng(42)

    # Test 1: Perfect prediction → Brier = 0
    y_true = np.array([0, 1, 2, 0, 1])
    y_perfect = np.array([
        [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]
    ], dtype=float)
    assert abs(brier_multiclass(y_true, y_perfect)) < 1e-9, "Brier(perfect)=0"

    # Test 2: Random uniform pred → BSS = 0 (since base = uniform too)
    y = rng.integers(0, 3, size=1000)
    p_unif = np.full((1000, 3), 1/3)
    bss = brier_skill_score(y, p_unif)
    assert abs(bss) < 0.001, f"BSS(uniform vs uniform-baseline) should ~0, got {bss}"

    # Test 3: Log-loss handles edge cases (no log(0))
    y_bin = np.array([0, 1])
    p_extreme = np.array([[1.0, 0.0], [0.0, 1.0]])  # would log(0) without clipping
    ll = log_loss(y_bin, p_extreme)
    assert np.isfinite(ll), f"log_loss should clip, got {ll}"

    # Test 4: ECE on perfectly-calibrated probs = 0
    n = 10000
    p_cal = rng.uniform(0, 1, n)
    y_cal = (rng.uniform(0, 1, n) < p_cal).astype(float)  # generated from p_cal
    e = ece(y_cal, p_cal, n_bins=10, strategy="quantile")
    assert e < 0.02, f"ECE on perfectly-calibrated probs should ~0, got {e:.4f}"

    # Test 5: Bootstrap CI contains true mean with high prob
    samples = rng.normal(loc=0.6, scale=0.1, size=200)
    lo, med, hi = bootstrap_ci(samples, np.mean, n_resamples=500)
    assert lo < 0.6 < hi, f"CI [{lo:.3f}, {hi:.3f}] should contain 0.6"
    assert 0.55 < med < 0.65, f"median {med:.3f} should be near 0.6"

    # Test 6: Input validation — NaN must raise
    y_t = np.array([0, 1])
    y_p_nan = np.array([[0.5, 0.5], [np.nan, np.nan]])
    try:
        brier_multiclass(y_t, y_p_nan)
        raise AssertionError("brier_multiclass should reject NaN")
    except ValueError as exc:
        assert "non-finite" in str(exc)

    # Test 7: Input validation — un-normalized rows must raise
    y_p_unnorm = np.array([[0.5, 0.5], [0.3, 0.3]])  # row 2 sums to 0.6
    try:
        brier_multiclass(y_t, y_p_unnorm)
        raise AssertionError("brier_multiclass should reject un-normalized")
    except ValueError as exc:
        assert "sum to" in str(exc)

    # Test 8: Input validation — out-of-range probs must raise
    y_p_oor = np.array([[1.5, -0.5], [0.5, 0.5]])
    try:
        brier_multiclass(y_t, y_p_oor)
        raise AssertionError("brier_multiclass should reject p<0 or p>1")
    except ValueError as exc:
        assert "outside [0, 1]" in str(exc)

    # Test 9: log_loss applies same validation
    try:
        log_loss(y_t, y_p_nan)
        raise AssertionError("log_loss should reject NaN")
    except ValueError:
        pass

    print("✓ All 9 self-tests passed")
    print(f"  ECE on synthetic perfectly-calibrated probs: {e:.4f}")
    print(f"  Bootstrap CI on N(0.6, 0.1, n=200): [{lo:.3f}, {med:.3f}, {hi:.3f}]")


if __name__ == "__main__":
    _self_test()

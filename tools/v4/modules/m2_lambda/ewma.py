"""
m2_lambda.ewma — exponentially-weighted moving average helpers.

Pure-numpy implementation (no pandas dependency for the math kernel — pandas
DataFrames are an INPUT shape but the EWMA math itself is array-based).

EWMA weight at step k (counting from MOST RECENT = 0):
    w_k = (1/2) ** (k / halflife)

The most recent observation has weight 1.0; an observation `halflife` steps
back has weight 0.5; one `2 × halflife` steps back has weight 0.25, etc.

This matches the standard "ewma_recent_first" convention. Caller must pass
values in MOST-RECENT-FIRST order.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


def ewma_recent_first(
    values: np.ndarray,
    halflife: float,
    *,
    min_periods: int = 1,
) -> float:
    """Exponentially-weighted mean. `values[0]` is treated as the most recent obs.

    Args:
        values: 1D numpy array, ordered MOST-RECENT-FIRST (values[0] is newest).
                Empty array or all-NaN → returns NaN.
        halflife: positive scalar. Observation `halflife` steps back has weight 0.5.
        min_periods: if non-NaN count < min_periods → returns NaN.

    Returns:
        scalar EWMA, or NaN if insufficient data.

    Why "recent first"? Because callers typically have a slice like
    `history.sort_values(date, ascending=False).head(N)` — natural fit.
    Pandas' ewm() uses oldest-first which makes off-by-one bugs easy.
    """
    if halflife <= 0:
        raise ValueError(f"halflife must be positive, got {halflife}")
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        return float("nan")

    # Drop NaN values (some sources have missing xG)
    finite_mask = np.isfinite(arr)
    if finite_mask.sum() < min_periods:
        return float("nan")

    # Indices 0, 1, 2, ... (0 = most recent)
    # Compute weights only on finite indices to preserve "step k from most recent"
    # interpretation. Important: we don't COMPRESS the indices after dropping
    # NaN — a NaN at position k is just skipped, and the next finite value at
    # position k+1 still gets weight 0.5^((k+1)/halflife). This is the correct
    # behavior for "missing observation, not different gap-distance".
    n = arr.size
    indices = np.arange(n, dtype=float)
    weights = np.power(0.5, indices / halflife)

    # Apply mask
    weighted_sum = np.sum(arr[finite_mask] * weights[finite_mask])
    weight_total = np.sum(weights[finite_mask])
    if weight_total <= 0:
        return float("nan")
    return float(weighted_sum / weight_total)


def ewma_with_fallback(
    values: np.ndarray,
    halflife: float,
    *,
    fallback: float,
    min_periods: int = 4,
) -> float:
    """EWMA but with a deterministic fallback when sample is too small.

    Args:
        values: 1D array, most-recent-first.
        halflife: positive scalar.
        fallback: value returned if non-NaN count < min_periods.
        min_periods: threshold below which fallback is used (default 4).

    Returns:
        scalar EWMA or fallback. Never NaN as long as fallback is non-NaN.
    """
    result = ewma_recent_first(values, halflife, min_periods=min_periods)
    if np.isnan(result):
        return float(fallback)
    return result


def effective_sample_size(n: int, halflife: float) -> float:
    """Approximate effective sample size of the EWMA, given n observations.

    Useful for confidence/uncertainty quantification: a sequence of 30 obs
    with halflife=8 has effective sample size ≈ 11.5 — most of the signal
    comes from the recent 11 obs.

    Formula:  ESS = (Σ w_k)² / Σ w_k²
    """
    if n <= 0 or halflife <= 0:
        return 0.0
    indices = np.arange(n, dtype=float)
    weights = np.power(0.5, indices / halflife)
    return float(weights.sum() ** 2 / np.sum(weights ** 2))

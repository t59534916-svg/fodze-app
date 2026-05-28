"""
m6_market.shin — Pinnacle-style vig-removal.

Given decimal odds for a multinomial outcome (1X2, O/U, BTTS), the implied
probabilities `1/odds` sum to >1 due to bookmaker margin (vig). Vig-removal
recovers the underlying "fair" probabilities.

Two methods implemented:

  1. PROPORTIONAL (default) — fast, no assumptions:
       p_fair_i = (1/odds_i) / sum_j(1/odds_j)
     Removes vig by scaling all implied probs by a constant. The simplest
     method, works fine for most markets.

  2. SHIN (Hyun Song Shin, 1993) — accounts for insider-trader proportion z:
       p_market_i = z + (1-z) × p_fair_i × (some normalization)
     Returns slightly different (typically more accurate for sharp books)
     fair probabilities. Requires numerical optimization but quick (< 1ms/match).

Both methods preserve: sum(p_fair) = 1.0.

API:
  remove_vig_proportional(odds_arr) → fair_probs
  remove_vig_shin(odds_arr) → (fair_probs, z)
  remove_vig(odds_arr, method='shin') → fair_probs  (convenience dispatcher)
"""
from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy.optimize import brentq


def remove_vig_proportional(odds: np.ndarray) -> np.ndarray:
    """Scale implied probabilities so they sum to 1.

    Args:
        odds: 1D array of decimal odds (positive, > 1.0 typically).

    Returns:
        1D array of fair probabilities, summing to 1.0.

    Raises:
        ValueError if any odd is non-positive or array is degenerate.
    """
    odds = np.asarray(odds, dtype=float)
    if np.any(odds <= 0):
        raise ValueError(f"all odds must be positive, got min={odds.min()}")
    implied = 1.0 / odds
    s = implied.sum()
    if s <= 0:
        raise ValueError(f"implied probability sum is non-positive: {s}")
    return implied / s


def remove_vig_shin(
    odds: np.ndarray,
    *,
    z_max: float = 0.30,
) -> Tuple[np.ndarray, float]:
    """Shin (1993) vig-removal with insider-trader proportion z.

    Shin model: each market probability p_i is a mixture of (z) from insiders
    + (1-z) from uninformed bettors. Solving inverts to give fair probs.

    Algorithm:
      Given implied probs π_i = 1/odds_i (un-normalized, sum > 1):
      Solve for z ∈ (0, z_max) such that sum_i p_fair_i = 1 when:
        p_fair_i = (sqrt(z² + 4(1-z)π_i²/π_sum) - z) / (2(1-z))
      We solve numerically via Brent's method (no initial guess needed —
      Brent uses brackets, not seeds).

    Args:
        odds: 1D array of decimal odds, length ≥ 2.
        z_max: upper bound for z search (default 0.30, conservative).

    Returns: (fair_probs, z_estimate)
    """
    odds = np.asarray(odds, dtype=float)
    if len(odds) < 2:
        raise ValueError(f"need ≥ 2 outcomes for Shin, got {len(odds)}")
    if np.any(odds <= 0):
        raise ValueError(f"all odds must be positive, got min={odds.min()}")

    pi = 1.0 / odds            # implied probs (un-normalized)
    pi_sum = pi.sum()           # > 1 typical (vig)

    if pi_sum <= 1.0:
        # No vig — return proportional and z=0
        return pi / pi_sum, 0.0

    # Closed-form Shin for K outcomes:
    # For each outcome: p_fair_i = ( sqrt(z² + 4(1-z) × pi_i² / pi_sum ) - z ) / (2(1-z))
    # Constraint: sum_i p_fair_i = 1 → solve for z

    def total_fair_minus_1(z: float) -> float:
        if z >= 1.0 - 1e-9 or z <= 0:
            return float("inf")
        # Vectorized: p_i for all outcomes
        denom = 2.0 * (1.0 - z)
        inner = z * z + 4.0 * (1.0 - z) * pi * pi / pi_sum
        if np.any(inner < 0):
            return float("inf")
        p_fair = (np.sqrt(inner) - z) / denom
        return p_fair.sum() - 1.0

    # Search for z in (eps, z_max). At z→0, fair sum > 1 (residual vig); at z high
    # enough, sum < 1. Brent finds the root.
    try:
        # Check signs at endpoints
        f_low = total_fair_minus_1(1e-6)
        f_high = total_fair_minus_1(z_max)
        if f_low * f_high > 0:
            # Both same sign → no sign change in range, fall back to proportional
            return pi / pi_sum, 0.0
        z_hat = brentq(total_fair_minus_1, 1e-6, z_max, xtol=1e-8)
    except Exception:
        # Numerical failure → fall back
        return pi / pi_sum, 0.0

    # Compute final fair probs at z_hat
    denom = 2.0 * (1.0 - z_hat)
    inner = z_hat * z_hat + 4.0 * (1.0 - z_hat) * pi * pi / pi_sum
    p_fair = (np.sqrt(inner) - z_hat) / denom
    # Normalize (should already sum to ~1, but defensive)
    p_fair = p_fair / p_fair.sum()
    return p_fair, float(z_hat)


def remove_vig(odds: np.ndarray, *, method: str = "shin") -> np.ndarray:
    """Convenience dispatcher: proportional or Shin.

    Args:
        odds: decimal odds array.
        method: 'proportional' or 'shin' (default 'shin').

    Returns: fair probabilities (sum to 1.0).
    """
    if method == "proportional":
        return remove_vig_proportional(odds)
    if method == "shin":
        fair, _ = remove_vig_shin(odds)
        return fair
    raise ValueError(f"unknown method: {method!r}")

"""
m1_score.coarse_graining — aggregate score-grid into market probabilities.

A score matrix M is np.ndarray of shape (max_h+1, max_a+1) where
M[h, a] = P(home scores h, away scores a). Coarse-graining maps M to
market-level probability dicts:

  get_1x2(M)        → {"H": p, "D": p, "A": p}
  get_ou(M, k)      → {"over": p, "under": p}    (default k=2.5)
  get_btts(M)       → {"yes": p, "no": p}
  get_asian_handicap(M, h) → {"home": p, "push": p, "away": p}
  get_correct_score(M, h, a) → P(scoreline)

All coarse-graining functions are vectorized over the matrix (no Python loops).

# ─────────────────────────────────────────────────────────────────────
# Module-local algorithm constants (NOT general-purpose tolerances).
# These are domain-specific classification thresholds — kept local so future
# changes don't accidentally drag in unrelated probability-validation logic.
# Different from eval.metrics.PROBABILITY_TOLERANCE (which is for input
# validation across the whole pipeline).
# ─────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

from typing import Dict

import numpy as np

from v4.eval.metrics import PROBABILITY_TOLERANCE

# Algorithm-internal classification thresholds (named — not tolerances).
# Below MIN_PUSH_MASS, an O/U integer-threshold push is considered "no push"
# (float-drift level mass in the integer cell).
MIN_PUSH_MASS: float = 1e-9

# A handicap is valid if it's a multiple of 0.25 (i.e. handicap × 4 is integer).
# Allow tiny float drift in the user-supplied handicap value.
HANDICAP_QUARTER_EPSILON: float = 1e-9

# AH outcome margin classification: |margin| < AH_MARGIN_EPSILON → push,
# margin > AH_MARGIN_EPSILON → home, margin < -AH_MARGIN_EPSILON → away.
AH_MARGIN_EPSILON: float = 1e-9


def _validate_matrix(matrix: np.ndarray) -> None:
    if not isinstance(matrix, np.ndarray):
        raise TypeError(f"matrix must be np.ndarray, got {type(matrix).__name__}")
    if matrix.ndim != 2:
        raise ValueError(f"matrix must be 2D, got ndim={matrix.ndim}")
    if matrix.shape[0] < 1 or matrix.shape[1] < 1:
        raise ValueError(f"matrix dimensions must be ≥ 1, got shape={matrix.shape}")
    # DC matrix entries must be non-negative — this is the OUTPUT-validity guard
    # (probability matrix can't have negative cells). Uses PROBABILITY_TOLERANCE
    # because semantically "is this thing a valid probability?" — same as input
    # validation in eval.metrics. Real ρ-OOB produces entries ~-0.05, well
    # over any reasonable tolerance.
    if np.any(matrix < -PROBABILITY_TOLERANCE):
        raise ValueError(
            f"matrix has negative entries (min={matrix.min():.6f}, "
            f"tol={PROBABILITY_TOLERANCE}). "
            "Likely Dixon-Coles ρ out-of-bounds or numerical error."
        )


def get_1x2(matrix: np.ndarray) -> Dict[str, float]:
    """1X2 (Home win / Draw / Away win) probabilities from score-grid.

    Vectorized: builds a 3-state mask from index arithmetic.
        h > a → Home win
        h == a → Draw
        h < a → Away win
    """
    _validate_matrix(matrix)
    n_h, n_a = matrix.shape
    h_idx, a_idx = np.indices((n_h, n_a))
    p_h = float(matrix[h_idx > a_idx].sum())
    p_d = float(matrix[h_idx == a_idx].sum())
    p_a = float(matrix[h_idx < a_idx].sum())
    return {"H": p_h, "D": p_d, "A": p_a}


def get_ou(matrix: np.ndarray, threshold: float = 2.5) -> Dict[str, float]:
    """Over/Under N.5 goals. Threshold defaults to 2.5.

    Note: for integer thresholds (2.0, 3.0), 'push' probability is non-zero
    (= P(total == threshold)). This function ignores pushes and returns only
    over/under — for AH-style markets with pushes, use a different function.
    """
    _validate_matrix(matrix)
    n_h, n_a = matrix.shape
    h_idx, a_idx = np.indices((n_h, n_a))
    total = h_idx + a_idx
    over = float(matrix[total > threshold].sum())
    under = float(matrix[total < threshold].sum())
    # Push (total == threshold) only nonzero for integer thresholds
    push = float(matrix[total == threshold].sum())
    if push > MIN_PUSH_MASS:
        # Push split: redistribute push to neither (or warn)
        # Convention: O/U on integer threshold returns push-mass under "_push" key
        return {"over": over, "under": under, "_push": push}
    return {"over": over, "under": under}


def get_btts(matrix: np.ndarray) -> Dict[str, float]:
    """Both Teams To Score (yes/no) probability.

    BTTS-no = P(home == 0) + P(away == 0) - P(home==0 AND away==0)
            = inclusion-exclusion of "at least one team failed to score"
    """
    _validate_matrix(matrix)
    p_h_zero = float(matrix[0, :].sum())
    p_a_zero = float(matrix[:, 0].sum())
    p_both_zero = float(matrix[0, 0])
    btts_no = p_h_zero + p_a_zero - p_both_zero
    return {"yes": float(1.0 - btts_no), "no": float(btts_no)}


def get_asian_handicap(matrix: np.ndarray, handicap: float) -> Dict[str, float]:
    """Asian Handicap probabilities from home perspective.

    handicap = +1.0  → home gets 1-goal head start (settle on h - a + 1)
    handicap =  0.0  → straight 1X2-equivalent (with push on draw)
    handicap = -0.5  → home must win outright
    handicap = -0.25 → split-handicap (handle separately — not yet supported)

    Returns: {"home": p, "push": p, "away": p}
        home: P(home margin + handicap > 0)
        push: P(home margin + handicap == 0)  — only nonzero for integer/half-integer
        away: P(home margin + handicap < 0)
    """
    _validate_matrix(matrix)
    if abs(handicap * 4 - round(handicap * 4)) > HANDICAP_QUARTER_EPSILON:
        raise ValueError(
            f"split-handicap (e.g. -0.25, +0.75) not supported in this function, "
            f"got {handicap}. Use get_asian_handicap_split() instead."
        )
    n_h, n_a = matrix.shape
    h_idx, a_idx = np.indices((n_h, n_a))
    margin = (h_idx - a_idx).astype(float) + handicap
    p_home = float(matrix[margin > AH_MARGIN_EPSILON].sum())
    p_away = float(matrix[margin < -AH_MARGIN_EPSILON].sum())
    p_push = float(matrix[np.abs(margin) <= AH_MARGIN_EPSILON].sum())
    return {"home": p_home, "push": p_push, "away": p_away}


def get_correct_score(matrix: np.ndarray, h: int, a: int) -> float:
    """P(exact scoreline h-a).

    Raises IndexError if (h, a) outside matrix dimensions.
    """
    _validate_matrix(matrix)
    return float(matrix[h, a])


def get_top_n_scorelines(matrix: np.ndarray, n: int = 5) -> list:
    """Return top-n most likely scorelines as [(h, a, prob), ...] sorted desc.

    Useful for: correct-score market display, sanity checking model output.
    """
    _validate_matrix(matrix)
    flat = matrix.flatten()
    top_idx = np.argsort(flat)[::-1][:n]
    n_a = matrix.shape[1]
    return [
        (int(idx // n_a), int(idx % n_a), float(flat[idx]))
        for idx in top_idx
    ]

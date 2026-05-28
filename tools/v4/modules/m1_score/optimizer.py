"""
m1_score.optimizer — Dixon-Coles ρ MLE.

Given a historical corpus of matches with per-match (λ_H, λ_A) already
estimated (from Modul 2 / Modul 3 LightGBM) and observed (goals_H, goals_A),
fit the global ρ parameter via Maximum Likelihood:

    argmin_ρ  Σ_i  -log P_DC(g_H^i, g_A^i | λ_H^i, λ_A^i, ρ)

Uses scipy.optimize.minimize with L-BFGS-B + hard bounds on ρ to keep
all τ-corrections positive (else NLL → ∞).
"""
from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy.optimize import OptimizeResult, minimize
from scipy.stats import poisson


def dixon_coles_nll(
    rho: float,
    lambdas_h: np.ndarray,
    lambdas_a: np.ndarray,
    goals_h: np.ndarray,
    goals_a: np.ndarray,
) -> float:
    """Negative log-likelihood of DC model over a match corpus.

    Returns +inf if any τ-correction goes ≤ 0 (= invalid ρ for some match's λ).
    This keeps the optimizer from wandering into invalid territory.
    """
    # If rho is array (from minimize), unwrap
    if hasattr(rho, "__len__"):
        rho = float(rho[0])
    else:
        rho = float(rho)

    # Base Poisson log-pmf per team (independent assumption pre-τ)
    log_p_h = poisson.logpmf(goals_h, lambdas_h)
    log_p_a = poisson.logpmf(goals_a, lambdas_a)
    log_p_base = log_p_h + log_p_a

    # τ-correction per match (only nontrivial for cells (0,0), (0,1), (1,0), (1,1))
    tau = np.ones_like(goals_h, dtype=float)
    mask_00 = (goals_h == 0) & (goals_a == 0)
    mask_01 = (goals_h == 0) & (goals_a == 1)
    mask_10 = (goals_h == 1) & (goals_a == 0)
    mask_11 = (goals_h == 1) & (goals_a == 1)

    tau[mask_00] = 1.0 - lambdas_h[mask_00] * lambdas_a[mask_00] * rho
    tau[mask_01] = 1.0 + lambdas_h[mask_01] * rho
    tau[mask_10] = 1.0 + lambdas_a[mask_10] * rho
    tau[mask_11] = 1.0 - rho

    # If ANY τ ≤ 0 → push optimizer away
    if np.any(tau <= 0):
        return float("inf")

    log_tau = np.log(tau)
    return -float(np.sum(log_p_base + log_tau))


def fit_dixon_coles_rho(
    lambdas_h: np.ndarray,
    lambdas_a: np.ndarray,
    goals_h: np.ndarray,
    goals_a: np.ndarray,
    rho_bounds: Tuple[float, float] = (-0.20, 0.13),
    initial_rho: float = -0.05,
) -> OptimizeResult:
    """Fit ρ via MLE on a match corpus.

    Default rho_bounds = (-0.20, 0.13) per Dixon-Coles (1997) empirical range.
    These are TIGHTER than the strict mathematical bounds (which depend on
    per-match λ values) — sufficient for typical football λ ∈ [0.5, 3.5].

    For a corpus that includes extreme matchups (e.g. λ_H × λ_A > 7), one
    could pass tighter bounds: rho_bounds = (-0.10, 0.10).

    Args:
        lambdas_h, lambdas_a: per-match expected goals (estimated upstream)
        goals_h, goals_a: per-match observed goals
        rho_bounds: (lower, upper) hard bounds for L-BFGS-B
        initial_rho: starting point (negative for typical football corr)

    Returns: scipy OptimizeResult. .x[0] is fitted ρ, .fun is NLL.
    """
    lambdas_h = np.asarray(lambdas_h, dtype=float)
    lambdas_a = np.asarray(lambdas_a, dtype=float)
    goals_h = np.asarray(goals_h, dtype=int)
    goals_a = np.asarray(goals_a, dtype=int)

    if len(lambdas_h) != len(lambdas_a) or len(lambdas_h) != len(goals_h):
        raise ValueError("input arrays must have same length")
    if len(lambdas_h) == 0:
        raise ValueError("empty corpus — nothing to fit")

    result = minimize(
        dixon_coles_nll,
        x0=np.array([initial_rho]),
        args=(lambdas_h, lambdas_a, goals_h, goals_a),
        method="L-BFGS-B",
        bounds=[rho_bounds],
    )
    return result

"""
m1_score.distributions — score-generative probability models.

Three building blocks for the score-grid output P(N_H=h, N_A=a):

  PoissonGoalModel   — independent bivariate Poisson, fast baseline
  DixonColesModel    — Dixon-Coles correction τ for low-score cells
                       (captures correlation at 0:0, 0:1, 1:0, 1:1)
  NegBinGoalModel    — Negative-Binomial fallback for overdispersed leagues
                       (Var > Mean violation of Poisson assumption)

All models return a 2D numpy matrix M[h, a] of shape (max_goals+1, max_goals+1).
Coarse-graining (1X2, O/U, BTTS, AH) lives in coarse_graining.py.

References:
  Dixon & Coles (1997). "Modelling Association Football Scores and
  Inefficiencies in the Football Betting Market." Applied Statistics.
"""
from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy.stats import nbinom, poisson


class PoissonGoalModel:
    """Independent bivariate Poisson score model.

    Assumes home and away goal counts are independent given (λ_H, λ_A).
    Empirically: underestimates draws + 1-1 results (low-score correlation).
    Use as baseline OR when you want a fast, debuggable reference.
    """

    def __init__(self, lambda_h: float, lambda_a: float, max_goals: int = 9):
        if lambda_h <= 0 or lambda_a <= 0:
            raise ValueError(
                f"lambdas must be positive: got h={lambda_h}, a={lambda_a}"
            )
        if max_goals < 1:
            raise ValueError(f"max_goals must be ≥ 1, got {max_goals}")
        self.lambda_h = float(lambda_h)
        self.lambda_a = float(lambda_a)
        self.max_goals = int(max_goals)

    def matrix(self, normalize: bool = False) -> np.ndarray:
        """Return P[h, a] of shape (max_goals+1, max_goals+1).

        Args:
            normalize: if True, rescale so matrix sums to exactly 1.0.
                Default False (preserves the tail-mass-loss as a diagnostic).
        """
        idx = np.arange(self.max_goals + 1)
        h_probs = poisson.pmf(idx, self.lambda_h)
        a_probs = poisson.pmf(idx, self.lambda_a)
        M = np.outer(h_probs, a_probs)
        if normalize:
            M = M / M.sum()
        return M

    def __repr__(self) -> str:
        return (
            f"PoissonGoalModel(λ_h={self.lambda_h:.3f}, "
            f"λ_a={self.lambda_a:.3f}, max_goals={self.max_goals})"
        )


class DixonColesModel(PoissonGoalModel):
    """Dixon-Coles bivariate Poisson with low-score correction.

    Applies τ-correction to cells (0,0), (0,1), (1,0), (1,1):
        τ(0, 0) = 1 - λ_H × λ_A × ρ      (ρ < 0 → boosts 0:0)
        τ(0, 1) = 1 + λ_H × ρ            (ρ < 0 → reduces 0:1)
        τ(1, 0) = 1 + λ_A × ρ            (ρ < 0 → reduces 1:0)
        τ(1, 1) = 1 - ρ                  (ρ < 0 → boosts 1:1)
        τ(h, a) = 1 otherwise

    ρ must satisfy all τ > 0 (else negative probabilities). Bounds:
        ρ > max(-1/λ_H, -1/λ_A)   (from τ(0,1), τ(1,0) > 0)
        ρ < min(1, 1/(λ_H × λ_A))  (from τ(1,1), τ(0,0) > 0)

    Empirical ρ for football typically in [-0.20, 0.13] (Dixon-Coles 1997).
    FODZE v2 production uses ρ ≈ -0.094 (Optuna-tuned).
    """

    def __init__(
        self,
        lambda_h: float,
        lambda_a: float,
        rho: float,
        max_goals: int = 9,
    ):
        super().__init__(lambda_h, lambda_a, max_goals)
        rho_min, rho_max = self.rho_bounds_for(lambda_h, lambda_a)
        if not (rho_min < rho < rho_max):
            raise ValueError(
                f"ρ={rho} outside valid range ({rho_min:.4f}, {rho_max:.4f}) "
                f"for λ_H={lambda_h}, λ_A={lambda_a}. "
                f"τ would be ≤ 0 (negative probability)."
            )
        self.rho = float(rho)

    @staticmethod
    def rho_bounds_for(lambda_h: float, lambda_a: float) -> Tuple[float, float]:
        """Return strict (rho_min, rho_max) bounds for the given λ pair."""
        rho_min = max(-1.0 / lambda_h, -1.0 / lambda_a)
        rho_max = min(1.0, 1.0 / (lambda_h * lambda_a))
        return rho_min, rho_max

    def tau(self, h: int, a: int) -> float:
        """Dixon-Coles correction factor for cell (h, a)."""
        if h == 0 and a == 0:
            return 1.0 - self.lambda_h * self.lambda_a * self.rho
        if h == 0 and a == 1:
            return 1.0 + self.lambda_h * self.rho
        if h == 1 and a == 0:
            return 1.0 + self.lambda_a * self.rho
        if h == 1 and a == 1:
            return 1.0 - self.rho
        return 1.0

    def matrix(self, normalize: bool = True) -> np.ndarray:
        """Return τ-corrected matrix.

        Args:
            normalize: default True (DC matrix is re-normalized because
                τ shifts probability mass between cells). Set False to
                inspect raw τ-correction effect (for debugging only).
        """
        M = super().matrix(normalize=False)
        # τ-correction (in place is fine — we own this copy)
        M[0, 0] *= 1.0 - self.lambda_h * self.lambda_a * self.rho
        M[0, 1] *= 1.0 + self.lambda_h * self.rho
        M[1, 0] *= 1.0 + self.lambda_a * self.rho
        M[1, 1] *= 1.0 - self.rho
        if normalize:
            M = M / M.sum()
        return M

    def __repr__(self) -> str:
        return (
            f"DixonColesModel(λ_h={self.lambda_h:.3f}, "
            f"λ_a={self.lambda_a:.3f}, ρ={self.rho:+.4f}, "
            f"max_goals={self.max_goals})"
        )


class NegBinGoalModel:
    """Negative-Binomial bivariate goal model — overdispersion fallback.

    For each team: goals ~ NegBin(μ, k) where:
        E[goals]   = μ
        Var[goals] = μ + μ²/k

    As k → ∞, NegBin → Poisson. Use NegBin when empirical Var(goals) > μ:
        k = μ² / (Var - μ)

    Empirically: small leagues (Tier-C, low-sample) often show modest
    overdispersion due to score-line variability. Per-Liga k can be fitted
    via method-of-moments or MLE.

    Note: this is an INDEPENDENT bivariate model (no DC-style correlation).
    For Liga-specific correlation, layer DC correction on top via separate
    DixonColesNegBinModel class (TODO when needed).
    """

    def __init__(
        self,
        mu_h: float,
        mu_a: float,
        k_h: float,
        k_a: float,
        max_goals: int = 9,
    ):
        if min(mu_h, mu_a) <= 0:
            raise ValueError(f"μ must be positive: got h={mu_h}, a={mu_a}")
        if min(k_h, k_a) <= 0:
            raise ValueError(f"k (dispersion) must be positive: got h={k_h}, a={k_a}")
        if max_goals < 1:
            raise ValueError(f"max_goals must be ≥ 1, got {max_goals}")
        self.mu_h = float(mu_h)
        self.mu_a = float(mu_a)
        self.k_h = float(k_h)
        self.k_a = float(k_a)
        self.max_goals = int(max_goals)

    @classmethod
    def from_mean_var(
        cls,
        mu_h: float,
        var_h: float,
        mu_a: float,
        var_a: float,
        max_goals: int = 9,
    ) -> "NegBinGoalModel":
        """Construct from method-of-moments (mean, variance) per team.

        Raises if var ≤ mu (would imply Poisson or underdispersion — use
        PoissonGoalModel instead).
        """
        if var_h <= mu_h or var_a <= mu_a:
            raise ValueError(
                f"variance must exceed mean for NegBin (else use Poisson): "
                f"μ_h={mu_h}, var_h={var_h}, μ_a={mu_a}, var_a={var_a}"
            )
        k_h = mu_h * mu_h / (var_h - mu_h)
        k_a = mu_a * mu_a / (var_a - mu_a)
        return cls(mu_h, mu_a, k_h, k_a, max_goals)

    def matrix(self, normalize: bool = False) -> np.ndarray:
        """Return NegBin score matrix.

        Parameterization: scipy.stats.nbinom uses (n, p) where:
            E[X] = n × (1-p) / p
            Var[X] = n × (1-p) / p²
        Given (μ, k):
            p = k / (k + μ)
            n = k
        """
        idx = np.arange(self.max_goals + 1)
        p_h = self.k_h / (self.k_h + self.mu_h)
        p_a = self.k_a / (self.k_a + self.mu_a)
        h_probs = nbinom.pmf(idx, self.k_h, p_h)
        a_probs = nbinom.pmf(idx, self.k_a, p_a)
        M = np.outer(h_probs, a_probs)
        if normalize:
            M = M / M.sum()
        return M

    def __repr__(self) -> str:
        return (
            f"NegBinGoalModel(μ_h={self.mu_h:.3f}, k_h={self.k_h:.3f}, "
            f"μ_a={self.mu_a:.3f}, k_a={self.k_a:.3f}, "
            f"max_goals={self.max_goals})"
        )


def detect_overdispersion(
    goals: np.ndarray,
    threshold_ratio: float = 1.2,
    min_n: int = 30,
) -> bool:
    """Returns True if empirical Var(goals) / E(goals) > threshold_ratio.

    Default threshold 1.2 = 20% over Poisson assumption (conservative trigger
    for NegBin fallback — wait until we see clearly non-Poisson behavior).

    Returns False (= use Poisson) if n < min_n (insufficient sample to
    reliably distinguish Poisson from light overdispersion).
    """
    arr = np.asarray(goals)
    if len(arr) < min_n:
        return False
    mu = float(np.mean(arr))
    if mu <= 0:
        return False
    var = float(np.var(arr, ddof=1))
    return var / mu > threshold_ratio

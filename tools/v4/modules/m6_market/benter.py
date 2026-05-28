"""
m6_market.benter — Per-Liga Benter log-pool blend of model + market.

Benter (1994) showed that blending a quantitative model's predictions with
the betting-market's predictions (vig-removed) via LOG-POOLING outperforms
either alone:

    log(p_blend_i) ∝ β_model × log(p_model_i) + β_market × log(p_market_i)
    p_blend_i = softmax(β_model × log p_model_i + β_market × log p_market_i)

Per-league β weights because each league has different model+market quality.

API:
  BenterBlender()
    .fit(per_liga_data) → self
    .blend(p_model, p_market, league) → p_blended

Where per_liga_data is a dict {league: (p_model_array, p_market_array, outcomes)}.
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np
from scipy.optimize import minimize

# Single source of truth for "is this a valid probability?" tolerance.
# Import from eval.metrics so we never drift into per-module defaults.
from v4.eval.metrics import PROBABILITY_TOLERANCE


# Bounds for β weights — keep blend interpretable (no aggressive extrapolation)
BETA_BOUNDS = (0.0, 2.0)
DEFAULT_BETAS = (0.5, 0.5)  # equal-weight starting point

# Minimum samples per Liga to fit independent weights — below this, fall back
# to global pooled weights (or default 0.5/0.5)
MIN_LIGA_SAMPLES = 100


def _log_softmax_blend(
    log_p_model: np.ndarray,
    log_p_market: np.ndarray,
    beta_model: float,
    beta_market: float,
) -> np.ndarray:
    """Compute blended probabilities via log-pool + softmax normalization.

    Args:
        log_p_model: shape (n, K) log of model probs per row per class
        log_p_market: same shape
        beta_model, beta_market: scalar weights

    Returns: shape (n, K), each row sums to 1.0
    """
    logits = beta_model * log_p_model + beta_market * log_p_market
    # Softmax along K-axis with numerical stability
    logits = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(logits)
    return exp / exp.sum(axis=1, keepdims=True)


def _nll_blend(
    betas: np.ndarray,
    log_p_model: np.ndarray,
    log_p_market: np.ndarray,
    outcomes: np.ndarray,
    eps: float = 1e-12,
) -> float:
    """Negative log-likelihood of blended probs for outcome class.

    Args:
        betas: array [beta_model, beta_market]
        log_p_model, log_p_market: (n, K) log-probs
        outcomes: (n,) integer class labels
    Returns: scalar mean NLL
    """
    blended = _log_softmax_blend(log_p_model, log_p_market, betas[0], betas[1])
    n = len(outcomes)
    selected = np.clip(blended[np.arange(n), outcomes], eps, 1.0 - eps)
    return -float(np.mean(np.log(selected)))


class BenterBlender:
    """Per-Liga Benter log-pool blender of m3 + vig-removed market probs.

    Stateless until .fit() is called. After fit, .blend() applies the per-Liga
    weights (or default if Liga unseen at fit-time).
    """

    def __init__(
        self,
        *,
        default_betas: Tuple[float, float] = DEFAULT_BETAS,
        beta_bounds: Tuple[float, float] = BETA_BOUNDS,
        min_liga_samples: int = MIN_LIGA_SAMPLES,
    ):
        self.default_betas = default_betas
        self.beta_bounds = beta_bounds
        self.min_liga_samples = min_liga_samples
        # Per-Liga fitted weights: {liga: (beta_model, beta_market, n_samples, fit_success)}
        self.liga_weights: Dict[str, Dict[str, float]] = {}
        self.global_weights: Optional[Tuple[float, float]] = None
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def fit(
        self,
        per_liga_data: Dict[str, Tuple[np.ndarray, np.ndarray, np.ndarray]],
    ) -> "BenterBlender":
        """Fit per-Liga (β_model, β_market) by minimizing NLL.

        Args:
            per_liga_data: dict {liga: (p_model, p_market, outcomes)}
                p_model: shape (n, K), rows sum to 1
                p_market: shape (n, K), rows sum to 1 (vig-removed)
                outcomes: shape (n,), integers in [0, K)

        Returns: self
        """
        if not per_liga_data:
            raise ValueError("per_liga_data is empty")

        # First fit GLOBAL weights — pool all Ligen for a robust default
        all_p_model_log = []
        all_p_market_log = []
        all_outcomes = []
        for liga, (p_m, p_mk, y) in per_liga_data.items():
            self._validate_inputs(p_m, p_mk, y, liga)
            all_p_model_log.append(np.log(np.clip(p_m, 1e-12, 1.0)))
            all_p_market_log.append(np.log(np.clip(p_mk, 1e-12, 1.0)))
            all_outcomes.append(np.asarray(y, dtype=int))
        log_p_model_all = np.vstack(all_p_model_log)
        log_p_market_all = np.vstack(all_p_market_log)
        outcomes_all = np.concatenate(all_outcomes)

        global_betas, global_success = self._fit_betas(
            log_p_model_all, log_p_market_all, outcomes_all
        )
        if not global_success:
            global_betas = self.default_betas
        self.global_weights = tuple(global_betas)

        # Per-Liga fitting (fall back to global if sample too small or fit fails)
        for liga, (p_m, p_mk, y) in per_liga_data.items():
            n = len(y)
            log_p_m = np.log(np.clip(p_m, 1e-12, 1.0))
            log_p_mk = np.log(np.clip(p_mk, 1e-12, 1.0))
            y_arr = np.asarray(y, dtype=int)

            if n < self.min_liga_samples:
                self.liga_weights[liga] = {
                    "beta_model": self.global_weights[0],
                    "beta_market": self.global_weights[1],
                    "n_samples": int(n),
                    "fit_success": False,
                    "source": "global_pool_fallback_small_n",
                }
                continue

            betas, success = self._fit_betas(log_p_m, log_p_mk, y_arr)
            if not success:
                self.liga_weights[liga] = {
                    "beta_model": self.global_weights[0],
                    "beta_market": self.global_weights[1],
                    "n_samples": int(n),
                    "fit_success": False,
                    "source": "global_pool_fallback_fit_failed",
                }
            else:
                self.liga_weights[liga] = {
                    "beta_model": float(betas[0]),
                    "beta_market": float(betas[1]),
                    "n_samples": int(n),
                    "fit_success": True,
                    "source": "computed",
                }

        self._fitted = True
        return self

    @staticmethod
    def _validate_inputs(
        p_model: np.ndarray, p_market: np.ndarray, outcomes: np.ndarray, liga: str
    ) -> None:
        p_m = np.asarray(p_model)
        p_mk = np.asarray(p_market)
        y = np.asarray(outcomes)
        if p_m.ndim != 2 or p_mk.ndim != 2:
            raise ValueError(f"{liga}: p_model and p_market must be 2D")
        if p_m.shape != p_mk.shape:
            raise ValueError(
                f"{liga}: shape mismatch p_model {p_m.shape} vs p_market {p_mk.shape}"
            )
        if len(y) != len(p_m):
            raise ValueError(
                f"{liga}: length mismatch outcomes {len(y)} vs probs {len(p_m)}"
            )
        if not np.all(np.isfinite(p_m)) or not np.all(np.isfinite(p_mk)):
            raise ValueError(f"{liga}: non-finite probabilities")
        # Range check: probs must be in [0, 1] within PROBABILITY_TOLERANCE
        # (single source of truth — imported from eval.metrics).
        # Catches the silent-garbage path where rows sum to 1.0 but contain
        # negatives — internal log-clip at 1e-12 would hide the bug otherwise.
        if np.any(p_m < -PROBABILITY_TOLERANCE) or np.any(p_m > 1.0 + PROBABILITY_TOLERANCE):
            min_v, max_v = float(p_m.min()), float(p_m.max())
            raise ValueError(
                f"{liga}: p_model contains values outside [0, 1] "
                f"(tol={PROBABILITY_TOLERANCE}, min={min_v:.6f}, max={max_v:.6f})"
            )
        if np.any(p_mk < -PROBABILITY_TOLERANCE) or np.any(p_mk > 1.0 + PROBABILITY_TOLERANCE):
            min_v, max_v = float(p_mk.min()), float(p_mk.max())
            raise ValueError(
                f"{liga}: p_market contains values outside [0, 1] "
                f"(tol={PROBABILITY_TOLERANCE}, min={min_v:.6f}, max={max_v:.6f})"
            )
        # Row-sum check (same tolerance — same single source of truth)
        max_dev_m = float(np.max(np.abs(p_m.sum(axis=1) - 1.0)))
        max_dev_mk = float(np.max(np.abs(p_mk.sum(axis=1) - 1.0)))
        if max_dev_m > PROBABILITY_TOLERANCE:
            raise ValueError(
                f"{liga}: p_model rows don't sum to ~1 "
                f"(tol={PROBABILITY_TOLERANCE}, max-dev={max_dev_m:.4e})"
            )
        if max_dev_mk > PROBABILITY_TOLERANCE:
            raise ValueError(
                f"{liga}: p_market rows don't sum to ~1 "
                f"(tol={PROBABILITY_TOLERANCE}, max-dev={max_dev_mk:.4e})"
            )
        K = p_m.shape[1]
        if not np.all((y >= 0) & (y < K)):
            raise ValueError(f"{liga}: outcomes outside [0, {K})")

    def _fit_betas(
        self,
        log_p_model: np.ndarray,
        log_p_market: np.ndarray,
        outcomes: np.ndarray,
    ) -> Tuple[np.ndarray, bool]:
        """Minimize NLL over β_model + β_market."""
        x0 = np.array(self.default_betas, dtype=float)
        try:
            result = minimize(
                _nll_blend,
                x0=x0,
                args=(log_p_model, log_p_market, outcomes),
                method="L-BFGS-B",
                bounds=[self.beta_bounds, self.beta_bounds],
            )
            return result.x, bool(result.success)
        except Exception:
            return x0, False

    def blend(
        self,
        p_model: np.ndarray,
        p_market: np.ndarray,
        league: str,
    ) -> np.ndarray:
        """Apply Benter blend for a given Liga.

        Args:
            p_model: shape (K,) or (n, K) — model probs
            p_market: same shape — market probs (vig-removed)
            league: Liga code (resolves to fitted weights, else default)

        Returns: blended probs, same shape, rows sum to 1.
        """
        if not self._fitted:
            raise RuntimeError("BenterBlender not fitted")
        p_m = np.asarray(p_model, dtype=float)
        p_mk = np.asarray(p_market, dtype=float)
        if p_m.shape != p_mk.shape:
            raise ValueError(f"shape mismatch: {p_m.shape} vs {p_mk.shape}")

        weights = self.liga_weights.get(league)
        if weights is not None:
            beta_m, beta_mk = weights["beta_model"], weights["beta_market"]
        elif self.global_weights is not None:
            beta_m, beta_mk = self.global_weights
        else:
            beta_m, beta_mk = self.default_betas

        # Support both single-row (K,) and batch (n, K)
        was_1d = p_m.ndim == 1
        if was_1d:
            p_m = p_m[np.newaxis, :]
            p_mk = p_mk[np.newaxis, :]

        log_m = np.log(np.clip(p_m, 1e-12, 1.0))
        log_mk = np.log(np.clip(p_mk, 1e-12, 1.0))
        blended = _log_softmax_blend(log_m, log_mk, beta_m, beta_mk)

        return blended[0] if was_1d else blended

    def save(self, path: Path) -> None:
        if not self._fitted:
            raise RuntimeError("Cannot save unfitted blender")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump({
                "default_betas": self.default_betas,
                "beta_bounds": self.beta_bounds,
                "min_liga_samples": self.min_liga_samples,
                "liga_weights": self.liga_weights,
                "global_weights": self.global_weights,
                "_format_version": 1,
            }, f, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def load(cls, path: Path) -> "BenterBlender":
        with open(path, "rb") as f:
            payload = pickle.load(f)
        if payload.get("_format_version", 1) != 1:
            raise ValueError(f"Unsupported format: {payload.get('_format_version')}")
        instance = cls(
            default_betas=payload["default_betas"],
            beta_bounds=payload["beta_bounds"],
            min_liga_samples=payload["min_liga_samples"],
        )
        instance.liga_weights = payload["liga_weights"]
        instance.global_weights = payload["global_weights"]
        instance._fitted = True
        return instance

    def __repr__(self) -> str:
        status = "fitted" if self._fitted else "unfitted"
        n_liga = len(self.liga_weights) if self._fitted else 0
        return f"BenterBlender(status={status}, n_liga={n_liga})"

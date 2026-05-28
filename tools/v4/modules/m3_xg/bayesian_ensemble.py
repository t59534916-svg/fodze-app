"""
m3_xg.bayesian_ensemble — 5-seed bagged LightGBM ensemble.

Per V4-BACKTESTING-PROTOCOL §"m3 Bayesian Ensemble Definition":
  - 5 LightGBM models with different random_state seeds
  - Each trained on 80% bootstrap sample (sampled-with-replacement)
  - Predictions: ensemble mean + variance (inter-model disagreement)
  - Approximates posterior without MCMC (computational tractability)

The variance is the KEY OUTPUT — fed to m7_kelly's variance-shrinkage formula:
    shrinkage = 1 / (1 + α × σ²_hat / p_hat²)

If σ² ≈ 0 → model is confident → Kelly bet near vanilla size.
If σ² high → models disagree → Kelly bet shrunk.

Persistence: pickle (simple, works for v0.1.0-dev). Future: per-model
Booster.save_model() with metadata JSON if cross-version compatibility needed.
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import lightgbm as lgb
import numpy as np
import pandas as pd


# Default LightGBM params for Tweedie regression on football goals.
# tweedie_variance_power ∈ [1, 2]: 1 = Poisson, 2 = Gamma. 1.3 = balanced for football.
DEFAULT_LGB_PARAMS: Dict[str, Any] = {
    "objective": "tweedie",
    "tweedie_variance_power": 1.3,
    "metric": "tweedie",
    "n_estimators": 200,
    "learning_rate": 0.05,
    "max_depth": 5,
    "num_leaves": 24,
    "min_child_samples": 20,
    "feature_fraction": 0.9,
    "verbose": -1,  # suppress training spam
}

DEFAULT_BOOTSTRAP_FRACTION = 0.8
DEFAULT_N_MODELS = 5


class BayesianEnsemble:
    """5-seed bagged LightGBM regression ensemble.

    Stateless until .fit() is called. After fit, .predict() returns (mean, var).

    Why 5 not more? Empirical: variance estimates stabilize by ~5 models for
    well-conditioned LightGBM trees. More models = diminishing returns + linear
    cost growth. Future: tune up to 10 if σ² distribution shows excess noise.
    """

    def __init__(
        self,
        *,
        n_models: int = DEFAULT_N_MODELS,
        base_params: Optional[Dict[str, Any]] = None,
        seeds: Optional[Sequence[int]] = None,
        bootstrap_fraction: float = DEFAULT_BOOTSTRAP_FRACTION,
    ):
        if n_models < 2:
            raise ValueError(f"n_models must be ≥ 2 for variance, got {n_models}")
        if not (0.5 <= bootstrap_fraction <= 1.0):
            raise ValueError(
                f"bootstrap_fraction must be in [0.5, 1.0], got {bootstrap_fraction}"
            )
        self.n_models = n_models
        self.base_params = {**DEFAULT_LGB_PARAMS, **(base_params or {})}
        self.seeds = list(seeds) if seeds is not None else [42 + i for i in range(n_models)]
        if len(self.seeds) != n_models:
            raise ValueError(
                f"len(seeds)={len(self.seeds)} must equal n_models={n_models}"
            )
        self.bootstrap_fraction = float(bootstrap_fraction)
        self.models: List[lgb.LGBMRegressor] = []
        self.feature_names: List[str] = []
        self.categorical_columns: List[str] = []
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def fit(
        self,
        X: pd.DataFrame,
        y: np.ndarray,
        *,
        categorical_columns: Optional[Sequence[str]] = None,
        sample_weight: Optional[np.ndarray] = None,
    ) -> "BayesianEnsemble":
        """Train 5 LightGBM models on independent bootstrap samples.

        Args:
            X: feature DataFrame. Categorical columns (if any) must be dtype='category'.
            y: target array (1D). Length must match X.
            categorical_columns: list of categorical column names. LightGBM uses
                                 these as natively-handled categoricals.
            sample_weight: optional per-row weights (length == len(X)). Subset per
                           bootstrap draw and passed to LightGBM. Default None =
                           uniform (unchanged behavior).

        Returns: self (for chaining)
        """
        if len(X) != len(y):
            raise ValueError(f"X and y length mismatch: {len(X)} vs {len(y)}")
        if len(X) < 50:
            raise ValueError(f"insufficient training data: {len(X)} (need ≥ 50)")
        if sample_weight is not None:
            sample_weight = np.asarray(sample_weight, dtype=float)
            if len(sample_weight) != len(X):
                raise ValueError(f"sample_weight length {len(sample_weight)} != len(X) {len(X)}")

        y = np.asarray(y, dtype=float)
        if not np.all(np.isfinite(y)):
            raise ValueError(
                f"target contains {(~np.isfinite(y)).sum()} non-finite values"
            )
        if np.any(y < 0):
            raise ValueError(
                "Tweedie objective requires y ≥ 0 (got negative goals — data bug)"
            )

        self.feature_names = list(X.columns)
        self.categorical_columns = list(categorical_columns or [])
        self.models = []
        n = len(X)
        sample_size = int(self.bootstrap_fraction * n)

        for seed in self.seeds:
            rng = np.random.default_rng(seed)
            # Sample-with-replacement (true bootstrap)
            indices = rng.integers(0, n, size=sample_size)
            X_sub = X.iloc[indices].reset_index(drop=True)
            y_sub = y[indices]
            w_sub = sample_weight[indices] if sample_weight is not None else None
            params = {**self.base_params, "random_state": int(seed)}
            model = lgb.LGBMRegressor(**params)
            model.fit(
                X_sub, y_sub,
                sample_weight=w_sub,
                categorical_feature=self.categorical_columns or "auto",
            )
            self.models.append(model)

        self._fitted = True
        return self

    def predict(self, X: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        """Return (mean, variance) over the 5-model ensemble.

        Args:
            X: feature DataFrame with same columns as training X (order doesn't matter,
               we'll project to self.feature_names).

        Returns:
            mean: shape (n,) ensemble mean prediction
            var: shape (n,) inter-model variance (NOT std; caller squares-roots if needed)

        Raises:
            RuntimeError if model not yet fitted.
            ValueError if X is missing any feature_names columns.
        """
        if not self._fitted:
            raise RuntimeError("BayesianEnsemble not yet fitted — call .fit() first")
        missing = set(self.feature_names) - set(X.columns)
        if missing:
            raise ValueError(f"X missing required features: {sorted(missing)}")

        X_aligned = X[self.feature_names]  # enforce column order

        # Stack predictions: shape (n_models, n_samples)
        preds = np.array([m.predict(X_aligned) for m in self.models], dtype=float)
        mean = preds.mean(axis=0)
        # Use ddof=0 (population variance) — we have ALL the ensemble members,
        # not a sample. Avoids the n-1 small-sample bias for n=5.
        var = preds.var(axis=0, ddof=0)
        return mean, var

    def save(self, path: Path) -> None:
        """Persist the full ensemble (all 5 models + metadata) to disk."""
        if not self._fitted:
            raise RuntimeError("Cannot save unfitted ensemble")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "n_models": self.n_models,
            "base_params": self.base_params,
            "seeds": self.seeds,
            "bootstrap_fraction": self.bootstrap_fraction,
            "feature_names": self.feature_names,
            "categorical_columns": self.categorical_columns,
            "models": self.models,
            "_format_version": 1,
        }
        with open(path, "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def load(cls, path: Path) -> "BayesianEnsemble":
        """Restore a fitted ensemble from disk."""
        with open(path, "rb") as f:
            payload = pickle.load(f)
        if payload.get("_format_version", 1) != 1:
            raise ValueError(
                f"unsupported BayesianEnsemble format version: {payload.get('_format_version')}"
            )
        instance = cls(
            n_models=payload["n_models"],
            base_params={k: v for k, v in payload["base_params"].items()
                         if k not in ("objective",)},  # don't double-set defaults
            seeds=payload["seeds"],
            bootstrap_fraction=payload["bootstrap_fraction"],
        )
        instance.base_params = payload["base_params"]  # restore exact training params
        instance.feature_names = payload["feature_names"]
        instance.categorical_columns = payload["categorical_columns"]
        instance.models = payload["models"]
        instance._fitted = True
        return instance

    def __repr__(self) -> str:
        status = "fitted" if self._fitted else "unfitted"
        return (
            f"BayesianEnsemble(n_models={self.n_models}, "
            f"bootstrap={self.bootstrap_fraction:.0%}, status={status})"
        )

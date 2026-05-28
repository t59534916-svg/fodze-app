"""
m4_set_pieces.predictor — SetPiecePredictor: XGBoost binary classifier on shots.

Per V4-BACKTESTING-PROTOCOL §"m4_set_pieces":
  - XGBoost binary classification
  - max_depth=4, n_estimators=200, learning_rate=0.05
  - early_stopping_rounds=30
  - Output: P(goal | shot) per setpiece shot

Pass criteria (Stage 1.m4):
  - Log-loss < league-avg-conversion baseline by ≥ 5% relative
  - ECE < 0.03 (binned by predicted-prob deciles)
  - Per-situation calibration:
      penalty:   ~0.78 actual vs predicted
      corner:    ~0.09 actual vs predicted
      set-piece: ~0.09 actual vs predicted
      free-kick: ~0.05 actual vs predicted
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import xgboost as xgb


# Default XGBoost params per protocol spec
DEFAULT_XGB_PARAMS: Dict[str, Any] = {
    "objective": "binary:logistic",
    "eval_metric": "logloss",
    "max_depth": 4,
    "learning_rate": 0.05,
    "n_estimators": 200,
    "min_child_weight": 5,
    "subsample": 0.9,
    "colsample_bytree": 0.9,
    "random_state": 42,
    "n_jobs": -1,
    "verbosity": 0,
}

DEFAULT_EARLY_STOPPING_ROUNDS = 30


class SetPiecePredictor:
    """XGBoost binary classifier for setpiece-shot goal probability.

    Fit on a corpus of (X, y) where X is per-shot features and y ∈ {0, 1}.
    Predict returns P(goal | shot) ∈ [0, 1].

    Usage:
        predictor = SetPiecePredictor()
        predictor.fit(X_train, y_train, eval_set=(X_val, y_val))
        proba = predictor.predict_proba(X_test)
    """

    def __init__(
        self,
        *,
        base_params: Optional[Dict[str, Any]] = None,
        early_stopping_rounds: Optional[int] = DEFAULT_EARLY_STOPPING_ROUNDS,
    ):
        self.base_params = {**DEFAULT_XGB_PARAMS, **(base_params or {})}
        self.early_stopping_rounds = early_stopping_rounds
        self.model: Optional[xgb.XGBClassifier] = None
        self.feature_names: List[str] = []
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def fit(
        self,
        X: pd.DataFrame,
        y: np.ndarray,
        *,
        eval_set: Optional[tuple] = None,
    ) -> "SetPiecePredictor":
        """Train XGBoost binary classifier.

        Args:
            X: feature DataFrame (must contain only ALL_FEATURES columns —
               call feature_builder.extract_X() first to defend).
            y: target array (binary 0/1, length == len(X))
            eval_set: optional (X_val, y_val) tuple for early stopping.

        Returns: self
        """
        if len(X) != len(y):
            raise ValueError(f"X/y length mismatch: {len(X)} vs {len(y)}")
        if len(X) < 100:
            raise ValueError(f"insufficient training data: {len(X)} (need ≥ 100)")

        y_arr = np.asarray(y, dtype=int)
        if not np.all((y_arr == 0) | (y_arr == 1)):
            raise ValueError("y must be binary 0/1")

        self.feature_names = list(X.columns)

        # Configure XGBClassifier with early stopping if eval_set provided
        params = self.base_params.copy()
        if eval_set is not None and self.early_stopping_rounds:
            # XGBoost 2.x: early_stopping_rounds is a constructor arg
            params["early_stopping_rounds"] = self.early_stopping_rounds

        self.model = xgb.XGBClassifier(**params)

        fit_kwargs = {}
        if eval_set is not None:
            X_val, y_val = eval_set
            fit_kwargs["eval_set"] = [(X_val, y_val)]
            fit_kwargs["verbose"] = False

        self.model.fit(X, y_arr, **fit_kwargs)
        self._fitted = True
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Return P(goal | shot) per row, shape (n,)."""
        if not self._fitted:
            raise RuntimeError("SetPiecePredictor not fitted — call .fit() first")
        missing = set(self.feature_names) - set(X.columns)
        if missing:
            raise ValueError(f"X missing required features: {sorted(missing)}")
        X_aligned = X[self.feature_names]
        return self.model.predict_proba(X_aligned)[:, 1]

    def expected_goals_per_match(
        self, shots: pd.DataFrame, features: pd.DataFrame
    ) -> pd.Series:
        """Aggregate per-shot P(goal) into per-match expected setpiece goals.

        For each unique game_id × is_home pairing, sum the predicted P(goal)
        over all shots. Returns Series indexed by (game_id, is_home) tuple.

        Used by m3 integration: per-team setpiece offense strength.
        """
        if not self._fitted:
            raise RuntimeError("not fitted")
        if "game_id" not in shots.columns or "is_home" not in shots.columns:
            raise ValueError("shots must have game_id + is_home columns")
        if len(shots) != len(features):
            raise ValueError(
                f"shots/features length mismatch: {len(shots)} vs {len(features)}"
            )
        probs = self.predict_proba(features)
        result = pd.DataFrame({
            "game_id": shots["game_id"].values,
            "is_home": shots["is_home"].values,
            "p_goal": probs,
        })
        # Group and sum
        return result.groupby(["game_id", "is_home"])["p_goal"].sum()

    def save(self, path: Path) -> None:
        if not self._fitted:
            raise RuntimeError("Cannot save unfitted predictor")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "base_params": self.base_params,
            "early_stopping_rounds": self.early_stopping_rounds,
            "feature_names": self.feature_names,
            "model": self.model,
            "_format_version": 1,
        }
        with open(path, "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def load(cls, path: Path) -> "SetPiecePredictor":
        with open(path, "rb") as f:
            payload = pickle.load(f)
        if payload.get("_format_version", 1) != 1:
            raise ValueError(
                f"Unsupported format version: {payload.get('_format_version')}"
            )
        instance = cls(
            base_params={k: v for k, v in payload["base_params"].items()
                         if k != "early_stopping_rounds"},
            early_stopping_rounds=payload["early_stopping_rounds"],
        )
        instance.base_params = payload["base_params"]
        instance.feature_names = payload["feature_names"]
        instance.model = payload["model"]
        instance._fitted = True
        return instance

    def __repr__(self) -> str:
        status = "fitted" if self._fitted else "unfitted"
        return f"SetPiecePredictor(status={status}, n_features={len(self.feature_names)})"

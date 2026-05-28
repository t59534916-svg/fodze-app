"""
m3_xg.isotonic_calibrator — per-market isotonic post-calibration for m3 outputs.

Fit on a CALIBRATION set (out-of-training where possible). At inference, applies
per-market 1-vs-rest isotonic, then renormalizes 1X2 row to sum to 1.

Why isotonic vs Platt/temperature?
  - Non-parametric: handles any monotonic miscalibration shape
  - Empirically dominant in football literature for raw → calibrated probs
  - Cheap to fit (O(n log n) per class), cheap to apply (O(log n) per prediction)

Empirical reliability observation 2026-05-12 on dev-01 m3:
  P(H) low-bin (~0.16): observed 0.20 (under-predicts)
  P(H) high-bin (~0.74): observed 0.69 (over-predicts)
  ECE 0.0295 → target 0.005 per protocol G2

This is exactly the sigmoid-overconfidence pattern isotonic fixes.

API:
  IsotonicCalibrator()
    .fit(probs_dict, outcomes) → self
    .calibrate_probs(probs_dict) → calibrated probs_dict
    .save(path), classmethod load(path)
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression


# Markets we calibrate. 1X2 (H/D/A) is renormalized after per-class transform
# because 1-vs-rest isotonic doesn't preserve sum-to-1.
ONE_X_TWO_KEYS = ("H", "D", "A")
BINARY_MARKETS = ("over25", "btts_yes")


class IsotonicCalibrator:
    """Per-market isotonic post-calibration.

    Usage:
        calib = IsotonicCalibrator().fit(calibration_probs, calibration_outcomes)
        calibrated = calib.calibrate_probs(raw_probs)
    """

    def __init__(self):
        self.regressors: Dict[str, IsotonicRegression] = {}
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def fit(
        self,
        probs: Dict[str, np.ndarray],
        outcomes_1x2: Optional[np.ndarray] = None,
        outcomes_o25: Optional[np.ndarray] = None,
        outcomes_btts: Optional[np.ndarray] = None,
    ) -> "IsotonicCalibrator":
        """Fit isotonic regressors per market.

        Args:
            probs: dict with keys 'H', 'D', 'A' (required) plus optional
                   'over25', 'btts_yes'. Each value is a 1D numpy array of probs.
            outcomes_1x2: integer array {0=H, 1=D, 2=A} matching len(probs['H']).
            outcomes_o25: optional binary array (1 if goals > 2.5).
            outcomes_btts: optional binary array (1 if BTTS yes).

        Returns: self
        """
        # 1X2: 1-vs-rest per class
        if outcomes_1x2 is not None:
            outcomes_1x2 = np.asarray(outcomes_1x2, dtype=int)
            for i, key in enumerate(ONE_X_TWO_KEYS):
                if key not in probs:
                    raise ValueError(f"probs dict missing key {key!r}")
                p = np.asarray(probs[key], dtype=float)
                if p.shape != outcomes_1x2.shape:
                    raise ValueError(
                        f"shape mismatch for {key}: probs={p.shape}, "
                        f"outcomes={outcomes_1x2.shape}"
                    )
                actual = (outcomes_1x2 == i).astype(float)
                iso = IsotonicRegression(out_of_bounds="clip")
                iso.fit(p, actual)
                self.regressors[key] = iso

        # Binary markets — single isotonic each
        if outcomes_o25 is not None and "over25" in probs:
            p = np.asarray(probs["over25"], dtype=float)
            iso = IsotonicRegression(out_of_bounds="clip")
            iso.fit(p, np.asarray(outcomes_o25, dtype=float))
            self.regressors["over25"] = iso

        if outcomes_btts is not None and "btts_yes" in probs:
            p = np.asarray(probs["btts_yes"], dtype=float)
            iso = IsotonicRegression(out_of_bounds="clip")
            iso.fit(p, np.asarray(outcomes_btts, dtype=float))
            self.regressors["btts_yes"] = iso

        if not self.regressors:
            raise ValueError("No calibrators fit — pass at least one outcomes array")
        self._fitted = True
        return self

    def calibrate_probs(
        self, probs: Dict[str, float | np.ndarray]
    ) -> Dict[str, float | np.ndarray]:
        """Apply calibration to a probability dict.

        Args:
            probs: dict same shape as fit() input. Values can be scalars or arrays.

        Returns:
            New dict with calibrated values. 1X2 keys are renormalized to sum to 1.
            Missing-from-fit markets are passed through unchanged.
        """
        if not self._fitted:
            raise RuntimeError("IsotonicCalibrator not fitted")

        out = {}
        # Determine if input was scalar (preserve shape on output)
        def _was_scalar(val) -> bool:
            return np.ndim(val) == 0

        # 1X2 with renormalization
        has_1x2 = all(k in self.regressors for k in ONE_X_TWO_KEYS)
        if has_1x2:
            transformed = {}
            scalar_input = _was_scalar(probs["H"])
            for key in ONE_X_TWO_KEYS:
                p = probs[key]
                arr = np.atleast_1d(np.asarray(p, dtype=float))
                cal = self.regressors[key].predict(arr)
                # Clip to avoid 0 (causes div issues on renormalization)
                cal = np.clip(cal, 1e-9, 1.0)
                transformed[key] = cal
            # Renormalize each row
            total = transformed["H"] + transformed["D"] + transformed["A"]
            for key in ONE_X_TWO_KEYS:
                renorm = transformed[key] / total
                out[key] = float(renorm[0]) if scalar_input else renorm

        # Binary markets — independent calibration
        for market in BINARY_MARKETS:
            if market in self.regressors and market in probs:
                scalar_input = _was_scalar(probs[market])
                arr = np.atleast_1d(np.asarray(probs[market], dtype=float))
                cal = np.clip(self.regressors[market].predict(arr), 1e-9, 1.0 - 1e-9)
                out[market] = float(cal[0]) if scalar_input else cal

        # Pass-through anything not calibrated
        for key, val in probs.items():
            if key not in out:
                out[key] = val

        return out

    def save(self, path: Path) -> None:
        if not self._fitted:
            raise RuntimeError("Cannot save unfitted calibrator")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump(
                {"regressors": self.regressors, "_format_version": 1},
                f,
                protocol=pickle.HIGHEST_PROTOCOL,
            )

    @classmethod
    def load(cls, path: Path) -> "IsotonicCalibrator":
        with open(path, "rb") as f:
            payload = pickle.load(f)
        if payload.get("_format_version", 1) != 1:
            raise ValueError(
                f"Unsupported format version: {payload.get('_format_version')}"
            )
        instance = cls()
        instance.regressors = payload["regressors"]
        instance._fitted = True
        return instance

    def __repr__(self) -> str:
        status = "fitted" if self._fitted else "unfitted"
        markets = sorted(self.regressors.keys()) if self._fitted else []
        return f"IsotonicCalibrator(status={status}, markets={markets})"

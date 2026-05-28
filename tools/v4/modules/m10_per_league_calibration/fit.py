"""Per-league isotonic calibrator with Bayesian shrinkage toward global Platt.

Math:
  p_final(L, O | p_raw) = w(N_L) × iso_L(p_raw) + (1 - w(N_L)) × iso_global(p_raw)
  w(N) = N / (N + N0)
  Then renormalize: p ← p / sum across {H, D, A}

Why shrinkage:
  At n=300 (typical target-league sample), pure isotonic overfits step-function
  artifacts on single outlier-bins. Shrinking 77% toward the global calibrator
  (fitted on n=6500) regularizes without abandoning league-specific signal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

TARGET_LEAGUES = ["epl", "la_liga2", "primeira_liga"]
OUTCOMES = ("H", "D", "A")
P_COL = {"H": "prob_h_raw", "D": "prob_d_raw", "A": "prob_a_raw"}


@dataclass(frozen=True)
class CalibratorConfig:
    """Tunable knobs. Defaults chosen for our 300-700 per-league sample regime."""
    min_n_per_league: int = 200      # statistical-power floor for fit
    shrinkage_n0: int = 1000          # prior strength → w(N=N0) = 0.5


@dataclass
class IsoArtifact:
    """Serializable isotonic regression — sklearn's internal state."""
    x_thresholds: list[float]
    y_thresholds: list[float]
    increasing: bool
    n: int


class PerLeagueIsotonicCalibrator:
    """
    Fit-once + predict pattern.

    Usage:
        cal = PerLeagueIsotonicCalibrator().fit(df, target_leagues=["epl", ...])
        ph, pd_, pa = cal.predict("epl", p_h=0.45, p_d=0.30, p_a=0.25)
    """
    def __init__(self, config: Optional[CalibratorConfig] = None):
        self.cfg = config or CalibratorConfig()
        # (league, outcome) → IsoArtifact for the league-specific calibrator
        self.per_league: dict[tuple[str, str], IsoArtifact] = {}
        # outcome → IsoArtifact for global calibrator (fitted on ALL data)
        self.global_: dict[str, IsoArtifact] = {}
        # league → {outcome: n} sample-size tracker (for shrinkage weights)
        self.coverage: dict[str, dict[str, int]] = {}

    def _fit_iso(self, p: np.ndarray, y: np.ndarray) -> IsoArtifact:
        # Clip to (eps, 1-eps) to avoid degenerate inputs at boundaries
        p_clipped = np.clip(p, 1e-6, 1.0 - 1e-6)
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0,
                                 increasing="auto")
        iso.fit(p_clipped, y)
        return IsoArtifact(
            x_thresholds=list(map(float, iso.X_thresholds_)),
            y_thresholds=list(map(float, iso.y_thresholds_)),
            increasing=bool(iso.increasing_),
            n=int(len(p)),
        )

    def fit(self, df: pd.DataFrame,
            target_leagues: list[str] = TARGET_LEAGUES) -> "PerLeagueIsotonicCalibrator":
        """
        df columns required: league, prob_h_raw, prob_d_raw, prob_a_raw,
        ft_result ∈ {'H', 'D', 'A'}, match_date.
        """
        required = {"league", "prob_h_raw", "prob_d_raw", "prob_a_raw",
                    "ft_result", "match_date"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Input df missing columns: {missing}")

        # 1) Global iso (fit on ALL data — used as shrinkage prior + fallback)
        for outcome in OUTCOMES:
            y = (df["ft_result"] == outcome).astype(int).values
            p = df[P_COL[outcome]].values.astype(float)
            self.global_[outcome] = self._fit_iso(p, y)

        # 2) Per-league iso for target leagues with sufficient N
        for league in target_leagues:
            sub = df[df["league"] == league]
            n = len(sub)
            if n < self.cfg.min_n_per_league:
                continue
            self.coverage[league] = {}
            for outcome in OUTCOMES:
                y = (sub["ft_result"] == outcome).astype(int).values
                p = sub[P_COL[outcome]].values.astype(float)
                self.per_league[(league, outcome)] = self._fit_iso(p, y)
                self.coverage[league][outcome] = n
        return self

    @staticmethod
    def _interp(iso: IsoArtifact, p: float) -> float:
        """Linear interpolation on (x_thresholds_, y_thresholds_) —
        sklearn IsotonicRegression's internal predict() logic.
        Mirrors src/lib/per-league-calibration.ts::isoPredict for parity."""
        x = iso.x_thresholds
        y = iso.y_thresholds
        if not x:
            return p
        if p <= x[0]:
            return y[0]
        if p >= x[-1]:
            return y[-1]
        # Binary search for the bracketing interval
        lo, hi = 0, len(x) - 1
        while hi - lo > 1:
            mid = (lo + hi) >> 1
            if x[mid] <= p:
                lo = mid
            else:
                hi = mid
        if x[hi] == x[lo]:  # degenerate (shouldn't happen but defensive)
            return y[lo]
        t = (p - x[lo]) / (x[hi] - x[lo])
        return y[lo] + t * (y[hi] - y[lo])

    def predict(self, league: str, p_h: float, p_d: float, p_a: float
               ) -> tuple[float, float, float]:
        """Returns calibrated, renormalized (H, D, A) probabilities."""
        calibrated = {}
        for outcome, p in zip(OUTCOMES, (p_h, p_d, p_a)):
            p_clipped = min(max(p, 1e-6), 1.0 - 1e-6)
            p_global = self._interp(self.global_[outcome], p_clipped)

            key = (league, outcome)
            if key in self.per_league:
                p_league = self._interp(self.per_league[key], p_clipped)
                n = self.coverage[league][outcome]
                w = n / (n + self.cfg.shrinkage_n0)
                p_final = w * p_league + (1.0 - w) * p_global
            else:
                p_final = p_global
            calibrated[outcome] = max(1e-6, min(1.0 - 1e-6, p_final))

        # Renormalize H+D+A to sum=1 (post-isotonic drift, typically <2%)
        s = sum(calibrated.values())
        return (calibrated["H"] / s, calibrated["D"] / s, calibrated["A"] / s)

    def export_dict(self) -> dict:
        """Serialize to JSON-ready dict for TS runtime consumption."""
        def _ser(iso: IsoArtifact) -> dict:
            return {
                "x": iso.x_thresholds,
                "y": iso.y_thresholds,
                "increasing": iso.increasing,
                "n": iso.n,
            }
        return {
            "version": "1.0",
            "shrinkage_n0": self.cfg.shrinkage_n0,
            "min_n_per_league": self.cfg.min_n_per_league,
            "target_leagues": sorted(set(L for L, _ in self.per_league.keys())),
            "global": {O: _ser(self.global_[O]) for O in OUTCOMES},
            "per_league": {
                f"{L}__{O}": _ser(iso)
                for (L, O), iso in self.per_league.items()
            },
        }

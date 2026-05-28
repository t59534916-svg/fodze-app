"""m10_per_league_calibration — post-hoc isotonic calibrator per (league, outcome).

Targets the 3 catastrophically miscalibrated leagues identified by the
conformal-drift audit (2026-04-21):
  - epl           — α=0.10 under-covers by 8.5pp
  - la_liga2      — catastrophic across all α (max -14.9pp at α=0.10)
  - primeira_liga — α=0.10 under-covers by 5.2pp

Approach:
  Switch from Platt (which the other 19 leagues use) to Isotonic for these 3.
  Platt's 2-parameter symmetric S-curve cannot model the shifted-inflection-
  point miscalibration these leagues exhibit. Isotonic is non-parametric.

Sample-size mitigation:
  Bayesian shrinkage toward global Platt with N0=1000. At n=300 per league,
  shrinkage weight w_league = 300/1300 ≈ 0.23 — calibrator is 77% global,
  23% league-specific. Conservative against overfitting.

Acceptance gate (per league, walk-forward 5-fold CV):
  - Mean Brier-delta < -0.005 (calibrated minus raw)
  - Bootstrap CI on Brier-delta: upper bound < 0
  - Mean ECE reduction > 30%
  - At least n >= 200 (statistical power floor)

If a league fails gate → stays on global Platt (passthrough).
"""
from .fit import PerLeagueIsotonicCalibrator, CalibratorConfig, TARGET_LEAGUES, OUTCOMES
from .walk_forward_cv import walk_forward_validate

__all__ = [
    "PerLeagueIsotonicCalibrator",
    "CalibratorConfig",
    "TARGET_LEAGUES",
    "OUTCOMES",
    "walk_forward_validate",
]

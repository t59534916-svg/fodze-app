"""m9_filter_shield — Filter-as-Shield veto layer for FODZE Kelly.

Mirrors v1.1 Asymmetric Negation Protocol pattern: vetoes stack to MIN-pool
(worst-multiplier wins, no product cascade), multipliers clamped to [0, 1.0]
hard-monotone-non-increasing.

Currently ships:
  CSD_REGIME_SHIFT — empirically validated on v2-OOT predictions (2026-05-21):
    * persistent_reversal (active): rho_1 < -0.30 AND sign_flip → mult 0.50
    * catastrophic (shadow-only):   |rho_1| < 0.30 AND sign_flip AND
                                    |Δμ| > 0.50 → mult 0.75 (after 200 burn-in)

Rejected pre-step (DO NOT re-implement without new empirical evidence):
  TRAVEL_FATIGUE — stadium-coverage MNAR confounds the signal.
  PER_LEAGUE_ISOTONIC — sample size too small; deferred to multi-season retrain.
"""
from .csd_veto import (
    CsdVetoResult,
    compute_csd_veto,
    csd_veto_to_shield_veto,
    fetch_goal_diff_series,
)
from .schemas import ShieldVeto, ShieldResult, BetSide
from .shield_orchestrator import FilterShield
from .config import load_config, FilterShieldConfig

__all__ = [
    "CsdVetoResult",
    "compute_csd_veto",
    "csd_veto_to_shield_veto",
    "fetch_goal_diff_series",
    "ShieldVeto",
    "ShieldResult",
    "BetSide",
    "FilterShield",
    "FilterShieldConfig",
    "load_config",
]

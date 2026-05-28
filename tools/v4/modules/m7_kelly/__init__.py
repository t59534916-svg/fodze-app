"""v4.modules.m7_kelly — Robust Bayesian Kelly + Goldilocks gate + CLV dampening.

Per V4-BACKTESTING-PROTOCOL §"Modul-7":
  Step 1: Vanilla Kelly         edge = p_hat × o - 1; f = edge / (o-1)
  Step 2: Variance shrinkage    shrinkage = 1 / (1 + α × σ²/p²)
  Step 3: Profile cap           K=2.5%, M=4%, A=6%
  Step 4: Goldilocks edge-gate  per-Liga tier (sharp/moderate/soft) windows
  Step 5: CLV-feedback dampen   halve stake if Liga-CLV-z-score < -1 (optional)

Public API:
  RobustBayesianKelly   — orchestrator class
  KellyDecision         — immutable dataclass result with all diagnostics
  TIER_EDGE_WINDOWS     — default tier→(min, max) edge gates
  PROFILE_CAPS          — default K/M/A Kelly cap fractions
  DEFAULT_LIGA_TIERS    — default Liga→tier map (FODZE 22 leagues)
  get_tier              — helper: resolve a Liga to its tier name
  get_edge_window       — helper: resolve a Liga to its Goldilocks window
  get_kelly_cap         — helper: resolve a profile to its Kelly cap

Typical usage:
    from v4.modules.m7_kelly import RobustBayesianKelly

    kelly = RobustBayesianKelly(profile="M", alpha=1.0)
    decision = kelly.stake(
        p_hat=0.51, odds=2.0, league="bundesliga", sigma_sq=0.01,
    )
    print(decision.f_robust, decision.reasons)
"""
from v4.modules.m7_kelly.goldilocks import (
    DEFAULT_LIGA_TIERS,
    FALLBACK_TIER,
    PROFILE_CAPS,
    TIER_EDGE_WINDOWS,
    get_edge_window,
    get_kelly_cap,
    get_tier,
    list_liga_tiers,
    validate_tier,
)
from v4.modules.m7_kelly.kelly import (
    MIN_P_FOR_SHRINKAGE,
    NO_VARIANCE,
    KellyDecision,
    RobustBayesianKelly,
)

__all__ = [
    "RobustBayesianKelly",
    "KellyDecision",
    "TIER_EDGE_WINDOWS",
    "PROFILE_CAPS",
    "DEFAULT_LIGA_TIERS",
    "FALLBACK_TIER",
    "NO_VARIANCE",
    "MIN_P_FOR_SHRINKAGE",
    "get_tier",
    "get_edge_window",
    "get_kelly_cap",
    "list_liga_tiers",
    "validate_tier",
]

"""
m7_kelly.goldilocks — per-Liga edge windows + per-profile Kelly caps.

Two independent axes (per V4-BACKTESTING-PROTOCOL §"Modul-7"):

  1. LIGA TIER (sharp / moderate / soft) — set by market sharpness:
       - Sharp:    tight market → low-edge signals are real → accept 1.5–5%
       - Moderate: medium market → middle range → accept 2.5–7.5%
       - Soft:     noisy market → only large edges are signal → accept 3.5–8.5%

  2. USER PROFILE (K / M / A) — risk appetite, independent of Liga:
       - K (conservative): max 2.5% Kelly stake
       - M (moderate):     max 4.0% Kelly stake
       - A (aggressive):   max 6.0% Kelly stake

Liga tier assignment is empirical (Pinnacle market quality per FODZE-v2
production). Override via constructor for custom tier maps.

Module exports values as immutable constants — caller may NOT mutate the
defaults (a future-proofing landmine). For custom maps, pass overrides to
RobustBayesianKelly's constructor.
"""
from __future__ import annotations

from typing import Dict, Tuple


# ─────────────────────────────────────────────────────────────────────
# Per-tier edge windows
# ─────────────────────────────────────────────────────────────────────
# Edge = p_model × odds - 1 (positive = model thinks bet has +EV)
# Below tier_min: edge too small to be real signal (likely noise)
# Above tier_max: edge too large to be real signal (likely model is wrong)
TIER_EDGE_WINDOWS: Dict[str, Tuple[float, float]] = {
    "sharp":    (0.015, 0.050),  # 1.5% – 5.0%
    "moderate": (0.025, 0.075),  # 2.5% – 7.5%
    "soft":     (0.035, 0.085),  # 3.5% – 8.5%
}


# ─────────────────────────────────────────────────────────────────────
# Per-profile Kelly caps (max stake fraction of bankroll)
# ─────────────────────────────────────────────────────────────────────
PROFILE_CAPS: Dict[str, float] = {
    "K": 0.025,   # Conservative: max 2.5% per bet
    "M": 0.040,   # Moderate:     max 4.0%
    "A": 0.060,   # Aggressive:   max 6.0%
}


# ─────────────────────────────────────────────────────────────────────
# Default Liga → tier mapping (FODZE 22 leagues)
# ─────────────────────────────────────────────────────────────────────
# Based on Pinnacle market sharpness empirically observed.
# - Top-5 European leagues + Championship: sharp
# - Second tiers + mid-quality European: moderate
# - Lower tiers + niche markets: soft
DEFAULT_LIGA_TIERS: Dict[str, str] = {
    # Sharp tier (top-5 + sharpest markets)
    "epl": "sharp",
    "la_liga": "sharp",
    "bundesliga": "sharp",
    "serie_a": "sharp",
    "ligue_1": "sharp",
    "eredivisie": "sharp",
    "championship": "sharp",
    # Moderate tier
    "bundesliga2": "moderate",
    "la_liga2": "moderate",
    "serie_b": "moderate",
    "ligue_2": "moderate",
    "primeira_liga": "moderate",
    "super_lig": "moderate",
    "scottish_prem": "moderate",
    "jupiler_pro": "moderate",
    # Soft tier
    "liga3": "soft",
    "league_one": "soft",
    "league_two": "soft",
    "eerste_divisie": "soft",
    "austria_bl": "soft",
    "swiss_sl": "soft",
    "greek_sl": "soft",
}


# Liga not in DEFAULT_LIGA_TIERS → conservative fallback (moderate tier).
# Better to over-classify as moderate than miss an edge by being too soft.
FALLBACK_TIER: str = "moderate"


# ─────────────────────────────────────────────────────────────────────
# Public helpers
# ─────────────────────────────────────────────────────────────────────


def get_tier(
    league: str,
    *,
    liga_tiers: Dict[str, str] = None,
) -> str:
    """Resolve a Liga to its tier name. Unknown Liga → FALLBACK_TIER."""
    if liga_tiers is None:
        liga_tiers = DEFAULT_LIGA_TIERS
    return liga_tiers.get(league, FALLBACK_TIER)


def get_edge_window(
    league: str,
    *,
    liga_tiers: Dict[str, str] = None,
    tier_windows: Dict[str, Tuple[float, float]] = None,
) -> Tuple[float, float]:
    """Return (edge_min, edge_max) Goldilocks window for a Liga."""
    if tier_windows is None:
        tier_windows = TIER_EDGE_WINDOWS
    tier = get_tier(league, liga_tiers=liga_tiers)
    if tier not in tier_windows:
        raise KeyError(
            f"tier {tier!r} (from Liga {league!r}) not in tier_windows: "
            f"{list(tier_windows.keys())}"
        )
    return tier_windows[tier]


def get_kelly_cap(profile: str, *, profile_caps: Dict[str, float] = None) -> float:
    """Return Kelly cap for a profile."""
    if profile_caps is None:
        profile_caps = PROFILE_CAPS
    if profile not in profile_caps:
        raise ValueError(
            f"profile must be one of {list(profile_caps.keys())}, got {profile!r}"
        )
    return profile_caps[profile]


def validate_tier(tier: str, *, tier_windows: Dict[str, Tuple[float, float]] = None) -> None:
    """Raise if tier not recognized."""
    if tier_windows is None:
        tier_windows = TIER_EDGE_WINDOWS
    if tier not in tier_windows:
        raise ValueError(
            f"tier must be one of {list(tier_windows.keys())}, got {tier!r}"
        )


def list_liga_tiers() -> Dict[str, str]:
    """Return a COPY of the default Liga→tier map (callers may not mutate
    the canonical one)."""
    return dict(DEFAULT_LIGA_TIERS)

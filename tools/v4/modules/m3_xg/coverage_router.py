"""
m3_xg.coverage_router — pick the blend weight between m3_premium (specialist)
and m3_lean (generalist) for a given match.

Architecture rationale (dev-06):
  The dev-04 + dev-05 archives both died from the Coverage-Sparsity-Trap:
  features with <80% training-coverage produced DOA inference because trees
  learned "ignore the feature when zero" and then at inference (where coverage
  was higher) the feature became noise instead of signal.

  Option C avoids that trap structurally by running TWO models:
    • m3_lean   — trained on all ~27k matches, 16 features (= dev-03 unchanged)
    • m3_premium — trained on ~7400 matches with full Sofa stack, 9 extra features
  And blending their outputs by a weight derived ONLY from data-availability
  signals, not from match-level signals (avoids feature-leakage into routing).

API:
    weight = compute_premium_weight(league, season, kickoff_date) -> float ∈ [0, 1]

The router does NOT read from any DB at inference time. The premium-coverage
set is hard-coded based on the coverage probe in
`tools/v4/diagnostics/dev06_coverage_probe.md` (run 2026-05-20). When new
seasons or leagues are added to the premium tier, update PREMIUM_LEAGUES_BY_SEASON
and re-train — do NOT switch on raw DB lookups in this module.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional, Set


# ── Premium coverage table ─────────────────────────────────────────────────
# Leagues × seasons where ALL 9 premium features have ≥80% coverage in the
# local SQLite mirror. Verified by the 2026-05-20 coverage probe — see
# the architecture note at the top of this file.
#
# Format: season label "YYYY/YY" matching `sofascore_match.season`. Sofa uses
# "23/24" for the 2023-24 European football season (Aug 23 → May 24).

PREMIUM_LEAGUES_ALL_SEASONS: Set[str] = frozenset({
    # The 7 "always-premium" leagues: full xg in shotmap + xa in player_match_stats
    # for all three covered seasons (23/24, 24/25, 25/26).
    "epl",
    "la_liga",
    "bundesliga",
    "serie_a",
    "ligue_1",
    "championship",
    "liga3",
})

# Leagues that became premium-tier ONLY in the current season (25/26).
# Their 23/24 + 24/25 data lacks the Sofa-extras stack and must route to lean.
PREMIUM_LEAGUES_CURRENT_ONLY: Set[str] = frozenset({
    "bundesliga2",
    "serie_b",
    "eredivisie",
    "primeira_liga",
    "super_lig",
    "scottish_prem",
    "swiss_sl",
    "austria_bl",
    "greek_sl",
    "jupiler_pro",
})

# Volume-tier — no xg in shotmap for ANY season. Always pure lean.
LEAN_ONLY_LEAGUES: Set[str] = frozenset({
    "ligue_2",
    "la_liga2",
    "league_one",
    "league_two",
    "eerste_divisie",
})


@dataclass(frozen=True)
class RouterDecision:
    """Diagnostic-rich return type so callers can log / explain the weight."""
    weight: float          # ∈ [0, 1]: how much m3_premium contributes
    tier: str              # 'premium-stable' | 'premium-current-only' | 'lean'
    reason: str            # human-readable explanation
    league: str
    season: str


def _season_from_kickoff(kickoff_date: date) -> str:
    """Map an ISO date to the Sofa-style 'YY/YY' season label.

    Football seasons run Aug → May with a few exceptions (we don't model that
    here; the few summer-leagues that don't fit aren't in our premium set).
    Aug → May of year+1 is season "YY/YY+1". June+July is the off-season; we
    attribute it to the season that just ended (Aug N-1 → May N).
    """
    y = kickoff_date.year
    m = kickoff_date.month
    if m >= 8:                   # Aug-Dec: start of season Y/Y+1
        return f"{y % 100:02d}/{(y + 1) % 100:02d}"
    elif m <= 5:                 # Jan-May: tail of season Y-1/Y
        return f"{(y - 1) % 100:02d}/{y % 100:02d}"
    else:                        # Jun-Jul: attribute to season that just ended
        return f"{(y - 1) % 100:02d}/{y % 100:02d}"


def _is_current_or_recent(season: str, reference_today: Optional[date] = None) -> bool:
    """True iff the season is the current one or the directly preceding one.

    The premium weight should taper as we look further into the past — the
    SOFA-extras pipeline didn't exist before 23/24, and even the 23/24 backfill
    has slightly more imputation than 24/25 + 25/26.
    """
    today = reference_today or date.today()
    current = _season_from_kickoff(today)
    # Decode both as start years for comparison
    try:
        cy = int(current.split("/")[0])
        sy = int(season.split("/")[0])
    except (ValueError, IndexError):
        return False
    # Allow current + 1 prior + 1 future-edge for late-fixture matches
    return sy >= cy - 2


def compute_premium_decision(
    league: str,
    kickoff_date: date,
    reference_today: Optional[date] = None,
) -> RouterDecision:
    """Decide premium-weight for a match. Pure function — no IO."""
    season = _season_from_kickoff(kickoff_date)
    league_norm = (league or "").strip().lower()

    if not league_norm:
        return RouterDecision(0.0, "lean", "empty-league", league_norm, season)

    if league_norm in LEAN_ONLY_LEAGUES:
        return RouterDecision(
            0.0, "lean", f"{league_norm} has no Sofa-xG coverage in any season",
            league_norm, season,
        )

    # Always-premium leagues: weight scales with season recency.
    # Current/recent season → 0.7 (specialist dominant but lean keeps a 30%
    # voice as a Bayesian-style anti-overfit hedge — the specialist is
    # trained on ~7400 matches vs lean's ~27k, so we don't blindly trust it).
    # Older season → 0.5 (specialist trained on it but coverage was a bit
    # noisier per the 2026-05-20 probe).
    if league_norm in PREMIUM_LEAGUES_ALL_SEASONS:
        if _is_current_or_recent(season, reference_today):
            return RouterDecision(
                0.7, "premium-stable",
                f"{league_norm} {season}: full Sofa stack + recent training data",
                league_norm, season,
            )
        return RouterDecision(
            0.5, "premium-stable",
            f"{league_norm} {season}: premium league but older — lean baseline weighted equally",
            league_norm, season,
        )

    # Current-only premium: only blend when this match IS in the strictly-current
    # season. For these leagues Sofa coverage went live mid-25/26, so older
    # seasons (24/25 + earlier) have no specialist signal worth blending.
    if league_norm in PREMIUM_LEAGUES_CURRENT_ONLY:
        today = reference_today or date.today()
        current_season = _season_from_kickoff(today)
        if season == current_season:
            # Specialist hasn't been trained on these in older seasons, so
            # premium weight is lower (we trust it less for inference here).
            return RouterDecision(
                0.4, "premium-current-only",
                f"{league_norm} {season}: Sofa coverage NEW this season — partial premium blend",
                league_norm, season,
            )
        return RouterDecision(
            0.0, "lean",
            f"{league_norm} {season}: Sofa stack not yet available historically",
            league_norm, season,
        )

    # Unknown league — defensive fallback to lean. Defensive over silent default
    # so we don't silently boost a league we haven't validated.
    return RouterDecision(
        0.0, "lean",
        f"{league_norm}: not in any premium-coverage set — lean fallback",
        league_norm, season,
    )


def compute_premium_weight(league: str, kickoff_date: date) -> float:
    """Convenience: just the weight, no diagnostic envelope."""
    return compute_premium_decision(league, kickoff_date).weight

"""
Tests for v4.m3_xg.coverage_router.

Locks down the routing decisions in the 4 quadrants the router needs to handle:
  • Tier-A always-premium league (epl etc.) × current season
  • Tier-A always-premium league × older season
  • Current-only premium league (bundesliga2 etc.) × current vs older
  • Lean-only league (la_liga2 etc.) — must always be 0.0
  • Unknown league — defensive 0.0 fallback

Plus the season-encoding helper (Aug-Dec → forward, Jan-May → backward).
"""
from datetime import date

import pytest

from v4.modules.m3_xg.coverage_router import (
    _season_from_kickoff,
    compute_premium_decision,
    compute_premium_weight,
    PREMIUM_LEAGUES_ALL_SEASONS,
    PREMIUM_LEAGUES_CURRENT_ONLY,
    LEAN_ONLY_LEAGUES,
)


# ── Season-encoding helper ─────────────────────────────────────────────

class TestSeasonFromKickoff:
    def test_august_start_is_new_season(self):
        # Aug 5, 2025 → season 25/26
        assert _season_from_kickoff(date(2025, 8, 5)) == "25/26"

    def test_december_is_same_season(self):
        # Dec 26, 2025 → still 25/26
        assert _season_from_kickoff(date(2025, 12, 26)) == "25/26"

    def test_january_is_tail_of_prior_season(self):
        # Jan 15, 2026 → still 25/26 (Aug 2025 → May 2026)
        assert _season_from_kickoff(date(2026, 1, 15)) == "25/26"

    def test_may_is_tail_of_prior_season(self):
        # May 22, 2025 → 24/25 (the season ending in May 25)
        assert _season_from_kickoff(date(2025, 5, 22)) == "24/25"

    def test_june_is_attributed_to_just_ended_season(self):
        # Off-season match (rare) — attribute to just-ended season
        assert _season_from_kickoff(date(2025, 6, 10)) == "24/25"


# ── Routing decisions ──────────────────────────────────────────────────

class TestPremiumRouting:
    """Always-premium leagues (epl, la_liga, bundesliga, etc.)."""

    def test_premium_league_current_season_high_weight(self):
        # EPL October 2025 → in 25/26, full premium
        d = compute_premium_decision(
            "epl", date(2025, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.7
        assert d.tier == "premium-stable"
        assert "epl" in d.reason

    def test_premium_league_old_season_mid_weight(self):
        # EPL in 2017 — way out of training scope → reduced weight (0.5)
        d = compute_premium_decision(
            "epl", date(2017, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.5
        assert d.tier == "premium-stable"

    def test_premium_league_case_insensitive(self):
        d = compute_premium_decision(
            "EPL", date(2025, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.7

    def test_premium_league_whitespace_tolerated(self):
        d = compute_premium_decision(
            " la_liga ", date(2025, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.7


class TestCurrentOnlyPremiumRouting:
    """Leagues that became premium only in 25/26 (bundesliga2, eredivisie, ...)."""

    def test_current_season_partial_blend(self):
        d = compute_premium_decision(
            "bundesliga2", date(2025, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        # Smaller weight than always-premium because specialist hasn't seen
        # 23/24 + 24/25 data for these leagues
        assert d.weight == 0.4
        assert d.tier == "premium-current-only"

    def test_older_season_no_premium(self):
        # bundesliga2 in 23/24 → lean only (no Sofa stack back then)
        d = compute_premium_decision(
            "bundesliga2", date(2023, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.0
        assert d.tier == "lean"
        assert "not yet available" in d.reason


class TestLeanOnly:
    """Volume-tier leagues — always 0.0."""

    def test_la_liga2_always_lean(self):
        for d_ in [date(2023, 10, 1), date(2025, 10, 1), date(2026, 4, 1)]:
            d = compute_premium_decision("la_liga2", d_, reference_today=date(2026, 5, 20))
            assert d.weight == 0.0
            assert d.tier == "lean"

    def test_league_one_always_lean(self):
        d = compute_premium_decision(
            "league_one", date(2025, 12, 1),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.0


class TestDefensiveFallback:
    """Unknown leagues / bad input — must default to lean (0.0)."""

    def test_unknown_league(self):
        d = compute_premium_decision(
            "some_random_league", date(2025, 10, 15),
            reference_today=date(2026, 1, 15),
        )
        assert d.weight == 0.0
        assert d.tier == "lean"

    def test_empty_string(self):
        d = compute_premium_decision("", date(2025, 10, 15))
        assert d.weight == 0.0

    def test_none_safe(self):
        # `(None or "")` short-circuits to empty string → routes via the
        # explicit empty-league branch → lean fallback. Better than a crash.
        d = compute_premium_decision(None, date(2025, 10, 15))  # type: ignore[arg-type]
        assert d.weight == 0.0
        assert d.tier == "lean"
        assert "empty-league" in d.reason


class TestConvenienceWrapper:
    """compute_premium_weight should return just the float."""

    def test_returns_float(self):
        w = compute_premium_weight("epl", date(2025, 10, 15))
        assert isinstance(w, float)
        # The recent-season test will depend on date.today(); just check valid range.
        assert 0.0 <= w <= 1.0


class TestPartitionDisjointness:
    """The three premium-coverage sets must be mutually exclusive."""

    def test_no_overlap(self):
        a = PREMIUM_LEAGUES_ALL_SEASONS
        b = PREMIUM_LEAGUES_CURRENT_ONLY
        c = LEAN_ONLY_LEAGUES
        assert not (a & b), f"overlap between always-premium and current-only: {a & b}"
        assert not (a & c), f"overlap between always-premium and lean-only: {a & c}"
        assert not (b & c), f"overlap between current-only and lean-only: {b & c}"

    def test_22_known_leagues_covered_or_explicitly_unknown(self):
        # Sanity: leagues we have in production should land in one of the sets.
        # If a league is in CLAUDE.md's 22 but in NONE of the sets, that's
        # likely an oversight worth catching here.
        known_22 = {
            "epl", "la_liga", "bundesliga", "serie_a", "ligue_1",  # Top-5
            "bundesliga2", "championship", "la_liga2", "serie_b", "ligue_2",  # 2nd-divs
            "liga3", "league_one", "league_two",
            "eredivisie", "eerste_divisie",
            "primeira_liga", "super_lig",
            "scottish_prem", "swiss_sl", "austria_bl", "greek_sl", "jupiler_pro",
        }
        assigned = PREMIUM_LEAGUES_ALL_SEASONS | PREMIUM_LEAGUES_CURRENT_ONLY | LEAN_ONLY_LEAGUES
        missing = known_22 - assigned
        assert not missing, f"unassigned leagues from CLAUDE.md's 22: {missing}"

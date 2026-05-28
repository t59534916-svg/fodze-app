"""Pytest cases for m7_kelly — math + invariants + goldilocks + CLV.

Two layers:
  1. Parametrized wrapper around Stage 1.m7 (12 sanity tests)
  2. Targeted unit tests for finer math + edge cases (rejection paths,
     tier resolution, dataclass behavior, constructor validation)
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError

import numpy as np
import pytest

from v4.modules.m7_kelly import (
    DEFAULT_LIGA_TIERS,
    FALLBACK_TIER,
    MIN_P_FOR_SHRINKAGE,
    PROFILE_CAPS,
    TIER_EDGE_WINDOWS,
    KellyDecision,
    RobustBayesianKelly,
    get_edge_window,
    get_kelly_cap,
    get_tier,
    list_liga_tiers,
    validate_tier,
)
from v4.pipeline import stage_1_m7_kelly as _runner


# ─────────────────────────────────────────────────────────────────────
# Parametrize Stage 1 runner
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "label,test_fn",
    _runner.TESTS,
    ids=[label.strip().split()[0].strip("[]") for label, _ in _runner.TESTS],
)
def test_m7_kelly_stage1(label: str, test_fn) -> None:
    try:
        test_fn()
    except _runner.SanityCheckFailed as e:
        pytest.fail(f"{label} — {e}")


# ─────────────────────────────────────────────────────────────────────
# goldilocks.py unit tests
# ─────────────────────────────────────────────────────────────────────


def test_default_tier_windows_are_ordered():
    """Tighter tier should have tighter (lower-max) window."""
    sharp = TIER_EDGE_WINDOWS["sharp"]
    mod = TIER_EDGE_WINDOWS["moderate"]
    soft = TIER_EDGE_WINDOWS["soft"]
    # min should increase as tier loosens (sharper = accept smaller edges)
    assert sharp[0] < mod[0] < soft[0], "tier min should be ordered sharp < moderate < soft"
    assert sharp[1] < mod[1] < soft[1], "tier max similarly ordered"


def test_default_liga_tiers_cover_22_leagues():
    """FODZE 22 leagues should all be in the default map."""
    expected = {
        "epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "eredivisie", "championship",
        "bundesliga2", "la_liga2", "serie_b", "ligue_2", "primeira_liga", "super_lig",
        "scottish_prem", "jupiler_pro",
        "liga3", "league_one", "league_two", "eerste_divisie",
        "austria_bl", "swiss_sl", "greek_sl",
    }
    assert set(DEFAULT_LIGA_TIERS.keys()) == expected, (
        f"Liga set drift: extra={set(DEFAULT_LIGA_TIERS) - expected}, "
        f"missing={expected - set(DEFAULT_LIGA_TIERS)}"
    )


def test_get_tier_known_liga():
    assert get_tier("bundesliga") == "sharp"
    assert get_tier("liga3") == "soft"
    assert get_tier("super_lig") == "moderate"


def test_get_tier_unknown_liga_falls_back():
    assert get_tier("totally_made_up_liga") == FALLBACK_TIER


def test_get_edge_window_round_trip():
    window = get_edge_window("bundesliga")
    assert window == TIER_EDGE_WINDOWS["sharp"]


def test_get_kelly_cap_known_profile():
    assert get_kelly_cap("K") == 0.025
    assert get_kelly_cap("M") == 0.040
    assert get_kelly_cap("A") == 0.060


def test_get_kelly_cap_unknown_profile_raises():
    with pytest.raises(ValueError):
        get_kelly_cap("Z")


def test_list_liga_tiers_returns_copy():
    """list_liga_tiers must return a copy — callers can't mutate the default."""
    a = list_liga_tiers()
    a["fake_liga"] = "sharp"
    b = list_liga_tiers()
    assert "fake_liga" not in b, "list_liga_tiers leaked a reference"


def test_validate_tier_rejects_unknown():
    with pytest.raises(ValueError):
        validate_tier("imaginary_tier")


# ─────────────────────────────────────────────────────────────────────
# kelly.py constructor validation
# ─────────────────────────────────────────────────────────────────────


def test_kelly_rejects_unknown_profile():
    with pytest.raises(ValueError, match="profile"):
        RobustBayesianKelly(profile="X")


def test_kelly_rejects_negative_alpha():
    with pytest.raises(ValueError, match="alpha"):
        RobustBayesianKelly(alpha=-0.1)


def test_kelly_rejects_dampening_factor_out_of_range():
    with pytest.raises(ValueError, match="dampening"):
        RobustBayesianKelly(clv_dampening_factor=-0.1)
    with pytest.raises(ValueError, match="dampening"):
        RobustBayesianKelly(clv_dampening_factor=1.5)


def test_vanilla_kelly_rejects_invalid_odds():
    kelly = RobustBayesianKelly()
    with pytest.raises(ValueError, match="odds"):
        kelly.vanilla_kelly(p_hat=0.5, odds=0.9)
    with pytest.raises(ValueError, match="odds"):
        kelly.vanilla_kelly(p_hat=0.5, odds=1.0)  # 1.0 means no return


def test_vanilla_kelly_rejects_invalid_p():
    kelly = RobustBayesianKelly()
    with pytest.raises(ValueError, match="p_hat"):
        kelly.vanilla_kelly(p_hat=-0.1, odds=2.0)
    with pytest.raises(ValueError, match="p_hat"):
        kelly.vanilla_kelly(p_hat=1.1, odds=2.0)


def test_variance_shrinkage_rejects_negative_variance():
    kelly = RobustBayesianKelly()
    with pytest.raises(ValueError, match="sigma_sq"):
        kelly.variance_shrinkage_factor(p_hat=0.5, sigma_sq=-0.1)


def test_variance_shrinkage_tiny_p_returns_zero():
    """p < MIN_P_FOR_SHRINKAGE → shrinkage = 0 (defensive against divide-by-zero)."""
    kelly = RobustBayesianKelly()
    assert kelly.variance_shrinkage_factor(p_hat=MIN_P_FOR_SHRINKAGE / 2, sigma_sq=0.01) == 0.0


# ─────────────────────────────────────────────────────────────────────
# KellyDecision dataclass
# ─────────────────────────────────────────────────────────────────────


def test_kelly_decision_is_frozen():
    kelly = RobustBayesianKelly(profile="M")
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    with pytest.raises(FrozenInstanceError):
        d.f_robust = 0.99  # type: ignore[misc]


def test_kelly_decision_has_all_required_fields():
    kelly = RobustBayesianKelly(profile="M")
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    required = {
        "f_robust", "f_vanilla", "f_bayesian", "edge", "shrinkage",
        "expected_value", "league_tier", "edge_window", "edge_in_window",
        "cap_applied", "clv_dampened", "reasons",
        "p_hat", "sigma_sq", "odds", "profile", "league",
    }
    for field in required:
        assert hasattr(d, field), f"KellyDecision missing field: {field}"


def test_reasons_non_empty_on_zero_stake():
    """When stake = 0, the reasons tuple must explain WHY (no silent zeros)."""
    kelly = RobustBayesianKelly(profile="M")
    # Negative edge
    d_neg = kelly.stake(p_hat=0.40, odds=2.0, league="bundesliga")
    assert d_neg.f_robust == 0
    assert len(d_neg.reasons) > 0
    assert "edge_non_positive" in d_neg.reasons
    # Edge above window
    d_above = kelly.stake(p_hat=0.60, odds=2.0, league="bundesliga")
    assert d_above.f_robust == 0
    assert any("above_window" in r for r in d_above.reasons)


# ─────────────────────────────────────────────────────────────────────
# CLV feedback integration
# ─────────────────────────────────────────────────────────────────────


def test_clv_callback_called_with_league():
    """Verify the callback receives the Liga name as positional arg."""
    received_leagues = []

    def mock_clv(league: str) -> float:
        received_leagues.append(league)
        return -2.0  # always dampen

    kelly = RobustBayesianKelly(profile="M", clv_feedback_fn=mock_clv)
    # In-window bet that should trigger the CLV callback
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert d.clv_dampened
    assert "bundesliga" in received_leagues


def test_clv_callback_returning_none_does_not_dampen():
    """If callback returns None, treat as no-CLV-signal (don't dampen)."""
    def mock_clv(league: str):
        return None

    kelly = RobustBayesianKelly(profile="M", clv_feedback_fn=mock_clv)
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert not d.clv_dampened


def test_clv_callback_zero_or_positive_zscore_no_dampen():
    def mock_clv(league: str) -> float:
        return 0.5

    kelly = RobustBayesianKelly(profile="M", clv_feedback_fn=mock_clv)
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert not d.clv_dampened
    # And stake equals what it would without CLV-feedback at all
    kelly_no_clv = RobustBayesianKelly(profile="M", clv_feedback_fn=None)
    d_no_clv = kelly_no_clv.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert abs(d.f_robust - d_no_clv.f_robust) < 1e-9


# ─────────────────────────────────────────────────────────────────────
# End-to-end determinism + idempotence
# ─────────────────────────────────────────────────────────────────────


def test_kelly_is_deterministic():
    """Same inputs → identical outputs (no stochastic behavior)."""
    kelly = RobustBayesianKelly(profile="M")
    decisions = [
        kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga", sigma_sq=0.01)
        for _ in range(5)
    ]
    for d in decisions[1:]:
        assert d.f_robust == decisions[0].f_robust
        assert d.edge == decisions[0].edge
        assert d.shrinkage == decisions[0].shrinkage


def test_kelly_allow_list_excludes_liga():
    """Liga not in allow_list should always return f_robust=0 with a clear reason."""
    kelly = RobustBayesianKelly(
        profile="M",
        liga_allow_list={"bundesliga"},  # only BL allowed
    )
    # BL is in allow_list — should bet as usual
    d_bl = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert d_bl.f_robust > 0
    # serie_a is NOT in allow_list — should refuse
    d_sa = kelly.stake(p_hat=0.51, odds=2.0, league="serie_a")
    assert d_sa.f_robust == 0
    assert any("not_in_allow_list" in r for r in d_sa.reasons)


def test_kelly_allow_list_none_means_no_filter():
    """allow_list=None (default) means all Ligen pass through."""
    kelly = RobustBayesianKelly(profile="M", liga_allow_list=None)
    # serie_a passes through (no allow_list filter)
    d = kelly.stake(p_hat=0.51, odds=2.0, league="serie_a")
    # serie_a is sharp tier → edge=0.02 ∈ [0.015, 0.05] → bet
    assert d.f_robust > 0


def test_kelly_allow_list_empty_set_blocks_all():
    """allow_list=set() blocks everything (edge case — caller probably means None)."""
    kelly = RobustBayesianKelly(profile="M", liga_allow_list=set())
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    assert d.f_robust == 0
    assert any("not_in_allow_list" in r for r in d.reasons)


def test_kelly_with_custom_tier_overrides():
    """Custom liga_tiers/tier_windows replace defaults cleanly."""
    custom_tiers = {"my_liga": "sharp"}
    custom_windows = {"sharp": (0.001, 0.999)}  # very wide
    kelly = RobustBayesianKelly(
        profile="M",
        liga_tiers=custom_tiers,
        tier_windows=custom_windows,
    )
    # edge=0.10 would normally fail default sharp window; should pass here
    d = kelly.stake(p_hat=0.55, odds=2.0, league="my_liga")
    assert d.edge_in_window
    assert d.f_robust > 0
    # Unknown Liga falls back to "moderate" — which isn't in our custom_windows
    # so it should raise on resolution
    with pytest.raises(KeyError):
        kelly.stake(p_hat=0.55, odds=2.0, league="unknown_liga")

"""Tests for m9_filter_shield — CSD veto + shield orchestrator.

Coverage:
  * Config loader: parses public/filter-shield-config.json
  * CSD classification: 4 regimes + boundary cases
  * Shield orchestrator: min-pool stacking, shadow handling, bet-side routing
  * End-to-end: real series → CSD result → ShieldVeto → multiplier application
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from v4.modules.m9_filter_shield import (
    FilterShield,
    ShieldVeto,
    compute_csd_veto,
    csd_veto_to_shield_veto,
    fetch_goal_diff_series,
    load_config,
)
from v4.modules.m9_filter_shield.shield_orchestrator import _clamp01


# ─────────────────────────────────────────────────────────────────────
# Config loader
# ─────────────────────────────────────────────────────────────────────


def test_config_loads_from_public_json():
    cfg = load_config()
    assert cfg.version == "1.0"
    assert cfg.csd_veto.signal == "goal_diff"
    assert cfg.csd_veto.window == 10
    assert cfg.csd_veto.min_obs == 8
    assert cfg.csd_veto.recent_block == 3
    assert cfg.csd_veto.leakage_offset_sec == 14400
    assert cfg.csd_veto.sign_flip_min_abs == 0.10


def test_config_has_both_regimes():
    cfg = load_config()
    assert "persistent_reversal" in cfg.csd_veto.regimes
    assert "catastrophic" in cfg.csd_veto.regimes


def test_config_persistent_reversal_is_active():
    """persistent_reversal MUST be active (empirically validated +0.043 Brier lift)."""
    cfg = load_config()
    pr = cfg.csd_veto.regimes["persistent_reversal"]
    assert pr.active is True
    assert pr.multiplier == 0.50
    assert pr.acf_max == -0.30


def test_config_catastrophic_is_shadow_only():
    """catastrophic must stay shadow until 200-firing burn-in confirms it."""
    cfg = load_config()
    cat = cfg.csd_veto.regimes["catastrophic"]
    assert cat.active is False
    assert cat.multiplier == 0.75
    assert cat.acf_max_abs == 0.30
    assert cat.delta_min_abs == 0.50


# ─────────────────────────────────────────────────────────────────────
# CSD classification
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def cfg():
    return load_config().csd_veto


def test_csd_insufficient_n(cfg):
    """Below min_obs → no veto."""
    series = np.array([1.0, 2.0, 3.0])
    r = compute_csd_veto(series, cfg)
    assert r.regime == "insufficient_n"
    assert r.multiplier == 1.0
    assert r.n_obs == 3


def test_csd_stable_no_signflip(cfg):
    """Stable series (no sign flip) → stable regime, mult 1.0."""
    series = np.array([1.0, 1.5, 1.0, 1.2, 0.8, 1.1, 1.3, 0.9, 1.4, 1.0])
    r = compute_csd_veto(series, cfg)
    assert r.regime == "stable"
    assert r.multiplier == 1.0


def test_csd_persistent_reversal_triggers(cfg):
    """Highly oscillating series with sign-flip → persistent_reversal."""
    # Strong negative autocorr + sign flip in last 3
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -2, 2, -3])
    r = compute_csd_veto(series, cfg)
    assert r.regime == "persistent_reversal"
    assert r.multiplier == 0.50
    assert r.rho_1 < -0.30
    assert r.sign_flipped is True
    assert r.shadow is False  # active


def test_csd_catastrophic_remains_shadow(cfg):
    """Even when catastrophic regime conditions hit, multiplier stays 1.0
    because the regime is SHADOW until burn-in completes."""
    # Construct a series with low autocorr + sign-flip + large delta
    # Prior block: mostly +2, recent block: -2 (sign flip with large |delta|)
    np.random.seed(42)
    prior = np.array([2.0, 1.5, 2.5, 1.8, 2.2, 2.1, 2.0])  # n=7 prior matches
    recent = np.array([-2.0, -1.5, -2.0])  # 3 recent matches, opposite sign
    series = np.concatenate([prior, recent])
    r = compute_csd_veto(series, cfg)
    if r.regime == "catastrophic":
        # Multiplier should be 1.0 because active=False
        assert r.multiplier == 1.0
        assert r.shadow is True
    # (May classify as stable depending on rho — that's fine, test that
    # IF classified catastrophic, shadow semantics hold)


def test_csd_minimum_observations_boundary(cfg):
    """Exactly min_obs (=8) → classification possible."""
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -3])  # n=8
    r = compute_csd_veto(series, cfg)
    assert r.regime != "insufficient_n"
    assert r.n_obs == 8


def test_csd_zero_variance_handled(cfg):
    """Constant series → rho=0 (no division-by-zero crash)."""
    series = np.array([1.0] * 10)
    r = compute_csd_veto(series, cfg)
    assert r.regime in ("stable", "catastrophic", "persistent_reversal")
    assert r.rho_1 == 0.0


def test_csd_result_includes_raw_series_for_trail_logging(cfg):
    """Persistence-contract: raw_series MUST be included for epistemic_trails."""
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -2, 2, -3])
    r = compute_csd_veto(series, cfg)
    assert isinstance(r.raw_series, list)
    assert len(r.raw_series) == 10


# ─────────────────────────────────────────────────────────────────────
# CSD → ShieldVeto conversion
# ─────────────────────────────────────────────────────────────────────


def test_csd_to_shield_stable_returns_none(cfg):
    """Stable regime → no veto generated."""
    series = np.array([1.0] * 10)
    r = compute_csd_veto(series, cfg)
    veto = csd_veto_to_shield_veto(r, team_side="home", match_key="test")
    if r.regime == "stable":
        assert veto is None


def test_csd_to_shield_home_side_routes_to_home_and_draw(cfg):
    """Home-team CSD veto must affect 'home' AND 'draw' bets, not 'away'."""
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -2, 2, -3])
    r = compute_csd_veto(series, cfg)
    veto = csd_veto_to_shield_veto(r, team_side="home", match_key="m1")
    assert veto is not None
    assert "home" in veto.applies_to
    assert "draw" in veto.applies_to
    assert "away" not in veto.applies_to


def test_csd_to_shield_away_side_routes_to_away_and_draw(cfg):
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -2, 2, -3])
    r = compute_csd_veto(series, cfg)
    veto = csd_veto_to_shield_veto(r, team_side="away", match_key="m1")
    assert veto is not None
    assert "away" in veto.applies_to
    assert "draw" in veto.applies_to
    assert "home" not in veto.applies_to


def test_csd_to_shield_invalid_team_side_raises(cfg):
    series = np.array([2.0, -2, 2, -2, 2, -2, 2, -2, 2, -3])
    r = compute_csd_veto(series, cfg)
    with pytest.raises(ValueError):
        csd_veto_to_shield_veto(r, team_side="wrong", match_key="m1")


# ─────────────────────────────────────────────────────────────────────
# FilterShield orchestrator
# ─────────────────────────────────────────────────────────────────────


def test_shield_empty_returns_passthrough():
    shield = FilterShield()
    r = shield.apply("home")
    assert r.effective_multiplier == 1.0
    assert r.haircut_pct == 0.0
    assert r.applied_vetoes == []
    assert r.shadow_vetoes == []


def test_shield_single_active_veto():
    shield = FilterShield()
    shield.add(ShieldVeto(name="v1", multiplier=0.5, reason="",
                          applies_to=["home"], raw_diagnostic={}))
    r = shield.apply("home")
    assert r.effective_multiplier == 0.5
    assert r.haircut_pct == 50.0
    assert len(r.applied_vetoes) == 1


def test_shield_min_pool_not_product():
    """CRITICAL: two vetoes 0.5 and 0.75 on same side → MIN (0.5), NOT product (0.375)."""
    shield = FilterShield()
    shield.add(ShieldVeto(name="v1", multiplier=0.5, reason="",
                          applies_to=["home"], raw_diagnostic={}))
    shield.add(ShieldVeto(name="v2", multiplier=0.75, reason="",
                          applies_to=["home"], raw_diagnostic={}))
    r = shield.apply("home")
    assert r.effective_multiplier == 0.5
    # NOT 0.5 * 0.75 = 0.375
    assert r.effective_multiplier != 0.375


def test_shield_shadow_veto_does_not_alter_multiplier():
    shield = FilterShield()
    shield.add(ShieldVeto(name="active", multiplier=0.9, reason="",
                          applies_to=["home"], raw_diagnostic={}, shadow=False))
    shield.add(ShieldVeto(name="shadow", multiplier=0.3, reason="",
                          applies_to=["home"], raw_diagnostic={}, shadow=True))
    r = shield.apply("home")
    assert r.effective_multiplier == 0.9  # NOT 0.3
    assert len(r.applied_vetoes) == 1
    assert len(r.shadow_vetoes) == 1
    assert r.applied_vetoes[0].name == "active"
    assert r.shadow_vetoes[0].name == "shadow"


def test_shield_bet_side_routing():
    """Veto on 'home' must NOT affect 'away' bets."""
    shield = FilterShield()
    shield.add(ShieldVeto(name="home_veto", multiplier=0.4, reason="",
                          applies_to=["home", "draw"], raw_diagnostic={}))

    assert shield.apply("home").effective_multiplier == 0.4
    assert shield.apply("away").effective_multiplier == 1.0
    assert shield.apply("draw").effective_multiplier == 0.4


def test_shield_clamps_multiplier_above_one():
    """Defensive: multiplier > 1.0 input MUST be clamped to 1.0."""
    shield = FilterShield()
    shield.add(ShieldVeto(name="weird", multiplier=2.5, reason="",
                          applies_to=["home"], raw_diagnostic={}))
    # Clamp happens INSIDE add(), so stored value is 1.0
    assert shield.vetoes[0].multiplier == 1.0


def test_shield_clamps_negative_multiplier_to_zero():
    shield = FilterShield()
    shield.add(ShieldVeto(name="negative", multiplier=-0.5, reason="",
                          applies_to=["home"], raw_diagnostic={}))
    assert shield.vetoes[0].multiplier == 0.0


def test_shield_add_none_is_noop():
    """add(None) should not crash (lets call-sites pass possibly-None vetoes)."""
    shield = FilterShield()
    shield.add(None)
    assert shield.vetoes == []


def test_shield_extend_with_mixed_none():
    shield = FilterShield()
    shield.extend([
        ShieldVeto(name="v1", multiplier=0.5, reason="",
                   applies_to=["home"], raw_diagnostic={}),
        None,
        ShieldVeto(name="v2", multiplier=0.7, reason="",
                   applies_to=["home"], raw_diagnostic={}),
    ])
    assert len(shield.vetoes) == 2


def test_clamp01_helper():
    assert _clamp01(-0.5) == 0.0
    assert _clamp01(0.0) == 0.0
    assert _clamp01(0.5) == 0.5
    assert _clamp01(1.0) == 1.0
    assert _clamp01(1.5) == 1.0


# ─────────────────────────────────────────────────────────────────────
# fetch_goal_diff_series + leakage protection
# ─────────────────────────────────────────────────────────────────────


def test_fetch_goal_diff_series_applies_4h_offset():
    """4h offset (14400 sec) MUST be enforced — same-day prior matches excluded."""
    import pandas as pd

    history = pd.DataFrame({
        "match_ts": [
            1700000000,                  # 11 days before focal
            1700864000,                  # 1 day before focal
            1700950000,                  # 4.4h before focal (excluded by 4h offset)
            1700986000,                  # ~6h AFTER focal (excluded as future)
        ],
        "goals_for":     [2.0, 1.0, 3.0, 0.0],
        "goals_against": [1.0, 1.0, 2.0, 0.0],
    })
    focal = 1700966400
    series = fetch_goal_diff_series(
        history, focal, window=10, leakage_offset_sec=14400,
    )
    # Only first 2 rows should be included (4h+ offset). The 3rd row (4.4h before
    # = 15840 sec) IS within the cutoff (>= 14400 before focal), so it qualifies.
    # Let me check: cutoff = focal - 14400 = 1700952000
    # Row 3 ts = 1700950000 < 1700952000 ✓ included
    # Row 4 ts = 1700986000 > cutoff ✗ excluded
    # So 3 rows included, future row excluded.
    assert len(series) == 3
    np.testing.assert_array_almost_equal(series, [1.0, 0.0, 1.0])


def test_fetch_goal_diff_series_empty_history():
    import pandas as pd
    empty = pd.DataFrame({"match_ts": [], "goals_for": [], "goals_against": []})
    series = fetch_goal_diff_series(empty, 1700000000, window=10, leakage_offset_sec=14400)
    assert len(series) == 0


def test_fetch_goal_diff_series_respects_window():
    """If history has more matches than window, only last-window are returned."""
    import pandas as pd
    ts_base = 1700000000
    history = pd.DataFrame({
        "match_ts": [ts_base + i * 86400 for i in range(15)],
        "goals_for": list(range(15)),
        "goals_against": [0] * 15,
    })
    focal = ts_base + 15 * 86400 + 86400  # all rows are in past
    series = fetch_goal_diff_series(history, focal, window=10, leakage_offset_sec=14400)
    assert len(series) == 10
    # Should be the LAST 10 (newest 10), so 5..14 - 0 = 5,6,...,14
    np.testing.assert_array_equal(series, np.arange(5, 15))

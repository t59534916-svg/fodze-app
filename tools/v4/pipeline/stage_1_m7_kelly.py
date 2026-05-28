"""
Stage 1.m7_kelly — math + invariant sanity for RobustBayesianKelly.

Per V4-BACKTESTING-PROTOCOL §"m7_kelly":
  Stage 1.m7 = math identities + invariants (NOT a Brier-comparison stage).
  Stage 5 (CLV simulation) is the bankroll-evolution test — separate file.

Tests (12 total):
  1.  Vanilla Kelly identity:  p=0.55, o=2.0 → edge=0.10, f_v=0.10
  2.  Vanilla Kelly: negative edge → f_v = 0
  3.  Variance shrinkage: σ²=0 → shrinkage=1.0 (no change)
  4.  Variance shrinkage: σ²>0 → shrinkage<1.0 (reduces stake)
  5.  Variance shrinkage: σ² → ∞ → shrinkage → 0
  6.  Profile cap enforced: never exceeds {K:2.5%, M:4%, A:6%}
  7.  Goldilocks gate: edge below window → f_robust = 0
  8.  Goldilocks gate: edge above window → f_robust = 0
  9.  Goldilocks gate: edge in window → f_robust > 0
  10. Output ranges: f_robust ∈ [0, f_cap], edge finite, EV finite
  11. KellyDecision is immutable (frozen dataclass)
  12. CLV-feedback dampening halves stake when z-score < -1

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m7_kelly.py
"""
from __future__ import annotations

import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import math

from v4.eval.metrics import IDENTITY_TOLERANCE
from v4.modules.m7_kelly import (
    DEFAULT_LIGA_TIERS,
    PROFILE_CAPS,
    TIER_EDGE_WINDOWS,
    KellyDecision,
    RobustBayesianKelly,
    get_edge_window,
)


class SanityCheckFailed(AssertionError):
    pass


def assert_close(actual: float, expected: float, tol: float = IDENTITY_TOLERANCE, msg: str = "") -> None:
    if abs(actual - expected) > tol:
        raise SanityCheckFailed(
            f"{msg}: expected {expected}, got {actual}, diff={abs(actual - expected):.2e}"
        )


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_1_vanilla_kelly_identity():
    """Classic Kelly: p=0.55, o=2.0 → edge=0.10, f_v=0.10."""
    kelly = RobustBayesianKelly(profile="M")
    # Use a Liga whose Goldilocks window includes 0.10. The default sharp
    # tier maxes at 0.05, so we need a custom config that doesn't trip the
    # gate — verify the pure math by inspecting the dataclass fields.
    d = kelly.stake(p_hat=0.55, odds=2.0, league="bundesliga")
    assert_close(d.edge, 0.10, msg="edge")
    assert_close(d.f_vanilla, 0.10, msg="f_vanilla")
    return f"edge={d.edge:.4f}, f_v={d.f_vanilla:.4f} ✓"


def test_2_vanilla_kelly_negative_edge():
    """p × o < 1 → no bet."""
    kelly = RobustBayesianKelly(profile="M")
    d = kelly.stake(p_hat=0.40, odds=2.0, league="bundesliga")
    if d.f_vanilla != 0:
        raise SanityCheckFailed(f"negative-edge f_v should be 0, got {d.f_vanilla}")
    if d.edge >= 0:
        raise SanityCheckFailed(f"edge should be negative, got {d.edge}")
    return f"edge={d.edge:.4f} (< 0), f_v={d.f_vanilla}"


def test_3_variance_shrinkage_zero_variance():
    """σ²=0 → shrinkage=1.0 (no shrinkage applied)."""
    kelly = RobustBayesianKelly(profile="M", alpha=1.0)
    factor = kelly.variance_shrinkage_factor(p_hat=0.51, sigma_sq=0.0)
    assert_close(factor, 1.0, msg="σ²=0 shrinkage")
    return f"σ²=0 → shrinkage={factor:.6f} (= 1.0)"


def test_4_variance_shrinkage_positive_variance():
    """σ²>0 → shrinkage<1.0."""
    kelly = RobustBayesianKelly(profile="M", alpha=1.0)
    factor = kelly.variance_shrinkage_factor(p_hat=0.51, sigma_sq=0.01)
    # shrinkage = 1 / (1 + 1.0 × 0.01 / 0.2601) = 1 / 1.0384 ≈ 0.9630
    if not (0.95 < factor < 0.98):
        raise SanityCheckFailed(f"expected shrinkage ~0.963, got {factor}")
    return f"σ²=0.01, p=0.51 → shrinkage={factor:.4f}"


def test_5_variance_shrinkage_extreme_variance():
    """σ² huge → shrinkage → 0."""
    kelly = RobustBayesianKelly(profile="M", alpha=1.0)
    factor = kelly.variance_shrinkage_factor(p_hat=0.5, sigma_sq=100.0)
    if not (0 <= factor < 0.01):
        raise SanityCheckFailed(f"extreme σ² should give tiny shrinkage, got {factor}")
    return f"σ²=100 → shrinkage={factor:.6f}"


def test_6_profile_cap_enforced():
    """f_robust never exceeds profile cap."""
    for profile, cap in PROFILE_CAPS.items():
        kelly = RobustBayesianKelly(profile=profile)
        # Pick edge inside Goldilocks window (use a soft-tier Liga = wider window)
        # austria_bl is soft (0.035, 0.085). edge=0.04 is within.
        # f_vanilla = 0.04 / (1.5-1.0) = 0.08 → above K(0.025) cap
        d = kelly.stake(p_hat=0.694, odds=1.5, league="austria_bl")
        if d.f_robust > cap + 1e-12:
            raise SanityCheckFailed(
                f"profile {profile}: f_robust {d.f_robust} > cap {cap}"
            )
        if d.edge_in_window and not d.cap_applied and d.f_robust < d.f_vanilla:
            raise SanityCheckFailed(
                f"profile {profile}: shrunk without cap_applied flag"
            )
    return f"all profiles K({PROFILE_CAPS['K']})/M({PROFILE_CAPS['M']})/A({PROFILE_CAPS['A']}) capped ✓"


def test_7_goldilocks_below_window():
    """edge below tier window → f_robust = 0."""
    kelly = RobustBayesianKelly(profile="M")
    # BL is sharp (0.015, 0.05). edge=0.01 is BELOW.
    d = kelly.stake(p_hat=0.505, odds=2.0, league="bundesliga")
    if d.edge >= 0.015:
        raise SanityCheckFailed(f"test setup wrong, edge {d.edge} should be < 0.015")
    if d.f_robust != 0:
        raise SanityCheckFailed(f"below-window f_robust should be 0, got {d.f_robust}")
    if d.edge_in_window:
        raise SanityCheckFailed("edge_in_window should be False")
    return f"edge={d.edge:.4f} < {d.edge_window[0]} → f_r=0 ✓"


def test_8_goldilocks_above_window():
    """edge above tier window → f_robust = 0."""
    kelly = RobustBayesianKelly(profile="M")
    # BL sharp window (0.015, 0.05). edge=0.10 is ABOVE.
    d = kelly.stake(p_hat=0.55, odds=2.0, league="bundesliga")
    if d.edge <= 0.05:
        raise SanityCheckFailed(f"test setup wrong, edge {d.edge} should be > 0.05")
    if d.f_robust != 0:
        raise SanityCheckFailed(f"above-window f_robust should be 0, got {d.f_robust}")
    return f"edge={d.edge:.4f} > {d.edge_window[1]} → f_r=0 ✓"


def test_9_goldilocks_in_window():
    """edge within tier window → f_robust > 0."""
    kelly = RobustBayesianKelly(profile="M")
    # BL sharp window (0.015, 0.05). edge=0.02 is INSIDE.
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    if not d.edge_in_window:
        raise SanityCheckFailed(
            f"edge={d.edge} should be in {d.edge_window}, but flag says not"
        )
    if d.f_robust <= 0:
        raise SanityCheckFailed(f"in-window f_robust should be > 0, got {d.f_robust}")
    return f"edge={d.edge:.4f} ∈ {d.edge_window} → f_r={d.f_robust:.4f}"


def test_10_output_invariants():
    """f_robust ∈ [0, cap], edge + EV finite, all over a random sample."""
    kelly = RobustBayesianKelly(profile="M")
    import numpy as np
    rng = np.random.default_rng(42)
    n_tested = 0
    for _ in range(200):
        p = float(rng.uniform(0.1, 0.9))
        o = float(rng.uniform(1.2, 10.0))
        sigma = float(rng.uniform(0.0, 0.5))
        league = list(DEFAULT_LIGA_TIERS.keys())[
            int(rng.integers(0, len(DEFAULT_LIGA_TIERS)))
        ]
        d = kelly.stake(p_hat=p, odds=o, league=league, sigma_sq=sigma)
        if not (0 <= d.f_robust <= PROFILE_CAPS["M"] + 1e-12):
            raise SanityCheckFailed(
                f"f_robust {d.f_robust} outside [0, {PROFILE_CAPS['M']}]"
            )
        if not math.isfinite(d.edge):
            raise SanityCheckFailed(f"edge non-finite: {d.edge}")
        if not math.isfinite(d.expected_value):
            raise SanityCheckFailed(f"EV non-finite: {d.expected_value}")
        n_tested += 1
    return f"{n_tested} random scenarios, all invariants held ✓"


def test_11_decision_immutable():
    """KellyDecision is frozen — attempts to mutate must raise."""
    kelly = RobustBayesianKelly(profile="M")
    d = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    try:
        d.f_robust = 0.99  # type: ignore[misc]
        raise SanityCheckFailed("should have raised FrozenInstanceError")
    except FrozenInstanceError:
        pass
    return "FrozenInstanceError raised on mutation ✓"


def test_12_clv_feedback_dampening():
    """When clv_feedback_fn returns z-score < -1, stake is halved."""
    # Configure a CLV-feedback function that returns -1.5 for bundesliga,
    # +0.5 elsewhere
    def mock_clv(league: str) -> float:
        return -1.5 if league == "bundesliga" else 0.5

    kelly = RobustBayesianKelly(
        profile="M",
        clv_feedback_fn=mock_clv,
        clv_dampening_zscore_threshold=-1.0,
        clv_dampening_factor=0.5,
    )

    # Same in-window match: BL (should dampen) vs serie_a (should not)
    d_bl = kelly.stake(p_hat=0.51, odds=2.0, league="bundesliga")
    d_sa = kelly.stake(p_hat=0.51, odds=2.0, league="serie_a")

    if not d_bl.clv_dampened:
        raise SanityCheckFailed("BL with z=-1.5 should be dampened")
    if d_sa.clv_dampened:
        raise SanityCheckFailed("serie_a with z=+0.5 should NOT be dampened")
    # Stake should be exactly half what serie_a got (same setup otherwise)
    expected_bl = d_sa.f_robust * 0.5
    assert_close(d_bl.f_robust, expected_bl, msg="dampened stake")
    return (
        f"BL dampened f={d_bl.f_robust:.4f} = 0.5 × serie_a f={d_sa.f_robust:.4f} ✓"
    )


# ─────────────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────────────


TESTS = [
    ("[1]  Vanilla Kelly identity (p=0.55, o=2.0)", test_1_vanilla_kelly_identity),
    ("[2]  Vanilla Kelly: negative edge → f=0", test_2_vanilla_kelly_negative_edge),
    ("[3]  Variance shrinkage: σ²=0 → 1.0", test_3_variance_shrinkage_zero_variance),
    ("[4]  Variance shrinkage: σ²>0 → <1.0", test_4_variance_shrinkage_positive_variance),
    ("[5]  Variance shrinkage: σ²→∞ → 0", test_5_variance_shrinkage_extreme_variance),
    ("[6]  Profile cap (K/M/A) enforced", test_6_profile_cap_enforced),
    ("[7]  Goldilocks: edge below window", test_7_goldilocks_below_window),
    ("[8]  Goldilocks: edge above window", test_8_goldilocks_above_window),
    ("[9]  Goldilocks: edge in window", test_9_goldilocks_in_window),
    ("[10] Output invariants (200 random)", test_10_output_invariants),
    ("[11] KellyDecision immutable", test_11_decision_immutable),
    ("[12] CLV-feedback dampening", test_12_clv_feedback_dampening),
]


def main() -> int:
    print("=" * 70)
    print("V4 m7_kelly — Stage 1 Sanity Checks")
    print("=" * 70)

    n_pass = 0
    n_fail = 0
    failures = []

    for label, test_fn in TESTS:
        try:
            note = test_fn()
            print(f"  ✓ {label:48} {note}")
            n_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:48} FAILED: {e}")
            failures.append((label, str(e)))
            n_fail += 1
        except Exception as e:
            print(f"  ✗ {label:48} CRASH: {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            n_fail += 1

    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{len(TESTS)} TESTS PASSED")
        print("  → m7_kelly Stage 1 cleared. Next: Stage 5 (CLV bankroll simulation).")
    else:
        print(f"✗ {n_fail}/{len(TESTS)} TESTS FAILED")
        for label, err in failures:
            print(f"    {label}: {err}")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

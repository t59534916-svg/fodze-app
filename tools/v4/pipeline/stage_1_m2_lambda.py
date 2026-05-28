"""
Stage 1.m2_lambda — Math + no-leakage + reasonableness gate for LambdaEstimator.

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m2_lambda.py

Tests (12 total — all must pass before m3_xg sprint):
  1.  Empty history → fallback to league defaults
  2.  Insufficient history (n < min_team_matches) → fallback used
  3.  Sufficient history → EWMA path activates
  4.  λ always in [LAMBDA_MIN, LAMBDA_MAX] (clamping invariant)
  5.  λ outputs are finite (no NaN/inf)
  6.  No future leakage — synthetic poisoned-row test
  7.  Determinism — same inputs → identical outputs across calls
  8.  Stronger-attack team gets higher attack_ratio
  9.  Team-swap inverts λ_h, λ_a (commutativity check)
  10. Home advantage signal — λ_h > λ_a in symmetric setup
  11. Form factor stays in [0.85, 1.15] when enabled
  12. Real Bundesliga 25/26 cohort: 90%+ of λ in [0.5, 3.5] reasonable range
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.eval.metrics import IDENTITY_TOLERANCE
from v4.modules.m2_lambda import (
    LAMBDA_MAX,
    LAMBDA_MIN,
    LambdaEstimator,
    compute_league_constants,
)


class SanityCheckFailed(AssertionError):
    pass


# ─────────────────────────────────────────────────────────────────────
# Synthetic-history helpers (for leakage + determinism tests)
# ─────────────────────────────────────────────────────────────────────


def _make_synthetic_history(
    team: str,
    league: str,
    n_matches: int,
    *,
    start_date: datetime = datetime(2025, 8, 1),
    xg_for: float = 1.5,
    xg_against: float = 1.2,
) -> pd.DataFrame:
    """Build a synthetic history block with deterministic values."""
    rows = []
    for i in range(n_matches):
        # Alternate home/away — realistic ratio
        venue = "home" if i % 2 == 0 else "away"
        opp = f"Opponent_{i}"
        # Slight jitter to avoid pure-equal-values pathologies
        rows.append({
            "team": team, "league": league, "opponent": opp,
            "venue": venue,
            "match_date": start_date + timedelta(days=7 * i),
            "xg": xg_for + 0.01 * (i % 3),
            "xga": xg_against + 0.01 * (i % 2),
            "goals_for": int(xg_for),
            "goals_against": int(xg_against),
            "source": "synthetic",
        })
    return pd.DataFrame(rows)


def _pair_synthetic_history(
    team_a: str, team_b: str, league: str, n_matches: int,
    xg_a: float = 1.6, xga_a: float = 1.1,
    xg_b: float = 1.3, xga_b: float = 1.4,
) -> pd.DataFrame:
    """Build history for two teams with mirrored opponents."""
    a = _make_synthetic_history(team_a, league, n_matches, xg_for=xg_a, xg_against=xga_a)
    b = _make_synthetic_history(team_b, league, n_matches, xg_for=xg_b, xg_against=xga_b)
    # Shift team_b dates so they don't collide
    b["match_date"] = b["match_date"] + timedelta(days=2)
    return pd.concat([a, b], ignore_index=True)


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────


def test_1_empty_history_fallback():
    history = pd.DataFrame(columns=["team", "league", "opponent", "venue",
                                     "match_date", "xg", "xga", "goals_for",
                                     "goals_against", "source"])
    history["match_date"] = pd.to_datetime(history["match_date"])
    est = LambdaEstimator()
    features = est.compute_features(
        home_team="A", away_team="B", league="bundesliga",
        match_date=datetime(2026, 1, 1), history=history,
    )
    if not features["home_fallback_used"]:
        raise SanityCheckFailed("empty history must trigger home fallback")
    if not features["away_fallback_used"]:
        raise SanityCheckFailed("empty history must trigger away fallback")
    return f"λ_h={features['lambda_h']:.2f}, λ_a={features['lambda_a']:.2f} (both fallback)"


def test_2_insufficient_history_fallback():
    # Only 2 matches per team → below min_team_matches=4 default
    history = _pair_synthetic_history("TeamA", "TeamB", "bundesliga", n_matches=2)
    est = LambdaEstimator()
    features = est.compute_features(
        home_team="TeamA", away_team="TeamB", league="bundesliga",
        match_date=datetime(2026, 1, 1), history=history,
    )
    if not features["home_fallback_used"]:
        raise SanityCheckFailed(f"n=2 should trigger fallback, didn't")
    return f"home_n={features['home_n_matches']}, fallback fired ✓"


def test_3_sufficient_history_uses_ewma():
    history = _pair_synthetic_history("TeamA", "TeamB", "bundesliga", n_matches=20)
    est = LambdaEstimator()
    features = est.compute_features(
        home_team="TeamA", away_team="TeamB", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    if features["home_fallback_used"]:
        raise SanityCheckFailed("n=20 should NOT trigger fallback")
    if features["home_ess"] < 4:
        raise SanityCheckFailed(f"ESS too low: {features['home_ess']:.2f}")
    return f"home_n={features['home_n_matches']}, ESS={features['home_ess']:.1f}"


def test_4_lambda_clamping_invariant():
    """λ outputs must always be in [LAMBDA_MIN, LAMBDA_MAX]."""
    # Build adversarial history: very strong attack + very weak defense
    extreme = _make_synthetic_history(
        "Monster", "bundesliga", 20, xg_for=5.0, xg_against=0.1,
    )
    weak = _make_synthetic_history(
        "Doormat", "bundesliga", 20, xg_for=0.2, xg_against=4.5,
    )
    history = pd.concat([extreme, weak], ignore_index=True)
    est = LambdaEstimator()
    features = est.compute_features(
        home_team="Monster", away_team="Doormat", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    if not (LAMBDA_MIN <= features["lambda_h"] <= LAMBDA_MAX):
        raise SanityCheckFailed(f"λ_h={features['lambda_h']} outside [{LAMBDA_MIN}, {LAMBDA_MAX}]")
    if not (LAMBDA_MIN <= features["lambda_a"] <= LAMBDA_MAX):
        raise SanityCheckFailed(f"λ_a={features['lambda_a']} outside [{LAMBDA_MIN}, {LAMBDA_MAX}]")
    return f"λ_h={features['lambda_h']:.2f} (clamped={features['lambda_h_was_clamped']}), λ_a={features['lambda_a']:.2f}"


def test_5_lambda_finite():
    """No NaN, no inf, never."""
    # Pathological case: team with all-NaN xG
    history = _pair_synthetic_history("TA", "TB", "bundesliga", 10)
    history.loc[history["team"] == "TA", "xg"] = np.nan
    est = LambdaEstimator()
    features = est.compute_features(
        home_team="TA", away_team="TB", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    if not np.isfinite(features["lambda_h"]):
        raise SanityCheckFailed(f"λ_h not finite: {features['lambda_h']}")
    if not np.isfinite(features["lambda_a"]):
        raise SanityCheckFailed(f"λ_a not finite: {features['lambda_a']}")
    return f"NaN-xg input → λ_h={features['lambda_h']:.2f}, λ_a={features['lambda_a']:.2f} (finite ✓)"


def test_6_no_future_leakage():
    """Insert a POISON row dated AFTER as_of. Estimator must ignore it."""
    history = _pair_synthetic_history("TA", "TB", "bundesliga", 20)
    est = LambdaEstimator()
    as_of = datetime(2026, 3, 1)

    # Baseline (no poison)
    baseline = est.compute_features(
        home_team="TA", away_team="TB", league="bundesliga",
        match_date=as_of, history=history,
    )

    # Add an extreme future-dated row for TA — would massively shift EWMA if leaked
    poison = pd.DataFrame([{
        "team": "TA", "league": "bundesliga", "opponent": "Future_Opp",
        "venue": "home",
        "match_date": as_of + timedelta(days=14),  # AFTER as_of
        "xg": 10.0, "xga": 0.0,
        "goals_for": 10, "goals_against": 0,
        "source": "POISON",
    }])
    poisoned_history = pd.concat([history, poison], ignore_index=True)

    poisoned_features = est.compute_features(
        home_team="TA", away_team="TB", league="bundesliga",
        match_date=as_of, history=poisoned_history,
    )

    # If leakage happened, λ_h would change drastically.
    # Use IDENTITY_TOLERANCE (1e-9): for a leakage-free run delta should be
    # exactly 0 modulo IEEE drift on float64. Any δ > 1e-9 means real contamination.
    delta = abs(poisoned_features["lambda_h"] - baseline["lambda_h"])
    if delta > IDENTITY_TOLERANCE:
        raise SanityCheckFailed(
            f"FUTURE LEAKAGE: baseline λ_h={baseline['lambda_h']:.4f}, "
            f"poisoned λ_h={poisoned_features['lambda_h']:.4f}, Δ={delta:.4f}"
        )
    return f"baseline = poisoned (Δ={delta:.2e}) ✓ no leakage"


def test_7_determinism():
    """Same inputs → identical outputs across multiple calls."""
    history = _pair_synthetic_history("TA", "TB", "bundesliga", 20)
    est = LambdaEstimator()
    results = [
        est.estimate(
            home_team="TA", away_team="TB", league="bundesliga",
            match_date=datetime(2026, 6, 1), history=history,
        )
        for _ in range(3)
    ]
    if not all(r == results[0] for r in results):
        raise SanityCheckFailed(f"non-deterministic: {results}")
    return f"3/3 calls returned λ=({results[0][0]:.3f}, {results[0][1]:.3f})"


def test_8_stronger_attack_higher_ratio():
    """Team with higher xG history → higher attack_ratio."""
    strong = _make_synthetic_history("Strong", "bundesliga", 20, xg_for=2.5, xg_against=1.0)
    weak = _make_synthetic_history("Weak", "bundesliga", 20, xg_for=0.8, xg_against=1.5)
    history = pd.concat([strong, weak], ignore_index=True)

    est = LambdaEstimator()
    f_strong_home = est.compute_features(
        home_team="Strong", away_team="Weak", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    f_weak_home = est.compute_features(
        home_team="Weak", away_team="Strong", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    if not (f_strong_home["home_attack_ratio"] > f_weak_home["home_attack_ratio"]):
        raise SanityCheckFailed(
            f"Strong attack_ratio={f_strong_home['home_attack_ratio']:.3f} "
            f"not > Weak attack_ratio={f_weak_home['home_attack_ratio']:.3f}"
        )
    return (
        f"Strong attack={f_strong_home['home_attack_ratio']:.2f} > "
        f"Weak attack={f_weak_home['home_attack_ratio']:.2f}"
    )


def test_9_team_swap_inversion():
    """Swap home↔away: home_attack_ratio should swap with away_attack_ratio (modulo league constants)."""
    history = _pair_synthetic_history(
        "TA", "TB", "bundesliga", n_matches=20,
        xg_a=2.0, xga_a=1.0, xg_b=1.0, xga_b=2.0,
    )
    est = LambdaEstimator()
    f_AB = est.compute_features(
        home_team="TA", away_team="TB", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    f_BA = est.compute_features(
        home_team="TB", away_team="TA", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    # When swapped, TA's attack becomes the away_attack. Same float64
    # computation, so IDENTITY_TOLERANCE applies.
    if abs(f_AB["home_attack_ratio"] - f_BA["away_attack_ratio"]) > IDENTITY_TOLERANCE:
        raise SanityCheckFailed(
            f"swap broke attack_ratio: AB.home={f_AB['home_attack_ratio']:.4f}, "
            f"BA.away={f_BA['away_attack_ratio']:.4f}"
        )
    return f"swap consistent: TA attack {f_AB['home_attack_ratio']:.3f} preserved across positions"


def test_10_home_advantage_signal():
    """Two symmetric teams → λ_h > λ_a (home advantage from league constants).

    Important: extras must be WITHIN the 540-day lookback window relative to the
    test's `as_of` date. We use as_of=2026-06-01 and extras starting 2025-01-01
    (~17 months back, well inside the 540-day window).
    """
    # Build matched-strength teams (40 rows, dates 2025-08-01 + 7*i days)
    history = _pair_synthetic_history("TA", "TB", "bundesliga", n_matches=20,
                                       xg_a=1.5, xga_a=1.5, xg_b=1.5, xga_b=1.5)
    # Add league-context rows: 30 home @ 1.7 xG + 30 away @ 1.3 xG, within lookback
    extra_rows = []
    extras_start = datetime(2025, 1, 1)
    for i in range(60):
        is_home = i < 30
        extra_rows.append({
            "team": f"Team_X{i}", "league": "bundesliga", "opponent": f"Team_Y{i}",
            "venue": "home" if is_home else "away",
            "match_date": extras_start + timedelta(days=i*3),
            "xg": 1.7 if is_home else 1.3, "xga": 1.3 if is_home else 1.7,
            "goals_for": 2 if is_home else 1, "goals_against": 1 if is_home else 2,
            "source": "synthetic",
        })
    history = pd.concat([history, pd.DataFrame(extra_rows)], ignore_index=True)

    est = LambdaEstimator()
    features = est.compute_features(
        home_team="TA", away_team="TB", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=history,
    )
    # Sanity: league constants should reflect the +0.4 home-adv we baked in
    if features["league_constants_source"] != "computed":
        raise SanityCheckFailed(
            f"league constants didn't compute: source={features['league_constants_source']}"
        )
    if features["league_home_advantage"] < 0.10:
        raise SanityCheckFailed(
            f"home advantage too low: {features['league_home_advantage']:.3f} "
            "(expected >0.10 given synthetic +0.4 setup)"
        )
    if features["lambda_h"] <= features["lambda_a"]:
        raise SanityCheckFailed(
            f"home advantage missing: λ_h={features['lambda_h']:.3f}, "
            f"λ_a={features['lambda_a']:.3f}, home_adv={features['league_home_advantage']:.3f}"
        )
    return (
        f"λ_h={features['lambda_h']:.2f} > λ_a={features['lambda_a']:.2f} "
        f"(Δ={features['lambda_h'] - features['lambda_a']:+.2f}, "
        f"league_adv=+{features['league_home_advantage']:.2f})"
    )


def test_11_form_factor_clamping():
    """When apply_form_factor=True, factor stays in [0.85, 1.15] even with extreme history."""
    history = _make_synthetic_history("Boom", "bundesliga", 20, xg_for=2.0, xg_against=1.0)
    # Make the LAST 4 matches extremely high to inflate form
    history.loc[history.index[-4:], "xg"] = 10.0
    # Need an opponent
    history2 = _make_synthetic_history("Bust", "bundesliga", 20, xg_for=1.0, xg_against=1.5)
    full = pd.concat([history, history2], ignore_index=True)

    est = LambdaEstimator(apply_form_factor=True)
    features = est.compute_features(
        home_team="Boom", away_team="Bust", league="bundesliga",
        match_date=datetime(2026, 6, 1), history=full,
    )
    if not (0.85 <= features["home_form_factor"] <= 1.15):
        raise SanityCheckFailed(
            f"form_factor outside [0.85, 1.15]: {features['home_form_factor']:.3f}"
        )
    return f"form_factor={features['home_form_factor']:.3f} (clamped to [0.85, 1.15])"


def test_12_real_bundesliga_cohort_reasonable():
    """Real-data sanity: λ outputs on BL 25/26 should be predominantly in [0.5, 3.5]."""
    history = load_team_xg_history(leagues=["bundesliga"])
    # Pick all home rows from Jan 2026 onward as test cohort
    matches = history[
        (history["venue"] == "home")
        & (history["match_date"] >= "2026-01-01")
        & (history["match_date"] < "2026-05-01")
    ].copy()

    if len(matches) < 30:
        raise SanityCheckFailed(f"insufficient real-data test cohort: {len(matches)}")

    est = LambdaEstimator()
    lambdas_h = []
    lambdas_a = []
    league_constants = compute_league_constants(
        history, league="bundesliga", before_date=datetime(2026, 1, 1)
    )
    for _, row in matches.head(80).iterrows():
        features = est.compute_features(
            home_team=row["team"], away_team=row["opponent"],
            league="bundesliga", match_date=row["match_date"].to_pydatetime(),
            history=history, league_constants=league_constants,
        )
        lambdas_h.append(features["lambda_h"])
        lambdas_a.append(features["lambda_a"])

    arr_h = np.array(lambdas_h)
    arr_a = np.array(lambdas_a)
    in_range_h = ((arr_h >= 0.5) & (arr_h <= 3.5)).mean()
    in_range_a = ((arr_a >= 0.5) & (arr_a <= 3.5)).mean()
    if in_range_h < 0.90:
        raise SanityCheckFailed(f"only {in_range_h:.1%} of λ_h in [0.5, 3.5]")
    if in_range_a < 0.90:
        raise SanityCheckFailed(f"only {in_range_a:.1%} of λ_a in [0.5, 3.5]")
    avg_h = float(arr_h.mean())
    avg_a = float(arr_a.mean())
    return (
        f"n={len(arr_h)} BL matches · "
        f"λ_h: avg={avg_h:.2f}, in_range={in_range_h:.0%} · "
        f"λ_a: avg={avg_a:.2f}, in_range={in_range_a:.0%} · "
        f"home-adv={avg_h - avg_a:+.2f}"
    )


# ─────────────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────────────


TESTS = [
    ("[1]  Empty history → fallback", test_1_empty_history_fallback),
    ("[2]  Insufficient history → fallback", test_2_insufficient_history_fallback),
    ("[3]  Sufficient history → EWMA", test_3_sufficient_history_uses_ewma),
    ("[4]  λ clamping invariant", test_4_lambda_clamping_invariant),
    ("[5]  λ outputs finite (NaN-input)", test_5_lambda_finite),
    ("[6]  No future leakage (poisoned row)", test_6_no_future_leakage),
    ("[7]  Determinism (3× calls)", test_7_determinism),
    ("[8]  Stronger attack → higher ratio", test_8_stronger_attack_higher_ratio),
    ("[9]  Team-swap inversion", test_9_team_swap_inversion),
    ("[10] Home advantage signal", test_10_home_advantage_signal),
    ("[11] Form factor clamping [0.85, 1.15]", test_11_form_factor_clamping),
    ("[12] Real BL 25/26 cohort reasonable", test_12_real_bundesliga_cohort_reasonable),
]


def main() -> int:
    print("=" * 70)
    print("V4 m2_lambda — Stage 1 Sanity Checks")
    print("=" * 70)

    n_pass = 0
    n_fail = 0
    failures = []

    for label, test_fn in TESTS:
        try:
            note = test_fn()
            print(f"  ✓ {label:42} {note}")
            n_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:42} FAILED: {e}")
            failures.append((label, str(e)))
            n_fail += 1
        except Exception as e:
            print(f"  ✗ {label:42} CRASH: {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            n_fail += 1

    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{len(TESTS)} TESTS PASSED")
        print("  → m2_lambda Stage 1 gate cleared. Ready for m3_xg sprint.")
    else:
        print(f"✗ {n_fail}/{len(TESTS)} TESTS FAILED")
        for label, err in failures:
            print(f"    {label}: {err}")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

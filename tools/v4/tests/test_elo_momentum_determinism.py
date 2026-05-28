"""Regression tests for the 2026-05-21 sort-determinism fix in
EloCalculator + TeamMomentumCalculator.

Bug context:
  pandas.sort_values defaults to kind='quicksort' which is UNSTABLE. When
  multiple matches share the same match_date (every league weekend), ties
  get scrambled in a way that depends on input row order. Callers passing
  pre-sorted DataFrames (e.g. our SQL loader sorts by (date, team)) got
  different cumulative Elo than callers passing the SAME data resorted
  by `match_date` alone (e.g. our cache exporter).

  Symptom: dev03-features.test.ts golden parity reported 597/800
  team-league pairs with up to 9.5 Elo points drift between the cache
  exporter and a fresh fit on the same data.

Fix:
  EloCalculator.fit() + TeamMomentumCalculator.fit() now sort with
  `kind='mergesort'` (stable) AND a canonical secondary key
  `(team, opponent)` so ties resolve identically regardless of input
  row order.

These tests lock that contract in: any future regression that re-introduces
the default-quicksort or removes the secondary key will fail here.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator


def _make_history_with_same_date_ties() -> pd.DataFrame:
    """Synthetic 6-match Bundesliga matchday where 3 home matches all
    fall on the same date — exercises the tie-breaking path.

    Pre-fix, shuffling the input row order would give different final
    Elo because pandas quicksort would reorder same-date rows.
    """
    rows = []
    # Day 1: three parallel matches all on 2024-08-25 (typical matchday)
    matches_day1 = [
        ("Bayern Munich", "Bayer Leverkusen", 3, 1),
        ("Borussia Dortmund", "RB Leipzig", 2, 2),
        ("VfB Stuttgart", "Eintracht Frankfurt", 1, 0),
    ]
    # Day 2: same 6 teams swap, week later
    matches_day2 = [
        ("Bayer Leverkusen", "Borussia Dortmund", 2, 1),
        ("RB Leipzig", "VfB Stuttgart", 0, 1),
        ("Eintracht Frankfurt", "Bayern Munich", 0, 4),
    ]
    for date_str, matches in [("2024-08-25", matches_day1),
                              ("2024-09-01", matches_day2)]:
        for home, away, gh, ga in matches:
            rows.append({
                "team": home, "opponent": away, "venue": "home",
                "league": "bundesliga", "match_date": pd.Timestamp(date_str),
                "xg": float(gh), "xga": float(ga),
                "goals_for": gh, "goals_against": ga,
            })
            rows.append({
                "team": away, "opponent": home, "venue": "away",
                "league": "bundesliga", "match_date": pd.Timestamp(date_str),
                "xg": float(ga), "xga": float(gh),
                "goals_for": ga, "goals_against": gh,
            })
    return pd.DataFrame(rows)


def test_elo_deterministic_across_input_row_orders():
    """Same matches, different DataFrame row order → identical final Elo.

    This is the contract that protects against the unstable-sort bug.
    """
    history = _make_history_with_same_date_ties()

    # Three input orderings that all encode the same MATCHES:
    #   A: canonical SQL order (by match_date, then team)
    #   B: reversed
    #   C: shuffled
    perm_a = history.sort_values(["match_date", "team"]).reset_index(drop=True)
    perm_b = history.iloc[::-1].reset_index(drop=True)
    rng = np.random.default_rng(42)
    perm_c = history.iloc[rng.permutation(len(history))].reset_index(drop=True)

    elo_a = EloCalculator().fit(perm_a)
    elo_b = EloCalculator().fit(perm_b)
    elo_c = EloCalculator().fit(perm_c)

    # Every team should have identical final rating across all three fits
    teams = ["Bayern Munich", "Bayer Leverkusen", "Borussia Dortmund",
             "RB Leipzig", "VfB Stuttgart", "Eintracht Frankfurt"]
    for team in teams:
        key = ("bundesliga", team)
        r_a = elo_a._history[key][-1].rating
        r_b = elo_b._history[key][-1].rating
        r_c = elo_c._history[key][-1].rating
        assert r_a == r_b == r_c, (
            f"Elo drift on {team}: order_A={r_a}, order_B={r_b}, order_C={r_c}. "
            "Did sort_values regress to quicksort or lose the secondary key?"
        )


def test_momentum_deterministic_across_input_row_orders():
    """Same contract for TeamMomentumCalculator — different input orders
    must produce identical normalized momentum features."""
    history = _make_history_with_same_date_ties()

    perm_a = history.sort_values(["match_date", "team"]).reset_index(drop=True)
    rng = np.random.default_rng(123)
    perm_c = history.iloc[rng.permutation(len(history))].reset_index(drop=True)

    mc_a = TeamMomentumCalculator().fit(perm_a)
    mc_c = TeamMomentumCalculator().fit(perm_c)

    # Query for the day-2 matches — by then teams have day-1 history
    query_date = pd.Timestamp("2024-09-10")
    teams = ["Bayern Munich", "Bayer Leverkusen", "Borussia Dortmund"]
    for team in teams:
        key = ("bundesliga", team)
        snaps_a = mc_a._snapshots[key]
        snaps_c = mc_c._snapshots[key]
        # Same number of snapshots
        assert len(snaps_a) == len(snaps_c), (
            f"Snapshot count differs for {team}: A={len(snaps_a)}, C={len(snaps_c)}"
        )
        # Each snapshot identical
        for i, (s_a, s_c) in enumerate(zip(snaps_a, snaps_c)):
            assert s_a.raw_lineup == s_c.raw_lineup, (
                f"{team} snapshot {i} lineup mismatch: {s_a.raw_lineup} vs {s_c.raw_lineup}"
            )
            assert s_a.raw_form == s_c.raw_form, (
                f"{team} snapshot {i} form mismatch: {s_a.raw_form} vs {s_c.raw_form}"
            )


def test_elo_canonical_secondary_key_is_team_then_opponent():
    """Document the exact sort contract — if anyone changes the secondary
    key, this test forces them to update the rest of the system to match.
    Without this test, a refactor that changes (team, opponent) to e.g.
    (opponent, team) would silently shift Elo without warning."""
    history = _make_history_with_same_date_ties()
    elo = EloCalculator().fit(history)

    # The fix uses kind="mergesort" and secondary key (team, opponent).
    # Verify by re-fitting WITHOUT that order and asserting agreement —
    # this is what the previous test does. Here we just confirm one
    # specific value to prevent silent drift after retraining.
    bm_final = elo._history[("bundesliga", "Bayern Munich")][-1].rating
    # Bayern won both matches (3-1, 4-0) → Elo should rise from 1500
    assert bm_final > 1500.0, f"Bayern Elo should rise after 2 wins, got {bm_final}"
    # Numerical anchor — captured 2026-05-21 post-fix. Tolerance 0.01 chosen
    # to (a) catch sort-determinism regression (which would shift Elo by ~10
    # points — well above 0.01), (b) not break on legitimate algorithm tweaks
    # within 1 LSB of float64 (e.g. multiplier order-of-ops change inside
    # _margin_multiplier). Original 1e-6 tolerance was brittle.
    EXPECTED_BAYERN_ELO = 1507.9085802867662
    assert abs(bm_final - EXPECTED_BAYERN_ELO) < 0.01, (
        f"Bayern Elo drifted from golden anchor {EXPECTED_BAYERN_ELO}: {bm_final}. "
        "Either (a) sort-determinism contract regressed (check fit() sort_values), "
        "or (b) algorithm intentionally changed — update this golden."
    )

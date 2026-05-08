#!/usr/bin/env python3
"""
FODZE — Stand-alone smoke test for load_extras_to_supabase.py mappings.

Tests the pure projection functions (project_match_stats,
project_player_stats, project_incidents, project_avg_positions)
against a hand-crafted fixture that mirrors real Sofascore JSON.

Why no pytest: the repo has no Python test infrastructure (only vitest
for JS/TS). This is a self-contained script — runnable any time:

  /Users/vonlinck/Desktop/fodze-app-master/tools/venv/bin/python3 \\
    tools/sofascore/test_load_extras.py

Exits with status 0 on pass, 1 on first failure (non-zero so CI can hook).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Stub Supabase env so import doesn't hard-exit
os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://stub")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "stub")

sys.path.insert(0, str(Path(__file__).parent))

from load_extras_to_supabase import (  # noqa: E402
    project_match_stats,
    project_player_stats,
    project_incidents,
    project_avg_positions,
)

# ─── Failures collector (run all assertions, report all at end) ───────

_failures: list[str] = []


def check(condition: bool, msg: str) -> None:
    if not condition:
        _failures.append(msg)


def eq(actual, expected, label: str) -> None:
    if actual != expected:
        _failures.append(f"{label}: expected {expected!r}, got {actual!r}")


# ─── Fixture: minimal but realistic Sofascore-shape JSON ───────────

STATISTICS_FIXTURE = {
    "statistics": [
        {
            "period": "ALL",
            "groups": [
                {
                    "groupName": "Match overview",
                    "statisticsItems": [
                        {"name": "Ball possession", "home": "52%", "away": "48%"},
                        {"name": "Expected goals", "home": "0.84", "away": "2.54"},
                        {"name": "Big chances", "home": "3", "away": "5"},
                        {"name": "Total shots", "home": "10", "away": "17"},
                        {"name": "Goalkeeper saves", "home": "3", "away": "1"},
                        {"name": "Corner kicks", "home": "7", "away": "7"},
                        {"name": "Fouls", "home": "10", "away": "8"},
                        {"name": "Passes", "home": "494", "away": "465"},
                        {"name": "Yellow cards", "home": "3", "away": "1"},
                    ],
                },
                {
                    "groupName": "Passes",
                    "statisticsItems": [
                        {"name": "Accurate passes", "home": "413", "away": "379"},
                        {"name": "Long balls", "home": "27/56 (48%)", "away": "25/66 (38%)"},
                        {"name": "Crosses", "home": "6/22 (27%)", "away": "4/11 (36%)"},
                    ],
                },
                {
                    "groupName": "Defending",
                    "statisticsItems": [
                        {"name": "Tackles won", "home": "80%", "away": "67%"},
                        {"name": "Total tackles", "home": "15", "away": "15"},
                        {"name": "Errors lead to a shot", "home": "1", "away": "0"},
                        {"name": "Errors lead to a goal", "home": "1", "away": "0"},
                    ],
                },
                {
                    "groupName": "Duels",
                    "statisticsItems": [
                        {"name": "Duels", "home": "46%", "away": "54%"},
                        {"name": "Ground duels", "home": "28/60 (47%)", "away": "32/60 (53%)"},
                        {"name": "Aerial duels", "home": "18/41 (44%)", "away": "23/41 (56%)"},
                        {"name": "Dribbles", "home": "6/13 (46%)", "away": "7/14 (50%)"},
                    ],
                },
                {
                    "groupName": "Goalkeeping",
                    "statisticsItems": [
                        {"name": "Goals prevented", "home": "-0.05", "away": "-0.65"},
                    ],
                },
            ],
        },
        # Skipping 1ST/2ND for brevity — function should still produce 2 rows × 1 period
    ]
}

LINEUPS_FIXTURE = {
    "confirmed": True,
    "home": {
        "formation": "4-3-3",
        "players": [
            {
                "player": {"id": 1001, "name": "Test Keeper", "position": "G"},
                "teamId": 100,
                "shirtNumber": 1,
                "position": "G",
                "substitute": False,
                "captain": True,
                "statistics": {
                    "rating": 7.2,
                    "minutesPlayed": 90,
                    "saves": 3,
                    "savedShotsFromInsideTheBox": 2,
                    "totalPass": 32,
                    "accuratePass": 28,
                },
            },
            {
                "player": {"id": 1002, "name": "Test Striker", "position": "F"},
                "teamId": 100,
                "shirtNumber": 9,
                "position": "F",
                "substitute": False,
                "statistics": {
                    "rating": 8.1,
                    "minutesPlayed": 90,
                    "goals": 1,
                    "goalAssist": 1,
                    "expectedGoals": 0.45,
                    "expectedAssists": 0.30,
                    "totalScoringAttempt": 4,
                    "onTargetScoringAttempt": 2,
                    "totalPass": 22,
                    "accuratePass": 18,
                    "duelWon": 5,
                    "duelLost": 4,
                },
            },
        ],
    },
    "away": {"players": []},
}

INCIDENTS_FIXTURE = {
    "incidents": [
        # Sofascore returns reverse-chrono — FT first
        {"incidentType": "period", "text": "FT", "homeScore": 1, "awayScore": 2, "time": 90},
        {
            "incidentType": "goal", "incidentClass": "regular",
            "time": 87, "isHome": True, "homeScore": 1, "awayScore": 2,
            "player": {"id": 2001, "name": "Late Sub"},
        },
        {
            "incidentType": "card", "incidentClass": "yellow",
            "reason": "Foul",
            "time": 75, "isHome": False,
            "player": {"id": 2002, "name": "Defender"},
        },
        {
            "incidentType": "substitution",
            "time": 60, "isHome": True,
            "playerIn": {"id": 2001, "name": "Late Sub"},
            "playerOut": {"id": 2003, "name": "Tired Forward"},
        },
        {
            "incidentType": "goal", "incidentClass": "regular",
            "time": 40, "isHome": False, "homeScore": 0, "awayScore": 2,
            "player": {"id": 2004, "name": "Away Striker"},
        },
        {
            "incidentType": "goal", "incidentClass": "regular",
            "time": 6, "isHome": False, "homeScore": 0, "awayScore": 1,
            "player": {"id": 2004, "name": "Away Striker"},
        },
    ]
}

AVG_POS_FIXTURE = {
    "home": [
        {"player": {"id": 1001, "name": "Test Keeper"}, "averageX": 12.5, "averageY": 50.0, "pointsCount": 87},
        {"player": {"id": 1002, "name": "Test Striker"}, "averageX": 71.6, "averageY": 32.4, "pointsCount": 90},
    ],
    "away": [
        {"player": {"id": 2004, "name": "Away Striker"}, "averageX": 68.5, "averageY": 36.9, "pointsCount": 95},
    ],
    "substitutions": [],
}


# ─── Tests ────────────────────────────────────────────────────────

def test_match_stats() -> None:
    rows = project_match_stats(STATISTICS_FIXTURE, game_id=999)
    eq(len(rows), 2, "match_stats: row count for 1 period × 2 sides")

    home = next((r for r in rows if r["is_home"] and r["period"] == "ALL"), None)
    away = next((r for r in rows if not r["is_home"] and r["period"] == "ALL"), None)
    check(home is not None, "match_stats: home/ALL row exists")
    check(away is not None, "match_stats: away/ALL row exists")

    if home is None or away is None:
        return

    # Simple parsers
    eq(home["ball_possession_pct"], 52.0, "match_stats: home ball_possession_pct")
    eq(home["expected_goals"], 0.84, "match_stats: home expected_goals")
    eq(home["big_chances"], 3, "match_stats: home big_chances")
    eq(home["total_shots"], 10, "match_stats: home total_shots")
    eq(home["fouls"], 10, "match_stats: home fouls")
    eq(home["yellow_cards"], 3, "match_stats: home yellow_cards")
    eq(home["passes_total"], 494, "match_stats: home passes_total (simple)")
    eq(home["passes_accurate"], 413, "match_stats: home passes_accurate (simple)")
    eq(home["pass_accuracy_pct"], 83.6, "match_stats: home pass_accuracy_pct (derived)")

    # Tackles: total + win-pct → derived tackles_won
    eq(home["tackles_total"], 15, "match_stats: home tackles_total")
    eq(home["tackles_won"], 12, "match_stats: home tackles_won (15 × 80%)")
    eq(away["tackles_won"], 10, "match_stats: away tackles_won (15 × 67%)")

    # Errors_lead_to_* — Sofascore now uses 'a shot'/'a goal' (with article)
    eq(home["errors_lead_to_shot"], 1, "match_stats: home errors_lead_to_shot")
    eq(home["errors_lead_to_goal"], 1, "match_stats: home errors_lead_to_goal")
    eq(away["errors_lead_to_shot"], 0, "match_stats: away errors_lead_to_shot")

    # Fractional stats
    eq(home["long_balls_accurate"], 27, "match_stats: home long_balls_accurate")
    eq(home["long_balls_total"], 56, "match_stats: home long_balls_total")
    eq(home["crosses_accurate"], 6, "match_stats: home crosses_accurate")
    eq(home["crosses_total"], 22, "match_stats: home crosses_total")
    eq(home["ground_duels_won"], 28, "match_stats: home ground_duels_won")
    eq(home["aerial_duels_won"], 18, "match_stats: home aerial_duels_won")
    eq(home["dribbles_won"], 6, "match_stats: home dribbles_won")
    eq(home["dribbles_attempted"], 13, "match_stats: home dribbles_attempted")

    # Goals prevented — real (signed)
    eq(home["goals_prevented"], -0.05, "match_stats: home goals_prevented")
    eq(away["goals_prevented"], -0.65, "match_stats: away goals_prevented")

    # No leaking temp keys
    leaked = [k for k in home.keys() if k.startswith("_")]
    eq(leaked, [], "match_stats: no leaking _temp_ keys")

    # Duels (single-stat pct) → goes in raw_extras, not as a column
    check("duels_won_pct" not in home, "match_stats: 'Duels' (single pct) not aliased to a column")


def test_player_stats() -> None:
    rows = project_player_stats(LINEUPS_FIXTURE, game_id=999)
    eq(len(rows), 2, "player_stats: 2 home players (away=empty fixture)")

    keeper = next((r for r in rows if r["player_id"] == 1001), None)
    striker = next((r for r in rows if r["player_id"] == 1002), None)

    check(keeper is not None, "player_stats: keeper row found")
    check(striker is not None, "player_stats: striker row found")
    if keeper is None or striker is None:
        return

    # Identity
    eq(keeper["team_id"], 100, "player_stats: team_id from slot.teamId")
    eq(keeper["is_home"], True, "player_stats: is_home")
    eq(keeper["is_starter"], True, "player_stats: is_starter (substitute=False)")
    eq(keeper["is_captain"], True, "player_stats: is_captain")
    eq(keeper["position"], "G", "player_stats: position")
    eq(keeper["jersey_number"], 1, "player_stats: jersey_number")

    # Stats mapping
    eq(keeper["rating"], 7.2, "player_stats: rating")
    eq(keeper["minutes_played"], 90, "player_stats: minutes_played")
    eq(keeper["saves"], 3, "player_stats: saves")
    eq(keeper["saves_inside_box"], 2, "player_stats: saves_inside_box")
    eq(keeper["passes_total"], 32, "player_stats: passes_total")
    eq(keeper["passes_accurate"], 28, "player_stats: passes_accurate")
    eq(keeper["pass_accuracy_pct"], 87.5, "player_stats: pass_accuracy_pct (derived)")

    # Striker
    eq(striker["goals"], 1, "player_stats: striker goals")
    eq(striker["assists"], 1, "player_stats: striker assists (goalAssist)")
    eq(striker["expected_goals"], 0.45, "player_stats: xG real")
    eq(striker["expected_assists"], 0.30, "player_stats: xA real")
    eq(striker["shots_total"], 4, "player_stats: striker shots_total")
    eq(striker["duels_won"], 5, "player_stats: duels_won")
    eq(striker["duels_total"], 9, "player_stats: duels_total derived (won+lost)")


def test_incidents() -> None:
    rows = project_incidents(INCIDENTS_FIXTURE, game_id=999)
    eq(len(rows), 6, "incidents: row count")

    # Reverse-chrono input → enumeration in match-time order
    # First incident in OUR output should be the earliest (6' goal)
    first = rows[0]
    eq(first["minute"], 6, "incidents: first row is earliest (6')")
    eq(first["incident_type"], "goal", "incidents: first is goal")
    eq(first["is_home"], False, "incidents: first goal is_home=False")

    # Goal at 87' attribution
    goal87 = next((r for r in rows if r["incident_type"] == "goal" and r["minute"] == 87), None)
    check(goal87 is not None, "incidents: 87' goal exists")
    if goal87:
        eq(goal87["player_id"], 2001, "incidents: 87' goal player_id")
        eq(goal87["scoring_team_score"], 1, "incidents: 87' scoring_team_score (home scored)")
        eq(goal87["conceding_team_score"], 2, "incidents: 87' conceding_team_score")

    # Card
    card = next((r for r in rows if r["incident_type"] == "card"), None)
    check(card is not None, "incidents: card row exists")
    if card:
        eq(card["card_color"], "yellow", "incidents: card color")
        eq(card["card_reason"], "Foul", "incidents: card reason")

    # Substitution
    sub = next((r for r in rows if r["incident_type"] == "substitution"), None)
    check(sub is not None, "incidents: sub row exists")
    if sub:
        eq(sub["player_id"], 2003, "incidents: sub player_id (player_out)")
        eq(sub["related_player_id"], 2001, "incidents: sub related (player_in)")

    # Period
    period = next((r for r in rows if r["incident_type"] == "period"), None)
    check(period is not None, "incidents: period row exists")
    if period:
        eq(period["period"], "FT", "incidents: period text")

    # Stable indices
    indices = sorted(r["incident_idx"] for r in rows)
    eq(indices, list(range(len(rows))), "incidents: incident_idx is 0..N-1")


def test_avg_positions() -> None:
    rows = project_avg_positions(AVG_POS_FIXTURE, game_id=999, team_ids={True: 100, False: 200})
    eq(len(rows), 3, "avg_positions: 2 home + 1 away players")

    home_keeper = next((r for r in rows if r["player_id"] == 1001), None)
    check(home_keeper is not None, "avg_positions: home keeper row")
    if home_keeper:
        eq(home_keeper["team_id"], 100, "avg_positions: team_id from team_ids dict")
        eq(home_keeper["avg_x"], 12.5, "avg_positions: avg_x (low x = own goal-side, expected for GK)")
        eq(home_keeper["avg_y"], 50.0, "avg_positions: avg_y (center)")
        eq(home_keeper["points_count"], 87, "avg_positions: points_count preserved")

    away_striker = next((r for r in rows if r["player_id"] == 2004), None)
    check(away_striker is not None, "avg_positions: away striker row")
    if away_striker:
        eq(away_striker["team_id"], 200, "avg_positions: away team_id")
        eq(away_striker["is_home"], False, "avg_positions: is_home False for away side")


# ─── Runner ───────────────────────────────────────────────────────

def main() -> int:
    tests = [
        ("match_stats projection",  test_match_stats),
        ("player_stats projection", test_player_stats),
        ("incidents projection",    test_incidents),
        ("avg_positions projection", test_avg_positions),
    ]
    print("Running load_extras_to_supabase smoke tests…\n")
    for label, fn in tests:
        before = len(_failures)
        try:
            fn()
        except Exception as e:
            _failures.append(f"{label}: raised {type(e).__name__}: {e}")
        n_added = len(_failures) - before
        marker = "✓" if n_added == 0 else f"✗ ({n_added} fail)"
        print(f"  {marker}  {label}")

    if _failures:
        print(f"\n❌ {len(_failures)} failures:")
        for msg in _failures:
            print(f"  - {msg}")
        return 1
    print(f"\n✓ All {len(tests)} test groups passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

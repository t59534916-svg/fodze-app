"""Smoke test for fetch_upcoming_lineups.py parse_lineups().

Mocked Sofa /lineups response based on actual response shape (verified
2026-05-25 from extras/{game_id}.json files where lineups WERE pulled
successfully under previous proxy windows).

Tests the parser logic without requiring live network:
  * Standard format with substitute boolean
  * Missing fields handled gracefully
  * Multiple positions
  * Empty / unconfirmed lineups
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Import parse_lineups via direct file load (skip __init__ complexity)
import importlib.util
ROOT = Path(__file__).resolve().parents[3]  # repo root
spec = importlib.util.spec_from_file_location(
    "ful", ROOT / "tools" / "sofascore" / "fetch_upcoming_lineups.py"
)
ful = importlib.util.module_from_spec(spec)
# Avoid triggering main() — stub out the cli args
sys.argv = ["fetch_upcoming_lineups.py", "--dry"]
try:
    spec.loader.exec_module(ful)
except SystemExit:
    pass
parse_lineups = ful.parse_lineups


def test_standard_confirmed_lineup():
    """Typical Sofa response: confirmed XI + bench."""
    raw = {
        "confirmed": True,
        "home": {
            "formation": "4-3-3",
            "players": [
                {"player": {"name": "Goalkeeper1", "id": 1}, "substitute": False, "position": "G"},
                {"player": {"name": "Defender1", "id": 2}, "substitute": False, "position": "D"},
                {"player": {"name": "Midfielder1", "id": 3}, "substitute": False, "position": "M"},
                {"player": {"name": "Forward1", "id": 4}, "substitute": False, "position": "F"},
                {"player": {"name": "Bench1", "id": 5}, "substitute": True, "position": "M"},
            ],
        },
        "away": {
            "formation": "4-4-2",
            "players": [
                {"player": {"name": "AwayGK", "id": 11}, "substitute": False},
                {"player": {"name": "AwayBench1", "id": 12}, "substitute": True},
            ],
        },
    }
    parsed = parse_lineups(raw)
    assert parsed["home_formation"] == "4-3-3", f"got {parsed['home_formation']!r}"
    assert parsed["away_formation"] == "4-4-2"
    assert parsed["home_starters"] == ["Goalkeeper1", "Defender1", "Midfielder1", "Forward1"]
    assert parsed["away_starters"] == ["AwayGK"]
    assert parsed["confirmed"] == 1


def test_unconfirmed_lineup():
    raw = {
        "confirmed": False,
        "home": {"formation": "4-3-3", "players": []},
        "away": {"formation": None, "players": []},
    }
    parsed = parse_lineups(raw)
    assert parsed["confirmed"] == 0
    assert parsed["home_starters"] == []
    assert parsed["away_starters"] == []


def test_missing_substitute_field_treated_as_starter():
    """If `substitute` field is absent, treat as starter (Sofa quirk for some leagues)."""
    raw = {
        "confirmed": True,
        "home": {"formation": "4-2-3-1", "players": [
            {"player": {"name": "A", "id": 1}},  # no substitute field
            {"player": {"name": "B", "id": 2}, "substitute": False},
            {"player": {"name": "C", "id": 3}, "substitute": True},
        ]},
        "away": {"players": []},
    }
    parsed = parse_lineups(raw)
    # `substitute` absent → falsy → not substitute → starter
    assert "A" in parsed["home_starters"]
    assert "B" in parsed["home_starters"]
    assert "C" not in parsed["home_starters"]


def test_missing_player_name_skipped():
    raw = {
        "confirmed": True,
        "home": {"formation": "4-3-3", "players": [
            {"player": {"name": "RealPlayer", "id": 1}, "substitute": False},
            {"player": {"id": 2}, "substitute": False},  # no name
            {"player": {"name": None, "id": 3}, "substitute": False},  # null name
            {"player": {"name": "", "id": 4}, "substitute": False},  # empty name
        ]},
        "away": {"players": []},
    }
    parsed = parse_lineups(raw)
    # Only RealPlayer should survive name filter
    assert parsed["home_starters"] == ["RealPlayer"]


def test_empty_or_missing_team_object():
    """Sofa returns empty dict for unknown side."""
    raw = {"confirmed": True, "home": {}, "away": {}}
    parsed = parse_lineups(raw)
    assert parsed["home_formation"] is None
    assert parsed["away_formation"] is None
    assert parsed["home_starters"] == []
    assert parsed["away_starters"] == []
    assert parsed["confirmed"] == 1


def test_completely_empty_response():
    raw = {}
    parsed = parse_lineups(raw)
    assert parsed["home_starters"] == []
    assert parsed["away_starters"] == []
    assert parsed["confirmed"] == 0


def run_all():
    tests = [
        test_standard_confirmed_lineup,
        test_unconfirmed_lineup,
        test_missing_substitute_field_treated_as_starter,
        test_missing_player_name_skipped,
        test_empty_or_missing_team_object,
        test_completely_empty_response,
    ]
    passed, failed = 0, []
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  ✓ {t.__name__}")
        except AssertionError as e:
            failed.append((t.__name__, str(e)))
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed.append((t.__name__, f"{type(e).__name__}: {e}"))
            print(f"  ✗ {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(tests)} passed")
    return len(failed) == 0


if __name__ == "__main__":
    if not run_all():
        sys.exit(1)

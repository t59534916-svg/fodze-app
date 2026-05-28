"""
validate_schema.py — Stage 0b: verify local SQLite mirror has all expected tables/columns.

Single source of truth for what v4 training expects to see. If this fails,
upstream sync is broken (likely `tools/sofascore/mirror_team_xg_history.py` or
`load_extras_to_supabase.py --local-mirror` didn't run).

Run: tools/venv/bin/python3 -I tools/v4/validate_schema.py

Exit codes:
  0 — all required tables present with required columns + minimum row counts
  1 — at least one required table missing or row count below floor
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


# (table_name, required_columns, minimum_rows)
REQUIRED_TABLES: List[Tuple[str, List[str], int]] = [
    (
        "team_xg_history",
        ["team", "league", "opponent", "venue", "match_date", "xg", "xga",
         "goals_for", "goals_against", "source"],
        80_000,  # ~87k as of 2026-05-10
    ),
    (
        "sofascore_shotmap",
        ["game_id", "league", "season", "is_home", "xg", "body_part"],
        150_000,  # ~175k as of 2026-05-10
    ),
    (
        "sofascore_match",
        ["game_id", "league", "season", "home_team", "away_team",
         "home_team_id", "away_team_id", "start_timestamp", "status"],
        6_500,  # ~7.1k as of 2026-05-10
    ),
    ("sofascore_match_statistics", [], 30_000),
    ("sofascore_incidents", [], 100_000),
    ("sofascore_average_positions", [], 150_000),
    ("sofascore_match_managers", [], 10_000),
    ("sofascore_pregame_form", [], 10_000),
    ("sofascore_team_streaks", [], 50_000),
    # `stadiums` entry removed 2026-05-28 — table dropped from Supabase
    # (verified leakage baggage). Ingest archived to scripts/_archive/.
]


def get_tables(conn: sqlite3.Connection) -> Dict[str, List[str]]:
    """Return {table_name: [column_names]} for all tables in DB."""
    tables = {}
    for (name,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ):
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({name})")]
        tables[name] = cols
    return tables


def get_row_count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def main() -> int:
    if not LOCAL_DB.exists():
        print(f"✗ FATAL: local SQLite mirror not found at {LOCAL_DB}")
        print("  Run: tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py")
        return 1

    conn = sqlite3.connect(LOCAL_DB)
    tables = get_tables(conn)

    print("=" * 70)
    print(f"Stage 0b: Schema validation — {LOCAL_DB.name}")
    print("=" * 70)

    n_fail = 0
    for table, required_cols, min_rows in REQUIRED_TABLES:
        if table not in tables:
            print(f"  ✗ {table:35} MISSING — required for v4 pipeline")
            n_fail += 1
            continue

        # Check required columns
        actual_cols = set(tables[table])
        missing_cols = [c for c in required_cols if c not in actual_cols]
        if missing_cols:
            print(f"  ✗ {table:35} missing cols: {missing_cols}")
            n_fail += 1
            continue

        # Check row count
        n = get_row_count(conn, table)
        if n < min_rows:
            print(f"  ✗ {table:35} n={n:>8,} (expected ≥ {min_rows:,})")
            n_fail += 1
        else:
            print(f"  ✓ {table:35} n={n:>8,}")

    conn.close()

    print()
    if n_fail == 0:
        print(f"✓ Schema OK — {len(REQUIRED_TABLES)}/{len(REQUIRED_TABLES)} tables valid")
        return 0
    print(f"✗ {n_fail}/{len(REQUIRED_TABLES)} tables FAILED validation")
    print("  → Fix upstream sync before continuing (see CLAUDE.md §'Local SQLite Mirror')")
    return 1


if __name__ == "__main__":
    sys.exit(main())

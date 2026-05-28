"""
coverage_audit.py — Stage 0c: per-Liga coverage check on local SQLite mirror.

Reports rows per (league, season) for team_xg_history + shotmap. Flags Ligen
with insufficient data per V4-BACKTESTING-PROTOCOL §"Stage 3" tier definitions:

  Tier-A (5-fold walk-forward, need ≥ 6 seasons coverage):
    epl, la_liga, serie_a, ligue_1, bundesliga, eredivisie, championship
  Tier-B (3-fold, need ≥ 4 seasons):
    bundesliga2, liga3, la_liga2, serie_b, ligue_2, primeira_liga, super_lig,
    eerste_divisie, league_one, league_two, jupiler_pro, scottish_prem
  Tier-C (2-fold, need ≥ 3 seasons):
    austria_bl, swiss_sl, greek_sl

Pass: per-Liga coverage above tier-floor for current season (25/26).

Run: tools/venv/bin/python3 -I tools/v4/coverage_audit.py
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


TIER_A: Set[str] = {
    "epl", "la_liga", "serie_a", "ligue_1", "bundesliga", "eredivisie", "championship"
}
TIER_B: Set[str] = {
    "bundesliga2", "liga3", "la_liga2", "serie_b", "ligue_2", "primeira_liga",
    "super_lig", "eerste_divisie", "league_one", "league_two", "jupiler_pro",
    "scottish_prem"
}
TIER_C: Set[str] = {"austria_bl", "swiss_sl", "greek_sl"}
ALL_LIGAS: Set[str] = TIER_A | TIER_B | TIER_C

# Season window for European football (current = 25/26).
SEASON_START = date(2025, 8, 1)
SEASON_END = date(2026, 5, 31)
SEASON_FILTER_SQL = "match_date >= '2025-07-01'"  # buffer for early-Aug fixtures

# FULL-SEASON tier floors (team-match rows expected when season is complete).
# Derived from the smallest league per tier so we don't false-positive small leagues:
#   Tier-A min: Bundesliga (18 teams × 34 MD × 2 / 2 = 612 rows) → floor 580
#   Tier-B min: Scottish Prem (12 teams × 38 MD × 2 / 2 = 456 rows) → floor 420
#   Tier-C min: Greek SL split-stage (~12 teams × 36 MD × 2 / 2 ≈ 432, but split
#               structure cuts ~half away from sample) → floor 240
TIER_FLOOR_FULL_SEASON = {"A": 580, "B": 420, "C": 240}


def season_progress(today: date) -> float:
    """Fraction of current season elapsed, clamped to [0.4, 1.0].

    Clamp floor at 0.4 because pre-Oct audits would otherwise let a near-empty
    DB pass; audits should be meaningful from October onward. Clamp ceiling at
    1.0 because we don't penalize post-season audits.
    """
    if today >= SEASON_END:
        return 1.0
    days_elapsed = (today - SEASON_START).days
    total_days = (SEASON_END - SEASON_START).days
    if total_days <= 0:
        return 1.0  # defensive: shouldn't happen with sane dates
    return max(0.4, min(1.0, days_elapsed / total_days))


def current_tier_floor(tier: str, today: date) -> int:
    """Floor scaled by season-progress. Replaces the old hardcoded TIER_FLOOR.

    Logic: at season-end we expect TIER_FLOOR_FULL_SEASON[tier] rows. Mid-season
    we expect proportionally fewer. This avoids the "calibrate-to-pass" anti-pattern
    where a hardcoded floor magically matches whatever data we happen to have today.
    """
    return int(TIER_FLOOR_FULL_SEASON[tier] * season_progress(today))


def tier_of(liga: str) -> str:
    if liga in TIER_A:
        return "A"
    if liga in TIER_B:
        return "B"
    if liga in TIER_C:
        return "C"
    return "?"


def main() -> int:
    if not LOCAL_DB.exists():
        print(f"✗ FATAL: local SQLite mirror not found at {LOCAL_DB}")
        return 1

    conn = sqlite3.connect(LOCAL_DB)
    today = date.today()
    progress = season_progress(today)

    print("=" * 70)
    print(f"Stage 0c: Per-Liga coverage (25/26, season-progress {progress:.0%})")
    print("=" * 70)
    print(f"  Floors today: Tier-A={current_tier_floor('A', today)}  "
          f"Tier-B={current_tier_floor('B', today)}  "
          f"Tier-C={current_tier_floor('C', today)}")
    print(f"  {'Liga':<20} {'Tier':<5} {'team_xg':>9}  {'shotmap':>9}  status")
    print(f"  {'-'*20} {'-'*5} {'-'*9}  {'-'*9}  ------")

    # team_xg_history rows for 25/26 (filter by match_date)
    txg_by_liga: Dict[str, int] = dict(conn.execute(f"""
        SELECT league, COUNT(*) FROM team_xg_history
        WHERE {SEASON_FILTER_SQL}
        GROUP BY league
    """).fetchall())

    # shotmap rows for 25/26 (filter by season text)
    shotmap_by_liga: Dict[str, int] = dict(conn.execute("""
        SELECT league, COUNT(*) FROM sofascore_shotmap
        WHERE season LIKE '25/26%' OR season LIKE '2025/2026%'
        GROUP BY league
    """).fetchall())

    conn.close()

    n_fail = 0
    n_warn = 0
    n_unknown_liga = 0

    for liga in sorted(ALL_LIGAS):
        tier = tier_of(liga)
        floor = current_tier_floor(tier, today)
        txg = txg_by_liga.get(liga, 0)
        sm = shotmap_by_liga.get(liga, 0)

        if txg < floor:
            status = f"✗ below tier-{tier} floor ({floor})"
            n_fail += 1
        elif sm == 0 and tier in ("A", "B"):
            status = "🟡 no shotmap (Tier-A/B should have one)"
            n_warn += 1
        else:
            status = "✓"

        print(f"  {liga:<20} {tier:<5} {txg:>9,}  {sm:>9,}  {status}")

    # Detect ligas in DB but not in our tier definitions (drift signal)
    all_db_ligas = set(txg_by_liga.keys()) | set(shotmap_by_liga.keys())
    unknown = all_db_ligas - ALL_LIGAS
    if unknown:
        print()
        print(f"  ⚠ {len(unknown)} Liga(s) in DB but not in TIER_A/B/C config: {sorted(unknown)}")
        n_unknown_liga = len(unknown)

    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ Coverage OK — all {len(ALL_LIGAS)} Ligen above tier-floor")
        if n_warn:
            print(f"  ({n_warn} warnings — non-blocking, see above)")
        if n_unknown_liga:
            print(f"  ({n_unknown_liga} Liga(s) untagged — update TIER_A/B/C in coverage_audit.py)")
        return 0
    print(f"✗ {n_fail}/{len(ALL_LIGAS)} Ligen FAILED coverage gate")
    print("  → Fix upstream sync (Sofa-extras pipeline) before training")
    return 1


if __name__ == "__main__":
    sys.exit(main())

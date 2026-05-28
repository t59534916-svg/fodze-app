"""
v4.data.loaders — paginated readers for local SQLite mirror.

Single entrypoint for ALL v4 training data. Reading from local SQLite (not Supabase)
is intentional:
  - Faster (~1s for 87k team-rows, ~3s for 175k shotmap rows)
  - Offline-resilient (Supabase Free-tier IO budget exhaustion is a real failure mode)
  - Predictable schema (we control the mirror schema, not Supabase migrations)

API surface (used by m2_lambda, m3_xg, m4_set_pieces):
  load_team_xg_history(*, cutoff, leagues, since) → pd.DataFrame   (87k rows)
  load_match_pairs(*, cutoff, leagues, since) → pd.DataFrame        (joined home+away)
  load_shotmap(*, cutoff, leagues, situations) → pd.DataFrame       (175k rows)
  load_sofa_match(*, cutoff, leagues) → pd.DataFrame                (7k matches)
  load_sofa_stats(*, cutoff, leagues, period) → pd.DataFrame        (40k stat rows)

All functions accept:
  cutoff:   max match_date inclusive (None = no upper bound)
  since:    min match_date inclusive (None = no lower bound)
  leagues:  list of league codes (None = all)

Date columns are parsed as pandas datetime64.

⚠ match_date semantics differ across sources — IMPORTANT for cross-table joins:
  * team_xg_history.match_date  → upstream source's date (FootyStats / OpenLigaDB /
                                   api-sports use LEAGUE-LOCAL date). Postponed matches
                                   carry the RESCHEDULED date.
  * sofa.match_date (derived)   → date(start_timestamp, 'unixepoch') — UTC-derived.
                                   Postponed matches carry the ORIGINAL date.

Empirical drift (measured 2026-05-12 on 5,327 matched rows):
  99.85% agree, 0.15% differ by ±2 days (ALL ±2-day cases are status='Postponed').
  Zero pure-timezone drift observed (≥99% of league fixtures kick off well clear
  of midnight UTC). So no TZ-offset code in loaders — would not help.

Implication for downstream: when joining team_xg_history × sofa-tables, prefer
joining on (league, home_team, away_team) and accept the source-native date of
the team_xg side, OR filter out sofascore_match.status='Postponed' first.
A `merge_team_xg_with_sofa()` helper will be added in m3_xg when needed.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import List, Optional, Sequence

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


# ─────────────────────────────────────────────────────────────────────
# Connection helper
# ─────────────────────────────────────────────────────────────────────


def _connect() -> sqlite3.Connection:
    """Open read-only connection to local SQLite mirror."""
    if not LOCAL_DB.exists():
        raise FileNotFoundError(
            f"Local SQLite mirror not found at {LOCAL_DB}. "
            "Run: tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py"
        )
    # uri=True with mode=ro for read-only access — avoids accidental writes from training
    uri = f"file:{LOCAL_DB}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _league_clause(leagues: Optional[Sequence[str]], col: str = "league") -> str:
    if not leagues:
        return ""
    placeholders = ",".join(["?"] * len(leagues))
    return f" AND {col} IN ({placeholders})"


def _date_clauses(
    cutoff: Optional[str], since: Optional[str], col: str = "match_date"
) -> str:
    parts = []
    if cutoff is not None:
        parts.append(f" AND {col} <= ?")
    if since is not None:
        parts.append(f" AND {col} >= ?")
    return "".join(parts)


def _date_params(cutoff: Optional[str], since: Optional[str]) -> List[str]:
    params: List[str] = []
    if cutoff is not None:
        params.append(cutoff)
    if since is not None:
        params.append(since)
    return params


# ─────────────────────────────────────────────────────────────────────
# Loaders
# ─────────────────────────────────────────────────────────────────────


def load_team_xg_history(
    *,
    cutoff: Optional[str] = None,
    since: Optional[str] = None,
    leagues: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Load team_xg_history filtered by date and league.

    Returns DataFrame with columns:
      id, team, league, opponent, venue, match_date (datetime64),
      xg, xga, goals_for, goals_against, source
    """
    sql = """
        SELECT id, team, league, opponent, venue, match_date,
               xg, xga, goals_for, goals_against, source
        FROM team_xg_history
        WHERE 1=1
    """
    sql += _date_clauses(cutoff, since)
    sql += _league_clause(leagues)
    sql += " ORDER BY match_date, team"

    params: List[str] = _date_params(cutoff, since)
    if leagues:
        params.extend(leagues)

    with _connect() as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def load_match_pairs(
    *,
    cutoff: Optional[str] = None,
    since: Optional[str] = None,
    leagues: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Self-join team_xg_history to produce one row per match (home + away combined).

    Returns DataFrame with columns:
      league, match_date (datetime64), home, away,
      home_xg, away_xg, home_goals, away_goals,
      home_source, away_source

    Drops rows where either side is missing (asymmetric data) or where venue values
    don't pair cleanly (defensive — shouldn't happen with canonical schema).
    """
    sql = """
        SELECT h.league AS league,
               h.match_date AS match_date,
               h.team AS home,
               h.opponent AS away,
               h.xg AS home_xg,
               a.xg AS away_xg,
               h.goals_for AS home_goals,
               h.goals_against AS home_goals_against,
               a.goals_for AS away_goals,
               a.goals_against AS away_goals_against,
               h.source AS home_source,
               a.source AS away_source
        FROM team_xg_history h
        INNER JOIN team_xg_history a
          ON h.league = a.league
         AND h.match_date = a.match_date
         AND h.team = a.opponent
         AND h.opponent = a.team
        WHERE h.venue = 'home'
          AND a.venue = 'away'
    """
    sql += _date_clauses(cutoff, since, col="h.match_date")
    sql += _league_clause(leagues, col="h.league")
    sql += " ORDER BY h.match_date, h.team"

    params: List[str] = _date_params(cutoff, since)
    if leagues:
        params.extend(leagues)

    with _connect() as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df["match_date"] = pd.to_datetime(df["match_date"])

    # Defensive consistency check: home_goals_against should equal away_goals
    # (and vice versa). If asymmetric, that's data corruption — drop + warn.
    # Operates on the original df only; never re-indexes after filtering.
    both_present = df["home_goals"].notna() & df["away_goals"].notna()
    consistent_goals = (
        (df["home_goals_against"] == df["away_goals"])
        & (df["away_goals_against"] == df["home_goals"])
    )
    # Drop only rows where BOTH sides have goals AND they disagree.
    # Rows with NULL goals on either side are kept (pre-match / scheduled / xG-only).
    inconsistent_mask = both_present & ~consistent_goals
    n_inconsistent = int(inconsistent_mask.sum())
    if n_inconsistent > 0:
        import sys as _sys
        _sys.stderr.write(
            f"[loaders.load_match_pairs] WARN: dropped {n_inconsistent} rows "
            f"with home/away goal-totals that disagree (data corruption signal).\n"
        )
        df = df[~inconsistent_mask].reset_index(drop=True)

    return df.drop(columns=["home_goals_against", "away_goals_against"])


def load_shotmap(
    *,
    cutoff: Optional[str] = None,
    since: Optional[str] = None,
    leagues: Optional[Sequence[str]] = None,
    situations: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Load sofascore_shotmap with optional filtering.

    Joins to sofascore_match for match_date. Filter `situations` accepts e.g.
    ['corner', 'free-kick', 'penalty', 'set-piece'] for m4 set-piece training.

    Returns DataFrame with columns:
      shot_id, game_id, league, season, week, player_id, player_name,
      player_position, is_home, xg, xgot, body_part, situation, shot_type,
      goal_outcome (derived: 1 if goal_type IS NOT NULL else 0),
      shooter_x, shooter_y, minute, added_minute,
      match_date (datetime64 derived from sofascore_match.start_timestamp)
    """
    sql = """
        SELECT s.id AS shot_id, s.game_id, s.league, s.season, s.week,
               s.player_id, s.player_name, s.player_position,
               s.is_home, s.xg, s.xgot, s.body_part, s.situation, s.shot_type,
               CASE WHEN s.goal_type IS NOT NULL THEN 1 ELSE 0 END AS goal_outcome,
               s.shooter_x, s.shooter_y, s.minute, s.added_minute,
               date(m.start_timestamp, 'unixepoch') AS match_date
        FROM sofascore_shotmap s
        INNER JOIN sofascore_match m ON s.game_id = m.game_id
        WHERE 1=1
    """
    sql += _date_clauses(cutoff, since, col="date(m.start_timestamp, 'unixepoch')")
    sql += _league_clause(leagues, col="s.league")
    if situations:
        placeholders = ",".join(["?"] * len(situations))
        sql += f" AND s.situation IN ({placeholders})"
    sql += " ORDER BY m.start_timestamp, s.game_id, s.id"

    params: List[str] = _date_params(cutoff, since)
    if leagues:
        params.extend(leagues)
    if situations:
        params.extend(situations)

    with _connect() as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def load_sofa_match(
    *,
    cutoff: Optional[str] = None,
    since: Optional[str] = None,
    leagues: Optional[Sequence[str]] = None,
    status: Optional[str] = "Ended",
) -> pd.DataFrame:
    """Load sofascore_match (one row per match).

    Default filter status='Ended' restricts to settled matches with final scores.
    Pass status=None to include all (incl. scheduled, postponed).

    Returns DataFrame with columns:
      game_id, league, season, week, home_team, away_team,
      home_team_id, away_team_id, home_score, away_score,
      match_date (datetime64), status
    """
    sql = """
        SELECT game_id, league, season, week,
               home_team, away_team, home_team_id, away_team_id,
               home_score, away_score,
               date(start_timestamp, 'unixepoch') AS match_date,
               status
        FROM sofascore_match
        WHERE 1=1
    """
    sql += _date_clauses(cutoff, since, col="date(start_timestamp, 'unixepoch')")
    sql += _league_clause(leagues)
    if status is not None:
        sql += " AND status = ?"
    sql += " ORDER BY start_timestamp, game_id"

    params: List[str] = _date_params(cutoff, since)
    if leagues:
        params.extend(leagues)
    if status is not None:
        params.append(status)

    with _connect() as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def load_sofa_stats(
    *,
    cutoff: Optional[str] = None,
    since: Optional[str] = None,
    leagues: Optional[Sequence[str]] = None,
    period: str = "ALL",
) -> pd.DataFrame:
    """Load sofascore_match_statistics (one row per game × team × period).

    period: "ALL" (full match), "1ST" (first half), "2ND" (second half).

    Returns DataFrame with the stat columns from sofascore_match_statistics.
    """
    sql = """
        SELECT s.*, date(m.start_timestamp, 'unixepoch') AS match_date
        FROM sofascore_match_statistics s
        INNER JOIN sofascore_match m ON s.game_id = m.game_id
        WHERE s.period = ?
    """
    params: List[str] = [period]
    sql += _date_clauses(cutoff, since, col="date(m.start_timestamp, 'unixepoch')")
    params.extend(_date_params(cutoff, since))
    sql += _league_clause(leagues, col="m.league")
    if leagues:
        params.extend(leagues)
    sql += " ORDER BY m.start_timestamp, s.game_id"

    with _connect() as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


# ─────────────────────────────────────────────────────────────────────
# Self-test: smoke-runs each loader to catch schema-drift early
# ─────────────────────────────────────────────────────────────────────


def _smoke_test() -> None:
    """Verify loaders work across all 3 tiers (data-heterogeneity catches schema bugs).

    Each tier has different characteristics:
      - bundesliga (Tier-A): high-coverage, all sources populated
      - bundesliga2 (Tier-B): FootyStats-era only, lower per-row enrichment
      - austria_bl (Tier-C): playoff-split structure, smallest sample
    """
    print(f"Local DB: {LOCAL_DB}")
    print()

    test_cases = [
        ("bundesliga", "A"),
        ("bundesliga2", "B"),
        ("austria_bl", "C"),
    ]

    for league, tier in test_cases:
        print(f"── Tier-{tier}: {league} ────────────────────────────────")

        # 1. team_xg_history loader
        df_txg = load_team_xg_history(since="2025-08-01", leagues=[league])
        assert len(df_txg) > 0, f"{league}: team_xg_history is empty"
        assert df_txg["league"].nunique() == 1, f"{league}: league column drift"
        assert df_txg["league"].iloc[0] == league
        assert df_txg["match_date"].notna().all(), f"{league}: null match_date"
        assert (df_txg["venue"].isin(["home", "away"])).all(), \
            f"{league}: unexpected venue values"
        print(f"  team_xg_history: {len(df_txg):,} rows · "
              f"{df_txg['match_date'].min().date()} → "
              f"{df_txg['match_date'].max().date()}")

        # 2. match_pairs loader (joined home+away)
        df_match = load_match_pairs(since="2025-08-01", leagues=[league])
        if len(df_match) > 0:
            # Each match-pair should derive from exactly 2 team_xg rows (one home, one away).
            # Allow some slack: not every team_xg row pairs cleanly if opponent rows missing.
            # But pair-count × 2 should be ≤ team_xg row count.
            assert len(df_match) * 2 <= len(df_txg) * 1.05, \
                f"{league}: match_pairs ({len(df_match)}) inconsistent with team_xg ({len(df_txg)})"
            avg_home_xg = df_match["home_xg"].mean()
            avg_away_xg = df_match["away_xg"].mean()
            # Home advantage should be visible (home_xg > away_xg on average)
            print(f"  match_pairs:     {len(df_match):,} matches · "
                  f"home_xg={avg_home_xg:.2f} vs away_xg={avg_away_xg:.2f} "
                  f"(Δ={avg_home_xg - avg_away_xg:+.2f})")

        # 3. shotmap loader (Sofa-only data)
        df_shots = load_shotmap(
            since="2025-08-01",
            leagues=[league],
            situations=["corner", "free-kick", "penalty"],
        )
        if len(df_shots) > 0:
            # goal_outcome must be {0, 1} only
            assert set(df_shots["goal_outcome"].unique()).issubset({0, 1}), \
                f"{league}: goal_outcome has non-binary values"
            goal_rate = df_shots["goal_outcome"].mean()
            # Realistic setpiece goal-rate is 5-25% (heavy penalty-weighting)
            assert 0.02 < goal_rate < 0.40, \
                f"{league}: setpiece goal-rate {goal_rate:.3f} outside plausible [0.02, 0.40]"
            print(f"  shotmap SP:      {len(df_shots):,} shots · goal-rate={goal_rate:.3f}")
        else:
            print(f"  shotmap SP:      0 shots (Tier-{tier} sometimes has no Sofa-coverage)")

        # 4. sofa_match loader
        df_sofa = load_sofa_match(since="2025-08-01", leagues=[league])
        if len(df_sofa) > 0:
            assert (df_sofa["status"] == "Ended").all(), \
                f"{league}: status filter not applied"
            assert df_sofa["home_score"].notna().all(), \
                f"{league}: null home_score on ended match"
            print(f"  sofa_match:      {len(df_sofa):,} ended matches")

        print()

    print("✓ All loaders work across Tier-A/B/C")


if __name__ == "__main__":
    _smoke_test()

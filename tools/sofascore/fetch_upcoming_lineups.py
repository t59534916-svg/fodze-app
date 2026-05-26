"""Lineup-Fetcher MVP — Sofa /lineups endpoint for UPCOMING matches.

Purpose: build the infrastructure channel so future lineup-aware engine
features (per `docs/LINEUP-INTEGRATION.md`) have a data source to read
from. Doesn't validate any specific feature — just stores the data.

Flow:
  1. Query local SQLite `sofascore_match` for "Not started" matches in
     a window (default: next 48h based on start_timestamp).
  2. For each: fetch `/api/v1/event/{id}/lineups`. Default = Mac-IP
     direct (curl_cffi chrome124, no proxy). Fall back to Webshare
     ONLY on BlockedError mid-run.
  3. Persist to local SQLite `sofascore_lineups_cache` (one row per game,
     full raw JSON + parsed starting-XI + formation).
  4. Output JSON snapshot to `tools/sofascore/data/lineups_upcoming.json`
     for engine-side reads.

Connectivity history:
  * 2026-05-25: Mac-IP got CF-blocked for api.sofascore.com — MVP launched
    with hardcoded Webshare-only path.
  * 2026-05-26: CF block lifted. All 7 endpoints (statistics, lineups,
    incidents, average-positions, managers, pregame-form, team-streaks)
    return HTTP 200 direct from Mac-IP. Confirmed via the in-flight
    22/23 slim-3 backfill (~25 games/min sustained, 0 BlockedErrors).
    Default flipped to Mac-IP-direct; Webshare is opt-in fallback.

Design notes:
  * NO Supabase write — purely local cache. Supabase sync would be a
    separate cron addition.
  * Auto-fallback: on BlockedError mid-run, switch to Webshare and
    continue. Saves Webshare bandwidth when Mac-IP works (most days).
  * Lineups are released ~1h before kickoff. Run hourly via cron OR
    on-demand before /matchday page-load.

Usage:
  python3 tools/sofascore/fetch_upcoming_lineups.py                    # Mac-IP-first
  python3 tools/sofascore/fetch_upcoming_lineups.py --use-webshare     # skip direct, force proxy
  python3 tools/sofascore/fetch_upcoming_lineups.py --hours-ahead 24
  python3 tools/sofascore/fetch_upcoming_lineups.py --game-id 14023928
  python3 tools/sofascore/fetch_upcoming_lineups.py --dry

Future integration:
  * Wire into refresh-all.mjs as Phase 7
  * Add lineup_quality_diff to dev03-features.ts via TS-port
  * Surface "Confirmed XI" / "Predicted XI" badge in /matchday
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

# Reuse Webshare infra from existing fetcher
sys.path.insert(0, str(Path(__file__).parent))
from fetch_match_extras import (
    WEBSHARE_PROXIES_VERIFIED, WEBSHARE_RES_USER, WEBSHARE_RES_PASS,
    SOFASCORE_BASE, BlockedError, _get, make_session,
)

ROOT = Path(__file__).resolve().parents[2]
LOCAL_DB = ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
OUTPUT_JSON = ROOT / "tools" / "sofascore" / "data" / "lineups_upcoming.json"


def ensure_table(conn: sqlite3.Connection) -> None:
    """Create sofascore_lineups_cache table if missing."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sofascore_lineups_cache (
            game_id          INTEGER PRIMARY KEY,
            fetched_at       INTEGER NOT NULL,           -- unix epoch seconds
            kickoff_unix     INTEGER,
            league           TEXT,
            home_team        TEXT,
            away_team        TEXT,
            home_formation   TEXT,
            away_formation   TEXT,
            home_starters    TEXT,   -- JSON array of player names
            away_starters    TEXT,   -- JSON array of player names
            confirmed        INTEGER NOT NULL DEFAULT 0,  -- 1 if Sofa confirms
            raw_json         TEXT NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_lineups_kickoff "
        "ON sofascore_lineups_cache (kickoff_unix)"
    )
    conn.commit()


def upcoming_games(conn: sqlite3.Connection, hours_ahead: int) -> list[dict]:
    """Get matches starting within `hours_ahead` hours from now."""
    now = int(time.time())
    horizon = now + hours_ahead * 3600
    rows = conn.execute("""
        SELECT game_id, league, season, home_team, away_team, start_timestamp
        FROM sofascore_match
        WHERE status = 'Not started'
          AND start_timestamp BETWEEN ? AND ?
        ORDER BY start_timestamp
    """, (now, horizon)).fetchall()
    cols = ("game_id", "league", "season", "home_team", "away_team", "start_timestamp")
    return [dict(zip(cols, r)) for r in rows]


def parse_lineups(raw: dict) -> dict:
    """Extract starting XI + formation per team."""
    out = {
        "home_formation": None, "away_formation": None,
        "home_starters": [], "away_starters": [],
        "confirmed": int(raw.get("confirmed", False)),
    }
    for side in ("home", "away"):
        team_obj = raw.get(side) or {}
        out[f"{side}_formation"] = team_obj.get("formation")
        players = team_obj.get("players") or []
        starters = [p.get("player", {}).get("name") for p in players if not p.get("substitute")]
        out[f"{side}_starters"] = [n for n in starters if n]
    return out


def fetch_one(http, game: dict) -> dict | None:
    """Fetch one game's lineups. Returns parsed dict or None on failure."""
    gid = game["game_id"]
    url = f"{SOFASCORE_BASE}/event/{gid}/lineups"
    try:
        raw = _get(http, url)
    except BlockedError as e:
        print(f"  ✗ {gid}: blocked ({e})", flush=True)
        return None
    if not raw:
        return None
    parsed = parse_lineups(raw)
    parsed["raw_json"] = json.dumps(raw, separators=(",", ":"))
    return parsed


def write_cache(conn: sqlite3.Connection, game: dict, parsed: dict) -> None:
    conn.execute("""
        INSERT INTO sofascore_lineups_cache
          (game_id, fetched_at, kickoff_unix, league, home_team, away_team,
           home_formation, away_formation, home_starters, away_starters,
           confirmed, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
          fetched_at = excluded.fetched_at,
          home_formation = excluded.home_formation,
          away_formation = excluded.away_formation,
          home_starters = excluded.home_starters,
          away_starters = excluded.away_starters,
          confirmed = excluded.confirmed,
          raw_json = excluded.raw_json
    """, (
        game["game_id"], int(time.time()), game["start_timestamp"],
        game["league"], game["home_team"], game["away_team"],
        parsed["home_formation"], parsed["away_formation"],
        json.dumps(parsed["home_starters"]),
        json.dumps(parsed["away_starters"]),
        parsed["confirmed"], parsed["raw_json"],
    ))
    conn.commit()


def export_snapshot(conn: sqlite3.Connection) -> None:
    """Dump current cache as JSON for engine-side reads."""
    rows = conn.execute("""
        SELECT game_id, fetched_at, kickoff_unix, league, home_team, away_team,
               home_formation, away_formation, home_starters, away_starters,
               confirmed
        FROM sofascore_lineups_cache
        WHERE kickoff_unix > ?
        ORDER BY kickoff_unix
    """, (int(time.time()) - 3600,)).fetchall()
    cols = ("game_id", "fetched_at", "kickoff_unix", "league", "home_team",
            "away_team", "home_formation", "away_formation",
            "home_starters", "away_starters", "confirmed")
    snapshot = []
    for r in rows:
        d = dict(zip(cols, r))
        d["home_starters"] = json.loads(d["home_starters"] or "[]")
        d["away_starters"] = json.loads(d["away_starters"] or "[]")
        snapshot.append(d)
    OUTPUT_JSON.write_text(json.dumps({
        "generated_at": int(time.time()),
        "n_games": len(snapshot),
        "games": snapshot,
    }, indent=2))
    print(f"  ✓ snapshot: {len(snapshot)} games → {OUTPUT_JSON.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours-ahead", type=int, default=48,
                    help="Pull games starting within N hours (default 48)")
    ap.add_argument("--game-id", type=int, help="Single game (debug)")
    ap.add_argument("--max", type=int, default=0, help="Cap pending games")
    ap.add_argument("--pace", type=float, default=1.5)
    ap.add_argument("--use-webshare", action="store_true",
                    help="Force Webshare proxy (skip Mac-IP direct attempt)")
    ap.add_argument("--block-threshold", type=int, default=3,
                    help="Switch to Webshare after N consecutive BlockedErrors (default 3)")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(LOCAL_DB)
    ensure_table(conn)

    if args.game_id:
        games = [{"game_id": args.game_id, "league": "?", "season": "?",
                  "home_team": "?", "away_team": "?", "start_timestamp": 0}]
    else:
        games = upcoming_games(conn, args.hours_ahead)
        if args.max > 0:
            games = games[:args.max]

    print(f"Upcoming lineup fetch · {len(games)} games in next {args.hours_ahead}h")
    if args.dry:
        for g in games[:10]:
            kt = time.strftime("%Y-%m-%d %H:%M", time.gmtime(g["start_timestamp"]))
            print(f"  {g['game_id']}  {kt}  {g['league']:<14}  {g['home_team']} vs {g['away_team']}")
        if len(games) > 10:
            print(f"  … and {len(games) - 10} more")
        return

    # Default: Mac-IP-direct (curl_cffi chrome124, no proxy). CF unblocked
    # as of 2026-05-26 — verified across all 7 Sofa endpoints. Webshare
    # is opt-in fallback for when CF re-enables the block.
    use_webshare = args.use_webshare
    if use_webshare:
        print("  ⚙ Mode: Webshare proxy (forced via --use-webshare)")
    else:
        print("  ⚙ Mode: Mac-IP direct (CF-unblocked since 2026-05-26)")
    http = make_session(use_tor=False, use_webshare=use_webshare, use_tls_requests=False)

    pulled = blocked = empty = 0
    consecutive_blocked = 0
    t0 = time.time()
    for i, g in enumerate(games, 1):
        parsed = fetch_one(http, g)
        if parsed is None:
            blocked += 1
            consecutive_blocked += 1
            # Auto-fallback: if Mac-IP starts getting blocked, swap to
            # Webshare and retry. Only fires once per run (use_webshare flips).
            if not use_webshare and consecutive_blocked >= args.block_threshold:
                print(f"  ⚠ {consecutive_blocked} consecutive blocks — switching to Webshare proxy",
                      flush=True)
                use_webshare = True
                http = make_session(use_tor=False, use_webshare=True, use_tls_requests=False)
                consecutive_blocked = 0
            continue
        consecutive_blocked = 0  # reset on any success
        if not parsed["home_starters"] and not parsed["away_starters"]:
            empty += 1
            kt = time.strftime("%H:%M", time.gmtime(g["start_timestamp"]))
            print(f"  [{i}/{len(games)}] {g['game_id']}  {kt}  EMPTY (lineups not yet released)")
            continue
        write_cache(conn, g, parsed)
        pulled += 1
        kt = time.strftime("%H:%M", time.gmtime(g["start_timestamp"]))
        n_h = len(parsed["home_starters"])
        n_a = len(parsed["away_starters"])
        conf = "confirmed" if parsed["confirmed"] else "predicted"
        print(f"  [{i}/{len(games)}] {g['game_id']}  {kt}  {g['home_team'][:18]:18} vs {g['away_team'][:18]:18}  XI={n_h}/{n_a} ({conf})")
        time.sleep(args.pace)

    elapsed = time.time() - t0
    mode_used = "Webshare" if use_webshare else "Mac-IP direct"
    print(f"\n━ Done in {elapsed:.0f}s: {pulled} fetched, {empty} empty, {blocked} blocked · final mode: {mode_used}")

    export_snapshot(conn)


if __name__ == "__main__":
    main()

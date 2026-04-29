#!/usr/bin/env python3
"""
FODZE — load Sofascore shot JSONs into Supabase `sofascore_shotmap`.

Reads `tools/sofascore/data/<league>_<season>.json` files produced by
fetch_shots.py and bulk-inserts via PostgREST. UNIQUE
(game_id, COALESCE(player_id,0), minute, COALESCE(shot_type,''))
guarantees idempotent re-loads.

Usage:
  # Single league
  python3 tools/sofascore/load_to_supabase.py --league bundesliga --season 25/26

  # All JSONs in data/ dir
  python3 tools/sofascore/load_to_supabase.py --all

  # Dry-run (count what would be inserted, no write)
  python3 tools/sofascore/load_to_supabase.py --all --dry
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Iterable

# stdlib HTTP — no third-party needed (Supabase PostgREST is JSON-over-HTTPS)
import urllib.request
import urllib.error

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "tools" / "sofascore" / "data"


def load_env():
    """Read repo's .env.local so we don't need an external loader."""
    env_path = REPO_ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


load_env()
SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local", file=sys.stderr)
    sys.exit(1)


def is_real(v):
    if v is None:
        return False
    if isinstance(v, float) and math.isnan(v):
        return False
    return True


def to_real_or_none(v):
    return v if is_real(v) else None


def project_match(m: dict, league: str) -> dict:
    """Map a datafc match record to the sofascore_match row shape."""
    def _i(v):
        try:
            return int(v) if is_real(v) else None
        except (TypeError, ValueError):
            return None
    return {
        "game_id":         int(m["game_id"]),
        "league":          league,
        "season":          str(m.get("season") or ""),
        "week":            int(m.get("week") or 0),
        "home_team":       str(m.get("home_team") or ""),
        "home_team_id":    int(m.get("home_team_id") or 0),
        "away_team":       str(m.get("away_team") or ""),
        "away_team_id":    int(m.get("away_team_id") or 0),
        "home_score":      _i(m.get("home_score_current")),
        "away_score":      _i(m.get("away_score_current")),
        "start_timestamp": _i(m.get("start_timestamp")),
        "status":          str(m.get("status") or "")[:50] or None,
    }


def project_shot(s: dict, league: str) -> dict:
    """Map a datafc shot record to our Supabase row shape."""
    return {
        "game_id":        int(s["game_id"]),
        "league":         league,
        "season":         str(s.get("season") or ""),
        "week":           int(s.get("week") or 0),
        # NOT NULL columns with defaults — match the UNIQUE dedup key
        "player_id":      int(s["player_id"]) if is_real(s.get("player_id")) else 0,
        "shot_type":      s.get("shot_type") or "",
        "minute":         int(s["time"]) if is_real(s.get("time")) else 0,
        "time_seconds":   int(s["time_seconds"]) if is_real(s.get("time_seconds")) else 0,
        # Nullable
        "player_name":    s.get("player_name"),
        "player_position": s.get("player_position"),
        "is_home":        bool(s.get("is_home")),
        "xg":             to_real_or_none(s.get("xg")),
        "xgot":           to_real_or_none(s.get("xgot")),
        "body_part":      s.get("body_part"),
        "situation":      s.get("situation"),
        "goal_type":      s.get("goal_type"),
        "goal_mouth_location": s.get("goal_mouth_location"),
        "shooter_x":      to_real_or_none(s.get("player_coordinates_x")),
        "shooter_y":      to_real_or_none(s.get("player_coordinates_y")),
        "goal_mouth_x":   to_real_or_none(s.get("goal_mouth_coordinates_x")),
        "goal_mouth_y":   to_real_or_none(s.get("goal_mouth_coordinates_y")),
        "goal_mouth_z":   to_real_or_none(s.get("goal_mouth_coordinates_z")),
        "added_minute":   to_real_or_none(s.get("added_time")),
    }


def supa_upsert_chunk(rows: list[dict], table: str, on_conflict: str, dry: bool = False) -> tuple[int, int]:
    """Returns (inserted_count, error_count). Idempotent via UNIQUE constraint."""
    if not rows:
        return 0, 0
    if dry:
        return len(rows), 0

    body = json.dumps(rows).encode("utf-8")
    url = f"{SUPA_URL}/rest/v1/{table}?on_conflict={on_conflict}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": SUPA_KEY,
            "Authorization": f"Bearer {SUPA_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status in (200, 201, 204):
                return len(rows), 0
            return 0, len(rows)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"    HTTP {e.code} on {table}: {body}", file=sys.stderr)
        return 0, len(rows)
    except Exception as e:
        print(f"    {type(e).__name__}: {e}", file=sys.stderr)
        return 0, len(rows)


def derive_league_from_filename(path: Path) -> str:
    """`bundesliga_25-26.json` → 'bundesliga'"""
    stem = path.stem  # 'bundesliga_25-26'
    return stem.rsplit("_", 1)[0]


def _dedup(rows: list[dict], key_fn) -> list[dict]:
    seen = set()
    out = []
    for r in rows:
        k = key_fn(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def load_file(path: Path, *, dry: bool, chunk_size: int = 500) -> None:
    league = derive_league_from_filename(path)
    data = json.loads(path.read_text())
    raw_shots = data.get("shots", [])
    raw_matches = data.get("matches", [])
    print(f"\n📦 {path.name}  league={league}  shots={len(raw_shots):,}  matches={len(raw_matches):,}")

    # ── Matches first (PK = game_id) so JOINs always resolve
    if raw_matches:
        match_rows = _dedup(
            [project_match(m, league) for m in raw_matches],
            lambda r: r["game_id"],
        )
        m_ins, m_err = 0, 0
        for i in range(0, len(match_rows), chunk_size):
            chunk = match_rows[i : i + chunk_size]
            ins, err = supa_upsert_chunk(chunk, "sofascore_match", "game_id", dry=dry)
            m_ins += ins
            m_err += err
        print(f"  matches: {m_ins}/{len(match_rows)} (errors: {m_err})")
    else:
        print(f"  matches: skipped (no `matches` field in JSON — backfill via fill_matches.py)")

    # ── Shots
    rows = []
    skipped = 0
    for s in raw_shots:
        try:
            rows.append(project_shot(s, league))
        except Exception as e:
            skipped += 1
            print(f"    ⚠ shot skipped ({type(e).__name__}): {e}", file=sys.stderr)
    if skipped:
        print(f"  skipped {skipped} malformed rows")

    # Pre-dedup against the UNIQUE constraint key. PostgreSQL aborts the
    # entire ON CONFLICT batch on the first intra-batch dup ("cannot affect
    # row a second time") — so a 500-row chunk with 1 dup loses all 500.
    rows = _dedup(rows, lambda r: (r["game_id"], r["player_id"], r["time_seconds"], r["shot_type"]))
    raw_n = len(raw_shots)
    if len(rows) < raw_n - skipped:
        print(f"  pre-dedup: {raw_n - skipped - len(rows)} duplicates removed")

    inserted, errors = 0, 0
    t0 = time.time()
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        ins, err = supa_upsert_chunk(chunk, "sofascore_shotmap",
                                     "game_id,player_id,time_seconds,shot_type", dry=dry)
        inserted += ins
        errors += err
        sys.stdout.write(f"\r  {'[DRY] ' if dry else ''}shots: {inserted}/{len(rows)} (errors: {errors})")
        sys.stdout.flush()
    elapsed = time.time() - t0
    print(f"\n✓ {league}: shots={inserted}/{len(rows)} in {elapsed:.1f}s")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--league", help="single league (e.g. bundesliga)")
    p.add_argument("--season", default="25/26",
                   help="season label, used only with --league (default 25/26)")
    p.add_argument("--all", action="store_true",
                   help="load every JSON in data/ dir")
    p.add_argument("--dry", action="store_true")
    args = p.parse_args()

    if not (args.league or args.all):
        p.error("use --league NAME or --all")

    if args.league:
        season_safe = args.season.replace("/", "-")
        path = DATA_DIR / f"{args.league}_{season_safe}.json"
        if not path.exists():
            print(f"ERROR: {path} not found", file=sys.stderr)
            sys.exit(1)
        load_file(path, dry=args.dry)
    else:
        files = sorted(DATA_DIR.glob("*.json"))
        if not files:
            print(f"No JSONs in {DATA_DIR}", file=sys.stderr)
            sys.exit(1)
        print(f"Found {len(files)} files")
        for f in files:
            load_file(f, dry=args.dry)


if __name__ == "__main__":
    main()

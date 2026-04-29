#!/usr/bin/env python3
"""
FODZE — Sofascore shot-event fetcher

Pulls per-shot event data (xG, location, body part, situation, outcome,
player, time) for one or more leagues / weeks via the `datafc` library
(curl_cffi-based, bypasses Cloudflare without a headless browser).

PoC mode: writes one JSON file per league-season under
`tools/sofascore/data/`. Once the schema is validated against an actual
Supabase migration, switch the writer to insert into `sofascore_shotmap`.

Usage:
  # Single league + season + single week (~10s, ~30 KB output)
  python3 tools/sofascore/fetch_shots.py --league bundesliga --season 25/26 --week 30

  # Single league, all weeks of current season (~40s, ~1.5 MB)
  python3 tools/sofascore/fetch_shots.py --league bundesliga --season 25/26 --all-weeks

  # All Tier-A leagues, current season (~10 min)
  python3 tools/sofascore/fetch_shots.py --tier A --season 25/26 --all-weeks

  # Dry-run — show what would be fetched, no writes
  python3 tools/sofascore/fetch_shots.py --league epl --all-weeks --dry

Env: requires the FODZE venv with datafc installed:
  /Users/vonlinck/Desktop/fodze-app-master/tools/venv/bin/pip install datafc

Resume: re-running the same command skips weeks whose JSON already exists
(check `--force` to overwrite).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterable

# Lib
from curl_cffi import requests as cf_requests
from datafc import match_data, shots_data

# Local mapping
sys.path.insert(0, str(Path(__file__).parent))
from tournament_ids import TOURNAMENT_IDS, TIER_A, TIER_B  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "tools" / "sofascore" / "data"

# ─── Sofascore season-id resolver ──────────────────────────────────

_SEASON_CACHE: dict[int, dict[str, int]] = {}


def resolve_season_id(tournament_id: int, season_label: str, *, http_session) -> int | None:
    """Map a season label like '25/26' or '2024' to Sofascore's internal season ID.

    Sofascore returns season records with a `year` field that's already
    formatted as '25/26' (cup format) or '2024' (single-year format), so
    we match by exact string.
    """
    if tournament_id in _SEASON_CACHE:
        cache_hit = _SEASON_CACHE[tournament_id].get(season_label)
        if cache_hit is not None:
            return cache_hit

    r = http_session.get(
        f"https://api.sofascore.com/api/v1/unique-tournament/{tournament_id}/seasons",
        timeout=15,
    )
    if r.status_code != 200:
        print(f"  ⚠ season list HTTP {r.status_code} for tournament {tournament_id}")
        return None
    seasons = r.json().get("seasons", [])
    by_year = {s["year"]: s["id"] for s in seasons}
    _SEASON_CACHE[tournament_id] = by_year
    return by_year.get(season_label)


# ─── Per-week fetcher ──────────────────────────────────────────────

_MATCH_FIELDS = (
    "country", "tournament", "season", "week",
    "game_id", "home_team", "home_team_id", "away_team", "away_team_id",
    "home_score_current", "away_score_current",
    "start_timestamp", "status",
)


def fetch_week(tournament_id: int, season_id: int, week: int) -> tuple[list[dict], list[dict]]:
    """Returns (match_dicts, shot_dicts) for a single matchday."""
    matches = match_data(
        tournament_id=tournament_id,
        season_id=season_id,
        week_number=week,
    )
    if matches is None or len(matches) == 0:
        return [], []
    # Keep only the columns we actually persist (datafc returns ~30 cols)
    keep = [c for c in _MATCH_FIELDS if c in matches.columns]
    match_records = matches[keep].to_dict("records")
    try:
        shots = shots_data(match_df=matches)
    except Exception as e:
        # Some weeks have matches but Sofascore hasn't yet indexed shots
        # (fixtures kicked off in the last few hours). datafc raises
        # DataNotAvailableError — propagate to caller for logging.
        raise
    shot_records = [] if shots is None or len(shots) == 0 else shots.to_dict("records")
    return match_records, shot_records


# ─── Per-league orchestration ──────────────────────────────────────

def output_path(league: str, season_label: str) -> Path:
    safe_season = season_label.replace("/", "-")
    return DATA_DIR / f"{league}_{safe_season}.json"


def existing_weeks(path: Path) -> set[int]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text())
        return {int(w) for w in data.get("weeks_done", [])}
    except Exception:
        return set()


def append_week(path: Path, week: int, shots: list[dict], matches: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists():
        data = json.loads(path.read_text())
    else:
        data = {"shots": [], "matches": [], "weeks_done": [], "match_counts": {}}
    # Backwards-compat: older JSONs lack `matches` key
    if "matches" not in data:
        data["matches"] = []
    data["shots"].extend(shots)
    data["matches"].extend(matches)
    data["weeks_done"] = sorted(set(data["weeks_done"]) | {week})
    data["match_counts"][str(week)] = len(matches)
    path.write_text(json.dumps(data, default=str, separators=(",", ":")))


def fetch_league(
    league: str,
    season_label: str,
    *,
    weeks: Iterable[int] | None,
    force: bool,
    dry: bool,
    pace_seconds: float,
    http_session,
) -> None:
    tid = TOURNAMENT_IDS.get(league)
    if tid is None:
        print(f"⚠ unknown league: {league}")
        return

    sid = resolve_season_id(tid, season_label, http_session=http_session)
    if sid is None:
        print(f"⚠ {league}: season '{season_label}' not found in Sofascore catalogue")
        return

    out = output_path(league, season_label)
    done = set() if force else existing_weeks(out)

    weeks_iter = list(weeks) if weeks else list(range(1, 39))
    todo = [w for w in weeks_iter if w not in done]

    print(f"📊 {league} season={season_label} (sofascore_id={sid})  "
          f"weeks={len(weeks_iter)} todo={len(todo)} done={len(done)}")
    if dry:
        print(f"  [DRY] would fetch weeks: {todo[:10]}{'...' if len(todo) > 10 else ''}")
        return

    total_shots = 0
    total_matches = 0
    for w in todo:
        try:
            matches, shots = fetch_week(tid, sid, w)
        except Exception as e:
            msg = str(e)
            if "404" in msg:
                # week not yet played / out of range — quietly skip
                print(f"  week {w:>2}: 404 (not played yet)")
                continue
            print(f"  week {w:>2}: ERROR {type(e).__name__}: {e}")
            continue

        if not matches:
            print(f"  week {w:>2}: 0 matches (TBD?)")
            continue

        total_shots += len(shots)
        total_matches += len(matches)
        append_week(out, w, shots, matches)
        print(f"  week {w:>2}: {len(matches)} matches · {len(shots):>4} shots")
        time.sleep(pace_seconds)

    print(f"✓ {league}: +{total_matches} matches, +{total_shots} shots → {out.relative_to(REPO_ROOT)}")


# ─── CLI ───────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Fetch Sofascore shot events into JSON")
    p.add_argument("--league", help="single FODZE league key (e.g. bundesliga)")
    p.add_argument("--tier", choices=["A", "B"], help="all leagues in this tier")
    p.add_argument("--season", default="25/26",
                   help="Sofascore season label (default '25/26')")
    p.add_argument("--week", type=int, help="single week (default: skip if --all-weeks not set)")
    p.add_argument("--all-weeks", action="store_true",
                   help="iterate weeks 1-38 (skip already-fetched weeks)")
    p.add_argument("--force", action="store_true", help="overwrite already-fetched weeks")
    p.add_argument("--dry", action="store_true", help="show plan, no writes")
    p.add_argument("--pace", type=float, default=0.6,
                   help="seconds between week fetches (default 0.6)")
    args = p.parse_args()

    if not (args.league or args.tier):
        p.error("must give --league or --tier")
    if args.league and args.tier:
        p.error("--league and --tier are exclusive")
    if not (args.week or args.all_weeks):
        p.error("must give --week N or --all-weeks")

    weeks = [args.week] if args.week else None

    leagues = [args.league] if args.league else (TIER_A if args.tier == "A" else TIER_B)

    http = cf_requests.Session(impersonate="chrome124")

    for lg in leagues:
        fetch_league(
            lg, args.season,
            weeks=weeks,
            force=args.force,
            dry=args.dry,
            pace_seconds=args.pace,
            http_session=http,
        )


if __name__ == "__main__":
    main()

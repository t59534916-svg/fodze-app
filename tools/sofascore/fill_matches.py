#!/usr/bin/env python3
"""
One-shot: walk every `tools/sofascore/data/<league>_<season>.json` that
was produced before fetch_shots.py persisted the `matches` field, and
add it now via a per-(league, week) datafc.match_data() call.

Skips JSONs that already have a non-empty `matches` field.

Usage:
  python3 tools/sofascore/fill_matches.py            # all data files
  python3 tools/sofascore/fill_matches.py --league bundesliga
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from datafc import match_data
from curl_cffi import requests as cf_requests

sys.path.insert(0, str(Path(__file__).parent))
from tournament_ids import TOURNAMENT_IDS  # noqa: E402
from fetch_shots import resolve_season_id, output_path, _MATCH_FIELDS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "tools" / "sofascore" / "data"


def fill_one(path: Path, *, http_session, pace: float = 0.5) -> None:
    league, season_safe = path.stem.rsplit("_", 1)
    season = season_safe.replace("-", "/")
    data = json.loads(path.read_text())

    if data.get("matches"):
        print(f"⏭  {path.name} already has {len(data['matches'])} matches — skip")
        return

    tid = TOURNAMENT_IDS.get(league)
    if tid is None:
        print(f"⚠ unknown league: {league}")
        return
    sid = resolve_season_id(tid, season, http_session=http_session)
    if sid is None:
        print(f"⚠ {league}: cannot resolve season {season}")
        return

    weeks = sorted({int(w) for w in data.get("match_counts", {}).keys()})
    print(f"📅 {league} {season} (sofascore_id={sid}) — fetching matches for {len(weeks)} weeks")

    all_matches = []
    for w in weeks:
        try:
            matches = match_data(tournament_id=tid, season_id=sid, week_number=w)
        except Exception as e:
            print(f"  week {w:>2}: ERROR {type(e).__name__}: {e}")
            continue
        if matches is None or len(matches) == 0:
            continue
        keep = [c for c in _MATCH_FIELDS if c in matches.columns]
        all_matches.extend(matches[keep].to_dict("records"))
        print(f"  week {w:>2}: {len(matches)} matches")
        time.sleep(pace)

    data["matches"] = all_matches
    path.write_text(json.dumps(data, default=str, separators=(",", ":")))
    print(f"✓ {league}: persisted {len(all_matches)} matches → {path.name}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--league", help="single league key")
    args = p.parse_args()

    files = sorted(DATA_DIR.glob("*.json"))
    if args.league:
        files = [f for f in files if f.stem.startswith(f"{args.league}_")]
    if not files:
        print(f"No files matched", file=sys.stderr)
        sys.exit(1)

    http = cf_requests.Session(impersonate="chrome124")
    for f in files:
        fill_one(f, http_session=http)


if __name__ == "__main__":
    main()

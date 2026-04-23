#!/usr/bin/env python3
"""
FODZE — StatsBomb Open Data Downloader

Downloads selected competition-seasons from the StatsBomb Open Data
GitHub repo (https://github.com/statsbomb/open-data). Files are cached
locally under `tools/statsbomb/data/` and the script is resumable
(skips files that already exist on disk).

Priority set (~1800 matches, ~600 MB):
  1. Bundesliga 2023/24 + 2015/16
  La Liga 2020/21 + 2019/20 (Messi-era peak)
  Premier League 2015/16
  Serie A 2015/16
  Ligue 1 2022/23
  Champions League 2018/19
  FIFA WM 2022 + 2018
  UEFA Euro 2024 + 2020

Usage:
  python3 tools/statsbomb/download.py                # all priority comps
  python3 tools/statsbomb/download.py --only bl_2324 # single slug
  python3 tools/statsbomb/download.py --dry          # show what would download

Rate-limit: 100ms between requests → ~10 r/s, well under GitHub's ~5000/h
unauthenticated cap on raw.githubusercontent.com.

License: StatsBomb Open Data is released for non-commercial research
(their EULA at open-data/LICENSE.pdf). Keep the downloaded files local.
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"
TOOL_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.join(TOOL_ROOT, "data")

# Priority competition-seasons for FODZE's shot-location-xG training.
PRIORITY = {
    "bl_2324":       {"competition_id": 9,  "season_id": 281, "label": "Bundesliga 2023/24"},
    "bl_1516":       {"competition_id": 9,  "season_id": 27,  "label": "Bundesliga 2015/16"},
    "la_liga_2021":  {"competition_id": 11, "season_id": 90,  "label": "La Liga 2020/21"},
    "la_liga_1920":  {"competition_id": 11, "season_id": 42,  "label": "La Liga 2019/20"},
    "epl_1516":      {"competition_id": 2,  "season_id": 27,  "label": "Premier League 2015/16"},
    "sa_1516":       {"competition_id": 12, "season_id": 27,  "label": "Serie A 2015/16"},
    "l1_2223":       {"competition_id": 7,  "season_id": 235, "label": "Ligue 1 2022/23"},
    "ucl_1819":      {"competition_id": 16, "season_id": 4,   "label": "Champions League 2018/19"},
    "wc_2022":       {"competition_id": 43, "season_id": 106, "label": "FIFA WC 2022"},
    "wc_2018":       {"competition_id": 43, "season_id": 3,   "label": "FIFA WC 2018"},
    "euro_2024":     {"competition_id": 55, "season_id": 282, "label": "UEFA Euro 2024"},
    "euro_2020":     {"competition_id": 55, "season_id": 43,  "label": "UEFA Euro 2020"},
}

DELAY_SEC = 0.10  # 10 r/s

def fetch(url: str) -> bytes:
    """HTTP GET. Polite UA, 5-tier retry-on-429/5xx."""
    headers = {
        "User-Agent": "FODZE-Research/1.0 (non-commercial academic use)",
        "Accept": "application/json",
    }
    last_err = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                wait = 2 ** attempt
                print(f"  retry #{attempt+1} after {wait}s (HTTP {e.code})")
                time.sleep(wait)
                last_err = e
                continue
            raise
        except Exception as e:
            last_err = e
            time.sleep(1)
    raise RuntimeError(f"fetch failed after retries: {url} — {last_err}")


def download_file(url: str, path: str, dry: bool) -> bool:
    """Download a single file; True if file was written (False = cached/skip)."""
    if os.path.exists(path):
        return False
    if dry:
        print(f"  [DRY] would download {url} → {path}")
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = fetch(url)
    with open(path, "wb") as f:
        f.write(data)
    time.sleep(DELAY_SEC)
    return True


def download_competition(slug: str, cfg: dict, dry: bool):
    cid, sid, label = cfg["competition_id"], cfg["season_id"], cfg["label"]
    print(f"\n━━━ {slug}: {label} (comp={cid}, season={sid}) ━━━")

    # 1. matches/{cid}/{sid}.json (list of matches in this comp-season)
    matches_url = f"{BASE}/matches/{cid}/{sid}.json"
    matches_path = os.path.join(DATA_ROOT, "matches", str(cid), f"{sid}.json")
    try:
        did_dl = download_file(matches_url, matches_path, dry)
        if did_dl and not dry:
            print(f"  ✓ matches list → {matches_path}")
        elif not did_dl:
            print(f"  ~ matches list cached")
    except Exception as e:
        print(f"  ✗ matches list failed: {e}")
        return

    if dry and not os.path.exists(matches_path):
        print(f"  [DRY] would continue downloading events for each match here.")
        return

    with open(matches_path) as f:
        matches = json.load(f)
    print(f"  {len(matches)} matches in this comp-season")

    # 2. Per match: events + lineups
    new = 0
    cached = 0
    failed = 0
    for i, m in enumerate(matches, 1):
        mid = m["match_id"]
        events_url = f"{BASE}/events/{mid}.json"
        events_path = os.path.join(DATA_ROOT, "events", f"{mid}.json")
        lineups_url = f"{BASE}/lineups/{mid}.json"
        lineups_path = os.path.join(DATA_ROOT, "lineups", f"{mid}.json")

        try:
            did_e = download_file(events_url, events_path, dry)
            did_l = download_file(lineups_url, lineups_path, dry)
            if did_e or did_l:
                new += 1
            else:
                cached += 1
        except Exception as e:
            failed += 1
            print(f"    ✗ match {mid}: {e}")

        if i % 20 == 0:
            print(f"  progress: {i}/{len(matches)} · new={new} cached={cached} failed={failed}")

    print(f"  done: {new} new, {cached} cached, {failed} failed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="Comma-sep slug filter (e.g. 'bl_2324,wc_2022')")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    slugs = sorted(PRIORITY.keys())
    if args.only:
        wanted = set(s.strip() for s in args.only.split(","))
        slugs = [s for s in slugs if s in wanted]
        missing = wanted - set(slugs)
        if missing:
            print(f"Unknown slugs: {missing}")
            print(f"Available: {sorted(PRIORITY.keys())}")
            sys.exit(1)

    total_matches_est = {
        "bl_2324": 306, "bl_1516": 306, "la_liga_2021": 380, "la_liga_1920": 380,
        "epl_1516": 380, "sa_1516": 380, "l1_2223": 380, "ucl_1819": 125,
        "wc_2022": 64, "wc_2018": 64, "euro_2024": 51, "euro_2020": 51,
    }
    est = sum(total_matches_est.get(s, 300) for s in slugs)
    print(f"Priority set: {len(slugs)} comp-seasons · ~{est} matches est.")
    print(f"Est. bandwidth: ~{est * 0.4:.0f} MB")
    if args.dry:
        print("(DRY-RUN — no files written)\n")
    else:
        print(f"(LIVE — writing to {DATA_ROOT}/)\n")

    for slug in slugs:
        download_competition(slug, PRIORITY[slug], args.dry)

    # Summary of local data
    if not args.dry:
        events_dir = os.path.join(DATA_ROOT, "events")
        if os.path.isdir(events_dir):
            n = len(os.listdir(events_dir))
            size_mb = sum(
                os.path.getsize(os.path.join(events_dir, f))
                for f in os.listdir(events_dir)
            ) / 1_000_000
            print(f"\n━━━ Summary ━━━")
            print(f"  {n} event files on disk · {size_mb:.1f} MB")


if __name__ == "__main__":
    main()

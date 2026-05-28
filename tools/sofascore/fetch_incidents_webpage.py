"""Fetch Sofa incidents via web-page SSR bundle (not blocked API endpoint).

Sofa's per-event page `https://www.sofascore.com/event/<id>` returns
HTTP 200 with the full SSR Next.js bundle. The `__NEXT_DATA__` script
tag contains `props.pageProps.initialProps.incidents` — exactly the
same payload as the api/v1/event/X/incidents endpoint.

Why this works while api.sofascore.com is CF-blocked:
- The web page must serve SEO crawlers + users with cookies
- It's hosted on a different CDN tier (less aggressive bot detection)
- The incidents data is pre-rendered server-side, no API call needed

Limits:
- Only incidents are embedded — statistics/lineups/managers/etc.
  are loaded client-side by JS (and would hit blocked api.sofascore.com)
- So this is a 1/7 endpoint solution

Usage:
    python3 tools/sofascore/fetch_incidents_webpage.py --season 22/23 --pace 1.0
    python3 tools/sofascore/fetch_incidents_webpage.py --max 100 --pace 0.5

Writes results to existing extras JSON files (merges into 'incidents' field).
Skips games whose JSON already has incidents data.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import curl_cffi.requests as cc

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _http_retry import get_with_retry  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "tools/sofascore/data/local_extras.db"
EXTRAS_DIR = ROOT / "tools/sofascore/data/extras"

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>',
    re.DOTALL,
)


def fetch_incidents(game_id: int, session: cc.Session) -> dict | None:
    """Return raw incidents-list dict or None on failure."""
    url = f"https://www.sofascore.com/event/{game_id}"
    try:
        # Retry transient 5xx / network blips; the outer except still degrades
        # to None on exhaustion (preserves "None on failure"). A 403 (CF) is
        # returned as-is → the != 200 guard skips it (no rotation on the free
        # Mac-IP SSR path).
        r = get_with_retry(
            session, url,
            impersonate="chrome124", timeout=15, allow_redirects=True,
            label=f"incidents {game_id}",
        )
        if r.status_code != 200 or len(r.content) < 50000:
            return None
        m = NEXT_DATA_RE.search(r.text)
        if not m:
            return None
        data = json.loads(m.group(1))
        incidents = (
            data.get("props", {})
            .get("pageProps", {})
            .get("initialProps", {})
            .get("incidents")
        )
        if incidents is None:
            return None
        # Wrap in dict matching api.sofascore.com/api/v1/event/X/incidents shape
        return {"incidents": incidents}
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="Fetch Sofa incidents via web-page SSR")
    ap.add_argument("--season", required=True, help="e.g. 22/23")
    ap.add_argument("--pace", type=float, default=1.0, help="seconds between requests")
    ap.add_argument("--max", type=int, default=0, help="cap games this run (0 = unlimited)")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    # Find games for this season that DON'T already have incidents
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT game_id FROM sofascore_match WHERE season = ? AND status = 'Ended' ORDER BY start_timestamp DESC",
        (args.season,),
    ).fetchall()
    all_ids = [r[0] for r in rows]
    print(f"Season {args.season}: {len(all_ids):,} ended games total")

    EXTRAS_DIR.mkdir(parents=True, exist_ok=True)

    # Filter: games whose JSON file is missing OR has no 'incidents' field
    pending = []
    for gid in all_ids:
        f = EXTRAS_DIR / f"{gid}.json"
        if not f.exists():
            pending.append(gid)
            continue
        try:
            data = json.loads(f.read_text())
            if not data.get("incidents"):
                pending.append(gid)
        except Exception:
            pending.append(gid)

    print(f"  Pending (no incidents yet): {len(pending):,}")
    if args.max > 0:
        pending = pending[: args.max]
        print(f"  Capped to: {len(pending):,}")

    if args.dry:
        print("DRY RUN — exiting.")
        return

    session = cc.Session(impersonate="chrome124")
    pulled = errored = 0
    start = time.time()
    for i, gid in enumerate(pending, 1):
        result = fetch_incidents(gid, session)
        if result is None:
            errored += 1
            print(f"  [{i}/{len(pending)}] {gid}  ✗ no incidents found")
        else:
            # Merge into existing JSON (or create new)
            f = EXTRAS_DIR / f"{gid}.json"
            if f.exists():
                try:
                    existing = json.loads(f.read_text())
                except Exception:
                    existing = {"game_id": gid}
            else:
                existing = {"game_id": gid}
            # Wrap in {"incidents": [...]} to match API endpoint format
            # (loader expects dict-shape; raw list breaks project_incidents()).
            existing["incidents"] = {"incidents": result["incidents"]}
            f.write_text(json.dumps(existing, separators=(",", ":")))
            pulled += 1
            if i % 25 == 0 or i == len(pending):
                rate = i / (time.time() - start)
                eta_s = (len(pending) - i) / rate if rate > 0 else 0
                print(f"  [{i}/{len(pending)}] {gid}  ✓  rate={rate:.1f}/s  eta={eta_s/60:.1f}min")
        if i < len(pending):
            time.sleep(args.pace)

    print(f"\n✓ Done: {pulled} pulled, {errored} errored")


if __name__ == "__main__":
    main()

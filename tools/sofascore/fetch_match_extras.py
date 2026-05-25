#!/usr/bin/env python3
"""
FODZE — Sofascore post-match extras fetcher

Pulls per-game stats/incidents/lineups/avg-positions for already-ended
matches (status='Ended' in `sofascore_match`). Forever-cache: once a
game's 4 endpoints are pulled successfully, never re-fetch.

Why direct curl_cffi calls instead of datafc: datafc only wraps
match_data + shots_data. The 4 endpoints we want here have no helper.

Endpoints (per game_id):
  /api/v1/event/{id}/statistics         → team-level stats (~40 cols × 3 periods)
  /api/v1/event/{id}/lineups            → starter XI + bench + per-player match stats
  /api/v1/event/{id}/incidents          → timeline (goals, cards, subs)
  /api/v1/event/{id}/average-positions  → tactical avg pitch positions

Output:
  tools/sofascore/data/extras/<game_id>.json    (1 file per game, all 4 payloads)

State tracking:
  Reads `sofascore_extras_state` to skip already-fully-pulled games.
  After a successful pull, the loader sets has_statistics/has_lineups/
  has_incidents/has_avg_positions = TRUE so next run skips it.

Anti-blocking:
  - curl_cffi impersonate=chrome124 (TLS fingerprint match)
  - Pace 1.5s between games (4 calls × 0.4s ~= 1.6s per game)
  - On 403/429: exponential backoff (60s, 5min, 30min) — abort after 3rd
  - On 404 (rare, e.g. game-id deleted): mark state as has_*=TRUE with empty
    payload so we don't keep retrying

Usage:
  # Single league, season 25/26
  python3 tools/sofascore/fetch_match_extras.py --league bundesliga --season 25/26

  # All Tier-A leagues
  python3 tools/sofascore/fetch_match_extras.py --tier A --season 25/26

  # Single game (debug)
  python3 tools/sofascore/fetch_match_extras.py --game-id 13037021

  # Limit batch size (rate-limit safety on first run)
  python3 tools/sofascore/fetch_match_extras.py --tier A --season 25/26 --max 200

  # Dry-run — list pending games, no fetches
  python3 tools/sofascore/fetch_match_extras.py --tier A --dry
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Iterable

# Lib
from curl_cffi import requests as cf_requests
# tls_requests = bogdanfinn/tls-client wrapper. Alternative TLS fingerprint
# (different from curl_cffi chrome124). Empirically passes CF blocks that
# curl_cffi gets 403'd on (verified 2026-05-10 — chrome124 was blocked on
# all 30 Webshare IPs while tls_requests from same IP returned HTTP 200).
import tls_requests

# Local mapping
sys.path.insert(0, str(Path(__file__).parent))
from tournament_ids import TOURNAMENT_IDS, TIER_A, TIER_B  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "tools" / "sofascore" / "data" / "extras"
SOFASCORE_BASE = "https://api.sofascore.com/api/v1"


# ─── env loader ────────────────────────────────────────────────────

def load_env():
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


# ─── DB helpers (read-only, write via loader) ──────────────────────

def fetch_pending_games(
    leagues: list[str],
    season: str,
    *,
    only_ended: bool = True,
    limit: int | None = None,
    skip_cached: bool = False,
    endpoints: tuple[str, ...] | None = None,
) -> list[dict]:
    """Returns games where extras are missing/incomplete.

    Joins sofascore_match LEFT JOIN sofascore_extras_state and filters
    for rows where any of the 4 has_* flags is FALSE (or state row missing).

    If skip_cached=True, ALSO filters out games whose JSON already exists on
    disk. Required when running with --no-supabase, where Supabase state-table
    doesn't reflect local cache progress (otherwise we'd return all-cached
    games and burn the whole limit on already-have-them work).
    """
    if not SUPA_URL or not SUPA_KEY:
        print("ERROR: missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local", file=sys.stderr)
        sys.exit(1)

    import urllib.request
    import urllib.parse

    # ── Strategy ────────────────────────────────────────────────────
    # Fetch sofascore_match rows in 1000-row pages (PostgREST default
    # page size, configurable up to 1000). For each page, batch-query
    # sofascore_extras_state for that page's game_ids, filter to truly
    # pending (state missing OR any has_* flag false), accumulate.
    # Stop when we have `limit` pending OR no more match rows.
    #
    # This replaces the previous "over-fetch limit*3 then filter" hack
    # which broke once >limit*3 games were already done — the page
    # of "earliest games" was full of done-state rows, and we never
    # paginated into the pending tail.
    PAGE_SIZE = 1000
    league_filter = "in.(" + ",".join(f'"{lg}"' for lg in leagues) + ")"

    def _fetch_match_page(offset: int) -> list[dict]:
        params = {
            "select": "game_id,league,season,start_timestamp,status,home_team,away_team",
            "league": league_filter,
            "season": f"eq.{season}",
            "order": "start_timestamp.asc",
        }
        if only_ended:
            params["status"] = "eq.Ended"
        qs = urllib.parse.urlencode(params, safe="(),\"")
        url = f"{SUPA_URL}/rest/v1/sofascore_match?{qs}"
        req = urllib.request.Request(
            url,
            headers={
                "apikey": SUPA_KEY,
                "Authorization": f"Bearer {SUPA_KEY}",
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + PAGE_SIZE - 1}",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())

    def _fetch_state_for(game_ids: list[str]) -> dict[int, dict]:
        out: dict[int, dict] = {}
        for i in range(0, len(game_ids), 200):
            chunk = game_ids[i : i + 200]
            params2 = {
                # v1 + v2 flags so pending-detection considers both endpoint families
                "select": (
                    "game_id,has_statistics,has_player_stats,has_incidents,has_avg_positions,"
                    "has_managers,has_pregame_form,has_team_streaks,attempt_count"
                ),
                "game_id": "in.(" + ",".join(chunk) + ")",
            }
            qs2 = urllib.parse.urlencode(params2, safe="(),")
            url2 = f"{SUPA_URL}/rest/v1/sofascore_extras_state?{qs2}"
            req2 = urllib.request.Request(
                url2,
                headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"},
            )
            try:
                with urllib.request.urlopen(req2, timeout=60) as resp:
                    for row in json.loads(resp.read().decode()):
                        out[int(row["game_id"])] = row
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    print(f"\n❌ sofascore_extras_state table missing — apply migration first:")
                    print(f"   scripts/migration-sofascore-extras.sql")
                    print(f"   (see Supabase SQL Editor)\n")
                    sys.exit(2)
                raise
        return out

    pending: list[dict] = []
    offset = 0
    pages_scanned = 0

    while True:
        match_rows = _fetch_match_page(offset)
        if not match_rows:
            break
        pages_scanned += 1

        game_ids = [str(r["game_id"]) for r in match_rows]
        state_by_game = _fetch_state_for(game_ids)

        for m in match_rows:
            gid = int(m["game_id"])
            st = state_by_game.get(gid)
            if st is not None:
                # State row exists — pending if ANY v1+v2 endpoint missing.
                # Existing rows that completed v1 but defaulted v2 flags to
                # FALSE during migration get correctly re-pended here.
                all_done = (
                    st["has_statistics"]
                    and st["has_player_stats"]
                    and st["has_incidents"]
                    and st["has_avg_positions"]
                    and st.get("has_managers", False)
                    and st.get("has_pregame_form", False)
                    and st.get("has_team_streaks", False)
                )
                if all_done:
                    continue
                # Cooldown: skip games with ≥3 failed attempts (manual reset needed)
                if (st.get("attempt_count") or 0) >= 3:
                    continue

            # Inline cache-filter (applies to both state-missing and incomplete-
            # state branches): skip if JSON already on disk AND has the
            # required endpoints populated. Required when running with
            # --no-supabase since state-table won't reflect local cache
            # progress. Updated 2026-05-25: only skip COMPLETE files (per
            # the requested endpoint subset), not partial ones (e.g. web-page
            # incidents-only JSONs from fetch_incidents_webpage.py should
            # NOT be marked complete when fetcher is asked to fill the others).
            if skip_cached:
                json_path = DATA_DIR / f"{gid}.json"
                if json_path.exists():
                    try:
                        d = json.loads(json_path.read_text())
                        required = endpoints if endpoints is not None else ALL_ENDPOINTS
                        if all(d.get(k) is not None for k in required):
                            continue
                    except Exception:
                        pass  # treat unreadable as not-cached → re-fetch

            pending.append(m)

            # Early exit once we have enough pending
            if limit and len(pending) >= limit:
                break

        # While-loop early exit
        if limit and len(pending) >= limit:
            break
        # End of pagination if last page was short
        if len(match_rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    if limit:
        pending = pending[:limit]
    return pending


# ─── HTTP fetcher ──────────────────────────────────────────────────

import signal


class BlockedError(RuntimeError):
    """Raised on 403/429 — caller should backoff."""


class HungError(RuntimeError):
    """Raised when SIGALRM fires (curl_cffi `timeout` proved unreliable in
    practice — sometimes hangs forever on partial Cloudflare responses)."""


def _alarm_handler(signum, frame):
    raise HungError("watchdog SIGALRM")


# Install once at module load; per-call we just toggle the alarm.
signal.signal(signal.SIGALRM, _alarm_handler)


def _get(http: cf_requests.Session, url: str, *, timeout: int = 15) -> dict | None:
    """Returns parsed JSON dict, None on 404, raises BlockedError on 403/429.

    Wrapped in SIGALRM watchdog: curl_cffi's own timeout has proven unreliable
    against slow-drip Cloudflare responses (observed 42min hang in production
    backfill). The watchdog forces a HungError after `timeout+5` seconds
    regardless of what curl_cffi is doing internally.
    """
    signal.alarm(timeout + 5)
    try:
        r = http.get(url, timeout=timeout)
    except HungError:
        # Don't escalate to backoff — single endpoint hung, skip it.
        # If the host is truly down, multiple hangs in a row will eventually
        # surface as 4-of-4-None payloads which fetch_pending logs as "0/4".
        signal.alarm(0)
        print(f"  ⚠ watchdog killed slow request: {url}", file=sys.stderr)
        return None
    except Exception as e:
        # Network errors, SSL hiccups — treat as 404 (skip silently).
        signal.alarm(0)
        print(f"  ⚠ {type(e).__name__} on {url}: {e}", file=sys.stderr)
        return None
    finally:
        signal.alarm(0)

    if r.status_code == 200:
        try:
            return r.json()
        except Exception as e:
            print(f"  ⚠ JSON-decode failed for {url}: {e}", file=sys.stderr)
            return None
    if r.status_code == 404:
        return None
    if r.status_code in (403, 429):
        raise BlockedError(f"HTTP {r.status_code} for {url}")
    print(f"  ⚠ HTTP {r.status_code} for {url}", file=sys.stderr)
    return None


# All 7 known per-event endpoints. Order matters only for display.
ALL_ENDPOINTS: tuple[str, ...] = (
    "statistics", "lineups", "incidents", "average_positions",
    "managers", "pregame_form", "team_streaks",
)


def fetch_game_extras(
    http: cf_requests.Session,
    game_id: int,
    endpoints: tuple[str, ...] | None = None,
) -> dict:
    """Returns dict with payload per endpoint (or None on 404).

    Endpoints (verified 2026-05-08 via Tor + chrome124 fingerprint):
      Phase 1 (v1, since 2026-05-07):
        statistics, lineups, incidents, average_positions
      Phase 2 (v2, added 2026-05-08 — HIGH-SIGNAL):
        managers       — homeManager + awayManager (id, name, slug)
        pregame_form   — avgRating, position, value, last-5 form
        team_streaks   — general (~8) + head2head (~5) entries

    Each value is the raw Sofascore JSON, or None on 404 (endpoint doesn't
    exist for that game — happens for some lower-league matches, or for
    games where Sofa's editorial pipeline didn't generate the summary).

    Pass `endpoints` to fetch a subset (e.g. for CF-pressure reduction —
    pulling 3 instead of 7 endpoints ~halves the api.sofascore.com hits
    per game and roughly doubles the games-per-proxy-pool burst before
    burnout). When None, all 7 are fetched (legacy behaviour).
    """
    targets = endpoints if endpoints is not None else ALL_ENDPOINTS
    url_map = {
        # v1 endpoints (forever-cache established, pulled for 736 games as of 2026-05-08)
        "statistics":         f"{SOFASCORE_BASE}/event/{game_id}/statistics",
        "lineups":            f"{SOFASCORE_BASE}/event/{game_id}/lineups",
        "incidents":          f"{SOFASCORE_BASE}/event/{game_id}/incidents",
        "average_positions":  f"{SOFASCORE_BASE}/event/{game_id}/average-positions",
        # v2 endpoints (HIGH-SIGNAL — added 2026-05-08, schema verified empirically)
        "managers":           f"{SOFASCORE_BASE}/event/{game_id}/managers",
        "pregame_form":       f"{SOFASCORE_BASE}/event/{game_id}/pregame-form",
        "team_streaks":       f"{SOFASCORE_BASE}/event/{game_id}/team-streaks",
    }
    return {k: _get(http, url_map[k]) for k in targets}


# ─── Per-game pull + persist ───────────────────────────────────────

def output_path(game_id: int) -> Path:
    return DATA_DIR / f"{game_id}.json"


def write_extras(game_id: int, game_meta: dict, payload: dict) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = output_path(game_id)
    # Forward-compatible: when an existing cache file is found (already
    # has v1 payloads), merge the v2 endpoints in without overwriting v1.
    # That way re-running with --use-tor on already-pulled games adds
    # managers/pregame_form/team_streaks without re-fetching v1.
    existing: dict = {}
    if p.exists():
        try:
            existing = json.loads(p.read_text())
        except Exception:
            existing = {}
    enriched = {
        **existing,  # preserve v1 payloads if present
        "game_id":       game_id,
        "league":        game_meta.get("league"),
        "season":        game_meta.get("season"),
        "home_team":     game_meta.get("home_team"),
        "away_team":     game_meta.get("away_team"),
        "fetched_at":    int(time.time()),
    }
    # Only update keys that the current pull provided non-None values for —
    # avoids overwriting a previously-cached payload with a None when an
    # endpoint returns 404 on a retry.
    for k in ("statistics", "lineups", "incidents", "average_positions",
              "managers", "pregame_form", "team_streaks"):
        v = payload.get(k)
        if v is not None or k not in existing:
            enriched[k] = v
    p.write_text(json.dumps(enriched, default=str, separators=(",", ":")))
    return p


def already_cached(
    game_id: int,
    endpoints: tuple[str, ...] | None = None,
) -> bool:
    """Returns True only if JSON exists AND has all required endpoints populated.

    Updated 2026-05-25: was naive `exists()` check, which incorrectly
    classified partial files (e.g. incidents-only from web-page fetcher)
    as fully cached. Now requires all required endpoint payloads to be non-None.

    Updated 2026-05-25 (slim-mode): when `endpoints` is given, only checks
    that subset — so running `--endpoints statistics,lineups,average_positions
    --skip-cached` correctly re-fetches games that have the v2-3 endpoints
    (managers/pregame_form/team_streaks) populated but lack one of the slim-3.
    """
    p = output_path(game_id)
    if not p.exists():
        return False
    try:
        d = json.loads(p.read_text())
        required = endpoints if endpoints is not None else ALL_ENDPOINTS
        return all(d.get(k) is not None for k in required)
    except Exception:
        return False


# ─── Backoff ───────────────────────────────────────────────────────

class BackoffState:
    SCHEDULE_SECS = [60, 300, 1800]  # 1min, 5min, 30min

    def __init__(self):
        self.consecutive_blocks = 0

    def hit(self) -> bool:
        """Returns True if we should keep trying, False if exhausted."""
        if self.consecutive_blocks >= len(self.SCHEDULE_SECS):
            return False
        wait = self.SCHEDULE_SECS[self.consecutive_blocks]
        jitter = random.uniform(0.8, 1.2)
        delay = wait * jitter
        print(f"  ⏸ blocked — sleeping {delay:.0f}s (attempt {self.consecutive_blocks + 1}/3)")
        time.sleep(delay)
        self.consecutive_blocks += 1
        return True

    def success(self):
        self.consecutive_blocks = 0


# ─── Session factory ──────────────────────────────────────────────
#
# When --use-tor is set, route everything through Tor's local SOCKS5
# proxy (default port 9050, set up via `brew install tor && brew services
# start tor`). Empirically verified 2026-05-08: chrome124 TLS fingerprint
# ALONE returns 403 from sofascore.com/api/* when the user's IP is
# Cloudflare-flagged. Same chrome124 fingerprint via Tor returns 200,
# because Tor exits aren't blanket-blocked — Cloudflare just applies
# stricter inspection that the chrome124 fingerprint passes.
#
# Caveats observed during empirical testing:
#   - Per-circuit rate limit hits at ~15 successive requests → use longer
#     pacing (4-6s) and recycle sessions more aggressively (every ~25 games)
#     to force a new Tor exit.
#   - SOCKS5h (the 'h' = remote DNS) is required so Sofa hostname resolves
#     via Tor, not via local DNS (which leaks our real IP).

TOR_PROXY = "socks5h://127.0.0.1:9050"

# ─── Webshare datacenter proxies (free tier) ─────────────────────
#
# Empirically verified 2026-05-09: Webshare datacenter IPs are NOT on
# Cloudflare's anti-Tor blocklist. Tested all 10 free proxies, 3/10
# returned HTTP 200 for /event/{id}/managers (the others 403 — Cloudflare
# has flagged some Webshare subnets but not all). Using only the 3 that
# WORK avoids burning quota on dead proxies.
#
# Re-validate any time via the loop in scripts/dev/probe-webshare.py
# (or just re-run the inline 10-proxy test). Rotation strategy: use a
# different proxy on every session-recycle. Each proxy gets ~25 games
# before swap; with 3 working proxies we cycle through ~75 games per
# rotation pass before any single IP gets >25 sequential requests.
#
# Fallback: if a proxy returns 403, the BackoffState handles it like any
# block. Next session-recycle picks a different proxy.

# Two Webshare plans on same account:
# - Static Residential ($6/mo, 20 IPs, 250GB) — credentials: adnaiwqf/ht74ld1kdk8v
# - Free Tier (10 datacenter IPs, no bandwidth cap) — credentials: gqihgyxt/qd3mxrzm8x3r
# Pool format: (label, ip, port, user, pass) so each proxy carries its own creds.
WEBSHARE_RES_USER = "adnaiwqf"
WEBSHARE_RES_PASS = "ht74ld1kdk8v"
WEBSHARE_FREE_USER = "gqihgyxt"
WEBSHARE_FREE_PASS = "qd3mxrzm8x3r"

# Static Residential plan ($6/mo, 20 IPs, 250GB bandwidth, 10 replacements/mo)
# verified 2026-05-09: ALL 20 return HTTP 200 against /event/{id}/managers.
# Residential subnets aren't blanket-blocked by Cloudflare (would block real
# users) → far more reliable than datacenter proxies (3/10 worked) or Tor
# (heavily blocked).
#
# Geographic distribution: US (10) / DE (3) / FR (3) / UK (1) / IT (1) / BE (1)
# — diverse subnets help with rate-limit distribution.
WEBSHARE_PROXIES_VERIFIED = [
    # (label, ip, port, user, pass)
    # ─── OLD POOL DISABLED 2026-05-25 — TCP-dead (ProxyError) ────────
    # All 20 WS-01..WS-20 IPs were rotated out by Webshare after sustained
    # use today blocked them at TCP level (not 403, but connection refused).
    # Re-enable if Webshare assigns them back.
    # ─── REFRESHED POOL 2026-05-25: 20 new IPs for extended rotation ───
    # Old WS-01..WS-20 pool degraded after ~60min of sustained use today.
    # Adding 20 fresh IPs (different /24 subnets) extends sustainable
    # fetch-window from ~60min to ~2-4h before CF starts catching up.
    #
    # ─── 7 REPLACEMENTS 2026-05-25 evening ─────────────────────────────
    # Webshare auto-rotated 7 burnt gateways. Files dropped by user:
    #   "Webshare 2 replaced proxies (1).txt" → FW-10, FW-06
    #   "Webshare 2 replaced proxies.txt"     → FW-09, FW-20
    #   "Webshare 3 replaced proxies.txt"     → FW-07, FW-02, FW-13
    # Mapping verified by matching file's egress-IP column to the old
    # host-IP in this list. New entries reuse the original FW-XX slot to
    # keep pool size at 20. Old host:port pairs are now TCP-dead.
    ("FW-01", "45.56.183.188", 8510, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-02", "209.166.17.130", 6291, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 46.203.30.67)
    ("FW-03", "82.29.47.225", 7949, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-04", "192.53.66.56", 6162, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-05", "9.142.15.195", 6351, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-06", "87.86.8.198", 6845, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 82.22.181.3)
    ("FW-07", "82.23.88.4", 7760, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 159.148.236.66)
    ("FW-08", "45.56.179.116", 9320, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-09", "166.0.40.167", 7175, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 150.241.111.32)
    ("FW-10", "87.86.8.131", 6778, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 5.59.251.84)
    ("FW-11", "9.142.10.184", 5840, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-12", "87.86.8.56", 6703, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-13", "23.27.88.139", 7141, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 46.203.76.197)
    ("FW-14", "87.86.10.238", 5885, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-15", "207.228.29.140", 5631, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-16", "9.142.14.209", 6865, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-17", "63.246.137.182", 5811, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-18", "130.180.236.191", 6196, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-19", "192.53.66.85", 6191, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),
    ("FW-20", "82.23.88.111", 7867, WEBSHARE_RES_USER, WEBSHARE_RES_PASS),  # replaced 2026-05-25 (egress 209.166.2.182)
    # ─── Free Tier datacenter proxies — RE-ENABLED 2026-05-10 ────────
    # Earlier CLOSE_WAIT hang (Python stuck 24min on US-LA-F1) is now
    # mitigated via SIGALRM watchdog at timeout+5s in _get(). Trade-off
    # accepted: occasional 20s hang per bad proxy is much better than 24min,
    # AND we get 10 more rotation slots when residential IPs are CF-blocked.
    ("UK-Lon-F1",   "31.59.20.176",   6754, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-Buf-F",    "198.23.239.134", 6540, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-Sea-F",    "31.56.127.193",  7684, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("UK-Lon-F2",   "45.38.107.97",   6014, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-Bldg-F",   "107.172.163.27", 6543, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-Dal-F",    "216.10.27.159",  6837, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("JP-Tok-F",    "142.111.67.146", 5611, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-LA-F1",    "191.96.254.138", 6185, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("DE-Frank-F",  "31.58.9.4",      6077, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
    ("US-LA-F2",    "23.229.19.94",   8689, WEBSHARE_FREE_USER, WEBSHARE_FREE_PASS),
]
WEBSHARE_PROXIES_FULL = WEBSHARE_PROXIES_VERIFIED  # all currently working


def _webshare_url(ip: str, port: int, user: str, password: str) -> str:
    return f"http://{user}:{password}@{ip}:{port}"


# Module-level proxy rotator state (populated when --use-webshare is set).
_webshare_idx = 0
_webshare_pool: list[tuple] = []


def make_session(use_tor: bool, use_webshare: bool = False, use_tls_requests: bool = False):
    """Build an HTTP session for Sofa API.

    use_tls_requests=True (default since 2026-05-10): returns a tls_requests.Client
    using bogdanfinn TLS fingerprint. This bypasses CF blocks that hit our
    curl_cffi chrome124 fingerprint. No proxy needed if user IP isn't blocked.

    Otherwise: curl_cffi chrome124-impersonating session, optionally routed
    through Tor SOCKS5 OR a rotating Webshare proxy.
    """
    global _webshare_idx
    if use_tls_requests:
        # Direct from user IP using bogdanfinn tls-client. CF lets this
        # fingerprint through. Proxies optional (skipped if no_proxy or
        # webshare not set; webshare can still be combined for IP rotation).
        if use_webshare and _webshare_pool:
            entry = _webshare_pool[_webshare_idx % len(_webshare_pool)]
            if len(entry) == 5:
                label, ip, port, user, password = entry
            else:
                label, ip, port = entry  # type: ignore
                user, password = WEBSHARE_RES_USER, WEBSHARE_RES_PASS
            _webshare_idx += 1
            proxy = _webshare_url(ip, port, user, password)
            print(f"  ↻ using Webshare proxy {label} ({ip}) [tls_requests]", flush=True)
            return tls_requests.Client(proxy=proxy)
        return tls_requests.Client()

    if use_webshare:
        if not _webshare_pool:
            return cf_requests.Session(impersonate="chrome124")  # safety
        entry = _webshare_pool[_webshare_idx % len(_webshare_pool)]
        # Pool entries are 5-tuples (label, ip, port, user, pass) supporting
        # multiple Webshare plans on same account. Unpack defensively to keep
        # backwards compat if someone passes legacy 3-tuple.
        if len(entry) == 5:
            label, ip, port, user, password = entry
        else:
            label, ip, port = entry  # type: ignore
            user, password = WEBSHARE_RES_USER, WEBSHARE_RES_PASS
        _webshare_idx += 1
        proxy = _webshare_url(ip, port, user, password)
        print(f"  ↻ using Webshare proxy {label} ({ip})", flush=True)
        return cf_requests.Session(
            impersonate="chrome124",
            proxies={"http": proxy, "https": proxy},
        )
    if use_tor:
        return cf_requests.Session(
            impersonate="chrome124",
            proxies={"http": TOR_PROXY, "https": TOR_PROXY},
        )
    return cf_requests.Session(impersonate="chrome124")


# ─── Orchestration ─────────────────────────────────────────────────

def fetch_pending(
    leagues: list[str],
    season: str,
    *,
    pace: float,
    dry: bool,
    max_games: int | None,
    use_tor: bool = False,
    use_webshare: bool = False,
    use_tls_requests: bool = False,
    skip_cached: bool = False,
    endpoints: tuple[str, ...] | None = None,
) -> None:
    # Initialize Webshare pool once at start of run
    global _webshare_pool, _webshare_idx
    if use_webshare:
        _webshare_pool = list(WEBSHARE_PROXIES_VERIFIED)
        _webshare_idx = 0
    eps_label = ",".join(endpoints) if endpoints is not None else "all 7"
    print(f"🔍 Fetching pending extras · leagues={leagues} · season={season}"
          f" · endpoints={eps_label}"
          f"{' · via Tor' if use_tor else ''}"
          f"{' · via Webshare ('+str(len(WEBSHARE_PROXIES_VERIFIED))+' proxies)' if use_webshare else ''}")
    pending = fetch_pending_games(
        leagues, season, limit=max_games,
        skip_cached=skip_cached, endpoints=endpoints,
    )
    if not pending:
        print("  no pending games (everything already pulled, or none ended)")
        return

    print(f"  {len(pending)} pending game(s)")
    if dry:
        for m in pending[:25]:
            print(f"    {m['game_id']}  {m['league']}  {m['home_team']} vs {m['away_team']}")
        if len(pending) > 25:
            print(f"    … and {len(pending) - 25} more")
        return

    # Fresh session every SESSION_RECYCLE games — defends against
    # cf_requests.Session accumulating bad state (observed: hung indefinitely
    # on game ~96 after ~480 cumulative games). On Tor we recycle MORE
    # aggressively (25 vs 50) because each recycle gives us a chance at a
    # new Tor exit IP, which is critical when Cloudflare's per-exit rate
    # counter starts climbing. 7 endpoints × 25 games = 175 requests per
    # session, comfortably under the empirical ~250-request soft-limit.
    # On Webshare: recycle every 25 games so we cycle through the 3-proxy
    # pool, distributing load and detecting any newly-blocked proxy quickly.
    if use_webshare:
        SESSION_RECYCLE = 25
        PER_GAME_BUDGET = 30  # datacenter proxies are fast, no Tor latency
    elif use_tor:
        SESSION_RECYCLE = 25
        PER_GAME_BUDGET = 60  # 7 endpoints × ~6s pace via Tor
    else:
        SESSION_RECYCLE = 50
        PER_GAME_BUDGET = 30

    http = make_session(use_tor, use_webshare, use_tls_requests)
    backoff = BackoffState()
    success_count = 0
    skip_cached_count = 0
    error_count = 0
    games_on_session = 0

    # Track which endpoints we expect for the kinds-counter display.
    # Defaults to all 7; --endpoints subsets shrink it (e.g. slim-3 mode).
    EXPECTED_KEYS = endpoints if endpoints is not None else ALL_ENDPOINTS

    for idx, m in enumerate(pending, 1):
        gid = int(m["game_id"])

        # NOTE: don't bypass via already_cached() any more. Cached JSONs
        # may pre-date v2 endpoints — we want to refetch (write_extras
        # merges new payloads non-destructively).
        # Exception: --skip-cached flag opts back into the early-skip when
        # the user knows local JSONs are complete (e.g. after running with
        # --no-supabase, state-table is stale but JSONs are accurate).
        # With --endpoints subset, "complete" means just those endpoints.
        if skip_cached and already_cached(gid, endpoints=endpoints):
            skip_cached_count += 1
            continue

        # Recycle session periodically (defense against curl_cffi state drift)
        if games_on_session >= SESSION_RECYCLE:
            try:
                http.close()
            except Exception:
                pass
            http = make_session(use_tor, use_webshare, use_tls_requests)
            games_on_session = 0
            tag = (' (new Webshare proxy)' if use_webshare
                   else ' (new Tor circuit)' if use_tor else '')
            print(f"  ↻ session recycled at game {idx}{tag}", flush=True)

        # Per-game wallclock budget: total time across all endpoints
        t0 = time.time()
        try:
            payload = fetch_game_extras(http, gid, endpoints=endpoints)
            backoff.success()
        except BlockedError as e:
            print(f"  [{idx}/{len(pending)}] {gid}: blocked ({e})", flush=True)
            payload = None

            # Webshare auto-fallback: when proxy gets 403, IMMEDIATELY rotate
            # to next proxy in pool instead of triggering BackoffState's
            # 60s/5min/30min cascade. We have N proxies available; if proxy
            # X is Cloudflare-flagged, proxy Y might still work. Try every
            # remaining proxy in pool before falling back to backoff.
            #
            # Empirically observed 2026-05-09: a single Webshare proxy gets
            # blocked partway through a chunk, and the BackoffState cascade
            # wastes ~30min before aborting — even though the OTHER 2-3 proxies
            # in the pool would still work. This loop spends ~5s per proxy
            # rotation (1 retry attempt each) instead of 30min waiting.
            if use_webshare and len(_webshare_pool) > 1:
                tried_count = 0
                while tried_count < len(_webshare_pool) - 1:
                    tried_count += 1
                    try:
                        http.close()
                    except Exception:
                        pass
                    http = make_session(use_tor=False, use_webshare=True, use_tls_requests=use_tls_requests)
                    games_on_session = 0  # reset since session changed
                    try:
                        payload = fetch_game_extras(http, gid, endpoints=endpoints)
                        backoff.success()
                        print(f"     ↳ recovered via proxy rotation (tried {tried_count})", flush=True)
                        break
                    except BlockedError:
                        continue  # next proxy

            # If still no payload after exhausting ALL proxies, this is likely
            # a per-game-id Cloudflare permablock (specific game-id pattern is
            # rejected regardless of source IP). Skip this game and continue —
            # don't waste 30+ min in BackoffState sleeps for a permablock.
            # Game stays in state-table as pending, will retry on next run.
            # Empirically observed 2026-05-10: game 14317587 hit ALL 20 IPs
            # with HTTP 403 on /statistics endpoint, even residential.
            if payload is None:
                error_count += 1
                print(f"  ✗ skip {gid}: blocked on all {len(_webshare_pool)} proxies "
                      f"(per-game permablock, will retry later)", flush=True)
                continue

        elapsed = time.time() - t0
        if elapsed > PER_GAME_BUDGET:
            # Some endpoint(s) hit the watchdog timeout — payload may be
            # partially populated. We still write what we have.
            print(f"  ⚠ game {gid} took {elapsed:.0f}s (budget {PER_GAME_BUDGET}s)", flush=True)

        path = write_extras(gid, m, payload)
        success_count += 1
        games_on_session += 1
        kinds = sum(1 for k in EXPECTED_KEYS if payload.get(k))
        print(f"  [{idx}/{len(pending)}] {gid}  {m['home_team'][:18]:18} vs {m['away_team'][:18]:18}  "
              f"{kinds}/{len(EXPECTED_KEYS)} endpoints  → {path.name}", flush=True)

        # Pace
        time.sleep(pace + random.uniform(-0.2, 0.4))

    print(f"\n✓ extras: {success_count} pulled, {skip_cached_count} already cached, {error_count} errored")


# ─── Single-game (debug) ───────────────────────────────────────────

def fetch_single(
    game_id: int,
    *,
    dry: bool,
    use_tor: bool = False,
    endpoints: tuple[str, ...] | None = None,
) -> None:
    targets = endpoints if endpoints is not None else ALL_ENDPOINTS
    print(f"🔍 Single-game fetch · {game_id}"
          f" · endpoints={','.join(targets)}"
          f"{' · via Tor' if use_tor else ''}")
    if dry:
        ep_paths = " ".join("/" + k.replace("_", "-") for k in targets)
        print(f"  [DRY] would fetch {ep_paths}")
        return
    http = make_session(use_tor)
    try:
        payload = fetch_game_extras(http, game_id, endpoints=endpoints)
    except BlockedError as e:
        print(f"  ✗ blocked: {e}")
        return
    meta = {"league": "?", "season": "?", "home_team": "?", "away_team": "?"}
    path = write_extras(game_id, meta, payload)
    kinds = sum(1 for k in targets if payload.get(k))
    print(f"  ✓ {kinds}/{len(targets)} endpoints → {path}")


# ─── CLI ───────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Fetch Sofascore post-match extras")
    p.add_argument("--league", help="single FODZE league key")
    p.add_argument("--tier", choices=["A", "B"], help="all leagues in tier")
    p.add_argument("--all-tiers", action="store_true", help="A + B (every league)")
    p.add_argument("--leagues", help="comma-separated league list (overrides --tier/--league). "
                                      "Use to split workload across N parallel backfill instances.")
    p.add_argument("--skip-cached", action="store_true",
                   help="skip games whose JSON already exists on disk. Use when "
                        "Supabase state-table is stale (e.g. after --no-supabase loads). "
                        "Avoids re-fetching games we already have locally.")
    p.add_argument("--use-tls-requests", action="store_true",
                   help="Use bogdanfinn tls-client (via wrapper-tls-requests) instead "
                        "of curl_cffi chrome124. Different TLS fingerprint passes CF "
                        "blocks that hit chrome124. No proxy required (works from "
                        "user's IP). Verified 2026-05-10.")
    p.add_argument("--game-id", type=int, help="single game (debug)")
    p.add_argument("--season", default="25/26", help="season label (default 25/26)")
    p.add_argument("--max", type=int, help="cap pending games processed this run")
    p.add_argument("--pace", type=float, default=None,
                   help="seconds between games (default 1.5 direct, 5.0 via Tor)")
    p.add_argument("--dry", action="store_true", help="list pending, no fetch")
    p.add_argument("--use-tor", action="store_true",
                   help="route through Tor SOCKS5 (127.0.0.1:9050) — bypasses Cloudflare API "
                        "block. Requires `brew install tor && brew services start tor`. Empirically "
                        "the only reliable path to managers/pregame-form/team-streaks endpoints "
                        "since Cloudflare started blocking direct API access on 2026-05-07.")
    p.add_argument("--use-webshare", action="store_true",
                   help="rotate through Webshare datacenter proxies (free tier, 3 verified "
                        "working proxies as of 2026-05-09). Faster + more reliable than Tor — "
                        "Webshare datacenter IPs are NOT on Cloudflare's anti-Tor blocklist. "
                        "Mutually exclusive with --use-tor (Webshare wins).")
    p.add_argument("--endpoints", default=None,
                   help="comma-separated subset of endpoints to fetch. Valid keys: "
                        "statistics,lineups,incidents,average_positions,managers,"
                        "pregame_form,team_streaks. Default: all 7. Engine-consumed-only "
                        "preset for ~50%% less CF pressure: "
                        "'statistics,lineups,average_positions' (drops managers + "
                        "pregame_form + team_streaks which are not currently wired into "
                        "any production engine).")
    args = p.parse_args()

    # Parse + validate --endpoints subset
    endpoints: tuple[str, ...] | None
    if args.endpoints:
        requested = tuple(e.strip() for e in args.endpoints.split(",") if e.strip())
        unknown = [e for e in requested if e not in ALL_ENDPOINTS]
        if unknown:
            p.error(f"unknown endpoint(s): {','.join(unknown)}. "
                    f"Valid: {','.join(ALL_ENDPOINTS)}")
        if not requested:
            p.error("--endpoints given but resolved to empty list")
        endpoints = requested
    else:
        endpoints = None  # signals "all 7" downstream

    # Default pace: 1.5s direct/Webshare, 5.0s via Tor.
    if args.pace is not None:
        pace = args.pace
    elif args.use_tor and not args.use_webshare:
        pace = 5.0
    else:
        pace = 1.5

    if args.game_id:
        fetch_single(args.game_id, dry=args.dry, use_tor=args.use_tor, endpoints=endpoints)
        return

    if not (args.league or args.tier or args.all_tiers or args.leagues):
        p.error("must give --league, --leagues, --tier, --all-tiers, or --game-id")

    if args.leagues:
        leagues = [lg.strip() for lg in args.leagues.split(",") if lg.strip()]
    elif args.all_tiers:
        leagues = TIER_A + TIER_B
    elif args.tier:
        leagues = TIER_A if args.tier == "A" else TIER_B
    else:
        leagues = [args.league]

    # Validate
    for lg in leagues:
        if lg not in TOURNAMENT_IDS:
            print(f"⚠ unknown league: {lg}", file=sys.stderr)
            sys.exit(1)

    fetch_pending(leagues, args.season, pace=pace, dry=args.dry,
                  max_games=args.max, use_tor=args.use_tor,
                  use_webshare=args.use_webshare,
                  use_tls_requests=args.use_tls_requests,
                  skip_cached=args.skip_cached,
                  endpoints=endpoints)


if __name__ == "__main__":
    main()

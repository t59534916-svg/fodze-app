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
) -> list[dict]:
    """Returns games where extras are missing/incomplete.

    Joins sofascore_match LEFT JOIN sofascore_extras_state and filters
    for rows where any of the 4 has_* flags is FALSE (or state row missing).
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
            if st is None:
                pending.append(m)
            else:
                # Pending if ANY of v1+v2 endpoints isn't yet pulled. Existing
                # rows that completed v1 (statistics+lineups+incidents+avg-pos)
                # but defaulted has_managers/has_pregame_form/has_team_streaks
                # to FALSE during the v2 migration are correctly flagged
                # pending here — the next run will pull just the v2 endpoints
                # for them (and re-fetch v1 ones, but that's idempotent).
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


def fetch_game_extras(http: cf_requests.Session, game_id: int) -> dict:
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
    """
    return {
        # v1 endpoints (forever-cache established, pulled for 736 games as of 2026-05-08)
        "statistics":         _get(http, f"{SOFASCORE_BASE}/event/{game_id}/statistics"),
        "lineups":            _get(http, f"{SOFASCORE_BASE}/event/{game_id}/lineups"),
        "incidents":          _get(http, f"{SOFASCORE_BASE}/event/{game_id}/incidents"),
        "average_positions":  _get(http, f"{SOFASCORE_BASE}/event/{game_id}/average-positions"),
        # v2 endpoints (HIGH-SIGNAL — added 2026-05-08, schema verified empirically)
        "managers":           _get(http, f"{SOFASCORE_BASE}/event/{game_id}/managers"),
        "pregame_form":       _get(http, f"{SOFASCORE_BASE}/event/{game_id}/pregame-form"),
        "team_streaks":       _get(http, f"{SOFASCORE_BASE}/event/{game_id}/team-streaks"),
    }


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


def already_cached(game_id: int) -> bool:
    return output_path(game_id).exists()


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


def make_session(use_tor: bool) -> cf_requests.Session:
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
) -> None:
    print(f"🔍 Fetching pending extras · leagues={leagues} · season={season}"
          f"{' · via Tor' if use_tor else ''}")
    pending = fetch_pending_games(leagues, season, limit=max_games)
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
    SESSION_RECYCLE = 25 if use_tor else 50
    PER_GAME_BUDGET = 60 if use_tor else 30  # 7 endpoints × ~6s pace via Tor

    http = make_session(use_tor)
    backoff = BackoffState()
    success_count = 0
    skip_cached = 0
    error_count = 0
    games_on_session = 0

    # Track which endpoints we expect for the kinds-counter display.
    # Counts both v1 (4 keys) and v2 (3 keys) endpoints.
    EXPECTED_KEYS = (
        "statistics", "lineups", "incidents", "average_positions",
        "managers", "pregame_form", "team_streaks",
    )

    for idx, m in enumerate(pending, 1):
        gid = int(m["game_id"])

        # NOTE: don't bypass via already_cached() any more. Cached JSONs
        # may pre-date v2 endpoints — we want to refetch (write_extras
        # merges new payloads non-destructively).

        # Recycle session periodically (defense against curl_cffi state drift)
        if games_on_session >= SESSION_RECYCLE:
            try:
                http.close()
            except Exception:
                pass
            http = make_session(use_tor)
            games_on_session = 0
            print(f"  ↻ session recycled at game {idx}{' (new Tor circuit)' if use_tor else ''}", flush=True)

        # Per-game wallclock budget: total time across all endpoints
        t0 = time.time()
        try:
            payload = fetch_game_extras(http, gid)
            backoff.success()
        except BlockedError as e:
            print(f"  [{idx}/{len(pending)}] {gid}: blocked ({e})", flush=True)
            if not backoff.hit():
                print(f"  ✗ aborted after 3 consecutive blocks — re-run later", flush=True)
                break
            # retry this game once after backoff
            try:
                payload = fetch_game_extras(http, gid)
                backoff.success()
            except BlockedError:
                error_count += 1
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

    print(f"\n✓ extras: {success_count} pulled, {skip_cached} already cached, {error_count} errored")


# ─── Single-game (debug) ───────────────────────────────────────────

def fetch_single(game_id: int, *, dry: bool, use_tor: bool = False) -> None:
    print(f"🔍 Single-game fetch · {game_id}{' · via Tor' if use_tor else ''}")
    if dry:
        print("  [DRY] would fetch /statistics /lineups /incidents /average-positions"
              " /managers /pregame-form /team-streaks")
        return
    http = make_session(use_tor)
    try:
        payload = fetch_game_extras(http, game_id)
    except BlockedError as e:
        print(f"  ✗ blocked: {e}")
        return
    meta = {"league": "?", "season": "?", "home_team": "?", "away_team": "?"}
    path = write_extras(game_id, meta, payload)
    kinds = sum(1 for k in (
        "statistics", "lineups", "incidents", "average_positions",
        "managers", "pregame_form", "team_streaks",
    ) if payload.get(k))
    print(f"  ✓ {kinds}/7 endpoints → {path}")


# ─── CLI ───────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Fetch Sofascore post-match extras")
    p.add_argument("--league", help="single FODZE league key")
    p.add_argument("--tier", choices=["A", "B"], help="all leagues in tier")
    p.add_argument("--all-tiers", action="store_true", help="A + B (every league)")
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
    args = p.parse_args()

    # Default pace: 1.5s direct, 5.0s via Tor (Cloudflare's per-circuit
    # rate-counter hits ~15 successive requests at 1.5s pacing → 403 burst).
    pace = args.pace if args.pace is not None else (5.0 if args.use_tor else 1.5)

    if args.game_id:
        fetch_single(args.game_id, dry=args.dry, use_tor=args.use_tor)
        return

    if not (args.league or args.tier or args.all_tiers):
        p.error("must give --league, --tier, --all-tiers, or --game-id")

    if args.all_tiers:
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
                  max_games=args.max, use_tor=args.use_tor)


if __name__ == "__main__":
    main()

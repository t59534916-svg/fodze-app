#!/usr/bin/env node
/**
 * FODZE — Sofascore post-match extras incremental sync
 *
 * Wraps tools/sofascore/{fetch_match_extras,load_extras_to_supabase}.py
 * so refresh-all.mjs can include match-statistics + lineups + incidents
 * + average-positions as a recurring data source. Every endpoint is
 * forever-cache after status='Ended', so this is cheap on later runs.
 *
 * What it does each run:
 *   1. fetch_match_extras.py --tier A --season 25/26 --max N
 *      (queries sofascore_extras_state to skip already-fully-pulled games)
 *   2. load_extras_to_supabase.py --all
 *      (idempotent upserts via UNIQUE constraints)
 *
 * Cost: 4 calls per pending game_id × 1.5s pace. A typical refresh
 * (last weekend's matches) hits ~80-120 games × 4 = ~400 calls × 1.5s
 * = ~10 min. First run after backfill enable will be ~5000 games and
 * should be split across multiple runs (--max 200 per run).
 *
 * Usage:
 *   node scripts/sync-sofascore-extras.mjs                    # default Tier A, no limit
 *   node scripts/sync-sofascore-extras.mjs --tier B           # Tier-B leagues
 *   node scripts/sync-sofascore-extras.mjs --all-tiers        # all 22 leagues
 *   node scripts/sync-sofascore-extras.mjs --max 200          # cap per run
 *   node scripts/sync-sofascore-extras.mjs --league bundesliga
 *   node scripts/sync-sofascore-extras.mjs --dry              # plan only
 *   node scripts/sync-sofascore-extras.mjs --skip-fetch       # only re-load cached JSONs
 *   node scripts/sync-sofascore-extras.mjs --use-tor          # route via Tor SOCKS5
 *                                                             # (REQUIRED for v2 endpoints
 *                                                             # since 2026-05-08 — Cloudflare
 *                                                             # blocks direct API access)
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const VENV_PY = resolve(REPO_ROOT, "tools/venv/bin/python3");
const FETCH_PY = resolve(REPO_ROOT, "tools/sofascore/fetch_match_extras.py");
const LOAD_PY  = resolve(REPO_ROOT, "tools/sofascore/load_extras_to_supabase.py");

if (!existsSync(VENV_PY)) {
  console.error(`✗ Python venv not found at ${VENV_PY}`);
  console.error(`  Setup: python3 -m venv tools/venv && tools/venv/bin/pip install curl_cffi`);
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function val(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const tier = val("tier") ?? "A";
const allTiers = flag("all-tiers");
const league = val("league");
const leagues = val("leagues");  // comma-list, splits workload for parallel runs
const max = val("max");
const dry = flag("dry");
const skipFetch = flag("skip-fetch");
const SEASON = val("season") ?? "25/26";
// --use-tor passes through to fetch_match_extras.py. Required since 2026-05-08
// for the v2 endpoints (managers / pregame-form / team-streaks) — Cloudflare
// blocks direct API access on those, but chrome124-fingerprinted requests
// via Tor SOCKS5 (127.0.0.1:9050) pass. Setup: `brew install tor && brew
// services start tor`.
const useTor = flag("use-tor");
// --use-webshare rotates through Webshare datacenter proxies (free tier).
// Faster + more reliable than Tor since 2026-05-09 — Webshare datacenter
// IPs are NOT on Cloudflare's anti-Tor blocklist. Mutually exclusive with
// --use-tor (Webshare wins). Hardcoded proxy creds in fetch_match_extras.py.
const useWebshare = flag("use-webshare");
// --use-tls-requests: use bogdanfinn tls-client fingerprint instead of
// curl_cffi chrome124. Bypasses CF blocks targeting chrome124. Verified
// 2026-05-10 to work without proxy from user's home IP.
const useTlsRequests = flag("use-tls-requests");
// --skip-player-stats skips loading sofascore_player_match_stats (the dominant
// storage cost — 36 KB/game = 60% of v1+v2 footprint). Engine doesn't currently
// read this table; bridge-sofascore-extras-to-team-xg.mjs uses match_statistics.
// Recommended for free-tier Supabase to keep DB under 500 MB. JSONs stay on
// disk in tools/sofascore/data/extras/ for future re-ingest if needed.
const skipPlayerStats = flag("skip-player-stats")
  || process.env.FODZE_SKIP_PLAYER_STATS === "1";
// --no-supabase: load step writes ONLY to local SQLite, skips all Supabase calls.
// Use when Supabase is overloaded (Disk IO budget exhausted) — fetch new JSONs
// fast without waiting on slow upserts. Run a separate load pass later when
// Supabase recovers to push to cloud.
const noSupabase = flag("no-supabase")
  || process.env.FODZE_NO_SUPABASE === "1";
// --skip-cached: fetch step skips games whose JSON exists on disk. Required
// when --no-supabase is on (state-table won't get updated, so otherwise we'd
// re-fetch the same games every run). Forces JSON existence as the dedup key.
const skipCached = flag("skip-cached")
  || process.env.FODZE_SKIP_CACHED === "1"
  || noSupabase;  // implied by no-supabase

function run(name, py, extraArgs) {
  console.log(`\n━━━ ${name} ━━━`);
  const t0 = Date.now();
  const r = spawnSync(VENV_PY, ["-u", py, ...extraArgs], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`✗ ${name} exit ${r.status} after ${sec}s`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${name} done (${sec}s)`);
}

const scopeDesc = allTiers
  ? "all 22 leagues"
  : league
    ? `league ${league}`
    : `tier ${tier}`;
console.log(`🔍 Sofascore extras sync · ${scopeDesc} · season ${SEASON}${dry ? " (DRY)" : ""}`);

// 1. Fetch (network → tools/sofascore/data/extras/<gid>.json)
if (!skipFetch) {
  const fetchArgs = ["--season", SEASON];
  if (leagues)       fetchArgs.push("--leagues", leagues);
  else if (allTiers) fetchArgs.push("--all-tiers");
  else if (league)   fetchArgs.push("--league", league);
  else               fetchArgs.push("--tier", tier);
  if (max)           fetchArgs.push("--max", max);
  if (dry)           fetchArgs.push("--dry");
  if (useTor)        fetchArgs.push("--use-tor");
  if (useWebshare)   fetchArgs.push("--use-webshare");
  if (useTlsRequests) fetchArgs.push("--use-tls-requests");
  if (skipCached)    fetchArgs.push("--skip-cached");
  run("fetch_match_extras", FETCH_PY, fetchArgs);
}

// 2. Load (JSON → Supabase)
// --since-mtime 1800 (30 min) skips re-loading already-projected JSONs that are
// older than the current fetch window. Without this, each chunk re-processes
// all N cached JSONs = O(chunk_count²) total work; with it, each chunk only
// processes its ~50 newly-fetched JSONs = O(N) total. On bulk backfill, this
// is the difference between 30h and 60h. To do a one-shot full re-load, run
// `python3 tools/sofascore/load_extras_to_supabase.py --all` directly.
// Override via env: FODZE_LOAD_SINCE_MTIME=0 to disable filter (full --all).
const sinceMtimeSec = process.env.FODZE_LOAD_SINCE_MTIME ?? "1800";
if (!dry) {
  const loadArgs = ["--all", "--since-mtime", sinceMtimeSec];
  if (skipPlayerStats) loadArgs.push("--skip-player-stats");
  if (noSupabase)      loadArgs.push("--no-supabase");
  run("load_extras_to_supabase", LOAD_PY, loadArgs);
} else {
  console.log("\n[DRY] Would run: load_extras_to_supabase.py --all --since-mtime " + sinceMtimeSec);
}

console.log(`\n✓ Sofascore extras sync complete`);

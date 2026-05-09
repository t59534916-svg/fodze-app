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

function run(name, py, extraArgs) {
  console.log(`\n━━━ ${name} ━━━`);
  const t0 = Date.now();
  const r = spawnSync(VENV_PY, [py, ...extraArgs], {
    stdio: "inherit",
    cwd: REPO_ROOT,
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
  if (allTiers)      fetchArgs.push("--all-tiers");
  else if (league)   fetchArgs.push("--league", league);
  else               fetchArgs.push("--tier", tier);
  if (max)           fetchArgs.push("--max", max);
  if (dry)           fetchArgs.push("--dry");
  if (useTor)        fetchArgs.push("--use-tor");
  if (useWebshare)   fetchArgs.push("--use-webshare");
  run("fetch_match_extras", FETCH_PY, fetchArgs);
}

// 2. Load (JSON → Supabase)
if (!dry) {
  run("load_extras_to_supabase", LOAD_PY, ["--all"]);
} else {
  console.log("\n[DRY] Would run: load_extras_to_supabase.py --all");
}

console.log(`\n✓ Sofascore extras sync complete`);

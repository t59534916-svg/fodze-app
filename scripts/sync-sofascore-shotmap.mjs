#!/usr/bin/env node
/**
 * FODZE — Sofascore shot-event incremental sync
 *
 * Wraps tools/sofascore/{fetch_shots,load_to_supabase}.py and the venv
 * so refresh-all.mjs can include Sofascore as a recurring data source.
 *
 * What it does each run:
 *   1. fetch_shots.py --tier A --season 25/26 --all-weeks
 *      (resume-capable: skips weeks already fetched)
 *   2. load_to_supabase.py --all
 *      (idempotent upserts via UNIQUE constraint)
 *
 * Why "--all-weeks" instead of "current week only": fetch_shots.py
 * skips weeks already in the JSON cache, so re-running just picks up
 * the new + freshly-played weeks. Cheap idempotent.
 *
 * Cost: ~50 datafc API calls per run (one per week-in-progress across
 * 11 Tier-A leagues). datafc uses curl_cffi — no API key needed,
 * Sofascore-side rate-limit handled by 0.6s pace.
 *
 * Usage:
 *   node scripts/sync-sofascore-shotmap.mjs              # default (Tier A)
 *   node scripts/sync-sofascore-shotmap.mjs --tier B     # Tier-B leagues
 *   node scripts/sync-sofascore-shotmap.mjs --dry        # plan only
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const VENV_PY = resolve(REPO_ROOT, "tools/venv/bin/python3");
const FETCH_PY = resolve(REPO_ROOT, "tools/sofascore/fetch_shots.py");
const LOAD_PY  = resolve(REPO_ROOT, "tools/sofascore/load_to_supabase.py");

if (!existsSync(VENV_PY)) {
  console.error(`✗ Python venv not found at ${VENV_PY}`);
  console.error(`  Setup: python3 -m venv tools/venv && tools/venv/bin/pip install datafc`);
  process.exit(1);
}

const args = process.argv.slice(2);
const tier = args.find((a, i) => args[i - 1] === "--tier") ?? "A";
const dry  = args.includes("--dry");
const SEASON = "25/26";

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

console.log(`🔍 Sofascore sync · tier ${tier} · season ${SEASON}${dry ? " (DRY)" : ""}`);

// 1. Fetch (network → tools/sofascore/data/*.json)
const fetchArgs = ["--tier", tier, "--season", SEASON, "--all-weeks"];
if (dry) fetchArgs.push("--dry");
run("fetch_shots", FETCH_PY, fetchArgs);

// 2. Load (JSON → Supabase)
if (!dry) {
  run("load_to_supabase", LOAD_PY, ["--all"]);
} else {
  console.log("\n[DRY] Would run: load_to_supabase.py --all");
}

console.log(`\n✓ Sofascore sync complete`);

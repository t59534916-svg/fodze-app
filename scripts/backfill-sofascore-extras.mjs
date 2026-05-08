#!/usr/bin/env node
/**
 * FODZE — Sofascore extras initial backfill
 * ═══════════════════════════════════════════════════════════════════
 *
 * Wraps sync-sofascore-extras.mjs in a smart loop that runs until:
 *   - pending games == 0 (all extras pulled), OR
 *   - 3 consecutive chunks block (Cloudflare hot — stop, sleep, alert), OR
 *   - --max-chunks reached (safety cap, default unlimited)
 *
 * Why this exists separately from sync-sofascore-extras.mjs:
 *   - The sync script defaults to --max 50 per run (cron-friendly)
 *   - First-run backfill needs ~5000 games × 4 endpoints × 1.5s pace
 *     ≈ 8.3h of API calls. Manually invoking 100 chunks of 50 is silly.
 *   - This wrapper handles the loop, status reporting, and (most
 *     importantly) gentle cool-downs between chunks so Cloudflare
 *     doesn't escalate to a 24h IP block.
 *
 * Cooldown strategy:
 *   - Between chunks: 30s pause (lets Cloudflare's per-IP rate counter
 *     decay before the next batch hits)
 *   - On chunk failure (any non-zero exit from sync script): 5min, then
 *     15min, then 1h (matches sync script's internal backoff schedule)
 *   - On 3 consecutive failures: abort with status report, recommend
 *     waiting 24h and re-running
 *
 * Idempotent + resumable: each chunk reads sofascore_extras_state to
 * skip games already pulled, so killing the script mid-run and re-
 * starting it the next day picks up where it left off automatically.
 *
 * Usage:
 *   node scripts/backfill-sofascore-extras.mjs                    # default chunk=200, no cap
 *   node scripts/backfill-sofascore-extras.mjs --chunk 100        # smaller chunks (slower CF heat)
 *   node scripts/backfill-sofascore-extras.mjs --max-chunks 5     # safety: stop after 5×chunk games
 *   node scripts/backfill-sofascore-extras.mjs --tier B           # only Tier-B leagues
 *   node scripts/backfill-sofascore-extras.mjs --league epl       # single league
 *   node scripts/backfill-sofascore-extras.mjs --dry              # plan only
 *   node scripts/backfill-sofascore-extras.mjs --cooldown 60      # pause between chunks (default 30s)
 *   node scripts/backfill-sofascore-extras.mjs --use-tor          # route via Tor SOCKS5 (REQUIRED
 *                                                                 # for v2 endpoints since 2026-05-08).
 *                                                                 # When --use-tor: lower --chunk to ~25
 *                                                                 # so each Tor circuit handles
 *                                                                 # 25*7=175 reqs (under CF cap).
 *
 * Recommended Tor command (initial backfill):
 *   node scripts/backfill-sofascore-extras.mjs --use-tor --tier A --chunk 25 --cooldown 90 --max-chunks 5
 */

import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SYNC_SCRIPT = resolve(REPO_ROOT, "scripts/sync-sofascore-extras.mjs");

// ─── args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function val(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const CHUNK       = parseInt(val("chunk") ?? "200", 10);
const MAX_CHUNKS  = parseInt(val("max-chunks") ?? "0", 10);  // 0 = unlimited
const COOLDOWN_MS = parseInt(val("cooldown") ?? "30", 10) * 1000;
const TIER        = val("tier");
const LEAGUE      = val("league");
const SEASON      = val("season") ?? "25/26";
const DRY         = flag("dry");
// Forward --use-tor to sync-sofascore-extras.mjs → fetch_match_extras.py.
// REQUIRED for the v2 endpoints (managers/pregame-form/team-streaks) since
// Cloudflare started blocking direct API access on api.sofascore.com on
// 2026-05-07. Without --use-tor, the v2 portion of every chunk will fail
// with 403, leaving the v2-state-flags FALSE and forcing infinite retries.
// When using Tor, drop --chunk to ~25 (default 200) — Cloudflare's
// per-Tor-exit rate counter caps at ~15-25 successive requests.
const USE_TOR     = flag("use-tor");

const FAIL_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];  // 5m, 15m, 1h

const scopeArg = LEAGUE
  ? ["--league", LEAGUE]
  : TIER
    ? ["--tier", TIER]
    : ["--all-tiers"];

// ─── progress ──────────────────────────────────────────────────────
let chunksRun = 0;
let totalAttempted = 0;
let consecutiveFailures = 0;
const startedAt = Date.now();

function header(msg) {
  console.log(`\n══ ${msg} ══`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function runChunk() {
  const t0 = Date.now();
  const cliArgs = [
    SYNC_SCRIPT,
    ...scopeArg,
    "--season", SEASON,
    "--max", String(CHUNK),
  ];
  if (DRY)     cliArgs.push("--dry");
  if (USE_TOR) cliArgs.push("--use-tor");

  const r = spawnSync("node", cliArgs, {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);

  return {
    ok: r.status === 0,
    exitCode: r.status ?? 1,
    elapsedSec: sec,
  };
}

async function main() {
  console.log(`🔁 Sofascore extras backfill loop`);
  console.log(`   chunk=${CHUNK} cooldown=${COOLDOWN_MS / 1000}s scope=${scopeArg.join(" ")}`);
  if (MAX_CHUNKS > 0) console.log(`   max-chunks=${MAX_CHUNKS}`);
  if (DRY) console.log(`   ⚠ DRY — no actual fetches\n`);

  while (true) {
    if (MAX_CHUNKS > 0 && chunksRun >= MAX_CHUNKS) {
      header(`Hit max-chunks=${MAX_CHUNKS} — stopping`);
      break;
    }

    chunksRun++;
    header(`Chunk ${chunksRun} (total elapsed ${fmtDuration(Date.now() - startedAt)})`);

    const result = runChunk();

    if (result.ok) {
      consecutiveFailures = 0;
      totalAttempted += CHUNK;

      if (DRY) {
        // Dry-run loop has nothing to learn — break after 1 iteration
        console.log(`\n[DRY] one iteration done. Drop --dry to actually loop.`);
        break;
      }

      // Cooldown between successful chunks (let CF rate counter cool)
      console.log(`\n⏸ chunk done (${result.elapsedSec}s). Cooldown ${COOLDOWN_MS / 1000}s before next…`);
      await sleep(COOLDOWN_MS);

      // Heuristic exit: if last chunk took < 5 seconds, the sync script
      // likely found 0 pending games (it short-circuits). End the loop.
      if (Number(result.elapsedSec) < 5) {
        header(`Chunk completed in <5s — likely no more pending games. Stopping.`);
        break;
      }
    } else {
      consecutiveFailures++;
      console.error(`\n✗ Chunk ${chunksRun} failed (exit ${result.exitCode}) after ${result.elapsedSec}s`);

      // Fast-fail in DRY mode (no point sleeping while testing config),
      // and on first failure when the chunk dies in <2s (= config bug
      // like missing venv, missing env vars — not a Cloudflare block).
      if (DRY || (consecutiveFailures === 1 && Number(result.elapsedSec) < 2)) {
        console.error(`   Quick-failure (likely config issue, not rate-limit) — exiting.`);
        process.exitCode = 1;
        break;
      }

      if (consecutiveFailures >= 3) {
        header(`3 consecutive failures — Cloudflare likely blocking`);
        console.error(`   Recommendation: stop now, wait 24h, re-run with --chunk 50.`);
        process.exitCode = 1;
        break;
      }

      const waitMs = FAIL_BACKOFF_MS[consecutiveFailures - 1];
      console.error(`   Sleeping ${fmtDuration(waitMs)} before retry…`);
      await sleep(waitMs);
    }
  }

  header(`Backfill loop summary`);
  console.log(`   chunks run:           ${chunksRun}`);
  console.log(`   games attempted:      ${totalAttempted} (max — actual depends on pending count)`);
  console.log(`   total elapsed:        ${fmtDuration(Date.now() - startedAt)}`);
  console.log(`   consecutive failures: ${consecutiveFailures}`);

  if (process.exitCode === 1) {
    console.error(`\n⚠ Loop ended with errors. State of sofascore_extras_state preserved — re-run later to continue.`);
  } else {
    console.log(`\n✓ Backfill loop done.`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

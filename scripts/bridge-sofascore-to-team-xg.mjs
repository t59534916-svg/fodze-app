#!/usr/bin/env node
/**
 * FODZE — Sofascore → team_xg_history Bridge
 * ═══════════════════════════════════════════════════════════════════
 *
 * Bridges per-team-per-game data from `sofascore_team_chance_quality`
 * (view aggregating sofascore_shotmap) into `team_xg_history` so the
 * engine reads (MatchdayContext.loadCached, generate-matchday) see
 * the latest weekend's xG without needing a manual FootyStats refresh.
 *
 * Why it exists:
 *   - Sofascore-Shotmap is auto-synced daily via refresh-all Phase 4
 *     and contains real per-shot xG for 12+ leagues × current season
 *   - team_xg_history is fed by manual FootyStats CSV imports for
 *     non-DE leagues, leaving 7-14 day gaps between imports
 *   - Engine predictions read team_xg_history.xg_h8 (sums of 8 most
 *     recent xG values) — without this bridge those sums are stale
 *
 * What it does:
 *   1. Fetches sofascore_team_chance_quality rows where data_quality_tier
 *      ∈ ('premium', 'partial') AND sum_xg IS NOT NULL
 *      (volume tier = no xG → would null-out existing xG, skipped)
 *   2. Groups by game_id → match-pair (home + away rows)
 *   3. Translates schema (sum_xg → xg, opponent.sum_xg → xga, etc.)
 *   4. Applies canonicalize() so team names match the convention used
 *      by other ingest scripts
 *   5. Upserts to team_xg_history with source='sofascore', merging
 *      existing rows via UNIQUE(team, league, match_date, venue)
 *
 * Behavior re: existing rows:
 *   - The PostgREST upsert with `Prefer: resolution=merge-duplicates`
 *     overwrites only the columns this script provides (xg, xga,
 *     goals_for/_against, shots_for/_against, shots_on_target_for/
 *     _against, xg_openplay, xga_openplay, source).
 *   - Columns not provided (corners, possession, cards, etc.) are
 *     PRESERVED from the existing row (e.g. footystats-sourced).
 *   - If a row was previously source='goals-proxy' (BL/BL2/Liga3),
 *     it gets upgraded to real Sofascore xG.
 *   - If a row was previously source='footystats', xG/shots get the
 *     Sofascore values (cleaner per-shot methodology); other fields
 *     stay as footystats provided.
 *
 * Usage:
 *   node scripts/bridge-sofascore-to-team-xg.mjs --dry      # preview, no writes
 *   node scripts/bridge-sofascore-to-team-xg.mjs            # live upsert
 *   node scripts/bridge-sofascore-to-team-xg.mjs --since 2026-04-25  # only matches >= date
 *
 * Window choice (when called with --since by refresh-all.mjs):
 *   The default daily-cron window is 30 days (refresh-all hardcodes it).
 *   That covers ~6-8 most-recent matches per team for typical 18-team
 *   leagues with 1 match/week, which is enough to keep xg_h8 (Engine's
 *   8-game rolling sum) up-to-date as long as the cron actually runs
 *   daily. For:
 *     - Backfill scenarios after a tier-function migration adds new
 *       leagues:  --since 2025-08-01 (full 25/26 season)
 *     - Catching up after >30d cron outage: same — full backfill
 *     - Sub-30d-cadence leagues (e.g. liga3 with mid-week games): 30d
 *       still covers >8 matches — fine
 *     - Slow-cadence leagues (scottish_prem ~1 match/week, sometimes
 *       breaks for cup): 30d covers ~4-6 matches — TIGHT. If you skipped
 *       a week of cron, gap might exceed 8-match window. In practice
 *       OK because team_xg_history KEEPS old rows; bridge just adds new.
 *
 * Idempotent — safe to re-run. Counts in summary print what was new vs
 * what already existed (changed = source/value differed from existing).
 *
 * ENV (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── env ───────────────────────────────────────────────────────────
const envPath = resolve(PROJECT_ROOT, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && !process.env[t.slice(0, eq)]) {
      process.env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// ─── CLI ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const sinceArg = args.find((_, i) => args[i - 1] === "--since");
const SINCE = sinceArg || null;
const VERBOSE = args.includes("--verbose") || args.includes("-v");

// ─── helpers ───────────────────────────────────────────────────────
const headers = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function fetchAll(table, qs) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
      headers: { ...headers, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok) {
      console.error(`  ⚠ fetch ${table}: ${r.status} ${await r.text().catch(()=>"") }`);
      break;
    }
    const data = await r.json();
    if (!data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function upsertBatch(rows) {
  if (rows.length === 0) return 0;
  const r = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
    {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    },
  );
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`  ⚠ upsert: ${r.status} ${msg.slice(0, 300)}`);
    return 0;
  }
  return rows.length;
}

// ─── pure transformation (exported for unit tests) ────────────────
//
// Takes sofascore_team_chance_quality rows (1 per team-game), groups by
// game_id, and emits team_xg_history rows (2 per game — home + away).
// No I/O. canonicalizeFn is injected so tests can mock it.
//
// Returns: { rows, perLeague, skippedNoOpponent, skippedCanonicalize }
export function buildTeamXgRows(cqRows, canonicalizeFn = canonicalize) {
  // Group by game_id (1 game = 2 rows = 1 home + 1 away)
  const byGame = new Map();
  for (const r of cqRows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, {});
    byGame.get(r.game_id)[r.is_home ? "home" : "away"] = r;
  }

  const rows = [];
  let skippedNoOpponent = 0;
  let skippedCanonicalize = 0;
  const perLeague = {};

  for (const [, game] of byGame.entries()) {
    if (!game.home || !game.away) {
      skippedNoOpponent++;
      continue;
    }
    const matchDate = new Date(game.home.start_timestamp * 1000)
      .toISOString()
      .slice(0, 10);
    const lg = game.home.league;

    // Canonicalize team names — must match what other ingestion scripts use.
    let homeTeam, awayTeam;
    try {
      homeTeam = canonicalizeFn(game.home.team, lg);
      awayTeam = canonicalizeFn(game.away.team, lg);
    } catch (e) {
      skippedCanonicalize++;
      continue;
    }
    if (!homeTeam || !awayTeam) {
      skippedCanonicalize++;
      continue;
    }

    // Compute setpiece xG (sum_xg × setpiece_xg_share — view exposes share, not raw)
    const homeSetpieceXg = game.home.setpiece_xg_share != null && game.home.sum_xg != null
      ? Number((game.home.sum_xg * game.home.setpiece_xg_share).toFixed(3))
      : null;
    const awaySetpieceXg = game.away.setpiece_xg_share != null && game.away.sum_xg != null
      ? Number((game.away.sum_xg * game.away.setpiece_xg_share).toFixed(3))
      : null;

    // Home-side row
    rows.push({
      team: homeTeam,
      opponent: awayTeam,
      league: lg,
      venue: "home",
      match_date: matchDate,
      xg: game.home.sum_xg,
      xga: game.away.sum_xg,
      goals_for: game.home.goals,
      goals_against: game.away.goals,
      shots_for: game.home.shots,
      shots_against: game.away.shots,
      shots_on_target_for: game.home.shots_on_target,
      shots_on_target_against: game.away.shots_on_target,
      xg_openplay: game.home.openplay_xg,
      xga_openplay: game.away.openplay_xg,
      xg_setpiece: homeSetpieceXg,
      xga_setpiece: awaySetpieceXg,
      source: "sofascore",
    });
    // Away-side row (mirrored)
    rows.push({
      team: awayTeam,
      opponent: homeTeam,
      league: lg,
      venue: "away",
      match_date: matchDate,
      xg: game.away.sum_xg,
      xga: game.home.sum_xg,
      goals_for: game.away.goals,
      goals_against: game.home.goals,
      shots_for: game.away.shots,
      shots_against: game.home.shots,
      shots_on_target_for: game.away.shots_on_target,
      shots_on_target_against: game.home.shots_on_target,
      xg_openplay: game.away.openplay_xg,
      xga_openplay: game.home.openplay_xg,
      xg_setpiece: awaySetpieceXg,
      xga_setpiece: homeSetpieceXg,
      source: "sofascore",
    });

    perLeague[lg] = (perLeague[lg] || 0) + 2;
  }

  return { rows, perLeague, skippedNoOpponent, skippedCanonicalize };
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`🔗 Sofascore → team_xg_history Bridge${DRY ? " (DRY RUN)" : ""}`);
  if (SINCE) console.log(`   Since filter: match_date >= ${SINCE}`);
  console.log("");

  // 1. Fetch chance_quality rows (premium + partial tier with xG)
  let qs = `select=*&data_quality_tier=in.(premium,partial)&sum_xg=not.is.null`;
  if (SINCE) {
    const sinceTs = Math.floor(new Date(SINCE).getTime() / 1000);
    qs += `&start_timestamp=gte.${sinceTs}`;
  }
  console.log("📥 Fetching sofascore_team_chance_quality rows...");
  const cq = await fetchAll("sofascore_team_chance_quality", qs);
  console.log(`   ${cq.length} rows fetched`);

  // 2-3. Translate via pure function (extracted for unit tests)
  const { rows: xghRows, perLeague, skippedNoOpponent, skippedCanonicalize } =
    buildTeamXgRows(cq);
  console.log(`   ${new Set(cq.map(r => r.game_id)).size} unique games\n`);

  console.log(`📊 Translation summary:`);
  console.log(`   ${xghRows.length} team_xg_history rows ready (${xghRows.length/2} match-pairs)`);
  if (skippedNoOpponent > 0) console.log(`   ⚠ ${skippedNoOpponent} games skipped (missing home or away row)`);
  if (skippedCanonicalize > 0) console.log(`   ⚠ ${skippedCanonicalize} games skipped (team name canonicalize failed)`);
  console.log(`\n   Per-league breakdown:`);
  for (const [lg, n] of Object.entries(perLeague).sort()) {
    console.log(`     ${lg.padEnd(20)} ${n} rows (${n/2} matches)`);
  }

  if (VERBOSE) {
    console.log(`\n   Sample (first 3 rows):`);
    for (const r of xghRows.slice(0, 3)) {
      console.log(`     ${r.match_date} ${r.team} (${r.venue}) vs ${r.opponent} | xg=${r.xg} xga=${r.xga} g=${r.goals_for}:${r.goals_against}`);
    }
  }

  if (DRY) {
    console.log(`\n🟡 DRY RUN — no writes performed. Drop --dry to upsert.`);
    return;
  }

  // 4. Batched upsert
  console.log(`\n📤 Upserting in batches of 500...`);
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < xghRows.length; i += BATCH) {
    const slice = xghRows.slice(i, i + BATCH);
    const n = await upsertBatch(slice);
    upserted += n;
    process.stdout.write(`   ${upserted}/${xghRows.length}...\r`);
  }
  console.log(`\n✅ Done — ${upserted} rows upserted.`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

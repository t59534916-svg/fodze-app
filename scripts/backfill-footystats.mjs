#!/usr/bin/env node
/**
 * FODZE FootyStats Integration — 3. Liga xG backfill (and other non-Understat leagues)
 *
 * FootyStats exposes real per-match xG for leagues that Understat doesn't
 * cover — most importantly the 3. Liga. Without this, the 3. Liga falls
 * back to either the league-average heuristic (in MatchdayContext) or
 * the noisier goals-proxy (backfill-liga3-goals.mjs).
 *
 * This script ONLY runs when a FOOTYSTATS_API_KEY env var is present.
 * Without the key it's a no-op — logs "skipped" so the cron workflow
 * isn't red for a non-error condition.
 *
 * Activate by:
 *   1. Subscribe to FootyStats (https://footystats.org/api)
 *   2. Add FOOTYSTATS_API_KEY to .env.local + GitHub Secrets
 *   3. The nightly cron picks it up automatically (no code change)
 *
 * Usage:
 *   node scripts/backfill-footystats.mjs --league liga3            # single league
 *   node scripts/backfill-footystats.mjs --league liga3 --dry      # preview
 *   node scripts/backfill-footystats.mjs --league liga3 --season 2025
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
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

const API_KEY = process.env.FOOTYSTATS_API_KEY;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueArg = args.find((_, i) => args[i - 1] === "--league") || "liga3";
const seasonArg = args.find((_, i) => args[i - 1] === "--season") || "2025";

// FootyStats' internal league IDs — populate as we integrate more leagues.
// Numbers from https://footystats.org/api/documentations/league-list
// 3. Liga is ID 4 in the 2025/26 season. Other leagues included for
// opportunistic future use.
const FOOTYSTATS_LEAGUE_IDS = {
  liga3: 4,               // 3. Liga
  championship: 3,        // EFL Championship
  league_one: 5,          // EFL League One
  league_two: 6,          // EFL League Two
  // Top-5 leagues NOT listed here — Understat is higher quality.
};

function gracefulExit(reason) {
  console.log(`ℹ️  ${reason} — skipping FootyStats backfill.`);
  console.log(`    (This is not an error — the script no-ops without credentials.)`);
  process.exit(0);
}

if (!API_KEY) gracefulExit("FOOTYSTATS_API_KEY not set");
if (!SUPA_URL || !SUPA_KEY) gracefulExit("Supabase env not set");

const leagueId = FOOTYSTATS_LEAGUE_IDS[leagueArg];
if (!leagueId) {
  console.log(`❌ League "${leagueArg}" has no FootyStats ID mapping. Add to FOOTYSTATS_LEAGUE_IDS.`);
  process.exit(1);
}

// ─── FootyStats API fetch ────────────────────────────────────────

async function fetchMatches(leagueId, season) {
  // FootyStats endpoint: /league-matches
  // Returns per-match info including team_a_xg, team_b_xg
  const url = `https://api.football-data-api.com/league-matches?key=${API_KEY}&league_id=${leagueId}&season=${season}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`FootyStats API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  // FootyStats wraps in { success, data: [matches] }
  if (!data.success) throw new Error(`FootyStats API error: ${data.message || "unknown"}`);
  return data.data || [];
}

// ─── Supabase upsert ─────────────────────────────────────────────

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function upsertRows(rows) {
  if (DRY) return;
  // Conflict target matches the real UNIQUE constraint from
  // migration-phase1-2.sql: (team, league, match_date, venue). A typo here
  // silently 400s every run and rows never land.
  const resp = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
    {
      method: "POST",
      headers: { ...SUPA_HEADERS, Prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify(rows),
    },
  );
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Upsert failed (${resp.status}): ${msg}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`⚽ FootyStats Backfill${DRY ? " (DRY)" : ""} · ${leagueArg} · season ${seasonArg}\n`);

  const matches = await fetchMatches(leagueId, seasonArg);
  console.log(`📋 ${matches.length} matches from FootyStats`);
  const played = matches.filter((m) => m.status === "complete");
  console.log(`    ${played.length} completed\n`);

  if (played.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const rows = [];
  for (const match of played) {
    // FootyStats fields (names from their docs; if they change we catch here):
    //   home_name, away_name, homeGoalCount, awayGoalCount,
    //   team_a_xg, team_b_xg, date_unix
    const xgH = Number(match.team_a_xg);
    const xgA = Number(match.team_b_xg);
    if (!Number.isFinite(xgH) || !Number.isFinite(xgA)) continue;

    const date = new Date((match.date_unix || 0) * 1000).toISOString().slice(0, 10);
    if (!date || date.startsWith("1970")) continue;

    // Home-perspective row
    rows.push({
      team: match.home_name,
      opponent: match.away_name,
      league: leagueArg,
      venue: "home",
      match_date: date,
      xg: +xgH.toFixed(2),
      xga: +xgA.toFixed(2),
      goals_for: match.homeGoalCount || 0,
      goals_against: match.awayGoalCount || 0,
      source: "footystats",
    });
    // Away-perspective row
    rows.push({
      team: match.away_name,
      opponent: match.home_name,
      league: leagueArg,
      venue: "away",
      match_date: date,
      xg: +xgA.toFixed(2),
      xga: +xgH.toFixed(2),
      goals_for: match.awayGoalCount || 0,
      goals_against: match.homeGoalCount || 0,
      source: "footystats",
    });
  }

  console.log(`📦 Built ${rows.length} rows (${played.length} matches × 2 perspectives)`);

  if (DRY) {
    console.log("🔍 DRY — sample row:", rows[0]);
    return;
  }

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertRows(rows.slice(i, i + BATCH));
    inserted += Math.min(BATCH, rows.length - i);
    process.stdout.write(`\r  Upserted ${inserted}/${rows.length}...`);
  }
  console.log(`\n✅ Done — ${inserted} rows upserted (source=footystats).`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * FODZE xG Sync — Uploads Understat per-match xG data to Supabase
 *
 * Reads tools/understat_xg_matches.csv and upserts into team_xg_history table.
 * Designed to run after scrape-understat.py.
 *
 * Usage:
 *   node scripts/sync-xg-to-supabase.mjs
 *   node scripts/sync-xg-to-supabase.mjs --league bundesliga
 *   node scripts/sync-xg-to-supabase.mjs --dry
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CSV_FILE = join(PROJECT_ROOT, "tools", "understat_xg_matches.csv");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h.trim()] = values[i]?.trim()));
    return row;
  });
}

async function upsertBatch(rows) {
  if (DRY) {
    console.log(`  [DRY] Would upsert ${rows.length} rows`);
    return;
  }

  const supaRows = rows.map((r) => ({
    team: r.home,
    league: r.league,
    opponent: r.away,
    venue: "home",
    match_date: r.date,
    xg: parseFloat(r.home_xg),
    xga: parseFloat(r.away_xg),
    goals_for: parseInt(r.home_goals),
    goals_against: parseInt(r.away_goals),
    source: "understat",
  }));

  // Also add away perspective
  rows.forEach((r) => {
    supaRows.push({
      team: r.away,
      league: r.league,
      opponent: r.home,
      venue: "away",
      match_date: r.date,
      xg: parseFloat(r.away_xg),
      xga: parseFloat(r.home_xg),
      goals_for: parseInt(r.away_goals),
      goals_against: parseInt(r.home_goals),
      source: "understat",
    });
  });

  // Batch upsert (Supabase handles duplicates via UNIQUE constraint)
  const BATCH_SIZE = 500;
  for (let i = 0; i < supaRows.length; i += BATCH_SIZE) {
    const batch = supaRows.slice(i, i + BATCH_SIZE);
    const resp = await fetch(`${SUPA_URL}/rest/v1/team_xg_history`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(batch),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`  ERROR batch ${i}: ${resp.status} ${txt.substring(0, 200)}`);
    }
  }
}

async function main() {
  console.log("FODZE xG Sync → Supabase");

  const csvText = readFileSync(CSV_FILE, "utf-8");
  let rows = parseCSV(csvText);
  console.log(`  Loaded ${rows.length} matches from ${CSV_FILE}`);

  if (leagueFilter) {
    rows = rows.filter((r) => r.league === leagueFilter);
    console.log(`  Filtered to ${rows.length} ${leagueFilter} matches`);
  }

  if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
    console.error("ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    console.log("  Set env vars or use --dry");
    process.exit(1);
  }

  // Group by league for progress reporting
  const byLeague = {};
  rows.forEach((r) => {
    byLeague[r.league] = byLeague[r.league] || [];
    byLeague[r.league].push(r);
  });

  for (const [league, leagueRows] of Object.entries(byLeague)) {
    console.log(`  ${league}: ${leagueRows.length} matches`);
    await upsertBatch(leagueRows);
  }

  console.log(`\nDone. ${rows.length} matches synced (${rows.length * 2} team_xg_history rows).`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

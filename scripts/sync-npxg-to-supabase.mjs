#!/usr/bin/env node
/**
 * FODZE npxG Sync — Uploads full Understat data (incl. npxG) to Supabase
 *
 * Reads tools/understat_full_matches.csv (from scrape-understat-full.py)
 * and upserts into team_xg_history table with npxg/npxga columns.
 *
 * The full CSV has per-team-per-match rows (already venue-specific),
 * so NO double-entry needed — each row maps 1:1 to a Supabase row.
 *
 * Prerequisites:
 *   1. Run migration: scripts/migration-npxg.sql (adds npxg/npxga columns)
 *   2. Run scraper: python3 tools/scrape-understat-full.py
 *
 * Usage:
 *   node scripts/sync-npxg-to-supabase.mjs
 *   node scripts/sync-npxg-to-supabase.mjs --league bundesliga
 *   node scripts/sync-npxg-to-supabase.mjs --dry
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CSV_FILE = join(PROJECT_ROOT, "tools", "understat_full_matches.csv");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

// League name mapping: Understat CSV → Supabase canonical
const LEAGUE_MAP = {
  bundesliga: "Bundesliga",
  epl: "EPL",
  la_liga: "La_liga",
  serie_a: "Serie_A",
  ligue_1: "Ligue_1",
};

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
    console.log(`  [DRY] Sample: ${JSON.stringify(rows[0])}`);
    return;
  }

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
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
      console.error(
        `  ERROR batch ${i / BATCH_SIZE}: ${resp.status} ${txt.substring(0, 300)}`
      );
    } else {
      process.stdout.write(".");
    }
  }
  console.log();
}

async function main() {
  console.log("═══ FODZE npxG Sync → Supabase ═══");
  console.log(`  Source: ${CSV_FILE}`);

  const csvText = readFileSync(CSV_FILE, "utf-8");
  let rows = parseCSV(csvText);
  console.log(`  Loaded ${rows.length} team-match entries`);

  if (leagueFilter) {
    rows = rows.filter((r) => r.league === leagueFilter);
    console.log(`  Filtered to ${rows.length} ${leagueFilter} entries`);
  }

  if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
    console.error("ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    console.log("  Set env vars or use --dry to preview");
    process.exit(1);
  }

  // Build opponent lookup: for each (league, date, team), find the other team
  // The full CSV has 2 rows per match (home + away), so we can pair them.
  const matchPairs = {}; // key: "league|date|scored-missed" → [row1, row2]
  rows.forEach((r) => {
    // Group by league + date + goals (home scored=away missed and vice versa)
    const key = `${r.league}|${r.date}`;
    if (!matchPairs[key]) matchPairs[key] = [];
    matchPairs[key].push(r);
  });

  // Map (league, date, team) → opponent
  const opponentMap = {};
  for (const pair of Object.values(matchPairs)) {
    if (pair.length === 2) {
      opponentMap[`${pair[0].league}|${pair[0].date}|${pair[0].team}`] = pair[1].team;
      opponentMap[`${pair[1].league}|${pair[1].date}|${pair[1].team}`] = pair[0].team;
    } else {
      // More than 2 teams on same date — match by scored/missed
      for (const r of pair) {
        const opp = pair.find(
          (o) => o.team !== r.team && o.scored === r.missed && o.missed === r.scored
        );
        if (opp) {
          opponentMap[`${r.league}|${r.date}|${r.team}`] = opp.team;
        }
      }
    }
  }

  // Transform CSV rows to Supabase rows
  const supaRows = rows.map((r) => ({
    team: r.team,
    league: LEAGUE_MAP[r.league] || r.league,
    opponent: opponentMap[`${r.league}|${r.date}|${r.team}`] || "",
    venue: r.h_a === "h" ? "home" : "away",
    match_date: r.date,
    xg: parseFloat(r.xg) || 0,
    xga: parseFloat(r.xga) || 0,
    npxg: parseFloat(r.npxg) || null,
    npxga: parseFloat(r.npxga) || null,
    goals_for: parseInt(r.scored) || 0,
    goals_against: parseInt(r.missed) || 0,
    source: "understat",
  }));

  // Group by league for progress reporting
  const byLeague = {};
  supaRows.forEach((r) => {
    byLeague[r.league] = byLeague[r.league] || [];
    byLeague[r.league].push(r);
  });

  for (const [league, leagueRows] of Object.entries(byLeague)) {
    console.log(`\n  ${league}: ${leagueRows.length} rows`);
    await upsertBatch(leagueRows);
  }

  console.log(
    `\n═══ Done. ${supaRows.length} rows synced (${Object.keys(byLeague).length} leagues). ═══`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

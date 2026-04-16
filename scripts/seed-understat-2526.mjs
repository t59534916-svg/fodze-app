#!/usr/bin/env node
/**
 * FODZE Understat 2025/26 Backfill Seeder
 *
 * Reads JSON files produced by the Browser-Console script (see CLAUDE.md
 * "Browser-Console Backfill") and upserts per-match xG history into
 * Supabase `team_xg_history`.
 *
 * Usage:
 *   1. Run the browser script on https://understat.com/league/<League>/2025
 *   2. Paste the JSON output into a file like `understat-bundesliga-2526.json`
 *   3. node scripts/seed-understat-2526.mjs --file understat-bundesliga-2526.json --league bundesliga
 *
 * Optional flags:
 *   --dry            Preview without writing
 *   --season 2025    Season identifier (default: 2025, meaning 2025/26)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
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

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const fileArg = args.find((_, i) => args[i - 1] === "--file");
const leagueArg = args.find((_, i) => args[i - 1] === "--league");

if (!fileArg || !leagueArg) {
  console.error("Usage: node scripts/seed-understat-2526.mjs --file <json> --league <league-key>");
  process.exit(1);
}

const json = JSON.parse(readFileSync(fileArg, "utf-8"));
console.log(`📂 Loaded ${Object.keys(json).length} teams from ${fileArg}`);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY,
);

// Convert browser-script output into team_xg_history rows
const rows = [];
for (const [teamName, data] of Object.entries(json)) {
  if (!data.history || !Array.isArray(data.history)) {
    console.warn(`  ⚠️ ${teamName}: no history field, skipping`);
    continue;
  }
  for (const match of data.history) {
    if (!match.date || !match.opponent) continue;
    rows.push({
      team: teamName,
      opponent: match.opponent,
      league: leagueArg,
      venue: match.venue, // 'h' or 'a'
      match_date: match.date,
      xg: match.xg,
      xga: match.xga,
      goals_for: match.goals_for,
      goals_against: match.goals_against,
      source: "understat",
    });
  }
}

console.log(`📦 Built ${rows.length} match-rows for ${leagueArg}`);

if (DRY) {
  console.log("🔍 DRY RUN — sample rows:");
  console.log(rows.slice(0, 3));
  console.log(`Would upsert ${rows.length} rows.`);
  process.exit(0);
}

// Upsert in batches of 500
const BATCH = 500;
let inserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const { error } = await supabase
    .from("team_xg_history")
    .upsert(batch, { onConflict: "team,opponent,league,venue,match_date" });
  if (error) {
    console.error(`❌ Batch ${i / BATCH + 1} failed:`, error.message);
    process.exit(1);
  }
  inserted += batch.length;
  process.stdout.write(`\r  Upserted ${inserted}/${rows.length}...`);
}
console.log(`\n✅ Done — ${inserted} rows upserted into team_xg_history (${leagueArg}).`);

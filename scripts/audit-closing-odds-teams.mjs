#!/usr/bin/env node
/**
 * FODZE Closing-Odds Team-Name Audit
 * ══════════════════════════════════
 * Lists the distinct CSV-side team names per league in odds_closing_history,
 * with match counts. Used to reconcile football-data.co.uk names against
 * the `csv` namespace of src/lib/team-resolver.ts::TEAM_REGISTRY before
 * downstream Benter / Dirichlet joins try to match back to FODZE names.
 *
 * Output: for each league, distinct team names sorted by match count,
 * followed by any that look suspect (single-match teams are usually data
 * glitches; teams present in bets.home_team but not here reveal stale maps).
 *
 * Usage:
 *   node scripts/audit-closing-odds-teams.mjs
 *   node scripts/audit-closing-odds-teams.mjs --league bundesliga
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Supabase creds missing");
  process.exit(1);
}

const args = process.argv.slice(2);
const argValue = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const FILTER_LEAGUE = argValue("--league");

async function query(path) {
  const resp = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase query failed (${resp.status}): ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// PostgREST doesn't expose COUNT(*) GROUP BY natively, so we pull a window of
// recent rows and aggregate client-side. Cap at 5000 per league — enough to
// see the full current-season team list even for busy leagues.
async function teamsForLeague(league) {
  const rows = await query(
    `odds_closing_history?select=home_team,away_team,match_date&league=eq.${league}&order=match_date.desc&limit=5000`,
  );
  const counts = new Map();
  for (const r of rows) {
    counts.set(r.home_team, (counts.get(r.home_team) || 0) + 1);
    counts.set(r.away_team, (counts.get(r.away_team) || 0) + 1);
  }
  return { rows: rows.length, teams: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]) };
}

async function main() {
  // Discover which leagues we have data for.
  const leagues = FILTER_LEAGUE
    ? [FILTER_LEAGUE]
    : await query("odds_closing_history?select=league").then(rows =>
        Array.from(new Set(rows.map(r => r.league))).sort(),
      );

  if (leagues.length === 0) {
    console.log("No data in odds_closing_history yet. Run backfill-football-data-co-uk.mjs first.");
    return;
  }

  for (const lg of leagues) {
    const { rows, teams } = await teamsForLeague(lg);
    console.log(`\n═══ ${lg}  —  ${rows} rows sampled  /  ${teams.length} distinct teams`);
    for (const [team, n] of teams) {
      const flag = n < 5 ? " ⚠" : "";
      console.log(`   ${String(n).padStart(4)}  ${team}${flag}`);
    }
  }
  console.log();
  console.log("Teams marked ⚠ have <5 appearances — likely name variants or dropped sides.");
  console.log("Reconcile any surprises against src/lib/team-resolver.ts → TEAM_REGISTRY[].csv.");
}

main().catch(e => {
  console.error("[audit]", e);
  process.exit(1);
});

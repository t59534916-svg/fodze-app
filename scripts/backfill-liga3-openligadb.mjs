#!/usr/bin/env node
/**
 * FODZE Liga 3 Backfill — OpenLigaDB (free, no API key)
 *
 * The-Odds-API's scores endpoint is limited to daysFrom=3, which means its
 * goals-proxy backfill misses matches whenever the cron doesn't fire within
 * the 3-day window after a matchday. Result: Liga 3's team_xg_history stays
 * empty forever.
 *
 * OpenLigaDB (openligadb.de) is a free community-maintained API covering
 * German football — Bundesliga (bl1), 2. Bundesliga (bl2), 3. Liga (bl3) —
 * back to 1963. No key required. We pull the 2024/25 + 2025/26 seasons
 * for Liga 3 and write `team_xg_history` rows with source=goals-proxy
 * (same as the existing backfill, so downstream code treats them uniformly).
 *
 * Usage:
 *   node scripts/backfill-liga3-openligadb.mjs            # current season
 *   node scripts/backfill-liga3-openligadb.mjs --seasons 2024,2025
 *   node scripts/backfill-liga3-openligadb.mjs --dry
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Missing SUPABASE env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const seasonsArg = args.find((_, i) => args[i - 1] === "--seasons");
// Default: current season + previous (for EWMA depth on relegated/promoted
// teams). 2025 = 2025/26 in OpenLigaDB convention.
const SEASONS = seasonsArg
  ? seasonsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : ["2024", "2025"];

const LEAGUE_KEY = "liga3";     // FODZE internal
const OPENLIGA_KEY = "bl3";     // OpenLigaDB league shortcut

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// ─── Fetch + shape ────────────────────────────────────────────────

async function fetchSeason(season) {
  const url = `https://api.openligadb.de/getmatchdata/${OPENLIGA_KEY}/${season}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OpenLigaDB ${season} ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// OpenLigaDB returns a `matchResults` array with partial results (halftime,
// fulltime, extratime). The one we want is resultTypeID=2 for full-time;
// fall back to the last entry if that flag isn't present.
function finalResult(m) {
  if (!m.matchResults || m.matchResults.length === 0) return null;
  const ft = m.matchResults.find((r) => r.resultTypeID === 2);
  if (ft) return { home: ft.pointsTeam1, away: ft.pointsTeam2 };
  // Fallback: take the last result (usually fulltime if halftime came first)
  const last = m.matchResults[m.matchResults.length - 1];
  return { home: last.pointsTeam1, away: last.pointsTeam2 };
}

function buildRows(matches) {
  const rows = [];
  for (const m of matches) {
    if (!m.matchIsFinished) continue;
    const score = finalResult(m);
    if (!score || !Number.isFinite(score.home) || !Number.isFinite(score.away)) continue;
    const date = (m.matchDateTime || "").slice(0, 10);
    if (!date) continue;
    const home = m.team1?.teamName;
    const away = m.team2?.teamName;
    if (!home || !away) continue;

    // Home perspective
    rows.push({
      team: home, opponent: away,
      league: LEAGUE_KEY, venue: "home", match_date: date,
      xg: score.home, xga: score.away,
      goals_for: score.home, goals_against: score.away,
      source: "goals-proxy",
    });
    // Away perspective
    rows.push({
      team: away, opponent: home,
      league: LEAGUE_KEY, venue: "away", match_date: date,
      xg: score.away, xga: score.home,
      goals_for: score.away, goals_against: score.home,
      source: "goals-proxy",
    });
  }
  return rows;
}

async function upsertBatch(rows) {
  if (DRY) return;
  // ON CONFLICT must match the actual UNIQUE constraint
  // (team, league, match_date, venue) from migration-phase1-2.sql.
  // An earlier backfill referenced `opponent` in the conflict key and
  // silently 400'd for months — that's why team_xg_history was empty.
  const resp = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
    {
      method: "POST",
      headers: {
        ...SUPA_HEADERS,
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Upsert ${resp.status}: ${msg}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`⚽ Liga 3 OpenLigaDB Backfill${DRY ? " (DRY)" : ""}`);
  console.log(`   Seasons: ${SEASONS.join(", ")}\n`);

  let allRows = [];
  for (const season of SEASONS) {
    const matches = await fetchSeason(season);
    const rows = buildRows(matches);
    const teams = new Set([...rows.map((r) => r.team)]);
    console.log(
      `  📅 Season ${season}: ${matches.length} matches, ${rows.length / 2} completed, ${teams.size} teams`,
    );
    allRows = allRows.concat(rows);
  }

  console.log(`\n📦 Total: ${allRows.length} rows (${allRows.length / 2} matches, home+away perspectives)`);

  if (allRows.length === 0) {
    console.log("Nothing to upsert.");
    return;
  }

  if (DRY) {
    console.log("🔍 DRY — sample rows:");
    for (const r of allRows.slice(0, 3)) console.log(" ", r);
    return;
  }

  // Batch upsert (Supabase REST has a payload limit around ~50-100 rows)
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    await upsertBatch(batch);
    done += batch.length;
    process.stdout.write(`\r  Upserted ${done}/${allRows.length}...`);
  }

  console.log(`\n✅ Done — ${done} rows written to team_xg_history (source=goals-proxy)`);
  console.log("\nℹ️  Goals are a noisy xG proxy. For Liga 3 this is the best free source");
  console.log("   short of paying for FootyStats. Engine will use these once each team");
  console.log("   has ~15 entries (Bayesian shrinkage minimum).");
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * FODZE OpenLigaDB Backfill — German leagues (Bundesliga, 2. Bundesliga, 3. Liga)
 *
 * Filename historically said "liga3-openligadb" but the script was
 * generalized 2026-04-26 to also cover Bundesliga + 2. Bundesliga since
 * OpenLigaDB has free coverage of all three German tiers with no API key.
 * The cron in settle-bets.yml still references this filename — kept as-is
 * to avoid touching the workflow + secrets re-binding. Header reflects
 * actual scope.
 *
 * Why this exists: The-Odds-API's scores endpoint is daysFrom=3-limited,
 * which means goals-proxy backfill misses matches whenever the cron
 * doesn't fire within that window. OpenLigaDB has no such restriction —
 * matches stay queryable forever. We pull the current + previous season
 * for each league and write `team_xg_history` rows with source=goals-proxy
 * (xG is approximated from goals, since OpenLigaDB has no xG data).
 *
 * For Bundesliga + 2.Bundesliga the goals-proxy rows COEXIST with the
 * higher-quality footystats rows (UNIQUE on team/league/date/venue, so
 * upserts MERGE — footystats real xG wins because it lands second after
 * the manual CSV import). The OpenLigaDB rows fill the gap on days where
 * the manual FootyStats CSV import hasn't happened yet, ensuring the
 * dashboard never shows 0 entries for a finished match.
 *
 * Usage:
 *   node scripts/backfill-liga3-openligadb.mjs                          # all 3 leagues, current+prev season
 *   node scripts/backfill-liga3-openligadb.mjs --league liga3            # single league
 *   node scripts/backfill-liga3-openligadb.mjs --leagues bundesliga,liga3
 *   node scripts/backfill-liga3-openligadb.mjs --seasons 2024,2025
 *   node scripts/backfill-liga3-openligadb.mjs --dry
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

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

// FODZE league key → OpenLigaDB shortcut. OpenLigaDB doc:
// https://www.openligadb.de/Resources/OpenLigaDB-API.htm
//   bl1 = Bundesliga (1. Liga)
//   bl2 = 2. Bundesliga
//   bl3 = 3. Liga
const LEAGUE_MAP = {
  bundesliga:  "bl1",
  bundesliga2: "bl2",
  liga3:       "bl3",
};

// ─── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const seasonsArg = args.find((_, i) => args[i - 1] === "--seasons");
const leagueArg = args.find((_, i) => args[i - 1] === "--league");
const leaguesArg = args.find((_, i) => args[i - 1] === "--leagues");

let LEAGUES;
if (leagueArg) {
  LEAGUES = [leagueArg];
} else if (leaguesArg) {
  LEAGUES = leaguesArg.split(",").map((s) => s.trim()).filter(Boolean);
} else {
  LEAGUES = Object.keys(LEAGUE_MAP); // default: all 3 German leagues
}

for (const lg of LEAGUES) {
  if (!LEAGUE_MAP[lg]) {
    console.error(`❌ Unknown league "${lg}". Supported: ${Object.keys(LEAGUE_MAP).join(", ")}`);
    process.exit(1);
  }
}

// Default seasons: current + previous season (for EWMA depth on relegated/
// promoted teams). 2025 = 2025/26 in OpenLigaDB convention.
const SEASONS = seasonsArg
  ? seasonsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : ["2024", "2025"];

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// ─── Fetch + shape ────────────────────────────────────────────────

async function fetchSeason(openligaKey, season) {
  const url = `https://api.openligadb.de/getmatchdata/${openligaKey}/${season}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OpenLigaDB ${openligaKey} ${season} ${resp.status}: ${await resp.text()}`);
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

function buildRows(matches, fodzeLeague) {
  const rows = [];
  for (const m of matches) {
    if (!m.matchIsFinished) continue;
    const score = finalResult(m);
    if (!score || !Number.isFinite(score.home) || !Number.isFinite(score.away)) continue;
    const date = (m.matchDateTime || "").slice(0, 10);
    if (!date) continue;
    let home = m.team1?.teamName;
    let away = m.team2?.teamName;
    if (!home || !away) continue;

    // Canonicalize team names BEFORE insert. Without this, OpenLigaDB's
    // formal-DE conventions ("FC Bayern München") would coexist with
    // FootyStats' shortened forms ("Bayern München") and shots-model's
    // English ("Bayern Munich") as separate rows. Bug fixed in 6ce7162.
    home = canonicalize(home, fodzeLeague);
    away = canonicalize(away, fodzeLeague);

    // Home perspective
    rows.push({
      team: home, opponent: away,
      league: fodzeLeague, venue: "home", match_date: date,
      xg: score.home, xga: score.away,
      goals_for: score.home, goals_against: score.away,
      source: "goals-proxy",
    });
    // Away perspective
    rows.push({
      team: away, opponent: home,
      league: fodzeLeague, venue: "away", match_date: date,
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
  console.log(`⚽ OpenLigaDB Backfill${DRY ? " (DRY)" : ""}`);
  console.log(`   Leagues: ${LEAGUES.join(", ")}`);
  console.log(`   Seasons: ${SEASONS.join(", ")}\n`);

  let allRows = [];
  for (const fodzeLeague of LEAGUES) {
    const openligaKey = LEAGUE_MAP[fodzeLeague];
    for (const season of SEASONS) {
      try {
        const matches = await fetchSeason(openligaKey, season);
        const rows = buildRows(matches, fodzeLeague);
        const teams = new Set([...rows.map((r) => r.team)]);
        console.log(
          `  📅 ${fodzeLeague.padEnd(12)} ${season} (${openligaKey}): ${matches.length} matches, ${rows.length / 2} completed, ${teams.size} teams`,
        );
        allRows = allRows.concat(rows);
      } catch (e) {
        // Don't abort the whole run if one league/season fails — log + continue
        console.warn(`  ⚠ ${fodzeLeague} ${season} fetch failed: ${e.message}`);
      }
    }
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
  console.log("\nℹ️  Goals are a noisy xG proxy. For Bundesliga + 2.BL the FootyStats CSVs");
  console.log("   provide real xG and overwrite these via on-conflict merge. For Liga 3 this");
  console.log("   is the best free source short of paying for FootyStats API. Engine will use");
  console.log("   these once each team has ~15 entries (Bayesian shrinkage minimum).");
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

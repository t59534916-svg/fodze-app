#!/usr/bin/env node
/**
 * FODZE Deterministic Matchday Pipeline
 *
 * Scrapes Understat → computes xG sums + per-match history → seeds Supabase.
 * Zero LLM involvement for numerical data.
 *
 * Usage:
 *   node scripts/update-matchday.mjs --league bundesliga
 *   node scripts/update-matchday.mjs --league bundesliga --season 2025
 *   node scripts/update-matchday.mjs --league bundesliga --dry
 *
 * What it does:
 *   1. Scrapes Understat for all team xG data (deterministic HTML parse)
 *   2. Computes xG sums (xg_h8, xga_h8, xg_a8, xga_a8)
 *   3. Upserts per-match xG history to Supabase team_xg_history
 *   4. Outputs a report showing all teams with their xG data
 *
 * The LLM is ONLY used for: injuries, context, referee info (via /api/matchday)
 * Hard numbers (xG) come from this script — never from an LLM.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ─── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueArg = args.find((_, i) => args[i - 1] === "--league") || "bundesliga";
const seasonArg = args.find((_, i) => args[i - 1] === "--season") || "2025";
const windowArg = parseInt(args.find((_, i) => args[i - 1] === "--window") || "8");

// ─── Supabase ────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const envFile = readFileSync(join(PROJECT_ROOT, ".env.local"), "utf-8");
    const vars = {};
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch { return {}; }
}

const env = loadEnv();
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;

async function supabaseUpsert(table, rows) {
  if (!SUPA_URL || !SUPA_KEY) throw new Error("Missing SUPABASE_URL or SERVICE_KEY");
  const resp = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Supabase ${resp.status}: ${body}`);
  }
  return resp;
}

// ─── Understat Scraper ───────────────────────────────────────────────

const UNDERSTAT_LEAGUES = {
  bundesliga: "Bundesliga", epl: "EPL", la_liga: "La_liga",
  serie_a: "Serie_A", ligue_1: "Ligue_1", eredivisie: "Eredivisie",
};

const LEAGUE_KEYS = {
  Bundesliga: "bundesliga", EPL: "epl", La_liga: "la_liga",
  Serie_A: "serie_a", Ligue_1: "ligue_1", Eredivisie: "eredivisie",
};

function decodeHex(str) {
  return str.replace(/\\x([\dA-Fa-f]{2})/g, (_, g1) =>
    String.fromCharCode(parseInt(g1, 16))
  );
}

async function scrapeUnderstat(leagueSlug, season) {
  const leagueName = UNDERSTAT_LEAGUES[leagueSlug];
  if (!leagueName) throw new Error(`Unknown league: ${leagueSlug}`);

  const url = `https://understat.com/league/${leagueName}/${season}`;
  console.log(`  Fetching ${url} ...`);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (FODZE Pipeline)" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  const html = await resp.text();

  // Extract teamsData
  const teamsMatch = html.match(/var teamsData\s*=\s*JSON\.parse\('([^']+)'\)/);
  if (!teamsMatch?.[1]) throw new Error("teamsData not found in HTML");
  const teamsData = JSON.parse(decodeHex(teamsMatch[1]));

  // Extract datesData (match-level for per-match history)
  const datesMatch = html.match(/var datesData\s*=\s*JSON\.parse\('([^']+)'\)/);
  const datesData = datesMatch?.[1] ? JSON.parse(decodeHex(datesMatch[1])) : [];

  return { teamsData, datesData, leagueName };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══ FODZE Deterministic Pipeline ═══`);
  console.log(`  League: ${leagueArg} | Season: ${seasonArg} | Window: ${windowArg} | Dry: ${DRY}\n`);

  const { teamsData, datesData, leagueName } = await scrapeUnderstat(leagueArg, seasonArg);
  const leagueKey = LEAGUE_KEYS[leagueName] || leagueArg;

  // ── 1. Build per-match xG history (for Supabase team_xg_history) ──

  const historyRows = [];
  for (const m of datesData) {
    if (!m.isResult) continue;
    const date = m.datetime?.split(" ")[0] || "";
    const hTeam = m.h?.title || "";
    const aTeam = m.a?.title || "";
    const hXG = parseFloat(m.xG?.h) || 0;
    const aXG = parseFloat(m.xG?.a) || 0;
    const hGoals = parseInt(m.goals?.h) || 0;
    const aGoals = parseInt(m.goals?.a) || 0;

    historyRows.push({
      team: hTeam, opponent: aTeam, league: leagueKey, venue: "home",
      match_date: date, xg: hXG, xga: aXG, goals_for: hGoals, goals_against: aGoals,
    });
    historyRows.push({
      team: aTeam, opponent: hTeam, league: leagueKey, venue: "away",
      match_date: date, xg: aXG, xga: hXG, goals_for: aGoals, goals_against: hGoals,
    });
  }

  console.log(`  Parsed ${datesData.filter(m => m.isResult).length} matches → ${historyRows.length} history rows`);

  // ── 2. Upsert to Supabase ────────────────────────────────────────

  if (!DRY && historyRows.length > 0) {
    console.log(`  Upserting to Supabase team_xg_history...`);
    const BATCH = 500;
    let upserted = 0;
    for (let i = 0; i < historyRows.length; i += BATCH) {
      const batch = historyRows.slice(i, i + BATCH);
      await supabaseUpsert("team_xg_history", batch);
      upserted += batch.length;
    }
    console.log(`  ✅ ${upserted} rows upserted`);
  }

  // ── 3. Compute xG sums per team (for display/verification) ───────

  console.log(`\n  ── xG Summary (Last ${windowArg} Games per Venue) ──\n`);
  console.log("  Team                         | H-xG   H-xGA | A-xG   A-xGA | H-Gms A-Gms");
  console.log("  " + "-".repeat(80));

  const teamSummary = {};
  for (const t of Object.values(teamsData)) {
    const title = t.title;
    const history = t.history || [];

    const home = history.filter(h => h.h_a === "h" && h.result);
    const away = history.filter(h => h.h_a === "a" && h.result);
    const h8 = home.slice(-windowArg);
    const a8 = away.slice(-windowArg);

    const xg_h8 = +h8.reduce((s, m) => s + (parseFloat(m.xG) || 0), 0).toFixed(2);
    const xga_h8 = +h8.reduce((s, m) => s + (parseFloat(m.xGA) || 0), 0).toFixed(2);
    const xg_a8 = +a8.reduce((s, m) => s + (parseFloat(m.xG) || 0), 0).toFixed(2);
    const xga_a8 = +a8.reduce((s, m) => s + (parseFloat(m.xGA) || 0), 0).toFixed(2);

    teamSummary[title] = { xg_h8, xga_h8, xg_a8, xga_a8, hGames: h8.length, aGames: a8.length };

    console.log(
      `  ${title.padEnd(30)} | ${xg_h8.toFixed(1).padStart(5)}  ${xga_h8.toFixed(1).padStart(5)} | ${xg_a8.toFixed(1).padStart(5)}  ${xga_a8.toFixed(1).padStart(5)} | ${String(h8.length).padStart(5)} ${String(a8.length).padStart(5)}`
    );
  }

  console.log(`\n  Total: ${Object.keys(teamSummary).length} teams`);
  console.log(`  History rows: ${historyRows.length}`);
  console.log(`  Supabase: ${DRY ? "DRY RUN (no upsert)" : "✅ upserted"}`);
  console.log(`\n═══ DONE ═══\n`);
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});

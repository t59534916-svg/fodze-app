#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * FODZE Historical xG Backfill
 * ═══════════════════════════════════════════════════════════════════
 *
 * Scrapt historische per-Match xG-Daten von Understat (5 Top-Ligen)
 * und FBref (2. Bundesliga, Championship, Eredivisie) und seeded
 * sie in die Supabase `team_xg_history` Tabelle.
 *
 * Usage:
 *   node scripts/backfill-xg.mjs                    # Alle Ligen, alle Saisons
 *   node scripts/backfill-xg.mjs --league bundesliga # Nur Bundesliga
 *   node scripts/backfill-xg.mjs --season 2023       # Nur 2023/24
 *   node scripts/backfill-xg.mjs --dry               # Nur anzeigen, nicht seeden
 *
 * Rate Limits:
 *   Understat: 3s zwischen Requests
 *   FBref: 5s zwischen Requests (aggressiveres Rate-Limiting)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY
);

// ─── CLI Args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);
const DRY_RUN = hasFlag('--dry');
const LEAGUE_FILTER = getArg('--league');
const SEASON_FILTER = getArg('--season');

// ─── Config ──────────────────────────────────────────────────────────

const UNDERSTAT_LEAGUES = {
  bundesliga: { slug: "Bundesliga", seasons: ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"] },
  epl:        { slug: "EPL",        seasons: ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"] },
  la_liga:    { slug: "La_liga",    seasons: ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"] },
  serie_a:    { slug: "Serie_A",    seasons: ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"] },
  ligue_1:    { slug: "Ligue_1",    seasons: ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"] },
};

// FBref league IDs for xG-enabled leagues
const FBREF_LEAGUES = {
  bundesliga2:  { fbrefId: "33", name: "2. Bundesliga",  seasons: ["2017-2018", "2018-2019", "2019-2020", "2020-2021", "2021-2022", "2022-2023", "2023-2024", "2024-2025"] },
  championship: { fbrefId: "10", name: "Championship",    seasons: ["2017-2018", "2018-2019", "2019-2020", "2020-2021", "2021-2022", "2022-2023", "2023-2024", "2024-2025"] },
  eredivisie:   { fbrefId: "23", name: "Eredivisie",      seasons: ["2017-2018", "2018-2019", "2019-2020", "2020-2021", "2021-2022", "2022-2023", "2023-2024", "2024-2025"] },
};

const c = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', cyan: '\x1b[36m' };
const ok = (msg) => console.log(`${c.green}✓ ${msg}${c.reset}`);
const warn = (msg) => console.log(`${c.yellow}⚠ ${msg}${c.reset}`);
const info = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Understat Scraper (inline, no TS import) ────────────────────────

function decodeHex(str) {
  return str.replace(/\\x([\dA-Fa-f]{2})/g, (_, g1) => String.fromCharCode(parseInt(g1, 16)));
}

async function scrapeUnderstatSeason(leagueSlug, season) {
  const url = `https://understat.com/league/${leagueSlug}/${season}`;
  info(`Fetching ${url}...`);

  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (FODZE Backfill)" } });
  if (!resp.ok) throw new Error(`Understat ${resp.status}: ${url}`);

  const html = await resp.text();

  // Extract datesData (contains all matches)
  const datesMatch = html.match(/var datesData\s*=\s*JSON\.parse\('([^']+)'\)/);
  if (!datesMatch?.[1]) throw new Error(`No datesData in ${url}`);

  const matches = JSON.parse(decodeHex(datesMatch[1]));
  const rows = [];

  for (const m of matches) {
    if (!m.isResult) continue;
    const date = m.datetime?.split(" ")[0] || "";
    const homeTeam = m.h?.title || "";
    const awayTeam = m.a?.title || "";
    const homeXG = parseFloat(m.xG?.h) || 0;
    const awayXG = parseFloat(m.xG?.a) || 0;
    const homeGoals = parseInt(m.goals?.h) || 0;
    const awayGoals = parseInt(m.goals?.a) || 0;

    if (!homeTeam || !awayTeam || !date) continue;

    // Home perspective
    rows.push({
      team: homeTeam, opponent: awayTeam, venue: "home",
      match_date: date, xg: homeXG, xga: awayXG,
      goals_for: homeGoals, goals_against: awayGoals,
    });
    // Away perspective
    rows.push({
      team: awayTeam, opponent: homeTeam, venue: "away",
      match_date: date, xg: awayXG, xga: homeXG,
      goals_for: awayGoals, goals_against: homeGoals,
    });
  }

  return rows;
}

// ─── FBref Scraper (for 2.BL, Championship, Eredivisie) ─────────────

async function scrapeFBrefSeason(fbrefId, leagueName, season) {
  // FBref schedule page: https://fbref.com/en/comps/33/2023-2024/schedule/...
  const url = `https://fbref.com/en/comps/${fbrefId}/${season}/schedule/${season}-${leagueName.replace(/\s/g, "-")}-Scores-and-Fixtures`;
  info(`Fetching ${url}...`);

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html",
    },
  });

  if (!resp.ok) {
    warn(`FBref ${resp.status} for ${leagueName} ${season} — skipping`);
    return [];
  }

  const html = await resp.text();
  const { load } = await import("cheerio");
  const $ = load(html);

  const rows = [];
  const table = $("table.stats_table tbody");

  table.find("tr:not(.thead)").each((_, row) => {
    const cells = $(row).find("td, th");
    if (cells.length < 8) return;

    const date = $(cells[1]).text().trim();       // Date
    const homeTeam = $(cells[3]).text().trim();    // Home
    const score = $(cells[5]).text().trim();       // Score "2–1"
    const awayTeam = $(cells[7]).text().trim();    // Away

    if (!date || !homeTeam || !awayTeam || !score.includes("–")) return;

    const [hGoals, aGoals] = score.split("–").map(s => parseInt(s.trim()));
    if (isNaN(hGoals) || isNaN(aGoals)) return;

    // Try xG columns (FBref has them for some leagues since ~2018)
    const homeXGStr = cells.length > 9 ? $(cells[9]).text().trim() : "";
    const awayXGStr = cells.length > 10 ? $(cells[10]).text().trim() : "";
    const homeXG = homeXGStr ? parseFloat(homeXGStr) : null;
    const awayXG = awayXGStr ? parseFloat(awayXGStr) : null;

    // Home perspective
    rows.push({
      team: homeTeam, opponent: awayTeam, venue: "home",
      match_date: date,
      xg: homeXG ?? hGoals,     // Echte xG wenn vorhanden, sonst Tore
      xga: awayXG ?? aGoals,
      goals_for: hGoals, goals_against: aGoals,
    });
    // Away perspective
    rows.push({
      team: awayTeam, opponent: homeTeam, venue: "away",
      match_date: date,
      xg: awayXG ?? aGoals,
      xga: homeXG ?? hGoals,
      goals_for: aGoals, goals_against: hGoals,
    });
  });

  return rows;
}

// ─── Seed to Supabase ────────────────────────────────────────────────

async function seedBatch(league, rows) {
  if (DRY_RUN) {
    info(`[DRY] Would insert ${rows.length} rows for ${league}`);
    return 0;
  }

  // Upsert in batches of 500
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({ ...r, league }));
    const { error } = await supabase.from("team_xg_history").upsert(batch, {
      onConflict: "team,league,venue,match_date",
    });
    if (error) {
      warn(`Seed error: ${error.message}`);
    } else {
      inserted += batch.length;
    }
  }
  return inserted;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${c.bold}${c.cyan}⚽ FODZE xG BACKFILL${c.reset}`);
  console.log(`${c.dim}Historische xG-Daten in Supabase team_xg_history laden${c.reset}`);
  if (DRY_RUN) console.log(`${c.yellow}DRY RUN — keine Daten werden geschrieben${c.reset}`);
  console.log();

  let totalRows = 0;

  // ─── Understat Ligen (echte xG) ────────────────────────────────────
  for (const [key, config] of Object.entries(UNDERSTAT_LEAGUES)) {
    if (LEAGUE_FILTER && key !== LEAGUE_FILTER) continue;

    console.log(`${c.bold}${c.green}━━━ ${key.toUpperCase()} (Understat · echte xG) ━━━${c.reset}`);

    for (const season of config.seasons) {
      if (SEASON_FILTER && season !== SEASON_FILTER) continue;

      try {
        const rows = await scrapeUnderstatSeason(config.slug, season);
        const inserted = await seedBatch(key, rows);
        ok(`${key} ${season}: ${rows.length} Einträge${DRY_RUN ? " (dry)" : ` → ${inserted} geseeded`}`);
        totalRows += rows.length;
      } catch (e) {
        warn(`${key} ${season}: ${e.message}`);
      }

      await sleep(3000);  // Rate limit: 3s
    }
    console.log();
  }

  // ─── FBref Ligen (xG wenn vorhanden, sonst Tore) ──────────────────
  for (const [key, config] of Object.entries(FBREF_LEAGUES)) {
    if (LEAGUE_FILTER && key !== LEAGUE_FILTER) continue;

    console.log(`${c.bold}${c.yellow}━━━ ${key.toUpperCase()} (FBref · xG/Tore) ━━━${c.reset}`);

    for (const season of config.seasons) {
      if (SEASON_FILTER && season !== SEASON_FILTER) continue;

      try {
        const rows = await scrapeFBrefSeason(config.fbrefId, config.name, season);
        if (rows.length === 0) {
          warn(`${key} ${season}: Keine Daten gefunden`);
          continue;
        }

        const hasXG = rows.some(r => r.xg !== r.goals_for);
        const inserted = await seedBatch(key, rows);
        ok(`${key} ${season}: ${rows.length} Einträge (${hasXG ? "echte xG" : "Tore-Proxy"})${DRY_RUN ? " (dry)" : ` → ${inserted} geseeded`}`);
        totalRows += rows.length;
      } catch (e) {
        warn(`${key} ${season}: ${e.message}`);
      }

      await sleep(5000);  // FBref: 5s Rate Limit
    }
    console.log();
  }

  // ─── Summary ───────────────────────────────────────────────────────
  console.log(`${c.bold}${c.cyan}━━━ ZUSAMMENFASSUNG ━━━${c.reset}`);
  console.log(`  Gesamt: ${totalRows} Einträge`);
  console.log(`  Understat: ${Object.keys(UNDERSTAT_LEAGUES).length} Ligen × 8 Saisons = echte xG`);
  console.log(`  FBref: ${Object.keys(FBREF_LEAGUES).length} Ligen × 8 Saisons = xG/Tore`);
  if (DRY_RUN) console.log(`  ${c.yellow}DRY RUN — nichts geschrieben${c.reset}`);
  console.log();
}

main().catch(e => { console.error(`${c.red}Fatal: ${e.message}${c.reset}`); process.exit(1); });

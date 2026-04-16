#!/usr/bin/env node
/**
 * FODZE Matchday Generator — Fixtures → Matchday JSON
 * ════════════════════════════════════════════════════
 * Reads upcoming fixtures from Supabase (populated by fetch-odds.mjs)
 * and generates a matchday JSON skeleton ready for xG enrichment.
 *
 * Usage:
 *   node scripts/generate-matchday.mjs --league bundesliga
 *   node scripts/generate-matchday.mjs --league bundesliga --seed
 *   node scripts/generate-matchday.mjs --league bundesliga --days 7
 *
 * Flags:
 *   --league   Liga-Code (required)
 *   --seed     Also seed to Supabase matchdays table
 *   --days     Look-ahead window in days (default: 7)
 *   --dry      Print JSON but don't save
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  lookupTeamXG as lookupTeamXGShared,
  deriveForm,
  deriveTags,
} from './_lib/matchday-enrich.mjs';

// ─── Load .env.local ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ─── Config ───────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
const DRY = args.includes('--dry');
const SEED = args.includes('--seed');
const league = getArg('league');
const days = parseInt(getArg('days') || '7', 10);

if (!league) {
  console.error('❌ --league required (bundesliga, epl, la_liga, serie_a, ligue_1)');
  process.exit(1);
}
if (!SUPA_URL || !SUPA_KEY) {
  console.error('❌ Missing Supabase credentials in .env.local');
  process.exit(1);
}

// ─── FODZE Team Name Resolution (inline, no TS imports) ──────────
// Simple mapping: Odds-API name → FODZE name
const ODDS_TO_FODZE = {
  // Bundesliga
  "Bayern Munich": "FC Bayern München",
  "Bayer Leverkusen": "Bayer 04 Leverkusen",
  "Borussia Dortmund": "Borussia Dortmund",
  "RB Leipzig": "RB Leipzig",
  "Eintracht Frankfurt": "Eintracht Frankfurt",
  "VfB Stuttgart": "VfB Stuttgart",
  "SC Freiburg": "SC Freiburg",
  "TSG Hoffenheim": "TSG Hoffenheim",
  "VfL Wolfsburg": "VfL Wolfsburg",
  "Borussia Monchengladbach": "Borussia Mönchengladbach",
  "Werder Bremen": "SV Werder Bremen",
  "Augsburg": "FC Augsburg",
  "FSV Mainz 05": "1. FSV Mainz 05",
  "Union Berlin": "1. FC Union Berlin",
  "1. FC Heidenheim": "1. FC Heidenheim",
  "FC St. Pauli": "FC St. Pauli",
  "1. FC Köln": "1. FC Köln",
  "Hamburger SV": "Hamburger SV",
  "Holstein Kiel": "Holstein Kiel",
  "VfL Bochum": "VfL Bochum",
  // EPL
  "Brighton and Hove Albion": "Brighton & Hove Albion",
  "Wolverhampton Wanderers": "Wolverhampton Wanderers",
  "Bournemouth": "AFC Bournemouth",
  // La Liga
  "Barcelona": "FC Barcelona",
  "Atlético Madrid": "Atlético Madrid",
  "Athletic Bilbao": "Athletic Bilbao",
  "Villarreal": "FC Villarreal",
  "Sevilla": "FC Sevilla",
  "Valencia": "FC Valencia",
  "Getafe": "FC Getafe",
  "CA Osasuna": "CA Osasuna",
  "Alavés": "Deportivo Alavés",
  "Girona": "FC Girona",
  "Espanyol": "Espanyol Barcelona",
  "Levante": "UD Levante",
  "Elche CF": "Elche CF",
  "Oviedo": "Real Oviedo",
  "Mallorca": "RCD Mallorca",
  // Serie A
  "Atalanta BC": "Atalanta",
  "AS Roma": "Roma",
  "Sassuolo": "US Sassuolo",
  "Como": "Como 1907",
};

function resolveName(apiName) {
  return ODDS_TO_FODZE[apiName] || apiName;
}

// ─── League Labels ────────────────────────────────────────────────
const LEAGUE_NAMES = {
  bundesliga: "Bundesliga", epl: "Premier League",
  la_liga: "La Liga", serie_a: "Serie A", ligue_1: "Ligue 1",
  bundesliga2: "2. Bundesliga", liga3: "3. Liga",
  championship: "EFL Championship",
};

// ─── Fetch fixtures from Supabase ─────────────────────────────────
async function loadFixtures() {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 86400000).toISOString();

  const url = `${SUPA_URL}/rest/v1/upcoming_fixtures?` + new URLSearchParams({
    league: `eq.${league}`,
    commence_time: `gte.${now}`,
    order: 'commence_time.asc',
  });

  const resp = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Failed to load fixtures: ${resp.status} ${txt}`);
  }

  const fixtures = await resp.json();
  // Filter to requested day window
  return fixtures.filter(f => f.commence_time <= future);
}

// ─── xG enrichment from team_xg_history ──────────────────────────
// Previously: matchdays stored with xg_h8=0 skelett, relied on MatchdayContext
// re-enriching in the browser on every visit. That meant stored JSONs showed
// "0% xG coverage" in the audit + engine paths that don't go through
// MatchdayContext (Goldilocks, fuck-betting standalone) had no data.
// Now: enrichment happens once at generation and gets persisted.

async function loadLeagueXGHistory(lg) {
  // Pull up to 3000 rows ordered recent-first. Each team plays ~20
  // venue-specific matches per season so this covers 2 seasons for 20 teams.
  const url = `${SUPA_URL}/rest/v1/team_xg_history?` + new URLSearchParams({
    league: `eq.${lg}`,
    order: 'match_date.desc',
    limit: '3000',
  });
  const resp = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!resp.ok) return [];
  return resp.json();
}

// Re-export with the same local name to keep the rest of this file stable.
// Normalization (umlauts, FC/SC/VfB strip, alias map) lives in the shared
// helper so backfill-enrich-matchdays.mjs gets the exact same logic.
const lookupTeamXG = lookupTeamXGShared;

function summarizeXG(entries) {
  if (!entries || entries.length === 0) return null;
  const xgSum = +entries.reduce((s, r) => s + Number(r.xg || 0), 0).toFixed(2);
  const xgaSum = +entries.reduce((s, r) => s + Number(r.xga || 0), 0).toFixed(2);
  // Chronological order for EWMA — history[0] = oldest
  const chrono = [...entries].reverse();
  return {
    xg: xgSum,
    xga: xgaSum,
    games: entries.length,
    history: chrono.map((r) => ({
      xg: Number(r.xg),
      xga: Number(r.xga),
      date: r.match_date,
      opponent: r.opponent || undefined,
    })),
  };
}

// ─── Build Matchday JSON ──────────────────────────────────────────
function buildMatchdayJSON(fixtures, xgHistory) {
  if (fixtures.length === 0) return null;

  // Determine matchday label from first fixture date
  const firstDate = fixtures[0].commence_time.slice(0, 10);
  const dates = [...new Set(fixtures.map(f => f.commence_time.slice(0, 10)))];

  // Coverage counters for the final log line — users see at a glance whether
  // enrichment landed (or whether they need to seed xG data first).
  let enrichedHome = 0;
  let enrichedAway = 0;
  let formHome = 0;
  let formAway = 0;
  let tagsApplied = 0;

  const matchday = {
    league: LEAGUE_NAMES[league] || league,
    matchday: `Spieltag (auto)`,
    date: firstDate,
    matches: fixtures.map(f => {
      const homeApi = f.home_team;
      const awayApi = f.away_team;
      const homeFodze = resolveName(homeApi);
      const awayFodze = resolveName(awayApi);

      // Format kickoff as "YYYY-MM-DD HH:MM"
      const ko = new Date(f.commence_time);
      const kickoff = `${ko.getFullYear()}-${String(ko.getMonth() + 1).padStart(2, '0')}-${String(ko.getDate()).padStart(2, '0')} ${String(ko.getHours()).padStart(2, '0')}:${String(ko.getMinutes()).padStart(2, '0')}`;

      // Look up last 8 venue-specific entries for each team. Try both the
      // Odds-API name (matches live_odds + goals-proxy rows) AND the FODZE
      // name (matches Understat-scraped rows) so we catch the team regardless
      // of which source populated their history.
      const homeEntries = xgHistory.length > 0
        ? lookupTeamXG(xgHistory, [homeApi, homeFodze], "home", 8)
        : [];
      const awayEntries = xgHistory.length > 0
        ? lookupTeamXG(xgHistory, [awayApi, awayFodze], "away", 8)
        : [];
      const homeXG = summarizeXG(homeEntries);
      const awayXG = summarizeXG(awayEntries);
      if (homeXG) enrichedHome++;
      if (awayXG) enrichedAway++;

      // Derive form (W D L string over last 5 matches, venue-agnostic).
      // Feeds formMultiplier in the engine — was always "" before, so the
      // form multiplier was identically 1.0 for every match.
      const homeForm = xgHistory.length > 0 ? deriveForm(xgHistory, [homeApi, homeFodze]) : "";
      const awayForm = xgHistory.length > 0 ? deriveForm(xgHistory, [awayApi, awayFodze]) : "";
      if (homeForm) formHome++;
      if (awayForm) formAway++;

      // Derive tags: DERBY via rivalry map, ROTATION via fixture density.
      // Engine's applyTagCorrections() multiplies λ by TAG_MAP[tag] so these
      // only fire when present — never fired before because tags was [].
      const derivedTags = deriveTags(f, fixtures);
      if (derivedTags.length > 0) tagsApplied++;

      return {
        home: {
          name: homeFodze,
          xg_h8: homeXG?.xg ?? 0,
          xga_h8: homeXG?.xga ?? 0,
          games: homeXG?.games ?? 8,
          form: homeForm,
          injuries: "",
          yellow_risk: "",
          ...(homeXG ? { xg_h_history: homeXG.history } : {}),
        },
        away: {
          name: awayFodze,
          xg_a8: awayXG?.xg ?? 0,
          xga_a8: awayXG?.xga ?? 0,
          games: awayXG?.games ?? 8,
          form: awayForm,
          injuries: "",
          yellow_risk: "",
          ...(awayXG ? { xg_a_history: awayXG.history } : {}),
        },
        tags: derivedTags,
        context: "",
        referee: "",
        kickoff,
      };
    }),
    // Attached to the JSON for debugging — not used by the engine.
    _enrichment: {
      home_xg: `${enrichedHome}/${fixtures.length}`,
      away_xg: `${enrichedAway}/${fixtures.length}`,
      home_form: `${formHome}/${fixtures.length}`,
      away_form: `${formAway}/${fixtures.length}`,
      tags_applied: `${tagsApplied}/${fixtures.length}`,
      source: "team_xg_history (Understat/shots-model/goals-proxy)",
      enriched_at: new Date().toISOString(),
    },
  };

  return matchday;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`📅 FODZE Matchday Generator`);
  console.log(`   Liga: ${league} (${LEAGUE_NAMES[league] || '?'})`);
  console.log(`   Fenster: nächste ${days} Tage`);
  console.log();

  const [fixtures, xgHistory] = await Promise.all([
    loadFixtures(),
    loadLeagueXGHistory(league),
  ]);
  console.log(`   ${fixtures.length} Fixtures gefunden`);
  console.log(`   ${xgHistory.length} xG-Einträge für diese Liga im team_xg_history`);

  if (fixtures.length === 0) {
    console.log('   ⚠ Keine anstehenden Spiele. Wurde fetch-odds.mjs schon ausgeführt?');
    return;
  }
  if (xgHistory.length === 0) {
    console.log(
      '   ⚠ Keine xG-Historie für diese Liga — Matchday wird als Skelett (xg_h8=0) erstellt.',
    );
    console.log(
      '      → Vorher backfill-<source>.mjs laufen lassen (z.B. backfill-liga3-openligadb.mjs)',
    );
  }

  const matchday = buildMatchdayJSON(fixtures, xgHistory);

  // Print summary with enrichment status per match. Two-char badge:
  // [0] xG present, [1] form present. Tags shown inline when non-empty.
  for (const m of matchday.matches) {
    const hXG = m.home.xg_h_history ? "✓" : "·";
    const aXG = m.away.xg_a_history ? "✓" : "·";
    const hForm = m.home.form ? "✓" : "·";
    const aForm = m.away.form ? "✓" : "·";
    const tags = m.tags.length ? ` [${m.tags.join(",")}]` : "";
    console.log(
      `   ${hXG}${aXG}·${hForm}${aForm} ${m.home.name} vs ${m.away.name} (${m.kickoff})${tags}`,
    );
  }
  const e = matchday._enrichment;
  console.log(
    `\n   xG: ${e.home_xg} home / ${e.away_xg} away  ·  Form: ${e.home_form} / ${e.away_form}  ·  Tags: ${e.tags_applied}\n`,
  );

  // Write JSON file
  const outPath = resolve(__dirname, '..', `matchday-${league}-auto.json`);
  writeFileSync(outPath, JSON.stringify(matchday, null, 2));
  console.log(`   ✅ JSON geschrieben: ${outPath}`);

  // Optionally seed to Supabase
  if (SEED && !DRY) {
    console.log('   Seeding nach Supabase...');
    // Import and use the seed logic
    const seedResp = await fetch(`${SUPA_URL}/rest/v1/matchdays`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        league,
        matchday_label: matchday.matchday,
        match_date: matchday.date,
        data: matchday,
      }),
    });

    if (!seedResp.ok) {
      console.error(`   ❌ Seed error: ${await seedResp.text()}`);
    } else {
      const result = await seedResp.json();
      console.log(`   ✅ Geseeded! ID: ${result[0]?.id || 'ok'}`);
    }
  }

  console.log();
  console.log('   💡 Nächste Schritte:');
  console.log('      1. xG-Daten ergänzen (Understat Browser-Script)');
  console.log('      2. Verletzungen/Kontext hinzufügen');
  console.log('      3. node scripts/seed-matchday.mjs --file matchday-*.json --league ' + league);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

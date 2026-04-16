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

// Fuzzy-match a FODZE/Odds-API team name against the team_xg_history name
// space (Understat/shots-model/goals-proxy all use different conventions).
// Returns the last N venue-specific entries for the best match.
function lookupTeamXG(historyRows, teamNames, venue, n = 8) {
  const candidates = Array.isArray(teamNames) ? teamNames : [teamNames];
  // Strategy: try exact match (any candidate), then case-insensitive, then
  // fuzzy (one candidate is a substring of the team_xg team or vice versa).
  // First matching team wins — stable across re-runs because we sort by
  // name length (longer = more distinctive) when tied.
  const pool = historyRows.filter((r) => r.venue === venue);
  const tryFind = (pred) => {
    const found = pool.filter(pred);
    if (found.length === 0) return null;
    // Group by r.team, pick the most-populated group, take last N
    const byTeam = {};
    for (const r of found) (byTeam[r.team] ||= []).push(r);
    const best = Object.entries(byTeam).sort((a, b) => b[1].length - a[1].length)[0];
    return best[1].slice(0, n);
  };
  // Exact match, any candidate
  for (const name of candidates) {
    const hits = tryFind((r) => r.team === name);
    if (hits) return hits;
  }
  // Case-insensitive exact
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const hits = tryFind((r) => r.team.toLowerCase() === lower);
    if (hits) return hits;
  }
  // Fuzzy: team includes candidate OR candidate includes team (longer one wins)
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const hits = tryFind((r) => {
      const t = r.team.toLowerCase();
      return t.includes(lower) || lower.includes(t);
    });
    if (hits) return hits;
  }
  return [];
}

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

      return {
        home: {
          name: homeFodze,
          xg_h8: homeXG?.xg ?? 0,
          xga_h8: homeXG?.xga ?? 0,
          games: homeXG?.games ?? 8,
          form: "",
          injuries: "",
          yellow_risk: "",
          ...(homeXG ? { xg_h_history: homeXG.history } : {}),
        },
        away: {
          name: awayFodze,
          xg_a8: awayXG?.xg ?? 0,
          xga_a8: awayXG?.xga ?? 0,
          games: awayXG?.games ?? 8,
          form: "",
          injuries: "",
          yellow_risk: "",
          ...(awayXG ? { xg_a_history: awayXG.history } : {}),
        },
        tags: [],
        context: "",
        referee: "",
        kickoff,
      };
    }),
    // Attached to the JSON for debugging — not used by the engine.
    _enrichment: {
      home_coverage: `${enrichedHome}/${fixtures.length}`,
      away_coverage: `${enrichedAway}/${fixtures.length}`,
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

  // Print summary with enrichment status per match
  for (const m of matchday.matches) {
    const hBadge = m.home.xg_h_history ? "✓" : "·";
    const aBadge = m.away.xg_a_history ? "✓" : "·";
    console.log(`   ${hBadge}${aBadge} ${m.home.name} vs ${m.away.name} (${m.kickoff})`);
  }
  console.log(`\n   Enrichment: Home ${matchday._enrichment.home_coverage}, Away ${matchday._enrichment.away_coverage}\n`);

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

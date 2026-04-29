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
  computeStandingsFromXG,
  findStanding,
  deriveStandingsTags,
  deriveH2H,
  loadOpenLigaDBSeason,
  findOpenLigaMatch,
  inferMatchdayLabel,
  loadRefereesForLeague,
  deriveRefereeFeatures,
  loadStadiumsForTeams,
  deriveTravelCongestion,
  flagShortRestEuropean,
} from './_lib/matchday-enrich.mjs';
import { fetchMultipleTeamInjuries } from './_lib/transfermarkt-scrape.mjs';

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
// Opt-in: scrape Transfermarkt for injuries + yellow-risk per team.
// Costs ~1.5s per team (20s-40s for a full matchday) but populates the
// fields parseAbsences() + calcAbsenceImpact() actually use. Requires
// GROQ_API_KEY in .env.local for HTML→JSON normalisation.
const INJURIES = args.includes('--injuries');
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

// Sofascore-derived standings (live table from match scores). Prefer over
// the team_xg_history-derived path — that one silently truncates at
// PostgREST's 1000-row default page, losing 1-3 teams from active leagues
// like EPL (Brighton was missing). Returns [] if the league isn't in
// sofascore_match yet → caller falls back to computeStandingsFromXG.
async function loadSofascoreStandings(lg, season = "25/26") {
  const url = `${SUPA_URL}/rest/v1/sofascore_standings?` + new URLSearchParams({
    league: `eq.${lg}`,
    season: `eq.${season}`,
    order: "position.asc",
    select: "team,position,played,wins,draws,losses,gf,ga,gd,points",
  });
  try {
    const resp = await fetch(url, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!resp.ok) return [];
    const rows = await resp.json();
    // Normalize "&" → "and" so the team-name matches the Odds-API
    // fixture-spelling that drives currentTeams (Brighton & Hove Albion
    // vs Brighton and Hove Albion was missing the standings join).
    return rows.map((r) => ({
      team: (r.team || "").replace(/ & /g, " and "),
      pos: r.position,
      points: r.points,
      gd: r.gd,
      played: r.played,
    }));
  } catch {
    return [];
  }
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
function buildMatchdayJSON(fixtures, xgHistory, ctx = {}) {
  if (fixtures.length === 0) return null;
  const {
    standings = [],
    leagueSize = 18,
    openLigaMatches = [],
    injuriesByTeam = new Map(),
    refereesMap = new Map(),
    stadiumMap = new Map(),
  } = ctx;

  // Real matchday label from OpenLigaDB when available (German leagues),
  // otherwise the "auto" fallback. Users see "30. Spieltag" in the app
  // header instead of the previous uninformative "Spieltag (auto)".
  const firstDate = fixtures[0].commence_time.slice(0, 10);
  const olLabel = openLigaMatches.length > 0
    ? inferMatchdayLabel(openLigaMatches, new Date(firstDate + "T12:00:00"))
    : null;
  const matchdayLabel = olLabel || "Spieltag (auto)";

  // Coverage counters for the final log line — users see at a glance
  // what landed (xG, form, tags, standings, H2H).
  let enrichedHome = 0;
  let enrichedAway = 0;
  let formHome = 0;
  let formAway = 0;
  let tagsApplied = 0;
  let standingsMatched = 0;
  let h2hFound = 0;
  let injuriesHome = 0;
  let injuriesAway = 0;
  let refereeMatched = 0;

  const matchday = {
    league: LEAGUE_NAMES[league] || league,
    matchday: matchdayLabel,
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

      // Standings positions — used for MEISTERKAMPF / ABSTIEGSKAMPF tags
      // (real λ-multipliers per TAG_MAP in dixon-coles.ts) and for display.
      const homeStanding = findStanding(standings, [homeApi, homeFodze]);
      const awayStanding = findStanding(standings, [awayApi, awayFodze]);
      if (homeStanding && awayStanding) standingsMatched++;
      const standingsTags = deriveStandingsTags(
        homeStanding?.pos, awayStanding?.pos, leagueSize,
      );

      // Head-to-Head — last 5 direct meetings, newest-first. Engine doesn't
      // use it yet but /matchday UI shows it and users rely on it.
      const h2h = xgHistory.length > 0
        ? deriveH2H(xgHistory, [homeApi, homeFodze], [awayApi, awayFodze], 5)
        : [];
      if (h2h.length > 0) h2hFound++;

      // Combined tags: DERBY + ROTATION (fixture-based) + MEISTERKAMPF /
      // ABSTIEGSKAMPF (standings-based). All map to TAG_MAP multipliers,
      // so they all actually move λ.
      const derivedTags = [
        ...deriveTags(f, fixtures),
        ...standingsTags,
      ];
      if (derivedTags.length > 0) tagsApplied++;

      // OpenLigaDB join — for German leagues we confirm/upgrade the kickoff
      // and expose the source matchID so future enrichment (official
      // goals-scored, viewers, weather) can join back.
      const oldMatch = openLigaMatches.length > 0
        ? findOpenLigaMatch(openLigaMatches, homeApi, awayApi) ||
          findOpenLigaMatch(openLigaMatches, homeFodze, awayFodze)
        : null;

      // Injuries from Transfermarkt scrape (populated only when the
      // --injuries flag is used; otherwise the Map is empty).
      const homeInj = injuriesByTeam.get(homeFodze);
      const awayInj = injuriesByTeam.get(awayFodze);
      const homeInjuries = homeInj?.injuries || "";
      const awayInjuries = awayInj?.injuries || "";
      const homeYellowRisk = homeInj?.yellow_risk || "";
      const awayYellowRisk = awayInj?.yellow_risk || "";
      if (homeInjuries) injuriesHome++;
      if (awayInjuries) injuriesAway++;

      // Referee: hydrate from `referees` table if a pre-match assignment
      // source ever populates f.referee_name. Until then this resolves to
      // an empty string (same as pre-upgrade behavior).
      // Engine's predictYellowCards() parses the "Name, Ø X.X Karten/Spiel"
      // format out of match.referee — no change needed there.
      const refFeatures = deriveRefereeFeatures(refereesMap, f.referee_name);
      if (refFeatures.ref_string) refereeMatched++;

      // Travel + congestion (Phase 1.4) — null travel when stadium map is
      // empty; engine treats nulls as "no signal" per existing null-safety.
      const homeStadium = stadiumMap.get(homeFodze) || null;
      const awayStadium = stadiumMap.get(awayFodze) || null;
      const homeFatigue = deriveTravelCongestion({
        team: homeFodze, teamStadium: homeStadium,
        historyRows: homeEntries, stadiumMap, kickoff,
      });
      const awayFatigue = deriveTravelCongestion({
        team: awayFodze, teamStadium: awayStadium,
        historyRows: awayEntries, stadiumMap, kickoff,
      });
      // EURO-FATIGUE tag fires only when a UEFA-fixtures source declares
      // a European-Away within 72h — no such source today, so always false.
      // Infrastructure is wired so the tag auto-activates once that source lands.
      const euroAwayHome = false; // placeholder — UEFA-fixtures TODO
      const euroAwayAway = false;
      if (flagShortRestEuropean(homeFatigue, euroAwayHome)) derivedTags.push("EURO-FATIGUE");
      else if (flagShortRestEuropean(awayFatigue, euroAwayAway)) derivedTags.push("EURO-FATIGUE");

      return {
        home: {
          name: homeFodze,
          xg_h8: homeXG?.xg ?? 0,
          xga_h8: homeXG?.xga ?? 0,
          games: homeXG?.games ?? 8,
          form: homeForm,
          injuries: homeInjuries,
          yellow_risk: homeYellowRisk,
          ...(homeStanding ? {
            standings_pos: homeStanding.pos,
            standings_points: homeStanding.points,
            standings_gd: homeStanding.gd,
          } : {}),
          ...(homeXG ? { xg_h_history: homeXG.history } : {}),
          ...(homeFatigue.travel_km_last_7d != null ? { travel_km_last_7d: homeFatigue.travel_km_last_7d } : {}),
          ...(homeFatigue.matches_last_14d ? { matches_last_14d: homeFatigue.matches_last_14d } : {}),
        },
        away: {
          name: awayFodze,
          xg_a8: awayXG?.xg ?? 0,
          xga_a8: awayXG?.xga ?? 0,
          games: awayXG?.games ?? 8,
          form: awayForm,
          injuries: awayInjuries,
          yellow_risk: awayYellowRisk,
          ...(awayStanding ? {
            standings_pos: awayStanding.pos,
            standings_points: awayStanding.points,
            standings_gd: awayStanding.gd,
          } : {}),
          ...(awayXG ? { xg_a_history: awayXG.history } : {}),
          ...(awayFatigue.travel_km_last_7d != null ? { travel_km_last_7d: awayFatigue.travel_km_last_7d } : {}),
          ...(awayFatigue.matches_last_14d ? { matches_last_14d: awayFatigue.matches_last_14d } : {}),
        },
        tags: derivedTags,
        context: "",
        referee: refFeatures.ref_string,
        kickoff,
        ...(h2h.length > 0 ? { h2h } : {}),
        ...(oldMatch ? { _openliga_match_id: oldMatch.matchID } : {}),
      };
    }),
    // Attached to the JSON for debugging — not used by the engine.
    _enrichment: {
      home_xg: `${enrichedHome}/${fixtures.length}`,
      away_xg: `${enrichedAway}/${fixtures.length}`,
      home_form: `${formHome}/${fixtures.length}`,
      away_form: `${formAway}/${fixtures.length}`,
      tags_applied: `${tagsApplied}/${fixtures.length}`,
      standings_matched: `${standingsMatched}/${fixtures.length}`,
      h2h_found: `${h2hFound}/${fixtures.length}`,
      home_injuries: `${injuriesHome}/${fixtures.length}`,
      away_injuries: `${injuriesAway}/${fixtures.length}`,
      referee_matched: `${refereeMatched}/${fixtures.length}`,
      matchday_label_source: olLabel ? "openligadb" : "auto-fallback",
      source: "team_xg_history (Understat/shots-model/goals-proxy) + OpenLigaDB" + (injuriesByTeam.size > 0 ? " + Transfermarkt" : ""),
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

  // Kick off the four network fetches in parallel. xgHistory covers
  // form + H2H + standings, OpenLigaDB gives real matchday labels for
  // German leagues (no-op for other leagues — returns []), and the
  // refereesMap hydrates match.referee when a pre-match source supplies
  // the referee name (empty map until a referee-assignment scraper lands).
  const currentRefSeason = (() => {
    const now = new Date();
    const y = now.getFullYear();
    const startYear = now.getMonth() >= 6 ? y : y - 1;
    return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
  })();
  const [fixtures, xgHistory, openLigaMatches, refereesMap] = await Promise.all([
    loadFixtures(),
    loadLeagueXGHistory(league),
    loadOpenLigaDBSeason(league),
    loadRefereesForLeague(SUPA_URL, SUPA_KEY, league, currentRefSeason),
  ]);

  // Stadium coords — one extra round-trip after we know which teams are in
  // the upcoming matchday. Empty map if the migration + Wikidata scrape
  // haven't run yet; deriveTravelCongestion degrades cleanly to null travel.
  const teamNames = new Set();
  for (const f of fixtures) {
    if (f.home_team) teamNames.add(resolveName(f.home_team));
    if (f.away_team) teamNames.add(resolveName(f.away_team));
  }
  const stadiumMap = await loadStadiumsForTeams(SUPA_URL, SUPA_KEY, Array.from(teamNames));
  console.log(`   ${fixtures.length} Fixtures gefunden`);
  console.log(`   ${xgHistory.length} xG-Einträge für diese Liga im team_xg_history`);
  if (openLigaMatches.length > 0) {
    console.log(`   ${openLigaMatches.length} OpenLigaDB-Matches (für echte Matchday-Labels)`);
  }

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

  // Derive league-wide standings from the CURRENT season only so position
  // counts reflect reality (the full 2-season dataset has promoted/relegated
  // teams that inflate the count, making "bottom 3" meaningless). Season
  // boundary matches what loadLeagueStandings uses in supabase.ts.
  const seasonStart = "2025-07-01";
  const currentSeasonXG = xgHistory.filter((r) => (r.match_date || "") >= seasonStart);
  // Further prune to teams that actually play in this upcoming matchday —
  // filters any lingering non-current-season rows that slipped through.
  const currentTeams = new Set();
  for (const f of fixtures) {
    if (f.home_team) currentTeams.add(f.home_team);
    if (f.away_team) currentTeams.add(f.away_team);
  }
  // Try Sofascore-derived standings first (proper league table from real
  // scores, not affected by the 1000-row PostgREST page-limit). Fallback
  // to the xG-history path for leagues we haven't backfilled yet.
  let activeStandings;
  let standingsSource;
  const sofaStandings = await loadSofascoreStandings(league);
  if (sofaStandings.length >= 10) {
    // No filtering needed — sofascore_standings is already season-bound
    // (filtered by season=25/26 in the view). The xG-history path needs
    // filtering to drop relegated/promoted teams from older seasons; the
    // Sofascore path doesn't have that drift. Position numbers are kept
    // as-is from the view (1..N by points/gd/gf).
    activeStandings = sofaStandings;
    standingsSource = "sofascore";
  } else {
    const standings = computeStandingsFromXG(currentSeasonXG);
    activeStandings = standings.filter((s) => {
      const lookedUp = findStanding([s], Array.from(currentTeams));
      return !!lookedUp;
    });
    activeStandings.forEach((s, i) => { s.pos = i + 1; });
    standingsSource = "xg-history";
  }
  const leagueSize = activeStandings.length || 18;
  if (activeStandings.length > 0) {
    console.log(`   ${activeStandings.length} Teams in der aktuellen Saisontabelle (Liga-Size für Tags) [src=${standingsSource}]`);
  }

  // Optional: fetch injury + suspension data per team from Transfermarkt.
  // Opt-in because it's slow (~1.5s/team for rate-limit politeness) and
  // needs GROQ_API_KEY. Without --injuries flag, injuries/yellow_risk
  // stay empty strings (same as before this commit).
  let injuriesByTeam = new Map();
  if (INJURIES) {
    // Delta-cache: only teams with a fixture within the next 72h need fresh
    // injury data. Distant-future fixtures get fetched when their own 72h
    // window opens, avoiding redundant scrapes (and Groq tokens) every run.
    const DELTA_WINDOW_MS = 72 * 60 * 60 * 1000;
    const cutoff = Date.now() + DELTA_WINDOW_MS;
    const uniqueTeams = new Set();
    let skippedFixtures = 0;
    for (const f of fixtures) {
      const koMs = new Date(f.commence_time).getTime();
      if (!Number.isFinite(koMs) || koMs > cutoff) { skippedFixtures++; continue; }
      const h = resolveName(f.home_team);
      const a = resolveName(f.away_team);
      if (h) uniqueTeams.add(h);
      if (a) uniqueTeams.add(a);
    }
    const teamList = Array.from(uniqueTeams);
    if (skippedFixtures > 0) {
      console.log(`   ⏩ Delta-cache: skipping ${skippedFixtures} fixtures outside 72h window`);
    }
    console.log(`   🏥 Injuries: fetching ${teamList.length} teams from Transfermarkt…`);
    injuriesByTeam = await fetchMultipleTeamInjuries(
      teamList,
      (done, total, name, status) => {
        const icon = status === "ok" ? "✓" : status === "no-id-mapping" ? "·" : "⚠";
        process.stdout.write(`\r      ${done}/${total} ${icon} ${name.padEnd(30).slice(0, 30)}  `);
      },
    );
    const okCount = Array.from(injuriesByTeam.values()).filter((r) => r.status === "ok").length;
    const noMap = Array.from(injuriesByTeam.values()).filter((r) => r.status === "no-id-mapping").length;
    process.stdout.write("\r" + " ".repeat(80) + "\r");
    console.log(`      → ${okCount} OK, ${noMap} ohne TM-ID-Mapping, ${teamList.length - okCount - noMap} andere Fehler`);

    // Auto-alias-learner: append any no-id-mapping teams to a log file
    // so a human can later review + add aliases in one go. We intentionally
    // don't auto-write to transfermarkt-aliases.mjs — finding the right TM
    // canonical name for a given FODZE name still needs manual judgement
    // (e.g. is "Sporting" → Sporting Lissabon or Sporting Gijón?).
    if (noMap > 0) {
      const todoPath = resolve(__dirname, "..", "missing-tm-aliases.log");
      const lines = [];
      for (const [team, r] of injuriesByTeam.entries()) {
        if (r.status === "no-id-mapping") {
          lines.push(`${new Date().toISOString()}\t${league}\t${team}`);
        }
      }
      try {
        const existing = existsSync(todoPath) ? readFileSync(todoPath, "utf-8") : "";
        writeFileSync(todoPath, existing + lines.join("\n") + "\n");
        console.log(`      → ${lines.length} ungemappte Teams geloggt nach missing-tm-aliases.log`);
      } catch {
        // Logging is best-effort — don't crash the pipeline over it.
      }
    }
  }

  const matchday = buildMatchdayJSON(fixtures, xgHistory, {
    standings: activeStandings,
    leagueSize,
    openLigaMatches,
    injuriesByTeam,
    refereesMap,
    stadiumMap,
  });

  // Print summary with enrichment status per match. Badge slots:
  //   xG home / xG away / form home / form away / standings / h2h
  // Tags shown inline when non-empty.
  for (const m of matchday.matches) {
    const hXG = m.home.xg_h_history ? "✓" : "·";
    const aXG = m.away.xg_a_history ? "✓" : "·";
    const hForm = m.home.form ? "✓" : "·";
    const aForm = m.away.form ? "✓" : "·";
    const hPos = m.home.standings_pos ? String(m.home.standings_pos).padStart(2, " ") : "··";
    const aPos = m.away.standings_pos ? String(m.away.standings_pos).padStart(2, " ") : "··";
    const h2h = m.h2h?.length ? `H2H×${m.h2h.length}` : "       ";
    const injBadge = (m.home.injuries || m.away.injuries)
      ? `🏥${m.home.injuries ? m.home.injuries.split(",").length : 0}v${m.away.injuries ? m.away.injuries.split(",").length : 0}`
      : "       ";
    const tags = m.tags.length ? ` [${m.tags.join(",")}]` : "";
    console.log(
      `   ${hXG}${aXG} ${hForm}${aForm} ${hPos}v${aPos} ${h2h} ${injBadge} ${m.home.name} vs ${m.away.name} (${m.kickoff})${tags}`,
    );
  }
  const e = matchday._enrichment;
  console.log(
    `\n   xG: ${e.home_xg}/${e.away_xg}  ·  Form: ${e.home_form}/${e.away_form}  ·  Tags: ${e.tags_applied}  ·  Standings: ${e.standings_matched}  ·  H2H: ${e.h2h_found}  ·  Injuries: ${e.home_injuries}/${e.away_injuries}  ·  Referee: ${e.referee_matched}  ·  Label: ${e.matchday_label_source}\n`,
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

// ═══════════════════════════════════════════════════════════════════════
// FODZE — TheSportsDB v1 thin client
// ═══════════════════════════════════════════════════════════════════════
//
// Free-Tier: public key "123" funktioniert ohne Anmeldung und hat kein
// hartes Rate-Limit (soft-limit ~30/min laut TheSportsDB-Forum). Premium-
// Key via Patreon (~$5/mo) liefert zusätzliche Endpoints + kein throttle.
//
// Endpoints die wir nutzen (alle v1):
//   /search_all_teams.php?l=<LeagueName>
//   /lookupteam.php?id=<idTeam>
//   /lookupleague.php?id=<idLeague>
//   /all_leagues.php
//
// Response-Quirks:
//   - Wenn ein Feld leer ist, kommt "" (leerer String), NICHT null
//   - Zahlen kommen als Strings ("1903", "75024")
//   - Bei fehlenden Ergebnissen: { teams: null } (nicht [])
// ═══════════════════════════════════════════════════════════════════════

const BASE = "https://www.thesportsdb.com/api/v1/json";
const DEFAULT_KEY = "123"; // public test-key, free-tier
const PER_REQUEST_DELAY = 400; // ms, höflich zum free-tier server

// FODZE league key → TheSportsDB info. `leagueId` ermöglicht
// lookup_all_teams.php?id=<id> (komplette Liste); `leagueName` ist
// Fallback für search_all_teams.php?l=<name> (10-Item-Limit).
// Verified IDs: Bundesliga=4331 (24 teams via lookup), 2.BL=4399,
// Serie A=4332, Serie B=4394, La Liga=4335, Ligue 1=4334, EPL=4328,
// Championship=4329, Eredivisie=4337, Belgian Pro=4338. Andere IDs
// kann der User bei Bedarf manuell verifizieren über
// https://www.thesportsdb.com/league/<idLeague> und hier nachtragen.
export const THESPORTSDB_LEAGUES = {
  bundesliga:    { leagueId: 4331, leagueName: "German Bundesliga" },
  bundesliga2:   { leagueId: 4399, leagueName: "German 2. Bundesliga" },
  // TODO liga3 + greek_sl: in TheSportsDB search_all_teams nicht gelistet.
  // Beide Liga-IDs existieren (liga3 ~ 4651, greek_sl ~ 4336) aber der
  // search-endpoint returnt 0 Ergebnisse. Nachtragen sobald TheSportsDB
  // die indexiert oder wir einen anderen Endpoint finden.
  liga3:         { leagueId: 4651, leagueName: "German 3 Liga" },
  epl:           { leagueId: 4328, leagueName: "English Premier League" },
  championship:  { leagueId: 4329, leagueName: "English League Championship" },
  league_one:    { leagueId: 4396, leagueName: "English League 1" },
  league_two:    { leagueId: 4397, leagueName: "English League 2" },
  la_liga:       { leagueId: 4335, leagueName: "Spanish La Liga" },
  la_liga2:      { leagueId: 4481, leagueName: "Spanish La Liga 2" },
  serie_a:       { leagueId: 4332, leagueName: "Italian Serie A" },
  serie_b:       { leagueId: 4394, leagueName: "Italian Serie B" },
  ligue_1:       { leagueId: 4334, leagueName: "French Ligue 1" },
  ligue_2:       { leagueId: 4437, leagueName: "French Ligue 2" },
  eredivisie:    { leagueId: 4337, leagueName: "Dutch Eredivisie" },
  primeira_liga: { leagueId: 4344, leagueName: "Portuguese Primeira Liga" },
  jupiler_pro:   { leagueId: 4338, leagueName: "Belgian Pro League" },
  super_lig:     { leagueId: 4339, leagueName: "Turkish Super Lig" },
  scottish_prem: { leagueId: 4330, leagueName: "Scottish Premiership" },
  greek_sl:      { leagueId: 4336, leagueName: "Greek Super League" },
  austria_bl:    { leagueId: 4406, leagueName: "Austrian Bundesliga" },
  swiss_sl:      { leagueId: 4344, leagueName: "Swiss Super League" },
  eerste_divisie:{ leagueId: 4442, leagueName: "Dutch Eerste Divisie" },
};

// Backward-compat: old name → info.leagueName
export const THESPORTSDB_LEAGUE_NAMES = Object.fromEntries(
  Object.entries(THESPORTSDB_LEAGUES).map(([k, v]) => [k, v.leagueName]),
);

export function resolveThesportsdbLeague(fodzeKey) {
  return THESPORTSDB_LEAGUES[fodzeKey] ?? null;
}

export function resolveThesportsdbLeagueName(fodzeKey) {
  return THESPORTSDB_LEAGUE_NAMES[fodzeKey] ?? null;
}

// ─── Client ──────────────────────────────────────────────────────

export function createThesportsdbClient({
  apiKey = process.env.THESPORTSDB_KEY || DEFAULT_KEY,
  verbose = false,
} = {}) {
  const state = { requestsDone: 0 };
  const log = (...args) => { if (verbose) console.log("[thesportsdb]", ...args); };

  async function sleep(ms) {
    if (ms > 0) await new Promise(r => setTimeout(r, ms));
  }

  async function request(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${BASE}/${apiKey}${path}${qs ? `?${qs}` : ""}`;
    const start = Date.now();
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return { ok: false, error: `network: ${e.message}`, data: null };
    }
    state.requestsDone++;
    if (res.status === 429) {
      log("429 rate-limit — warte 30s");
      await sleep(30_000);
      return request(path, params);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}`, data: null };
    }
    const json = await res.json();
    await sleep(PER_REQUEST_DELAY);
    log(`${path} ${res.status} · ${Date.now() - start}ms`);
    return { ok: true, error: null, data: json };
  }

  // ─── High-level helpers ──────────────────────────────────────

  async function searchAllTeams(leagueName) {
    // search_all_teams.php?l=<name> returnt NUR die ersten 10 Teams
    return request("/search_all_teams.php", { l: leagueName });
  }

  async function searchTeam(teamName) {
    // searchteams.php?t=<name> macht fuzzy-search across all teams,
    // returnt oft mehrere Treffer (verschiedene Sportarten/Länder) —
    // aufrufer muss strLeague prüfen.
    return request("/searchteams.php", { t: teamName });
  }

  async function lookupAllTeams(leagueId) {
    // lookup_all_teams.php?id=<idLeague> returnt ALLE Teams (historisch +
    // aktuell) — use this over search_all_teams wenn möglich.
    return request("/lookup_all_teams.php", { id: String(leagueId) });
  }

  async function lookupTeam(idTeam) {
    return request("/lookupteam.php", { id: String(idTeam) });
  }

  async function lookupLeague(idLeague) {
    return request("/lookupleague.php", { id: String(idLeague) });
  }

  return {
    request,
    searchAllTeams,
    searchTeam,
    lookupAllTeams,
    lookupTeam,
    lookupLeague,
    state,
  };
}

// ─── Parser: TheSportsDB team → FODZE team_metadata row ──────────

function toInt(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Normalize a TheSportsDB team record into a FODZE team_metadata row.
 * Keeps nulls where upstream has empty strings so downstream joins are
 * explicit about missing data.
 *
 * Feld-Mapping (v1 hat 2024/25 umbenannt):
 *   strBadge           → logo_url          (früher strTeamBadge)
 *   strLogo            → jersey_url        (früher strTeamLogo)
 *   strEquipment       → jersey_url-Alt    (war strTeamJersey)
 *   strLocation        → stadium_city      (früher strStadiumLocation)
 *   strTeamAlternate   → team_alternate    (früher strAlternate)
 *   idAPIfootball      → api_sports_id     (neu — stabiler Cross-Source-Link!)
 *   strDescriptionDE   → description_en    (DE bevorzugt wenn vorhanden,
 *                                            Spalte bleibt description_en
 *                                            als generic "short text")
 */
export function parseTeamRecord(t, fodzeLeague) {
  if (!t || !t.idTeam) return null;
  const description = toStr(t.strDescriptionDE) || toStr(t.strDescriptionEN);
  return {
    fodze_league: fodzeLeague,
    thesportsdb_id: toInt(t.idTeam),
    api_sports_id: toInt(t.idAPIfootball),
    team_name: toStr(t.strTeam),
    team_short: toStr(t.strTeamShort),
    team_alternate: toStr(t.strTeamAlternate) || toStr(t.strAlternate),
    country: toStr(t.strCountry),
    stadium: toStr(t.strStadium),
    stadium_city: toStr(t.strLocation) || toStr(t.strStadiumLocation),
    stadium_capacity: toInt(t.intStadiumCapacity),
    founded_year: toInt(t.intFormedYear),
    logo_url: toStr(t.strBadge) || toStr(t.strTeamBadge),
    jersey_url: toStr(t.strEquipment) || toStr(t.strTeamJersey) || toStr(t.strLogo),
    color_primary: toStr(t.strColour1),
    color_secondary: toStr(t.strColour2),
    color_tertiary: toStr(t.strColour3),
    website: toStr(t.strWebsite),
    description_en: description?.slice(0, 800) ?? null,
  };
}

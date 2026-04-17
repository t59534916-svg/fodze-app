// ═══════════════════════════════════════════════════════════════════════
// FODZE Matchday-Enrichment Helpers — shared by generate-matchday.mjs +
// backfill-enrich-matchdays.mjs.
//
// Four concerns:
//   1. normalizeTeamName — strips umlauts, punctuation, and common club
//      prefixes so "1. FC Köln" ≈ "FC Koln" ≈ "Koln" across data sources.
//   2. lookupTeamXG — fuzzy-match a team across Understat / shots-model /
//      goals-proxy name spaces in team_xg_history.
//   3. deriveForm — builds a "W W D L W" form string from last 5 matches
//      (venue-agnostic) using goals_for vs goals_against.
//   4. deriveTags — DERBY (rivalry map) + ROTATION (3 games / 7 days).
//
// No dependencies, plain ES modules. Works in any .mjs script.
// ═══════════════════════════════════════════════════════════════════════

// ─── 1. Name normalization ──────────────────────────────────────────

/**
 * Collapse a team name into a comparison-friendly form.
 * Lowercase → strip accents/umlauts → drop punctuation → drop common
 * club abbreviations (FC, SC, etc.) → collapse whitespace.
 *
 * Stays pure for reversibility: output is NOT a display name, only a key
 * for equality/substring checks across `team_xg_history` conventions.
 *
 * Examples:
 *   "1. FC Köln"       → "koln"
 *   "Borussia M.Gladbach" → "borussia mgladbach"
 *   "Paris Saint Germain" → "paris saint germain"
 *   "Paris SG"            → "paris"     (intentional — PSG prefix-drop
 *                                        ends at "paris"; use tokens-overlap)
 */
export function normalizeTeamName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip combining marks (umlauts)
    .replace(/ß/g, "ss")
    .replace(/[.,'"`´]/g, "")
    .replace(/\b(fc|sc|sv|ss|ssd|us|ac|sk|ko|afc|cf|cd|ud|ca|rcd|sd|rc|ec|kf|ogc|as|og|nk|tsg|tsv|vfb|vfl|rb|rbleipzig|rasenballsport|1|1\.|club|the)\b/g, "")
    .replace(/\bmunchen\b/g, "munich")
    .replace(/\bkoln\b|\bkoeln\b|\bcologne\b/g, "koln")
    .replace(/\bmgladbach\b|\bmonchengladbach\b|\bgladbach\b/g, "mgladbach")
    .replace(/\b(man|manchester)\b/g, "manchester")
    .replace(/\bnottingham\b|\bnottm\b/g, "nottingham")
    .replace(/\bparis\b.*$/g, "paris")    // Paris SG / Paris Saint Germain / Paris FC all → paris
    .replace(/\bnewcastle\b.*$/g, "newcastle")
    .replace(/\bwolverhampton\b.*$/g, "wolves")
    .replace(/\bwolves\b/g, "wolves")
    .replace(/\bath(letic|letico)?\b/g, "athletic")
    .replace(/\batlet(ico|ic)\b/g, "athletic")
    .replace(/\bsociedad\b/g, "sociedad")
    .replace(/\bbetis\b/g, "betis")
    .replace(/\bcelta\b/g, "celta")
    .replace(/\bespan(ol|yol)\b/g, "espanyol")
    .replace(/\brayo\b.*$/g, "rayo")
    .replace(/\bvallecano\b/g, "rayo")
    .replace(/\b(ein|eintracht)\s*frankfurt\b/g, "frankfurt")
    .replace(/\bmainz\b\s*\d*/g, "mainz")
    .replace(/\bst\s*pauli\b|\bst\.?pauli\b/g, "stpauli")
    .replace(/\bhoffenheim\b.*$/g, "hoffenheim")   // also matches "Hoffenheim II"
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fuzzy-match a team against team_xg_history rows.
 * Tries several candidate names (e.g. Odds-API + FODZE) in priority order:
 *   exact → case-insensitive exact → normalized equality →
 *   normalized substring (either direction, both ≥ 4 chars to avoid
 *   generic "FC" false-matches).
 *
 * Returns the last N venue-specific entries of the best-matching team
 * (most populated if multiple normalized names collide), or [] when
 * nothing reasonable landed.
 */
export function lookupTeamXG(historyRows, teamNames, venue, n = 8) {
  const candidates = (Array.isArray(teamNames) ? teamNames : [teamNames])
    .filter(Boolean);
  const pool = historyRows.filter((r) => r.venue === venue);
  if (pool.length === 0 || candidates.length === 0) return [];

  const pickBest = (hits) => {
    if (hits.length === 0) return null;
    // Group by team name; return the most-populated group's last N
    const byTeam = {};
    for (const r of hits) (byTeam[r.team] ||= []).push(r);
    const best = Object.entries(byTeam).sort((a, b) => b[1].length - a[1].length)[0];
    return best[1].slice(0, n);
  };

  // 1. Exact
  for (const name of candidates) {
    const hits = pool.filter((r) => r.team === name);
    const got = pickBest(hits);
    if (got) return got;
  }
  // 2. Case-insensitive exact
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const hits = pool.filter((r) => r.team.toLowerCase() === lower);
    const got = pickBest(hits);
    if (got) return got;
  }
  // 3. Normalized equality (handles umlauts, FC/SC, punctuation)
  const normCands = candidates.map(normalizeTeamName).filter((n) => n.length >= 3);
  for (const nc of normCands) {
    const hits = pool.filter((r) => normalizeTeamName(r.team) === nc);
    const got = pickBest(hits);
    if (got) return got;
  }
  // 4. Normalized substring (bidirectional, length-guarded to avoid
  //    "fc" matching every team). Both strings must be at least 4 chars
  //    after normalization so pathological cases ("st" matching St Pauli
  //    / Stuttgart simultaneously) don't sneak through.
  for (const nc of normCands) {
    if (nc.length < 4) continue;
    const hits = pool.filter((r) => {
      const nt = normalizeTeamName(r.team);
      if (nt.length < 4) return false;
      return nt.includes(nc) || nc.includes(nt);
    });
    const got = pickBest(hits);
    if (got) return got;
  }
  return [];
}

// ─── 2. Form derivation ─────────────────────────────────────────────

/**
 * Load a team's last N matches across both venues and return a "W W D L W"
 * string ordered newest-first (matches the format MatchdayContext's form
 * parser expects: form.split(/\s+/) with newest at index 0).
 *
 * Uses goals_for / goals_against directly — the raw result — rather than
 * xG-based form, because the user-facing "form" is about results, and
 * xG can disagree (e.g. "3:0 loss but xG 2.5:1.8" still displays as L).
 */
export function deriveForm(historyRows, teamNames, n = 5) {
  const candidates = (Array.isArray(teamNames) ? teamNames : [teamNames])
    .filter(Boolean);
  if (historyRows.length === 0 || candidates.length === 0) return "";

  const normCands = candidates.map(normalizeTeamName).filter((s) => s.length >= 3);
  // Match by exact → normalized
  const matches = historyRows.filter((r) => {
    if (candidates.includes(r.team)) return true;
    const nt = normalizeTeamName(r.team);
    return normCands.some((nc) => nt === nc || (nc.length >= 4 && nt.length >= 4 && (nt.includes(nc) || nc.includes(nt))));
  });
  if (matches.length === 0) return "";

  // Pick the most-populated team variant so we don't mix sources
  const byTeam = {};
  for (const r of matches) (byTeam[r.team] ||= []).push(r);
  const bestRows = Object.entries(byTeam).sort((a, b) => b[1].length - a[1].length)[0][1];

  // Sort newest first
  const sorted = [...bestRows].sort(
    (a, b) => new Date(b.match_date).getTime() - new Date(a.match_date).getTime(),
  );
  const recent = sorted.slice(0, n);
  const results = recent.map((r) => {
    const gf = Number(r.goals_for ?? r.xg ?? 0);
    const ga = Number(r.goals_against ?? r.xga ?? 0);
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) return null;
    if (gf > ga) return "W";
    if (gf < ga) return "L";
    return "D";
  }).filter(Boolean);
  return results.join(" ");
}

// ─── 3. Derby rivalries ─────────────────────────────────────────────

/**
 * Hand-curated rivalry pairs. Each entry marks a symmetric relationship —
 * either direction triggers a DERBY tag.
 *
 * Names use the FODZE internal naming (what the matchday JSON uses after
 * resolveName()). If a rivalry exists under Odds-API / Understat name, add
 * that too — normalize() handles minor variants.
 *
 * The list is deliberately not exhaustive; add new entries when missing.
 */
export const TEAM_RIVALRIES = [
  // ─── Bundesliga ──────────────────────────────────────────────
  ["Borussia Dortmund", "FC Schalke 04"],
  ["Borussia Dortmund", "Borussia Mönchengladbach"],
  ["FC Bayern München", "Borussia Dortmund"],    // modern Klassiker
  ["FC Bayern München", "1. FC Nürnberg"],        // bayrisches
  ["FC Bayern München", "TSV 1860 München"],       // münchnerisches
  ["1. FC Köln", "Bayer 04 Leverkusen"],          // rheinisches
  ["1. FC Köln", "Borussia Mönchengladbach"],    // rheinisches
  ["Hamburger SV", "FC St. Pauli"],                // stadt-hamburg
  ["Hamburger SV", "SV Werder Bremen"],            // nord-derby
  ["SV Werder Bremen", "Hamburger SV"],
  ["Hertha BSC", "1. FC Union Berlin"],          // berliner
  ["Eintracht Frankfurt", "SV Darmstadt 98"],    // hessisches
  ["VfB Stuttgart", "Karlsruher SC"],              // badisches
  ["1. FSV Mainz 05", "Eintracht Frankfurt"],    // rhein-main
  // ─── EPL ─────────────────────────────────────────────────────
  ["Liverpool", "Everton"],                        // Merseyside
  ["Manchester United", "Manchester City"],       // Manchester
  ["Manchester United", "Liverpool"],             // historic
  ["Arsenal", "Tottenham"],                        // North London
  ["Chelsea", "Tottenham"],
  ["Chelsea", "Arsenal"],
  ["Chelsea", "Fulham"],                            // West London
  ["West Ham", "Tottenham"],
  ["Newcastle United", "Sunderland"],
  ["Aston Villa", "Birmingham"],
  // ─── La Liga ─────────────────────────────────────────────────
  ["Real Madrid", "FC Barcelona"],                 // El Clásico
  ["Real Madrid", "Atlético Madrid"],              // Madrid
  ["FC Barcelona", "Espanyol Barcelona"],          // Barcelona
  ["FC Sevilla", "Real Betis"],                    // Sevilla
  ["Athletic Bilbao", "Real Sociedad"],            // Basque
  ["Valencia", "Levante"],                          // Valencia
  ["Valencia", "Villarreal"],
  // ─── Serie A ─────────────────────────────────────────────────
  ["AC Milan", "Inter"],                            // Milan
  ["Inter", "AC Milan"],
  ["Juventus", "Torino"],                           // Turin
  ["Roma", "Lazio"],                                // Rome
  ["Napoli", "Juventus"],
  ["Fiorentina", "Juventus"],
  // ─── Ligue 1 ─────────────────────────────────────────────────
  ["Paris Saint-Germain", "Marseille"],            // Le Classique
  ["Lyon", "Saint-Etienne"],                       // Rhône
  ["Lens", "Lille"],                                // Nord
  ["Nice", "Monaco"],
  // ─── Eredivisie ──────────────────────────────────────────────
  ["Ajax", "Feyenoord"],                           // De Klassieker
  ["Ajax", "PSV"],
  ["PSV", "Feyenoord"],
  // ─── Scottish Premiership ────────────────────────────────────
  ["Celtic", "Rangers"],                            // Old Firm
];

/**
 * Return true when the home/away pair is (or contains) a known derby.
 * Uses normalization so "Man United" matches "Manchester United" etc.
 */
export function isDerby(homeTeam, awayTeam) {
  const h = normalizeTeamName(homeTeam);
  const a = normalizeTeamName(awayTeam);
  if (!h || !a) return false;
  for (const [t1, t2] of TEAM_RIVALRIES) {
    const n1 = normalizeTeamName(t1);
    const n2 = normalizeTeamName(t2);
    if ((h === n1 && a === n2) || (h === n2 && a === n1)) return true;
    // Substring fallback for EPL Man United/Man City cases after prefix drop
    const matchH = (h.includes(n1) || n1.includes(h)) && h.length >= 4;
    const matchA = (a.includes(n2) || n2.includes(a)) && a.length >= 4;
    const matchHb = (h.includes(n2) || n2.includes(h)) && h.length >= 4;
    const matchAb = (a.includes(n1) || n1.includes(a)) && a.length >= 4;
    if ((matchH && matchA) || (matchHb && matchAb)) return true;
  }
  return false;
}

// ─── 4. Tag derivation (DERBY + ROTATION) ───────────────────────────

/**
 * Compute contextual tags for a match given the full league fixture list.
 *
 * DERBY: symmetric entry in TEAM_RIVALRIES.
 * ROTATION: either team has ≥3 fixtures within a 7-day window centered on
 *           this kickoff — strong indicator of squad rotation risk.
 * SANDWICH: best-effort via 3-day-before-or-after gap from another fixture.
 *           Without European-cup fixtures in the DB this is a lower-signal
 *           version of the engine's TAG_MAP SANDWICH — still useful as a
 *           congestion marker.
 */
export function deriveTags(match, allFixtures) {
  const tags = [];
  const homeTeam = match.home_team || match.home?.name;
  const awayTeam = match.away_team || match.away?.name;
  const kickoff = match.commence_time || match.kickoff;
  if (!homeTeam || !awayTeam || !kickoff) return tags;

  // DERBY
  if (isDerby(homeTeam, awayTeam)) tags.push("DERBY");

  // ROTATION: for each team, count games within ±3.5 days of this kickoff
  // (i.e. a 7-day window). ≥3 (including this one) → rotation risk.
  const koMs = new Date(kickoff).getTime();
  if (Number.isFinite(koMs)) {
    const WINDOW_MS = 3.5 * 86400_000;
    const countGames = (team) => {
      if (!team) return 0;
      const nTeam = normalizeTeamName(team);
      return allFixtures.filter((f) => {
        const h = f.home_team || f.home?.name;
        const a = f.away_team || f.away?.name;
        if (!h || !a) return false;
        const nh = normalizeTeamName(h);
        const na = normalizeTeamName(a);
        if (nh !== nTeam && na !== nTeam) return false;
        const ft = new Date(f.commence_time || f.kickoff || "").getTime();
        if (!Number.isFinite(ft)) return false;
        return Math.abs(ft - koMs) <= WINDOW_MS;
      }).length;
    };
    if (countGames(homeTeam) >= 3 || countGames(awayTeam) >= 3) {
      tags.push("ROTATION");
    }
  }

  return tags;
}

// ─── Enrichment entry-point ─────────────────────────────────────────

/**
 * All-in-one enrichment helper: given a match, league xG history, and all
 * league fixtures, returns { form_home, form_away, tags } ready to paste
 * into the matchday JSON.
 */
export function enrichMatch(match, xgHistory, allFixtures) {
  const home = match.home_team || match.home?.name;
  const away = match.away_team || match.away?.name;
  const homeFodze = match.home?.name || home;
  const awayFodze = match.away?.name || away;

  return {
    form_home: deriveForm(xgHistory, [home, homeFodze]),
    form_away: deriveForm(xgHistory, [away, awayFodze]),
    tags: deriveTags(match, allFixtures),
  };
}

// ─── 5. Standings computation (JS clone of computeStandings) ────────

/**
 * Build a league table from team_xg_history rows. Mirrors
 * src/lib/supabase.ts:computeStandings pure-logic so script code
 * doesn't have to import TS. Only rows with a finite goals_for /
 * goals_against count — rows lacking actual results (e.g. future
 * fixtures slipped into the dataset) are ignored.
 *
 * Returns: Array of { team, played, won, drawn, lost, gf, ga, gd,
 * points, pos } sorted by position. `team` uses whatever the source
 * name space is (Understat for top-5, football-data.co.uk for shots-
 * model, Odds-API for goals-proxy) — callers match on it via
 * normalizeTeamName.
 */
export function computeStandingsFromXG(xgRows) {
  const stats = new Map();
  const ensure = (t) => {
    if (!stats.has(t)) stats.set(t, { w: 0, d: 0, l: 0, gf: 0, ga: 0 });
    return stats.get(t);
  };

  // The dataset contains TWO rows per match (home + away perspective).
  // Use only the home-perspective rows so each match is counted once.
  // goals_for on a home row = actual home goals; goals_against = away goals.
  for (const m of xgRows) {
    if (m.venue !== "home") continue;
    const gH = Number(m.goals_for);
    const gA = Number(m.goals_against);
    if (!Number.isFinite(gH) || !Number.isFinite(gA)) continue;

    const home = ensure(m.team);
    home.gf += gH; home.ga += gA;
    if (gH > gA) home.w++;
    else if (gH === gA) home.d++;
    else home.l++;

    if (m.opponent) {
      const away = ensure(m.opponent);
      away.gf += gA; away.ga += gH;
      if (gA > gH) away.w++;
      else if (gA === gH) away.d++;
      else away.l++;
    }
  }

  const rows = Array.from(stats.entries()).map(([team, s]) => ({
    team,
    played: s.w + s.d + s.l,
    won: s.w,
    drawn: s.d,
    lost: s.l,
    gf: s.gf,
    ga: s.ga,
    gd: s.gf - s.ga,
    points: s.w * 3 + s.d,
  }));
  rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
  rows.forEach((r, i) => { r.pos = i + 1; });
  return rows;
}

/**
 * Find a team's position in the computed standings by fuzzy-matching the
 * name. Returns { pos, played, gd, points } or null.
 */
export function findStanding(standings, teamNames) {
  const cands = (Array.isArray(teamNames) ? teamNames : [teamNames]).filter(Boolean);
  if (!standings?.length || !cands.length) return null;
  const normCands = cands.map(normalizeTeamName).filter((n) => n.length >= 3);
  for (const r of standings) {
    if (cands.includes(r.team)) return r;
  }
  for (const r of standings) {
    const lower = r.team.toLowerCase();
    if (cands.some((c) => c.toLowerCase() === lower)) return r;
  }
  for (const r of standings) {
    const nt = normalizeTeamName(r.team);
    if (normCands.some((nc) => nt === nc)) return r;
  }
  for (const r of standings) {
    const nt = normalizeTeamName(r.team);
    if (nt.length < 4) continue;
    if (normCands.some((nc) => nc.length >= 4 && (nt.includes(nc) || nc.includes(nt)))) return r;
  }
  return null;
}

// ─── 6. Standings-driven context tags ───────────────────────────────

/**
 * Given the positions of home + away in the league table, compute tags
 * that the engine's TAG_MAP recognises. These actually move λ, unlike
 * display-only tags:
 *   ABSTIEGSKAMPF  — both in bottom 3 → both λ +6%
 *   MEISTERKAMPF   — both in top 3 → both λ +3%
 *
 * The MUST_WIN_HOME / TOP_VS_BOTTOM tags are intentionally NOT emitted:
 * TAG_MAP in src/lib/dixon-coles.ts doesn't have entries for them, so
 * emitting them would be cargo-cult clutter.
 */
export function deriveStandingsTags(homePos, awayPos, leagueSize = 18) {
  const tags = [];
  if (homePos == null || awayPos == null) return tags;
  const relZone = Math.max(3, leagueSize - 15); // top-5 leagues: bottom 3
  const titleZone = 3;
  if (homePos > leagueSize - relZone && awayPos > leagueSize - relZone) {
    tags.push("ABSTIEGSKAMPF");
  }
  if (homePos <= titleZone && awayPos <= titleZone) {
    tags.push("MEISTERKAMPF");
  }
  return tags;
}

// ─── 7. Head-to-Head ────────────────────────────────────────────────

/**
 * Last N meetings between home and away across the xG history dataset.
 * Uses goals_for/goals_against on the home-perspective row — when the
 * home row's team matches `home` (exact or normalized), we have the
 * right directional view. Returns newest-first.
 *
 * Result shape:
 *   [{ date, gf, ga, result: "W"|"D"|"L" (from home's perspective) }]
 */
export function deriveH2H(xgRows, homeNames, awayNames, n = 5) {
  const homeCands = (Array.isArray(homeNames) ? homeNames : [homeNames]).filter(Boolean);
  const awayCands = (Array.isArray(awayNames) ? awayNames : [awayNames]).filter(Boolean);
  if (!xgRows?.length || !homeCands.length || !awayCands.length) return [];

  const normH = homeCands.map(normalizeTeamName).filter((s) => s.length >= 3);
  const normA = awayCands.map(normalizeTeamName).filter((s) => s.length >= 3);

  const matchName = (name, norms) => {
    const lower = name.toLowerCase();
    if (homeCands.includes(name) || awayCands.includes(name)) return true;
    const nt = normalizeTeamName(name);
    return norms.some((nc) => nt === nc || (nc.length >= 4 && nt.length >= 4 && (nt.includes(nc) || nc.includes(nt))));
  };

  // Look at ALL meetings between these two teams in either direction.
  // Take home-perspective rows only so we don't double-count each match.
  const meetings = xgRows.filter((r) => r.venue === "home" && (
    (matchName(r.team, normH) && matchName(r.opponent || "", normA)) ||
    (matchName(r.team, normA) && matchName(r.opponent || "", normH))
  ));

  meetings.sort((a, b) => new Date(b.match_date).getTime() - new Date(a.match_date).getTime());

  return meetings.slice(0, n).map((m) => {
    const homePerspective = matchName(m.team, normH);
    const gf = homePerspective ? Number(m.goals_for ?? m.xg ?? 0) : Number(m.goals_against ?? m.xga ?? 0);
    const ga = homePerspective ? Number(m.goals_against ?? m.xga ?? 0) : Number(m.goals_for ?? m.xg ?? 0);
    let result = "D";
    if (Number.isFinite(gf) && Number.isFinite(ga)) {
      if (gf > ga) result = "W";
      else if (gf < ga) result = "L";
    }
    return {
      date: m.match_date,
      venue: homePerspective ? "home" : "away",
      gf,
      ga,
      result,
    };
  });
}

// ─── 8. OpenLigaDB integration (German leagues only) ────────────────

// Map FODZE league keys to OpenLigaDB shortcuts. Only the three German
// divisions are covered — openligadb doesn't serve other countries.
const OPENLIGA_MAP = {
  bundesliga: "bl1",
  bundesliga2: "bl2",
  liga3: "bl3",
};

/**
 * Compute the current German football season year per OpenLigaDB convention:
 * the season starting in August 2025 is indexed as "2025" (runs until
 * May 2026). So from Aug-Dec we use this year; Jan-Jul we use last year.
 */
function currentGermanFootballSeason() {
  const d = new Date();
  const y = d.getFullYear();
  // Month is 0-indexed; 7 = August. Before August we're in prev season.
  return d.getMonth() >= 7 ? String(y) : String(y - 1);
}

/**
 * Fetch the current-season matches from OpenLigaDB for a FODZE league.
 * Returns [] for non-German leagues or on network failure. Never throws.
 *
 * Each match has { matchID, matchDateTime, group:{groupName, groupOrderID},
 *   team1:{teamName}, team2:{teamName}, matchIsFinished, matchResults, ... }.
 * The `group.groupName` is the real matchday label ("30. Spieltag") and
 * `groupOrderID` is the matchday number.
 */
export async function loadOpenLigaDBSeason(leagueKey, season = currentGermanFootballSeason()) {
  const shortcut = OPENLIGA_MAP[leagueKey];
  if (!shortcut) return [];
  try {
    // Season convention: "2025" = 2025/26 German football season
    const url = `https://api.openligadb.de/getmatchdata/${shortcut}/${season}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

/**
 * Find the OpenLigaDB entry matching a given home/away pair. Used to pull
 * the real matchday label + confirm kickoff + get the matchID for joins.
 */
export function findOpenLigaMatch(openLigaMatches, homeName, awayName) {
  if (!openLigaMatches?.length || !homeName || !awayName) return null;
  const nh = normalizeTeamName(homeName);
  const na = normalizeTeamName(awayName);
  return openLigaMatches.find((m) => {
    const t1 = normalizeTeamName(m.team1?.teamName || "");
    const t2 = normalizeTeamName(m.team2?.teamName || "");
    if (!t1 || !t2) return false;
    if (t1 === nh && t2 === na) return true;
    if (t1.length >= 4 && t2.length >= 4 && nh.length >= 4 && na.length >= 4) {
      if ((t1.includes(nh) || nh.includes(t1)) && (t2.includes(na) || na.includes(t2))) return true;
    }
    return false;
  }) || null;
}

/**
 * Find the most-populous matchday label among matches scheduled in the
 * next ~10 days. Avoids returning "34. Spieltag" when we're actually
 * querying mid-round for the upcoming round — takes the MAJORITY label.
 */
export function inferMatchdayLabel(openLigaMatches, aroundDate = new Date()) {
  if (!openLigaMatches?.length) return null;
  const start = aroundDate.getTime();
  const windowEnd = start + 10 * 86400_000;
  const upcoming = openLigaMatches.filter((m) => {
    const t = new Date(m.matchDateTime || m.matchDateTimeUTC || "").getTime();
    return Number.isFinite(t) && t >= start - 86400_000 && t <= windowEnd;
  });
  const labelCounts = new Map();
  for (const m of upcoming) {
    const label = m.group?.groupName;
    if (!label) continue;
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }
  if (labelCounts.size === 0) return null;
  return Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

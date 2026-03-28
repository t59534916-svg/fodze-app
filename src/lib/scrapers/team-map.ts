// ═══════════════════════════════════════════════════════════════════════
// FODZE Team Name Mapping — Links FODZE names to scraper sources
// ═══════════════════════════════════════════════════════════════════════

export interface TeamSource {
  understat?: string;   // Understat team name (exact match)
  fbref?: string;       // FBref squad URL path
  league: string;       // FODZE league key
}

/**
 * Mapping from FODZE team names to scraper source identifiers.
 * Understat names must match exactly as they appear on understat.com.
 * FBref paths are relative to https://fbref.com.
 */
export const TEAM_SCRAPER_MAP: Record<string, TeamSource> = {
  // ─── Bundesliga (Understat) ─────────────────────────────────
  "Bayern Munich":        { understat: "Bayern Munich", league: "bundesliga" },
  "FC Bayern München":    { understat: "Bayern Munich", league: "bundesliga" },
  "Bayer Leverkusen":     { understat: "Bayer Leverkusen", league: "bundesliga" },
  "Borussia Dortmund":    { understat: "Borussia Dortmund", league: "bundesliga" },
  "RB Leipzig":           { understat: "RasenBallsport Leipzig", league: "bundesliga" },
  "VfB Stuttgart":        { understat: "VfB Stuttgart", league: "bundesliga" },
  "Eintracht Frankfurt":  { understat: "Eintracht Frankfurt", league: "bundesliga" },
  "SC Freiburg":          { understat: "Freiburg", league: "bundesliga" },
  "TSG Hoffenheim":       { understat: "Hoffenheim", league: "bundesliga" },
  "VfL Wolfsburg":        { understat: "Wolfsburg", league: "bundesliga" },
  "1. FC Union Berlin":   { understat: "Union Berlin", league: "bundesliga" },
  "Werder Bremen":        { understat: "Werder Bremen", league: "bundesliga" },
  "FC Augsburg":          { understat: "Augsburg", league: "bundesliga" },
  "1. FSV Mainz 05":      { understat: "Mainz 05", league: "bundesliga" },
  "Borussia Mönchengladbach": { understat: "Borussia M.Gladbach", league: "bundesliga" },
  "1. FC Heidenheim":     { understat: "Heidenheim", league: "bundesliga" },
  "FC St. Pauli":         { understat: "St. Pauli", league: "bundesliga" },
  "Holstein Kiel":        { understat: "Holstein Kiel", league: "bundesliga" },

  // ─── Premier League (Understat) ─────────────────────────────
  "Manchester City":      { understat: "Manchester City", league: "epl" },
  "Arsenal":              { understat: "Arsenal", league: "epl" },
  "Liverpool":            { understat: "Liverpool", league: "epl" },
  "Aston Villa":          { understat: "Aston Villa", league: "epl" },
  "Tottenham":            { understat: "Tottenham", league: "epl" },
  "Chelsea":              { understat: "Chelsea", league: "epl" },
  "Newcastle":            { understat: "Newcastle United", league: "epl" },
  "Manchester United":    { understat: "Manchester United", league: "epl" },
  "West Ham":             { understat: "West Ham", league: "epl" },
  "Brighton":             { understat: "Brighton", league: "epl" },
  "Bournemouth":          { understat: "Bournemouth", league: "epl" },
  "Crystal Palace":       { understat: "Crystal Palace", league: "epl" },
  "Wolverhampton":        { understat: "Wolverhampton Wanderers", league: "epl" },
  "Fulham":               { understat: "Fulham", league: "epl" },
  "Everton":              { understat: "Everton", league: "epl" },
  "Brentford":            { understat: "Brentford", league: "epl" },
  "Nottingham Forest":    { understat: "Nottingham Forest", league: "epl" },
  "Ipswich Town":         { understat: "Ipswich", league: "epl" },
  "Leicester City":       { understat: "Leicester", league: "epl" },
  "Southampton":          { understat: "Southampton", league: "epl" },

  // ─── La Liga (Understat) ────────────────────────────────────
  "Real Madrid":          { understat: "Real Madrid", league: "la_liga" },
  "FC Barcelona":         { understat: "Barcelona", league: "la_liga" },
  "Atletico Madrid":      { understat: "Atletico Madrid", league: "la_liga" },
  "Girona":               { understat: "Girona", league: "la_liga" },
  "Athletic Bilbao":      { understat: "Athletic Club", league: "la_liga" },
  "Real Sociedad":        { understat: "Real Sociedad", league: "la_liga" },
  "Real Betis":           { understat: "Real Betis", league: "la_liga" },
  "Villarreal":           { understat: "Villarreal", league: "la_liga" },
  "Sevilla":              { understat: "Sevilla", league: "la_liga" },
  "Valencia":             { understat: "Valencia", league: "la_liga" },

  // ─── Serie A (Understat) ────────────────────────────────────
  "Inter Mailand":        { understat: "Inter", league: "serie_a" },
  "AC Milan":             { understat: "AC Milan", league: "serie_a" },
  "Juventus":             { understat: "Juventus", league: "serie_a" },
  "Atalanta":             { understat: "Atalanta", league: "serie_a" },
  "SSC Neapel":           { understat: "Napoli", league: "serie_a" },
  "AS Rom":               { understat: "Roma", league: "serie_a" },
  "Lazio":                { understat: "Lazio", league: "serie_a" },
  "Fiorentina":           { understat: "Fiorentina", league: "serie_a" },
  "Bologna":              { understat: "Bologna", league: "serie_a" },
  "Torino":               { understat: "Torino", league: "serie_a" },

  // ─── Ligue 1 (Understat) ───────────────────────────────────
  "Paris Saint-Germain":  { understat: "Paris Saint Germain", league: "ligue_1" },
  "AS Monaco":            { understat: "Monaco", league: "ligue_1" },
  "Olympique Marseille":  { understat: "Marseille", league: "ligue_1" },
  "LOSC Lille":           { understat: "Lille", league: "ligue_1" },
  "OGC Nizza":            { understat: "Nice", league: "ligue_1" },
  "Stade Rennes":         { understat: "Rennes", league: "ligue_1" },
  "RC Lens":              { understat: "Lens", league: "ligue_1" },
  "Olympique Lyon":       { understat: "Lyon", league: "ligue_1" },

  // ─── 2. Bundesliga (FBref only) ────────────────────────────
  "FC Schalke 04":        { fbref: "/en/squads/c539e393/Schalke-04-Stats", league: "bundesliga2" },
  "Fortuna Düsseldorf":   { fbref: "/en/squads/b1278397/Fortuna-Dusseldorf-Stats", league: "bundesliga2" },
  "Hertha BSC":           { fbref: "/en/squads/2818f8bc/Hertha-BSC-Stats", league: "bundesliga2" },
  "Hamburger SV":         { fbref: "/en/squads/febe5e84/Hamburger-SV-Stats", league: "bundesliga2" },
  "1. FC Köln":           { fbref: "/en/squads/bc357bf7/Koln-Stats", league: "bundesliga2" },
  "Hannover 96":          { fbref: "/en/squads/60b5e41f/Hannover-96-Stats", league: "bundesliga2" },
  "SV Darmstadt 98":      { fbref: "/en/squads/6a399165/Darmstadt-98-Stats", league: "bundesliga2" },
  "SC Paderborn":         { fbref: "/en/squads/3a4e3fe6/Paderborn-07-Stats", league: "bundesliga2" },
  "Karlsruher SC":        { fbref: "/en/squads/ecd11ca2/Karlsruher-SC-Stats", league: "bundesliga2" },
  "1. FC Nürnberg":       { fbref: "/en/squads/6dc1d32e/Nurnberg-Stats", league: "bundesliga2" },

  // ─── 3. Liga (FBref only, limited data) ─────────────────────
  "Dynamo Dresden":       { fbref: "/en/squads/5c16702a/Dynamo-Dresden-Stats", league: "liga3" },
  "1860 München":         { fbref: "/en/squads/5f8e0151/1860-Munich-Stats", league: "liga3" },
  "TSV 1860 München":     { fbref: "/en/squads/5f8e0151/1860-Munich-Stats", league: "liga3" },
  "Rot-Weiss Essen":      { fbref: "/en/squads/fa059953/Rot-Weiss-Essen-Stats", league: "liga3" },
  "Energie Cottbus":      { fbref: "/en/squads/6fbfc1f9/Energie-Cottbus-Stats", league: "liga3" },
  "Erzgebirge Aue":       { fbref: "/en/squads/95c2dd82/Erzgebirge-Aue-Stats", league: "liga3" },
  "1. FC Saarbrücken":    { fbref: "/en/squads/5c91e0ff/Saarbrucken-Stats", league: "liga3" },
  "Alemannia Aachen":     { fbref: "/en/squads/ccb62a73/Alemannia-Aachen-Stats", league: "liga3" },
  "SV Waldhof Mannheim":  { fbref: "/en/squads/5c44cd3e/Waldhof-Mannheim-Stats", league: "liga3" },
  "Hallescher FC":        { fbref: "/en/squads/4a9dbb30/Hallescher-FC-Stats", league: "liga3" },
  "Hansa Rostock":        { fbref: "/en/squads/d53a0066/Hansa-Rostock-Stats", league: "liga3" },
  "VfL Osnabrück":        { fbref: "/en/squads/b9583e3f/VfL-Osnabruck-Stats", league: "liga3" },
  "MSV Duisburg":         { fbref: "/en/squads/47e5edbd/MSV-Duisburg-Stats", league: "liga3" },
  "Preußen Münster":      { fbref: "/en/squads/f1e30aff/Preussen-Munster-Stats", league: "liga3" },
  "Arminia Bielefeld":    { fbref: "/en/squads/247c4b67/Arminia-Bielefeld-Stats", league: "liga3" },
  "SpVgg Unterhaching":   { fbref: "/en/squads/fc6e7be1/Unterhaching-Stats", league: "liga3" },
  "Viktoria Köln":        { fbref: "/en/squads/2fe80c74/Viktoria-Koln-Stats", league: "liga3" },
  "FC Viktoria Köln":     { fbref: "/en/squads/2fe80c74/Viktoria-Koln-Stats", league: "liga3" },
};

/**
 * Look up a team's scraper source. Tries exact match, then fuzzy.
 */
export function findTeamSource(teamName: string): TeamSource | null {
  // Exact match
  if (TEAM_SCRAPER_MAP[teamName]) return TEAM_SCRAPER_MAP[teamName];

  // Case-insensitive match
  const lower = teamName.toLowerCase();
  for (const [key, val] of Object.entries(TEAM_SCRAPER_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }

  // Partial match (contains)
  for (const [key, val] of Object.entries(TEAM_SCRAPER_MAP)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return val;
    }
  }

  return null;
}

/**
 * Check if a league has Understat coverage.
 */
export function hasUnderstatCoverage(league: string): boolean {
  return ["bundesliga", "epl", "la_liga", "serie_a", "ligue_1", "eredivisie"].includes(league);
}

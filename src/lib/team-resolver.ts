// ═══════════════════════════════════════════════════════════════════════
// FODZE Team Name Resolver — Unified Entity Resolution
//
// Maps between 3 naming universes:
// - FODZE names: "FC Bayern München" (what the app uses)
// - CSV names: "Bayern Munich" (what football-data.co.uk uses, Elo keyed to)
// - Understat names: "Bayern Munich" (what Supabase xG history uses)
//
// Without this, getElo("FC Bayern München") returns 1500 instead of 1919.
// ═══════════════════════════════════════════════════════════════════════

export interface TeamIdentity {
  fodze: string;
  csv: string;
  understat?: string;
  oddsApi?: string;
  league: string;
}

// ─── Complete Team Registry ──────────────────────────────────────────

const TEAM_REGISTRY: TeamIdentity[] = [
  // Bundesliga
  { fodze: "FC Bayern München", csv: "Bayern Munich", understat: "Bayern Munich", oddsApi: "Bayern Munich", league: "bundesliga" },
  { fodze: "Bayer 04 Leverkusen", csv: "Leverkusen", understat: "Bayer Leverkusen", oddsApi: "Bayer Leverkusen", league: "bundesliga" },
  { fodze: "Borussia Dortmund", csv: "Dortmund", understat: "Borussia Dortmund", oddsApi: "Borussia Dortmund", league: "bundesliga" },
  { fodze: "RB Leipzig", csv: "RB Leipzig", understat: "RasenBallsport Leipzig", oddsApi: "RB Leipzig", league: "bundesliga" },
  { fodze: "Eintracht Frankfurt", csv: "Ein Frankfurt", understat: "Eintracht Frankfurt", oddsApi: "Eintracht Frankfurt", league: "bundesliga" },
  { fodze: "VfB Stuttgart", csv: "Stuttgart", understat: "VfB Stuttgart", oddsApi: "VfB Stuttgart", league: "bundesliga" },
  { fodze: "SC Freiburg", csv: "Freiburg", understat: "Freiburg", oddsApi: "SC Freiburg", league: "bundesliga" },
  { fodze: "TSG Hoffenheim", csv: "Hoffenheim", understat: "Hoffenheim", oddsApi: "TSG Hoffenheim", league: "bundesliga" },
  { fodze: "VfL Wolfsburg", csv: "Wolfsburg", understat: "Wolfsburg", oddsApi: "VfL Wolfsburg", league: "bundesliga" },
  { fodze: "Borussia Mönchengladbach", csv: "M'gladbach", understat: "Borussia M.Gladbach", oddsApi: "Borussia Monchengladbach", league: "bundesliga" },
  { fodze: "SV Werder Bremen", csv: "Werder Bremen", understat: "Werder Bremen", oddsApi: "Werder Bremen", league: "bundesliga" },
  { fodze: "FC Augsburg", csv: "Augsburg", understat: "Augsburg", oddsApi: "Augsburg", league: "bundesliga" },
  { fodze: "1. FSV Mainz 05", csv: "Mainz", understat: "Mainz 05", oddsApi: "FSV Mainz 05", league: "bundesliga" },
  { fodze: "1. FC Union Berlin", csv: "Union Berlin", understat: "Union Berlin", oddsApi: "Union Berlin", league: "bundesliga" },
  { fodze: "1. FC Heidenheim", csv: "Heidenheim", oddsApi: "1. FC Heidenheim", league: "bundesliga" },
  { fodze: "FC St. Pauli", csv: "St Pauli", oddsApi: "FC St. Pauli", league: "bundesliga" },
  { fodze: "Holstein Kiel", csv: "Holstein Kiel", league: "bundesliga" },
  { fodze: "VfL Bochum", csv: "Bochum", understat: "Bochum", league: "bundesliga" },
  { fodze: "1. FC Köln", csv: "FC Koln", understat: "FC Cologne", oddsApi: "1. FC Köln", league: "bundesliga" },
  { fodze: "FC Schalke 04", csv: "Schalke 04", understat: "Schalke 04", league: "bundesliga" },
  { fodze: "Hertha BSC", csv: "Hertha", understat: "Hertha Berlin", league: "bundesliga" },
  { fodze: "SV Darmstadt 98", csv: "Darmstadt", league: "bundesliga" },
  { fodze: "Hamburger SV", csv: "Hamburg", understat: "Hamburger SV", oddsApi: "Hamburger SV", league: "bundesliga" },
  { fodze: "Hannover 96", csv: "Hannover", understat: "Hannover 96", league: "bundesliga" },
  { fodze: "1. FC Nürnberg", csv: "Nurnberg", league: "bundesliga" },

  // Premier League
  { fodze: "Arsenal", csv: "Arsenal", understat: "Arsenal", league: "epl" },
  { fodze: "Liverpool", csv: "Liverpool", understat: "Liverpool", league: "epl" },
  { fodze: "Manchester City", csv: "Man City", understat: "Manchester City", league: "epl" },
  { fodze: "Manchester United", csv: "Man United", understat: "Manchester United", league: "epl" },
  { fodze: "Chelsea", csv: "Chelsea", understat: "Chelsea", league: "epl" },
  { fodze: "Tottenham Hotspur", csv: "Tottenham", understat: "Tottenham", league: "epl" },
  { fodze: "Newcastle United", csv: "Newcastle", understat: "Newcastle United", league: "epl" },
  { fodze: "Aston Villa", csv: "Aston Villa", understat: "Aston Villa", league: "epl" },
  { fodze: "West Ham United", csv: "West Ham", understat: "West Ham", league: "epl" },
  { fodze: "Brighton & Hove Albion", csv: "Brighton", understat: "Brighton", oddsApi: "Brighton and Hove Albion", league: "epl" },
  { fodze: "Wolverhampton Wanderers", csv: "Wolves", understat: "Wolverhampton Wanderers", oddsApi: "Wolverhampton Wanderers", league: "epl" },
  { fodze: "AFC Bournemouth", csv: "Bournemouth", understat: "Bournemouth", oddsApi: "Bournemouth", league: "epl" },
  { fodze: "Fulham", csv: "Fulham", understat: "Fulham", league: "epl" },
  { fodze: "Crystal Palace", csv: "Crystal Palace", understat: "Crystal Palace", league: "epl" },
  { fodze: "Brentford", csv: "Brentford", understat: "Brentford", league: "epl" },
  { fodze: "Everton", csv: "Everton", understat: "Everton", league: "epl" },
  { fodze: "Nottingham Forest", csv: "Nott'm Forest", understat: "Nottingham Forest", league: "epl" },
  { fodze: "Burnley", csv: "Burnley", understat: "Burnley", league: "epl" },
  { fodze: "Sunderland", csv: "Sunderland", understat: "Sunderland", league: "epl" },
  { fodze: "Leeds United", csv: "Leeds", understat: "Leeds", league: "epl" },
  { fodze: "Leicester City", csv: "Leicester", understat: "Leicester", league: "epl" },
  { fodze: "Southampton", csv: "Southampton", understat: "Southampton", league: "epl" },
  { fodze: "Ipswich Town", csv: "Ipswich", league: "epl" },

  // Championship
  { fodze: "Sheffield United", csv: "Sheffield United", league: "championship" },
  { fodze: "Leeds United", csv: "Leeds", league: "championship" },
  { fodze: "Burnley", csv: "Burnley", league: "championship" },
  { fodze: "Sunderland", csv: "Sunderland", league: "championship" },
  { fodze: "Norwich City", csv: "Norwich", league: "championship" },
  { fodze: "West Bromwich Albion", csv: "West Brom", league: "championship" },
  { fodze: "Coventry City", csv: "Coventry", league: "championship" },
  { fodze: "Middlesbrough", csv: "Middlesbrough", league: "championship" },
  { fodze: "Bristol City", csv: "Bristol City", league: "championship" },
  { fodze: "Watford", csv: "Watford", league: "championship" },
  { fodze: "Swansea City", csv: "Swansea", league: "championship" },
  { fodze: "Stoke City", csv: "Stoke", league: "championship" },
  { fodze: "Hull City", csv: "Hull", league: "championship" },
  { fodze: "Millwall", csv: "Millwall", league: "championship" },
  { fodze: "Queens Park Rangers", csv: "QPR", league: "championship" },
  { fodze: "Preston North End", csv: "Preston", league: "championship" },
  { fodze: "Derby County", csv: "Derby", league: "championship" },
  { fodze: "Sheffield Wednesday", csv: "Sheffield Weds", league: "championship" },
  { fodze: "Oxford United", csv: "Oxford", league: "championship" },
  { fodze: "Birmingham City", csv: "Birmingham", league: "championship" },
  { fodze: "Wrexham", csv: "Wrexham", league: "championship" },
  { fodze: "Charlton Athletic", csv: "Charlton", league: "championship" },
  { fodze: "Ipswich Town", csv: "Ipswich", league: "championship" },
  { fodze: "Leicester City", csv: "Leicester", league: "championship" },
  { fodze: "Southampton", csv: "Southampton", league: "championship" },

  // La Liga
  { fodze: "Real Madrid", csv: "Real Madrid", understat: "Real Madrid", league: "la_liga" },
  { fodze: "FC Barcelona", csv: "Barcelona", understat: "Barcelona", oddsApi: "Barcelona", league: "la_liga" },
  { fodze: "Atlético Madrid", csv: "Ath Madrid", understat: "Atletico Madrid", oddsApi: "Atlético Madrid", league: "la_liga" },
  { fodze: "Athletic Bilbao", csv: "Ath Bilbao", understat: "Athletic Club", oddsApi: "Athletic Bilbao", league: "la_liga" },
  { fodze: "Real Sociedad", csv: "Sociedad", understat: "Real Sociedad", league: "la_liga" },
  { fodze: "Real Betis", csv: "Betis", understat: "Real Betis", league: "la_liga" },
  { fodze: "FC Villarreal", csv: "Villarreal", understat: "Villarreal", oddsApi: "Villarreal", league: "la_liga" },
  { fodze: "FC Sevilla", csv: "Sevilla", understat: "Sevilla", oddsApi: "Sevilla", league: "la_liga" },
  { fodze: "FC Valencia", csv: "Valencia", understat: "Valencia", oddsApi: "Valencia", league: "la_liga" },
  { fodze: "Celta Vigo", csv: "Celta", understat: "Celta Vigo", oddsApi: "Celta Vigo", league: "la_liga" },
  { fodze: "FC Getafe", csv: "Getafe", understat: "Getafe", oddsApi: "Getafe", league: "la_liga" },
  { fodze: "CA Osasuna", csv: "Osasuna", understat: "Osasuna", oddsApi: "CA Osasuna", league: "la_liga" },
  { fodze: "RCD Mallorca", csv: "Mallorca", understat: "Mallorca", oddsApi: "Mallorca", league: "la_liga" },
  { fodze: "Rayo Vallecano", csv: "Vallecano", understat: "Rayo Vallecano", oddsApi: "Rayo Vallecano", league: "la_liga" },
  { fodze: "Deportivo Alavés", csv: "Alaves", understat: "Alaves", oddsApi: "Alavés", league: "la_liga" },
  { fodze: "FC Girona", csv: "Girona", understat: "Girona", oddsApi: "Girona", league: "la_liga" },
  { fodze: "Espanyol Barcelona", csv: "Espanol", understat: "Espanyol", oddsApi: "Espanyol", league: "la_liga" },
  { fodze: "UD Levante", csv: "Levante", understat: "Levante", oddsApi: "Levante", league: "la_liga" },
  { fodze: "Elche CF", csv: "Elche", understat: "Elche", oddsApi: "Elche CF", league: "la_liga" },
  { fodze: "Real Oviedo", csv: "Real Oviedo", oddsApi: "Oviedo", league: "la_liga" },

  // Serie A
  { fodze: "Inter Milan", csv: "Inter", understat: "Inter", oddsApi: "Inter Milan", league: "serie_a" },
  { fodze: "AC Milan", csv: "Milan", understat: "AC Milan", oddsApi: "AC Milan", league: "serie_a" },
  { fodze: "Juventus", csv: "Juventus", understat: "Juventus", league: "serie_a" },
  { fodze: "Napoli", csv: "Napoli", understat: "Napoli", league: "serie_a" },
  { fodze: "Atalanta", csv: "Atalanta", understat: "Atalanta", oddsApi: "Atalanta BC", league: "serie_a" },
  { fodze: "Roma", csv: "Roma", understat: "Roma", oddsApi: "AS Roma", league: "serie_a" },
  { fodze: "Lazio", csv: "Lazio", understat: "Lazio", league: "serie_a" },
  { fodze: "Fiorentina", csv: "Fiorentina", understat: "Fiorentina", league: "serie_a" },
  { fodze: "Bologna", csv: "Bologna", understat: "Bologna", league: "serie_a" },
  { fodze: "Torino", csv: "Torino", understat: "Torino", league: "serie_a" },
  { fodze: "Genoa", csv: "Genoa", understat: "Genoa", league: "serie_a" },
  { fodze: "Udinese", csv: "Udinese", understat: "Udinese", league: "serie_a" },
  { fodze: "Cagliari", csv: "Cagliari", understat: "Cagliari", league: "serie_a" },
  { fodze: "US Sassuolo", csv: "Sassuolo", understat: "Sassuolo", oddsApi: "Sassuolo", league: "serie_a" },
  { fodze: "Hellas Verona", csv: "Verona", understat: "Verona", oddsApi: "Hellas Verona", league: "serie_a" },
  { fodze: "Lecce", csv: "Lecce", understat: "Lecce", league: "serie_a" },
  { fodze: "Parma", csv: "Parma", understat: "Parma", league: "serie_a" },
  { fodze: "Como 1907", csv: "Como", understat: "Como", oddsApi: "Como", league: "serie_a" },

  // Ligue 1
  { fodze: "Paris Saint-Germain", csv: "Paris SG", understat: "Paris Saint Germain", league: "ligue_1" },
  { fodze: "AS Monaco", csv: "Monaco", understat: "Monaco", league: "ligue_1" },
  { fodze: "Olympique Marseille", csv: "Marseille", understat: "Marseille", league: "ligue_1" },
  { fodze: "LOSC Lille", csv: "Lille", understat: "Lille", league: "ligue_1" },
  { fodze: "Olympique Lyon", csv: "Lyon", understat: "Lyon", league: "ligue_1" },
  { fodze: "OGC Nizza", csv: "Nice", understat: "Nice", league: "ligue_1" },
  { fodze: "Stade Rennes", csv: "Rennes", understat: "Rennes", league: "ligue_1" },
  { fodze: "RC Lens", csv: "Lens", understat: "Lens", league: "ligue_1" },
  { fodze: "Stade Brest", csv: "Brest", understat: "Brest", league: "ligue_1" },
  { fodze: "RC Strasbourg", csv: "Strasbourg", understat: "Strasbourg", league: "ligue_1" },
  { fodze: "FC Toulouse", csv: "Toulouse", understat: "Toulouse", league: "ligue_1" },
  { fodze: "FC Nantes", csv: "Nantes", understat: "Nantes", league: "ligue_1" },
  { fodze: "HSC Montpellier", csv: "Montpellier", understat: "Montpellier", league: "ligue_1" },
  { fodze: "Stade Reims", csv: "Reims", understat: "Reims", league: "ligue_1" },
];

// ─── Build Lookup Maps ───────────────────────────────────────────────

const byFodze = new Map<string, TeamIdentity>();
const byCsv = new Map<string, TeamIdentity>();
const byUnderstat = new Map<string, TeamIdentity>();
const byOddsApi = new Map<string, TeamIdentity>();
const byFodzeLower = new Map<string, TeamIdentity>();

for (const team of TEAM_REGISTRY) {
  byFodze.set(team.fodze, team);
  byCsv.set(team.csv, team);
  byFodzeLower.set(team.fodze.toLowerCase(), team);
  if (team.understat) byUnderstat.set(team.understat, team);
  if (team.oddsApi) byOddsApi.set(team.oddsApi, team);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Resolve any team name variant to a TeamIdentity.
 * Tries: exact FODZE → exact CSV → exact Understat → case-insensitive → substring
 */
export function resolveTeam(name: string): TeamIdentity | null {
  if (!name) return null;
  // Exact matches
  if (byFodze.has(name)) return byFodze.get(name)!;
  if (byCsv.has(name)) return byCsv.get(name)!;
  if (byUnderstat.has(name)) return byUnderstat.get(name)!;
  if (byOddsApi.has(name)) return byOddsApi.get(name)!;
  // Case-insensitive
  const lower = name.toLowerCase();
  if (byFodzeLower.has(lower)) return byFodzeLower.get(lower)!;
  // Substring match (last resort)
  for (const team of TEAM_REGISTRY) {
    const tl = team.fodze.toLowerCase();
    const cl = team.csv.toLowerCase();
    if (tl.includes(lower) || lower.includes(tl) || cl.includes(lower) || lower.includes(cl)) {
      return team;
    }
  }
  return null;
}

/**
 * Convert FODZE name to CSV name (for Elo lookup).
 * Returns input unchanged if no mapping found.
 */
export function toCsvName(fodzeName: string): string {
  const resolved = resolveTeam(fodzeName);
  return resolved?.csv || fodzeName;
}

/**
 * Convert FODZE name to Understat name (for xG history).
 * Returns input unchanged if no mapping found.
 */
export function toUnderstatName(fodzeName: string): string {
  const resolved = resolveTeam(fodzeName);
  return resolved?.understat || fodzeName;
}

/**
 * Convert Odds-API team name to FODZE name.
 * Returns input unchanged if no mapping found.
 */
export function fromOddsApiName(oddsApiName: string): string {
  if (byOddsApi.has(oddsApiName)) return byOddsApi.get(oddsApiName)!.fodze;
  // Fallback to general resolution
  const resolved = resolveTeam(oddsApiName);
  return resolved?.fodze || oddsApiName;
}

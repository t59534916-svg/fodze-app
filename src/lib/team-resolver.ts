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

  // Eredivisie (missing from registry, teams already in LEAGUES)
  { fodze: "Ajax Amsterdam", csv: "Ajax", understat: "Ajax", league: "eredivisie" },
  { fodze: "PSV Eindhoven", csv: "PSV Eindhoven", understat: "PSV", league: "eredivisie" },
  { fodze: "Feyenoord Rotterdam", csv: "Feyenoord", understat: "Feyenoord", league: "eredivisie" },
  { fodze: "AZ Alkmaar", csv: "AZ Alkmaar", understat: "AZ", league: "eredivisie" },
  { fodze: "FC Twente", csv: "Twente", understat: "Twente", league: "eredivisie" },
  { fodze: "FC Utrecht", csv: "Utrecht", understat: "Utrecht", league: "eredivisie" },
  { fodze: "SC Heerenveen", csv: "Heerenveen", understat: "Heerenveen", league: "eredivisie" },
  { fodze: "Sparta Rotterdam", csv: "Sparta Rotterdam", league: "eredivisie" },
  { fodze: "Go Ahead Eagles", csv: "Go Ahead Eagles", league: "eredivisie" },
  { fodze: "FC Groningen", csv: "Groningen", understat: "Groningen", league: "eredivisie" },
  { fodze: "Heracles Almelo", csv: "Heracles", understat: "Heracles", league: "eredivisie" },
  { fodze: "Willem II", csv: "Willem II", understat: "Willem II", league: "eredivisie" },
  { fodze: "NEC Nijmegen", csv: "Nijmegen", understat: "NEC", league: "eredivisie" },
  { fodze: "NAC Breda", csv: "NAC Breda", league: "eredivisie" },
  { fodze: "Fortuna Sittard", csv: "For Sittard", understat: "Fortuna Sittard", league: "eredivisie" },
  { fodze: "RKC Waalwijk", csv: "Waalwijk", understat: "Waalwijk", league: "eredivisie" },
  { fodze: "PEC Zwolle", csv: "Zwolle", understat: "Zwolle", league: "eredivisie" },
  { fodze: "Almere City FC", csv: "Almere City", league: "eredivisie" },

  // ═══ Primeira Liga (Portugal) ═══
  { fodze: "SL Benfica", csv: "Benfica", league: "primeira_liga" },
  { fodze: "FC Porto", csv: "Porto", league: "primeira_liga" },
  { fodze: "Sporting CP", csv: "Sp Lisbon", league: "primeira_liga" },
  { fodze: "SC Braga", csv: "Sp Braga", league: "primeira_liga" },
  { fodze: "Vitória Guimarães", csv: "Guimaraes", league: "primeira_liga" },
  { fodze: "Gil Vicente", csv: "Gil Vicente", league: "primeira_liga" },
  { fodze: "Casa Pia AC", csv: "Casa Pia", league: "primeira_liga" },
  { fodze: "Famalicão", csv: "Famalicao", league: "primeira_liga" },
  { fodze: "Moreirense", csv: "Moreirense", league: "primeira_liga" },
  { fodze: "Rio Ave", csv: "Rio Ave", league: "primeira_liga" },
  { fodze: "Estoril Praia", csv: "Estoril", league: "primeira_liga" },
  { fodze: "Estrela Amadora", csv: "Estrela", league: "primeira_liga" },
  { fodze: "SC Farense", csv: "Farense", league: "primeira_liga" },
  { fodze: "Nacional", csv: "Nacional", league: "primeira_liga" },
  { fodze: "Boavista", csv: "Boavista", league: "primeira_liga" },
  { fodze: "Santa Clara", csv: "Santa Clara", league: "primeira_liga" },
  { fodze: "FC Arouca", csv: "Arouca", league: "primeira_liga" },
  { fodze: "AVS Futebol SAD", csv: "AVS", league: "primeira_liga" },

  // ═══ Jupiler Pro League (Belgium) ═══
  { fodze: "Club Brugge", csv: "Club Brugge", league: "jupiler_pro" },
  { fodze: "RSC Anderlecht", csv: "Anderlecht", league: "jupiler_pro" },
  { fodze: "KRC Genk", csv: "Genk", league: "jupiler_pro" },
  { fodze: "KAA Gent", csv: "Gent", league: "jupiler_pro" },
  { fodze: "Royal Antwerp FC", csv: "Antwerp", league: "jupiler_pro" },
  { fodze: "Standard Liège", csv: "Standard", league: "jupiler_pro" },
  { fodze: "Union Saint-Gilloise", csv: "St. Gilloise", league: "jupiler_pro" },
  { fodze: "Cercle Brugge", csv: "Cercle Brugge", league: "jupiler_pro" },
  { fodze: "Charleroi", csv: "Charleroi", league: "jupiler_pro" },
  { fodze: "KV Mechelen", csv: "Mechelen", league: "jupiler_pro" },
  { fodze: "KV Kortrijk", csv: "Kortrijk", league: "jupiler_pro" },
  { fodze: "Sint-Truiden", csv: "St Truiden", league: "jupiler_pro" },
  { fodze: "KVC Westerlo", csv: "Westerlo", league: "jupiler_pro" },
  { fodze: "OH Leuven", csv: "Oud-Heverlee Leuven", league: "jupiler_pro" },
  { fodze: "Beerschot", csv: "Beerschot VA", league: "jupiler_pro" },
  { fodze: "FCV Dender", csv: "Dender", league: "jupiler_pro" },

  // ═══ Süper Lig (Turkey) ═══
  { fodze: "Galatasaray", csv: "Galatasaray", league: "super_lig" },
  { fodze: "Fenerbahçe", csv: "Fenerbahce", league: "super_lig" },
  { fodze: "Beşiktaş", csv: "Besiktas", league: "super_lig" },
  { fodze: "Trabzonspor", csv: "Trabzonspor", league: "super_lig" },
  { fodze: "Başakşehir", csv: "Buyuksehyr", league: "super_lig" },
  { fodze: "Kasımpaşa", csv: "Kasimpasa", league: "super_lig" },
  { fodze: "Antalyaspor", csv: "Antalyaspor", league: "super_lig" },
  { fodze: "Alanyaspor", csv: "Alanyaspor", league: "super_lig" },
  { fodze: "Konyaspor", csv: "Konyaspor", league: "super_lig" },
  { fodze: "Sivasspor", csv: "Sivasspor", league: "super_lig" },
  { fodze: "Kayserispor", csv: "Kayserispor", league: "super_lig" },
  { fodze: "Gaziantep FK", csv: "Gaziantep", league: "super_lig" },
  { fodze: "Samsunspor", csv: "Samsunspor", league: "super_lig" },
  { fodze: "Rizespor", csv: "Rizespor", league: "super_lig" },
  { fodze: "Hatayspor", csv: "Hatayspor", league: "super_lig" },
  { fodze: "Adana Demirspor", csv: "Ad. Demirspor", league: "super_lig" },
  { fodze: "Göztepe", csv: "Goztep", league: "super_lig" },
  { fodze: "Eyüpspor", csv: "Eyupspor", league: "super_lig" },
  { fodze: "Bodrum FK", csv: "Bodrumspor", league: "super_lig" },

  // ═══ La Liga 2 (Spain) ═══
  { fodze: "Levante UD", csv: "Levante", league: "la_liga2" },
  { fodze: "Granada CF", csv: "Granada", league: "la_liga2" },
  { fodze: "SD Eibar", csv: "Eibar", league: "la_liga2" },
  { fodze: "Cádiz CF", csv: "Cadiz", league: "la_liga2" },
  { fodze: "UD Almería", csv: "Almeria", league: "la_liga2" },
  { fodze: "Real Zaragoza", csv: "Zaragoza", league: "la_liga2" },
  { fodze: "Real Oviedo", csv: "Oviedo", league: "la_liga2" },
  { fodze: "Racing Santander", csv: "Santander", league: "la_liga2" },
  { fodze: "Sporting Gijón", csv: "Sp Gijon", league: "la_liga2" },
  { fodze: "CD Tenerife", csv: "Tenerife", league: "la_liga2" },
  { fodze: "SD Huesca", csv: "Huesca", league: "la_liga2" },
  { fodze: "CD Castellón", csv: "Castellon", league: "la_liga2" },
  { fodze: "CD Mirandés", csv: "Mirandes", league: "la_liga2" },
  { fodze: "FC Cartagena", csv: "Cartagena", league: "la_liga2" },
  { fodze: "Racing Ferrol", csv: "Ferrol", league: "la_liga2" },
  { fodze: "Albacete Balompié", csv: "Albacete", league: "la_liga2" },
  { fodze: "Burgos CF", csv: "Burgos", league: "la_liga2" },
  { fodze: "Córdoba CF", csv: "Cordoba", league: "la_liga2" },
  { fodze: "Elche CF", csv: "Elche", league: "la_liga2" },
  { fodze: "Eldense", csv: "Eldense", league: "la_liga2" },
  { fodze: "Deportivo La Coruña", csv: "La Coruna", league: "la_liga2" },
  { fodze: "Málaga CF", csv: "Malaga", league: "la_liga2" },

  // ═══ Serie B (Italy) ═══
  { fodze: "US Sassuolo", csv: "Sassuolo", league: "serie_b" },
  { fodze: "Pisa", csv: "Pisa", league: "serie_b" },
  { fodze: "Spezia", csv: "Spezia", league: "serie_b" },
  { fodze: "Cremonese", csv: "Cremonese", league: "serie_b" },
  { fodze: "Palermo", csv: "Palermo", league: "serie_b" },
  { fodze: "Sampdoria", csv: "Sampdoria", league: "serie_b" },
  { fodze: "Salernitana", csv: "Salernitana", league: "serie_b" },
  { fodze: "Frosinone", csv: "Frosinone", league: "serie_b" },
  { fodze: "Bari", csv: "Bari", league: "serie_b" },
  { fodze: "Catanzaro", csv: "Catanzaro", league: "serie_b" },
  { fodze: "Brescia", csv: "Brescia", league: "serie_b" },
  { fodze: "Modena", csv: "Modena", league: "serie_b" },
  { fodze: "Reggiana", csv: "Reggiana", league: "serie_b" },
  { fodze: "Cesena", csv: "Cesena", league: "serie_b" },
  { fodze: "Cittadella", csv: "Cittadella", league: "serie_b" },
  { fodze: "Cosenza", csv: "Cosenza", league: "serie_b" },
  { fodze: "Juve Stabia", csv: "Juve Stabia", league: "serie_b" },
  { fodze: "Mantova", csv: "Mantova", league: "serie_b" },
  { fodze: "Carrarese", csv: "Carrarese", league: "serie_b" },
  { fodze: "Südtirol", csv: "Sudtirol", league: "serie_b" },

  // ═══ Ligue 2 (France) ═══
  { fodze: "FC Lorient", csv: "Lorient", league: "ligue_2" },
  { fodze: "FC Metz", csv: "Metz", league: "ligue_2" },
  { fodze: "SM Caen", csv: "Caen", league: "ligue_2" },
  { fodze: "Troyes AC", csv: "Troyes", league: "ligue_2" },
  { fodze: "SC Bastia", csv: "Bastia", league: "ligue_2" },
  { fodze: "Clermont Foot", csv: "Clermont", league: "ligue_2" },
  { fodze: "EA Guingamp", csv: "Guingamp", league: "ligue_2" },
  { fodze: "Grenoble Foot 38", csv: "Grenoble", league: "ligue_2" },
  { fodze: "Stade Lavallois", csv: "Laval", league: "ligue_2" },
  { fodze: "Amiens SC", csv: "Amiens", league: "ligue_2" },
  { fodze: "AC Ajaccio", csv: "Ajaccio", league: "ligue_2" },
  { fodze: "Pau FC", csv: "Pau FC", league: "ligue_2" },
  { fodze: "Paris FC", csv: "Paris FC", league: "ligue_2" },
  { fodze: "Rodez AF", csv: "Rodez", league: "ligue_2" },
  { fodze: "USL Dunkerque", csv: "Dunkerque", league: "ligue_2" },
  { fodze: "FC Annecy", csv: "Annecy", league: "ligue_2" },
  { fodze: "FC Martigues", csv: "Martigues", league: "ligue_2" },
  { fodze: "Red Star FC", csv: "Red Star", league: "ligue_2" },

  // ═══ Scottish Premiership ═══
  { fodze: "Celtic", csv: "Celtic", league: "scottish_prem" },
  { fodze: "Rangers", csv: "Rangers", league: "scottish_prem" },
  { fodze: "Aberdeen", csv: "Aberdeen", league: "scottish_prem" },
  { fodze: "Hearts", csv: "Hearts", league: "scottish_prem" },
  { fodze: "Hibernian", csv: "Hibernian", league: "scottish_prem" },
  { fodze: "Dundee United", csv: "Dundee United", league: "scottish_prem" },
  { fodze: "Dundee FC", csv: "Dundee", league: "scottish_prem" },
  { fodze: "Kilmarnock", csv: "Kilmarnock", league: "scottish_prem" },
  { fodze: "Motherwell", csv: "Motherwell", league: "scottish_prem" },
  { fodze: "St Mirren", csv: "St Mirren", league: "scottish_prem" },
  { fodze: "St Johnstone", csv: "St Johnstone", league: "scottish_prem" },
  { fodze: "Ross County", csv: "Ross County", league: "scottish_prem" },

  // ═══ Super League Greece ═══
  { fodze: "Olympiakos Piräus", csv: "Olympiakos", league: "greek_sl" },
  { fodze: "PAOK Thessaloniki", csv: "PAOK", league: "greek_sl" },
  { fodze: "Panathinaikos", csv: "Panathinaikos", league: "greek_sl" },
  { fodze: "AEK Athen", csv: "AEK", league: "greek_sl" },
  { fodze: "Aris Thessaloniki", csv: "Aris", league: "greek_sl" },
  { fodze: "Atromitos", csv: "Atromitos", league: "greek_sl" },
  { fodze: "Asteras Tripolis", csv: "Asteras Tripolis", league: "greek_sl" },
  { fodze: "OFI Kreta", csv: "OFI Crete", league: "greek_sl" },
  { fodze: "Volos NFC", csv: "Volos NFC", league: "greek_sl" },
  { fodze: "Lamia", csv: "Lamia", league: "greek_sl" },
  { fodze: "Levadeiakos", csv: "Levadeiakos", league: "greek_sl" },
  { fodze: "Panetolikos", csv: "Panetolikos", league: "greek_sl" },
  { fodze: "Athens Kallithea", csv: "Athens Kallithea", league: "greek_sl" },
  { fodze: "Panserraikos", csv: "Panserraikos", league: "greek_sl" },

  // ═══ League One (England) ═══
  { fodze: "Birmingham City", csv: "Birmingham", league: "league_one" },
  { fodze: "Wrexham", csv: "Wrexham", league: "league_one" },
  { fodze: "Huddersfield Town", csv: "Huddersfield", league: "league_one" },
  { fodze: "Bolton Wanderers", csv: "Bolton", league: "league_one" },
  { fodze: "Wigan Athletic", csv: "Wigan", league: "league_one" },
  { fodze: "Charlton Athletic", csv: "Charlton", league: "league_one" },
  { fodze: "Barnsley", csv: "Barnsley", league: "league_one" },
  { fodze: "Blackpool", csv: "Blackpool", league: "league_one" },
  { fodze: "Peterborough United", csv: "Peterboro", league: "league_one" },
  { fodze: "Reading", csv: "Reading", league: "league_one" },
  { fodze: "Rotherham United", csv: "Rotherham", league: "league_one" },
  { fodze: "Exeter City", csv: "Exeter", league: "league_one" },
  { fodze: "Lincoln City", csv: "Lincoln", league: "league_one" },
  { fodze: "Stockport County", csv: "Stockport", league: "league_one" },
  { fodze: "Mansfield Town", csv: "Mansfield", league: "league_one" },
  { fodze: "Northampton Town", csv: "Northampton", league: "league_one" },
  { fodze: "Leyton Orient", csv: "Leyton Orient", league: "league_one" },
  { fodze: "Stevenage", csv: "Stevenage", league: "league_one" },
  { fodze: "Shrewsbury Town", csv: "Shrewsbury", league: "league_one" },
  { fodze: "Cambridge United", csv: "Cambridge", league: "league_one" },
  { fodze: "Crawley Town", csv: "Crawley Town", league: "league_one" },
  { fodze: "Burton Albion", csv: "Burton", league: "league_one" },
  { fodze: "Bristol Rovers", csv: "Bristol Rvs", league: "league_one" },
  { fodze: "Wycombe Wanderers", csv: "Wycombe", league: "league_one" },

  // ═══ League Two (England) ═══
  { fodze: "Doncaster Rovers", csv: "Doncaster", league: "league_two" },
  { fodze: "Bradford City", csv: "Bradford", league: "league_two" },
  { fodze: "Chesterfield", csv: "Chesterfield", league: "league_two" },
  { fodze: "Grimsby Town", csv: "Grimsby", league: "league_two" },
  { fodze: "Notts County", csv: "Notts County", league: "league_two" },
  { fodze: "Crewe Alexandra", csv: "Crewe", league: "league_two" },
  { fodze: "MK Dons", csv: "Milton Keynes Dons", league: "league_two" },
  { fodze: "Port Vale", csv: "Port Vale", league: "league_two" },
  { fodze: "Swindon Town", csv: "Swindon", league: "league_two" },
  { fodze: "Cheltenham Town", csv: "Cheltenham", league: "league_two" },
  { fodze: "Carlisle United", csv: "Carlisle", league: "league_two" },
  { fodze: "Walsall", csv: "Walsall", league: "league_two" },
  { fodze: "Gillingham", csv: "Gillingham", league: "league_two" },
  { fodze: "Barrow", csv: "Barrow", league: "league_two" },
  { fodze: "AFC Wimbledon", csv: "AFC Wimbledon", league: "league_two" },
  { fodze: "Newport County", csv: "Newport County", league: "league_two" },
  { fodze: "Accrington Stanley", csv: "Accrington", league: "league_two" },
  { fodze: "Tranmere Rovers", csv: "Tranmere", league: "league_two" },
  { fodze: "Morecambe", csv: "Morecambe", league: "league_two" },
  { fodze: "Salford City", csv: "Salford", league: "league_two" },
  { fodze: "Colchester United", csv: "Colchester", league: "league_two" },
  { fodze: "Bromley", csv: "Bromley", league: "league_two" },
  { fodze: "Harrogate Town", csv: "Harrogate", league: "league_two" },
  { fodze: "Fleetwood Town", csv: "Fleetwood Town", league: "league_two" },
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
 * Fuzzy-compare two team names for "same team" intent.
 *
 * Used when two naming universes emit different strings for the same team
 * and a definitive mapping isn't available at the call site — e.g. matching
 * `live_odds.home_team` against `matchdays.data.matches[].home.name`, or
 * lining up goldilocks odds against matchday-resolved teams.
 *
 * Rules (case-insensitive):
 *   1. Substring either way                       → match
 *   2. Any shared word with length > 3            → match
 *
 * This mirrors the pattern used inline in `MatchdayContext.loadCached`.
 */
export function fuzzyTeamMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  if (la.includes(lb) || lb.includes(la)) return true;
  const words = la.split(/\s+/).filter((w) => w.length > 3);
  return words.some((w) => lb.includes(w));
}

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

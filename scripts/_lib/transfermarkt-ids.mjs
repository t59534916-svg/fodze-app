// ═══════════════════════════════════════════════════════════════════════
// FODZE Transfermarkt Team-ID Map
//
// Transfermarkt URL pattern for injuries + suspensions + yellow-card risk:
//   https://www.transfermarkt.de/{slug}/sperrenundverletzungen/verein/{id}
//
// We need both the slug and the numeric ID. The slug is required by the URL
// routing (otherwise Transfermarkt redirects, costing an extra hop), and
// the ID is the stable primary key.
//
// Coverage starts with the three German divisions — those are the highest-
// priority for a German user, have stable TM IDs, and cover the bulk of
// typical FODZE league selections. Add other leagues as needed.
//
// Keys use the FODZE internal team name (what the matchday JSON's
// match.home.name contains after resolveName()). When a team name isn't
// found here, the injury scrape silently skips that team.
// ═══════════════════════════════════════════════════════════════════════

export const TRANSFERMARKT_IDS = {
  // ─── Bundesliga ─────────────────────────────────────────────────────
  "FC Bayern München":              { slug: "fc-bayern-munchen",             id: 27 },
  "Borussia Dortmund":              { slug: "borussia-dortmund",             id: 16 },
  "Bayer 04 Leverkusen":            { slug: "bayer-04-leverkusen",           id: 15 },
  "RB Leipzig":                      { slug: "rasenballsport-leipzig",        id: 23826 },
  "Eintracht Frankfurt":            { slug: "eintracht-frankfurt",           id: 24 },
  "VfB Stuttgart":                  { slug: "vfb-stuttgart",                 id: 79 },
  "SC Freiburg":                    { slug: "sc-freiburg",                   id: 60 },
  "VfL Wolfsburg":                  { slug: "vfl-wolfsburg",                 id: 82 },
  "SV Werder Bremen":               { slug: "sv-werder-bremen",              id: 86 },
  "1. FSV Mainz 05":                { slug: "1-fsv-mainz-05",                id: 39 },
  "TSG Hoffenheim":                 { slug: "tsg-1899-hoffenheim",           id: 533 },
  "FC Augsburg":                    { slug: "fc-augsburg",                   id: 167 },
  "1. FC Köln":                     { slug: "1-fc-koln",                     id: 3 },
  "Borussia Mönchengladbach":       { slug: "borussia-monchengladbach",      id: 18 },
  "1. FC Union Berlin":             { slug: "1-fc-union-berlin",             id: 89 },
  "1. FC Heidenheim":               { slug: "1-fc-heidenheim-1846",          id: 2036 },
  "Hamburger SV":                   { slug: "hamburger-sv",                  id: 41 },
  "FC St. Pauli":                   { slug: "fc-st-pauli",                   id: 35 },
  "Holstein Kiel":                  { slug: "holstein-kiel",                 id: 269 },
  "VfL Bochum":                     { slug: "vfl-bochum",                    id: 80 },
  "SV Darmstadt 98":                { slug: "sv-darmstadt-98",               id: 105 },
  "TSV 1860 München":               { slug: "tsv-1860-munchen",              id: 81 },
  "Hertha BSC":                     { slug: "hertha-bsc",                    id: 44 },
  "1. FC Nürnberg":                 { slug: "1-fc-nurnberg",                 id: 4 },
  "Karlsruher SC":                  { slug: "karlsruher-sc",                 id: 71 },

  // ─── 2. Bundesliga (additional — some already above via promotion) ──
  "Fortuna Düsseldorf":             { slug: "fortuna-dusseldorf",            id: 38 },
  "Hannover 96":                    { slug: "hannover-96",                   id: 42 },
  "FC Schalke 04":                  { slug: "fc-schalke-04",                 id: 33 },
  "1. FC Kaiserslautern":           { slug: "1-fc-kaiserslautern",           id: 2 },
  "Eintracht Braunschweig":         { slug: "eintracht-braunschweig",        id: 85 },
  "SC Paderborn 07":                { slug: "sc-paderborn-07",               id: 127 },
  "SSV Jahn Regensburg":            { slug: "ssv-jahn-regensburg",           id: 2328 },
  "SpVgg Greuther Fürth":           { slug: "spvgg-greuther-furth",          id: 126 },
  "SC Preußen Münster":             { slug: "sc-preussen-munster",           id: 7190 },
  "1. FC Magdeburg":                { slug: "1-fc-magdeburg",                id: 125 },
  "Elversberg":                     { slug: "sv-07-elversberg",              id: 4177 },
  "Hansa Rostock":                  { slug: "fc-hansa-rostock",              id: 49 },

  // ─── 3. Liga ────────────────────────────────────────────────────────
  "Arminia Bielefeld":              { slug: "arminia-bielefeld",             id: 10 },
  "Energie Cottbus":                { slug: "fc-energie-cottbus",            id: 55 },
  "Rot-Weiss Essen":                { slug: "rot-weiss-essen",               id: 6589 },
  "Dynamo Dresden":                 { slug: "sg-dynamo-dresden",             id: 87 },
  "SV Waldhof Mannheim":            { slug: "sv-waldhof-mannheim",           id: 259 },
  "MSV Duisburg":                   { slug: "msv-duisburg",                  id: 112 },
  "Alemannia Aachen":               { slug: "alemannia-aachen",              id: 95 },
  "Viktoria Köln":                  { slug: "viktoria-koln",                 id: 9911 },
  "SV Sandhausen":                  { slug: "sv-sandhausen",                 id: 469 },
  "Hallescher FC":                  { slug: "hallescher-fc",                 id: 1304 },
  "1. FC Saarbrücken":              { slug: "1-fc-saarbrucken",              id: 245 },
  "VfB Lübeck":                     { slug: "vfb-lubeck",                    id: 1011 },
  "TSV Havelse":                    { slug: "tsv-havelse",                   id: 3122 },
  "FC Ingolstadt 04":               { slug: "fc-ingolstadt-04",              id: 2740 },
  "VfL Osnabrück":                  { slug: "vfl-osnabruck",                 id: 100 },
  "SC Verl":                        { slug: "sc-verl",                       id: 9816 },
  "Schweinfurt":                    { slug: "1-fc-schweinfurt-1905",         id: 6439 },
  "SSV Ulm 1846":                   { slug: "ssv-ulm-1846",                  id: 2289 },
  "Erzgebirge Aue":                 { slug: "erzgebirge-aue",                id: 1075 },
  "Wehen Wiesbaden":                { slug: "sv-wehen-wiesbaden",            id: 2787 },
  "Waldhof Mannheim":               { slug: "sv-waldhof-mannheim",           id: 259 },
};

/**
 * Normalise a FODZE team name to match this map's keys. Light touch —
 * just strips common prefixes that drift ("TSG 1899 Hoffenheim" vs
 * "TSG Hoffenheim"). For the tough cases callers should add explicit
 * entries above.
 */
export function resolveTransfermarktRef(teamName) {
  if (!teamName) return null;
  if (TRANSFERMARKT_IDS[teamName]) return TRANSFERMARKT_IDS[teamName];
  // Case-insensitive fallback
  const lower = teamName.toLowerCase();
  for (const [k, v] of Object.entries(TRANSFERMARKT_IDS)) {
    if (k.toLowerCase() === lower) return v;
  }
  // Substring match — "TSG 1899 Hoffenheim" matches "TSG Hoffenheim" etc.
  // Only when one is fully contained in the other to avoid "FC" matching
  // every team.
  const cleaned = teamName.replace(/\b(FC|SC|SV|TSG|VfB|VfL|RB|1\.)\b\s*/g, "").trim().toLowerCase();
  if (cleaned.length >= 4) {
    for (const [k, v] of Object.entries(TRANSFERMARKT_IDS)) {
      const kc = k.replace(/\b(FC|SC|SV|TSG|VfB|VfL|RB|1\.)\b\s*/g, "").trim().toLowerCase();
      if (kc === cleaned || (kc.length >= 4 && (kc.includes(cleaned) || cleaned.includes(kc)))) {
        return v;
      }
    }
  }
  return null;
}

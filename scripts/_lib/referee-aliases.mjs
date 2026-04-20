// ═══════════════════════════════════════════════════════════════════════
// FODZE Referee Name Aliases + Slug
//
// FBref, weltfussball, kicker and OddsPortal render the same referee
// with slightly different conventions:
//   FBref         → "Felix Zwayer"
//   weltfussball  → "Zwayer, Felix"
//   kicker        → "F. Zwayer"
//   OpenLigaDB    → "Felix Zwayer"
//
// slugifyReferee collapses all of these to a stable key ("felix-zwayer")
// that the `referees` table uses as a join key (column `referee_slug`).
//
// REFEREE_ALIASES covers cases where slugify alone is ambiguous (two refs
// with overlapping names, or foreign transliterations). Keep small —
// additions are cheap but untested transformations cause silent misses.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Normalise a referee name to a stable slug.
 *
 *   "Felix Zwayer"          → "felix-zwayer"
 *   "Zwayer, Felix"         → "felix-zwayer"
 *   "F. Zwayer"             → "f-zwayer"          (initial preserved — caller decides)
 *   "José María Sánchez"    → "jose-maria-sanchez"
 *   "  Mike  Dean  "        → "mike-dean"
 */
export function slugifyReferee(name) {
  if (!name) return "";
  let s = String(name).trim();

  // Handle "Last, First" → "First Last"
  if (s.includes(",") && s.split(",").length === 2) {
    const [last, first] = s.split(",").map(x => x.trim());
    s = `${first} ${last}`;
  }

  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[.,'"`´]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Manual aliases: source-name → canonical FBref-style name.
// Only add entries the slugifyReferee couldn't otherwise collapse.
export const REFEREE_ALIASES = {
  // ─── Bundesliga ─────────────────────────────────────────────────────
  "F. Zwayer": "Felix Zwayer",
  "T. Stieler": "Tobias Stieler",
  "D. Siebert": "Daniel Siebert",
  "D. Aytekin": "Deniz Aytekin",
  "S. Jablonski": "Sascha Stegemann",
  "M. Fritz": "Marco Fritz",
  "F. Brych": "Felix Brych",
  "P. Osmers": "Patrick Ittrich",

  // ─── EPL ────────────────────────────────────────────────────────────
  "M. Dean": "Mike Dean",
  "M. Oliver": "Michael Oliver",
  "A. Taylor": "Anthony Taylor",
  "A. Madley": "Andy Madley",
  "C. Pawson": "Craig Pawson",
  "D. Coote": "David Coote",
  "J. Gillett": "Jarred Gillett",
  "P. Tierney": "Paul Tierney",
  "R. Jones": "Robert Jones",
  "S. Attwell": "Stuart Attwell",

  // ─── La Liga / Serie A (German diacritic drops) ────────────────────
  "J. Mateu Lahoz":       "Antonio Mateu Lahoz",
  "J. Sanchez Martinez":  "José Luis Sánchez Martínez",
  "C. del Cerro Grande":  "Carlos del Cerro Grande",
  "D. Orsato":            "Daniele Orsato",
  "M. Guida":             "Marco Guida",
  "M. Mariani":           "Maurizio Mariani",
};

/**
 * Resolve a raw referee name (from any source) → canonical FBref name.
 * If no alias matches, returns the input unchanged (still slugifiable).
 */
export function resolveRefereeName(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  return REFEREE_ALIASES[trimmed] ?? trimmed;
}

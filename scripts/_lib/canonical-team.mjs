// ═══════════════════════════════════════════════════════════════════════
// FODZE — Canonical Team Name Resolver (shared by all backfill scripts)
//
// All scripts that INSERT/UPSERT into team_xg_history must call
// canonicalize(team, league) to map source-specific aliases (footystats
// "Bayern München", goals-proxy "FC Bayern München", shots-model
// "Bayern Munich") to the single canonical name from src/lib/team-resolver.ts.
//
// Without this, the table re-fragments into 30-43 distinct teams per
// league (instead of the real 18-24) every time a new source writes —
// exactly the bug fixed in commit 6ce7162.
//
// The canonical convention matches:
//   - matchdays JSONB (UI source of truth)
//   - bets table (user-facing)
//   - src/lib/team-resolver.ts TEAM_REGISTRY.fodze field
//
// Performance: registry parsing + alias-map build runs ONCE on first call,
// then every canonicalize() lookup is O(1). Safe for use in tight loops.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Normalize a team name for fuzzy comparison: lowercase, strip
 * diacritics (NFD), normalize German alt-spellings (ue/ae/oe → u/a/o),
 * remove non-alphanumerics.
 */
export function normalize(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ue/g, "u")
    .replace(/oe/g, "o")
    .replace(/ae/g, "a")
    .replace(/[^a-z0-9]/g, "");
}

// ─── EXTRA_ALIASES — manual overrides for cases TEAM_REGISTRY misses ──
//
// The TEAM_REGISTRY in src/lib/team-resolver.ts is biased toward Top-5
// leagues. Lower divisions (BL2, Liga3, La Liga 2, Serie B, Greek SL,
// Primeira Liga, Ligue 2, Jupiler Pro) have many teams not yet in the
// registry, and aliases between sources (FootyStats short / OpenLigaDB
// long / shots-model variant) aren't auto-resolved.
//
// Each entry: { league, aliases: ["a", "b", ...], canonical: "X" }
// The canonical name is the form that appears in matchdays JSONB (UI
// source-of-truth, matches bets table convention).
//
// Add new entries here as we discover them. Effective immediately for
// any backfill script using canonicalize() — no Python re-train needed.
//
// Curated 2026-04-27 from forensic audit of remaining duplicates after
// initial dedupe run.
const EXTRA_ALIASES = [
  // ── Bundesliga 2 ──
  { league: "bundesliga2", canonical: "Hertha BSC",
    aliases: ["Hertha Berlin", "Hertha"] },
  { league: "bundesliga2", canonical: "SpVgg Greuther Fürth",
    aliases: ["Greuther Fürth", "Greuther Fuerth", "Greuther Furth"] },
  { league: "bundesliga2", canonical: "SC Paderborn 07",
    aliases: ["SC Paderborn", "Paderborn"] },
  { league: "bundesliga2", canonical: "DSC Arminia Bielefeld",
    aliases: ["Arminia Bielefeld", "Bielefeld"] },
  { league: "bundesliga2", canonical: "SV 07 Elversberg",
    aliases: ["Elversberg", "SV Elversberg"] },

  // ── Liga 3 ──
  { league: "liga3", canonical: "1. FC Schweinfurt 05",
    aliases: ["Schweinfurt", "FC Schweinfurt", "Schweinfurt 05"] },
  { league: "liga3", canonical: "TSG 1899 Hoffenheim II",
    aliases: ["TSG Hoffenheim II", "Hoffenheim II"] },
  { league: "liga3", canonical: "SV Wehen Wiesbaden",
    aliases: ["Wehen Wiesbaden", "Wehen"] },
  { league: "liga3", canonical: "FC Viktoria Köln",
    aliases: ["Viktoria Köln", "Viktoria Koln", "Viktoria Cologne"] },

  // ── Greek SL ──
  { league: "greek_sl", canonical: "Larissa",
    aliases: ["Larisa", "AE Larissa"] },
  { league: "greek_sl", canonical: "Panaitolikos",
    aliases: ["Panetolikos"] },

  // ── Jupiler Pro ──
  { league: "jupiler_pro", canonical: "OH Leuven",
    aliases: ["Leuven", "Oud-Heverlee Leuven"] },

  // ── La Liga 2 ──
  { league: "la_liga2", canonical: "Cultural y Deportiva Leonesa",
    aliases: ["Cultural Leonesa", "Cultural Leonesa SAD"] },
  { league: "la_liga2", canonical: "Real Sociedad II",
    aliases: ["Real Sociedad B", "Sociedad B"] },
  { league: "la_liga2", canonical: "FC Andorra",
    aliases: ["Andorra CF", "Andorra"] },

  // ── League Two ──
  { league: "league_two", canonical: "Bristol Rovers",
    aliases: ["Bristol Rvs", "Bristol R"] },

  // ── Ligue 1 ──
  { league: "ligue_1", canonical: "Paris Saint Germain",
    aliases: ["PSG", "Paris SG", "Paris S.G.", "Paris-SG"] },

  // ── Ligue 2 ──
  { league: "ligue_2", canonical: "Saint Etienne",
    aliases: ["St Etienne", "St. Etienne", "AS Saint-Etienne"] },

  // ── Primeira Liga ──
  { league: "primeira_liga", canonical: "Moreirense FC",
    aliases: ["Moreirense"] },
  { league: "primeira_liga", canonical: "Rio Ave FC",
    aliases: ["Rio Ave"] },
  { league: "primeira_liga", canonical: "SC Braga",
    aliases: ["Braga", "Sporting Braga", "Sp Braga"] },
  { league: "primeira_liga", canonical: "Sporting CP",
    aliases: ["Sporting Lisbon", "Sporting", "Sporting Lissabon"] },

  // ── Serie B ──
  { league: "serie_b", canonical: "Bari 1908",
    aliases: ["Bari", "AS Bari", "FC Bari"] },

  // ── Austria Bundesliga ──
  { league: "austria_bl", canonical: "Wattens",
    aliases: ["WSG Tirol", "WSG Wattens"] },
];

// ─── Registry loader (cached) ───────────────────────────────────────

let _aliasMapCache = null;

function loadAliasMap() {
  if (_aliasMapCache) return _aliasMapCache;

  const tsPath = resolve(REPO_ROOT, "src/lib/team-resolver.ts");
  if (!existsSync(tsPath)) {
    console.warn(`[canonical-team] TEAM_REGISTRY not found at ${tsPath} — canonicalize is a no-op`);
    _aliasMapCache = new Map();
    return _aliasMapCache;
  }

  const src = readFileSync(tsPath, "utf-8");
  // Match each TEAM_REGISTRY entry. Tolerant of optional fields.
  // Pattern: { fodze: "X", csv: "Y", understat: "Z", oddsApi: "W", league: "L" },
  const re = /\{\s*fodze:\s*"([^"]+)",\s*csv:\s*"([^"]+)"(?:,\s*understat:\s*"([^"]*)")?(?:,\s*oddsApi:\s*"([^"]*)")?(?:,\s*league:\s*"([^"]+)")?\s*\},?/g;

  const aliasMap = new Map(); // league → Map<normAlias, canonical>
  let m;
  while ((m = re.exec(src)) !== null) {
    const fodze = m[1];
    const aliases = [m[2], m[3], m[4]].filter(Boolean);  // csv, understat, oddsApi
    const league = m[5];
    if (!league) continue;
    if (!aliasMap.has(league)) aliasMap.set(league, new Map());
    const lm = aliasMap.get(league);
    // Self-mapping: canonical normalized → canonical (so canonicalize() is idempotent)
    lm.set(normalize(fodze), fodze);
    for (const alias of aliases) {
      lm.set(normalize(alias), fodze);
    }
  }

  // Apply EXTRA_ALIASES — manual overrides for cases TEAM_REGISTRY missed.
  // These take precedence (overwrite registry entries if same normAlias).
  for (const e of EXTRA_ALIASES) {
    if (!aliasMap.has(e.league)) aliasMap.set(e.league, new Map());
    const lm = aliasMap.get(e.league);
    lm.set(normalize(e.canonical), e.canonical);
    for (const alias of e.aliases) {
      lm.set(normalize(alias), e.canonical);
    }
  }

  _aliasMapCache = aliasMap;
  return aliasMap;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Map a possibly-aliased team-name to its canonical form for the league.
 * Returns the input unchanged if no canonical is known (new teams not yet
 * in TEAM_REGISTRY — caller should add to registry, but as-is is safer
 * than guessing).
 *
 * @param {string} team - The team name as written by the source
 * @param {string} league - FODZE league key (bundesliga, epl, etc.)
 * @returns {string} The canonical FODZE team name
 *
 * @example
 *   canonicalize("Bayern München", "bundesliga")        // → "FC Bayern München"
 *   canonicalize("Bayern Munich", "bundesliga")         // → "FC Bayern München"
 *   canonicalize("FC Bayern München", "bundesliga")     // → "FC Bayern München" (idempotent)
 *   canonicalize("Some New Team", "bundesliga")         // → "Some New Team" (unchanged)
 */
export function canonicalize(team, league) {
  if (!team || !league) return team;
  const aliasMap = loadAliasMap();
  const lm = aliasMap.get(league);
  if (!lm) return team;
  const normT = normalize(team);
  // Tier-1: exact normalized match
  if (lm.has(normT)) return lm.get(normT);
  // Tier-2: substring match (length-guarded ≥ 5 chars to avoid false matches)
  for (const [normAlias, canonical] of lm.entries()) {
    if (normAlias.length < 5) continue;
    if (normT.includes(normAlias) || normAlias.includes(normT)) {
      return canonical;
    }
  }
  return team;  // unchanged — caller can decide to skip or log
}

/**
 * For diagnostics: returns true if a team-name is already canonical
 * (i.e., its canonicalize() output is itself).
 */
export function isCanonical(team, league) {
  return canonicalize(team, league) === team;
}

/**
 * For tests: clears the cached alias map so re-runs see fresh registry.
 */
export function _resetCache() {
  _aliasMapCache = null;
}

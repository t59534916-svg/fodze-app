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

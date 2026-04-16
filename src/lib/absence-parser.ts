// ═══════════════════════════════════════════════════════════════════════
// FODZE Absence Parser — bridges free-text matchday injury strings to the
// structured PlayerProfile[] inputs expected by calcAbsenceImpact.
//
// The enrichment scripts + admin workflow produce strings like:
//   "Fujita (MF, 5. Gelbe Karte Sperre), Sands (MF, Knöchel-OP, Saison-Aus)"
//
// We parse them into player profiles using German position hints and
// default xG-share heuristics. The prediction engines then apply
// calcAbsenceImpact to scale lambdas.
//
// Skip logic: entries without a clear injury reason (empty, dashes) are
// treated as "no data" rather than "no injuries". This is the honest
// behavior — we don't know if the team is fully fit; we know we don't know.
// ═══════════════════════════════════════════════════════════════════════

import { defaultPlayerProfile, type PlayerProfile } from "./player-impact";

// Map German position tags in matchday text to canonical position codes.
// Add synonyms as we encounter them — CSV format is not strict.
const POSITION_MAP: Record<string, string> = {
  tw: "GK",
  tor: "GK",
  iv: "DEF",
  abw: "DEF",
  rv: "DEF",
  lv: "DEF",
  def: "DEF",
  mf: "MID",
  zm: "MID",
  om: "MID",
  dm: "MID",
  mid: "MID",
  st: "FWD",
  fwd: "FWD",
  angriff: "FWD",
};

// Words in the reason text that should NOT produce an absence entry —
// e.g. "zurück im Training" means the player is recovering, not out.
const EXCLUDE_REASON_RE = /\b(zurück|zurueck|fit|available|comeback)\b/i;

/**
 * Parse an injuries string into a list of PlayerProfile entries.
 *
 * Input format (loose): `"Name (Pos, Reason), Name2 (Pos, Reason)"`
 *   - Parentheses optional
 *   - Position hint (TW/IV/MF/ST) maps to GK/DEF/MID/FWD
 *   - Reason free-text; if it contains a "zurück"-ish word we skip
 *
 * Every parsed player is marked `isKeyPlayer: true` because people don't
 * bother mentioning rotation players in matchday reports — the listed
 * names are the ones that materially impact the match.
 */
export function parseAbsences(raw: string | undefined | null, team: string): PlayerProfile[] {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed === "—") return [];

  const entries: PlayerProfile[] = [];
  // Split on commas that are NOT inside parentheses.
  // We don't use a regex splitter because positions can contain "3+" etc.
  // Instead, walk the string tracking paren depth.
  const chunks: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      chunks.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (const chunk of chunks) {
    if (!chunk) continue;

    // Extract name + optional "(Pos, Reason)" block
    const m = chunk.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);
    let name: string;
    let meta: string;
    if (m) {
      name = m[1].trim();
      meta = m[2].trim();
    } else {
      // No parens — treat the whole chunk as the name, with no metadata
      name = chunk.trim();
      meta = "";
    }

    if (!name) continue;
    if (EXCLUDE_REASON_RE.test(meta)) continue;

    // First comma-separated token in meta is the position hint
    const posHint = (meta.split(",")[0] || "").trim().toLowerCase();
    const position = POSITION_MAP[posHint] || "MID"; // default to MID — most common

    entries.push(defaultPlayerProfile(name, team, position, true));
  }

  return entries;
}

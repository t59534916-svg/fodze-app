// ═══════════════════════════════════════════════════════════════════════
// FODZE xG-History Bucket Resolver
//
// Mirrors the fuzzy-matching logic in loadTeamXGHistory (supabase.ts) but
// operates on an already-loaded batch of xG matches keyed by
// "team|venue". Used by MatchdayContext.loadCached to attach per-match
// xG history to fixtures without N round-trips to Supabase.
//
// Resolution order (identical to loadTeamXGHistory so the "first 8 with
// xG" list a user sees in the App matches what the engine calcs use):
//
//   1. exact key lookup on the Understat name from TEAM_SCRAPER_MAP
//      (falls back to the raw team name if unmapped)
//   2. substring match on the longest distinctive token of the team
//      name — picks the first matching bucket with the same venue
//
// "Distinctive token" filters out common club suffixes (fc, sc, sv,
// vfl, vfb, tsg, tsv, rb, afc, the, club) and tokens shorter than 4
// chars, so "FC Bayern München" probes with "bayern" (or "münchen" if
// it's the longer token on the Understat side).
// ═══════════════════════════════════════════════════════════════════════

import type { TeamXGMatch } from "@/lib/supabase";
import { TEAM_SCRAPER_MAP } from "@/lib/scrapers/team-map";

export type Venue = "home" | "away";

// Tokens we never treat as distinctive — too many clubs share them, so
// they would produce false-positive substring hits. Kept tiny on
// purpose; any team whose NAME is only these tokens will return empty
// history (correct: we don't know who they are).
const STOP_TOKENS = new Set([
  "fc", "sc", "sv", "vfl", "vfb", "tsg", "tsv", "rb", "afc", "the", "club",
]);

export function extractProbeToken(team: string): string | null {
  const tokens = team
    .toLowerCase()
    .replace(/[._]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_TOKENS.has(w));
  if (tokens.length === 0) return null;
  return tokens.sort((a, b) => b.length - a.length)[0];
}

/**
 * Resolve a (team, venue) pair to the list of xG matches from the
 * pre-loaded league bucket. Returns [] when nothing matches — callers
 * decide whether to fall back to league-average synthesis.
 *
 * @param byTeamVenue Map keyed by "Understat team name|venue". Each
 *   value is the pre-sliced last-8 chronological-ascending list that
 *   loadCached builds once per league load.
 * @param team The FODZE-canonical team name from the matchday JSON.
 * @param venue "home" or "away".
 */
export function resolveBucket(
  byTeamVenue: Map<string, TeamXGMatch[]>,
  team: string,
  venue: Venue,
): TeamXGMatch[] {
  const mapped = TEAM_SCRAPER_MAP[team];
  const understat = mapped?.understat || team;
  const exact = byTeamVenue.get(`${understat}|${venue}`);
  if (exact && exact.length > 0) return exact;

  const probe = extractProbeToken(team);
  if (!probe) return [];

  for (const [k, arr] of byTeamVenue) {
    const [t, v] = k.split("|");
    if (v === venue && t.toLowerCase().includes(probe)) return arr;
  }
  return [];
}

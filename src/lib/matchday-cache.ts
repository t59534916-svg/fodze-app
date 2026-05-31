// ═══════════════════════════════════════════════════════════════════════
// Matchday engine-cache keys — pure, testable extraction of the cache-
// correctness logic from MatchdayContext.
//
// WHY THIS EXISTS
// MatchdayContext computes all engines per match and caches the result in a
// Map. Two keys guard that cache:
//
//   1. engineCacheKey(home, away, odds) — per-MATCH identity. Includes team
//      NAMES (not the array index) because a server-side matchday refresh with
//      the same match count but a different sort order would otherwise serve
//      ANOTHER match's cached result under the same idx. Includes the odds so
//      editing one match's odds invalidates only that match.
//
//   2. engineCacheVersionKey(...) — GLOBAL invalidation. When league / league-
//      constants / Kelly fraction / calibration-loaded / filter-shield-loaded /
//      SoS / player-xg / league-Kelly-multiplier / the match-set changes, the
//      whole cache must clear. Missing a field here = serving stale engine
//      output forever for already-loaded matches (the exact race fixed for
//      filterShieldLoaded on 2026-05-22).
//
// This is the same "don't serve the wrong cached result" guarantee whose
// absence caused the dev-03 stale-pairing bug — so it's locked by tests rather
// than living untested inside an 1000-LOC React context.
// ═══════════════════════════════════════════════════════════════════════

/** Per-match cache key. Team names + serialized odds — NOT the array index,
 *  so a re-sorted matchday of the same length can't alias another match. */
export function engineCacheKey(
  homeName: string | undefined,
  awayName: string | undefined,
  odds: Record<string, unknown> | undefined,
): string {
  return `${homeName}|${awayName}|${JSON.stringify(odds || {})}`;
}

/** Inputs that, when changed, must invalidate the WHOLE engine cache. */
export interface CacheVersionInputs {
  league: string;
  leagueAvg: number;
  homeFactor: number;
  fraction: number;
  calLoaded: boolean;
  filterShieldLoaded: boolean;
  /** Number of teams in the SoS rating table, or null when not loaded. Uses
   *  count (not a presence flag) so content changes — e.g. league switch
   *  swapping the team set — also invalidate. */
  sosTeamCount: number | null;
  /** Size of the per-league player-xg index; grows after async hydration. */
  playerXgSize: number;
  /** Per-league CLV-feedback Kelly multiplier (flips on bet settlement). */
  leagueKellyMultiplier: number;
  /** Ordered "home:away" pairs — captures match set AND order. */
  matchIds: string[];
}

/** Build the global cache-version key. Any field change yields a new string,
 *  forcing the cache to clear on the next render. */
export function engineCacheVersionKey(v: CacheVersionInputs): string {
  const sosKey = v.sosTeamCount != null ? `sos${v.sosTeamCount}` : "sos0";
  return [
    v.league, v.leagueAvg, v.homeFactor, v.fraction,
    v.calLoaded, v.filterShieldLoaded, sosKey,
    `pxg${v.playerXgSize}`, `lkm${v.leagueKellyMultiplier}`,
    v.matchIds.join(","),
  ].join("|");
}

/** Derive the favoured 1X2 side from a market-probability triple. Ties break
 *  H > A > X (home-advantage prior), matching the inline convictionPicks /
 *  display logic. Pure so the selection display is testable. */
export function favouredSide(mk: { H: number; D: number; A: number }): "1" | "X" | "2" {
  return mk.H >= mk.D && mk.H >= mk.A ? "1" : mk.A >= mk.D ? "2" : "X";
}

/** Parse a raw odds record into a numeric map, keeping only positive quotes
 *  for the recognised markets. Mirrors the inline `no` builder. */
export function parseOddsMap(odds: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!odds) return out;
  for (const k of ["h", "d", "a", "o25", "u25", "btts"]) {
    const v = parseFloat(String(odds[k] ?? ""));
    if (v > 0) out[k] = v;
  }
  return out;
}

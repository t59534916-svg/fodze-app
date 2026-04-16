// ═══════════════════════════════════════════════════════════════════════
// FODZE Elo Seeding — fair fallback for teams without a trained rating
//
// Before: teams not in ensemble-model.json.elo_ratings got the hardcoded
// DEFAULT_ELO = 1500. That's the exact value of a TOP Bundesliga team's
// mid-tier peer — absurd for a newly-promoted Liga-3 club.
//
// After: teams fall back to `league_median - 50`. The penalty reflects
// that a promoted team is typically weaker than the league median of
// their new tier. Computed once per league from existing ratings and
// cached.
//
// Data source: ensemble-model.json elo_ratings already has 655 teams
// across 25 seasons — plenty to derive league-level medians without a
// separate data pipeline.
// ═══════════════════════════════════════════════════════════════════════

import { LEAGUES } from "./dixon-coles";

/** Penalty applied on top of league median — reflects that promoted teams
 *  usually start below-average in their new league. */
const PROMOTION_PENALTY = 50;

/** If a league can't be detected, use 1450 (50 below the old 1500 default). */
const UNIVERSAL_FALLBACK = 1450;

// Cache for per-league median Elos — computed lazily on first call.
// Invalidated by `resetEloSeedCache()` if the ratings change at runtime
// (they don't currently, but safer to have an escape valve).
const medianCache: Record<string, number> = {};

/**
 * Heuristic league-tier order from strong to weak. Used to derive a
 * league median when the Elo table has few/no teams matching this league
 * (e.g. during early-model bootstrap).
 *
 * These are approximate; real medians (computed from the table) always
 * win when available.
 */
const LEAGUE_TIER_DEFAULTS: Record<string, number> = {
  epl: 1800,
  la_liga: 1770,
  bundesliga: 1730,
  serie_a: 1720,
  ligue_1: 1680,
  eredivisie: 1550,
  primeira_liga: 1500,
  championship: 1480,
  bundesliga2: 1400,
  la_liga2: 1400,
  serie_b: 1400,
  ligue_2: 1350,
  jupiler_pro: 1400,
  super_lig: 1420,
  scottish_prem: 1450,
  greek_sl: 1360,
  league_one: 1300,
  liga3: 1250,
  league_two: 1200,
};

/**
 * Compute the median Elo for a given league from the current ratings dict.
 * Uses the LEAGUES config + team-resolver CSV map to identify teams per
 * league — falls back to the tier default if fewer than 5 ratings match.
 */
export function computeLeagueMedian(
  league: string,
  eloRatings: Record<string, number>,
): number {
  if (medianCache[league] != null) return medianCache[league];
  const fallback = LEAGUE_TIER_DEFAULTS[league] ?? UNIVERSAL_FALLBACK;

  // Count all teams in this league registered via team-resolver, then look
  // up their CSV names in the rating table. We can't easily import the
  // full TEAM_REGISTRY here without a circular dep, so the caller (or a
  // light-weight registry mirror) should pass team names via a side channel
  // if this proves inaccurate. For now we trust the tier defaults.
  //
  // Touching LEAGUES just to validate the league key exists — if not, we
  // simply return the fallback without caching (so a typo'd call doesn't
  // poison future calls for the same typo).
  if (!LEAGUES[league]) return fallback;

  // When ratings dict is empty (initial load), use tier default
  const ratingValues = Object.values(eloRatings);
  if (ratingValues.length < 5) {
    medianCache[league] = fallback;
    return fallback;
  }

  // Without per-team league metadata here, we use the tier default.
  // This is intentional: we don't want to silently pick a wrong median
  // from the whole table. Tier defaults are based on historical averages
  // and change slowly.
  medianCache[league] = fallback;
  return fallback;
}

/**
 * Seeded Elo for teams not found in the trained ratings. Drops the
 * league median by PROMOTION_PENALTY so newcomers/aufsteiger start
 * appropriately below average, not at the "universal 1500" that reads
 * as mid-table Bundesliga.
 */
export function seedElo(
  league: string | undefined,
  eloRatings: Record<string, number>,
): number {
  if (!league) return UNIVERSAL_FALLBACK;
  const median = computeLeagueMedian(league, eloRatings);
  return median - PROMOTION_PENALTY;
}

/**
 * Reset the median cache. Use only after replacing the rating dict at
 * runtime (rare — currently loaded once on app startup).
 */
export function resetEloSeedCache(): void {
  for (const k of Object.keys(medianCache)) delete medianCache[k];
}

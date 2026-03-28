// ═══════════════════════════════════════════════════════════════════════
// FODZE Strength of Schedule (SoS) — Iterative Rating Algorithm
//
// Problem: 10.0 xG against Top-3 defenses ≠ 10.0 xG against relegation teams.
// Solution: Elo-like iterative algorithm that adjusts xG by opponent quality.
//
// Algorithm converges in ~5-8 iterations. After convergence:
// - attackRating > 1.0 = above-average attack
// - defenseRating > 1.0 = concedes more than average (bad defense)
// - sosAttack = avg defensive quality of opponents faced
// ═══════════════════════════════════════════════════════════════════════

export interface SoSRatings {
  [team: string]: {
    attackRating: number;    // >1.0 = strong attack (relative to league avg)
    defenseRating: number;   // >1.0 = weak defense (concedes more)
    sosAttack: number;       // avg defensive rating of opponents faced
    sosDefense: number;      // avg attacking rating of opponents faced
    rawXgPg: number;         // original unadjusted xG per game
    rawXgaPg: number;        // original unadjusted xGA per game
    adjustedXgPg: number;    // SoS-adjusted xG per game
    adjustedXgaPg: number;   // SoS-adjusted xGA per game
    games: number;
  };
}

export interface SoSMatch {
  team: string;
  opponent: string;
  xg: number;
  xga: number;
}

/**
 * Compute Strength of Schedule ratings for all teams in a league.
 *
 * @param matches - Array of match-level xG data (one entry per team per match)
 * @param leagueAvg - League average goals/xG per game (from LEAGUES config)
 * @param iterations - Number of convergence iterations (default 10)
 * @returns SoSRatings object keyed by team name
 */
export function computeSoSRatings(
  matches: SoSMatch[],
  leagueAvg: number,
  iterations: number = 10
): SoSRatings {
  // Collect unique teams
  const teams = Array.from(new Set(matches.map((m) => m.team)));
  if (teams.length === 0) return {};

  // Initialize all ratings at 1.0
  const ratings: SoSRatings = {};
  for (const t of teams) {
    const teamMatches = matches.filter((m) => m.team === t);
    const games = teamMatches.length;
    const rawXgPg = games > 0 ? teamMatches.reduce((s, m) => s + m.xg, 0) / games : leagueAvg;
    const rawXgaPg = games > 0 ? teamMatches.reduce((s, m) => s + m.xga, 0) / games : leagueAvg;
    ratings[t] = {
      attackRating: 1.0,
      defenseRating: 1.0,
      sosAttack: 1.0,
      sosDefense: 1.0,
      rawXgPg,
      rawXgaPg,
      adjustedXgPg: rawXgPg,
      adjustedXgaPg: rawXgaPg,
      games,
    };
  }

  // Group matches by team for efficiency
  const matchesByTeam: Record<string, SoSMatch[]> = {};
  for (const t of teams) {
    matchesByTeam[t] = matches.filter((m) => m.team === t);
  }

  // Iterative convergence
  for (let iter = 0; iter < iterations; iter++) {
    const nextRatings: Record<string, {
      attackRating: number; defenseRating: number;
      sosAttack: number; sosDefense: number;
      adjustedXgPg: number; adjustedXgaPg: number;
    }> = {};

    let sumAtk = 0;
    let sumDef = 0;
    let count = 0;

    for (const team of teams) {
      const teamMatches = matchesByTeam[team];
      if (teamMatches.length === 0) continue;

      let sumAdjXg = 0;
      let sumAdjXga = 0;
      let oppDefSum = 0;
      let oppAtkSum = 0;

      for (const m of teamMatches) {
        const oppDefRating = ratings[m.opponent]?.defenseRating || 1.0;
        const oppAtkRating = ratings[m.opponent]?.attackRating || 1.0;

        // Key insight: If opponent has defenseRating > 1.0 (bad defense),
        // the team's xG against them is deflated (worth less).
        // If opponent has defenseRating < 1.0 (good defense),
        // the team's xG is inflated (worth more).
        sumAdjXg += m.xg * (leagueAvg / Math.max(0.3, oppDefRating));
        sumAdjXga += m.xga * (leagueAvg / Math.max(0.3, oppAtkRating));
        oppDefSum += oppDefRating;
        oppAtkSum += oppAtkRating;
      }

      const n = teamMatches.length;
      const adjXgPg = sumAdjXg / n;
      const adjXgaPg = sumAdjXga / n;

      nextRatings[team] = {
        attackRating: adjXgPg / leagueAvg,
        defenseRating: adjXgaPg / leagueAvg,
        sosAttack: oppDefSum / n,
        sosDefense: oppAtkSum / n,
        adjustedXgPg: adjXgPg,
        adjustedXgaPg: adjXgaPg,
      };

      sumAtk += nextRatings[team].attackRating;
      sumDef += nextRatings[team].defenseRating;
      count++;
    }

    // Renormalize so league mean = 1.0
    const meanAtk = count > 0 ? sumAtk / count : 1.0;
    const meanDef = count > 0 ? sumDef / count : 1.0;

    for (const team of teams) {
      if (!nextRatings[team]) continue;
      nextRatings[team].attackRating /= meanAtk || 1;
      nextRatings[team].defenseRating /= meanDef || 1;

      // Update ratings for next iteration
      ratings[team].attackRating = nextRatings[team].attackRating;
      ratings[team].defenseRating = nextRatings[team].defenseRating;
      ratings[team].sosAttack = nextRatings[team].sosAttack;
      ratings[team].sosDefense = nextRatings[team].sosDefense;
      ratings[team].adjustedXgPg = nextRatings[team].adjustedXgPg;
      ratings[team].adjustedXgaPg = nextRatings[team].adjustedXgaPg;
    }
  }

  return ratings;
}

/**
 * Apply SoS adjustment to a team's xG per game values.
 * Used in the engine's lambda calculation pipeline.
 *
 * @param xgPg - Raw xG per game for the team
 * @param xgaPg - Raw xGA per game for the team
 * @param teamSoS - The team's SoS ratings
 * @param leagueAvg - League average
 * @returns Adjusted { xgPg, xgaPg }
 */
export function applySoSAdjustment(
  xgPg: number,
  xgaPg: number,
  teamSoS: SoSRatings[string] | undefined,
  leagueAvg: number
): { xgPg: number; xgaPg: number } {
  if (!teamSoS) return { xgPg, xgaPg };

  return {
    xgPg: xgPg * (leagueAvg / Math.max(0.3, teamSoS.sosAttack)),
    xgaPg: xgaPg * (leagueAvg / Math.max(0.3, teamSoS.sosDefense)),
  };
}

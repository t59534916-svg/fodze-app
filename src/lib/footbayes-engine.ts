// ═══════════════════════════════════════════════════════════════════════
// FODZE footBayes Engine — Hierarchical Bayesian Poisson with Partial Pooling
//
// Browser-side runtime for the posterior means produced nightly by
// services/footbayes/fit_daily.R (Stan + footBayes v2.1). The R job
// writes public/footbayes-posteriors.json; we load it once on startup
// and use the per-team attack/defense means + per-league intercept +
// home_advantage to compute λH, λA per match.
//
// Math (standard footBayes biv_pois_dynamic parameterisation):
//   log λ_H = intercept_league + home_advantage_league + attack_home - defense_away
//   log λ_A = intercept_league                        + attack_away - defense_home
//
// The hierarchical partial-pooling is entirely in the UPSTREAM fit —
// at runtime we just lookup per-team posterior means. That's the whole
// point: Stan does the shrinkage, the browser stays fast and stateless.
//
// Missing-data behaviour:
//   - Posteriors not loaded → return null (MatchdayContext falls back
//     to Ensemble for this match)
//   - Team missing in posteriors → null (newly-promoted team mid-season)
//   - League missing → null (shouldn't happen; we fit every FODZE league)
//
// Use cases where footBayes shines (per Egidi/Palaskas/Torelli 2025):
//   - Lower-tier leagues (Liga 3, League Two, Greek SL) with sparse data
//     — partial pooling toward league mean delivers 0.005–0.015 Brier gain
//   - End-of-season predictions when recent form matters most
// ═══════════════════════════════════════════════════════════════════════

export interface FootBayesTeamPosterior {
  attack_mean: number;
  attack_sd?: number;      // optional — stored for future uncertainty display
  defense_mean: number;
  defense_sd?: number;
  league: string;
}

export interface FootBayesLeaguePosterior {
  intercept: number;           // log-scale goals intercept
  home_advantage: number;      // log-scale home bump
  n_matches?: number;
}

export interface FootBayesPosteriors {
  _version: 1;
  _meta?: { method?: string; trained_at?: string | null; model_package?: string };
  leagues: Record<string, FootBayesLeaguePosterior>;
  teams: Record<string, FootBayesTeamPosterior>;
}

// ─── Module state ──────────────────────────────────────────────────

let POSTERIORS: FootBayesPosteriors | null = null;

export function loadFootBayesPosteriors(json: FootBayesPosteriors): void {
  if (!json || json._version !== 1 || !json.leagues || !json.teams) {
    throw new Error("Invalid footbayes-posteriors schema (need _version=1, leagues, teams)");
  }
  POSTERIORS = json;
}

export function isFootBayesLoaded(): boolean {
  return POSTERIORS !== null && Object.keys(POSTERIORS.teams).length > 0;
}

export function resetFootBayesPosteriors(): void {
  POSTERIORS = null;
}

// ─── Runtime API ────────────────────────────────────────────────────

export interface FootBayesInput {
  homeTeam: string;
  awayTeam: string;
  league: string;
}

export interface FootBayesLambdas {
  lambdaH: number;
  lambdaA: number;
  source: "footbayes";
}

/**
 * Look up hierarchical posterior means for both teams in a given league
 * and return the two expected-goal rates. Returns null when any part of
 * the lookup fails so the caller can fall back to Ensemble cleanly.
 *
 * LambdaH/LambdaA are CLAMPED to the same [0.1, 5.0] range the other
 * engines use (src/lib/poisson-ml-engine-v2.ts line 206-212) — out-of-
 * distribution posterior draws shouldn't produce wild engine output.
 */
export function calcMatchFootBayesLambdas(input: FootBayesInput): FootBayesLambdas | null {
  if (!POSTERIORS) return null;
  const league = POSTERIORS.leagues[input.league];
  if (!league) return null;
  const home = POSTERIORS.teams[input.homeTeam];
  const away = POSTERIORS.teams[input.awayTeam];
  if (!home || !away) return null;

  // log-linear additive form from footBayes/Stan.
  const logLH = league.intercept + league.home_advantage + home.attack_mean - away.defense_mean;
  const logLA = league.intercept                          + away.attack_mean - home.defense_mean;

  // Clamp — same tail guard as v2's lambda clipping.
  const clamp = (x: number) => Math.max(0.1, Math.min(5.0, Math.exp(x)));
  return {
    lambdaH: clamp(logLH),
    lambdaA: clamp(logLA),
    source: "footbayes",
  };
}

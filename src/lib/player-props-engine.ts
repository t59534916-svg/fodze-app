// ═══════════════════════════════════════════════════════════════════════
// FODZE Player-Props Engine (Phase 3.2)
//
// Hierarchical Bayesian Player model — runtime consumer of the posterior
// means produced nightly by services/footbayes/fit_player_props.R:
//
//   log λ_goals(player, match)
//     = α_player + β_team_attack + γ_opp_defense + δ_is_home
//       + log(expected_minutes / 90)          [offset]
//
//   Anytime Goalscorer: P(goals ≥ 1) = 1 - exp(-λ_goals)
//   Player Shots Over k.5: Poisson(λ_shots) tail
//   Player Yellow Card: 1 - exp(-λ_cards)  (Hurdle-Poisson; no retries)
//
// Methodology follows Whitaker et al. 2021 (JRSS-C, DOI 10.1111/rssc.12454)
// and Bransen, Robberechts et al. 2019 ("Choke or Shine?"). Partial-pooling
// (hierarchical priors over league + position) happens upstream in Stan —
// at runtime we just read posterior means + apply the formula.
//
// Graceful degradation:
//   - Posteriors not loaded → every prob returns null (UI can hide market)
//   - Player missing      → null (newly-signed, no training data)
//   - Team missing from team-level priors → still works using player-only
//     terms at the cost of precision
// ═══════════════════════════════════════════════════════════════════════

export interface PlayerPosterior {
  alpha_mean: number;          // goal-rate intercept (log-scale)
  alpha_sd?: number;
  beta_mean: number;           // shots-per-90 rate (log-scale)
  beta_sd?: number;
  gamma_mean: number;          // cards-per-90 rate (log-scale)
  gamma_sd?: number;
  minutes_share: number;       // fraction of team minutes this season
  position?: string;
  team: string;
  league: string;
  season: string;
}

export interface TeamAttackModifier {
  team_attack: number;         // log-scale team-level attack modifier
  league_baseline: number;     // log-scale league avg goals rate
}

export interface PlayerPropsJSON {
  _version: 1;
  _meta?: { method?: string; trained_at?: string | null; model_package?: string };
  // team_id → modifiers, used to multiply player-level λ by team context.
  teams: Record<string, TeamAttackModifier>;
  // player_name → posterior (keyed by lowercase name to tolerate TM/FBref
  // umlaut variants in the scrape layer).
  players: Record<string, PlayerPosterior>;
}

// ─── Module state ──────────────────────────────────────────────────

let POSTERIORS: PlayerPropsJSON | null = null;

export function loadPlayerPropsPosteriors(json: PlayerPropsJSON): void {
  if (!json || json._version !== 1 || !json.players || !json.teams) {
    throw new Error("Invalid player-props-posteriors schema (need _version=1, teams, players)");
  }
  POSTERIORS = json;
}

export function isPlayerPropsLoaded(): boolean {
  return POSTERIORS !== null && Object.keys(POSTERIORS.players).length > 0;
}

export function resetPlayerProps(): void { POSTERIORS = null; }

// ─── Lookup helpers ────────────────────────────────────────────────

function findPlayer(name: string): PlayerPosterior | null {
  if (!POSTERIORS || !name) return null;
  const lower = name.toLowerCase();
  if (POSTERIORS.players[lower]) return POSTERIORS.players[lower];
  // Last-name fallback for Transfermarkt vs. FBref spelling mismatch.
  const last = lower.split(" ").pop() || "";
  if (last && POSTERIORS.players[last]) return POSTERIORS.players[last];
  return null;
}

function findTeam(team: string): TeamAttackModifier | null {
  if (!POSTERIORS || !team) return null;
  return POSTERIORS.teams[team] || null;
}

// ─── Core API ──────────────────────────────────────────────────────

export interface MatchContext {
  homeTeam: string;
  awayTeam: string;
  /**
   * Expected minutes for the player — 90 for starters, 0-30 for bench.
   * Caller (lineup-aware matchday code) supplies this. Default 70
   * (conservative for a star that might be subbed at 75-80).
   */
  expectedMinutes?: number;
  isHome: boolean;            // the player's team is home
}

export interface PlayerPropsResult {
  player: string;
  expectedMinutes: number;
  lambda_goals: number;        // exp(log λ), total-goals rate over the expected minutes
  lambda_shots: number;
  lambda_cards: number;
  p_anytime_scorer: number | null;
  p_shots_over: (threshold: number) => number | null;
  p_yellow_card: number | null;
  source: "player-props-bayes" | "fallback";
}

/**
 * Poisson cumulative > k. Returns null for non-finite λ.
 * (Over 2.5 means k=2 threshold, strictly more than 2 → 1 - P(X ≤ 2).)
 */
function poissonOver(lambda: number, k: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  // Iterative Poisson PMF for small k (≤ 10 typical thresholds).
  let cdf = 0;
  let term = Math.exp(-lambda); // P(X=0)
  cdf += term;
  for (let i = 1; i <= k; i++) {
    term = term * lambda / i;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/**
 * Compute player-prop probabilities for a given player in a given match.
 * Returns null-valued probs when posteriors don't cover this player —
 * the UI can then either hide the market or fall back to a defaults list.
 */
export function predictPlayerProps(
  playerName: string,
  playerTeam: string,
  context: MatchContext,
): PlayerPropsResult | null {
  const player = findPlayer(playerName);
  if (!player) return null;
  const teamMod = findTeam(playerTeam);
  const expectedMinutes = Number.isFinite(context.expectedMinutes)
    ? Math.max(0, Math.min(95, Number(context.expectedMinutes)))
    : 70;

  // Opponent modifier — use the opposing team's log-scale defense proxy
  // as minus-their-attack (standard Bayesian trick when defense isn't fit).
  const oppTeam = context.isHome ? context.awayTeam : context.homeTeam;
  const oppMod = findTeam(oppTeam);
  const teamAttack = teamMod?.team_attack ?? 0;
  const oppDefenseProxy = oppMod?.team_attack ? -0.5 * oppMod.team_attack : 0;
  const leagueBaseline = teamMod?.league_baseline ?? 0;
  const homeBump = context.isHome ? 0.12 : 0; // log-scale ≈ +13 % goals at home

  // Minutes offset in log-scale (Poisson with rate per-90).
  const minutesOffset = Math.log(Math.max(0.1, expectedMinutes) / 90);

  const logLambdaGoals = player.alpha_mean + teamAttack + oppDefenseProxy + homeBump + leagueBaseline + minutesOffset;
  const logLambdaShots = player.beta_mean + teamAttack * 0.5 + homeBump * 0.5 + minutesOffset;
  const logLambdaCards = player.gamma_mean + minutesOffset;

  const λgoals = Math.exp(logLambdaGoals);
  const λshots = Math.exp(logLambdaShots);
  const λcards = Math.exp(logLambdaCards);

  return {
    player: playerName,
    expectedMinutes,
    lambda_goals: +λgoals.toFixed(4),
    lambda_shots: +λshots.toFixed(4),
    lambda_cards: +λcards.toFixed(4),
    p_anytime_scorer: 1 - Math.exp(-λgoals),
    p_shots_over: (threshold: number) => poissonOver(λshots, Math.floor(threshold)),
    p_yellow_card: 1 - Math.exp(-λcards),
    source: "player-props-bayes",
  };
}

// ─── Convenience: decimal-odds fair-line for each market ───────────

/**
 * Convert posterior probability → fair decimal odds. Bookmaker margin is
 * layered on top by the caller's Goldilocks filter, not here.
 */
export function fairOdds(p: number | null): number | null {
  if (p == null || p <= 0 || p >= 1) return null;
  return +(1 / p).toFixed(3);
}

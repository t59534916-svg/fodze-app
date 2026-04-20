// ═══════════════════════════════════════════════════════════════════════
// FODZE Live Win-Probability (Phase 3.3)
//
// Remaining-time Poisson WP, parametrised by pre-game engine λ_H, λ_A plus
// current match state (minute, score, reds). Matches the structure of
// Robberechts et al. 2021 "A Bayesian Approach to In-Game Win Probability
// in Soccer" (KDD, arXiv 1906.05029), simplified to the subset that can
// be computed browser-side without a running Stan fit.
//
// Math (simplified):
//   For each team, the remaining goal rate over the rest of the match is
//     λ_remaining = λ_pregame * ((90 - minute) / 90)^decay * state_mult * red_card_mult
//   where
//     decay        = 0.84   (Betfair forum empirical, Robberechts §5 confirms)
//     state_mult   = HT-state-style multiplier — teams leading score less,
//                    teams trailing score more (defensive shell / desperation)
//     red_card_mult= Vecer/Kopriva/Ichiba 2009 (JQAS): +0.39–0.5 goals/remaining-90
//                    for the non-penalised side when a red card is shown
//
// Future goals are Poisson(λ_remaining). Final score = current + future;
// the joint PMF gives us P(H), P(D), P(A).
//
// Intentionally DOESN'T model:
//   - Substitution effects (noisy unless we have lineup-aware engine)
//   - xG of individual shots during the match (needs StatsPerform/Opta feed)
//   - Momentum / xG-trend (implicitly captured by score-state multipliers)
// ═══════════════════════════════════════════════════════════════════════

const REMAINING_DECAY = 0.84;
const MAX_GOALS_PER_TEAM = 12;

// Multipliers on remaining-time λ based on score-state (home perspective).
// Empirically derived from ~15k Understat matches (same source as
// HT_STATE_MULTIPLIERS in dixon-coles.ts). `mH`/`mA` multiply each team's
// own remaining λ.
const STATE_MULTIPLIERS: Record<string, { mH: number; mA: number }> = {
  "0-0": { mH: 0.98, mA: 0.98 },
  "0-1": { mH: 1.04, mA: 1.03 },
  "0-2": { mH: 0.98, mA: 1.20 },
  "0-3": { mH: 0.86, mA: 1.25 },
  "1-0": { mH: 1.00, mA: 1.00 },
  "1-1": { mH: 1.01, mA: 1.01 },
  "1-2": { mH: 1.02, mA: 1.05 },
  "1-3": { mH: 0.90, mA: 1.15 },
  "2-0": { mH: 0.92, mA: 1.08 },
  "2-1": { mH: 1.00, mA: 1.05 },
  "2-2": { mH: 1.05, mA: 1.05 },
  "3-0": { mH: 0.85, mA: 1.12 },
  "3-1": { mH: 0.90, mA: 1.08 },
};

// Red-card impact on the REMAINING 90-minute-equivalent λ of the two
// sides. Handy lookup rather than re-fitting per-match:
//   - Penalised team LOSES ~25 % λ (their goal-rate drops)
//   - Other team GAINS ~30 % λ (they attack the 10-man defence)
// Magnitudes from Vecer/Kopriva/Ichiba 2009 JQAS, scaled to fit the
// remaining-time Poisson fit.
const RED_PENALTY = 0.75;
const RED_BOOST = 1.30;

export interface LivePregame {
  lambdaH: number;        // pre-game expected home goals
  lambdaA: number;
}

export interface LiveMatchState {
  minute: number;         // 0-95 (95 = injury time cap)
  scoreH: number;
  scoreA: number;
  redCardsH: number;      // integer
  redCardsA: number;
}

export interface LiveWPResult {
  wp_home: number;
  wp_draw: number;
  wp_away: number;
  lambda_h_remaining: number;
  lambda_a_remaining: number;
  state_mult_h: number;
  state_mult_a: number;
  time_decay: number;
}

function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(95, Math.floor(m)));
}

function poissonPMF(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k < 0) return 0;
  // Stable iterative computation.
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) term = term * lambda / i;
  return term;
}

function stateMultiplier(scoreH: number, scoreA: number): { mH: number; mA: number } {
  const key = `${scoreH}-${scoreA}`;
  if (STATE_MULTIPLIERS[key]) return STATE_MULTIPLIERS[key];
  // Fallback for unusual scores (e.g. 0-4, 4-0): extrapolate the trailing
  // team desperation. Positive goalDiff = home leads → home scores less,
  // away scores more. Scale 4 % per goal-difference.
  const diff = scoreH - scoreA;
  if (diff > 0) return { mH: Math.max(0.8, 1 - 0.04 * diff), mA: Math.min(1.4, 1 + 0.06 * diff) };
  if (diff < 0) return { mH: Math.min(1.4, 1 + 0.06 * (-diff)), mA: Math.max(0.8, 1 - 0.04 * (-diff)) };
  return { mH: 1.0, mA: 1.0 };
}

/**
 * Remaining-time λ for each team given pre-game rates + current state.
 * Exposed separately so callers can inspect before computing WP.
 */
export function remainingLambda(pregame: LivePregame, state: LiveMatchState): { lH: number; lA: number; decay: number; sm: { mH: number; mA: number } } {
  const minute = clampMinute(state.minute);
  const remainingFrac = Math.max(0, (90 - minute) / 90);
  const decay = Math.pow(remainingFrac, REMAINING_DECAY);
  const sm = stateMultiplier(state.scoreH, state.scoreA);
  const redH = Math.max(0, state.redCardsH | 0);
  const redA = Math.max(0, state.redCardsA | 0);
  // If home has more reds than away → home penalised, away boosted.
  // Net multipliers:
  const redNet = redH - redA;
  const homeRedMult = redNet > 0 ? Math.pow(RED_PENALTY, redNet) : redNet < 0 ? Math.pow(RED_BOOST, -redNet) : 1;
  const awayRedMult = redNet > 0 ? Math.pow(RED_BOOST, redNet) : redNet < 0 ? Math.pow(RED_PENALTY, -redNet) : 1;

  const lH = pregame.lambdaH * decay * sm.mH * homeRedMult;
  const lA = pregame.lambdaA * decay * sm.mA * awayRedMult;
  return { lH, lA, decay, sm };
}

/**
 * Compute live 1X2 WP from pre-game engine output + current match state.
 * Always returns valid probs (sum == 1, each in [0,1]). After 90' the
 * WP equals the Heaviside step function of scoreH vs scoreA.
 */
export function computeLiveWP(pregame: LivePregame, state: LiveMatchState): LiveWPResult {
  const { lH, lA, decay, sm } = remainingLambda(pregame, state);

  // Edge case: match is over (minute >= 90 and no more remaining time).
  if (decay <= 1e-9) {
    const diff = state.scoreH - state.scoreA;
    return {
      wp_home: diff > 0 ? 1 : 0,
      wp_draw: diff === 0 ? 1 : 0,
      wp_away: diff < 0 ? 1 : 0,
      lambda_h_remaining: 0,
      lambda_a_remaining: 0,
      state_mult_h: sm.mH,
      state_mult_a: sm.mA,
      time_decay: decay,
    };
  }

  // Marginal PMFs for each team's additional goals.
  const pH: number[] = [];
  const pA: number[] = [];
  for (let k = 0; k <= MAX_GOALS_PER_TEAM; k++) {
    pH.push(poissonPMF(k, lH));
    pA.push(poissonPMF(k, lA));
  }

  let wpH = 0, wpD = 0, wpA = 0;
  for (let kh = 0; kh <= MAX_GOALS_PER_TEAM; kh++) {
    const fh = state.scoreH + kh;
    for (let ka = 0; ka <= MAX_GOALS_PER_TEAM; ka++) {
      const fa = state.scoreA + ka;
      const p = pH[kh] * pA[ka];
      if (fh > fa) wpH += p;
      else if (fh < fa) wpA += p;
      else wpD += p;
    }
  }
  // Re-normalise — truncation at MAX_GOALS_PER_TEAM loses a sliver of tail mass.
  const s = wpH + wpD + wpA;
  if (s > 0) { wpH /= s; wpD /= s; wpA /= s; }

  return {
    wp_home: +wpH.toFixed(4),
    wp_draw: +wpD.toFixed(4),
    wp_away: +wpA.toFixed(4),
    lambda_h_remaining: +lH.toFixed(4),
    lambda_a_remaining: +lA.toFixed(4),
    state_mult_h: sm.mH,
    state_mult_a: sm.mA,
    time_decay: +decay.toFixed(4),
  };
}

/**
 * Efficiency-audit helper: given a live market price + model WP, compute
 * edge in the Croxson & Reade 2014 style. Positive edge = model disagrees
 * with market in your favour.
 */
export function liveEdge(modelWP: number, marketDecimalOdds: number | null | undefined): number | null {
  if (!marketDecimalOdds || marketDecimalOdds <= 1) return null;
  const impliedP = 1 / marketDecimalOdds;
  return +(modelWP - impliedP).toFixed(4);
}

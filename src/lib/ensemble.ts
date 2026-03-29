// ═══════════════════════════════════════════════════════════════════════
// FODZE Ensemble Model + Bayesian Bootstrap Confidence
//
// Combines 4 independent models for better predictions:
// 1. Dixon-Coles (existing engine — Poisson with NegBin)
// 2. Elo Rating (form-weighted team strength)
// 3. Logistic Regression (feature-based)
// 4. Market-Implied (Pinnacle odds when available)
//
// Bayesian Bootstrap: resample xG history 500× → distribution of predictions
// → empirical confidence intervals that know when the model is uncertain
// ═══════════════════════════════════════════════════════════════════════

// ─── Elo Rating Model ────────────────────────────────────────────────

const DEFAULT_ELO = 1500;
const K_FACTOR = 32;
const HOME_ADVANTAGE_ELO = 65;

interface EloRatings {
  [team: string]: number;
}

import { toCsvName } from "./team-resolver";

// Global Elo store (loaded from ensemble-model.json at runtime)
let eloRatings: EloRatings = {};

function getElo(team: string): number {
  // Direct lookup first (already a CSV name)
  if (eloRatings[team] !== undefined) return eloRatings[team];
  // Resolve FODZE/Understat name to CSV name
  const csvName = toCsvName(team);
  return eloRatings[csvName] ?? DEFAULT_ELO;
}

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Update Elo from a match result. Call this for historical data.
 */
export function updateElo(homeTeam: string, awayTeam: string, homeGoals: number, awayGoals: number): void {
  const rH = getElo(homeTeam) + HOME_ADVANTAGE_ELO;
  const rA = getElo(awayTeam);

  const actual = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const expected = expectedScore(rH, rA);

  // Goal-difference multiplier (Elo convention)
  const gd = Math.abs(homeGoals - awayGoals);
  const gdMult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;

  eloRatings[homeTeam] = getElo(homeTeam) + K_FACTOR * gdMult * (actual - expected);
  eloRatings[awayTeam] = getElo(awayTeam) + K_FACTOR * gdMult * ((1 - actual) - (1 - expected));
}

// Trained logistic regression coefficients (loaded from ensemble-model.json)
let logisticCoeffs: number[][] | null = null;
let logisticIntercepts: number[] | null = null;
let logisticScalerMean: number[] | null = null;
let logisticScalerScale: number[] | null = null;

// Trained ensemble weights (optimized via cross-validation)
let ensembleWeights = { dixonColes: 0.08, elo: 0.26, logistic: 0.46, market: 0.20 };

/**
 * Load trained ensemble model from JSON. Call once at app startup.
 */
export function loadEnsembleModel(model: any): void {
  if (model.elo_ratings) {
    eloRatings = model.elo_ratings;
  }
  if (model.logistic) {
    logisticCoeffs = model.logistic.coefficients;
    logisticIntercepts = model.logistic.intercepts;
    logisticScalerMean = model.logistic.scaler_mean;
    logisticScalerScale = model.logistic.scaler_scale;
  }
  if (model.weights) {
    ensembleWeights = model.weights;
  }
}

/**
 * Predict 1X2 probabilities from Elo ratings.
 */
export function eloPrediction(homeTeam: string, awayTeam: string): { H: number; D: number; A: number } {
  const rH = getElo(homeTeam) + HOME_ADVANTAGE_ELO;
  const rA = getElo(awayTeam);

  const expH = expectedScore(rH, rA);
  // Elo gives win probability, estimate draw from empirical relationship
  const drawProb = Math.max(0.15, 0.36 - 0.28 * Math.abs(expH - 0.5));
  const H = expH * (1 - drawProb);
  const A = (1 - expH) * (1 - drawProb);

  return { H, D: drawProb, A };
}

// ─── Logistic Feature Model ──────────────────────────────────────────

/**
 * Simple logistic regression prediction from match features.
 * Coefficients fitted on historical data (hardcoded from training).
 */
export function logisticPrediction(features: {
  xgDiffPerGame: number;   // (home_xg - away_xg) per game
  formDiff: number;         // not used in trained model (kept for compat)
  homeFactor: number;       // league home factor
  totalXG: number;          // total expected goals
  eloDiff?: number;         // (home_elo - away_elo) / 400
}): { H: number; D: number; A: number; O25: number } {
  const { xgDiffPerGame, homeFactor, totalXG } = features;
  const eloDiff = features.eloDiff || 0;

  // Use trained coefficients if loaded, otherwise fallback
  if (logisticCoeffs && logisticIntercepts && logisticScalerMean && logisticScalerScale) {
    // Scale features as sklearn StandardScaler would
    const raw = [xgDiffPerGame, totalXG, eloDiff, homeFactor];
    const scaled = raw.map((v, i) => (v - logisticScalerMean![i]) / logisticScalerScale![i]);

    // Multinomial logistic: z_class = coeff · x + intercept
    const z = logisticCoeffs.map((coeff, cls) =>
      coeff.reduce((s, c, i) => s + c * scaled[i], 0) + logisticIntercepts![cls]
    );

    // Softmax
    const maxZ = Math.max(...z);
    const expZ = z.map(v => Math.exp(v - maxZ));
    const sumExp = expZ.reduce((s, v) => s + v, 0);
    const probs = expZ.map(v => v / sumExp);

    // Classes order from training: [away=0, draw=1, home=2]
    const O25 = 1 / (1 + Math.exp(-(totalXG - 2.5) * 1.2));
    return { H: probs[2], D: probs[1], A: probs[0], O25 };
  }

  // Fallback (not trained)
  const zH = 0.35 + 0.48 * xgDiffPerGame + 0.05 * eloDiff;
  const zD = -0.16 + 0.04 * xgDiffPerGame;
  const zA = -0.20 - 0.52 * xgDiffPerGame - 0.04 * eloDiff;
  const expH = Math.exp(zH), expD = Math.exp(zD), expA = Math.exp(zA);
  const sum = expH + expD + expA;
  const O25 = 1 / (1 + Math.exp(-(totalXG - 2.5) * 1.2));
  return { H: expH / sum, D: expD / sum, A: expA / sum, O25 };
}

// ─── Market-Implied Model ────────────────────────────────────────────

export function marketImpliedProbs(odds: { h?: number; d?: number; a?: number }): { H: number; D: number; A: number } | null {
  const h = odds.h, d = odds.d, a = odds.a;
  if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) return null;

  // Shin's method (simplified normalization)
  const raw_h = 1 / h, raw_d = 1 / d, raw_a = 1 / a;
  const total = raw_h + raw_d + raw_a;

  return { H: raw_h / total, D: raw_d / total, A: raw_a / total };
}

// ─── Ensemble Combiner ───────────────────────────────────────────────

export interface EnsembleResult {
  // Final ensemble prediction
  H: number; D: number; A: number; O25: number;
  // Per-model predictions (for transparency)
  models: {
    dixonColes: { H: number; D: number; A: number; O25: number; weight: number };
    elo: { H: number; D: number; A: number; weight: number } | null;
    logistic: { H: number; D: number; A: number; O25: number; weight: number };
    market: { H: number; D: number; A: number; weight: number } | null;
  };
  // Bayesian confidence
  confidence: {
    H_ci: [number, number];  // [lower, upper] 90% CI
    D_ci: [number, number];
    A_ci: [number, number];
    O25_ci: [number, number];
    uncertainty: number;      // 0-1 (average CI width, lower = more confident)
  };
  nBootstrap: number;
}

/**
 * Combine all models into weighted ensemble with Bayesian bootstrap.
 */
export function ensemblePrediction(
  dixonColes: { H: number; D: number; A: number; O25: number },
  homeTeam: string,
  awayTeam: string,
  features: {
    xgDiffPerGame: number;
    formDiff: number;
    homeFactor: number;
    totalXG: number;
  },
  odds?: { h?: number; d?: number; a?: number },
  // Per-match xG histories for bootstrap (optional)
  homeXGHistory?: { xg: number; xga: number }[],
  awayXGHistory?: { xg: number; xga: number }[],
  leagueAvg?: number,
): EnsembleResult {

  // ─── Individual model predictions ──────────────────────────────

  const elo = eloPrediction(homeTeam, awayTeam);
  const logistic = logisticPrediction(features);
  const market = odds ? marketImpliedProbs({
    h: parseFloat(String(odds.h || 0)),
    d: parseFloat(String(odds.d || 0)),
    a: parseFloat(String(odds.a || 0)),
  }) : null;

  // ─── Weights (optimized via cross-validation on 8,027 OOS matches) ──
  const w_dc = ensembleWeights.dixonColes;
  const w_elo = ensembleWeights.elo;
  const w_log = ensembleWeights.logistic;
  const w_mkt = market ? ensembleWeights.market : 0;
  const totalW = w_dc + w_elo + w_log + w_mkt;

  // ─── Weighted combination ─────────────────────────────────────

  let H = (w_dc * dixonColes.H + w_elo * elo.H + w_log * logistic.H + (market ? w_mkt * market.H : 0)) / totalW;
  let D = (w_dc * dixonColes.D + w_elo * elo.D + w_log * logistic.D + (market ? w_mkt * market.D : 0)) / totalW;
  let A = (w_dc * dixonColes.A + w_elo * elo.A + w_log * logistic.A + (market ? w_mkt * market.A : 0)) / totalW;

  // Renormalize
  const sum1x2 = H + D + A;
  H /= sum1x2; D /= sum1x2; A /= sum1x2;

  // O25: only DC and Logistic have this
  const O25 = (w_dc * dixonColes.O25 + w_log * logistic.O25) / (w_dc + w_log);

  // ─── Bayesian Bootstrap ───────────────────────────────────────
  // Resample xG history → recompute lambdas → distribution of predictions

  const N_BOOTSTRAP = 500;
  const bootH: number[] = [];
  const bootD: number[] = [];
  const bootA: number[] = [];
  const bootO25: number[] = [];

  const avg = leagueAvg || 1.35;
  const hf = features.homeFactor;

  if (homeXGHistory && awayXGHistory && homeXGHistory.length >= 4 && awayXGHistory.length >= 4) {
    for (let b = 0; b < N_BOOTSTRAP; b++) {
      // Resample with replacement
      const hSample = Array.from({ length: homeXGHistory.length }, () =>
        homeXGHistory[Math.floor(Math.random() * homeXGHistory.length)]);
      const aSample = Array.from({ length: awayXGHistory.length }, () =>
        awayXGHistory[Math.floor(Math.random() * awayXGHistory.length)]);

      const hXGpg = hSample.reduce((s, m) => s + m.xg, 0) / hSample.length;
      const hXGApg = hSample.reduce((s, m) => s + m.xga, 0) / hSample.length;
      const aXGpg = aSample.reduce((s, m) => s + m.xg, 0) / aSample.length;
      const aXGApg = aSample.reduce((s, m) => s + m.xga, 0) / aSample.length;

      // Compute bootstrap lambdas
      const lamH = Math.max(0.3, avg * (hXGpg / avg) * (aXGApg / avg) * hf);
      const lamA = Math.max(0.3, avg * (aXGpg / avg) * (hXGApg / avg));

      // Quick Poisson 1X2
      const totalLam = lamH + lamA;
      const bH = 1 / (1 + Math.exp(-1.1 * (lamH - lamA) - 0.25));
      const bD = Math.max(0.12, 0.36 - 0.3 * Math.abs(lamH - lamA) / Math.max(totalLam, 1));
      const bA = 1 - bH - bD;
      const bO25 = 1 / (1 + Math.exp(-(totalLam - 2.5) * 1.2));

      bootH.push(Math.max(0.01, Math.min(0.99, bH)));
      bootD.push(Math.max(0.01, Math.min(0.99, bD)));
      bootA.push(Math.max(0.01, Math.min(0.99, bA)));
      bootO25.push(Math.max(0.01, Math.min(0.99, bO25)));
    }
  } else {
    // No history → parametric CI (fallback)
    for (let b = 0; b < N_BOOTSTRAP; b++) {
      const noise = () => 1 + (Math.random() - 0.5) * 0.2;  // ±10%
      bootH.push(H * noise());
      bootD.push(D * noise());
      bootA.push(A * noise());
      bootO25.push(O25 * noise());
    }
  }

  // Sort for percentiles
  bootH.sort((a, b) => a - b);
  bootD.sort((a, b) => a - b);
  bootA.sort((a, b) => a - b);
  bootO25.sort((a, b) => a - b);

  const ci5 = Math.floor(N_BOOTSTRAP * 0.05);
  const ci95 = Math.floor(N_BOOTSTRAP * 0.95);

  const H_ci: [number, number] = [bootH[ci5], bootH[ci95]];
  const D_ci: [number, number] = [bootD[ci5], bootD[ci95]];
  const A_ci: [number, number] = [bootA[ci5], bootA[ci95]];
  const O25_ci: [number, number] = [bootO25[ci5], bootO25[ci95]];

  // Uncertainty = average CI width (0 = perfectly confident, 1 = max uncertainty)
  const uncertainty = ((H_ci[1] - H_ci[0]) + (D_ci[1] - D_ci[0]) + (A_ci[1] - A_ci[0])) / 3;

  return {
    H, D, A, O25,
    models: {
      dixonColes: { ...dixonColes, weight: w_dc / totalW },
      elo: { ...elo, weight: w_elo / totalW },
      logistic: { ...logistic, weight: w_log / totalW },
      market: market ? { ...market, weight: w_mkt / totalW } : null,
    },
    confidence: { H_ci, D_ci, A_ci, O25_ci, uncertainty },
    nBootstrap: N_BOOTSTRAP,
  };
}

// ─── Seed Elo from historical data ───────────────────────────────────

/**
 * Initialize Elo ratings from xG history entries.
 * Call once at app startup with historical match data.
 */
export function seedEloFromHistory(matches: { team: string; opponent: string; goals_for: number; goals_against: number; venue: "home" | "away" }[]): void {
  for (const m of matches) {
    if (m.venue === "home") {
      updateElo(m.team, m.opponent, m.goals_for, m.goals_against);
    }
  }
}

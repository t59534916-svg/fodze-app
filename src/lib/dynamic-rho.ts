// ═══════════════════════════════════════════════════════════════════════
// FODZE Dynamic RHO — Per-Match Correlation Prediction
//
// Static RHO = -0.05 treats all matches the same. In reality:
// - Two defensive teams → stronger low-score correlation (more negative rho)
// - Two attacking open teams → weaker correlation (rho closer to 0)
//
// A logistic regression predicts rho from match features,
// mapping to the plausible range [-0.15, 0.02].
// ═══════════════════════════════════════════════════════════════════════

export interface RhoModelCoefficients {
  coefficients: number[];
  intercept: number;
  feature_names: string[];
  rho_min: number;
  rho_max: number;
  training_r2?: number;
  n_train?: number;
}

export interface RhoFeatures {
  total_lambda: number;       // lamH + lamA (expected total goals)
  lambda_diff_abs: number;    // |lamH - lamA| (match balance)
  home_factor: number;        // league/team home advantage
  is_derby: number;           // 0 or 1
  rest_days_diff: number;     // home_rest - away_rest
  league_avg: number;         // league scoring average
}

/**
 * Sigmoid function: maps (-inf, inf) to (0, 1)
 */
function sigmoid(x: number): number {
  if (x > 500) return 1;
  if (x < -500) return 0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Predict the optimal RHO for a specific match.
 *
 * Uses trained logistic regression coefficients to compute:
 *   z = intercept + sum(coeff_i * feature_i)
 *   rho = sigmoid(z) * (rho_max - rho_min) + rho_min
 *
 * @param model - Trained model coefficients (from train_rho.py)
 * @param features - Match-level features
 * @returns Predicted rho in [rho_min, rho_max]
 */
export function predictRho(
  model: RhoModelCoefficients,
  features: RhoFeatures
): number {
  // Build feature vector in the order the model expects
  const featureVector: number[] = model.feature_names.map((name) => {
    switch (name) {
      case "total_lambda": return features.total_lambda;
      case "lambda_diff_abs": return features.lambda_diff_abs;
      case "home_factor": return features.home_factor;
      case "is_derby": return features.is_derby;
      case "rest_days_diff": return features.rest_days_diff;
      case "league_avg": return features.league_avg;
      default: return 0;
    }
  });

  // Linear combination: z = intercept + sum(coeff * feature)
  let z = model.intercept;
  for (let i = 0; i < featureVector.length; i++) {
    z += model.coefficients[i] * featureVector[i];
  }

  // Map through sigmoid to [rho_min, rho_max]
  const rhoRange = model.rho_max - model.rho_min;
  return sigmoid(z) * rhoRange + model.rho_min;
}

/**
 * Build RhoFeatures from match context.
 * Convenience function for use in the engine.
 */
export function buildRhoFeatures(
  lamH: number,
  lamA: number,
  homeFactor: number,
  leagueAvg: number,
  tags?: string[],
  restDaysDiff?: number
): RhoFeatures {
  return {
    total_lambda: lamH + lamA,
    lambda_diff_abs: Math.abs(lamH - lamA),
    home_factor: homeFactor,
    is_derby: tags?.some((t) => t.toUpperCase().includes("DERBY")) ? 1 : 0,
    rest_days_diff: restDaysDiff ?? 0,
    league_avg: leagueAvg,
  };
}

// ── Default Model (pre-trained coefficients) ────────────────────────
// These are placeholder values. Replace with output from train_rho.py.
// The default produces rho ≈ -0.05 for an average match.
export const DEFAULT_RHO_MODEL: RhoModelCoefficients = {
  coefficients: [
    0.35,    // total_lambda: higher scoring → less negative rho
    -0.20,   // lambda_diff_abs: unbalanced → slightly more negative
    -0.15,   // home_factor: strong home → less correlation
    0.10,    // is_derby: derbies → more open
    0.02,    // rest_days_diff: minimal effect
    0.25,    // league_avg: high-scoring league → less correlation
  ],
  intercept: -0.65,
  feature_names: [
    "total_lambda",
    "lambda_diff_abs",
    "home_factor",
    "is_derby",
    "rest_days_diff",
    "league_avg",
  ],
  rho_min: -0.15,
  rho_max: 0.02,
};

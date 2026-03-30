// ═══════════════════════════════════════════════════════════════════════
// FODZE Poisson Regression Runtime
//
// Predicts λH (home goals) and λA (away goals) from match features
// using pre-trained Poisson GLM coefficients (log-link).
//
// λ = exp(intercept + dot(coefficients, scaled_features))
//
// Training: tools/retrain_all.py (sklearn.linear_model.PoissonRegressor)
// ═══════════════════════════════════════════════════════════════════════

export interface PoissonGLMCoeffs {
  coefficients: number[];
  intercept: number;
}

export interface PoissonModel {
  home: PoissonGLMCoeffs;
  away: PoissonGLMCoeffs;
  scaler_mean: number[];
  scaler_scale: number[];
  feature_names: string[];
}

// ─── Global model store (loaded from ensemble-model.json at runtime) ──

let poissonModel: PoissonModel | null = null;

/**
 * Load Poisson model coefficients from ensemble-model.json.
 * Call once at app startup (alongside loadEnsembleModel).
 */
export function loadPoissonModel(json: any): void {
  if (!json?.poisson) return;
  const p = json.poisson;
  if (!p.home?.coefficients || !p.away?.coefficients) return;
  if (!p.scaler_mean || !p.scaler_scale) return;
  // Validate consistent dimensions across all arrays
  const n = p.home.coefficients.length;
  if (p.away.coefficients.length !== n || p.scaler_mean.length !== n || p.scaler_scale.length !== n) {
    console.error(`[Poisson] Model dimension mismatch: home=${n}, away=${p.away.coefficients.length}, mean=${p.scaler_mean.length}, scale=${p.scaler_scale.length}`);
    return;
  }
  poissonModel = p as PoissonModel;
}

export function isPoissonModelLoaded(): boolean {
  return poissonModel !== null;
}

// ─── Prediction ─────────────────────────────────────────────────────

function glmPredict(coeffs: PoissonGLMCoeffs, scaledFeatures: number[]): number {
  let z = coeffs.intercept;
  for (let i = 0; i < coeffs.coefficients.length; i++) {
    z += coeffs.coefficients[i] * scaledFeatures[i];
  }
  return Math.exp(z);
}

/**
 * Predict λH and λA from match features using trained Poisson GLM.
 *
 * Features (9 inputs, must match training order):
 *   [xg_diff, xga_diff, elo_diff, total_xg, home_factor, league_avg, rest_days_diff, sos_strength, is_derby]
 *
 * Returns null if no model is loaded (fallback to xG formula).
 */
export function poissonLambdaPredict(
  features: number[]
): { lambdaH: number; lambdaA: number } | null {
  if (!poissonModel) return null;

  const { home, away, scaler_mean, scaler_scale } = poissonModel;

  // Feature count guardrail: refuse to predict if dimensions mismatch.
  // A mismatch means training and runtime are out of sync — silent NaN is worse than no prediction.
  if (features.length !== scaler_mean.length || features.length !== home.coefficients.length) {
    console.error(`[Poisson] Feature dimension mismatch: got ${features.length}, model expects ${scaler_mean.length} (scaler) / ${home.coefficients.length} (coefs)`);
    return null;
  }

  // StandardScaler: (x - mean) / scale
  // Guard against zero-variance features (constant column in training → scale=0)
  const scaled = features.map((v, i) =>
    (v - scaler_mean[i]) / (scaler_scale[i] || 1)
  );

  const lambdaH = glmPredict(home, scaled);
  const lambdaA = glmPredict(away, scaled);

  // Clamp to plausible range [0.3, 4.5]
  return {
    lambdaH: Math.max(0.3, Math.min(4.5, lambdaH)),
    lambdaA: Math.max(0.3, Math.min(4.5, lambdaA)),
  };
}

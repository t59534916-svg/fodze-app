// ═══════════════════════════════════════════════════════════════════════
// FODZE Negative Binomial Distribution — Overdispersion Upgrade
//
// Football is often overdispersed: variance > mean. Poisson assumes
// variance = mean, underpricing 4+ goal games ("fat tails").
//
// NB(k; mu, alpha) converges to Poisson when alpha → 0.
// Typical alpha values: 0.03-0.12 depending on league.
//
// Parameterization: mu = expected goals (lambda), alpha = overdispersion
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lanczos approximation for log-Gamma function.
 * Accurate to ~15 significant digits for z > 0.5.
 */
function logGamma(z: number): number {
  if (z <= 0) return Infinity;

  // Lanczos coefficients (g=7, n=9)
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    // Reflection formula: Gamma(z) * Gamma(1-z) = pi / sin(pi*z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Negative Binomial PMF in log-space for numerical stability.
 *
 * NB(k; mu, alpha) = Gamma(k + 1/alpha) / (Gamma(1/alpha) * k!)
 *                     * (1/(1+alpha*mu))^(1/alpha)
 *                     * (alpha*mu/(1+alpha*mu))^k
 *
 * @param k - Number of goals (0, 1, 2, ...)
 * @param mu - Expected goals (lambda)
 * @param alpha - Overdispersion parameter (0 = Poisson, higher = more variance)
 * @returns Probability P(X = k)
 */
export function negBinomialPMF(k: number, mu: number, alpha: number): number {
  // Degenerate to Poisson when alpha is negligible
  if (alpha <= 0.001) {
    return poissonPMFInternal(k, mu);
  }

  if (mu <= 0) return k === 0 ? 1 : 0;
  if (k < 0) return 0;

  const r = 1 / alpha;              // "number of successes" parameter
  const p = r / (r + mu);           // "success probability"

  // Log-space computation:
  // log P(k) = logGamma(k+r) - logGamma(r) - logGamma(k+1)
  //          + r*log(p) + k*log(1-p)
  const logProb =
    logGamma(k + r) -
    logGamma(r) -
    logGamma(k + 1) +
    r * Math.log(p) +
    k * Math.log(1 - p);

  return Math.exp(logProb);
}

/**
 * Internal Poisson PMF (for fallback when alpha ≈ 0).
 * Identical to the one in dixon-coles.ts but local to avoid circular deps.
 */
function poissonPMFInternal(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Negative Binomial mean and variance.
 * Mean = mu, Variance = mu + alpha * mu^2
 */
export function negBinomialMoments(mu: number, alpha: number): { mean: number; variance: number; overdispersion: number } {
  const variance = mu + alpha * mu * mu;
  return {
    mean: mu,
    variance,
    overdispersion: variance / Math.max(mu, 0.001), // V/M ratio (1.0 for Poisson)
  };
}

/**
 * Per-league overdispersion parameters.
 * Fitted via MLE on historical data.
 * Higher alpha = more variance = more fat-tail goals.
 */
export interface OverdispersionConfig {
  [league: string]: number;
}

// Default values (to be replaced by fit_alpha.py output)
export const DEFAULT_OVERDISPERSION: OverdispersionConfig = {
  bundesliga: 0.058,
  epl: 0.042,
  la_liga: 0.051,
  serie_a: 0.067,
  ligue_1: 0.055,
  eredivisie: 0.072,
  championship: 0.065,
  bundesliga2: 0.070,
  liga3: 0.095,      // Lower leagues: higher variance
  cl: 0.048,
  el: 0.055,
  default: 0.060,
};

/**
 * Get the overdispersion alpha for a league.
 */
export function getAlpha(league: string, config?: OverdispersionConfig): number {
  const cfg = config || DEFAULT_OVERDISPERSION;
  return cfg[league] ?? cfg.default ?? 0.06;
}

/**
 * Create a PMF function that uses either Poisson or NegBin
 * based on the alpha parameter.
 */
export function createPMF(alpha: number): (k: number, mu: number) => number {
  if (alpha <= 0.001) {
    return poissonPMFInternal;
  }
  return (k: number, mu: number) => negBinomialPMF(k, mu, alpha);
}

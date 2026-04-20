// ═══════════════════════════════════════════════════════════════════════
// FODZE Pinnacle Bayesian Anchoring — "Don't Fight the Tape"
//
// When the model diverges significantly from Pinnacle closing lines
// (the sharpest odds in the world), the model is more likely wrong.
//
// This module:
// 1. Computes KL divergence between model and Pinnacle implied probs
// 2. Blends model with Pinnacle when divergence is high
// 3. Dampens Kelly stake proportional to divergence
//
// Does NOT improve Brier (it's a betting strategy), but dramatically
// improves ROI by preventing over-betting on false positives.
// ═══════════════════════════════════════════════════════════════════════

export interface PinnacleOdds {
  sharp_h: number;   // Pinnacle decimal odds for Home
  sharp_d: number;   // Pinnacle decimal odds for Draw
  sharp_a: number;   // Pinnacle decimal odds for Away
}

export interface AnchoredResult {
  // Blended probabilities
  H: number;
  D: number;
  A: number;
  // Diagnostics
  anchor_weight: number;     // 0 = pure model, 1 = pure Pinnacle
  divergence: number;        // KL divergence (bits)
  kelly_dampening: number;   // multiplier for Kelly (0.2 to 1.0)
  pinnacle_implied: { H: number; D: number; A: number };
}

export interface AnchorConfig {
  max_divergence: number;       // KL threshold for heavy dampening (default 0.10)
  blend_alpha: number;          // sigmoid steepness for blend weight (default 15)
  blend_threshold: number;      // KL midpoint for sigmoid (default 0.06)
  kelly_beta: number;           // dampening rate (default 5.0)
  min_kelly_mult: number;       // floor for Kelly multiplier (default 0.20)
}

const DEFAULT_CONFIG: AnchorConfig = {
  max_divergence: 0.10,
  blend_alpha: 15,
  blend_threshold: 0.06,
  kelly_beta: 5.0,
  min_kelly_mult: 0.20,
};

/**
 * Convert Pinnacle decimal odds to implied probabilities.
 * Uses Shin's method (power method) to remove the vig.
 *
 * Simple approximation: normalize raw implied probs.
 * For Pinnacle's typical 2-3% vig, this is very close to Shin's.
 *
 * Exported for reuse by benter-blend.ts (Phase 1.3) — both anchor + Benter
 * want the same vig-free Pinnacle prior and we avoid divergent helpers.
 */
export function pinnacleImpliedProbs(odds: PinnacleOdds): { H: number; D: number; A: number } | null {
  if (!odds.sharp_h || !odds.sharp_d || !odds.sharp_a) return null;
  if (odds.sharp_h <= 1 || odds.sharp_d <= 1 || odds.sharp_a <= 1) return null;

  const rawH = 1 / odds.sharp_h;
  const rawD = 1 / odds.sharp_d;
  const rawA = 1 / odds.sharp_a;
  const total = rawH + rawD + rawA;

  if (total <= 0) return null;

  return {
    H: rawH / total,
    D: rawD / total,
    A: rawA / total,
  };
}

/**
 * KL Divergence: D_KL(model || pinnacle)
 * Measures how much the model distribution differs from Pinnacle.
 *
 * D_KL = sum(model_i * log(model_i / pinnacle_i))
 *
 * Higher = more divergent. Typical values:
 * - < 0.02: Good agreement
 * - 0.02-0.06: Moderate disagreement
 * - > 0.06: Significant divergence (beware)
 * - > 0.10: Model and Pinnacle strongly disagree (high risk)
 */
function klDivergence(
  model: { H: number; D: number; A: number },
  pinnacle: { H: number; D: number; A: number }
): number {
  let kl = 0;
  const eps = 1e-10;
  for (const key of ["H", "D", "A"] as const) {
    const p = Math.max(model[key], eps);
    const q = Math.max(pinnacle[key], eps);
    kl += p * Math.log(p / q);
  }
  return Math.max(0, kl);
}

/**
 * Sigmoid for smooth blending transition.
 */
function sigmoid(x: number): number {
  if (x > 500) return 1;
  if (x < -500) return 0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Anchor model probabilities to Pinnacle sharp lines.
 *
 * Strategy:
 * 1. Low divergence (< threshold): Trust model fully (weight ≈ 0)
 * 2. High divergence (> threshold): Blend toward Pinnacle (weight increases)
 * 3. Kelly is dampened proportional to divergence
 *
 * @param modelProbs - Model's 1X2 probabilities (after calibration)
 * @param pinnacleOdds - Pinnacle decimal odds
 * @param config - Tuning parameters
 * @returns Anchored probabilities and Kelly dampening factor
 */
export function anchorToPinnacle(
  modelProbs: { H: number; D: number; A: number },
  pinnacleOdds: PinnacleOdds,
  config: Partial<AnchorConfig> = {}
): AnchoredResult | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Extract Pinnacle implied probabilities
  const pinnImplied = pinnacleImpliedProbs(pinnacleOdds);
  if (!pinnImplied) return null;

  // Compute KL divergence
  const div = klDivergence(modelProbs, pinnImplied);

  // Compute anchor weight via sigmoid
  // w ≈ 0 when div << threshold, w ≈ 1 when div >> threshold
  const anchorWeight = sigmoid(cfg.blend_alpha * (div - cfg.blend_threshold));

  // Blend probabilities: P_final = (1-w) * P_model + w * P_pinnacle
  let H = (1 - anchorWeight) * modelProbs.H + anchorWeight * pinnImplied.H;
  let D = (1 - anchorWeight) * modelProbs.D + anchorWeight * pinnImplied.D;
  let A = (1 - anchorWeight) * modelProbs.A + anchorWeight * pinnImplied.A;

  // Renormalize (should already be ~1.0 but ensure)
  const sum = H + D + A;
  if (sum > 0) { H /= sum; D /= sum; A /= sum; }

  // Kelly dampening: aggressively reduce stake when fighting the tape
  // kelly_mult = max(min_mult, 1.0 - beta * divergence)
  const kellyDampening = Math.max(
    cfg.min_kelly_mult,
    1.0 - cfg.kelly_beta * div
  );

  return {
    H, D, A,
    anchor_weight: +anchorWeight.toFixed(4),
    divergence: +div.toFixed(6),
    kelly_dampening: +kellyDampening.toFixed(3),
    pinnacle_implied: pinnImplied,
  };
}

/**
 * Quick check if Pinnacle data is available and valid.
 */
export function hasPinnacleData(odds: Partial<PinnacleOdds>): boolean {
  return !!(odds.sharp_h && odds.sharp_d && odds.sharp_a &&
    odds.sharp_h > 1 && odds.sharp_d > 1 && odds.sharp_a > 1);
}

/**
 * Format divergence for display (Telegram alerts, UI).
 */
export function divergenceLabel(div: number): { emoji: string; label: string; severity: "OK" | "WARN" | "DANGER" } {
  if (div < 0.02) return { emoji: "✅", label: "Pinnacle-aligned", severity: "OK" };
  if (div < 0.06) return { emoji: "⚠️", label: "Moderate divergence", severity: "WARN" };
  return { emoji: "🚨", label: "Fighting the tape!", severity: "DANGER" };
}

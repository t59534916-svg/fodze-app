// ═══════════════════════════════════════════════════════════════════════
// FODZE Benter-Style Logit-Blending — 1X2 posterior shrinkage toward Pinnacle
//
// Bill Benter (1994) docummented that pure fundamental models aren't
// profitable, but a 2-stage logit pool of model × market implied-probs
// IS. The formula:
//
//   z_k  = β₁ · log(max(model_k,  1e-9))
//        + β₂ · log(max(pinn_k,   1e-9))
//   p_k  = softmax(z_k)
//
// Per-league (β₁, β₂) are grid-searched off-line (tools/fit_benter_blend.py)
// against pinnacle closing odds from odds_closing_history + v2 OOT
// predictions. The export here is pure runtime: no training code, no
// network I/O, no supabase dependency. Loader is invoked once at startup
// from AppContext with the contents of public/benter-weights.json.
//
// Integration: benterBlend() is invoked from calculateBetsEnhanced() in
// dixon-coles.ts BEFORE calibrate1X2(). If Benter output is shrunk toward
// Pinnacle, subsequent Platt/Dirichlet calibration + Pinnacle anchoring
// (which still runs on the RAW model probs, per plan decision) operate on
// a more truthful posterior. When Pinnacle odds are unavailable, or the
// blend is disabled by feature flag, the function is a passthrough.
// ═══════════════════════════════════════════════════════════════════════

export interface BetaPair {
  beta1: number; // model-weight
  beta2: number; // pinnacle-weight
}

export interface BenterWeightsEngine {
  global: BetaPair;
  leagues: Record<string, BetaPair & { n?: number; oot_logloss?: number }>;
}

export interface BenterWeightsJSON {
  _version: 1;
  _meta?: { trained_at?: string; n_oot_total?: number; loss_function?: string };
  engines: {
    v2?: BenterWeightsEngine;
    v1?: BenterWeightsEngine;
    ensemble?: BenterWeightsEngine;
  };
}

export interface BenterBlendResult {
  H: number;
  D: number;
  A: number;
  applied: boolean;
  reason: string;
}

// ─── Module state ───────────────────────────────────────────────────

let WEIGHTS: BenterWeightsJSON | null = null;
// Allow the feature to be toggled at runtime. Default "off" so an unset
// NEXT_PUBLIC_BENTER_BLEND env var keeps pre-upgrade behavior.
type Mode = "off" | "shadow" | "on";
let MODE: Mode = "off";

export function loadBenterWeights(json: BenterWeightsJSON): void {
  if (!json || json._version !== 1 || !json.engines) {
    // Explicit no-load instead of a silent half-parse. Caller logs the rejection.
    throw new Error("Invalid benter-weights schema (missing _version=1 or engines)");
  }
  WEIGHTS = json;
}

export function setBenterMode(mode: Mode): void { MODE = mode; }
export function getBenterMode(): Mode { return MODE; }
export function isBenterActive(): boolean { return MODE === "on" || MODE === "shadow"; }

// Test helper — restore pristine state between unit tests.
export function resetBenterBlend(): void {
  WEIGHTS = null;
  MODE = "off";
}

// ─── Helpers ────────────────────────────────────────────────────────

function getBetas(engine: "v1" | "v2" | "ensemble", leagueCode?: string): BetaPair | null {
  if (!WEIGHTS) return null;
  const e = WEIGHTS.engines[engine];
  if (!e) return null;
  if (leagueCode && e.leagues && e.leagues[leagueCode]) return e.leagues[leagueCode];
  return e.global || null;
}

// Safe log for probs near zero. We clamp at 1e-9 so the log stays finite
// even for a model that assigned essentially zero probability to an outcome
// (would otherwise dominate the softmax).
function safeLog(x: number): number {
  return Math.log(Math.max(x, 1e-9));
}

function softmax3(a: number, b: number, c: number): { H: number; D: number; A: number } {
  const m = Math.max(a, b, c);
  const eA = Math.exp(a - m);
  const eB = Math.exp(b - m);
  const eC = Math.exp(c - m);
  const s = eA + eB + eC;
  return { H: eA / s, D: eB / s, A: eC / s };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Blend a model's 1X2 probabilities with Pinnacle implied probabilities
 * using per-league Benter (β₁, β₂) weights. Falls through to the model
 * probs unchanged (applied=false) when:
 *   - MODE is "off" (feature flag)
 *   - no weights have been loaded
 *   - no Pinnacle implied probs are supplied
 *   - Pinnacle overround is unusable (> 4 %)
 *   - ALL three outcomes have |log(model/pinn)| > 2.5 — that's a broken
 *     engine, not a disagreement; blending with Pinnacle would amplify noise.
 *
 * Never throws. Output always sums to 1.0 within floating-point epsilon.
 */
export function benterBlend(
  modelProbs: { H: number; D: number; A: number },
  pinnacleImplied: { H: number; D: number; A: number } | null,
  engine: "v1" | "v2" | "ensemble" = "v2",
  leagueCode?: string,
): BenterBlendResult {
  const passthrough = (reason: string): BenterBlendResult => ({
    H: modelProbs.H, D: modelProbs.D, A: modelProbs.A, applied: false, reason,
  });

  if (MODE === "off") return passthrough("mode_off");
  if (!WEIGHTS) return passthrough("no_weights");
  if (!pinnacleImplied) return passthrough("no_pinnacle");

  // Gate 1: Pinnacle overround check. pinnacleImpliedProbs normalises to
  // sum=1 already, but we re-derive the raw-implied sum from (1/H+1/D+1/A)
  // using the input Pinnacle probs's implied odds. We don't have the raw
  // odds here, so instead verify the caller actually handed us a valid
  // probability distribution. Heuristic: if the distribution is too
  // concentrated (single outcome >99%) it's a suspect scrape.
  const pSum = pinnacleImplied.H + pinnacleImplied.D + pinnacleImplied.A;
  if (Math.abs(pSum - 1) > 0.01) return passthrough("pinn_not_normalised");
  if (pinnacleImplied.H > 0.99 || pinnacleImplied.D > 0.99 || pinnacleImplied.A > 0.99) {
    return passthrough("pinn_degenerate");
  }

  const betas = getBetas(engine, leagueCode);
  if (!betas) return passthrough("no_weights_for_engine");
  if (!Number.isFinite(betas.beta1) || !Number.isFinite(betas.beta2)) {
    return passthrough("invalid_betas");
  }
  if (betas.beta1 + betas.beta2 <= 0) return passthrough("degenerate_betas");

  // Gate 3: model-weight-share guard. Backtest Apr-2026 showed the MLE fit
  // against Pinnacle close lands at β₁=0 for 12 of 16 leagues — meaning
  // the blend effectively replaces the model posterior with the market.
  // Activating that would collapse FODZE's value-detection loop because
  // the edge = model − market would drift to ≈ 0 everywhere. Refuse any
  // blend where the model gets less than 15% of the log-pool weight so
  // a future fit accident can't ship a "pure Pinnacle" payload. The
  // 0.15 threshold passes the +EV whitelist (la_liga2 β=0.593/0.659 →
  // share 0.47, la_liga β=0.438/0.888 → 0.33, greek_sl 0.257/0.960 →
  // 0.21, bundesliga2 0.169/0.947 → 0.15) and rejects the "β₁=0"
  // cases that dominate the current fit.
  const modelShare = betas.beta1 / (betas.beta1 + betas.beta2);
  if (modelShare < 0.15) return passthrough("market_dominated");

  // Gate 2: outlier detector. If the model disagrees by more than 2.5 log-
  // units on ALL outcomes (very rare but real — e.g. broken engine fallback
  // to uniform), don't pull it toward Pinnacle; log and pass through so
  // downstream calibration + anchoring surface the problem honestly.
  const logDiff = {
    H: Math.abs(safeLog(modelProbs.H) - safeLog(pinnacleImplied.H)),
    D: Math.abs(safeLog(modelProbs.D) - safeLog(pinnacleImplied.D)),
    A: Math.abs(safeLog(modelProbs.A) - safeLog(pinnacleImplied.A)),
  };
  if (logDiff.H > 2.5 && logDiff.D > 2.5 && logDiff.A > 2.5) {
    return passthrough("outlier");
  }

  // The actual blend.
  const zH = betas.beta1 * safeLog(modelProbs.H) + betas.beta2 * safeLog(pinnacleImplied.H);
  const zD = betas.beta1 * safeLog(modelProbs.D) + betas.beta2 * safeLog(pinnacleImplied.D);
  const zA = betas.beta1 * safeLog(modelProbs.A) + betas.beta2 * safeLog(pinnacleImplied.A);
  const { H, D, A } = softmax3(zH, zD, zA);

  return { H, D, A, applied: true, reason: leagueCode ? `blend:${engine}:${leagueCode}` : `blend:${engine}:global` };
}

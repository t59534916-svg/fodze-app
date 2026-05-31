// ═══════════════════════════════════════════════════════════════════════
// FODZE Isotonic Calibration — TRAINED on 14,359 games (2017-2025)
// Curves from sklearn.isotonic.IsotonicRegression
// Backtest: Brier 0.6013 → Calibration Error 0.0047
// OOS Validation: 1,274 games (2025/26), Cal. Error 0.0188
// ═══════════════════════════════════════════════════════════════════════

const CAL_H: number[] = [
  0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
  0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.0938, 0.0938, 0.0938, 0.0938,
  0.1053, 0.1053, 0.1176, 0.1176, 0.1176, 0.1425, 0.1425, 0.1425, 0.1425, 0.1425,
  0.1425, 0.1961, 0.1961, 0.1961, 0.1961, 0.2214, 0.2214, 0.2523, 0.2644, 0.2644,
  0.2644, 0.2644, 0.2776, 0.2907, 0.3047, 0.3047, 0.3504, 0.3504, 0.3747, 0.3748,
  0.3748, 0.3748, 0.3748, 0.3748, 0.4126, 0.4126, 0.4466, 0.4604, 0.4604, 0.4951,
  0.5023, 0.5023, 0.5062, 0.5062, 0.5387, 0.5387, 0.5648, 0.5648, 0.5648, 0.6229,
  0.6229, 0.6253, 0.6253, 0.6383, 0.6799, 0.6799, 0.6995, 0.6995, 0.7198, 0.7662,
  0.7887, 0.7887, 0.8133, 0.8235, 0.8235, 0.8605, 0.8605, 0.8769, 0.8769, 0.8769,
  0.8769, 0.8769, 0.8769, 0.8769, 0.8769, 0.8769, 0.8769, 0.8769, 0.8769, 0.8769,
  0.8769
];

// Draw calibration: indices 34+ were pathological (0.377 → 0.6417 → 0.999)
// due to insufficient high-probability draw training samples.
// Fixed: smooth sigmoid transition from 0.377 at idx 28 → cap at 0.40 (draws rarely exceed 35-40%)
const CAL_D: number[] = [
  0.001, 0.001, 0.001, 0.001, 0.0115, 0.0386, 0.0476, 0.0476, 0.0676, 0.0676,
  0.08, 0.123, 0.123, 0.1614, 0.1921, 0.1926, 0.2201, 0.2249, 0.2561, 0.2561,
  0.2561, 0.2561, 0.2595, 0.2595, 0.2674, 0.2674, 0.2674, 0.2674, 0.300, 0.310,
  0.320, 0.330, 0.340, 0.350, 0.360, 0.370, 0.377, 0.383, 0.388, 0.392,
  0.395, 0.397, 0.399, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400, 0.400,
  0.400
];

const CAL_A: number[] = [
  0.0545, 0.0545, 0.0545, 0.0545, 0.0545, 0.0545, 0.071, 0.071, 0.071, 0.1117,
  0.1227, 0.1227, 0.1441, 0.1665, 0.1665, 0.1923, 0.2005, 0.2268, 0.2268, 0.2381,
  0.2617, 0.2737, 0.2824, 0.3225, 0.3225, 0.3357, 0.3545, 0.3639, 0.3639, 0.3639,
  0.4394, 0.4394, 0.4394, 0.4394, 0.4394, 0.45, 0.4618, 0.4618, 0.5046, 0.5046,
  0.541, 0.541, 0.541, 0.541, 0.5976, 0.6111, 0.6631, 0.6631, 0.6631, 0.6631,
  0.7059, 0.7097, 0.7097, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284,
  0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.7284, 0.999,
  0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999,
  0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999,
  0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999,
  0.999
];

const CAL_O25: number[] = [
  0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
  0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
  0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.0556, 0.1937, 0.3319, 0.3407,
  0.3407, 0.3407, 0.3407, 0.3407, 0.3407, 0.3407, 0.3407, 0.3407, 0.3407, 0.3407,
  0.3407, 0.375, 0.3812, 0.3812, 0.3812, 0.3812, 0.3968, 0.4516, 0.4516, 0.4516,
  0.4516, 0.4516, 0.4574, 0.4574, 0.4587, 0.4587, 0.4587, 0.4956, 0.4956, 0.4956,
  0.5136, 0.5136, 0.5136, 0.5136, 0.5136, 0.5136, 0.5754, 0.5754, 0.5872, 0.5872,
  0.5872, 0.5872, 0.5872, 0.5872, 0.5949, 0.6078, 0.6403, 0.6403, 0.6403, 0.6403,
  0.6403, 0.6403, 0.6531, 0.6966, 0.6966, 0.6966, 0.6966, 0.6966, 0.6966, 0.6966,
  0.6966, 0.6966, 0.778, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999,
  0.999
];

let CALIBRATION: Record<string, number[]> = {
  H: CAL_H, D: CAL_D, A: CAL_A, O25: CAL_O25,
};

let CALIBRATION_ACTIVE = true;

// Calibration method:
//   "isotonic" — 101-point curve lookup (legacy path, per-market calibration)
//   "platt"    — 2-param sigmoid (current default, per-market + per-league)
//   "dirichlet" — Kull 2019 ODIR-regularised 3-class calibration for 1X2
//                 (O25 still runs through Platt/Isotonic, since it's 2-class)
export type CalibrationMethod = "isotonic" | "platt" | "dirichlet";
let CALIBRATION_METHOD: CalibrationMethod = "isotonic";

// ─── Per-engine shared-calibration gate (2026-05-31) ─────────────────
// The global isotonic curves in public/calibration_curves.json were fit on the
// ensemble / Dixon-Coles DISPLAY distribution (file header: "TRAINED on 14,359
// games 2017-2025"; git: "Train Dixon-Coles calibration on real xG data",
// "Per-league calibration", "Retrain engine from 28,718 Supabase xG entries").
// Applying that curve to the *better-calibrated* v1/v2/dev-03 posteriors degrades
// BOTH Brier AND top-label ECE on the Kelly/edge track — measured by running the
// REAL production calibrate1X2 over the 25/26 OOT parquet
// (tools/backtest/engine_calibrated_brier.mts → validate_calibration_bypass.py):
//
//   engine    Brier raw→cal    ECE raw→cal     verdict
//   Standard  0.682 → 0.651    0.151 → 0.052   curve HELPS (it owns this dist) → keep
//   v1        0.648 → 0.678    0.075 → 0.106   curve HURTS both axes → bypass
//   v2        0.624 → 0.652    0.013 → 0.058   curve HURTS both axes (ECE 4×) → bypass
//   dev-03    0.621 → 0.650    0.021 → 0.063   curve HURTS both axes (ECE 3×) → bypass
//
// Both axes worsening rules out a reliability-for-sharpness trade — the curve is
// simply mis-applied. All four deltas are Holm-significant + powered (n≥6.5k).
// The dev-03 Money-Eval (G5) ROI "worsening" under bypass is NOT robust: a
// 2000-sample match-level bootstrap puts the profit/match Δ CI across 0
// (tools/backtest/_bootstrap_roi_delta.py). Betting edge vs Pinnacle is
// validated-impossible (docs/FORECAST-QUALITY-ANALYSIS.md §5b), so the goal is
// forecast/Kelly probability quality — which bypass strictly improves.
//
// Bypass (identity), NOT a per-engine refit: v2/dev-03 raw ECE is already
// 1.3 % / 2.1 % — there is essentially nothing for a refit to gain, and a fresh
// fit on 25/26 would re-introduce the exact single-season-overfit failure mode
// that produced this stale curve. Bypass removes a transform and adds no fit →
// zero leakage / overfit risk. Scope is 1X2 only (the markets measured); the
// O25 isotonic curve is left untouched (unmeasured per-engine).
//
// ⚠ Conformal coupling: conformalKellyFactor consumes the post-calibration 1X2.
// The gate is `warn` (inert, factor 1.0) in production today, so bypass has no
// live effect on it. IF it is ever flipped to `enforce`, the conformal quantiles
// MUST be refit per-engine on the bypassed (raw/blended) distribution — see
// tools/backtest/refit-all.sh.
export const BYPASS_SHARED_CALIBRATION_ENGINES: ReadonlySet<string> = new Set([
  "v1", "v2", "dev-03",
]);

/** True when this engine's Kelly/edge 1X2 track should SKIP the shared global
 *  isotonic curve (it is better-calibrated on its own — see the table above).
 *  `undefined`/`ensemble` → false (keep calibration). */
export function bypassSharedCalibration(engine?: string): boolean {
  return engine != null && BYPASS_SHARED_CALIBRATION_ENGINES.has(engine);
}
let PLATT_PARAMS: Record<string, { a: number; b: number }> = {};

// Per-league Platt params (loaded from retrained model)
let LEAGUE_PLATT_PARAMS: Record<string, Record<string, { a: number; b: number }>> = {};

// Per-league calibration curves (loaded from retrained model)
let LEAGUE_CALIBRATION: Record<string, Record<string, number[]>> = {};

// ─── Dirichlet Calibration (Phase 2.1) ──────────────────────────────
//
// Three cluster tiers ("top5" / "mid_european" / "lower") each carry a
// 3×3 weight matrix W and a 3-bias vector b. Runtime: given raw 1X2 probs,
//   z = W @ log(probs) + b
//   p' = softmax(z)
// Identity W + zero b is a pass-through.

export interface DirichletClusterParams {
  W: number[][];
  b: number[];
  n_train?: number;
  oot_logloss?: number;
}
export interface DirichletCalibrationJSON {
  _version: 1;
  _meta?: { method?: string; lambda?: number; trained_at?: string | null };
  cluster_map: Record<string, string>;  // league → cluster
  global: DirichletClusterParams;
  clusters: Record<string, DirichletClusterParams>;
}

let DIRICHLET_CLUSTERS: Record<string, DirichletClusterParams> = {};
let DIRICHLET_GLOBAL: DirichletClusterParams | null = null;
let DIRICHLET_CLUSTER_MAP: Record<string, string> = {};
let DIRICHLET_LOADED = false;

export function loadCalibrationCurves(curves: any): void {
  // Identity: no calibration (raw probs are already well-calibrated)
  if (curves.method === "identity") {
    CALIBRATION_METHOD = "isotonic"; // fallback path, but won't be used since ACTIVE=false
    CALIBRATION_ACTIVE = false;
    return;
  }

  // Check for Platt scaling
  if (curves.method === "platt" && curves.platt_params) {
    CALIBRATION_METHOD = "platt";
    PLATT_PARAMS = curves.platt_params;
    // Load per-league Platt params if available
    if (curves.platt_params_league) {
      LEAGUE_PLATT_PARAMS = curves.platt_params_league;
    }
    CALIBRATION_ACTIVE = true;
    return;
  }

  // Isotonic fallback
  CALIBRATION_METHOD = "isotonic";
  // Load global curves (support both flat and nested formats)
  const globalCurves = curves.curves || curves;
  for (const key of ["H", "D", "A", "O25"]) {
    const globalKey = `CAL_${key}`;
    if (globalCurves[globalKey] && globalCurves[globalKey].length === 101) CALIBRATION[key] = globalCurves[globalKey];
    else if (globalCurves[key] && globalCurves[key].length === 101) CALIBRATION[key] = globalCurves[key];
  }
  // Load per-league curves (new format: league_curves.{league}.{market})
  if (curves.league_curves) {
    for (const [league, markets] of Object.entries(curves.league_curves)) {
      if (!LEAGUE_CALIBRATION[league]) LEAGUE_CALIBRATION[league] = {};
      for (const [market, arr] of Object.entries(markets as Record<string, unknown>)) {
        if (Array.isArray(arr) && arr.length === 101) {
          LEAGUE_CALIBRATION[league][market] = arr;
        }
      }
    }
  }
  // Legacy format: CAL_H_bundesliga etc.
  for (const [key, arr] of Object.entries(curves)) {
    const match = key.match(/^CAL_(H|D|A|O25)_(.+)$/);
    if (match && Array.isArray(arr) && arr.length === 101) {
      const [, market, league] = match;
      if (!LEAGUE_CALIBRATION[league]) LEAGUE_CALIBRATION[league] = {};
      LEAGUE_CALIBRATION[league][market] = arr;
    }
  }
  CALIBRATION_ACTIVE = true;
}

export function isCalibrationActive(): boolean { return CALIBRATION_ACTIVE; }

// ─── Dirichlet loader + runtime ─────────────────────────────────────

export function setCalibrationMethod(method: CalibrationMethod): void {
  CALIBRATION_METHOD = method;
}
export function getCalibrationMethod(): CalibrationMethod { return CALIBRATION_METHOD; }

/**
 * Load per-cluster 3×3 W + 3-bias b from the fit output
 * (tools/calibrate_dirichlet.py → public/dirichlet-calibration.json).
 *
 * Throws on invalid schema — AppContext loader catches the throw and
 * flags the `dirichlet` entry in modelErrors so the UI can warn.
 */
export function loadDirichletCalibration(json: DirichletCalibrationJSON): void {
  if (!json || json._version !== 1 || !json.cluster_map || !json.global || !json.clusters) {
    throw new Error("Invalid dirichlet-calibration schema (need _version=1, cluster_map, global, clusters)");
  }
  // Shallow-validate cluster shapes (3×3 W, length-3 b).
  const ok = (p: any): p is DirichletClusterParams =>
    Array.isArray(p?.W) && p.W.length === 3 && p.W.every((r: any) => Array.isArray(r) && r.length === 3)
    && Array.isArray(p?.b) && p.b.length === 3;
  if (!ok(json.global)) throw new Error("Invalid dirichlet global params (W 3×3 + b length-3 required)");
  for (const [cluster, params] of Object.entries(json.clusters)) {
    if (!ok(params)) throw new Error(`Invalid dirichlet cluster "${cluster}"`);
  }
  DIRICHLET_GLOBAL = json.global;
  DIRICHLET_CLUSTERS = json.clusters;
  DIRICHLET_CLUSTER_MAP = json.cluster_map;
  DIRICHLET_LOADED = true;
}

export function isDirichletLoaded(): boolean { return DIRICHLET_LOADED; }

// Test helper — clears Dirichlet state between unit tests.
export function resetDirichlet(): void {
  DIRICHLET_GLOBAL = null;
  DIRICHLET_CLUSTERS = {};
  DIRICHLET_CLUSTER_MAP = {};
  DIRICHLET_LOADED = false;
}

/**
 * Apply Dirichlet calibration to 1X2 probabilities for a given league.
 *
 *   logits = log(max(probs, 1e-9))
 *   z      = W @ logits + b
 *   p'     = softmax(z)
 *
 * Per-league cluster lookup via DIRICHLET_CLUSTER_MAP; falls back to the
 * global params when the league isn't mapped. Returns `applied: false`
 * + the raw input when nothing was loaded.
 */
export function applyDirichlet(
  probs: { H: number; D: number; A: number },
  league?: string,
): { H: number; D: number; A: number; applied: boolean; cluster: string } {
  if (!DIRICHLET_LOADED || !DIRICHLET_GLOBAL) {
    return { ...probs, applied: false, cluster: "none" };
  }
  const clusterKey = (league && DIRICHLET_CLUSTER_MAP[league]) || "global";
  const params = DIRICHLET_CLUSTERS[clusterKey] || DIRICHLET_GLOBAL;
  const logits = [
    Math.log(Math.max(probs.H, 1e-9)),
    Math.log(Math.max(probs.D, 1e-9)),
    Math.log(Math.max(probs.A, 1e-9)),
  ];
  const z = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    z[i] = params.b[i];
    for (let j = 0; j < 3; j++) z[i] += params.W[i][j] * logits[j];
  }
  // Numerical stability: subtract max before exp.
  const mz = Math.max(z[0], z[1], z[2]);
  const e0 = Math.exp(z[0] - mz);
  const e1 = Math.exp(z[1] - mz);
  const e2 = Math.exp(z[2] - mz);
  const s = e0 + e1 + e2;
  return {
    H: e0 / s,
    D: e1 / s,
    A: e2 / s,
    applied: true,
    cluster: clusterKey,
  };
}

export function calibrateProb(rawP: number, market: "H" | "D" | "A" | "O25", league?: string): number {
  // Platt scaling: calibrated_p = 1 / (1 + exp(a * logit(p) + b))
  if (CALIBRATION_METHOD === "platt") {
    // Per-league Platt params if available, fallback to global
    const params = (league && LEAGUE_PLATT_PARAMS[league]?.[market]) || PLATT_PARAMS[market];
    if (!params) return rawP;
    const clipped = Math.max(rawP, 1e-6);
    const logit = Math.log(clipped / Math.max(1 - clipped, 1e-6));
    return 1 / (1 + Math.exp(params.a * logit + params.b));
  }

  // Isotonic: use per-league curve if available, fallback to global
  const curve = (league && LEAGUE_CALIBRATION[league]?.[market]) || CALIBRATION[market];
  if (!curve) return rawP;
  if (rawP <= 0) return curve[0];
  if (rawP >= 1) return curve[100];
  let exactIdx = rawP * 100;

  // CAL_D curve is unreliable above index 34 (trained on insufficient high-draw
  // samples). The isotonic fit jumps from 0.377 at idx 33 to 0.6417 at idx 34
  // and 0.999 at idx 35. Cap lookup to prevent pathological redistribution.
  if (market === "D" && exactIdx > 34) exactIdx = 34;

  const lo = Math.floor(exactIdx);
  const hi = Math.ceil(exactIdx);
  let cal: number;
  if (lo === hi) cal = curve[lo];
  else { const w = exactIdx - lo; cal = curve[lo] * (1 - w) + curve[hi] * w; }

  // Safety clamps for known curve instabilities (sparse data at extremes)
  // D-Kurve: draws almost never exceed 38% in real football
  if (market === "D") cal = Math.min(cal, 0.38);
  // H/A Kurven saturieren bei 0.999 — kein Ergebnis hat >95% Chance
  if (market === "H" || market === "A") cal = Math.min(cal, 0.95);

  return cal;
}

export function calibrate1X2(rawH: number, rawD: number, rawA: number, league?: string): { H: number; D: number; A: number } {
  // Dispatch: when method=dirichlet AND params are loaded, use ODIR 3-class
  // calibration on the input distribution directly (no per-market Platt hop).
  // The D-clamp below is Platt-specific — skipped in the Dirichlet path
  // because Dirichlet's joint 3-class training already constrains each
  // outcome's posterior shape.
  if (CALIBRATION_METHOD === "dirichlet" && DIRICHLET_LOADED) {
    // Inputs may not sum to 1 (rare but happens for CI bounds); re-normalise
    // before taking logs so Dirichlet sees a valid distribution.
    const s0 = Math.max(rawH + rawD + rawA, 1e-12);
    const d = applyDirichlet({ H: rawH / s0, D: rawD / s0, A: rawA / s0 }, league);
    if (d.applied) {
      // Keep H/A safety cap — saturated outcomes > 95% are a data-curve
      // pathology we see across all methods, not just Platt. Redistribute
      // excess proportionally to the other two outcomes so the output
      // still sums to 1 (parallel to the D-clamp below for Platt).
      let H = d.H, D = d.D, A = d.A;
      if (H > 0.95) {
        const excess = H - 0.95;
        H = 0.95;
        const da = D + A;
        if (da > 0) { D += excess * (D / da); A += excess * (A / da); }
      }
      if (A > 0.95) {
        const excess = A - 0.95;
        A = 0.95;
        const hd = H + D;
        if (hd > 0) { H += excess * (H / hd); D += excess * (D / hd); }
      }
      return { H, D, A };
    }
    // Fall through to Platt/Isotonic path when Dirichlet is selected but
    // nothing was loaded yet.
  }

  let calH = calibrateProb(rawH, "H", league);
  let calD = calibrateProb(rawD, "D", league);
  let calA = calibrateProb(rawA, "A", league);
  // First renormalization
  let sum = calH + calD + calA;
  if (sum > 0) { calH /= sum; calD /= sum; calA /= sum; }
  // Post-renorm D-clamp: D-curve collapses at raw>34%, causing D to dominate
  // after renormalization in defensive matches. Cap at 38% and redistribute.
  const D_MAX_POST = 0.38;
  if (calD > D_MAX_POST) {
    const excess = calD - D_MAX_POST;
    calD = D_MAX_POST;
    const ha = calH + calA;
    if (ha > 0) { calH += excess * (calH / ha); calA += excess * (calA / ha); }
  }
  return { H: calH, D: calD, A: calA };
}

export function calibrateOU25(rawO25: number, league?: string): { O25: number; U25: number } {
  const calO25 = calibrateProb(rawO25, "O25", league);
  return { O25: calO25, U25: 1 - calO25 };
}

// ═══════════════════════════════════════════════════════════════════════
// Dual-Track Calibration — @annafrick13 v2.0
//
// Track A: Raw matrix probabilities (market coherence, UI display)
// Track B: Isotonic-calibrated (Kelly sizing, edge check vs Pinnacle)
//
// Edge is computed from Track B: calibrated_prob - pinnacle_vigfree_prob
// Only Track B is used for Kelly fraction and Goldilocks guard.
// ═══════════════════════════════════════════════════════════════════════

export interface DualTrackResult {
  trackA: { H: number; D: number; A: number };  // Raw matrix probs
  trackB: { H: number; D: number; A: number };  // Isotonic-calibrated
}

export function dualTrackCalibrate(
  rawH: number,
  rawD: number,
  rawA: number,
  league?: string,
  engine?: string,
): DualTrackResult {
  // Track A: raw matrix probabilities (used for market derivation, display)
  const trackA = { H: rawH, D: rawD, A: rawA };

  // Track B: isotonic-calibrated (used for the Goldilocks edge-vs-Pinnacle gate).
  // Bypass for engines whose own posterior is better-calibrated than the shared
  // ensemble-era curve (v1/v2/dev-03) — Track B then equals Track A, so the
  // Goldilocks edge is measured on the engine's honest probs, consistent with
  // the Kelly `pModel` in calculateBetsEnhanced. See bypassSharedCalibration.
  if (!CALIBRATION_ACTIVE || bypassSharedCalibration(engine)) {
    return { trackA, trackB: { ...trackA } };
  }

  const trackB = calibrate1X2(rawH, rawD, rawA, league);
  return { trackA, trackB };
}

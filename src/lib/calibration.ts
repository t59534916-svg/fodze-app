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

// Calibration method: isotonic (101-point lookup) or platt (2-param sigmoid)
let CALIBRATION_METHOD: "isotonic" | "platt" = "isotonic";
let PLATT_PARAMS: Record<string, { a: number; b: number }> = {};

// Per-league Platt params (loaded from retrained model)
let LEAGUE_PLATT_PARAMS: Record<string, Record<string, { a: number; b: number }>> = {};

// Per-league calibration curves (loaded from retrained model)
let LEAGUE_CALIBRATION: Record<string, Record<string, number[]>> = {};

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
  league?: string
): DualTrackResult {
  // Track A: raw matrix probabilities (used for market derivation, display)
  const trackA = { H: rawH, D: rawD, A: rawA };

  // Track B: pass through isotonic calibration (used for Kelly + edge)
  if (!CALIBRATION_ACTIVE) {
    return { trackA, trackB: { ...trackA } };
  }

  const trackB = calibrate1X2(rawH, rawD, rawA, league);
  return { trackA, trackB };
}

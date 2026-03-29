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

let CALIBRATION_ACTIVE = true; // Real curves loaded from backtest

// Per-league calibration curves (loaded from retrained model)
let LEAGUE_CALIBRATION: Record<string, Record<string, number[]>> = {};

export function loadCalibrationCurves(curves: Record<string, number[]>): void {
  for (const key of ["H", "D", "A", "O25"]) {
    const globalKey = `CAL_${key}`;
    if (curves[globalKey] && curves[globalKey].length === 101) CALIBRATION[key] = curves[globalKey];
    else if (curves[key] && curves[key].length === 101) CALIBRATION[key] = curves[key];
  }
  // Load per-league curves
  for (const [key, arr] of Object.entries(curves)) {
    const match = key.match(/^CAL_(H|D|A|O25)_(.+)$/);
    if (match && arr.length === 101) {
      const [, market, league] = match;
      if (!LEAGUE_CALIBRATION[league]) LEAGUE_CALIBRATION[league] = {};
      LEAGUE_CALIBRATION[league][market] = arr;
    }
  }
  CALIBRATION_ACTIVE = true;
}

export function isCalibrationActive(): boolean { return CALIBRATION_ACTIVE; }

export function calibrateProb(rawP: number, market: "H" | "D" | "A" | "O25", league?: string): number {
  // Use per-league curve if available, fallback to global
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

export function calibrate1X2(rawH: number, rawD: number, rawA: number): { H: number; D: number; A: number } {
  let calH = calibrateProb(rawH, "H");
  let calD = calibrateProb(rawD, "D");
  let calA = calibrateProb(rawA, "A");
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

export function calibrateOU25(rawO25: number): { O25: number; U25: number } {
  const calO25 = calibrateProb(rawO25, "O25");
  return { O25: calO25, U25: 1 - calO25 };
}

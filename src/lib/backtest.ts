// ═══════════════════════════════════════════════════════════════════════
// FODZE — Post-Match Backtest Scoring
// ═══════════════════════════════════════════════════════════════════════
//
// Pure functions that take a prediction + outcome and return scoring
// metrics. No Supabase / no React — easy to unit-test.
//
// Two headline metrics per binary event:
//   Brier score:  mean((p - o)²)   — lower is better, 0 = perfect
//   Log-loss:     -mean(o*log(p) + (1-o)*log(1-p))  — lower is better
//
// For multi-class 1X2 we use the rank-brier variant (average of the
// three binary Briers). Matches the convention in tests/dixon-coles.test.ts
// and public/backtest-summary.json so runtime and historical metrics
// compare directly.
// ═══════════════════════════════════════════════════════════════════════

export interface Prediction1X2 {
  prob_h: number;
  prob_d: number;
  prob_a: number;
  prob_o25?: number | null;
  prob_btts?: number | null;
}

export interface Outcome1X2 {
  outcome_1x2: "H" | "D" | "A";
  over25: boolean;
  btts: boolean;
}

// ─── Per-Match Metrics ───────────────────────────────────────────

export interface MatchScore {
  brier_1x2: number;
  brier_o25: number | null;
  brier_btts: number | null;
  logloss_1x2: number;
  logloss_o25: number | null;
  logloss_btts: number | null;
  correct_favorite: boolean;  // was the top-probability outcome the actual one?
}

// Clip into (EPS, 1-EPS) to keep log-loss finite when a prediction is
// degenerate (prob = 0 or 1). Without clipping, a single 100%-certain
// wrong pick sends the aggregate to infinity.
const EPS = 1e-6;
const clip = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));

function brierBinary(prob: number, outcome: boolean): number {
  const o = outcome ? 1 : 0;
  return (prob - o) ** 2;
}

function loglossBinary(prob: number, outcome: boolean): number {
  const p = clip(prob);
  return outcome ? -Math.log(p) : -Math.log(1 - p);
}

export function scoreMatch(pred: Prediction1X2, out: Outcome1X2): MatchScore {
  // 1X2 is a 3-class problem — rank-brier averages the three binary Briers.
  const outH = out.outcome_1x2 === "H";
  const outD = out.outcome_1x2 === "D";
  const outA = out.outcome_1x2 === "A";

  const brier_1x2 =
    (brierBinary(pred.prob_h, outH) +
     brierBinary(pred.prob_d, outD) +
     brierBinary(pred.prob_a, outA)) / 3;

  // Log-loss for multi-class: only the winning class contributes.
  const pWinning = clip(
    outH ? pred.prob_h : outD ? pred.prob_d : pred.prob_a,
  );
  const logloss_1x2 = -Math.log(pWinning);

  const brier_o25 = pred.prob_o25 != null ? brierBinary(pred.prob_o25, out.over25) : null;
  const brier_btts = pred.prob_btts != null ? brierBinary(pred.prob_btts, out.btts) : null;
  const logloss_o25 = pred.prob_o25 != null ? loglossBinary(pred.prob_o25, out.over25) : null;
  const logloss_btts = pred.prob_btts != null ? loglossBinary(pred.prob_btts, out.btts) : null;

  const maxP = Math.max(pred.prob_h, pred.prob_d, pred.prob_a);
  const predictedFav =
    pred.prob_h === maxP ? "H"
    : pred.prob_a === maxP ? "A"
    : "D";
  const correct_favorite = predictedFav === out.outcome_1x2;

  return { brier_1x2, brier_o25, brier_btts, logloss_1x2, logloss_o25, logloss_btts, correct_favorite };
}

// ─── Aggregates ──────────────────────────────────────────────────

export interface AggregateScore {
  n: number;
  brier_1x2: number;
  brier_o25: number | null;
  brier_btts: number | null;
  logloss_1x2: number;
  logloss_o25: number | null;
  logloss_btts: number | null;
  favorite_accuracy: number;    // fraction of matches where favorite was correct
}

export function aggregate(scores: MatchScore[]): AggregateScore | null {
  if (scores.length === 0) return null;
  const n = scores.length;
  const mean = (fn: (s: MatchScore) => number | null): number | null => {
    const vals: number[] = [];
    for (const s of scores) { const v = fn(s); if (v != null) vals.push(v); }
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  return {
    n,
    brier_1x2: mean(s => s.brier_1x2)!,
    brier_o25: mean(s => s.brier_o25),
    brier_btts: mean(s => s.brier_btts),
    logloss_1x2: mean(s => s.logloss_1x2)!,
    logloss_o25: mean(s => s.logloss_o25),
    logloss_btts: mean(s => s.logloss_btts),
    favorite_accuracy: scores.filter(s => s.correct_favorite).length / n,
  };
}

// ─── Calibration bins ────────────────────────────────────────────
//
// For each decile of predicted probability, what fraction of the
// matches actually happened? A well-calibrated model has realized-freq
// close to the bin's midpoint (diagonal on the reliability plot).

export interface CalibrationBin {
  bin_lower: number;  // 0.0, 0.1, ..., 0.9
  bin_upper: number;  // 0.1, 0.2, ..., 1.0
  count: number;
  avg_predicted: number;
  realized_freq: number;   // fraction of this bin where event happened
}

export function calibration(pairs: { prob: number; hit: boolean }[], bins = 10): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins;
    const inBin = pairs.filter(p => p.prob >= lo && (i === bins - 1 ? p.prob <= hi : p.prob < hi));
    if (inBin.length === 0) { out.push({ bin_lower: lo, bin_upper: hi, count: 0, avg_predicted: 0, realized_freq: 0 }); continue; }
    const avg = inBin.reduce((s, p) => s + p.prob, 0) / inBin.length;
    const freq = inBin.filter(p => p.hit).length / inBin.length;
    out.push({ bin_lower: lo, bin_upper: hi, count: inBin.length, avg_predicted: avg, realized_freq: freq });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/trust-band.ts
//
// Maps live-Brier calibration to a Gold/Caution/Trap trust band per
// (league, confidence_band). Drives the L0 pill + the Kelly damper.
//
// Data source (production): live_brier_snapshots table.
// ═══════════════════════════════════════════════════════════════════════

export type TrustBand = "gold" | "caution" | "trap";

export interface CalibrationSnapshot {
  league: string;
  confidenceBand: [number, number]; // e.g. [0.60, 0.70]
  hitRate: number;                   // 0-1
  n: number;
  /** Optional: drift in percentage points over last N weeks. */
  driftPp?: number;
}

export interface TrustBandInput {
  league: string;
  confidenceBand: [number, number];
  snapshots: CalibrationSnapshot[];
}

export interface TrustBandResult {
  band: TrustBand;
  hitRate: number | null;
  n: number;
  underCov: boolean;
  /** Drift in PP over recent window (if available). */
  drift?: number;
}

/** Below this n, snapshot is too sparse for normal grading → auto-Caution. */
export const MIN_N = 20;
/** Below this n, snapshot is unusable for ANY signal (even catastrophic). */
export const TRAP_MIN_N = 10;
/** Brier-drift threshold beyond which we downgrade to Trap. */
export const DRIFT_THRESHOLD = 0.015;
/** Hit-rate vs claim midpoint — within this is Gold. (3pp + float tolerance) */
export const GOLD_BAND_EPS = 0.03001;
/** Hit-rate vs claim midpoint — beyond this is Trap. */
export const TRAP_BAND_EPS = 0.08;

export function computeTrustBand(input: TrustBandInput): TrustBandResult {
  const snap = input.snapshots.find(
    s =>
      s.league === input.league &&
      s.confidenceBand[0] === input.confidenceBand[0] &&
      s.confidenceBand[1] === input.confidenceBand[1]
  );

  if (!snap) {
    return { band: "caution", hitRate: null, n: 0, underCov: true };
  }

  const claimMid = (input.confidenceBand[0] + input.confidenceBand[1]) / 2;
  const delta = snap.hitRate - claimMid;
  const absDelta = Math.abs(delta);
  const drift = snap.driftPp ?? 0;
  const isDrift = Math.abs(drift) > DRIFT_THRESHOLD;

  // Catastrophic miscalibration trumps under-coverage: a small sample with
  // hit-rate 22pp off the claim midpoint IS a Trap-Zone signal — the model
  // is clearly miscalibrated here, even if we'd want more samples to be sure.
  if (snap.n >= TRAP_MIN_N && (absDelta > TRAP_BAND_EPS || isDrift)) {
    return {
      band: "trap",
      hitRate: snap.hitRate,
      n: snap.n,
      underCov: snap.n < 30,
      drift,
    };
  }

  // Insufficient sample (and not catastrophic) → Caution with under-cov flag.
  if (snap.n < MIN_N) {
    return { band: "caution", hitRate: snap.hitRate, n: snap.n, underCov: true };
  }

  if (absDelta <= GOLD_BAND_EPS) {
    return { band: "gold", hitRate: snap.hitRate, n: snap.n, underCov: false, drift };
  }
  return { band: "caution", hitRate: snap.hitRate, n: snap.n, underCov: false, drift };
}

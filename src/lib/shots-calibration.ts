// ═══════════════════════════════════════════════════════════════════════
// FODZE — League-specific xG-per-shot calibration
// ═══════════════════════════════════════════════════════════════════════
//
// The historical-replay xShots proxy divides the ensemble λ by a xG-per-
// shot constant. FBref's top-5 long-run mean is ~0.105, but real values
// vary 0.09–0.12 across leagues — lower-quality leagues tend toward 0.09
// because more shots are long-range or blocked, top leagues toward 0.12
// because chance quality is higher.
//
// This module derives a per-league ratio from team_xg_history rows that
// carry both xG and shots. CSV-sourced leagues (football-data.co.uk) and
// Understat 2025/26 backfills populate shots_for; pure-Understat historical
// rows don't, so they don't contribute. When sample is too thin or the
// computed ratio falls outside a plausibility band, we fall back to the
// 0.105 constant.
// ═══════════════════════════════════════════════════════════════════════

export const FALLBACK_XG_PER_SHOT = 0.105;

// Below MIN_SAMPLE matches with both xG and shots the ratio is dominated
// by noise — a single high-xG/low-shot game (penalty match, red-card
// chaos) moves the point estimate by several percent.
const MIN_SAMPLE = 50;

// Plausibility clamp — anything outside this band is a data bug (unit
// confusion, stale model output, wrong column join) not a league signal.
const CLAMP_LO = 0.07;
const CLAMP_HI = 0.15;

export type CalibrationSource =
  | "calibrated"         // computed from sample, inside plausibility band
  | "insufficient-data"  // fewer than MIN_SAMPLE rows with shots
  | "out-of-range";      // computed but clamped → data quality warning

export interface XGPerShotCalibration {
  /** The ratio to actually divide by (already clamped / fallback-applied). */
  ratio: number;
  /** Number of matches that contributed (xG + shots both populated). */
  n: number;
  /** Raw aggregate ratio before clamp/fallback. null when n == 0. */
  raw: number | null;
  /** Why this ratio was chosen. */
  source: CalibrationSource;
}

interface ShotRow {
  xg?: number | null;
  shots_for?: number | null;
}

/**
 * Compute xG / shots aggregated across all input rows. Returns fallback
 * if fewer than 50 usable rows exist. Clamps to [0.07, 0.15].
 *
 * Aggregation style: Σ(xG) / Σ(shots) (micro-average). More robust than
 * mean-of-per-match ratios which blow up on low-shot matches.
 */
export function calibrateXGPerShot(rows: readonly ShotRow[]): XGPerShotCalibration {
  let sumXG = 0;
  let sumShots = 0;
  let n = 0;
  for (const r of rows) {
    if (r.xg == null || r.shots_for == null) continue;
    if (!Number.isFinite(r.xg) || !Number.isFinite(r.shots_for)) continue;
    if (r.shots_for <= 0 || r.xg < 0) continue;
    sumXG += r.xg;
    sumShots += r.shots_for;
    n++;
  }

  if (n < MIN_SAMPLE || sumShots <= 0) {
    return {
      ratio: FALLBACK_XG_PER_SHOT,
      n,
      raw: n > 0 && sumShots > 0 ? sumXG / sumShots : null,
      source: "insufficient-data",
    };
  }

  const raw = sumXG / sumShots;
  if (raw < CLAMP_LO || raw > CLAMP_HI) {
    return {
      ratio: Math.min(CLAMP_HI, Math.max(CLAMP_LO, raw)),
      n,
      raw,
      source: "out-of-range",
    };
  }

  return { ratio: raw, n, raw, source: "calibrated" };
}

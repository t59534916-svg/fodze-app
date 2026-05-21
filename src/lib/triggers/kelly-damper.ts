// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/kelly-damper.ts
//
// Maps trust-band → Kelly multiplier. Same source-of-truth as the
// list-ordering score in /matchday (`score = edge × calibration_factor`).
// ═══════════════════════════════════════════════════════════════════════

import type { TrustBand } from "./trust-band";

export type KellyMult = 1.0 | 0.7 | 0.3;

export function kellyMultiplier(band: TrustBand): KellyMult {
  if (band === "gold") return 1.0;
  if (band === "caution") return 0.7;
  return 0.3;
}

export function calibrationFactor(band: TrustBand): number {
  return kellyMultiplier(band);
}

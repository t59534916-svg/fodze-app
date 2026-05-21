// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/index.ts — Barrel + orchestrator
// ═══════════════════════════════════════════════════════════════════════

export type { TriggerPart, TriggerType, TriggerResult } from "./types";

export {
  detectXGMarketDivergence,
  type XGMarketInput,
  THETA_LIGA,
  DEFAULT_THETA,
} from "./xgMarketDivergence";

export {
  detectCoachingChange,
  type CoachingChangeInput,
  type ManagerChange,
  WINDOW_MIN,
  WINDOW_MAX,
} from "./coachingChange";

export {
  detectStreakPattern,
  type StreakPatternInput,
  type Streak,
  type StreakType,
  type StreakOutcome,
  MIN_GENERAL,
  MIN_H2H,
} from "./streakPattern";

export {
  computeTrustBand,
  type TrustBand,
  type TrustBandInput,
  type TrustBandResult,
  type CalibrationSnapshot,
  MIN_N,
  DRIFT_THRESHOLD,
  GOLD_BAND_EPS,
  TRAP_BAND_EPS,
} from "./trust-band";

export {
  kellyMultiplier,
  calibrationFactor,
  type KellyMult,
} from "./kelly-damper";

import { detectXGMarketDivergence, type XGMarketInput } from "./xgMarketDivergence";
import { detectCoachingChange, type CoachingChangeInput } from "./coachingChange";
import { detectStreakPattern, type StreakPatternInput } from "./streakPattern";
import type { TriggerResult } from "./types";

export interface AllTriggerInputs {
  xgMarket?: XGMarketInput;
  coachingChange?: CoachingChangeInput;
  streakPattern?: StreakPatternInput;
}

/** Runs all enabled trigger detectors, returns non-null results
 *  sorted by descending severity (most prominent first). */
export function runAllTriggers(inputs: AllTriggerInputs): TriggerResult[] {
  const results: TriggerResult[] = [];
  if (inputs.xgMarket) {
    const r = detectXGMarketDivergence(inputs.xgMarket);
    if (r) results.push(r);
  }
  if (inputs.coachingChange) {
    const r = detectCoachingChange(inputs.coachingChange);
    if (r) results.push(r);
  }
  if (inputs.streakPattern) {
    const r = detectStreakPattern(inputs.streakPattern);
    if (r) results.push(r);
  }
  return results.sort((a, b) => b.severity - a.severity);
}

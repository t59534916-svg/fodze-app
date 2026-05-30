// ═══════════════════════════════════════════════════════════════════════
// Engine primary-pick — pure, testable extraction of the MatchdayContext
// hot-path selection logic.
//
// MatchdayContext computes ALL engines per match (memoized, so toggling the
// engine dropdown is instant) and then RE-PICKS the primary calc for the
// currently-selected engine on every render. That re-pick + its fallback
// rule is the single most safety-critical branch in the render path, yet it
// lived inline in an 858-LOC React context with no test coverage.
//
// This module isolates it so the selection + fallback semantics are locked
// by tests/engine-pick.test.ts (the React wiring stays in the context).
// ═══════════════════════════════════════════════════════════════════════

import type { PredictionEngine } from "./engine-registry";

/** The per-match bundle of all engine outputs. Generic over the calc type so
 *  it can be unit-tested with lightweight sentinels instead of full MatchCalc
 *  objects. `ensembleCalc` is always present (the guaranteed fallback); every
 *  other engine may be null (insufficient data, model not loaded, runtime
 *  failure). */
export interface EngineCalcBundle<T> {
  ensembleCalc: T;
  v1Calc: T | null;
  v2Calc: T | null;
  v3Calc: T | null;
  dev03Calc: T | null;
  bayesCalc: T | null;
}

/**
 * Pick the primary calc for the selected engine, with a hard ensemble
 * fallback.
 *
 * Fallback rule (preserved verbatim from the original inline chain): if the
 * selected engine produced `null` — insufficient xG-history (GIGO guard),
 * model artifact not loaded, or a caught runtime error — fall back to the
 * always-present ensemble calc rather than rendering nothing. An unknown /
 * default engine also resolves to ensemble.
 */
export function pickPrimaryCalc<T>(
  engine: PredictionEngine,
  all: EngineCalcBundle<T>,
): T {
  switch (engine) {
    case "poisson-ml-dev03": return all.dev03Calc ?? all.ensembleCalc;
    case "poisson-ml-v3": return all.v3Calc ?? all.ensembleCalc;
    case "poisson-ml-v2": return all.v2Calc ?? all.ensembleCalc;
    case "poisson-ml": return all.v1Calc ?? all.ensembleCalc;
    case "footbayes-hierarchical": return all.bayesCalc ?? all.ensembleCalc;
    default: return all.ensembleCalc;
  }
}

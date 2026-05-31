// ═══════════════════════════════════════════════════════════════════════
// dev-03 overlay merge — pure, testable extraction of the MatchdayContext
// async-overlay fold.
//
// dev-03 is the heaviest engine, so it computes OFF the main thread (Web
// Worker) and lands asynchronously AFTER the synchronous allEngineCalcs memo.
// This module folds that async result back into each per-match engine bundle
// and (re)builds the dev-03 ⊕ v2 Blend once dev-03 is available.
//
// Why extracted: the original inline version indexed the overlay positionally,
// so on a matchday/league switch the NEW allEngineCalcs[i] paired with the
// PREVIOUS matchday's overlay[i] for one render — briefly showing the wrong
// team's dev-03 calc. The fix tags the overlay with the exact source array it
// was computed against; the merge ignores it unless the tag still matches.
// That stale-guard is the single most bug-prone branch in the render path, so
// it's locked by tests/dev03-overlay-merge.test.ts instead of living untested
// inside an 858-LOC React context.
// ═══════════════════════════════════════════════════════════════════════

/** Tagged async-overlay state: the dev-03 results plus the EXACT engine-calc
 *  array reference they were computed against (the staleness tag). */
export interface Dev03OverlayState<C> {
  src: unknown;
  results: (C | null)[];
}

/** Minimal shape the merge needs from a per-match engine bundle. Generic over
 *  the calc type so it can be tested with lightweight sentinels. */
export interface MergeableBundle<C, Ctx> {
  dev03Calc: C | null;
  blendCalc: C | null;
  v2Calc: C | null;
  blendCtx: Ctx;
}

/**
 * Resolve the overlay against the current engine-calc array. Returns the
 * overlay's results ONLY when its staleness tag still matches `current` —
 * otherwise an empty array, so a stale cross-matchday batch can never be
 * positionally paired with the new matchday's matches.
 */
export function resolveOverlay<C>(
  overlay: Dev03OverlayState<C>,
  current: unknown,
): (C | null)[] {
  return overlay.src === current ? overlay.results : [];
}

/**
 * Fold the async dev-03 result + rebuild the Blend into each per-match bundle.
 *
 * Semantics (preserved verbatim from the inline version):
 *   - dev03Calc: prefer an already-present sync value, else the overlay slot,
 *     else null (→ engine selection falls back to ensemble for that tick).
 *   - blendCalc: prefer an already-present value, else build it from the
 *     resolved dev-03 + v2 via the injected `buildBlend` (which returns null
 *     unless BOTH legs exist).
 *   - null bundles (insufficient xG-history) pass through untouched.
 *
 * `buildBlend` is dependency-injected so this stays free of the heavy
 * DC-matrix/Kelly pipeline and is unit-testable with a trivial stub.
 */
// `B extends MergeableBundle<C, Ctx>` so the FULL bundle type (with
// ensembleCalc/v1Calc/v3Calc/bayesCalc/mlInputs/blendCtx) flows through
// unchanged — the merge only overwrites dev03Calc + blendCalc and preserves
// every other property of the caller's concrete bundle.
export function mergeDev03Overlay<C, Ctx, B extends MergeableBundle<C, Ctx>>(
  bundles: (B | null)[],
  overlay: Dev03OverlayState<C>,
  buildBlend: (dev03Calc: C | null, v2Calc: C | null, ctx: Ctx) => C | null,
): (B | null)[] {
  const resolved = resolveOverlay(overlay, bundles);
  return bundles.map((b, i) => {
    if (!b) return b;
    const dev03Calc = b.dev03Calc ?? resolved[i] ?? null;
    const blendCalc = b.blendCalc ?? buildBlend(dev03Calc, b.v2Calc, b.blendCtx);
    return { ...b, dev03Calc, blendCalc };
  });
}

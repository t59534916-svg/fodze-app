// ═══════════════════════════════════════════════════════════════════════
// tests/trail-aggregations.test.ts
// v1.1 Asymmetric Negation Protocol · unit tests for the cron analytics
//
// Locks down the pure-function layer that drives the burn-in + CLV-decay
// recommendations. These were previously embedded in the cron scripts with
// no test coverage; bugs in the dedupe or threshold logic would have
// produced silently-wrong deprecation calls.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
// .mjs import: vitest's bundler resolves ESM modules; TS reads the JSDoc
// type annotations in trail-aggregations.mjs and derives signatures. We
// re-type a few opaque return shapes locally as `any` below — JSDoc-derived
// types are imprecise for nested records, and these tests only assert
// runtime shape (which `it` blocks already verify).
import {
  dedupeTrails,
  aggregateBurnIn,
  computeClosingHwRate,
  clvDecayStatus,
  aggregateClvDecay,
} from "../scripts/_lib/trail-aggregations.mjs";

// Sloppy-typed handles for the return shapes — TS's JSDoc inference for the
// .mjs module makes the inner record types opaque. The runtime contract is
// covered by the assertions; this is only for type-checker plumbing.
type BurnInReturn = { signals: Record<string, any> };
type ClvDecayReturn = { updates: any[]; byTrap: Record<string, any> };
const callBurnIn = aggregateBurnIn as (
  trails: any[], outcomeMap: Map<string, string>, opts: { minN: number; eps: number },
) => BurnInReturn;
const callClvDecay = aggregateClvDecay as (
  trails: any[], closingByKey: Map<string, any>, opts: { decayEps: number; nowMs?: number },
) => ClvDecayReturn;

// ─── dedupeTrails ──────────────────────────────────────────────────────

describe("dedupeTrails", () => {
  it("keeps one row per (trap_kind, match_key)", () => {
    const raw = [
      { trap_kind: "POSSESSION_TRAP", match_key: "bl:bay-bvb", detected_at: 3 },
      { trap_kind: "POSSESSION_TRAP", match_key: "bl:bay-bvb", detected_at: 2 },
      { trap_kind: "POSSESSION_TRAP", match_key: "bl:bay-bvb", detected_at: 1 },
      { trap_kind: "MANAGER_BOUNCE_REGIME", match_key: "bl:bay-bvb", detected_at: 4 },
      { trap_kind: "POSSESSION_TRAP", match_key: "bl:s04-rb", detected_at: 5 },
    ];
    const out = dedupeTrails(raw);
    expect(out).toHaveLength(3);
    // First-wins semantic — caller is expected to pass DESC by detected_at,
    // so the most recent firing wins. Here detected_at=3 is the first one.
    expect(out[0].detected_at).toBe(3);
  });

  it("empty input → empty output", () => {
    expect(dedupeTrails([])).toEqual([]);
  });

  it("different trap_kinds on the same match are NOT deduped", () => {
    const raw = [
      { trap_kind: "A", match_key: "m1", detected_at: 1 },
      { trap_kind: "B", match_key: "m1", detected_at: 1 },
    ];
    expect(dedupeTrails(raw)).toHaveLength(2);
  });
});

// ─── aggregateBurnIn ───────────────────────────────────────────────────

describe("aggregateBurnIn", () => {
  const mkTrail = (trap: string, key: string, predicted: number) => ({
    trap_kind: trap, match_key: key, predicted_hw_rate: predicted,
  });

  it("INSUFFICIENT_N when n < minN", () => {
    const outcomes = new Map([
      ["m1", "H"], ["m2", "A"], ["m3", "H"],
    ]);
    const { signals } = callBurnIn(
      [
        mkTrail("TACTICAL_WIDTH", "m1", 0.55),
        mkTrail("TACTICAL_WIDTH", "m2", 0.55),
        mkTrail("TACTICAL_WIDTH", "m3", 0.55),
      ],
      outcomes,
      { minN: 200, eps: 0.05 },
    );
    expect(signals.TACTICAL_WIDTH.n).toBe(3);
    expect(signals.TACTICAL_WIDTH.recommendation).toMatch(/^INSUFFICIENT_N/);
  });

  it("GRADUATE when |delta| ≤ eps and n ≥ minN", () => {
    // 6 settled matches, observed HW = 50%, predicted 0.50 → delta=0pp
    const outcomes = new Map([
      ["m1", "H"], ["m2", "H"], ["m3", "H"],
      ["m4", "A"], ["m5", "D"], ["m6", "A"],
    ]);
    const trails = [
      mkTrail("X", "m1", 0.5), mkTrail("X", "m2", 0.5), mkTrail("X", "m3", 0.5),
      mkTrail("X", "m4", 0.5), mkTrail("X", "m5", 0.5), mkTrail("X", "m6", 0.5),
    ];
    const { signals } = callBurnIn(trails, outcomes, { minN: 5, eps: 0.05 });
    expect(signals.X.observed_hw_rate).toBe(0.5);
    expect(signals.X.delta_pp).toBe(0);
    expect(signals.X.recommendation).toMatch(/^GRADUATE/);
  });

  it("KEEP_SHADOW when observed << predicted (toxic)", () => {
    // 5 matches, observed 0% home wins, predicted 0.60 → delta=-60pp
    const outcomes = new Map([
      ["m1", "A"], ["m2", "A"], ["m3", "D"], ["m4", "A"], ["m5", "D"],
    ]);
    const trails = ["m1", "m2", "m3", "m4", "m5"].map((k) => mkTrail("X", k, 0.6));
    const { signals } = callBurnIn(trails, outcomes, { minN: 5, eps: 0.05 });
    expect(signals.X.observed_hw_rate).toBe(0);
    expect(signals.X.delta_pp).toBe(-60);
    expect(signals.X.recommendation).toMatch(/^KEEP_SHADOW/);
  });

  it("INVERT_SIGNAL when observed >> predicted (anti-trap)", () => {
    // 5 matches, observed 100% home wins, predicted 0.30 → delta=+70pp
    const outcomes = new Map([
      ["m1", "H"], ["m2", "H"], ["m3", "H"], ["m4", "H"], ["m5", "H"],
    ]);
    const trails = ["m1", "m2", "m3", "m4", "m5"].map((k) => mkTrail("X", k, 0.3));
    const { signals } = callBurnIn(trails, outcomes, { minN: 5, eps: 0.05 });
    expect(signals.X.delta_pp).toBe(70);
    expect(signals.X.recommendation).toMatch(/^INVERT_SIGNAL/);
  });

  it("skips trails whose match isn't in outcomeMap (unresolved)", () => {
    const outcomes = new Map([["m1", "H"]]);
    const trails = [mkTrail("X", "m1", 0.5), mkTrail("X", "m_unsettled", 0.5)];
    const { signals } = callBurnIn(trails, outcomes, { minN: 1, eps: 0.05 });
    expect(signals.X.n).toBe(1);
  });

  it("aggregates per trap_kind independently", () => {
    const outcomes = new Map([["m1", "H"], ["m2", "A"]]);
    const trails = [
      mkTrail("A", "m1", 0.5), mkTrail("A", "m2", 0.5),
      mkTrail("B", "m1", 0.7),
    ];
    const { signals } = callBurnIn(trails, outcomes, { minN: 1, eps: 0.05 });
    expect(signals.A.n).toBe(2);
    expect(signals.B.n).toBe(1);
    expect(signals.B.observed_hw_rate).toBe(1);
  });
});

// ─── computeClosingHwRate ──────────────────────────────────────────────

describe("computeClosingHwRate", () => {
  it("returns null for missing closing", () => {
    expect(computeClosingHwRate(null)).toBeNull();
    expect(computeClosingHwRate({ psch: null } as any)).toBeNull();
    expect(computeClosingHwRate({ psch: 1.0 } as any)).toBeNull(); // psch must be > 1
  });

  it("vig-removes a fair-ish 1x2 set", () => {
    // True probs ~ 50/25/25 → fair odds 2.0/4.0/4.0. With 5% vig: 1.9/3.8/3.8
    const r = computeClosingHwRate({ psch: 1.9, pscd: 3.8, psca: 3.8 });
    expect(r).toBeCloseTo(0.5, 5);
  });

  it("handles missing draw/away (treated as zero implied prob)", () => {
    // Sum reduces to invH only → returns 1.0
    const r = computeClosingHwRate({ psch: 2.0 });
    expect(r).toBe(1.0);
  });

  it("rejects invalid odds (≤ 1.0)", () => {
    expect(computeClosingHwRate({ psch: 0.95, pscd: 3.5, psca: 3.5 })).toBeNull();
  });
});

// ─── clvDecayStatus ────────────────────────────────────────────────────

describe("clvDecayStatus", () => {
  it("BURN_IN when n < 30", () => {
    expect(clvDecayStatus(0.5, 10)).toMatch(/^BURN_IN/);
  });
  it("MARKET_CONVERGED → DEPRECATE in [0.45, 0.55] band", () => {
    expect(clvDecayStatus(0.5, 100)).toMatch(/MARKET_CONVERGED/);
    expect(clvDecayStatus(0.45, 100)).toMatch(/MARKET_CONVERGED/);
    expect(clvDecayStatus(0.55, 100)).toMatch(/MARKET_CONVERGED/);
  });
  it("TRAP_ALIVE when convergence < 30%", () => {
    expect(clvDecayStatus(0.2, 100)).toMatch(/^TRAP_ALIVE/);
    expect(clvDecayStatus(0.0, 100)).toMatch(/^TRAP_ALIVE/);
  });
  it("CONVERGING (watch) in the middle band", () => {
    expect(clvDecayStatus(0.4, 100)).toMatch(/^CONVERGING/);
    expect(clvDecayStatus(0.6, 100)).toMatch(/^CONVERGING/);
    expect(clvDecayStatus(0.8, 100)).toMatch(/^CONVERGING/);
  });
});

// ─── aggregateClvDecay ─────────────────────────────────────────────────

describe("aggregateClvDecay", () => {
  const mkTrail = (id: number, trap: string, key: string, predicted: number) => ({
    id, trap_kind: trap, match_key: key, predicted_hw_rate: predicted,
  });
  const closingMap = (entries: Array<[string, any]>) => new Map(entries);

  it("marks moved_against_us when |closingHw − predicted| < decayEps", () => {
    // closing 50%, predicted 49% → distance 1pp < 3pp threshold → converged
    const closing = closingMap([["m1", { psch: 1.9, pscd: 3.8, psca: 3.8 }]]);
    const { updates, byTrap } = callClvDecay(
      [mkTrail(7, "X", "m1", 0.49)],
      closing,
      { decayEps: 0.03, nowMs: 1700000000000 },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].moved_against_us).toBe(true);
    expect(updates[0].clv_resolved_at).toBe(1700000000000);
    expect(byTrap.X.n).toBe(1);
    expect(byTrap.X.converged).toBe(1);
  });

  it("marks NOT moved when closing stays far from prediction", () => {
    // closing 50%, predicted 90% → distance 40pp > 3pp → not converged
    const closing = closingMap([["m1", { psch: 1.9, pscd: 3.8, psca: 3.8 }]]);
    const { updates, byTrap } = callClvDecay(
      [mkTrail(1, "X", "m1", 0.9)],
      closing,
      { decayEps: 0.03 },
    );
    expect(updates[0].moved_against_us).toBe(false);
    expect(byTrap.X.converged).toBe(0);
  });

  it("DEDUPES aggregation by (trap, match) but updates ALL rows", () => {
    // Same (X, m1) emitted 3 times across page reloads
    const closing = closingMap([["m1", { psch: 1.9, pscd: 3.8, psca: 3.8 }]]);
    const trails = [
      mkTrail(1, "X", "m1", 0.49),
      mkTrail(2, "X", "m1", 0.49),
      mkTrail(3, "X", "m1", 0.49),
    ];
    const { updates, byTrap } = callClvDecay(trails, closing, { decayEps: 0.03 });
    expect(updates).toHaveLength(3); // all rows get patched
    expect(byTrap.X.n).toBe(1);       // aggregation counts once
    expect(byTrap.X.converged).toBe(1);
  });

  it("skips trails whose match has no closing", () => {
    const closing = closingMap([["m1", { psch: 2.0, pscd: 4.0, psca: 4.0 }]]);
    const { updates } = callClvDecay(
      [mkTrail(1, "X", "m_unknown", 0.5)],
      closing,
      { decayEps: 0.03 },
    );
    expect(updates).toHaveLength(0);
  });

  it("status pill matches the n + convergence rate", () => {
    // 30 matches, 15 converged → 50% → MARKET_CONVERGED
    const closing = closingMap(
      Array.from({ length: 30 }, (_, i) => [`m${i}`, { psch: 1.9, pscd: 3.8, psca: 3.8 }] as [string, any]),
    );
    // 15 with predicted=0.49 (converged), 15 with predicted=0.90 (not)
    const trails = [
      ...Array.from({ length: 15 }, (_, i) => mkTrail(i, "X", `m${i}`, 0.49)),
      ...Array.from({ length: 15 }, (_, i) => mkTrail(i + 15, "X", `m${i + 15}`, 0.9)),
    ];
    const { byTrap } = callClvDecay(trails, closing, { decayEps: 0.03 });
    expect(byTrap.X.n).toBe(30);
    expect(byTrap.X.converged).toBe(15);
    expect(byTrap.X.convergence_rate).toBe(0.5);
    expect(byTrap.X.status).toMatch(/MARKET_CONVERGED/);
  });
});

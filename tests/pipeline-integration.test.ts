import { describe, it, expect, beforeEach } from "vitest";
import { calculateBetsEnhanced, type Markets } from "@/lib/dixon-coles";
import { loadBenterWeights, setBenterMode, resetBenterBlend } from "@/lib/benter-blend";
import type { PinnacleOdds } from "@/lib/pinnacle-anchor";

// Minimal Markets object — only the fields calculateBetsEnhanced reads.
// Filling the rest with plausible numbers so edge/Kelly math stays stable.
function makeMk(p: { H: number; D: number; A: number; O25?: number; BY?: number }): Markets {
  return {
    H: p.H, D: p.D, A: p.A,
    O25: p.O25 ?? 0.55, U25: 1 - (p.O25 ?? 0.55),
    BY: p.BY ?? 0.52,
    // Required shape fields — values irrelevant for the tests below but
    // must exist to satisfy the Markets type.
    O15: 0.8, O35: 0.3, O45: 0.15, O55: 0.08,
    U15: 0.2, U35: 0.7, U45: 0.85, U55: 0.92,
    HTHome: 0.4, HTAway: 0.3, HTDraw: 0.3,
    HT_H: 0.4, HT_D: 0.3, HT_A: 0.3,
    CS: {}, CS_HOME: 0, CS_DRAW: 0, CS_AWAY: 0, CS_LIST: [],
  } as unknown as Markets;
}

const mockBenterOn = {
  _version: 1 as const,
  engines: {
    v2: { global: { beta1: 0.8, beta2: 0.6 }, leagues: { bundesliga: { beta1: 0.75, beta2: 0.7 } } },
    v1: { global: { beta1: 1.0, beta2: 0.4 }, leagues: {} },
    ensemble: { global: { beta1: 0.7, beta2: 0.5 }, leagues: {} },
  },
};

const PINN: PinnacleOdds = { sharp_h: 1.85, sharp_d: 3.6, sharp_a: 4.2 };

// Shared inputs for the whole suite.
const mk = makeMk({ H: 0.60, D: 0.25, A: 0.15 });
const mkLow = makeMk({ H: 0.50, D: 0.22, A: 0.12 });
const mkHigh = makeMk({ H: 0.70, D: 0.28, A: 0.18 });
const odds = { h: 1.80, d: 3.70, a: 4.50, o25: 1.90, u25: 1.95, btts: 1.85 };

describe("calculateBetsEnhanced — pipeline integration", () => {
  beforeEach(() => resetBenterBlend());

  it("v1-equivalence: benter OFF + pinnacle absent == pre-upgrade output", () => {
    // Sanity baseline: when Benter is off AND we pass no Pinnacle, the new
    // pipeline must produce the exact same pModel as if the Benter code
    // didn't exist. This is the critical regression guard.
    const baseline = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33);
    resetBenterBlend();
    setBenterMode("on");
    loadBenterWeights(mockBenterOn);
    const withBenterButNoPinn = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33);
    // Without pinnacleOdds, benterBlend returns `no_pinnacle` passthrough.
    // So pModel for the H/D/A bets should match the baseline exactly.
    for (const label of ["Heim", "Unent.", "Ausw."]) {
      const b1 = baseline.find(b => b.label === label)!;
      const b2 = withBenterButNoPinn.find(b => b.label === label)!;
      expect(b2.pModel).toBeCloseTo(b1.pModel, 10);
    }
  });

  it("benter ON + pinnacle present → H/D/A pModel changes, O25 stays stable", () => {
    setBenterMode("on");
    loadBenterWeights(mockBenterOn);
    const baseline = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33);  // mode on, but Pinn absent
    // Same inputs but with Pinnacle — Benter should actually move things.
    const blended = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33, PINN, undefined, "bundesliga", "v2");
    const hB = baseline.find(b => b.label === "Heim")!.pModel;
    const hR = blended.find(b => b.label === "Heim")!.pModel;
    expect(hR).not.toBe(hB);
    // O25 is not part of the Benter blend — must be untouched.
    const o25B = baseline.find(b => b.label === "Ü2.5")!.pModel;
    const o25R = blended.find(b => b.label === "Ü2.5")!.pModel;
    expect(o25R).toBe(o25B);
  });

  it("CI bounds (mk_low/mk_high) are NOT blended toward Pinnacle", () => {
    setBenterMode("on");
    loadBenterWeights(mockBenterOn);
    const withPinn   = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33, PINN, undefined, "bundesliga", "v2");
    const noPinn     = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33);
    const hWith = withPinn.find(b => b.label === "Heim")!;
    const hNo   = noPinn.find(b => b.label === "Heim")!;
    // pModel_low and pModel_high must be identical between the two runs:
    // the CI is computed from mk_low/mk_high which Benter never touches.
    expect(hWith.pModel_low).toBeCloseTo(hNo.pModel_low, 10);
    expect(hWith.pModel_high).toBeCloseTo(hNo.pModel_high, 10);
  });

  it("Benter blend changes pModel but leaves the pipeline stable (no NaN, no crash)", () => {
    // We want to assert that the anchor input (raw mk) is independent of the
    // blend, so Kelly dampening stays an independent safety net. Easiest
    // functional check: pipeline completes without throwing, output sums to
    // ~1 on H/D/A, and pModel differs between the two runs.
    const noBlend = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33, PINN, undefined, "bundesliga", "v2");
    setBenterMode("on");
    loadBenterWeights(mockBenterOn);
    const withBlend = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33, PINN, undefined, "bundesliga", "v2");
    // pModel for H moved (the blend did its job)
    const hNo = noBlend.find(b => b.label === "Heim")!;
    const hW  = withBlend.find(b => b.label === "Heim")!;
    expect(hW.pModel).not.toBe(hNo.pModel);
    // H/D/A still sum to ~1 after renormalisation inside calibrate1X2
    const sumH_D_A = withBlend
      .filter(b => ["Heim", "Unent.", "Ausw."].includes(b.label))
      .reduce((s, b) => s + b.pModel, 0);
    expect(sumH_D_A).toBeCloseTo(1.0, 3);
    // All Kelly values must be finite and non-negative (never < 0 or NaN)
    for (const b of withBlend) {
      expect(Number.isFinite(b.kelly)).toBe(true);
      expect(b.kelly).toBeGreaterThanOrEqual(0);
    }
  });

  it("invalid benter-weights.json → throws from loader, never corrupts state", () => {
    expect(() => loadBenterWeights({} as any)).toThrow();
    // After a failed load, mode remains as last-set (defaults to off at reset).
    // Runtime behavior must fall back to pre-upgrade path cleanly.
    resetBenterBlend();
    const bets = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.33, PINN, undefined, "bundesliga", "v2");
    expect(bets.length).toBeGreaterThan(0);
    const sum = bets.filter(b => ["Heim", "Unent.", "Ausw."].includes(b.label))
      .reduce((s, b) => s + b.pModel, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
});

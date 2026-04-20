import { describe, it, expect, beforeEach } from "vitest";
import {
  benterBlend,
  loadBenterWeights,
  setBenterMode,
  getBenterMode,
  resetBenterBlend,
  type BenterWeightsJSON,
} from "@/lib/benter-blend";

// ─── Fixture: realistic (β₁, β₂) layout ────────────────────────────
const mockWeights: BenterWeightsJSON = {
  _version: 1,
  engines: {
    v2: {
      global: { beta1: 0.8, beta2: 0.6 },
      leagues: {
        bundesliga: { beta1: 0.75, beta2: 0.7 },
      },
    },
    v1: {
      global: { beta1: 1.0, beta2: 0.4 },
      leagues: {},
    },
    ensemble: {
      global: { beta1: 1.0, beta2: 0.0 }, // pass-through
      leagues: {},
    },
  },
};

describe("loadBenterWeights", () => {
  beforeEach(() => resetBenterBlend());

  it("throws on invalid schema", () => {
    expect(() => loadBenterWeights({} as any)).toThrow();
    expect(() => loadBenterWeights({ _version: 2, engines: {} } as any)).toThrow();
    expect(() => loadBenterWeights({ _version: 1 } as any)).toThrow();
  });

  it("accepts valid v1 schema", () => {
    expect(() => loadBenterWeights(mockWeights)).not.toThrow();
  });
});

describe("benterBlend — gates", () => {
  beforeEach(() => {
    resetBenterBlend();
    loadBenterWeights(mockWeights);
  });

  it("passthrough when MODE is off (default)", () => {
    // resetBenterBlend + loadBenterWeights leaves mode off
    const model = { H: 0.50, D: 0.30, A: 0.20 };
    const pinn = { H: 0.45, D: 0.30, A: 0.25 };
    const out = benterBlend(model, pinn, "v2", "bundesliga");
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("mode_off");
    expect(out.H).toBe(0.50);
    expect(out.D).toBe(0.30);
    expect(out.A).toBe(0.20);
  });

  it("passthrough when no Pinnacle implied probs are supplied", () => {
    setBenterMode("on");
    const out = benterBlend({ H: 0.5, D: 0.3, A: 0.2 }, null, "v2", "bundesliga");
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("no_pinnacle");
  });

  it("passthrough when no weights loaded", () => {
    resetBenterBlend();
    setBenterMode("on");
    const out = benterBlend({ H: 0.5, D: 0.3, A: 0.2 }, { H: 0.5, D: 0.3, A: 0.2 }, "v2");
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("no_weights");
  });

  it("passthrough on degenerate Pinnacle (>99% one outcome)", () => {
    setBenterMode("on");
    const out = benterBlend(
      { H: 0.5, D: 0.3, A: 0.2 },
      { H: 0.995, D: 0.003, A: 0.002 },
      "v2",
    );
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("pinn_degenerate");
  });

  it("passthrough on un-normalised Pinnacle input", () => {
    setBenterMode("on");
    const out = benterBlend(
      { H: 0.5, D: 0.3, A: 0.2 },
      { H: 0.4, D: 0.3, A: 0.1 }, // sums to 0.8
      "v2",
    );
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("pinn_not_normalised");
  });

  it("passthrough on outlier (all-3 log-diff > 2.5)", () => {
    setBenterMode("on");
    // Construct pathological disagreement: model puts all mass on D, Pinn
    // splits it H/A. All three log-ratios exceed 2.5 so the outlier gate fires.
    const out = benterBlend(
      { H: 0.005, D: 0.99,  A: 0.005 },
      { H: 0.495, D: 0.01,  A: 0.495 },
      "v2",
    );
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("outlier");
  });

  it("does NOT treat 2-of-3 disagreement as outlier (model gets legitimate edge)", () => {
    setBenterMode("on");
    // 2 large log-diffs, 1 modest — model may know something real; blend applies.
    const out = benterBlend(
      { H: 0.98, D: 0.015, A: 0.005 },
      { H: 0.03, D: 0.07,  A: 0.90  },
      "v2",
    );
    expect(out.applied).toBe(true);
  });
});

describe("benterBlend — math", () => {
  beforeEach(() => {
    resetBenterBlend();
    loadBenterWeights(mockWeights);
    setBenterMode("on");
  });

  it("applies the blend with per-league weights when present", () => {
    const out = benterBlend(
      { H: 0.60, D: 0.25, A: 0.15 },
      { H: 0.50, D: 0.30, A: 0.20 },
      "v2",
      "bundesliga",
    );
    expect(out.applied).toBe(true);
    expect(out.reason).toBe("blend:v2:bundesliga");
    // Output is always a valid distribution.
    const sum = out.H + out.D + out.A;
    expect(sum).toBeCloseTo(1.0, 6);
    // Logit-pool with β₁+β₂ > 1 can SHARPEN when both inputs agree on
    // direction — H stays top-ranked but is slightly different from model.
    expect(out.H).toBeGreaterThan(out.D);
    expect(out.H).toBeGreaterThan(out.A);
    expect(out.H).not.toBe(0.60);
  });

  it("falls back to engine's global betas for an unknown league", () => {
    const out = benterBlend(
      { H: 0.50, D: 0.30, A: 0.20 },
      { H: 0.45, D: 0.30, A: 0.25 },
      "v2",
      "unknown_league",
    );
    expect(out.applied).toBe(true);
    expect(out.reason).toBe("blend:v2:unknown_league");
  });

  it("a pure-passthrough weight (β1=1, β2=0) keeps the model unchanged", () => {
    const model = { H: 0.40, D: 0.35, A: 0.25 };
    const pinn  = { H: 0.55, D: 0.25, A: 0.20 };
    const out = benterBlend(model, pinn, "ensemble");
    expect(out.applied).toBe(true);
    expect(out.H).toBeCloseTo(0.40, 6);
    expect(out.D).toBeCloseTo(0.35, 6);
    expect(out.A).toBeCloseTo(0.25, 6);
  });

  it("a pure-market weight (β1=0, β2=1) returns Pinnacle", () => {
    resetBenterBlend();
    loadBenterWeights({
      _version: 1,
      engines: { v2: { global: { beta1: 0, beta2: 1 }, leagues: {} }, v1: { global: {beta1:0,beta2:1}, leagues: {}}, ensemble: { global: {beta1:0,beta2:1}, leagues: {}} },
    });
    setBenterMode("on");
    const pinn = { H: 0.55, D: 0.25, A: 0.20 };
    const out = benterBlend({ H: 0.40, D: 0.35, A: 0.25 }, pinn, "v2");
    expect(out.H).toBeCloseTo(pinn.H, 6);
    expect(out.D).toBeCloseTo(pinn.D, 6);
    expect(out.A).toBeCloseTo(pinn.A, 6);
  });

  it("handles zero-prob model outcome without NaN (safeLog floor)", () => {
    const out = benterBlend(
      { H: 0.99, D: 0.005, A: 0.005 },
      { H: 0.50, D: 0.30, A: 0.20 },
      "v2",
    );
    expect(out.applied).toBe(true);
    expect(Number.isFinite(out.H)).toBe(true);
    expect(Number.isFinite(out.D)).toBe(true);
    expect(Number.isFinite(out.A)).toBe(true);
    const sum = out.H + out.D + out.A;
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it("shadow mode also applies the blend", () => {
    setBenterMode("shadow");
    expect(getBenterMode()).toBe("shadow");
    const out = benterBlend(
      { H: 0.60, D: 0.25, A: 0.15 },
      { H: 0.50, D: 0.30, A: 0.20 },
      "v2",
    );
    expect(out.applied).toBe(true);
  });
});

describe("benterBlend — invariants across inputs", () => {
  beforeEach(() => {
    resetBenterBlend();
    loadBenterWeights(mockWeights);
    setBenterMode("on");
  });

  it("output is always a valid probability distribution", () => {
    const cases: Array<[{H:number;D:number;A:number}, {H:number;D:number;A:number}]> = [
      [{H:0.33,D:0.34,A:0.33}, {H:0.34,D:0.33,A:0.33}],
      [{H:0.70,D:0.20,A:0.10}, {H:0.60,D:0.25,A:0.15}],
      [{H:0.10,D:0.30,A:0.60}, {H:0.15,D:0.30,A:0.55}],
    ];
    for (const [m, p] of cases) {
      const out = benterBlend(m, p, "v2");
      expect(out.H).toBeGreaterThan(0);
      expect(out.D).toBeGreaterThan(0);
      expect(out.A).toBeGreaterThan(0);
      expect(out.H + out.D + out.A).toBeCloseTo(1.0, 6);
    }
  });
});

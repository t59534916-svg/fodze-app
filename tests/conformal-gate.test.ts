import { describe, it, expect, beforeEach } from "vitest";
import {
  loadConformalQuantiles,
  setConformalMode,
  getConformalMode,
  isConformalLoaded,
  resetConformal,
  conformalGate,
  conformalKellyFactor,
  type ConformalQuantilesJSON,
} from "@/lib/conformal-gate";

// A hand-built fixture: one league with a tight quantile (only arg-max
// survives), one league with a loose quantile (top-2 survive), global fallback.
const fixture: ConformalQuantilesJSON = {
  _version: 1,
  _meta: { alpha_default: 0.10 },
  global: { "0.10": 0.55 },
  leagues: {
    bundesliga: { "0.10": 0.45 }, // tight: only arg-max gets in
    liga3:      { "0.10": 0.85 }, // loose: often multi-class sets
  },
};

describe("loadConformalQuantiles", () => {
  beforeEach(() => resetConformal());

  it("throws on missing _version", () => {
    expect(() => loadConformalQuantiles({} as any)).toThrow();
    expect(() => loadConformalQuantiles({ _version: 2, global: {} } as any)).toThrow();
    expect(() => loadConformalQuantiles({ _version: 1 } as any)).toThrow();
  });

  it("accepts a valid payload and marks loaded", () => {
    expect(isConformalLoaded()).toBe(false);
    loadConformalQuantiles(fixture);
    expect(isConformalLoaded()).toBe(true);
  });

  it("tolerates missing leagues field (defaults to {})", () => {
    loadConformalQuantiles({ _version: 1, global: { "0.10": 0.5 } } as ConformalQuantilesJSON);
    expect(isConformalLoaded()).toBe(true);
  });
});

describe("conformalGate", () => {
  beforeEach(() => {
    resetConformal();
    loadConformalQuantiles(fixture);
  });

  it("uses per-league quantile when available (bundesliga tight → singleton)", () => {
    const probs = { H: 0.55, D: 0.30, A: 0.15 };
    const out = conformalGate(probs, "bundesliga");
    expect(out.cluster).toBe("league");
    expect(out.quantile).toBe(0.45);
    // (1-H=0.45) ≤ 0.45 → H in. (1-D=0.70) > 0.45 → out. (1-A=0.85) > 0.45 → out.
    expect(out.inSet).toEqual(["H"]);
    expect(out.isSingleton).toBe(true);
    expect(out.applied).toBe(true);
  });

  it("uses per-league quantile (liga3 loose → multi-class set)", () => {
    const probs = { H: 0.42, D: 0.33, A: 0.25 };
    const out = conformalGate(probs, "liga3");
    // q=0.85 → everything with (1-p) ≤ 0.85 in → p ≥ 0.15 in.
    expect(out.setSize).toBe(3);
    expect(out.isSingleton).toBe(false);
  });

  it("falls back to global quantile when league unknown", () => {
    const probs = { H: 0.50, D: 0.30, A: 0.20 };
    const out = conformalGate(probs, "unknown_league");
    expect(out.cluster).toBe("global");
    expect(out.quantile).toBe(0.55);
  });

  it("defaults when nothing is loaded (applied=false)", () => {
    resetConformal();
    const out = conformalGate({ H: 0.5, D: 0.3, A: 0.2 }, "bundesliga");
    expect(out.cluster).toBe("default");
    expect(out.applied).toBe(false);
    // Fallback quantile 0.50 means arg-max usually survives → singleton.
    expect(out.isSingleton).toBe(true);
  });

  it("keeps arg-max when quantile is so tight that NO class qualifies", () => {
    resetConformal();
    loadConformalQuantiles({
      _version: 1, global: { "0.10": 0.01 }, leagues: {}, // degenerate
    });
    const out = conformalGate({ H: 0.5, D: 0.3, A: 0.2 }, "bundesliga");
    // 1-0.5=0.5 > 0.01, 1-0.3=0.7 > 0.01, 1-0.2=0.8 > 0.01 → no class in.
    // Defensive recourse: keep arg-max.
    expect(out.inSet).toEqual(["H"]);
    expect(out.isSingleton).toBe(true);
  });

  it("uses alpha parameter for quantile lookup", () => {
    resetConformal();
    loadConformalQuantiles({
      _version: 1,
      global: { "0.05": 0.40, "0.10": 0.55 },
      leagues: {},
    });
    const tight = conformalGate({ H: 0.50, D: 0.30, A: 0.20 }, undefined, 0.05);
    const loose = conformalGate({ H: 0.50, D: 0.30, A: 0.20 }, undefined, 0.10);
    expect(tight.quantile).toBe(0.40);
    expect(loose.quantile).toBe(0.55);
  });
});

describe("conformalKellyFactor", () => {
  beforeEach(() => {
    resetConformal();
    loadConformalQuantiles(fixture);
  });

  it("returns 1.0 when mode is off (feature disabled)", () => {
    setConformalMode("off");
    const f = conformalKellyFactor({ H: 0.4, D: 0.3, A: 0.3 }, "bundesliga");
    expect(f).toBe(1.0);
  });

  it("returns 1.0 when mode is warn (diagnostic only)", () => {
    setConformalMode("warn");
    expect(getConformalMode()).toBe("warn");
    const f = conformalKellyFactor({ H: 0.4, D: 0.3, A: 0.3 }, "bundesliga");
    expect(f).toBe(1.0);
  });

  it("dampens by setSize in dampen mode: 1.0 / 0.6 / 0.3", () => {
    setConformalMode("dampen");
    // bundesliga q=0.45 → H at 0.6 alone (1-0.6=0.4 ≤ 0.45), singleton.
    const single = conformalKellyFactor({ H: 0.60, D: 0.25, A: 0.15 }, "bundesliga");
    expect(single).toBe(1.0);

    // liga3 q=0.85 → all three outcomes in, setSize=3.
    const triple = conformalKellyFactor({ H: 0.42, D: 0.33, A: 0.25 }, "liga3");
    expect(triple).toBe(0.3);
  });

  it("enforce mode: binary 0/1 based on singleton", () => {
    setConformalMode("enforce");
    // bundesliga singleton.
    const ok = conformalKellyFactor({ H: 0.60, D: 0.25, A: 0.15 }, "bundesliga");
    expect(ok).toBe(1.0);
    // liga3 multi-class.
    const blocked = conformalKellyFactor({ H: 0.42, D: 0.33, A: 0.25 }, "liga3");
    expect(blocked).toBe(0.0);
  });

  it("caller can override mode per call (testing convenience)", () => {
    setConformalMode("off");
    const f = conformalKellyFactor({ H: 0.42, D: 0.33, A: 0.25 }, "liga3", 0.10, "enforce");
    expect(f).toBe(0.0);
  });

  it("when mode != off but nothing loaded → permissive fallback", () => {
    resetConformal();
    setConformalMode("enforce");
    // Fallback quantile 0.50 makes arg-max a singleton → passes.
    const f = conformalKellyFactor({ H: 0.55, D: 0.25, A: 0.20 });
    expect(f).toBe(1.0);
  });
});

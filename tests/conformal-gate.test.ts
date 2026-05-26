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

// ─── Over/Under 2.5 binary conformal gate ─────────────────────────
import {
  conformalGateOU25,
  conformalKellyFactorOU25,
  isConformalOU25Loaded,
} from "@/lib/conformal-gate";

// Fixture for OU25: one tight (only confident side gets in singleton),
// one loose (both classes in set), and a global fallback.
const ou25Fixture: ConformalQuantilesJSON = {
  _version: 1,
  global: { "0.10": 0.60 },  // 1X2 baseline (required by schema)
  leagues: {},
  ou25: {
    _meta: { method: "mondrian_binary", market: "over_under_2_5" },
    global: { "0.05": 0.62, "0.10": 0.59, "0.20": 0.56 },
    leagues: {
      // Tight: q=0.55 → p must be ≥0.45 for over25 in set AND p must be ≤0.55 for under25 in set.
      // So singleton occurs when p<0.45 (under only) or p>0.55 (over only).
      bundesliga: { "0.10": 0.55 },
      // Loose: q=0.75 → over25 in iff p≥0.25, under25 in iff p≤0.75 → almost always BOTH.
      liga3: { "0.10": 0.75 },
    },
  },
};

describe("conformalGateOU25 (binary Over/Under 2.5)", () => {
  beforeEach(() => {
    resetConformal();
    loadConformalQuantiles(ou25Fixture);
  });

  it("isConformalOU25Loaded reports true when ou25 section present", () => {
    expect(isConformalOU25Loaded()).toBe(true);
  });

  it("isConformalOU25Loaded false when ou25 section absent (legacy schema)", () => {
    resetConformal();
    loadConformalQuantiles({ _version: 1, global: { "0.10": 0.50 } } as ConformalQuantilesJSON);
    expect(isConformalOU25Loaded()).toBe(false);
  });

  it("tight quantile + confident over → singleton {over25}", () => {
    const g = conformalGateOU25(0.75, "bundesliga"); // q=0.55, p_o25=0.75
    // over: p ≥ 1-q = 0.45 → YES (0.75 ≥ 0.45)
    // under: p ≤ q = 0.55 → NO (0.75 > 0.55)
    expect(g.inSet).toEqual(["over25"]);
    expect(g.isSingleton).toBe(true);
    expect(g.cluster).toBe("league");
  });

  it("tight quantile + confident under → singleton {under25}", () => {
    const g = conformalGateOU25(0.25, "bundesliga"); // q=0.55, p_o25=0.25
    // over: 0.25 ≥ 0.45 → NO
    // under: 0.25 ≤ 0.55 → YES
    expect(g.inSet).toEqual(["under25"]);
    expect(g.isSingleton).toBe(true);
  });

  it("tight quantile + uncertain (p in [0.45, 0.55]) → both in set", () => {
    const g = conformalGateOU25(0.50, "bundesliga"); // q=0.55, p_o25=0.50
    // both qualify
    expect(g.inSet).toEqual(["over25", "under25"]);
    expect(g.setSize).toBe(2);
    expect(g.isSingleton).toBe(false);
  });

  it("loose quantile → both classes in set almost everywhere", () => {
    const g = conformalGateOU25(0.50, "liga3"); // q=0.75
    expect(g.setSize).toBe(2);
  });

  it("extreme p outside loose quantile range falls back to arg-max", () => {
    // Make a hypothetical even-tighter quantile via global lookup of unknown
    // alpha → fallback q=0.50, then p=0.99 → over in (0.99 ≥ 0.50) yes;
    // under in (0.99 ≤ 0.50) no. singleton.
    const g = conformalGateOU25(0.99, "unknown_league");
    expect(g.isSingleton).toBe(true);
    expect(g.inSet[0]).toBe("over25");
  });

  it("falls back to global when league has no ou25 entry", () => {
    const g = conformalGateOU25(0.50, "unknown_league"); // global q=0.59
    expect(g.cluster).toBe("global");
  });
});

describe("conformalKellyFactorOU25", () => {
  beforeEach(() => {
    resetConformal();
    loadConformalQuantiles(ou25Fixture);
  });

  it("mode=off → 1.0 always", () => {
    setConformalMode("off");
    expect(conformalKellyFactorOU25(0.5, "bundesliga")).toBe(1.0);
    expect(conformalKellyFactorOU25(0.99, "liga3")).toBe(1.0);
  });

  it("mode=warn → 1.0 always (observation only)", () => {
    setConformalMode("warn");
    expect(conformalKellyFactorOU25(0.5, "bundesliga")).toBe(1.0);
  });

  it("mode=dampen + singleton → 1.0; both-in-set → 0.6", () => {
    setConformalMode("dampen");
    // confident over → singleton
    expect(conformalKellyFactorOU25(0.75, "bundesliga")).toBe(1.0);
    // p=0.50 in tight range → both in set
    expect(conformalKellyFactorOU25(0.50, "bundesliga")).toBe(0.6);
  });

  it("mode=enforce + singleton → 1.0; both-in-set → 0.0 (block bet)", () => {
    setConformalMode("enforce");
    expect(conformalKellyFactorOU25(0.75, "bundesliga")).toBe(1.0);
    expect(conformalKellyFactorOU25(0.50, "bundesliga")).toBe(0.0);
  });

  it("when ou25 section absent → 1.0 (no-op, preserves legacy behavior)", () => {
    resetConformal();
    loadConformalQuantiles({ _version: 1, global: { "0.10": 0.50 } } as ConformalQuantilesJSON);
    setConformalMode("enforce");
    expect(conformalKellyFactorOU25(0.50, "bundesliga")).toBe(1.0);
  });

  it("real-world schema (one-digit alpha keys '0.1' '0.2') resolves correctly", () => {
    // tools/fit_conformal_ou25.py emits keys like "0.1" (not "0.10").
    // Verify lookup tolerates both.
    resetConformal();
    loadConformalQuantiles({
      _version: 1,
      global: { "0.10": 0.50 },
      ou25: {
        global: { "0.1": 0.59, "0.2": 0.56 },
        leagues: { bundesliga: { "0.1": 0.55 } },
      },
    } as ConformalQuantilesJSON);
    setConformalMode("dampen");
    // p=0.75, q=0.55 → over only (singleton)
    expect(conformalKellyFactorOU25(0.75, "bundesliga")).toBe(1.0);
    // p=0.50 → both
    expect(conformalKellyFactorOU25(0.50, "bundesliga")).toBe(0.6);
  });

  it("caller can override mode per call (matches 1X2 convenience pattern)", () => {
    setConformalMode("off");
    const f = conformalKellyFactorOU25(0.50, "bundesliga", 0.10, "enforce");
    expect(f).toBe(0.0);
  });
});

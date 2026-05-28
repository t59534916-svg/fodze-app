// Tests for the central engine-cascade helper.
//
// The vitest env has no LightGBM model loaded (no AppContext to fetch
// /lgbm-model-v2.json), so `isLGBMModelLoaded()` returns false. This is
// EXACTLY the production "model missing" fallback path — the cascade
// should silently fall through to standard.
import { describe, it, expect } from "vitest";
import { dispatchLambdas, type DispatchInputs } from "@/lib/engine-dispatch";

const baseInput: DispatchInputs = {
  xgHS: 12, xgaHC: 9, hGames: 8,
  xgAS: 10, xgaAC: 11, aGames: 8,
  leagueAvg: 1.5, homeFactor: 1.15,
  league: "bundesliga",
  homeTeam: "Bayern", awayTeam: "Dortmund",
  fraction: 0.25,
};

describe("engine-dispatch", () => {
  it("falls back to standard when v2 model not loaded (test env default)", () => {
    const r = dispatchLambdas("poisson-ml-v2", baseInput);
    expect(r.engineUsed).toBe("standard-fallback");
    expect(r.rho).toBe(-0.05);
    expect(r.lambdaH).toBeGreaterThan(0);
    expect(r.lambdaA).toBeGreaterThan(0);
  });

  it("falls back to standard for engines not wired to narrow-λ path", () => {
    for (const engine of [
      "ensemble-v1", "poisson-ml", "poisson-ml-v3",
      "poisson-ml-dev03", "footbayes-hierarchical",
    ] as const) {
      const r = dispatchLambdas(engine, baseInput);
      expect(r.engineUsed).toBe("standard-fallback");
      expect(r.lambdaH).toBeGreaterThan(0);
      expect(r.lambdaA).toBeGreaterThan(0);
    }
  });

  it("returns deterministic standard λ when no history provided", () => {
    const r1 = dispatchLambdas("poisson-ml-v2", baseInput);
    const r2 = dispatchLambdas("poisson-ml-v2", baseInput);
    expect(r1.lambdaH).toBe(r2.lambdaH);
    expect(r1.lambdaA).toBe(r2.lambdaA);
  });

  it("standard λ respects home factor + xG inputs", () => {
    const strongHome = dispatchLambdas("poisson-ml-v2", {
      ...baseInput,
      xgHS: 24, xgaHC: 5, homeFactor: 1.30,
    });
    const weakHome = dispatchLambdas("poisson-ml-v2", {
      ...baseInput,
      xgHS: 5, xgaHC: 12, homeFactor: 0.95,
    });
    // Strong home should produce HIGHER λ_h than weak home, given same opp
    expect(strongHome.lambdaH).toBeGreaterThan(weakHome.lambdaH);
  });

  it("v2 fallback fires when history arrays are empty", () => {
    const r = dispatchLambdas("poisson-ml-v2", {
      ...baseInput,
      hHistory: [],
      aHistory: [],
    });
    // Empty arrays trigger the "no hist" guard → fallback
    expect(r.engineUsed).toBe("standard-fallback");
  });
});

import { describe, it, expect } from "vitest";
import { pickPrimaryCalc, type EngineCalcBundle } from "@/lib/engine-pick";
import type { PredictionEngine } from "@/lib/engine-registry";

// Sentinel "calc" type — a string tag — so we can assert WHICH engine's calc
// was selected without constructing full MatchCalc objects.
const full: EngineCalcBundle<string> = {
  ensembleCalc: "ENS",
  v1Calc: "V1",
  v2Calc: "V2",
  v3Calc: "V3",
  dev03Calc: "DEV03",
  bayesCalc: "BAYES",
  blendCalc: "BLEND",
};

describe("pickPrimaryCalc — hot-path engine selection + fallback", () => {
  it("selects each engine's own calc when present", () => {
    expect(pickPrimaryCalc("ensemble-v1", full)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml", full)).toBe("V1");
    expect(pickPrimaryCalc("poisson-ml-v2", full)).toBe("V2");
    expect(pickPrimaryCalc("poisson-ml-v3", full)).toBe("V3");
    expect(pickPrimaryCalc("poisson-ml-dev03", full)).toBe("DEV03");
    expect(pickPrimaryCalc("poisson-ml-blend", full)).toBe("BLEND");
    expect(pickPrimaryCalc("footbayes-hierarchical", full)).toBe("BAYES");
  });

  it("falls back to ensemble when the selected engine produced null", () => {
    // GIGO / model-not-loaded / runtime-error case for each non-ensemble engine
    const noV1 = { ...full, v1Calc: null };
    const noV2 = { ...full, v2Calc: null };
    const noV3 = { ...full, v3Calc: null };
    const noDev03 = { ...full, dev03Calc: null };
    const noBayes = { ...full, bayesCalc: null };
    const noBlend = { ...full, blendCalc: null };
    expect(pickPrimaryCalc("poisson-ml", noV1)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml-v2", noV2)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml-v3", noV3)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml-dev03", noDev03)).toBe("ENS");
    expect(pickPrimaryCalc("footbayes-hierarchical", noBayes)).toBe("ENS");
    // Blend is null until BOTH dev-03 (async overlay) + v2 are present.
    expect(pickPrimaryCalc("poisson-ml-blend", noBlend)).toBe("ENS");
  });

  it("dev-03 worker-overlay race: dev03Calc null on first tick → ensemble, then dev-03", () => {
    // Models the async Web-Worker overlay: the sync memo leaves dev03Calc null
    // until calcMatchDev03Async resolves; the merged bundle then carries it.
    const tick0 = { ...full, dev03Calc: null };
    expect(pickPrimaryCalc("poisson-ml-dev03", tick0)).toBe("ENS");
    const tick1 = { ...full, dev03Calc: "DEV03" };
    expect(pickPrimaryCalc("poisson-ml-dev03", tick1)).toBe("DEV03");
  });

  it("ensemble selection never falls back (ensemble is always present)", () => {
    // Even if every optional engine is null, ensemble stands.
    const onlyEns: EngineCalcBundle<string> = {
      ensembleCalc: "ENS", v1Calc: null, v2Calc: null,
      v3Calc: null, dev03Calc: null, bayesCalc: null, blendCalc: null,
    };
    expect(pickPrimaryCalc("ensemble-v1", onlyEns)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml-dev03", onlyEns)).toBe("ENS");
    expect(pickPrimaryCalc("poisson-ml-blend", onlyEns)).toBe("ENS");
  });

  it("unknown / unexpected engine id resolves to ensemble", () => {
    expect(pickPrimaryCalc("totally-unknown" as PredictionEngine, full)).toBe("ENS");
  });

  it("does not mutate the input bundle", () => {
    const snapshot = JSON.stringify(full);
    pickPrimaryCalc("poisson-ml-dev03", full);
    pickPrimaryCalc("poisson-ml", { ...full, v1Calc: null });
    expect(JSON.stringify(full)).toBe(snapshot);
  });
});

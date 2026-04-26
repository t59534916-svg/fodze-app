// Tests the Phase 2.5 fitted-overdispersion loader. The runtime resolution
// order is:
//   1. caller-supplied config (per-call override)
//   2. LOADED_OVERDISPERSION (fitted JSON, set by AppContext at boot)
//   3. DEFAULT_OVERDISPERSION (hardcoded conservative fallback)
//
// These tests pin (2) and (3) — bad JSON or missing JSON must degrade
// gracefully to the defaults, never crash.

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_OVERDISPERSION,
  loadOverdispersionConfig,
  isOverdispersionLoaded,
  resetOverdispersion,
  getAlpha,
} from "@/lib/neg-binomial";

describe("overdispersion loader (Phase 2.5)", () => {
  beforeEach(() => {
    resetOverdispersion();
  });

  it("returns DEFAULT_OVERDISPERSION when nothing loaded", () => {
    expect(isOverdispersionLoaded()).toBe(false);
    expect(getAlpha("bundesliga")).toBe(DEFAULT_OVERDISPERSION.bundesliga);
    expect(getAlpha("epl")).toBe(DEFAULT_OVERDISPERSION.epl);
    expect(getAlpha("default")).toBe(DEFAULT_OVERDISPERSION.default);
  });

  it("uses LOADED config after a successful load", () => {
    const fitted = {
      bundesliga: 0.045,
      epl: 0.038,
      la_liga: 0.035,
      serie_a: 0.032,
      ligue_1: 0.042,
      default: 0.042,
    };
    loadOverdispersionConfig(fitted);
    expect(isOverdispersionLoaded()).toBe(true);
    expect(getAlpha("bundesliga")).toBe(0.045);
    expect(getAlpha("serie_a")).toBe(0.032);
    // Fall back to default for unmapped league
    expect(getAlpha("portuguese_liga_3")).toBe(0.042);
  });

  it("caller-supplied config overrides loaded state", () => {
    loadOverdispersionConfig({ bundesliga: 0.045, default: 0.042 });
    const callerOverride = { bundesliga: 0.099, default: 0.099 };
    expect(getAlpha("bundesliga", callerOverride)).toBe(0.099);
  });

  it("falls back to 0.06 when neither league nor default is in any source", () => {
    // Caller config with no default
    expect(getAlpha("unknown_lg", { foo: 0.5 })).toBe(0.06);
  });

  it("rejects null / non-object input", () => {
    expect(() => loadOverdispersionConfig(null)).toThrow(/not an object/);
    expect(() => loadOverdispersionConfig("nope" as unknown)).toThrow();
    expect(() => loadOverdispersionConfig(42 as unknown)).toThrow();
  });

  it("rejects negative or non-finite alphas", () => {
    expect(() => loadOverdispersionConfig({ bundesliga: -0.1 })).toThrow(/non-negative/);
    expect(() => loadOverdispersionConfig({ epl: NaN })).toThrow();
    expect(() => loadOverdispersionConfig({ epl: Infinity })).toThrow();
    // After a failed load, state stays clean (still false) — verifies
    // the throw happens BEFORE the assignment to LOADED_OVERDISPERSION
    expect(isOverdispersionLoaded()).toBe(false);
  });

  it("resetOverdispersion restores fall-through to defaults", () => {
    loadOverdispersionConfig({ bundesliga: 0.001, default: 0.001 });
    expect(getAlpha("bundesliga")).toBe(0.001);
    resetOverdispersion();
    expect(isOverdispersionLoaded()).toBe(false);
    expect(getAlpha("bundesliga")).toBe(DEFAULT_OVERDISPERSION.bundesliga);
  });

  it("matches the production overdispersion.json shape", () => {
    // Mirrors public/overdispersion.json — every league + cup competition
    // FODZE supports has a fitted alpha. If you add a new competition, add
    // a sentinel here so a missing fit doesn't silently fall through to default.
    const productionShape = {
      bundesliga: 0.045,
      bundesliga2: 0.055,
      liga3: 0.065,
      championship: 0.05,
      epl: 0.038,
      eredivisie: 0.072,
      la_liga: 0.035,
      ligue_1: 0.042,
      serie_a: 0.032,
      cl: 0.04,
      el: 0.048,
      pokal: 0.06,
      default: 0.042,
      global: 0.042,
    };
    expect(() => loadOverdispersionConfig(productionShape)).not.toThrow();
    // All fitted alphas should be ≤ DEFAULT_OVERDISPERSION (the whole
    // point: real data is less overdispersed than conservative defaults)
    for (const lg of ["bundesliga", "epl", "la_liga", "serie_a", "ligue_1"]) {
      const fitted = getAlpha(lg);
      const dflt = DEFAULT_OVERDISPERSION[lg];
      expect(fitted).toBeLessThanOrEqual(dflt);
    }
  });
});

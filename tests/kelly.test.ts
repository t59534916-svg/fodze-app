import { describe, it, expect } from "vitest";
import { kellyFraction } from "@/lib/dixon-coles";

// ─── Correctness of the raw Kelly formula ───────────────────────

describe("kellyFraction — raw math", () => {
  it("returns 0 for zero-edge bet (p × q = 1)", () => {
    // p=0.5, q=2.0 → raw k = (0.5*2 - 1) / (2-1) = 0, stake = 0
    expect(kellyFraction(0.5, 2.0, 1.0)).toBe(0);
  });

  it("returns 0 for negative-edge bet (p × q < 1)", () => {
    // p=0.4, q=2.0 → raw k negative → Math.max(0, ...) → 0
    expect(kellyFraction(0.4, 2.0, 1.0)).toBe(0);
  });

  it("applies the fraction multiplier for positive edge (below cap)", () => {
    // p=0.55, q=2.0 → raw k = 0.10 → ×0.25 = 0.025 (right at K cap)
    // Using fraction 0.33 → 0.10 × 0.33 = 0.033, below M cap 0.04
    const stake = kellyFraction(0.55, 2.0, 0.33);
    expect(stake).toBeCloseTo(0.033, 3);
  });

  it("returns 0 for quote ≤ 1 (guards division by zero)", () => {
    expect(kellyFraction(0.7, 1.0, 0.33)).toBe(0);
    expect(kellyFraction(0.7, 0.5, 0.33)).toBe(0);
  });

  it("returns 0 for p=0 regardless of quote", () => {
    expect(kellyFraction(0, 3.0, 0.5)).toBe(0);
  });
});

// ─── Profile-dependent cap (P0 finding from deep-dive) ──────────

describe("kellyFraction — profile-dependent cap", () => {
  it("K profile (fraction=0.25) caps at 2.5%", () => {
    // Huge edge that would blow past any cap: p=0.9, q=2.0
    // raw k = 0.80 → ×0.25 = 0.20 → capped at 0.025
    expect(kellyFraction(0.9, 2.0, 0.25)).toBe(0.025);
  });

  it("M profile (fraction=0.33) caps at 4%", () => {
    // Same huge edge: raw k = 0.80 → ×0.33 = 0.264 → capped at 0.04
    expect(kellyFraction(0.9, 2.0, 0.33)).toBe(0.04);
  });

  it("A profile (fraction=0.5) caps at 6%", () => {
    // raw k = 0.80 → ×0.5 = 0.40 → capped at 0.06
    expect(kellyFraction(0.9, 2.0, 0.5)).toBe(0.06);
  });

  it("three profiles produce THREE DIFFERENT stakes on the same strong edge", () => {
    // This was the regression: old code capped all three at 0.05
    const sK = kellyFraction(0.9, 2.0, 0.25);
    const sM = kellyFraction(0.9, 2.0, 0.33);
    const sA = kellyFraction(0.9, 2.0, 0.5);
    expect(sK).toBeLessThan(sM);
    expect(sM).toBeLessThan(sA);
    // And the gap is meaningful (A is >2× K)
    expect(sA / sK).toBeGreaterThan(2);
  });

  it("below-cap small edges scale linearly with fraction", () => {
    // Small edge: p=0.52, q=2.0 → raw k = 0.04
    //   K: 0.04 × 0.25 = 0.010 (below 0.025 cap)
    //   M: 0.04 × 0.33 = 0.0132 (below 0.04 cap)
    //   A: 0.04 × 0.5 = 0.020 (below 0.06 cap)
    // All below their caps → should scale with fraction
    const sK = kellyFraction(0.52, 2.0, 0.25);
    const sM = kellyFraction(0.52, 2.0, 0.33);
    const sA = kellyFraction(0.52, 2.0, 0.5);
    expect(sK).toBeCloseTo(0.010, 3);
    expect(sM).toBeCloseTo(0.0132, 3);
    expect(sA).toBeCloseTo(0.020, 3);
    // Linearity: sA / sK ≈ 0.5 / 0.25 = 2.0
    expect(sA / sK).toBeCloseTo(2.0, 1);
  });

  it("default fraction 0.33 behaves as M profile", () => {
    const explicit = kellyFraction(0.9, 2.0, 0.33);
    const defaulted = kellyFraction(0.9, 2.0);
    expect(defaulted).toBe(explicit);
  });
});

import { describe, it, expect } from "vitest";
import { normalizedCIWidth } from "@/lib/backtest";
import { kellyFraction } from "@/lib/dixon-coles";

describe("normalizedCIWidth", () => {
  it("returns 0 for degenerate CI (lo >= hi)", () => {
    expect(normalizedCIWidth(0.5, 0.5, 0.5)).toBe(0);
    expect(normalizedCIWidth(0.6, 0.4, 0.5)).toBe(0);
  });

  it("returns 0 for non-finite bounds", () => {
    expect(normalizedCIWidth(NaN, 0.5, 0.5)).toBe(0);
    expect(normalizedCIWidth(0.1, Infinity, 0.5)).toBe(0);
  });

  it("divides width by base probability, not edge", () => {
    // pModel = 0.5, width = 0.1 → ratio = 0.2
    expect(normalizedCIWidth(0.45, 0.55, 0.5)).toBeCloseTo(0.2, 10);
  });

  it("applies epsilon floor 0.05 when pModel is tiny (long-shot Away)", () => {
    // Tiny pModel=0.001 without epsilon would explode ratio
    // With floor max(0.001, 0.05)=0.05, width 0.01 → ratio 0.2
    const r = normalizedCIWidth(0.001, 0.011, 0.001);
    expect(r).toBeCloseTo(0.01 / 0.05, 10);
    expect(isFinite(r)).toBe(true);
  });

  it("large CI produces ratio > 1 (clamp responsibility on caller)", () => {
    // pModel=0.3, width=0.6 → ratio 2.0
    const r = normalizedCIWidth(0.0, 0.6, 0.3);
    expect(r).toBeCloseTo(2.0, 10);
  });
});

describe("kellyFraction with varianceHaircut", () => {
  // pEigen=0.55, quote=2.0 → raw k = (0.55*2 - 1)/(2-1) = 0.10
  // With fraction=0.33 → k * frac = 0.033 (under 4% M-cap)

  it("haircut=1 → identical to no-haircut (default behavior)", () => {
    const a = kellyFraction(0.55, 2.0, 0.33);
    const b = kellyFraction(0.55, 2.0, 0.33, 1);
    expect(a).toBeCloseTo(b, 10);
  });

  it("haircut=0.5 → Kelly exactly halved (but still under cap)", () => {
    const full = kellyFraction(0.55, 2.0, 0.33, 1);
    const half = kellyFraction(0.55, 2.0, 0.33, 0.5);
    expect(half).toBeCloseTo(full * 0.5, 10);
  });

  it("haircut clamped to [0.5, 1.0] — over-shrink ignored", () => {
    // haircut=0 should be treated as 0.5
    const half = kellyFraction(0.55, 2.0, 0.33, 0.5);
    const underflow = kellyFraction(0.55, 2.0, 0.33, 0);
    expect(underflow).toBeCloseTo(half, 10);
  });

  it("haircut clamped upward — 1.5 treated as 1.0", () => {
    const full = kellyFraction(0.55, 2.0, 0.33, 1);
    const overflow = kellyFraction(0.55, 2.0, 0.33, 1.5);
    expect(overflow).toBeCloseTo(full, 10);
  });

  it("cap still applies after haircut (aggressive profile + huge edge)", () => {
    // pEigen=0.9, quote=3.0 → k = (0.9*3 - 1)/2 = 0.85
    // aggressive fraction=0.5 → k*frac = 0.425 — capped at 0.06
    const noHaircut = kellyFraction(0.9, 3.0, 0.5, 1);
    const withHaircut = kellyFraction(0.9, 3.0, 0.5, 0.5);
    expect(noHaircut).toBeCloseTo(0.06, 10);
    // haircut reduces k*frac from 0.425 → 0.2125 — still over 0.06 cap
    expect(withHaircut).toBeCloseTo(0.06, 10);
  });

  it("edge-case: tiny pModel with wide CI does not produce NaN", () => {
    const w = normalizedCIWidth(0.001, 0.011, 0.001);
    const haircut = Math.max(0.5, Math.min(1, 1 - 0.5 * w));
    const k = kellyFraction(0.01, 50, 0.33, haircut);
    expect(isFinite(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
  });
});

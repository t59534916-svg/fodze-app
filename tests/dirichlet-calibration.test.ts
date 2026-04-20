import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDirichletCalibration,
  applyDirichlet,
  setCalibrationMethod,
  getCalibrationMethod,
  isDirichletLoaded,
  resetDirichlet,
  calibrate1X2,
  type DirichletCalibrationJSON,
} from "@/lib/calibration";

const identity: DirichletCalibrationJSON = {
  _version: 1,
  cluster_map: { bundesliga: "top5", liga3: "lower" },
  global:   { W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 0, 0] },
  clusters: {
    top5:         { W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 0, 0] },
    mid_european: { W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 0, 0] },
    lower:        { W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 0, 0] },
  },
};

// Non-identity: a shrink-toward-uniform weight (diagonal < 1) — smoothing.
const shrinkage: DirichletCalibrationJSON = {
  _version: 1,
  cluster_map: { bundesliga: "top5" },
  global:   { W: [[0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]], b: [0, 0, 0] },
  clusters: {
    top5: { W: [[0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]], b: [0, 0, 0] },
  },
};

describe("loadDirichletCalibration", () => {
  beforeEach(() => resetDirichlet());

  it("throws on missing _version", () => {
    expect(() => loadDirichletCalibration({} as any)).toThrow();
  });

  it("throws on wrong W shape (not 3×3)", () => {
    const bad = { ...identity, global: { W: [[1, 0], [0, 1]], b: [0, 0] } } as any;
    expect(() => loadDirichletCalibration(bad)).toThrow();
  });

  it("throws on wrong b length", () => {
    const bad = { ...identity, global: { W: identity.global.W, b: [0, 0] } } as any;
    expect(() => loadDirichletCalibration(bad)).toThrow();
  });

  it("accepts a valid payload and marks loaded", () => {
    expect(isDirichletLoaded()).toBe(false);
    loadDirichletCalibration(identity);
    expect(isDirichletLoaded()).toBe(true);
  });
});

describe("applyDirichlet", () => {
  beforeEach(() => resetDirichlet());

  it("passthrough when nothing loaded", () => {
    const out = applyDirichlet({ H: 0.5, D: 0.3, A: 0.2 }, "bundesliga");
    expect(out.applied).toBe(false);
    expect(out.H).toBe(0.5);
    expect(out.D).toBe(0.3);
    expect(out.A).toBe(0.2);
  });

  it("identity W + zero b returns input unchanged (± 1e-9)", () => {
    loadDirichletCalibration(identity);
    const out = applyDirichlet({ H: 0.55, D: 0.25, A: 0.20 }, "bundesliga");
    expect(out.applied).toBe(true);
    expect(out.cluster).toBe("top5");
    expect(out.H).toBeCloseTo(0.55, 6);
    expect(out.D).toBeCloseTo(0.25, 6);
    expect(out.A).toBeCloseTo(0.20, 6);
  });

  it("shrinks extreme probs toward uniform with diag<1", () => {
    loadDirichletCalibration(shrinkage);
    const out = applyDirichlet({ H: 0.80, D: 0.15, A: 0.05 }, "bundesliga");
    expect(out.applied).toBe(true);
    // H was the largest before → should still be largest, but less extreme.
    expect(out.H).toBeLessThan(0.80);
    expect(out.H).toBeGreaterThan(out.D);
    expect(out.H + out.D + out.A).toBeCloseTo(1.0, 6);
  });

  it("uses cluster_map lookup for known leagues", () => {
    loadDirichletCalibration(identity);
    const out = applyDirichlet({ H: 0.5, D: 0.3, A: 0.2 }, "liga3");
    expect(out.cluster).toBe("lower");
  });

  it("falls back to global when the league isn't in cluster_map", () => {
    loadDirichletCalibration(identity);
    const out = applyDirichlet({ H: 0.5, D: 0.3, A: 0.2 }, "nonexistent");
    expect(out.cluster).toBe("global");
  });

  it("handles zero-probability input without NaN (log-floor)", () => {
    loadDirichletCalibration(identity);
    const out = applyDirichlet({ H: 0.999, D: 0.0005, A: 0.0005 }, "bundesliga");
    expect(Number.isFinite(out.H)).toBe(true);
    expect(Number.isFinite(out.D)).toBe(true);
    expect(Number.isFinite(out.A)).toBe(true);
    expect(out.H + out.D + out.A).toBeCloseTo(1.0, 6);
  });
});

describe("calibrate1X2 dispatch", () => {
  beforeEach(() => {
    resetDirichlet();
    setCalibrationMethod("platt");
  });

  it("uses Platt path when method=platt (current default)", () => {
    expect(getCalibrationMethod()).toBe("platt");
    const out = calibrate1X2(0.5, 0.3, 0.2, "bundesliga");
    expect(out.H + out.D + out.A).toBeCloseTo(1.0, 5);
  });

  it("uses Dirichlet path when method=dirichlet AND params loaded", () => {
    loadDirichletCalibration(identity);
    setCalibrationMethod("dirichlet");
    expect(getCalibrationMethod()).toBe("dirichlet");
    // Identity matrix means output ≈ input (after soft clamp).
    const out = calibrate1X2(0.55, 0.25, 0.20, "bundesliga");
    expect(out.H).toBeCloseTo(0.55, 3);
    expect(out.D).toBeCloseTo(0.25, 3);
    expect(out.A).toBeCloseTo(0.20, 3);
  });

  it("falls back to Platt when method=dirichlet but nothing loaded", () => {
    setCalibrationMethod("dirichlet");
    // No Dirichlet loaded → calibrate1X2 should still return a valid
    // distribution via Platt/Isotonic fallback.
    const out = calibrate1X2(0.5, 0.3, 0.2, "bundesliga");
    expect(out.H + out.D + out.A).toBeCloseTo(1.0, 5);
  });

  it("D-clamp is skipped in Dirichlet path (no Platt-specific workaround)", () => {
    // Platt-path has a D-clamp at 0.38; Dirichlet trusts its joint fit.
    // With identity matrix + a high-D input, Dirichlet returns ~0.50,
    // Platt would clamp to 0.38.
    loadDirichletCalibration(identity);
    setCalibrationMethod("dirichlet");
    const out = calibrate1X2(0.30, 0.50, 0.20, "bundesliga");
    // Under identity: input ≈ output (after H/A cap ≤ 0.95 and re-norm).
    expect(out.D).toBeGreaterThan(0.38);
  });

  it("H/A hard-cap (0.95) still applies in Dirichlet path (data-safety)", () => {
    loadDirichletCalibration(identity);
    setCalibrationMethod("dirichlet");
    // Pathological input (H near 1.0) — cap at 0.95.
    const out = calibrate1X2(0.98, 0.01, 0.01, "bundesliga");
    expect(out.H).toBeLessThanOrEqual(0.95);
    expect(out.H + out.D + out.A).toBeCloseTo(1.0, 5);
  });
});

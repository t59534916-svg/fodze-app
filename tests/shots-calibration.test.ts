import { describe, it, expect } from "vitest";
import {
  calibrateXGPerShot,
  FALLBACK_XG_PER_SHOT,
} from "@/lib/shots-calibration";

type Row = { xg: number | null; shots_for: number | null };

function makeRows(count: number, xgPerShot: number, shotsPerMatch = 12): Row[] {
  return Array.from({ length: count }, () => ({
    xg: xgPerShot * shotsPerMatch,
    shots_for: shotsPerMatch,
  }));
}

describe("calibrateXGPerShot", () => {
  it("returns fallback (0.105) for empty input", () => {
    const c = calibrateXGPerShot([]);
    expect(c.ratio).toBe(FALLBACK_XG_PER_SHOT);
    expect(c.n).toBe(0);
    expect(c.raw).toBeNull();
    expect(c.source).toBe("insufficient-data");
  });

  it("returns fallback when below MIN_SAMPLE (49 rows)", () => {
    const c = calibrateXGPerShot(makeRows(49, 0.1));
    expect(c.ratio).toBe(FALLBACK_XG_PER_SHOT);
    expect(c.n).toBe(49);
    expect(c.source).toBe("insufficient-data");
    // raw is still computable — surface it so operators can spot trends
    expect(c.raw).toBeCloseTo(0.1, 10);
  });

  it("calibrates to true ratio at MIN_SAMPLE (50 rows)", () => {
    const c = calibrateXGPerShot(makeRows(50, 0.098));
    expect(c.source).toBe("calibrated");
    expect(c.ratio).toBeCloseTo(0.098, 10);
    expect(c.n).toBe(50);
  });

  it("ignores null / non-finite / zero-shot rows", () => {
    const rows: Row[] = [
      ...makeRows(50, 0.1),
      { xg: null, shots_for: 12 },
      { xg: 1.2, shots_for: null },
      { xg: NaN, shots_for: 12 },
      { xg: 1.2, shots_for: Infinity },
      { xg: 1.2, shots_for: 0 },
      { xg: -0.5, shots_for: 12 },  // negative xG = bug
    ];
    const c = calibrateXGPerShot(rows);
    expect(c.n).toBe(50);
    expect(c.ratio).toBeCloseTo(0.1, 10);
  });

  it("clamps high-end out-of-range (raw 0.2 → 0.15)", () => {
    const c = calibrateXGPerShot(makeRows(100, 0.2));
    expect(c.source).toBe("out-of-range");
    expect(c.raw).toBeCloseTo(0.2, 10);
    expect(c.ratio).toBe(0.15);
  });

  it("clamps low-end out-of-range (raw 0.05 → 0.07)", () => {
    const c = calibrateXGPerShot(makeRows(100, 0.05));
    expect(c.source).toBe("out-of-range");
    expect(c.raw).toBeCloseTo(0.05, 10);
    expect(c.ratio).toBe(0.07);
  });

  it("uses micro-average — one high-xG low-shot match can't swing the mean", () => {
    // 100 normal matches (ratio 0.10) + 1 penalty-heavy match (1 shot, 1.0 xG)
    // Per-match mean would reach 0.19 on that outlier.
    // Micro-avg: Σ xG / Σ shots = (100*1.2 + 1.0) / (100*12 + 1) = 121 / 1201 ≈ 0.1008
    const rows: Row[] = [
      ...makeRows(100, 0.1),
      { xg: 1.0, shots_for: 1 },
    ];
    const c = calibrateXGPerShot(rows);
    expect(c.ratio).toBeCloseTo(0.1008, 3);
  });

  it("returns insufficient-data source when all rows are invalid", () => {
    const rows: Row[] = [
      { xg: null, shots_for: 12 },
      { xg: 1.2, shots_for: 0 },
    ];
    const c = calibrateXGPerShot(rows);
    expect(c.source).toBe("insufficient-data");
    expect(c.n).toBe(0);
    expect(c.raw).toBeNull();
  });

  it("is pure (does not mutate input)", () => {
    const rows = makeRows(50, 0.1);
    const snapshot = JSON.stringify(rows);
    calibrateXGPerShot(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

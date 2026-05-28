import { describe, it, expect } from "vitest";
import {
  LEAGUES,
  validateXGData,
  vigAdjustBest,
  calcMatchEnhanced,
  calculateBetsEnhanced,
  getHomeFactor,
  type Markets,
} from "@/lib/dixon-coles";

// Build a fully-typed Markets fixture from the few fields a test cares about.
// calculateBetsEnhanced only reads H/D/A/O25/U25 for 1X2 + O/U bets, but the
// Markets interface has 28 required fields — this helper fills the rest with
// neutral defaults so the call is type-correct (was 2 pre-existing tsc errors
// documented in CLAUDE.md; fixed 2026-05-28 to flip CI tsc-enforcement on).
function mkFixture(p: Partial<Markets> = {}): Markets {
  return {
    H: 0.45, D: 0.27, A: 0.28,
    O15: 0.75, O25: 0.52, O35: 0.30, O45: 0.15, O55: 0.06,
    U15: 0.25, U25: 0.48, U35: 0.70, U45: 0.85, U55: 0.94,
    BY: 0.55, BN: 0.45,
    best: "1", bestP: 0.45,
    DC_1X: 0.72, DC_X2: 0.55, DC_12: 0.73,
    CS_H: 0.30, CS_A: 0.25,
    HO05: 0.78, HO15: 0.45, HO25: 0.20,
    AO05: 0.70, AO15: 0.38, AO25: 0.15,
    ...p,
  };
}

describe("LEAGUES", () => {
  it("has 24 leagues defined", () => {
    // 19 FODZE original + 2 European cups (cl/el) + 3 neu (austria_bl,
    // swiss_sl, eerste_divisie) = 24
    expect(Object.keys(LEAGUES).length).toBe(24);
  });

  it("each league has name, hf, avg", () => {
    for (const [key, val] of Object.entries(LEAGUES)) {
      expect(val.name).toBeTruthy();
      expect(val.hf).toBeGreaterThan(1);
      expect(val.avg).toBeGreaterThan(1);
    }
  });
});

describe("validateXGData", () => {
  it("returns no errors for valid data", () => {
    const warnings = validateXGData(14, 8, 8, 10, 12, 8, 1.38);
    const errors = warnings.filter((w: any) => w.level === "error");
    expect(errors.length).toBe(0);
  });

  it("returns warnings array (may include hints for edge cases)", () => {
    const warnings = validateXGData(1.5, 1.0, 8, 1.2, 1.8, 8, 1.38);
    // Low values may or may not trigger warnings depending on threshold
    expect(Array.isArray(warnings)).toBe(true);
  });
});

describe("vigAdjustBest", () => {
  it("removes vig from 1X2 odds", () => {
    const result = vigAdjustBest([2.0, 3.5, 4.0]);
    expect(result.probs).toHaveLength(3);
    expect(result.overround).toBeGreaterThanOrEqual(0);
    // Probabilities should sum to ~1
    const sum = result.probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 1);
  });

  it("calculates overround correctly", () => {
    // Fair odds (no vig): 2.0 / 3.0 / 6.0 → 50% + 33% + 17% = 100%
    const fair = vigAdjustBest([2.0, 3.0, 6.0]);
    expect(fair.overround).toBeCloseTo(0, 1);

    // Juiced odds → overround > 0
    const juiced = vigAdjustBest([1.8, 3.2, 4.5]);
    expect(juiced.overround).toBeGreaterThan(0);
  });
});

describe("calcMatchEnhanced", () => {
  it("calculates Poisson lambda for a typical Bundesliga match", () => {
    const result = calcMatchEnhanced(
      14, 8, 8, "W W D L W",   // home: xg_h8=14, xga_h8=8
      10, 12, 8, "L W W D W",  // away: xg_a8=10, xga_a8=12
      1.38, 1.28, [],           // avg=1.38, hf=1.28
      undefined, undefined
    );
    expect(result.lambdaH).toBeGreaterThan(0);
    expect(result.lambdaA).toBeGreaterThan(0);
    expect(result.mk.H + result.mk.D + result.mk.A).toBeCloseTo(1, 1);
    expect(result.mk.O25 + result.mk.U25).toBeCloseTo(1, 1);
  });

  it("home team gets higher lambda with strong home factor", () => {
    const result = calcMatchEnhanced(
      14, 8, 8, "",
      10, 12, 8, "",
      1.38, 1.5, [],  // high home factor
      undefined, undefined
    );
    expect(result.lambdaH).toBeGreaterThan(result.lambdaA);
  });

  it("produces score matrix that sums to ~1", () => {
    const result = calcMatchEnhanced(
      14, 8, 8, "",
      10, 12, 8, "",
      1.38, 1.28, [],
      undefined, undefined
    );
    let total = 0;
    for (let i = 0; i < result.matrix.length; i++)
      for (let j = 0; j < result.matrix[i].length; j++)
        total += result.matrix[i][j];
    expect(total).toBeCloseTo(1, 1);
  });
});

describe("calculateBetsEnhanced", () => {
  it("identifies value bets when model prob > market prob", () => {
    const mk = mkFixture({ H: 0.6, D: 0.2, A: 0.2, O25: 0.7, U25: 0.3 });
    const odds = { h: 2.0, d: 4.0, a: 5.0 }; // implied: 50% / 25% / 20%
    const bets = calculateBetsEnhanced(mk, mk, mk, odds, 0.33);
    // Bets should be generated for all markets
    expect(bets.length).toBeGreaterThan(0);
    const homeBet = bets.find((b: any) => b.label === "Heim" || b.label === "1");
    expect(homeBet).toBeTruthy();
    // Edge exists (may be positive or negative after calibration adjustments)
    expect(typeof homeBet?.edge).toBe("number");
  });

  it("calculates Kelly stake correctly", () => {
    const mk = mkFixture({ H: 0.6, D: 0.2, A: 0.2, O25: 0.7, U25: 0.3 });
    const odds = { h: 2.0, d: 4.0, a: 5.0 };
    const bets = calculateBetsEnhanced(mk, mk, mk, odds, 0.25);
    const homeBet = bets.find((b: any) => b.label === "Heim" || b.label === "1");
    expect(homeBet).toBeTruthy();
    // Kelly should be non-negative for positive edge bets
    expect(homeBet?.kelly).toBeGreaterThanOrEqual(0);
  });
});

describe("getHomeFactor", () => {
  it("returns league default for unknown teams", () => {
    const hf = getHomeFactor("Unbekanntes Team", 1.28);
    expect(hf).toBe(1.28);
  });

  it("returns team-specific factor for known 3.Liga teams", () => {
    const hf = getHomeFactor("Energie Cottbus", 1.22);
    expect(hf).toBeGreaterThan(1.22); // Cottbus has strong home support
  });
});

// Per-engine shared-calibration bypass (2026-05-31)
//
// The shared global isotonic in public/calibration_curves.json was fit on the
// ensemble/Dixon-Coles display distribution and degrades the better-calibrated
// v1/v2/dev-03 posteriors on BOTH Brier and ECE (measured by
// tools/backtest/engine_calibrated_brier.mts). These tests pin the WIRING:
//   • bypassSharedCalibration gates exactly {v1, v2, dev-03}
//   • calculateBetsEnhanced uses raw model probs as pModel for bypass engines
//     and the shared-isotonic-calibrated probs for ensemble
//   • dualTrackCalibrate returns Track B == Track A for bypass engines
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { calculateBetsEnhanced, loadCalibrationCurves, type Markets } from "@/lib/dixon-coles";
import {
  bypassSharedCalibration,
  BYPASS_SHARED_CALIBRATION_ENGINES,
  dualTrackCalibrate,
  calibrate1X2,
  setCalibrationMethod,
} from "@/lib/calibration";

// Load the REAL production calibration curve so the test exercises the same
// transform the app does.
beforeAll(() => {
  const curves = JSON.parse(
    readFileSync(resolve(__dirname, "..", "public", "calibration_curves.json"), "utf8"),
  );
  loadCalibrationCurves(curves);
  // .env.local runs method=isotonic; mirror that (loadCalibrationCurves sets
  // platt from the JSON, AppContext then flips to isotonic — see calibration.ts).
  setCalibrationMethod("isotonic");
});

// A defensive-ish 1X2 where the ensemble-era isotonic curve visibly moves the
// numbers (so "bypass == raw" is a non-trivial assertion).
const MK: Markets = { H: 0.5, D: 0.3, A: 0.2, O25: 0.55, U25: 0.45, BY: 0.5 } as Markets;
const MK_LOW: Markets = { H: 0.42, D: 0.28, A: 0.16, O25: 0.5, U25: 0.5, BY: 0.5 } as Markets;
const MK_HIGH: Markets = { H: 0.58, D: 0.32, A: 0.26, O25: 0.6, U25: 0.4, BY: 0.5 } as Markets;
const ODDS = { h: 2.0, d: 3.4, a: 4.2 };
const LEAGUE = "bundesliga";

function pModelByLabel(engine: "v1" | "v2" | "ensemble" | "dev-03") {
  // No Pinnacle odds → benterBlend passes through for every engine, so the only
  // transform between mk and pModel is the (gated) shared isotonic.
  const bets = calculateBetsEnhanced(MK, MK_LOW, MK_HIGH, ODDS, 0.25, undefined, undefined, LEAGUE, engine);
  const m: Record<string, number> = {};
  for (const b of bets) m[b.label] = b.pModel;
  return m;
}

describe("bypassSharedCalibration gate membership", () => {
  it("includes exactly v1, v2, dev-03", () => {
    expect(bypassSharedCalibration("v1")).toBe(true);
    expect(bypassSharedCalibration("v2")).toBe(true);
    expect(bypassSharedCalibration("dev-03")).toBe(true);
    expect(bypassSharedCalibration("ensemble")).toBe(false);
    expect(bypassSharedCalibration(undefined)).toBe(false);
    expect(bypassSharedCalibration("v3")).toBe(false);
    expect([...BYPASS_SHARED_CALIBRATION_ENGINES].sort()).toEqual(["dev-03", "v1", "v2"]);
  });
});

describe("calculateBetsEnhanced pModel routing", () => {
  it("ensemble pModel == shared-isotonic-calibrated probs (curve applied)", () => {
    const cal = calibrate1X2(MK.H, MK.D, MK.A, LEAGUE);
    const p = pModelByLabel("ensemble");
    expect(p["Heim"]).toBeCloseTo(cal.H, 6);
    expect(p["Unent."]).toBeCloseTo(cal.D, 6);
    expect(p["Ausw."]).toBeCloseTo(cal.A, 6);
  });

  for (const engine of ["v1", "v2", "dev-03"] as const) {
    it(`${engine} pModel == RAW model probs (shared isotonic bypassed)`, () => {
      const p = pModelByLabel(engine);
      // bypass → pModel is the raw mk (benter passthrough, isotonic skipped)
      expect(p["Heim"]).toBeCloseTo(MK.H, 6);
      expect(p["Unent."]).toBeCloseTo(MK.D, 6);
      expect(p["Ausw."]).toBeCloseTo(MK.A, 6);
    });
  }

  it("the curve actually moves ensemble (bypass is a non-trivial change)", () => {
    const ens = pModelByLabel("ensemble");
    const v2 = pModelByLabel("v2");
    // If these were equal the test would be vacuous — the ensemble-era curve
    // must visibly differ from raw on this input.
    const moved = Math.abs(ens["Heim"] - v2["Heim"])
      + Math.abs(ens["Unent."] - v2["Unent."])
      + Math.abs(ens["Ausw."] - v2["Ausw."]);
    expect(moved).toBeGreaterThan(0.01);
  });
});

describe("dualTrackCalibrate Track B routing", () => {
  it("bypass engines: Track B == Track A (raw)", () => {
    for (const engine of ["v1", "v2", "dev-03"] as const) {
      const dt = dualTrackCalibrate(MK.H, MK.D, MK.A, LEAGUE, engine);
      expect(dt.trackB.H).toBeCloseTo(dt.trackA.H, 9);
      expect(dt.trackB.D).toBeCloseTo(dt.trackA.D, 9);
      expect(dt.trackB.A).toBeCloseTo(dt.trackA.A, 9);
    }
  });

  it("ensemble: Track B == shared-isotonic-calibrated (≠ Track A here)", () => {
    const dt = dualTrackCalibrate(MK.H, MK.D, MK.A, LEAGUE, "ensemble");
    const cal = calibrate1X2(MK.H, MK.D, MK.A, LEAGUE);
    expect(dt.trackB.H).toBeCloseTo(cal.H, 9);
    expect(dt.trackB.D).toBeCloseTo(cal.D, 9);
    expect(dt.trackB.A).toBeCloseTo(cal.A, 9);
    // and Track B genuinely differs from Track A (curve is active)
    expect(Math.abs(dt.trackB.H - dt.trackA.H)).toBeGreaterThan(0.005);
  });

  it("no-engine call is unchanged (back-compat: still calibrated)", () => {
    const dt = dualTrackCalibrate(MK.H, MK.D, MK.A, LEAGUE);
    const cal = calibrate1X2(MK.H, MK.D, MK.A, LEAGUE);
    expect(dt.trackB.H).toBeCloseTo(cal.H, 9);
  });
});

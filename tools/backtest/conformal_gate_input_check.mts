// Regression guard: the Conformal staking gate receives CALIBRATED probs for
// bypass engines (v1/v2/dev-03), NOT their raw posterior. (2026-05-31)
//
// Context: the per-engine calibration bypass (bypassSharedCalibration) makes
// v1/v2/dev-03 use their RAW posterior as the Kelly pModel — the shared
// ensemble-era curve degrades their Brier+ECE. But the Mondrian conformal
// quantiles (public/conformal-quantiles.json) were fit on CALIBRATED probs, so
// calculateBetsEnhanced must keep feeding the 1X2 gate the calibrated probs
// (`calIso`), restoring the gate's exact pre-bypass input. That makes a future
// NEXT_PUBLIC_CONFORMAL_GATE=enforce|dampen flip behave identically for bypass
// engines with no per-engine quantile refit. Today the gate is `warn` (factor
// 1.0) so this has zero live effect — this check flips it to `dampen` to make
// the wiring observable and guard against a future "simplify calIso back to cal"
// regression.
//
// WHY THIS IS A .mts HARNESS, NOT A tests/*.test.ts:
// calculateBetsEnhanced run under an ACTIVE conformal mode reliably trips a
// vitest worker-pool quirk ("Not all promises returned by utils.runMode() were
// awaited") ONLY at full-suite scale (53+ files) — it passes in isolation and in
// pairs. conformalGate/conformalKellyFactor are pure synchronous functions (no
// bug). Rather than destabilise the 900+ test suite for a guard on an inert gate,
// this lives as an on-demand harness (same pattern as engine_calibrated_brier.mts).
//
// Run:
//   npx vitest run --config tools/backtest/conformal-input.vitest.config.mts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

import { calculateBetsEnhanced, loadCalibrationCurves, type Markets } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod } from "@/lib/calibration";
import {
  loadConformalQuantiles,
  setConformalMode,
  conformalKellyFactor,
} from "@/lib/conformal-gate";
import { resetBenterBlend } from "@/lib/benter-blend";

const REPO = resolve(__dirname, "..", "..");
const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));

it("conformal gate sees CALIBRATED probs (not raw) for bypass engine v2", () => {
  // Production init (mirror AppContext): isotonic method + curves + quantiles.
  loadCalibrationCurves(readJson("public/calibration_curves.json"));
  setCalibrationMethod("isotonic");
  loadConformalQuantiles(readJson("public/conformal-quantiles.json"));
  resetBenterBlend(); // benter off → blended == raw mk → calIso = calibrate1X2(mk)

  // Favorite with positive edge so kelly_off > 0 (ratio well-defined).
  const mk: Markets = { H: 0.6, D: 0.25, A: 0.15, O25: 0.55, U25: 0.45, BY: 0.5 } as Markets;
  const mkLow: Markets = { H: 0.5, D: 0.22, A: 0.12, O25: 0.5, U25: 0.5, BY: 0.5 } as Markets;
  const mkHigh: Markets = { H: 0.7, D: 0.28, A: 0.18, O25: 0.6, U25: 0.4, BY: 0.5 } as Markets;
  const odds = { h: 2.2, d: 3.6, a: 6.0 }; // h implied ≈0.45 vig-free < model 0.6 → +edge
  const rawProbs = { H: mk.H, D: mk.D, A: mk.A };

  // Find a league where the gate's dampen factor DIFFERS between calibrated and
  // raw probs — that's where the wiring is observable. (If none differ the gate
  // can't distinguish the two inputs and the check would be vacuous.)
  const LEAGUES = [
    "bundesliga", "epl", "la_liga", "serie_a", "ligue_1", "eredivisie",
    "primeira_liga", "scottish_prem", "jupiler_pro", "super_lig",
    "championship", "bundesliga2", "serie_b", "greek_sl",
  ];
  setConformalMode("dampen");
  let discrim: { lg: string; fCal: number; fRaw: number } | null = null;
  for (const lg of LEAGUES) {
    const calp = calibrate1X2(mk.H, mk.D, mk.A, lg);
    const fCal = conformalKellyFactor({ H: calp.H, D: calp.D, A: calp.A }, lg);
    const fRaw = conformalKellyFactor(rawProbs, lg);
    if (Math.abs(fCal - fRaw) > 1e-9) { discrim = { lg, fCal, fRaw }; break; }
  }
  expect(
    discrim,
    "expected ≥1 league where calibrated vs raw give different conformal factors",
  ).not.toBeNull();
  const { lg, fCal, fRaw } = discrim!;

  // Run the bypass engine (v2) twice: conformal off (factor 1) vs dampen. The
  // only term differing between the runs is the conformal factor, so
  // kelly_dampen / kelly_off == that factor — no need to reconstruct Kelly.
  setConformalMode("off");
  const off = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.25, undefined, undefined, lg, "v2");
  setConformalMode("dampen");
  const dmp = calculateBetsEnhanced(mk, mkLow, mkHigh, odds, 0.25, undefined, undefined, lg, "v2");

  // Conformal factor is per-match (one set-size for the whole 1X2 vector), so
  // every outcome with positive base kelly must scale by that same factor.
  let checked = 0;
  for (const label of ["Heim", "Unent.", "Ausw."]) {
    const bOff = off.find(b => b.label === label)!;
    const bDmp = dmp.find(b => b.label === label)!;
    if (bOff.kelly <= 1e-9) continue;
    const ratio = bDmp.kelly / bOff.kelly;
    expect(ratio).toBeCloseTo(fCal, 6);                     // tracks CALIBRATED gate
    expect(Math.abs(ratio - fRaw)).toBeGreaterThan(1e-6);   // NOT the raw gate
    checked++;
  }
  expect(checked, "no positive-edge outcome to verify the ratio on").toBeGreaterThan(0);

  setConformalMode("off"); // tidy module state
});

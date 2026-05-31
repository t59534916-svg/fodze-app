// B2 of the runtime-faithful conformal re-fit (option B).
//
// Runs the REAL production calibration over the B1 raw probs, so the conformal
// quantiles get fit on EXACTLY the distribution the runtime gate scores —
// eliminating the Python-reimplementation mismatch class. Mirrors AppContext's
// startup init verbatim (loadCalibrationCurves → setBenterMode/loadBenterWeights
// → setCalibrationMethod from NEXT_PUBLIC_CALIBRATION_METHOD), then computes
//   cal = calibrate1X2(benterBlend(raw, null, "v2", league))
// which is what conformalKellyFactor() receives at dixon-coles.ts:1054.
//
// Not named *.test.ts on purpose → invisible to `npm run test`. Run via:
//   npx vitest run --config tools/backtest/conformal.vitest.config.mts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

import { loadCalibrationCurves } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod, loadDirichletCalibration } from "@/lib/calibration";
import { benterBlend, loadBenterWeights, setBenterMode } from "@/lib/benter-blend";

const REPO = resolve(__dirname, "..", "..");
const RAW_IN = resolve(REPO, "tools/backtest/.conformal_raw.json");
const CAL_OUT = resolve(REPO, "tools/backtest/.conformal_calibrated.json");

function readJson(p: string) {
  return JSON.parse(readFileSync(p, "utf8"));
}

it("compute production-faithful calibrated 1X2 for the OOT corpus", () => {
  // ── replicate AppContext init (the production startup sequence) ──
  loadCalibrationCurves(readJson(resolve(REPO, "public/calibration_curves.json")));

  const benterMode = (process.env.NEXT_PUBLIC_BENTER_BLEND || "on").toLowerCase();
  setBenterMode(benterMode === "shadow" ? "shadow" : benterMode === "on" ? "on" : "off");
  if (benterMode !== "off") {
    loadBenterWeights(readJson(resolve(REPO, "public/benter-weights.json")));
  }

  const calMethod = (process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "isotonic").toLowerCase();
  if (calMethod === "dirichlet") {
    loadDirichletCalibration(readJson(resolve(REPO, "public/dirichlet-calibration.json")));
    setCalibrationMethod("dirichlet");
  } else {
    setCalibrationMethod(calMethod === "platt" ? "platt" : "isotonic");
  }

  const rows: Array<{ league: string; match_date: string; ft_result: string; raw: number[] }> =
    readJson(RAW_IN);

  let benterChanged = 0;
  let calChanged = 0;
  const out = rows.map((r) => {
    const [h, d, a] = r.raw;
    const bl = benterBlend({ H: h, D: d, A: a }, null, "v2", r.league); // null pinn: v2 β=(1,0) ⇒ no-op
    if (Math.abs(bl.H - h) > 1e-9) benterChanged++;
    const cal = calibrate1X2(bl.H, bl.D, bl.A, r.league);
    if (Math.abs(cal.H - h) > 1e-4 || Math.abs(cal.D - d) > 1e-4 || Math.abs(cal.A - a) > 1e-4) calChanged++;
    return { league: r.league, match_date: r.match_date, ft_result: r.ft_result, cal: [cal.H, cal.D, cal.A] };
  });

  writeFileSync(CAL_OUT, JSON.stringify(out));

  // surface what the pipeline actually did (printed in vitest stdout)
  console.log(`[B2] init: benter=${benterMode} calMethod=${calMethod}`);
  console.log(`[B2] rows=${rows.length} · benter changed ${benterChanged} (expect ~0 for v2 β=(1,0)) · ` +
    `calibration changed ${calChanged} (${((100 * calChanged) / rows.length).toFixed(0)}%)`);
  // a couple of concrete examples raw→cal so the transform is auditable
  for (const i of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    const r = rows[i]; const c = out[i].cal;
    console.log(`[B2]   ${r.league} ${r.match_date}: raw [${r.raw.map((x) => x.toFixed(3)).join(",")}] ` +
      `→ cal [${c.map((x: number) => x.toFixed(3)).join(",")}]`);
  }

  expect(out.length).toBe(rows.length);
  expect(out.every((o) => Math.abs(o.cal[0] + o.cal[1] + o.cal[2] - 1) < 1e-6)).toBe(true);
});

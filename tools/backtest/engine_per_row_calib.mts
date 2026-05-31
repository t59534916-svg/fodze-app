// Per-row production-faithful calibration of each parquet engine's raw 1X2, so
// Python can compute raw-vs-calibrated Brier + ECE + reliability (calibration
// mis-fit audit). Runs the REAL calibrate1X2 (active path = hardcoded global
// isotonic curves; JSON Platt is dead under the env override). Out of CI.
//   npx vitest run --config tools/backtest/calib-audit.vitest.config.mts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";
import { loadCalibrationCurves } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod, loadDirichletCalibration, getCalibrationMethod } from "@/lib/calibration";
import { benterBlend, loadBenterWeights, setBenterMode } from "@/lib/benter-blend";
const REPO = resolve(__dirname, "..", "..");
const j = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
it("per-row calibrated 1X2 for parquet engines", () => {
  loadCalibrationCurves(j("public/calibration_curves.json"));
  setBenterMode("on"); loadBenterWeights(j("public/benter-weights.json"));
  const m = (process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "isotonic").toLowerCase();
  if (m === "dirichlet") { loadDirichletCalibration(j("public/dirichlet-calibration.json")); setCalibrationMethod("dirichlet"); }
  else setCalibrationMethod(m === "platt" ? "platt" : "isotonic");
  const rows: Array<{ engine: string; ekey: string; league: string; ft_result: string; raw: number[] }> =
    j("tools/backtest/.engine_raw.json");
  const out = rows.map((r) => {
    const [h, d, a] = r.raw;
    const bl = benterBlend({ H: h, D: d, A: a }, null, r.ekey as any, r.league);
    const c = calibrate1X2(bl.H, bl.D, bl.A, r.league);
    return { engine: r.engine, ft_result: r.ft_result, raw: r.raw, cal: [c.H, c.D, c.A] };
  });
  writeFileSync(resolve(REPO, "tools/backtest/.engine_calib_rows.json"),
    JSON.stringify({ active_method: getCalibrationMethod(), rows: out }));
  expect(out.length).toBe(rows.length);
});

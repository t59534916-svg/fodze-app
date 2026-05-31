import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";
import { loadCalibrationCurves } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod, getCalibrationMethod } from "@/lib/calibration";
import { benterBlend, loadBenterWeights, setBenterMode } from "@/lib/benter-blend";
const REPO = resolve(__dirname, "..", "..");
const j = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
it("dev-03 raw → real calibrate1X2", () => {
  loadCalibrationCurves(j("public/calibration_curves.json"));
  setBenterMode("on"); loadBenterWeights(j("public/benter-weights.json"));
  setCalibrationMethod("isotonic");
  const rows: Array<{ ft_result: string; raw: number[] }> = j("tools/backtest/.dev03_raw.json");
  const out = rows.map((r) => {
    const [h, d, a] = r.raw;
    const bl = benterBlend({ H: h, D: d, A: a }, null, "dev-03" as any); // dev-03 → passthrough
    const c = calibrate1X2(bl.H, bl.D, bl.A);
    return { ft_result: r.ft_result, raw: r.raw, cal: [c.H, c.D, c.A] };
  });
  writeFileSync(resolve(REPO, "tools/backtest/.dev03_calib_rows.json"),
    JSON.stringify({ active_method: getCalibrationMethod(), rows: out }));
  expect(out.length).toBe(rows.length);
});

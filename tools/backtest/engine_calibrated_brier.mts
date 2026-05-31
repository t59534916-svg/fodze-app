// Score the PRODUCTION-DISPLAY (calibrated) 1X2 Brier of each parquet engine by
// running the REAL TS calibration — calibrate1X2(benterBlend(raw, engineKey)) —
// the same transform conformalKellyFactor/MatchDetail see. Answers the default-
// engine question: does calibration close Standard's raw gap to v2 (and thus to
// dev-03/Blend, which are already below v2 raw)?
//
// Not *.test.ts → invisible to `npm run test`. Run:
//   npx vitest run --config tools/backtest/engine-brier.vitest.config.mts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

import { loadCalibrationCurves } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod, loadDirichletCalibration } from "@/lib/calibration";
import { benterBlend, loadBenterWeights, setBenterMode } from "@/lib/benter-blend";

const REPO = resolve(__dirname, "..", "..");
const IN = resolve(REPO, "tools/backtest/.engine_raw.json");
const OUT = resolve(REPO, "tools/backtest/engine-calibrated-brier.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const OUTCOME: Record<string, number> = { H: 0, D: 1, A: 2 };

function brier(p: number[], y: number): number {
  const t = [0, 0, 0]; t[y] = 1;
  return (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
}

it("calibrated production-display Brier per engine", () => {
  // production init (mirror AppContext)
  loadCalibrationCurves(readJson(resolve(REPO, "public/calibration_curves.json")));
  setBenterMode("on");
  loadBenterWeights(readJson(resolve(REPO, "public/benter-weights.json")));
  const calMethod = (process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "isotonic").toLowerCase();
  if (calMethod === "dirichlet") {
    loadDirichletCalibration(readJson(resolve(REPO, "public/dirichlet-calibration.json")));
    setCalibrationMethod("dirichlet");
  } else setCalibrationMethod(calMethod === "platt" ? "platt" : "isotonic");

  const rows: Array<{ engine: string; ekey: string; league: string; ft_result: string; raw: number[] }> =
    readJson(IN);

  type Acc = { n: number; brawSum: number; bcalSum: number; hochN: number; hochHit: number };
  const acc: Record<string, Acc> = {};
  for (const r of rows) {
    const y = OUTCOME[r.ft_result];
    const [h, d, a] = r.raw;
    const bl = benterBlend({ H: h, D: d, A: a }, null, r.ekey as any, r.league);
    const cal = calibrate1X2(bl.H, bl.D, bl.A, r.league);
    const cp = [cal.H, cal.D, cal.A];
    const A = (acc[r.engine] ||= { n: 0, brawSum: 0, bcalSum: 0, hochN: 0, hochHit: 0 });
    A.n++;
    A.brawSum += brier(r.raw, y);
    A.bcalSum += brier(cp, y);
    // calibrated HOCH tier (top prob >= 0.65)
    const conf = Math.max(cp[0], cp[1], cp[2]);
    const pick = cp.indexOf(conf);
    if (conf >= 0.65) { A.hochN++; if (pick === y) A.hochHit++; }
  }

  const out = Object.entries(acc).map(([engine, A]) => ({
    engine, n: A.n,
    brier_raw: +(A.brawSum / A.n).toFixed(4),
    brier_calibrated: +(A.bcalSum / A.n).toFixed(4),
    calibration_delta: +((A.bcalSum - A.brawSum) / A.n).toFixed(4),
    hoch_n: A.hochN, hoch_hit: A.hochN >= 10 ? +(A.hochHit / A.hochN).toFixed(3) : null,
  })).sort((x, y2) => x.brier_calibrated - y2.brier_calibrated);

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[engine-brier] calMethod=${calMethod}`);
  for (const e of out) {
    console.log(`[engine-brier] ${e.engine.padEnd(10)} n=${String(e.n).padEnd(5)} ` +
      `Brier raw ${e.brier_raw} → cal ${e.brier_calibrated} (Δ${e.calibration_delta}) ` +
      `HOCH ${e.hoch_hit ?? "n/a"} (n=${e.hoch_n})`);
  }
  expect(out.length).toBe(3);
});

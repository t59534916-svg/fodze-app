// Score the calibration-EFFECT (Brier + top-label ECE, raw vs calibrated) of
// each engine by running the REAL TS calibration — calibrate1X2(benterBlend(raw,
// engineKey)) — the exact transform calculateBetsEnhanced/MatchDetail see. This
// is the apples-to-apples basis for the default-engine + calibration-curve audit:
// does the shared global isotonic in public/calibration_curves.json HELP or HURT
// each engine's already-(mis)calibrated distribution?
//
// Data half: tools/backtest/_engine_export_calib.py → .engine_raw_calib.json
//   rows: { engine, ekey, variant, league, ft_result, raw:[h,d,a] }
//   variant "raw_dc"  — raw model probs (Standard/v1/v2 parquet · dev-03 λ→DC)
//   variant "blended" — dev-03 ONLY: benter-blended toward Pinnacle (production
//                       DISPLAY + Kelly-track INPUT). calibrate1X2(blended) here
//                       == the ACTUAL dev-03 Kelly/edge track in production.
//
// For every engine the harness applies benterBlend(raw, null, ekey, league):
//   - Standard/v1/ensemble: no/inert weights → passthrough
//   - v2: β=(1,0) identity log-pool → passthrough
//   - dev-03: hard guard → passthrough
// so `cal = calibrate1X2(raw)` isolates the shared-curve calibration effect.
//
// Not *.test.ts → invisible to `npm run test`. Run:
//   tools/venv/bin/python3 -I tools/backtest/_engine_export_calib.py
//   npx vitest run --config tools/backtest/engine-brier.vitest.config.mts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

import { loadCalibrationCurves } from "@/lib/dixon-coles";
import { calibrate1X2, setCalibrationMethod, loadDirichletCalibration } from "@/lib/calibration";
import { benterBlend, loadBenterWeights, setBenterMode } from "@/lib/benter-blend";

const REPO = resolve(__dirname, "..", "..");
const IN = resolve(REPO, "tools/backtest/.engine_raw_calib.json");
const OUT = resolve(REPO, "tools/backtest/engine-calibrated-brier.json");
// Per-row dump (raw + production-calibrated + odds + y) so the Python validator
// (validate_calibration_bypass.py) can run the paired t-test + Money-Eval (G4/G5)
// against the EXACT production-calibrated probs this harness produces.
const ROWS_OUT = resolve(REPO, "tools/backtest/.engine_calibrated_rows.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const OUTCOME: Record<string, number> = { H: 0, D: 1, A: 2 };

function brier(p: number[], y: number): number {
  const t = [0, 0, 0]; t[y] = 1;
  return (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
}

// Top-label ECE (10 equal-width bins by max-prob) — mirror of
// validate_confidence_production_path.py::_ece so TS↔Python agree.
function topLabelEce(probs: number[][], ys: number[], nBins = 10): number {
  const n = probs.length;
  if (n === 0) return NaN;
  const bins = Array.from({ length: nBins }, () => ({ n: 0, conf: 0, correct: 0 }));
  for (let i = 0; i < n; i++) {
    const p = probs[i];
    let conf = p[0], pred = 0;
    if (p[1] > conf) { conf = p[1]; pred = 1; }
    if (p[2] > conf) { conf = p[2]; pred = 2; }
    let b = Math.floor(conf * nBins);
    if (b >= nBins) b = nBins - 1;
    if (b < 0) b = 0;
    bins[b].n++; bins[b].conf += conf; bins[b].correct += pred === ys[i] ? 1 : 0;
  }
  let ece = 0;
  for (const bn of bins) {
    if (bn.n === 0) continue;
    ece += (bn.n / n) * Math.abs(bn.correct / bn.n - bn.conf / bn.n);
  }
  return ece;
}

type Row = { engine: string; ekey: string; variant: string; season?: string; league: string; ft_result: string; raw: number[]; odds: number[] | null };
type OutRow = { engine: string; variant: string; season: string; league: string; y: number; raw: number[]; cal: number[]; odds: number[] | null };

it("calibration-effect (Brier + ECE) per engine·variant", () => {
  // production init (mirror AppContext)
  loadCalibrationCurves(readJson(resolve(REPO, "public/calibration_curves.json")));
  setBenterMode("on");
  loadBenterWeights(readJson(resolve(REPO, "public/benter-weights.json")));
  const calMethod = (process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "isotonic").toLowerCase();
  if (calMethod === "dirichlet") {
    loadDirichletCalibration(readJson(resolve(REPO, "public/dirichlet-calibration.json")));
    setCalibrationMethod("dirichlet");
  } else setCalibrationMethod(calMethod === "platt" ? "platt" : "isotonic");

  const rows: Row[] = readJson(IN);

  type Acc = {
    rawP: number[][]; calP: number[][]; ys: number[];
    brawSum: number; bcalSum: number;
    hochRawN: number; hochRawHit: number; hochCalN: number; hochCalHit: number;
  };
  const acc: Record<string, Acc> = {};
  const outRows: OutRow[] = [];
  for (const r of rows) {
    const y = OUTCOME[r.ft_result];
    if (y === undefined) continue;
    const [h, d, a] = r.raw;
    const bl = benterBlend({ H: h, D: d, A: a }, null, r.ekey as any, r.league);
    const cal = calibrate1X2(bl.H, bl.D, bl.A, r.league);
    const rawArr = [h, d, a];
    const calArr = [cal.H, cal.D, cal.A];
    const season = r.season ?? "25/26";
    outRows.push({ engine: r.engine, variant: r.variant, season, league: r.league, y, raw: rawArr, cal: calArr, odds: r.odds });
    // Key by season so cross-season dev-03 rows (24/25 dev-03-2h) don't merge
    // into the 25/26 accumulator. Display label below shows the season suffix
    // only for non-25/26 to keep the primary table identical to before.
    const key = `${r.engine}|${r.variant}|${season}`;
    const A = (acc[key] ||= {
      rawP: [], calP: [], ys: [], brawSum: 0, bcalSum: 0,
      hochRawN: 0, hochRawHit: 0, hochCalN: 0, hochCalHit: 0,
    });
    A.rawP.push(rawArr); A.calP.push(calArr); A.ys.push(y);
    A.brawSum += brier(rawArr, y);
    A.bcalSum += brier(calArr, y);
    // HOCH tier (top prob >= 0.65) on each track
    const cRaw = Math.max(h, d, a), pRaw = rawArr.indexOf(cRaw);
    if (cRaw >= 0.65) { A.hochRawN++; if (pRaw === y) A.hochRawHit++; }
    const cCal = Math.max(calArr[0], calArr[1], calArr[2]), pCal = calArr.indexOf(cCal);
    if (cCal >= 0.65) { A.hochCalN++; if (pCal === y) A.hochCalHit++; }
  }

  const out = Object.entries(acc).map(([key, A]) => {
    const [engine, variant, season] = key.split("|");
    const n = A.ys.length;
    return {
      engine, variant, season, n,
      brier_raw: +(A.brawSum / n).toFixed(4),
      brier_calibrated: +(A.bcalSum / n).toFixed(4),
      calibration_delta: +((A.bcalSum - A.brawSum) / n).toFixed(4), // + = calibration HURT
      ece_raw: +topLabelEce(A.rawP, A.ys).toFixed(4),
      ece_calibrated: +topLabelEce(A.calP, A.ys).toFixed(4),
      ece_delta: +(topLabelEce(A.calP, A.ys) - topLabelEce(A.rawP, A.ys)).toFixed(4), // + = cal less calibrated
      hoch_raw: A.hochRawN >= 10 ? +(A.hochRawHit / A.hochRawN).toFixed(3) : null,
      hoch_raw_n: A.hochRawN,
      hoch_calibrated: A.hochCalN >= 10 ? +(A.hochCalHit / A.hochCalN).toFixed(3) : null,
      hoch_calibrated_n: A.hochCalN,
    };
  }).sort((x, y2) => (x.season + x.engine + x.variant).localeCompare(y2.season + y2.engine + y2.variant));

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  writeFileSync(ROWS_OUT, JSON.stringify(outRows));
  console.log(`[engine-brier] calMethod=${calMethod}  (Δ>0 = calibration HURT; ece Δ>0 = less calibrated)`);
  for (const e of out) {
    console.log(
      `[engine-brier] ${(e.engine + ":" + e.variant + ":" + e.season).padEnd(26)} n=${String(e.n).padEnd(5)} ` +
      `Brier ${e.brier_raw}→${e.brier_calibrated} (Δ${e.calibration_delta >= 0 ? "+" : ""}${e.calibration_delta})  ` +
      `ECE ${e.ece_raw}→${e.ece_calibrated} (Δ${e.ece_delta >= 0 ? "+" : ""}${e.ece_delta})  ` +
      `HOCH ${e.hoch_raw ?? "—"}→${e.hoch_calibrated ?? "—"}`,
    );
  }
  expect(out.length).toBeGreaterThanOrEqual(4);
});

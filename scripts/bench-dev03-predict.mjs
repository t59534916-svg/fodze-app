#!/usr/bin/env node
/**
 * dev-03 prediction micro-benchmark — empirically measures the per-match cost
 * of the 5-bagged LightGBM forward pass (dev03Predict).
 *
 * WHY THIS EXISTS
 * The dev-03 Web Worker (src/lib/dev03-worker*.ts, wired in MatchdayContext) was
 * justified by "~15 ms/match, blocks the React render thread across a whole
 * matchday". That premise was never measured. This script measures it against
 * the real public/dev03-model.json (5×200 home + 5×200 away trees) using the
 * golden feature fixtures.
 *
 * FINDING (2026-05-31, node v22, this container):
 *   warm:  ~0.46 ms/match  (≈ 32× LESS than the "15 ms" claim)
 *   a 40-match day = ~19 ms warm / ~35 ms cold of total dev-03 compute.
 * → The worker offload addresses a cost ~30× smaller than its justification
 *   stated. It's harmless (sync-fallback is what tests run), but the perf
 *   rationale was overstated. Browser numbers will differ (V8 is V8, but the
 *   model JSON parse + GC behave differently); treat this as the order-of-
 *   magnitude reality check, not the exact browser figure.
 *
 * Run: node scripts/bench-dev03-predict.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadDev03Model, dev03Predict } from "../src/lib/dev03-runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parseT0 = performance.now();
const model = JSON.parse(readFileSync(resolve(ROOT, "public/dev03-model.json"), "utf8"));
const loadT0 = performance.now();
const ok = loadDev03Model(model);
const loadMs = performance.now() - loadT0;
const parseMs = loadT0 - parseT0;
if (!ok) { console.error("model load failed"); process.exit(1); }

const golden = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/dev03-features-golden.json"), "utf8"));
const inputs = golden.fixtures.map((f) => f.expected_features);

// Guard: a valid prediction returns numeric lambdaH_mean — else the timing
// would measure a no-op and be meaningless.
const probe = dev03Predict(inputs[0]);
if (!probe || typeof probe.lambdaH_mean !== "number") {
  console.error("dev03Predict returned no valid prediction — aborting (timing would be a no-op).");
  process.exit(1);
}

// Cold: a fresh 40-match matchday with no warmup (closest to first-render UX).
const coldT0 = performance.now();
for (let i = 0; i < 40; i++) dev03Predict(inputs[i % inputs.length]);
const cold40 = performance.now() - coldT0;

// Warm steady-state.
for (let i = 0; i < 500; i++) dev03Predict(inputs[i % inputs.length]);
const N = 10000;
const warmT0 = performance.now();
for (let i = 0; i < N; i++) dev03Predict(inputs[i % inputs.length]);
const warmPer = (performance.now() - warmT0) / N;

console.log(JSON.stringify({
  model_parse_ms: +parseMs.toFixed(1),
  model_load_ms: +loadMs.toFixed(1),
  per_prediction_warm_ms: +warmPer.toFixed(4),
  cold_40_match_day_ms: +cold40.toFixed(1),
  warm_40_match_day_ms: +(warmPer * 40).toFixed(1),
  worker_justification_claim_ms_per_match: 15,
  overstatement_factor: +(15 / warmPer).toFixed(0),
  note: "Node measurement; browser V8 will differ but order-of-magnitude holds.",
}, null, 2));

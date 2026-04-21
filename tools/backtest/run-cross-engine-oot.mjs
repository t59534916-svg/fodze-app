#!/usr/bin/env node
/*
═══════════════════════════════════════════════════════════════════
FODZE Cross-Engine OOT — v2 raw vs v2+Dirichlet vs v2+Benter
═══════════════════════════════════════════════════════════════════

Scores the held-out out-of-time split (≥ 2023-08-01) with each of
three calibration variants that are wired into the live app:

  v2_raw          — LightGBM Tweedie posterior, bit-identical to the
                    `prob_*_raw` columns exported by retrain_v2.py
  v2_dirichlet    — Dirichlet-ODIR calibration from
                    public/dirichlet-calibration.json (per-cluster)
  v2_benter       — Benter log-pool blend with Pinnacle close from
                    public/benter-weights.json (per-league). Runtime
                    gates mirror src/lib/benter-blend.ts for the cases
                    that apply off-line (pinn_degenerate, degenerate_betas,
                    market_dominated at modelShare < 0.15, outlier at
                    logDiff > 2.5). The runtime-only gates are omitted:
                    the mode_off/no_weights branches (no feature flag in
                    backtest), and pinn_not_normalised (we vig-remove
                    ourselves from raw Pinnacle odds so the invariant
                    holds by construction).

and reports the same metrics.py-style scorecard for each:

  Brier · BSS (+ 95% bootstrap CI) · Log-Loss · RPS · ECE 10-bucket

Optional per-engine conformal diagnostics (--conformal) report
empirical coverage, average prediction-set size, and singleton rate
at α ∈ {0.05, 0.10, 0.20} using public/conformal-quantiles.json. A
well-calibrated conformal gate should hit coverage ≈ 1−α; set size
and singleton rate measure how much information the gate is leaving
on the table vs. a pure point-prediction.

The point is a head-to-head decision-theoretic comparison: each
variant feeds a different Kelly stake + Goldilocks selection at
runtime, so knowing which one leads on the holdout tells us whether
the Dirichlet / Benter layers actually earn their inclusion in the
stack — or whether they just move numbers around. With --kelly
--conformal-gate enforce/dampen layered on top, the same answer is
available for the staking gate.

Usage:
  node tools/backtest/run-cross-engine-oot.mjs
  node tools/backtest/run-cross-engine-oot.mjs --per-league
  node tools/backtest/run-cross-engine-oot.mjs --league epl
  node tools/backtest/run-cross-engine-oot.mjs --engines v2_raw,v2_dirichlet
  node tools/backtest/run-cross-engine-oot.mjs --no-bootstrap
  node tools/backtest/run-cross-engine-oot.mjs --out tools/backtest/my.json
  node tools/backtest/run-cross-engine-oot.mjs --kelly             # Kelly ROI per engine
  node tools/backtest/run-cross-engine-oot.mjs --kelly --kelly-profile A --bankroll 5000
  node tools/backtest/run-cross-engine-oot.mjs --conformal         # + coverage diagnostics
  node tools/backtest/run-cross-engine-oot.mjs --kelly --conformal-gate enforce
  node tools/backtest/run-cross-engine-oot.mjs --kelly --conformal-gate dampen --conformal-alpha 0.10

On first run (or whenever the upstream parquets are newer than the
JSONL cache) the Python bridge _export_oot_merged.py is invoked
automatically via tools/venv/bin/python. No Node parquet reader
dependency is required.
═══════════════════════════════════════════════════════════════════
*/

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");

const DEFAULTS = {
  merged: join(HERE, "v2-oot-merged.jsonl"),
  predictions: join(HERE, "v2-oot-predictions.parquet"),
  odds: join(HERE, "odds-close-oot.parquet"),
  dirichlet: join(PROJECT_ROOT, "public", "dirichlet-calibration.json"),
  benter: join(PROJECT_ROOT, "public", "benter-weights.json"),
  conformal: join(PROJECT_ROOT, "public", "conformal-quantiles.json"),
  out: join(HERE, "cross-engine-oot-metrics.json"),
  python: join(PROJECT_ROOT, "tools", "venv", "bin", "python"),
  bridge: join(HERE, "_export_oot_merged.py"),
};

const ENGINE_NAMES = ["v1", "v2_raw", "v2_dirichlet", "v2_benter"];
const RESULT_CLASSES = ["H", "D", "A"];
const RESULT_IDX = { H: 0, D: 1, A: 2 };
const MIN_STABLE_SAMPLE = 100;
const BOOTSTRAP_N = 1000;
const BOOTSTRAP_SEED = 42;

// Kelly conventions — mirrors tools/backtest/simulate_kelly.py + src/lib/kelly.ts.
const RISK_CAPS = { K: 0.025, M: 0.040, A: 0.060 };
const EDGE_BUCKETS = [
  { lo: 0.0, hi: 0.02, key: "0.00-0.02" },
  { lo: 0.02, hi: 0.05, key: "0.02-0.05" },
  { lo: 0.05, hi: 0.10, key: "0.05-0.10" },
  { lo: 0.10, hi: 1.0, key: "0.10-1.00" },
];
const PER_LEAGUE_CI_MIN_N = 30;

// Conformal — mirrors src/lib/conformal-gate.ts.
// α levels match what public/conformal-quantiles.json ships by default
// (0.05, 0.10, 0.20). DEFAULT_ALPHA=0.10 matches the TS reference.
const CONFORMAL_ALPHAS = [0.05, 0.10, 0.20];
const CONFORMAL_DEFAULT_ALPHA = 0.10;
// Permissive fallback when a league has no quantile at the requested
// alpha. q=0.50 means only arg-max gets in → always singleton. Keeps
// the gate from silently dropping every bet.
const CONFORMAL_FALLBACK_QUANTILE = 0.50;
// Dampen factors from src/lib/conformal-gate.ts (|S|=1→1.0, 2→0.6, 3→0.3).
const CONFORMAL_DAMPEN_FACTORS = { 1: 1.0, 2: 0.6, 3: 0.3 };

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    league: null,
    limit: 0,
    bootstrap: true,
    perLeague: false,
    engines: ENGINE_NAMES.slice(),
    mergedPath: DEFAULTS.merged,
    outPath: DEFAULTS.out,
    dirichletPath: DEFAULTS.dirichlet,
    benterPath: DEFAULTS.benter,
    // Kelly
    kelly: false,
    kellyProfile: "M",
    bankroll: 10000,
    edgeMin: 0.025,
    edgeMax: 0.075,
    maxOverround: 0.05,
    minMarketProb: 0.10,
    maxMarketProb: 0.65,
    // Conformal
    conformal: false,
    conformalPath: DEFAULTS.conformal,
    conformalGate: "off",
    conformalAlpha: CONFORMAL_DEFAULT_ALPHA,
    // Ships a slim summary to public/ so /performance can read it.
    publish: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--league") out.league = next();
    else if (a === "--limit") out.limit = parseInt(next(), 10) || 0;
    else if (a === "--no-bootstrap") out.bootstrap = false;
    else if (a === "--per-league") out.perLeague = true;
    else if (a === "--engines") out.engines = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--merged") out.mergedPath = next();
    else if (a === "--out") out.outPath = next();
    else if (a === "--dirichlet") out.dirichletPath = next();
    else if (a === "--benter") out.benterPath = next();
    else if (a === "--kelly") out.kelly = true;
    else if (a === "--kelly-profile") out.kellyProfile = next();
    else if (a === "--bankroll") out.bankroll = parseFloat(next());
    else if (a === "--edge-min") out.edgeMin = parseFloat(next());
    else if (a === "--edge-max") out.edgeMax = parseFloat(next());
    else if (a === "--max-overround") out.maxOverround = parseFloat(next());
    else if (a === "--min-market-prob") out.minMarketProb = parseFloat(next());
    else if (a === "--max-market-prob") out.maxMarketProb = parseFloat(next());
    else if (a === "--conformal") out.conformal = true;
    else if (a === "--conformal-path") out.conformalPath = next();
    else if (a === "--conformal-gate") { out.conformalGate = next(); out.conformal = true; }
    else if (a === "--conformal-alpha") { out.conformalAlpha = parseFloat(next()); out.conformal = true; }
    else if (a === "--publish") {
      out.publish = true;
      out.conformal = true;
      out.kelly = true;
    }
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node tools/backtest/run-cross-engine-oot.mjs [opts]\n" +
          "  --league <key>              restrict to one league key\n" +
          "  --limit <N>                 take last N rows only (debug)\n" +
          "  --engines a,b,c             subset of: v2_raw, v2_dirichlet, v2_benter\n" +
          "  --no-bootstrap              skip 95% CI bootstrap on BSS\n" +
          "  --per-league                print per-league table to stdout\n" +
          "  --merged <path>             override merged JSONL input\n" +
          "  --out <path>                override JSON output path\n" +
          "  --kelly                     also run Kelly ROI simulation per engine\n" +
          "  --kelly-profile K|M|A       Kelly risk profile (default M)\n" +
          "  --bankroll <N>              starting bankroll (default 10000)\n" +
          "  --edge-min <F>              Goldilocks lower bound (default 0.025)\n" +
          "  --edge-max <F>              Goldilocks upper bound (default 0.075)\n" +
          "  --max-overround <F>         skip matches with Pinn overround > F (default 0.05)\n" +
          "  --min-market-prob <F>       skip market probs below (default 0.10)\n" +
          "  --max-market-prob <F>       skip market probs above (default 0.65)\n" +
          "  --conformal                 report coverage/set-size/singleton-rate per engine\n" +
          "  --conformal-gate off|enforce|dampen  gate Kelly on prediction-set singleton (default off)\n" +
          "  --conformal-alpha <F>       target miscoverage rate: 0.05, 0.10 (default), 0.20\n" +
          "  --publish                   also write slim summary to public/backtest-summary.json (ships to UI)\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  for (const e of out.engines) {
    if (!ENGINE_NAMES.includes(e)) {
      process.stderr.write(`unknown engine: ${e} (valid: ${ENGINE_NAMES.join(", ")})\n`);
      process.exit(2);
    }
  }
  if (!RISK_CAPS[out.kellyProfile]) {
    process.stderr.write(`unknown kelly profile: ${out.kellyProfile} (valid: K, M, A)\n`);
    process.exit(2);
  }
  if (!["off", "enforce", "dampen"].includes(out.conformalGate)) {
    process.stderr.write(`unknown conformal-gate: ${out.conformalGate} (valid: off, enforce, dampen)\n`);
    process.exit(2);
  }
  if (!CONFORMAL_ALPHAS.some((a) => Math.abs(a - out.conformalAlpha) < 1e-6)) {
    process.stderr.write(`unknown conformal-alpha: ${out.conformalAlpha} (valid: ${CONFORMAL_ALPHAS.join(", ")})\n`);
    process.exit(2);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Python bridge — auto-regen JSONL if missing/stale
// ═══════════════════════════════════════════════════════════════════

function ensureMergedFresh(mergedPath) {
  const pyExists = existsSync(DEFAULTS.python);
  const bridgeExists = existsSync(DEFAULTS.bridge);
  const predExists = existsSync(DEFAULTS.predictions);
  const mergedExists = existsSync(mergedPath);

  if (mergedExists) {
    // Skip regen only if merged is newer than the parquets it derived from.
    const mergedMtime = statSync(mergedPath).mtimeMs;
    const predMtime = predExists ? statSync(DEFAULTS.predictions).mtimeMs : 0;
    const oddsMtime = existsSync(DEFAULTS.odds) ? statSync(DEFAULTS.odds).mtimeMs : 0;
    if (mergedMtime >= predMtime && mergedMtime >= oddsMtime) return; // fresh
    process.stdout.write(`  merged JSONL is older than source parquets → regenerating\n`);
  } else {
    process.stdout.write(`  merged JSONL missing → generating via ${relative(PROJECT_ROOT, DEFAULTS.bridge)}\n`);
  }

  if (!pyExists) {
    throw new Error(
      `Python venv not found at ${DEFAULTS.python}. ` +
        `Either create it (tools/venv) or pre-generate the JSONL by running the Python bridge manually.`,
    );
  }
  if (!bridgeExists) {
    throw new Error(`Bridge script not found: ${DEFAULTS.bridge}`);
  }
  if (!predExists) {
    throw new Error(
      `Predictions parquet missing: ${DEFAULTS.predictions}. ` +
        `Regenerate via tools/retrain_v2.py or pass --merged to an already-materialized JSONL.`,
    );
  }

  const res = spawnSync(DEFAULTS.python, [DEFAULTS.bridge, "--out", mergedPath], {
    stdio: "inherit",
    cwd: PROJECT_ROOT,
  });
  if (res.status !== 0) {
    throw new Error(`Python bridge failed with exit ${res.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// JSONL loader
// ═══════════════════════════════════════════════════════════════════

// Validate a merged row has every field the scoring + metrics code depends
// on. Missing `ft_result` in particular is silent-garbage-producing — the
// downstream onehot() builds oh[i][undefined]=1 which leaves the [0,0,0]
// baseline, so Brier is computed against all-zero actuals and produces a
// nonsense number with no thrown error. Fail loudly at load time instead.
function validateRow(row, idx, path) {
  const req = ["league", "match_date", "prob_h_raw", "prob_d_raw", "prob_a_raw", "ft_result"];
  for (const f of req) {
    if (row[f] === undefined || row[f] === null) {
      throw new Error(`row ${idx} in ${path}: missing required field '${f}'`);
    }
  }
  if (row.ft_result !== "H" && row.ft_result !== "D" && row.ft_result !== "A") {
    throw new Error(`row ${idx} in ${path}: ft_result must be H/D/A, got ${JSON.stringify(row.ft_result)}`);
  }
  for (const p of ["prob_h_raw", "prob_d_raw", "prob_a_raw"]) {
    if (!Number.isFinite(row[p])) {
      throw new Error(`row ${idx} in ${path}: ${p} is not finite (${row[p]})`);
    }
  }
}

function loadMerged(path) {
  const raw = readFileSync(path, "utf8");
  const rows = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSONL at ${path}:${i + 1}: ${err.message}`);
    }
    validateRow(parsed, i + 1, path);
    rows.push(parsed);
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// Engines — each takes (row) and returns { H, D, A, applied, note }
// ═══════════════════════════════════════════════════════════════════

function engineV2Raw(row) {
  return { H: row.prob_h_raw, D: row.prob_d_raw, A: row.prob_a_raw, applied: true, note: "raw" };
}

// v1 probs come pre-computed from tools/backtest/export_v1_oot.py and are
// merged into the JSONL by _export_oot_merged.py as v1_prob_*_raw. Rows
// without a v1 prediction fall back to NaN → the scoring path filters
// them via the loadMerged validator downstream of this function.
function engineV1(row) {
  if (row.v1_prob_h_raw == null) {
    return { H: 0, D: 0, A: 0, applied: false, note: "no_v1_prediction" };
  }
  return {
    H: row.v1_prob_h_raw,
    D: row.v1_prob_d_raw,
    A: row.v1_prob_a_raw,
    applied: true,
    note: "v1-from-v2-npxg",
  };
}

// ─── Dirichlet: per-cluster W·log(p) + b → softmax ────────────
function makeDirichletEngine(dirichletJson) {
  const clusterMap = dirichletJson.cluster_map || {};
  const globalParams = dirichletJson.global;
  const clusters = dirichletJson.clusters || {};

  return function engineV2Dirichlet(row) {
    const rawH = Math.max(row.prob_h_raw, 1e-9);
    const rawD = Math.max(row.prob_d_raw, 1e-9);
    const rawA = Math.max(row.prob_a_raw, 1e-9);
    const clusterKey = clusterMap[row.league] || "global";
    const params = clusters[clusterKey] || globalParams;
    if (!params) return { H: row.prob_h_raw, D: row.prob_d_raw, A: row.prob_a_raw, applied: false, note: "no_params" };
    const logits = [Math.log(rawH), Math.log(rawD), Math.log(rawA)];
    const z = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      z[i] = params.b[i];
      for (let j = 0; j < 3; j++) z[i] += params.W[i][j] * logits[j];
    }
    const mz = Math.max(z[0], z[1], z[2]);
    const e0 = Math.exp(z[0] - mz);
    const e1 = Math.exp(z[1] - mz);
    const e2 = Math.exp(z[2] - mz);
    const s = e0 + e1 + e2;
    return { H: e0 / s, D: e1 / s, A: e2 / s, applied: true, note: `cluster:${clusterKey}` };
  };
}

// ─── Benter: log-pool β₁·log(model) + β₂·log(pinn) → softmax ────
// Gates are a port of the off-line-applicable subset of
// src/lib/benter-blend.ts: pinn_degenerate, degenerate_betas,
// market_dominated, outlier. The runtime-only gates (mode_off /
// no_weights / pinn_not_normalised) are omitted — see the header
// docstring for rationale. Any change to the remaining gates MUST be
// made in both files together, otherwise the backtest drifts from
// what the live app would produce.
function makeBenterEngine(benterJson) {
  const engine = benterJson?.engines?.v2;
  if (!engine) {
    return function engineV2Benter(row) {
      return { H: row.prob_h_raw, D: row.prob_d_raw, A: row.prob_a_raw, applied: false, note: "no_v2_engine" };
    };
  }
  const globalBetas = engine.global;
  const leagueBetas = engine.leagues || {};

  return function engineV2Benter(row) {
    const passthrough = (note) => ({
      H: row.prob_h_raw, D: row.prob_d_raw, A: row.prob_a_raw, applied: false, note,
    });
    if (row.psch == null || row.pscd == null || row.psca == null) return passthrough("no_pinnacle");

    // Vig-remove Pinnacle close by normalizing implied probs to sum=1.
    // (The app hands benterBlend pre-normalised probs; we replicate that here.)
    const impH = 1 / row.psch;
    const impD = 1 / row.pscd;
    const impA = 1 / row.psca;
    const impSum = impH + impD + impA;
    if (!(impSum > 0)) return passthrough("pinn_zero");
    const pinn = { H: impH / impSum, D: impD / impSum, A: impA / impSum };
    if (pinn.H > 0.99 || pinn.D > 0.99 || pinn.A > 0.99) return passthrough("pinn_degenerate");

    const betas = leagueBetas[row.league] || globalBetas;
    if (!betas) return passthrough("no_betas");
    const { beta1, beta2 } = betas;
    if (!Number.isFinite(beta1) || !Number.isFinite(beta2)) return passthrough("invalid_betas");
    if (beta1 + beta2 <= 0) return passthrough("degenerate_betas");
    const modelShare = beta1 / (beta1 + beta2);
    if (modelShare < 0.15) return passthrough("market_dominated");

    const safeLog = (x) => Math.log(Math.max(x, 1e-9));
    const logDiff = {
      H: Math.abs(safeLog(row.prob_h_raw) - safeLog(pinn.H)),
      D: Math.abs(safeLog(row.prob_d_raw) - safeLog(pinn.D)),
      A: Math.abs(safeLog(row.prob_a_raw) - safeLog(pinn.A)),
    };
    if (logDiff.H > 2.5 && logDiff.D > 2.5 && logDiff.A > 2.5) return passthrough("outlier");

    const zH = beta1 * safeLog(row.prob_h_raw) + beta2 * safeLog(pinn.H);
    const zD = beta1 * safeLog(row.prob_d_raw) + beta2 * safeLog(pinn.D);
    const zA = beta1 * safeLog(row.prob_a_raw) + beta2 * safeLog(pinn.A);
    const mz = Math.max(zH, zD, zA);
    const eH = Math.exp(zH - mz);
    const eD = Math.exp(zD - mz);
    const eA = Math.exp(zA - mz);
    const ss = eH + eD + eA;
    return {
      H: eH / ss, D: eD / ss, A: eA / ss,
      applied: true,
      note: leagueBetas[row.league] ? `blend:v2:${row.league}` : "blend:v2:global",
    };
  };
}

// ═══════════════════════════════════════════════════════════════════
// Conformal prediction gate — port of src/lib/conformal-gate.ts
//
// Returns a closure that classifies a (probs, league) pair against the
// per-league Mondrian quantile at the requested α. The set is built by
// keeping every outcome whose non-conformity score (1 − p_k) ≤ q. When
// no outcome qualifies (q too tight) we keep the argmax — matches the
// defensive fallback in conformal-gate.ts:118.
// ═══════════════════════════════════════════════════════════════════

function alphaKey(alpha) {
  return alpha.toFixed(2);
}

function makeConformalGate(conformalJson) {
  const globalQ = conformalJson?.global || {};
  const leagueQ = conformalJson?.leagues || {};

  return function gate(probs, league, alpha = CONFORMAL_DEFAULT_ALPHA) {
    const key = alphaKey(alpha);
    let q, cluster;
    if (league && leagueQ[league] && typeof leagueQ[league][key] === "number") {
      q = leagueQ[league][key];
      cluster = "league";
    } else if (typeof globalQ[key] === "number") {
      q = globalQ[key];
      cluster = "global";
    } else {
      q = CONFORMAL_FALLBACK_QUANTILE;
      cluster = "default";
    }
    const scores = [
      { k: "H", s: 1 - probs.H },
      { k: "D", s: 1 - probs.D },
      { k: "A", s: 1 - probs.A },
    ];
    let set = scores.filter((x) => x.s <= q).map((x) => x.k);
    if (set.length === 0) {
      // argmin of s = argmax of p — keep the most confident outcome
      // so a too-tight quantile doesn't blank every bet.
      const argmax = scores.reduce((best, x) => (x.s < best.s ? x : best)).k;
      set = [argmax];
    }
    return {
      inSet: set,
      setSize: set.length,
      isSingleton: set.length === 1,
      quantile: q,
      cluster,
      applied: cluster !== "default",
    };
  };
}

// Coverage = P(actual ∈ prediction set). A well-calibrated conformal
// gate at confidence (1−α) should hit coverage ≈ 1−α; overshoots waste
// information, undershoots violate the guarantee. Set-size and
// singleton rate measure how much information the gate leaves on the
// table vs. a plain argmax point prediction.
function computeConformalDiagnostics(rows, probs, gateFn, alphas) {
  const out = {};
  for (const alpha of alphas) {
    let hit = 0, setSizeSum = 0, singletons = 0;
    for (let i = 0; i < rows.length; i++) {
      const probMap = { H: probs[i][0], D: probs[i][1], A: probs[i][2] };
      const g = gateFn(probMap, rows[i].league, alpha);
      setSizeSum += g.setSize;
      if (g.isSingleton) singletons++;
      if (g.inSet.includes(rows[i].ft_result)) hit++;
    }
    out[alphaKey(alpha)] = {
      nominal_coverage: 1 - alpha,
      empirical_coverage: round4(hit / rows.length),
      avg_set_size: round4(setSizeSum / rows.length),
      singleton_rate: round4(singletons / rows.length),
    };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Metrics (direct ports of tools/backtest/metrics.py)
// ═══════════════════════════════════════════════════════════════════

function onehot(actual) {
  const oh = new Array(actual.length);
  for (let i = 0; i < actual.length; i++) {
    oh[i] = [0, 0, 0];
    oh[i][RESULT_IDX[actual[i]]] = 1;
  }
  return oh;
}

function brier3(probs, actual) {
  let sum = 0;
  const oh = onehot(actual);
  for (let i = 0; i < probs.length; i++) {
    for (let k = 0; k < 3; k++) {
      const d = probs[i][k] - oh[i][k];
      sum += d * d;
    }
  }
  return sum / probs.length;
}

function logLoss(probs, actual) {
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.max(1e-12, Math.min(1, probs[i][RESULT_IDX[actual[i]]]));
    sum += Math.log(p);
  }
  return -sum / probs.length;
}

// Ranked Probability Score for ordered H>D>A. Drop last column (always zero).
function rpsOrdinal(probs, actual) {
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    const cumP = [probs[i][0], probs[i][0] + probs[i][1]];
    let cumA0, cumA1;
    if (actual[i] === "H") {
      cumA0 = 1; cumA1 = 1;
    } else if (actual[i] === "D") {
      cumA0 = 0; cumA1 = 1;
    } else {
      cumA0 = 0; cumA1 = 0;
    }
    const d0 = cumP[0] - cumA0;
    const d1 = cumP[1] - cumA1;
    sum += d0 * d0 + d1 * d1;
  }
  return (0.5 * sum) / probs.length;
}

function ece10(probs, actual, nBins = 10) {
  const predClass = probs.map((p) => {
    let k = 0;
    if (p[1] > p[k]) k = 1;
    if (p[2] > p[k]) k = 2;
    return k;
  });
  const predConf = probs.map((p, i) => p[predClass[i]]);
  const actualIdx = actual.map((c) => RESULT_IDX[c]);
  const correct = predClass.map((k, i) => (k === actualIdx[i] ? 1 : 0));

  const reliability = [];
  let ece = 0;
  const n = probs.length;
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    let cnt = 0, sumConf = 0, sumCorrect = 0;
    for (let i = 0; i < n; i++) {
      const inBin = b === nBins - 1 ? (predConf[i] >= lo && predConf[i] <= hi) : (predConf[i] >= lo && predConf[i] < hi);
      if (inBin) { cnt++; sumConf += predConf[i]; sumCorrect += correct[i]; }
    }
    if (cnt === 0) {
      reliability.push({ lo, hi, n: 0, avg_conf: null, accuracy: null });
      continue;
    }
    const avgConf = sumConf / cnt;
    const acc = sumCorrect / cnt;
    ece += (cnt / n) * Math.abs(avgConf - acc);
    reliability.push({ lo, hi, n: cnt, avg_conf: avgConf, accuracy: acc });
  }
  return { ece, reliability };
}

function baseRate(actual) {
  let h = 0, d = 0, a = 0;
  for (const c of actual) {
    if (c === "H") h++;
    else if (c === "D") d++;
    else a++;
  }
  const n = actual.length;
  return [h / n, d / n, a / n];
}

function bssFrom(probs, actual) {
  const br = baseRate(actual);
  const baseProbs = probs.map(() => br);
  const b = brier3(probs, actual);
  const bClim = brier3(baseProbs, actual);
  return bClim > 0 ? 1 - b / bClim : 0;
}

// Mulberry32 PRNG — deterministic, uniform, matches the seeded bootstrap
// in metrics.py in spirit (reproducible across runs, not bit-identical
// to numpy.random).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapBssCI(probs, actual, nBoot = BOOTSTRAP_N, seed = BOOTSTRAP_SEED, conf = 0.95) {
  const n = probs.length;
  if (n < 20) return { ci_low: NaN, ci_high: NaN, n_boot: 0, conf };
  const rng = mulberry32(seed);
  const samples = new Array(nBoot);
  const idxBuf = new Int32Array(n);
  const probBuf = new Array(n);
  const actBuf = new Array(n);
  for (let b = 0; b < nBoot; b++) {
    for (let i = 0; i < n; i++) idxBuf[i] = Math.floor(rng() * n);
    for (let i = 0; i < n; i++) { probBuf[i] = probs[idxBuf[i]]; actBuf[i] = actual[idxBuf[i]]; }
    samples[b] = bssFrom(probBuf, actBuf);
  }
  samples.sort((x, y) => x - y);
  const alpha = 1 - conf;
  const lo = samples[Math.floor((alpha / 2) * nBoot)];
  const hi = samples[Math.floor((1 - alpha / 2) * nBoot)];
  return { ci_low: lo, ci_high: hi, n_boot: nBoot, conf };
}

function computeMetrics(probs, actual, withBootstrap) {
  const n = probs.length;
  const br = baseRate(actual);
  const baseProbs = probs.map(() => br);
  const brier = brier3(probs, actual);
  const brierClim = brier3(baseProbs, actual);
  const bss = brierClim > 0 ? 1 - brier / brierClim : 0;
  const { ece, reliability } = ece10(probs, actual);

  const out = {
    n,
    brier: round6(brier),
    brier_climatology: round6(brierClim),
    brier_skill_score: round6(bss),
    log_loss: round6(logLoss(probs, actual)),
    rps: round6(rpsOrdinal(probs, actual)),
    ece_10bucket: round6(ece),
    reliability,
    base_rate: { H: round4(br[0]), D: round4(br[1]), A: round4(br[2]) },
    low_sample: n < MIN_STABLE_SAMPLE,
  };

  if (withBootstrap) {
    const ci = bootstrapBssCI(probs, actual);
    out.bss_ci95 = {
      low: round6(ci.ci_low),
      high: round6(ci.ci_high),
      n_boot: ci.n_boot,
      excludes_zero: ci.ci_low > 0 || ci.ci_high < 0,
    };
  }
  return out;
}

function round6(x) { return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x; }
function round4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x; }

// ═══════════════════════════════════════════════════════════════════
// Orchestration
// ═══════════════════════════════════════════════════════════════════

function scoreAll(rows, engineFns) {
  // Each engine produces its own probs array (same index order as rows).
  // We also track the "applied" flag so the stdout can honestly show how
  // often Benter fell through to passthrough (typical: ~70–80% of rows).
  const out = {};
  for (const [name, fn] of Object.entries(engineFns)) {
    const probs = new Array(rows.length);
    let appliedN = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = fn(rows[i]);
      probs[i] = [r.H, r.D, r.A];
      if (r.applied) appliedN++;
    }
    out[name] = { probs, applied_n: appliedN };
  }
  return out;
}

function printOverallTable(results, rows) {
  const actualArr = rows.map((r) => r.ft_result);
  process.stdout.write("\n" + "═".repeat(84) + "\n");
  process.stdout.write(`OVERALL OOT ACROSS ${rows.length} rows\n`);
  process.stdout.write("═".repeat(84) + "\n");
  process.stdout.write(
    `  ${"engine".padEnd(16)} ${"applied%".padStart(9)}  ${"Brier".padStart(8)}  ${"BSS".padStart(8)}  ${"BSS 95% CI".padEnd(20)}  ${"LogLoss".padStart(8)}  ${"RPS".padStart(7)}  ${"ECE".padStart(6)}\n`,
  );
  process.stdout.write(`  ${"─".repeat(84)}\n`);
  for (const [name, payload] of Object.entries(results)) {
    const m = payload.overall;
    const applied = (payload.applied_n / rows.length) * 100;
    const ci = m.bss_ci95;
    const ciStr = ci
      ? `[${ci.low >= 0 ? "+" : ""}${ci.low.toFixed(3)}, ${ci.high >= 0 ? "+" : ""}${ci.high.toFixed(3)}]`
      : "(skipped)";
    const excl = ci?.excludes_zero ? " *" : "  ";
    process.stdout.write(
      `  ${name.padEnd(16)} ${applied.toFixed(1).padStart(8)}%  ${m.brier.toFixed(4).padStart(8)}  ${(m.brier_skill_score >= 0 ? "+" : "") + m.brier_skill_score.toFixed(4)}  ${(ciStr + excl).padEnd(22)}  ${m.log_loss.toFixed(4).padStart(8)}  ${m.rps.toFixed(4).padStart(7)}  ${m.ece_10bucket.toFixed(4).padStart(6)}\n`,
    );
  }
  process.stdout.write(`  ${"─".repeat(84)}\n`);
  const br = actualArr.length > 0 ? baseRate(actualArr) : [0, 0, 0];
  process.stdout.write(`  base rate:     H=${br[0].toFixed(3)}  D=${br[1].toFixed(3)}  A=${br[2].toFixed(3)}\n`);
  process.stdout.write(`  * = 95% CI on BSS excludes zero (distinct from climatology)\n`);
}

function printPerLeagueTable(results) {
  // Take one engine's per-league keys as the canonical league list (all
  // engines score the same rows). Sort by v2_raw BSS descending when
  // available — otherwise whatever comes first.
  const engineNames = Object.keys(results);
  if (engineNames.length === 0) return;
  const refEngine = results.v2_raw ? "v2_raw" : engineNames[0];
  const refLeagues = results[refEngine].per_league;
  const sortedLeagues = Object.keys(refLeagues).sort(
    (a, b) => refLeagues[b].brier_skill_score - refLeagues[a].brier_skill_score,
  );

  process.stdout.write("\n" + "═".repeat(80) + "\n");
  process.stdout.write("PER-LEAGUE BSS (Brier Skill Score vs climatology)\n");
  process.stdout.write("═".repeat(80) + "\n");
  process.stdout.write(
    `  ${"league".padEnd(16)} ${"n".padStart(5)}  ${engineNames.map((e) => e.padStart(12)).join("  ")}  flag\n`,
  );
  process.stdout.write(`  ${"─".repeat(80)}\n`);
  for (const lg of sortedLeagues) {
    const parts = engineNames.map((e) => {
      const m = results[e].per_league[lg];
      if (!m) return "   —  ";
      return ((m.brier_skill_score >= 0 ? "+" : "") + m.brier_skill_score.toFixed(4)).padStart(12);
    });
    const flag = refLeagues[lg].low_sample ? "low-n" : "";
    process.stdout.write(
      `  ${lg.padEnd(16)} ${String(refLeagues[lg].n).padStart(5)}  ${parts.join("  ")}  ${flag}\n`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// Kelly simulation — mirrors tools/backtest/simulate_kelly.py. Point
// estimates (ROI, DD, Sharpe, Calmar, per-league ROI-on-stake) match
// exactly; bootstrap CI endpoints drift by ≤ 1 sample because this
// uses nearest-rank quantiles while numpy.quantile interpolates.
//
// Sane-market filters (519556b): Pinnacle overround cap + market-prob
// band. These are a proxy for the live Goldilocks dual-source guard
// (which needs soft-book odds we don't have in the OOT corpus). On the
// default settings they filter ~20% of the Goldilocks-qualifying bets
// — the noisy longshot/chalk tails.
// ═══════════════════════════════════════════════════════════════════

function simulateKelly(rows, engineFn, opts) {
  const cap = RISK_CAPS[opts.profile];
  const bets = [];
  const trajectory = [["_start", opts.bankroll]];
  let bankroll = opts.bankroll;

  for (const row of rows) {
    if (row.psch == null || row.pscd == null || row.psca == null) continue;
    const psch = row.psch, pscd = row.pscd, psca = row.psca;
    if (psch <= 1 || pscd <= 1 || psca <= 1) continue;

    const overround = 1 / psch + 1 / pscd + 1 / psca - 1;
    if (overround > opts.maxOverround) continue;

    const impSum = 1 / psch + 1 / pscd + 1 / psca;
    const market = {
      H: 1 / psch / impSum, D: 1 / pscd / impSum, A: 1 / psca / impSum,
    };
    const engineRes = engineFn(row);
    const probs = { H: engineRes.H, D: engineRes.D, A: engineRes.A };
    const odds = { H: psch, D: pscd, A: psca };
    const actual = row.ft_result;

    // Conformal gate (opt-in). Two modes mirror src/lib/conformal-gate.ts:
    //   enforce — non-singleton sets disable all bets on this match
    //   dampen  — keep betting but scale Kelly by 1 / 0.6 / 0.3 for |S|=1/2/3
    let cfGate = null;
    let cfFactor = 1.0;
    if (opts.conformalGateFn && opts.conformalGateMode !== "off") {
      cfGate = opts.conformalGateFn(probs, row.league, opts.conformalAlpha);
      if (opts.conformalGateMode === "enforce") {
        if (!cfGate.isSingleton) continue;
      } else if (opts.conformalGateMode === "dampen") {
        cfFactor = CONFORMAL_DAMPEN_FACTORS[Math.min(3, cfGate.setSize)] ?? 1.0;
      }
    }

    for (const k of RESULT_CLASSES) {
      const mk = market[k];
      if (mk < opts.minMarketProb || mk > opts.maxMarketProb) continue;
      const p = probs[k];
      if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
      const edge = p - mk;
      if (edge < opts.edgeMin || edge > opts.edgeMax) continue;

      const b = odds[k] - 1;
      const q = 1 - p;
      const kelly = (b * p - q) / b;
      if (kelly <= 0) continue;

      // Apply conformal dampen factor to the kelly before cap — keeps the
      // cap semantics intact (cap is "max fraction of bankroll per bet").
      const fraction = Math.min(kelly * cfFactor, cap);
      const stake = fraction * bankroll;
      if (stake <= 0) continue;

      const won = actual === k;
      const profit = won ? stake * b : -stake;
      bankroll += profit;

      bets.push({
        date: row.match_date, league: row.league, outcome: k,
        model_prob: p, market_prob: mk, edge, odds: odds[k],
        fraction, stake, won, profit,
        ...(cfGate ? { conformal_set_size: cfGate.setSize, conformal_factor: cfFactor } : {}),
      });
      trajectory.push([row.match_date, bankroll]);
    }
  }

  return {
    profile: opts.profile,
    bets,
    trajectory,
    starting_bankroll: opts.bankroll,
    final_bankroll: bankroll,
  };
}

// Aggregate bet-level trajectory into EOD bankrolls so Sharpe isn't
// inflated by multiple bets on the same date.
function dailyReturns(trajectory) {
  if (trajectory.length < 2) return [];
  const eodByDate = new Map();
  for (const [date, bk] of trajectory) {
    if (date === "_start") continue;
    eodByDate.set(date, bk); // last write wins → EOD
  }
  if (eodByDate.size === 0) return [];
  const dates = [...eodByDate.keys()].sort();
  const series = [trajectory[0][1], ...dates.map((d) => eodByDate.get(d))];
  const returns = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0) returns.push(series[i] / series[i - 1] - 1);
  }
  return returns;
}

// Bootstrap CI on ROI-on-stake. Resamples (stake, profit) pairs jointly
// so numerator + denominator co-vary (ratio remains self-consistent on
// each draw). Matches the Python sim's per-league CI method.
function bootstrapRoiOnStakeCI(bets, seed, nBoot = BOOTSTRAP_N, conf = 0.95) {
  const n = bets.length;
  if (n < PER_LEAGUE_CI_MIN_N) return null;
  const rng = mulberry32(seed);
  const samples = new Array(nBoot);
  const stakeArr = bets.map((b) => b.stake);
  const profitArr = bets.map((b) => b.profit);
  for (let bi = 0; bi < nBoot; bi++) {
    let sumStake = 0, sumProfit = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sumStake += stakeArr[idx];
      sumProfit += profitArr[idx];
    }
    samples[bi] = sumStake > 0 ? sumProfit / sumStake : 0;
  }
  samples.sort((a, b) => a - b);
  const alpha = 1 - conf;
  return {
    low: samples[Math.floor((alpha / 2) * nBoot)],
    high: samples[Math.floor((1 - alpha / 2) * nBoot)],
  };
}

function kellyMetrics(sim) {
  const n = sim.bets.length;
  if (n === 0) {
    return {
      profile: sim.profile, n_bets: 0, roi: 0,
      starting_bankroll: sim.starting_bankroll,
      final_bankroll: sim.final_bankroll,
      note: "no bets placed — Goldilocks band + sane-market filter admitted nothing",
    };
  }
  const wins = sim.bets.filter((b) => b.won).length;
  const totalStake = sim.bets.reduce((s, b) => s + b.stake, 0);
  const totalProfit = sim.bets.reduce((s, b) => s + b.profit, 0);
  const roi = sim.final_bankroll / sim.starting_bankroll - 1;

  // Max drawdown on the full trajectory.
  const bankrolls = sim.trajectory.map(([, bk]) => bk);
  let peak = -Infinity, maxDD = 0;
  for (const bk of bankrolls) {
    if (bk > peak) peak = bk;
    if (peak > 0) {
      const dd = (bk - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
  }

  const daily = dailyReturns(sim.trajectory);
  let sharpe = 0;
  if (daily.length >= 2) {
    const mean = daily.reduce((s, r) => s + r, 0) / daily.length;
    const variance = daily.reduce((s, r) => s + (r - mean) ** 2, 0) / daily.length;
    const std = Math.sqrt(variance);
    if (std > 0) sharpe = (mean / std) * Math.sqrt(252);
  }

  const buckets = {};
  for (const bk of EDGE_BUCKETS) buckets[bk.key] = { n: 0, wins: 0, pnl: 0 };
  for (const bet of sim.bets) {
    for (const bk of EDGE_BUCKETS) {
      if (bet.edge >= bk.lo && bet.edge < bk.hi) {
        buckets[bk.key].n++;
        if (bet.won) buckets[bk.key].wins++;
        buckets[bk.key].pnl += bet.profit;
        break;
      }
    }
  }
  for (const key of Object.keys(buckets)) {
    const b = buckets[key];
    b.hit_rate = b.n > 0 ? round4(b.wins / b.n) : null;
    // Keep the Python key name (`roi_on_bucket`) so consumers that already
    // read v2-oot-simulation.json don't need a rename. Value semantics are
    // identical: total profit / bet count for that edge bucket.
    b.roi_on_bucket = b.n > 0 ? round4(b.pnl / b.n) : null;
  }

  // Per-league ROI on stake (with bootstrap CI where n ≥ 30).
  const perLeague = {};
  const perLeagueBets = {};
  for (const bet of sim.bets) {
    const lg = bet.league;
    if (!perLeague[lg]) perLeague[lg] = { n: 0, wins: 0, stake: 0, pnl: 0 };
    perLeague[lg].n++;
    if (bet.won) perLeague[lg].wins++;
    perLeague[lg].stake += bet.stake;
    perLeague[lg].pnl += bet.profit;
    (perLeagueBets[lg] ||= []).push(bet);
  }
  for (const lg of Object.keys(perLeague)) {
    const pl = perLeague[lg];
    pl.hit_rate = round4(pl.wins / pl.n);
    pl.roi_on_stake = pl.stake > 0 ? round4(pl.pnl / pl.stake) : 0;
    // Seed derivation matches the Python approach in spirit — a stable
    // per-league seed so re-runs are reproducible without clashing.
    let seedHash = 0;
    for (let i = 0; i < lg.length; i++) seedHash = ((seedHash << 5) - seedHash + lg.charCodeAt(i)) | 0;
    const ci = bootstrapRoiOnStakeCI(perLeagueBets[lg], BOOTSTRAP_SEED + Math.abs(seedHash) % 100);
    if (ci) {
      pl.roi_ci95_low = round4(ci.low);
      pl.roi_ci95_high = round4(ci.high);
      pl.ci_excludes_zero = ci.low > 0 || ci.high < 0;
    } else {
      pl.roi_ci95_low = null;
      pl.roi_ci95_high = null;
      pl.ci_excludes_zero = false;
    }
  }

  return {
    profile: sim.profile,
    n_bets: n,
    wins,
    hit_rate: round4(wins / n),
    starting_bankroll: sim.starting_bankroll,
    final_bankroll: Math.round(sim.final_bankroll * 100) / 100,
    roi: round4(roi),
    total_stake: Math.round(totalStake * 100) / 100,
    total_profit: Math.round(totalProfit * 100) / 100,
    max_drawdown: round4(maxDD),
    sharpe_daily_annualised: Math.round(sharpe * 1000) / 1000,
    calmar: maxDD < 0 ? Math.round((roi / Math.abs(maxDD)) * 1000) / 1000 : null,
    edge_buckets: buckets,
    per_league: perLeague,
  };
}

function printConformalTable(results) {
  process.stdout.write("\n" + "═".repeat(92) + "\n");
  process.stdout.write("CONFORMAL DIAGNOSTICS  —  empirical coverage vs nominal (1−α), avg set size, singleton rate\n");
  process.stdout.write("═".repeat(92) + "\n");
  const alphaKeys = CONFORMAL_ALPHAS.map(alphaKey);
  process.stdout.write(
    `  ${"engine".padEnd(16)} ${"α".padStart(4)}  ${"nominal".padStart(8)}  ${"empirical".padStart(10)}  ${"delta".padStart(7)}  ${"set size".padStart(9)}  ${"singleton%".padStart(11)}\n`,
  );
  process.stdout.write(`  ${"─".repeat(92)}\n`);
  for (const [name, payload] of Object.entries(results)) {
    if (!payload.conformal) continue;
    for (const ak of alphaKeys) {
      const d = payload.conformal[ak];
      if (!d) continue;
      const delta = d.empirical_coverage - d.nominal_coverage;
      const deltaStr = (delta >= 0 ? "+" : "") + (delta * 100).toFixed(2) + "%";
      process.stdout.write(
        `  ${name.padEnd(16)} ${ak.padStart(4)}  ${(d.nominal_coverage * 100).toFixed(1).padStart(7)}%  ${(d.empirical_coverage * 100).toFixed(2).padStart(9)}%  ${deltaStr.padStart(7)}  ${d.avg_set_size.toFixed(3).padStart(9)}  ${(d.singleton_rate * 100).toFixed(1).padStart(10)}%\n`,
      );
    }
    process.stdout.write(`  ${"·".repeat(92)}\n`);
  }
  process.stdout.write("  delta > 0 = over-covers (wastes set size); delta < 0 = under-covers (guarantee violated)\n");
}

function printKellyTable(kellyResults, opts) {
  process.stdout.write("\n" + "═".repeat(96) + "\n");
  const gateStr = opts.conformalGate !== "off"
    ? `,  conformal-gate ${opts.conformalGate} (α=${opts.conformalAlpha})`
    : "";
  process.stdout.write(
    `KELLY ROI  —  profile ${opts.kellyProfile} (cap ${(RISK_CAPS[opts.kellyProfile] * 100).toFixed(1)}%),  Goldilocks [${(opts.edgeMin * 100).toFixed(1)}%, ${(opts.edgeMax * 100).toFixed(1)}%],  bankroll ${opts.bankroll}${gateStr}\n`,
  );
  process.stdout.write("═".repeat(96) + "\n");
  process.stdout.write(
    `  ${"engine".padEnd(16)} ${"bets".padStart(5)}  ${"hit%".padStart(6)}  ${"ROI".padStart(8)}  ${"final".padStart(10)}  ${"max DD".padStart(8)}  ${"Sharpe".padStart(7)}  ${"Calmar".padStart(7)}\n`,
  );
  process.stdout.write(`  ${"─".repeat(96)}\n`);
  for (const [name, k] of Object.entries(kellyResults)) {
    if (k.n_bets === 0) {
      process.stdout.write(`  ${name.padEnd(16)}  (${k.note})\n`);
      continue;
    }
    const roiStr = (k.roi >= 0 ? "+" : "") + (k.roi * 100).toFixed(2) + "%";
    const ddStr = (k.max_drawdown * 100).toFixed(2) + "%";
    const calmar = k.calmar == null ? "  —" : k.calmar.toFixed(2);
    process.stdout.write(
      `  ${name.padEnd(16)} ${String(k.n_bets).padStart(5)}  ${(k.hit_rate * 100).toFixed(2).padStart(6)}  ${roiStr.padStart(8)}  ${k.final_bankroll.toFixed(0).padStart(10)}  ${ddStr.padStart(8)}  ${k.sharpe_daily_annualised.toFixed(2).padStart(7)}  ${String(calmar).padStart(7)}\n`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

function main() {
  const opts = parseArgs();

  process.stdout.write("FODZE Cross-Engine OOT Backtest\n");
  ensureMergedFresh(opts.mergedPath);

  let rows = loadMerged(opts.mergedPath);
  if (opts.league) rows = rows.filter((r) => r.league === opts.league);
  if (opts.limit > 0) rows = rows.slice(-opts.limit);
  if (rows.length === 0) {
    process.stderr.write("no rows after filters — aborting\n");
    process.exit(1);
  }
  process.stdout.write(`  ${rows.length} rows loaded, ${new Set(rows.map((r) => r.league)).size} leagues\n`);

  const dirichletJson = JSON.parse(readFileSync(opts.dirichletPath, "utf8"));
  const benterJson = JSON.parse(readFileSync(opts.benterPath, "utf8"));

  // Conformal loader — only materializes when the user asks for
  // diagnostics or kelly gating. Skipping the read keeps the happy-path
  // startup cost at two JSON parses, same as before.
  const wantConformal = opts.conformal || opts.conformalGate !== "off";
  const conformalJson = wantConformal ? JSON.parse(readFileSync(opts.conformalPath, "utf8")) : null;
  const conformalGateFn = conformalJson ? makeConformalGate(conformalJson) : null;

  const engineFns = {};
  for (const name of opts.engines) {
    if (name === "v2_raw") engineFns[name] = engineV2Raw;
    else if (name === "v2_dirichlet") engineFns[name] = makeDirichletEngine(dirichletJson);
    else if (name === "v2_benter") engineFns[name] = makeBenterEngine(benterJson);
    else if (name === "v1") engineFns[name] = engineV1;
  }

  const scored = scoreAll(rows, engineFns);
  const actualArr = rows.map((r) => r.ft_result);
  const leagues = [...new Set(rows.map((r) => r.league))].sort();

  const results = {};
  for (const [name, payload] of Object.entries(scored)) {
    const overall = computeMetrics(payload.probs, actualArr, opts.bootstrap);
    const per_league = {};
    for (const lg of leagues) {
      const lgIdx = [];
      for (let i = 0; i < rows.length; i++) if (rows[i].league === lg) lgIdx.push(i);
      const lgProbs = lgIdx.map((i) => payload.probs[i]);
      const lgAct = lgIdx.map((i) => actualArr[i]);
      per_league[lg] = computeMetrics(lgProbs, lgAct, opts.bootstrap);
    }
    results[name] = { overall, per_league, applied_n: payload.applied_n };
    if (opts.conformal && conformalGateFn) {
      results[name].conformal = computeConformalDiagnostics(
        rows, payload.probs, conformalGateFn, CONFORMAL_ALPHAS,
      );
    }
  }

  printOverallTable(results, rows);
  if (opts.perLeague) printPerLeagueTable(results);
  if (opts.conformal && conformalGateFn) printConformalTable(results);

  // ─── Kelly simulation (opt-in) ──────────────────────────────────
  let kellyResults = null;
  let kellyEnforceResults = null;
  const sortedRows = rows.slice().sort((a, b) => a.match_date.localeCompare(b.match_date));
  function runKelly(gateMode) {
    const out = {};
    for (const name of opts.engines) {
      const sim = simulateKelly(sortedRows, engineFns[name], {
        profile: opts.kellyProfile,
        bankroll: opts.bankroll,
        edgeMin: opts.edgeMin,
        edgeMax: opts.edgeMax,
        maxOverround: opts.maxOverround,
        minMarketProb: opts.minMarketProb,
        maxMarketProb: opts.maxMarketProb,
        conformalGateFn: gateMode !== "off" ? conformalGateFn : null,
        conformalGateMode: gateMode,
        conformalAlpha: opts.conformalAlpha,
      });
      out[name] = kellyMetrics(sim);
    }
    return out;
  }
  if (opts.kelly) {
    // Chronological ordering matters for compounding bankroll math to
    // match the Python simulation exactly. The merged JSONL order is
    // inherited from pandas.merge, which isn't guaranteed sorted.
    kellyResults = runKelly(opts.conformalGate);
    printKellyTable(kellyResults, opts);
  }
  // When publishing to the UI, also run an "enforce α=0.10" pair so the
  // tab can show the gated vs. unguarded story side-by-side without a
  // second CLI invocation. Skipped outside --publish to keep the default
  // run fast.
  if (opts.publish && conformalGateFn && opts.conformalGate === "off") {
    kellyEnforceResults = runKelly("enforce");
  }

  const outDir = dirname(opts.outPath);
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outputJson = {
    generated_at: new Date().toISOString(),
    source_merged: relative(PROJECT_ROOT, opts.mergedPath),
    dirichlet_artifact: relative(PROJECT_ROOT, opts.dirichletPath),
    benter_artifact: relative(PROJECT_ROOT, opts.benterPath),
    n_rows: rows.length,
    n_leagues: leagues.length,
    league_filter: opts.league,
    engines: results,
  };
  if (conformalJson) {
    outputJson.conformal_artifact = relative(PROJECT_ROOT, opts.conformalPath);
  }
  if (kellyResults) {
    outputJson.kelly = {
      profile: opts.kellyProfile,
      starting_bankroll: opts.bankroll,
      edge_min: opts.edgeMin,
      edge_max: opts.edgeMax,
      max_overround: opts.maxOverround,
      min_market_prob: opts.minMarketProb,
      max_market_prob: opts.maxMarketProb,
      conformal_gate: opts.conformalGate,
      conformal_alpha: opts.conformalGate !== "off" ? opts.conformalAlpha : null,
      per_engine: kellyResults,
    };
  }
  if (kellyEnforceResults) {
    outputJson.kelly_enforce = {
      profile: opts.kellyProfile,
      starting_bankroll: opts.bankroll,
      edge_min: opts.edgeMin,
      edge_max: opts.edgeMax,
      max_overround: opts.maxOverround,
      min_market_prob: opts.minMarketProb,
      max_market_prob: opts.maxMarketProb,
      conformal_gate: "enforce",
      conformal_alpha: opts.conformalAlpha,
      per_engine: kellyEnforceResults,
    };
  }
  writeFileSync(opts.outPath, JSON.stringify(outputJson, null, 2));
  process.stdout.write(`\n  written: ${relative(PROJECT_ROOT, opts.outPath)}\n`);

  if (opts.publish) {
    const publicDir = join(PROJECT_ROOT, "public");
    if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });
    const publishPath = join(publicDir, "backtest-summary.json");
    writeFileSync(publishPath, JSON.stringify(buildPublicSummary(outputJson), null, 2));
    process.stdout.write(`  published: ${relative(PROJECT_ROOT, publishPath)}\n`);
  }
}

// Strip the full-detail JSON down to the numbers a UI actually needs:
// overall metrics, per-league BSS (scalar only — drop reliability diagrams
// and bootstrap CIs' n_boot/excludes_zero flag), conformal coverage
// summary, Kelly top-line. Target: < 10 KB gzipped so it ships in the
// bundle without bloat.
function buildPublicSummary(full) {
  const slim = {
    generated_at: full.generated_at,
    n_rows: full.n_rows,
    n_leagues: full.n_leagues,
    engines: {},
  };
  for (const [name, r] of Object.entries(full.engines)) {
    const ov = r.overall;
    slim.engines[name] = {
      overall: {
        n: ov.n,
        brier: ov.brier,
        brier_skill_score: ov.brier_skill_score,
        log_loss: ov.log_loss,
        rps: ov.rps,
        ece_10bucket: ov.ece_10bucket,
        base_rate: ov.base_rate,
        bss_ci95: ov.bss_ci95 ? { low: ov.bss_ci95.low, high: ov.bss_ci95.high } : null,
      },
      applied_n: r.applied_n,
      per_league_bss: Object.fromEntries(
        Object.entries(r.per_league).map(([lg, m]) => [lg, {
          n: m.n, bss: m.brier_skill_score, log_loss: m.log_loss, ece: m.ece_10bucket,
        }]),
      ),
    };
    if (r.conformal) {
      slim.engines[name].conformal = Object.fromEntries(
        Object.entries(r.conformal).map(([alpha, d]) => [alpha, {
          nominal_coverage: d.nominal_coverage,
          empirical_coverage: d.empirical_coverage,
          avg_set_size: d.avg_set_size,
          singleton_rate: d.singleton_rate,
        }]),
      );
    }
  }
  const slimKelly = (k) => ({
    profile: k.profile,
    starting_bankroll: k.starting_bankroll,
    edge_min: k.edge_min,
    edge_max: k.edge_max,
    conformal_gate: k.conformal_gate,
    conformal_alpha: k.conformal_alpha,
    per_engine: Object.fromEntries(
      Object.entries(k.per_engine).map(([name, p]) => [name, {
        n_bets: p.n_bets,
        hit_rate: p.hit_rate ?? 0,
        roi: p.roi ?? 0,
        final_bankroll: p.final_bankroll ?? p.starting_bankroll ?? 0,
        max_drawdown: p.max_drawdown ?? 0,
        sharpe_daily_annualised: p.sharpe_daily_annualised ?? 0,
        note: p.note ?? null,
      }]),
    ),
  });
  if (full.kelly) slim.kelly = slimKelly(full.kelly);
  if (full.kelly_enforce) slim.kelly_enforce = slimKelly(full.kelly_enforce);
  return slim;
}

main();

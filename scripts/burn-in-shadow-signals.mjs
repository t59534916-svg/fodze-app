#!/usr/bin/env node
/**
 * burn-in-shadow-signals.mjs
 * v1.1 Asymmetric Negation Protocol · Mandate M2 graduation gate
 *
 * Reads SHADOW_LOG_ONLY trails from `epistemic_trails`, joins with
 * `match_outcomes` to compute empirical hit-rate vs predicted, and emits a
 * graduation recommendation when N ≥ 200 and the signal is empirically
 * robust (predicted_hwrate − observed_hwrate within 5pp).
 *
 * USAGE:
 *   node scripts/burn-in-shadow-signals.mjs           # report only
 *   node scripts/burn-in-shadow-signals.mjs --json    # machine-readable
 *   node scripts/burn-in-shadow-signals.mjs --min-n 100  # override threshold
 *
 * EXIT CODES:
 *   0   report generated (regardless of graduation)
 *   1   network / Supabase failure
 *
 * INTEGRATION:
 *   Run as a weekly cron after match_outcomes are populated (Saturdays 06:00).
 *   When a signal graduates, remove it from `SHADOW_LOG_ONLY` set in
 *   src/lib/goldilocks-engine.ts and ship a new release.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeTrails, aggregateBurnIn } from "./_lib/trail-aggregations.mjs";
import { buildInFilter } from "./_lib/postgrest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── env ────────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
// service_role EXCLUSIVELY (2026-05-28) — bypasses RLS; reads epistemic_trails
// + match_outcomes without per-row auth-subquery CPU. Cron job, server-side only.
const SUPA_KEY = env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("✗ missing Supabase env vars");
  process.exit(1);
}

// ─── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const minN = (() => {
  const i = argv.indexOf("--min-n");
  return i >= 0 ? parseInt(argv[i + 1], 10) : 200;
})();
const eps = 0.05; // 5 pp graduation threshold

// ─── helpers ────────────────────────────────────────────────────────────
const supaGet = async (path) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
};

const supaPaginated = async (path, pageSize = 1000) => {
  const all = [];
  let offset = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await supaGet(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
};

// ─── load shadow trails + outcomes ──────────────────────────────────────
const t0 = Date.now();
console.error("Loading shadow trails + outcomes…");

const trailsRaw = await supaPaginated(
  "epistemic_trails?select=trap_kind,match_key,match_kickoff,league,predicted_hw_rate,raw_signals,detected_at&shadow=eq.true&order=detected_at.desc",
);

// Dedupe by (trap_kind, match_key) — same trap firing on the same match
// across N page-reloads creates N rows (unique on detected_at). We want
// ONE observation per (trap, match) in the burn-in statistics. Pure-function
// version lives in scripts/_lib/trail-aggregations.mjs and is unit-tested.
const trails = dedupeTrails(trailsRaw);
console.error(`  trails: ${trails.length} (deduped from ${trailsRaw.length} raw)`);

if (trails.length === 0) {
  const report = { generated_at: new Date().toISOString(), trails: 0, signals: {} };
  console.log(wantJson ? JSON.stringify(report, null, 2) : "no shadow trails found · burn-in skipped");
  process.exit(0);
}

const matchKeys = [...new Set(trails.map((t) => t.match_key))];

// Outcomes — paginate through IN-filter chunks (Supabase URL length limit).
// `buildInFilter` does PostgREST-quote-escape THEN URL-encode in the right
// order; a match_key containing a `"` or `\` would otherwise silently
// truncate the in-list with no error.
const outcomes = [];
const chunk = 200;
for (let i = 0; i < matchKeys.length; i += chunk) {
  const slice = matchKeys.slice(i, i + chunk);
  const part = await supaGet(
    `match_outcomes?select=match_key,outcome_1x2&${buildInFilter("match_key", slice)}`,
  );
  outcomes.push(...part);
}
console.error(`  outcomes: ${outcomes.length} (of ${matchKeys.length} matches)`);

// ─── analysis ───────────────────────────────────────────────────────────
const outcomeMap = new Map(outcomes.map((o) => [o.match_key, o.outcome_1x2]));
const { signals } = aggregateBurnIn(trails, outcomeMap, { minN, eps });

const report = {
  generated_at: new Date().toISOString(),
  trails_total: trails.length,
  matches_resolved: outcomes.length,
  min_n_threshold: minN,
  graduation_eps_pp: eps * 100,
  signals,
  duration_ms: Date.now() - t0,
};

// ─── output ─────────────────────────────────────────────────────────────
if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.error("");
  console.log("═══ SHADOW SIGNAL BURN-IN REPORT ═══");
  console.log(`generated:  ${report.generated_at}`);
  console.log(`trails:     ${report.trails_total} (${report.matches_resolved} resolved)`);
  console.log(`threshold:  n ≥ ${minN}, |delta| ≤ ${eps * 100}pp`);
  console.log("");
  for (const [name, s] of Object.entries(signals)) {
    console.log(`◇ ${name}`);
    console.log(`  n = ${s.n}`);
    console.log(`  observed HW: ${s.observed_hw_rate} · predicted: ${s.mean_predicted_hw_rate} · Δ = ${s.delta_pp}pp`);
    console.log(`  → ${s.recommendation}`);
    console.log("");
  }
}

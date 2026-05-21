#!/usr/bin/env node
/**
 * clv-trap-decay.mjs
 * v1.1 Asymmetric Negation Protocol · Mandate M8 CLV-reflexivity watcher
 *
 * Reads unresolved `epistemic_trails` (kickoff in the past, clv_resolved_at
 * NULL), joins with `odds_closing_history`, computes whether the sharp
 * market moved AGAINST our trap signal, and writes back to the row.
 *
 * Aggregate per trap_kind:
 *   moved_against_us rate ≈ 50%   → sharp markets have priced in this trap
 *                                    → deprecation candidate
 *   moved_against_us rate << 50%  → trap is still alpha (sharp ≠ converging)
 *
 * "Moved against us" definition:
 *   We veto when our engine projects HW_rate > market_HW_rate (engine thinks
 *   home wins more than market priced in). A "real" trap means actual outcome
 *   was BELOW market — i.e., market was right, engine wrong, trap was correct
 *   to fire. CLV-decay watches whether the *closing* market (post our entry)
 *   moved toward the engine prediction (market converged on our edge → no
 *   alpha left) or away (market still disagrees → trap still valid).
 *
 * IMPLEMENTATION: closing_odds_implied_hwrate = 1 / psch (home decimal odds).
 *   If closing_hwrate moved CLOSER to predicted_hw_rate → markt converged → 1.
 *   If closing_hwrate stayed BELOW our prediction → trap remains valid → 0.
 *
 * USAGE:
 *   node scripts/clv-trap-decay.mjs            # resolve unresolved rows + log
 *   node scripts/clv-trap-decay.mjs --dry      # report only, no DB writes
 *   node scripts/clv-trap-decay.mjs --json     # machine-readable
 *
 * EXIT CODES:
 *   0   success
 *   1   network / Supabase failure
 *
 * INTEGRATION: daily cron, AFTER snapshot-closing-odds.mjs runs.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateClvDecay } from "./_lib/trail-aggregations.mjs";
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
const SUPA_KEY = env.SUPABASE_SERVICE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("✗ missing Supabase env vars");
  process.exit(1);
}

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const wantJson = argv.includes("--json");

// ─── helpers ────────────────────────────────────────────────────────────
const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

const get = async (path) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
};

const patch = async (path, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}: ${await r.text()}`);
};

// ─── 1. find unresolved trails (kickoff in past, no clv_resolved_at yet) ──
const nowUnixSec = Math.floor(Date.now() / 1000);
const t0 = Date.now();
console.error("Loading unresolved trails …");

const trails = await (async () => {
  const all = [];
  let offset = 0;
  while (true) {
    const page = await get(
      `epistemic_trails?select=id,trap_kind,match_key,match_kickoff,predicted_hw_rate` +
        `&clv_resolved_at=is.null&match_kickoff=lt.${nowUnixSec}` +
        `&limit=1000&offset=${offset}`,
    );
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return all;
})();
console.error(`  unresolved trails: ${trails.length}`);

if (trails.length === 0) {
  const report = { generated_at: new Date().toISOString(), unresolved: 0, by_trap: {} };
  console.log(wantJson ? JSON.stringify(report, null, 2) : "no unresolved trails · nothing to do");
  process.exit(0);
}

// ─── 2. fetch closing odds per match_key (chunked IN-filter) ───────────
const matchKeys = [...new Set(trails.map((t) => t.match_key))];
const closingByKey = new Map();
const chunk = 200;
for (let i = 0; i < matchKeys.length; i += chunk) {
  const slice = matchKeys.slice(i, i + chunk);
  // buildInFilter handles PostgREST-quote-escape + URL-encode in the right
  // order. A bare encodeURIComponent (the pre-fix version) lets `"` or `\`
  // in a match_key silently terminate the in-list.
  const page = await get(
    `odds_closing_history?select=match_key,psch,pscd,psca&${buildInFilter("match_key", slice)}`,
  );
  for (const row of page) closingByKey.set(row.match_key, row);
}
console.error(`  closing-odds matched: ${closingByKey.size} / ${matchKeys.length}`);

// ─── 3. classify each trail (pure-function in scripts/_lib) ─────────────
// "moved_against_us" = closing market converged toward our engine's prediction
// (distance from predicted_hw_rate < decayEps). Aggregation deduped by
// (trap, match) so page-reload re-emissions don't double-count.
const decay_eps = 0.03; // 3pp = converged
const { updates, byTrap: by_trap } = aggregateClvDecay(trails, closingByKey, {
  decayEps: decay_eps,
});

// ─── 4. write back ──────────────────────────────────────────────────────
if (!dry) {
  for (const u of updates) {
    await patch(`epistemic_trails?id=eq.${u.id}`, {
      closing_odds: u.closing_odds,
      moved_against_us: u.moved_against_us,
      clv_resolved_at: u.clv_resolved_at,
    });
  }
}

// ─── 5. aggregate by trap_kind — already done by aggregateClvDecay ─────
const report = {
  generated_at: new Date().toISOString(),
  unresolved: trails.length,
  closing_odds_matched: closingByKey.size,
  rows_updated: dry ? 0 : updates.length,
  decay_eps_pp: decay_eps * 100,
  by_trap,
  duration_ms: Date.now() - t0,
};

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.error("");
  console.log("═══ CLV-TRAP-DECAY REPORT ═══");
  console.log(`generated:    ${report.generated_at}`);
  console.log(`unresolved:   ${report.unresolved}`);
  console.log(`matched:      ${report.closing_odds_matched}`);
  console.log(`updated:      ${report.rows_updated}${dry ? " (dry-run)" : ""}`);
  console.log("");
  for (const [name, s] of Object.entries(by_trap)) {
    console.log(`◇ ${name}`);
    console.log(`  n=${s.n}, converged=${s.converged} (${s.convergence_rate})`);
    console.log(`  → ${s.status}`);
    console.log("");
  }
}

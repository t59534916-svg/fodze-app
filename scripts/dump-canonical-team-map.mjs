#!/usr/bin/env node
/**
 * Dump (league, raw_name) → canonical name map for all teams across
 * `odds_closing_history` and `team_xg_history` into a single JSON, so
 * Python tooling can do fast canonical lookup without re-implementing
 * the resolver.
 *
 * Output: tools/v4/diagnostics/canonical-team-map.json
 *   {
 *     "bundesliga": {
 *       "bayern munich": "FC Bayern München",
 *       "fc bayern münchen": "FC Bayern München",
 *       ...
 *     },
 *     ...
 *   }
 *
 * Re-run when canonical-team.mjs's TEAM_REGISTRY or EXTRA_ALIASES changes.
 *
 * Usage: node scripts/dump-canonical-team-map.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── env ────────────────────────────────────────────────────────────
const envPath = resolve(REPO_ROOT, ".env.local");
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^['"]|['"]$/g, "");
  }
}
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
// service_role EXCLUSIVELY (2026-05-28) — bypasses RLS read-side auth-subquery
// CPU when dumping team_xg_history + odds_closing_history. Local/cron only.
const SUPA_KEY =
  env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("✗ missing Supabase env vars");
  process.exit(1);
}

const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

// Paginated GET
async function fetchAll(path) {
  const all = [];
  let offset = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${SUPA_URL}/rest/v1/${path}${sep}limit=1000&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}: ${await r.text()}`);
    const page = await r.json();
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return all;
}

// ─── Collect unique (league, team_name) pairs ──────────────────────
console.log("Collecting unique team names from odds_closing_history...");
const oddsRows = await fetchAll(
  "odds_closing_history?select=league,home_team,away_team",
);
console.log(`  fetched ${oddsRows.length} odds rows`);

console.log("Collecting unique team names from team_xg_history...");
const xgRows = await fetchAll("team_xg_history?select=league,team,opponent");
console.log(`  fetched ${xgRows.length} team_xg rows`);

// Build the map
const map = {};
let n_team_xg = 0,
  n_odds = 0;

function add(league, name) {
  if (!league || !name) return;
  if (!map[league]) map[league] = {};
  const key = name.toLowerCase();
  if (!(key in map[league])) {
    map[league][key] = canonicalize(name, league);
  }
}

for (const r of oddsRows) {
  add(r.league, r.home_team);
  add(r.league, r.away_team);
  n_odds++;
}
for (const r of xgRows) {
  add(r.league, r.team);
  add(r.league, r.opponent);
  n_team_xg++;
}

// Statistics
let total = 0,
  changed = 0;
for (const lg of Object.keys(map)) {
  for (const [k, v] of Object.entries(map[lg])) {
    total++;
    if (k.toLowerCase() !== v.toLowerCase()) changed++;
  }
}
console.log(
  `\nBuilt canonical map: ${total} unique (league, name) pairs · ${changed} changed (${((100 * changed) / total).toFixed(1)}%)`,
);

// ─── Dump JSON ──────────────────────────────────────────────────────
const outPath = resolve(REPO_ROOT, "tools", "v4", "diagnostics", "canonical-team-map.json");
writeFileSync(outPath, JSON.stringify(map, null, 2));
console.log(`\n✓ wrote ${outPath}`);

// Sample for verification
console.log("\nSample entries:");
const sampleLeagues = ["bundesliga", "epl", "la_liga"].filter((l) => l in map);
for (const lg of sampleLeagues) {
  const entries = Object.entries(map[lg]).slice(0, 5);
  console.log(`  ${lg}:`);
  for (const [k, v] of entries) {
    const arrow = k.toLowerCase() === v.toLowerCase() ? "≈" : "→";
    console.log(`    ${k.padEnd(40)} ${arrow} ${v}`);
  }
}

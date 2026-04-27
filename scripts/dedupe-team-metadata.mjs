#!/usr/bin/env node
/**
 * FODZE — Team Metadata Deduplication
 * ════════════════════════════════════════════════════════════════════
 *
 * Same alias-pollution problem as team_xg_history (fixed in 6ce7162):
 * team_metadata has 29 distinct rows for Bundesliga (real: 18) because
 * TheSportsDB sync wrote the same team under multiple naming conventions
 * — "Augsburg" + "FC Augsburg", "Bayern Munich" + "FC Bayern München",
 * "FC Koln" + "1. FC Köln" + "Köln", etc.
 *
 * Effects:
 *   - Logo / color lookups in MatchCard hit one of N rows non-deterministically
 *   - Stadium/capacity may be wrong if the alias-row has stale data
 *   - Cross-source IDs (api_sports_id, thesportsdb_id) split across aliases
 *
 * This script:
 *   1. For each (fodze_league, team_name) row, compute canonical name
 *   2. If multiple rows in the same league map to the same canonical →
 *      MERGE: keep the row with the most populated columns, delete others
 *   3. PATCH the survivor's team_name to canonical
 *
 * Idempotent. UNIQUE (fodze_league, team_name) constraint will reject
 * concurrent UPDATE-to-canonical when a canonical row already exists,
 * which we handle by deleting the alias-row.
 *
 * Usage:
 *   node scripts/dedupe-team-metadata.mjs --dry              # preview
 *   node scripts/dedupe-team-metadata.mjs                    # apply
 *   node scripts/dedupe-team-metadata.mjs --league bundesliga --dry
 * ════════════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader ────────────────────────────────────────────────
const envPath = resolve(REPO_ROOT, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && !process.env[t.slice(0, eq)]) {
      process.env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error("❌ Missing SUPABASE env"); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LEAGUE = args.find((_, i) => args[i - 1] === "--league");

const SUPA_HEADERS = {
  apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function fetchAll(url) {
  const out = []; const PAGE = 1000; let offset = 0;
  while (true) {
    const r = await fetch(`${url}&limit=${PAGE}&offset=${offset}`, { headers: SUPA_HEADERS });
    if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${await r.text()}`);
    const page = await r.json();
    if (page.length === 0) break;
    out.push(...page); offset += PAGE;
    if (page.length < PAGE) break;
  }
  return out;
}

// "Richness" of a team_metadata row — used to pick the survivor in a merge.
// Rows with logos + colors + stable IDs win over rows with just a name.
function richness(row) {
  let score = 0;
  if (row.logo_url) score += 5;
  if (row.color_primary) score += 3;
  if (row.color_secondary) score += 2;
  if (row.thesportsdb_id) score += 4;
  if (row.api_sports_id) score += 4;
  if (row.stadium) score += 2;
  if (row.stadium_capacity) score += 2;
  if (row.founded_year) score += 1;
  if (row.description_en) score += 2;
  if (row.team_short) score += 1;
  if (row.team_alternate) score += 1;
  if (row.jersey_url) score += 1;
  return score;
}

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  FODZE Team Metadata Deduplication${DRY ? " (DRY)" : ""}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  let url = `${SUPA_URL}/rest/v1/team_metadata?select=*`;
  if (LEAGUE) url += `&fodze_league=eq.${LEAGUE}`;
  const all = await fetchAll(url);
  console.log(`📚 ${all.length} team_metadata rows fetched\n`);

  // Group by league
  const byLeague = new Map();
  for (const row of all) {
    const lg = row.fodze_league;
    if (!lg) continue;
    if (!byLeague.has(lg)) byLeague.set(lg, []);
    byLeague.get(lg).push(row);
  }

  let totalDeletes = 0, totalPatches = 0;
  const plan = [];

  for (const [league, rows] of byLeague.entries()) {
    // Group rows by canonical-name
    const byCanonical = new Map();
    for (const row of rows) {
      const canonical = canonicalize(row.team_name, league);
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
      byCanonical.get(canonical).push(row);
    }

    const renames = []; // [oldRow, canonical]
    const merges = [];  // {survivor, deletes[], canonical}

    for (const [canonical, group] of byCanonical.entries()) {
      if (group.length === 1) {
        const row = group[0];
        if (row.team_name !== canonical) {
          renames.push({ row, canonical });
        }
        continue;
      }
      // Multi-row group: pick richest as survivor, delete rest
      group.sort((a, b) => richness(b) - richness(a));
      const survivor = group[0];
      const deletes = group.slice(1);
      merges.push({ survivor, deletes, canonical });
    }

    if (renames.length === 0 && merges.length === 0) continue;
    console.log(`══ ${league} ══`);
    console.log(`  Rows in DB: ${rows.length}`);
    console.log(`  Distinct canonicals: ${byCanonical.size}`);
    console.log(`  Pure renames: ${renames.length}`);
    console.log(`  Merge-clusters: ${merges.length}`);

    for (const { row, canonical } of renames) {
      console.log(`    rename "${row.team_name}" → "${canonical}"`);
    }
    for (const { survivor, deletes, canonical } of merges) {
      const deleteList = deletes.map(d => `"${d.team_name}"`).join(", ");
      console.log(`    merge → "${canonical}": survivor "${survivor.team_name}" (richness=${richness(survivor)}), delete ${deleteList}`);
    }
    plan.push({ league, renames, merges });
    totalPatches += renames.length;
    totalDeletes += merges.reduce((s, m) => s + m.deletes.length, 0);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  Renames: ${totalPatches}`);
  console.log(`  Deletes: ${totalDeletes}`);

  if (DRY) {
    console.log(`\n  DRY mode — no changes written. Re-run without --dry to apply.\n`);
    return;
  }

  // Apply: deletes first (release UNIQUE constraint conflicts), then renames
  let applied = 0;
  for (const { league, merges } of plan) {
    for (const { survivor, deletes, canonical } of merges) {
      // Promote survivor to canonical (or rename in place)
      if (survivor.team_name !== canonical) {
        // Delete aliases first to clear UNIQUE
        for (const d of deletes) {
          await fetch(`${SUPA_URL}/rest/v1/team_metadata?id=eq.${d.id}`, {
            method: "DELETE", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
          });
        }
        // Rename survivor
        await fetch(`${SUPA_URL}/rest/v1/team_metadata?id=eq.${survivor.id}`, {
          method: "PATCH", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
          body: JSON.stringify({ team_name: canonical }),
        });
      } else {
        // Survivor IS canonical — delete aliases
        for (const d of deletes) {
          await fetch(`${SUPA_URL}/rest/v1/team_metadata?id=eq.${d.id}`, {
            method: "DELETE", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
          });
        }
      }
      applied += deletes.length;
    }
  }
  for (const { renames } of plan) {
    for (const { row, canonical } of renames) {
      const r = await fetch(`${SUPA_URL}/rest/v1/team_metadata?id=eq.${row.id}`, {
        method: "PATCH", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ team_name: canonical }),
      });
      if (r.ok) applied++;
      else if (r.status === 409) {
        // Canonical already exists in same league, delete this alias
        await fetch(`${SUPA_URL}/rest/v1/team_metadata?id=eq.${row.id}`, {
          method: "DELETE", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
        });
        applied++;
      }
    }
  }
  console.log(`\n✅ Done — ${applied} mutations applied\n`);
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exit(1); });

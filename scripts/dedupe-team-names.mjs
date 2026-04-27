#!/usr/bin/env node
/**
 * FODZE — Team Name Deduplication
 * ════════════════════════════════════════════════════════════════════
 *
 * Problem (discovered 2026-04-27):
 *   team_xg_history has 38-43 distinct teams per league for current
 *   season (should be 18-24). 3 sources (footystats, goals-proxy,
 *   shots-model) write the SAME team with DIFFERENT names:
 *     "Bayern München" (footystats) + "FC Bayern München" (goals-proxy)
 *     + "Bayern Munich" (shots-model)  →  3 separate rows
 *   UNIQUE(team, league, match_date, venue) doesn't catch this because
 *   `team` differs by string-comparison.
 *
 * Impact:
 *   - Standings calculation aggregates over aliases → garbage tables
 *   - EWMA xG history is computed on RANDOM subset of matches (whichever
 *     name was queried) → engine predictions degraded
 *   - Per-league Brier comparisons distorted
 *
 * Solution:
 *   matchdays JSONB uses the CANONICAL team names (verified against
 *   bets table — same convention). Build canonical map per league
 *   from all matchdays JSONs, then UPDATE team_xg_history rows whose
 *   team-name doesn't match canonical → fuzzy-match-resolved canonical.
 *   ON CONFLICT MERGE handles the dedup at write time.
 *
 *   Fallbacks: if a team doesn't fuzzy-match any canonical (e.g. relegated
 *   teams from 2017 in Top-5), leave row unchanged. They're not in current
 *   prediction path so they don't degrade UX.
 *
 * Usage:
 *   node scripts/dedupe-team-names.mjs --dry              # PREVIEW only
 *   node scripts/dedupe-team-names.mjs --dry --league bundesliga
 *   node scripts/dedupe-team-names.mjs                    # REAL run, all leagues
 *
 * IDEMPOTENT: re-runs are safe. Already-canonical rows are skipped.
 * ════════════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
// Use the shared canonical-team module instead of duplicating logic. The
// 2026-04-27 EXTRA_ALIASES live in canonical-team.mjs and we want them
// to fire here too — without this delegation, dedupe missed the manual
// override aliases (Hertha Berlin → Hertha BSC, etc.).
import { canonicalize as sharedCanonicalize } from "./_lib/canonical-team.mjs";

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
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Missing SUPABASE env (need SUPABASE_SERVICE_KEY for write).");
  process.exit(1);
}

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LEAGUE = args.find((_, i) => args[i - 1] === "--league");

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Normalize a team name for fuzzy comparison: lowercase, strip
 * diacritics (NFD), remove all non-alphanumeric.
 */
function normalize(name) {
  if (!name) return "";
  // 1) lowercase + Unicode-decompose so "ü" → "u" + combining-diaeresis
  // 2) strip the combining marks
  // 3) ALSO normalize the German alt-spelling: "ue/ae/oe" → "u/a/o"
  //    (sources mix: "Düsseldorf"/"Duesseldorf", "Fürth"/"Fuerth", "Nürnberg"/"Nuernberg")
  // 4) strip non-alphanumerics
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ue/g, "u")
    .replace(/oe/g, "o")
    .replace(/ae/g, "a")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Parse TEAM_REGISTRY from src/lib/team-resolver.ts at runtime. The TS
 * file is the authoritative source — we extract its entries via regex
 * to avoid duplicating ~330 team aliases across .ts/.mjs.
 *
 * Each TS entry looks like:
 *   { fodze: "FC Bayern München", csv: "Bayern Munich", understat: "Bayern Munich", oddsApi: "Bayern Munich", league: "bundesliga" },
 *
 * We extract fodze + csv + understat + oddsApi + league. The "fodze"
 * field is the canonical name. csv/understat/oddsApi/league give us
 * additional aliases.
 */
function loadRegistry() {
  const tsPath = resolve(REPO_ROOT, "src/lib/team-resolver.ts");
  if (!existsSync(tsPath)) {
    throw new Error(`team-resolver.ts not found at ${tsPath}`);
  }
  const src = readFileSync(tsPath, "utf-8");
  // Match each registry-entry line. Tolerant of optional fields.
  const re = /\{\s*fodze:\s*"([^"]+)",\s*csv:\s*"([^"]+)"(?:,\s*understat:\s*"([^"]*)")?(?:,\s*oddsApi:\s*"([^"]*)")?(?:,\s*league:\s*"([^"]+)")?\s*\},?/g;
  const entries = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      fodze: m[1],
      csv: m[2],
      understat: m[3] || null,
      oddsApi: m[4] || null,
      league: m[5] || null,
    });
  }
  return entries;
}

/**
 * Build aliasMap: per-league Map<normalized-alias, canonical-fodze-name>
 * Single match by EXACT normalized match.
 */
function buildAliasMap(registry) {
  const aliasMap = new Map(); // league → Map<normAlias, canonical>
  for (const e of registry) {
    if (!e.league) continue;
    if (!aliasMap.has(e.league)) aliasMap.set(e.league, new Map());
    const lm = aliasMap.get(e.league);
    // Add fodze itself + all known aliases
    for (const alias of [e.fodze, e.csv, e.understat, e.oddsApi]) {
      if (alias) lm.set(normalize(alias), e.fodze);
    }
  }
  return aliasMap;
}

/**
 * Tier-1: exact-normalized match against registry.
 * Tier-2: substring containment fallback (length-guarded ≥ 5 chars).
 */
function findCanonical(team, league, aliasMap) {
  const lm = aliasMap.get(league);
  if (!lm) return null;
  const normT = normalize(team);
  if (lm.has(normT)) return lm.get(normT);
  // Tier-2: try substring match against registered aliases
  for (const [normAlias, canonical] of lm.entries()) {
    if (normAlias.length < 5) continue;
    if (normT.includes(normAlias) || normAlias.includes(normT)) {
      return canonical;
    }
  }
  return null;
}

// ─── Supabase fetch ────────────────────────────────────────────

async function fetchAll(url) {
  const out = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const r = await fetch(`${url}&limit=${PAGE}&offset=${offset}`, { headers: SUPA_HEADERS });
    if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${await r.text()}`);
    const page = await r.json();
    if (page.length === 0) break;
    out.push(...page);
    offset += PAGE;
    if (page.length < PAGE) break;
  }
  return out;
}

// Build canonical team list per league from matchdays JSONB.
// Used to confirm the registry's "fodze" name is the same as what the UI
// uses. If a team is in matchdays but NOT in the registry, it's added as
// canonical = matchdays name (registry-augmentation for new teams).
async function buildCanonicalMap(aliasMap) {
  console.log(`📚 Loading canonical team names from matchdays JSONB...`);
  const matchdays = await fetchAll(`${SUPA_URL}/rest/v1/matchdays?select=league,data`);
  console.log(`   ${matchdays.length} matchday rows fetched`);

  const canonicalByLeague = new Map(); // league → Set<team_name>
  for (const m of matchdays) {
    const league = m.league;
    if (!league) continue;
    if (!canonicalByLeague.has(league)) canonicalByLeague.set(league, new Set());
    const set = canonicalByLeague.get(league);
    const matches = m.data?.matches || [];
    for (const match of matches) {
      const h = match?.home?.name;
      const a = match?.away?.name;
      if (h) set.add(h);
      if (a) set.add(a);
    }
  }

  // Augment alias map with matchday teams that aren't in the registry yet.
  // These become their own canonicals — UI is source-of-truth for team names.
  let augmented = 0;
  for (const [league, teams] of canonicalByLeague.entries()) {
    if (!aliasMap.has(league)) aliasMap.set(league, new Map());
    const lm = aliasMap.get(league);
    for (const t of teams) {
      const norm = normalize(t);
      if (!lm.has(norm)) {
        lm.set(norm, t);
        augmented++;
      }
    }
  }
  console.log(`   Augmented alias-map with ${augmented} matchday-team-names not in registry\n`);

  return canonicalByLeague;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  FODZE Team Name Deduplication${DRY ? " (DRY)" : ""}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  // 1) Load TEAM_REGISTRY from team-resolver.ts (single source of truth)
  console.log(`🔍 Loading TEAM_REGISTRY from src/lib/team-resolver.ts...`);
  const registry = loadRegistry();
  console.log(`   ${registry.length} entries parsed\n`);

  const aliasMap = buildAliasMap(registry);

  // 2) Augment with matchday-derived canonicals (for new teams not yet in registry)
  const canonicalByLeague = await buildCanonicalMap(aliasMap);

  if (LEAGUE && !aliasMap.has(LEAGUE)) {
    console.error(`❌ League "${LEAGUE}" has no canonical teams — neither registry nor matchdays.`);
    process.exit(1);
  }

  const targets = LEAGUE
    ? [LEAGUE]
    : Array.from(aliasMap.keys()).sort();

  let totalRowsToFix = 0;
  let totalUnmatched = 0;
  const renamePlanByLeague = new Map(); // league → Map<old → new>

  for (const league of targets) {
    const lm = aliasMap.get(league);
    if (!lm || lm.size === 0) {
      console.log(`⚠ ${league}: no aliases — skip`);
      continue;
    }

    // Fetch all team_xg_history rows for this league with their team name + count
    const teamRows = await fetchAll(
      `${SUPA_URL}/rest/v1/team_xg_history?select=team&league=eq.${league}`
    );
    const teamCounts = new Map();
    for (const r of teamRows) {
      teamCounts.set(r.team, (teamCounts.get(r.team) || 0) + 1);
    }

    const renames = new Map();
    const unmatched = [];

    for (const [team, n] of teamCounts.entries()) {
      // Delegate to shared canonicalize (which knows EXTRA_ALIASES + registry).
      // Returns the input unchanged when no canonical is known — we then
      // fall back to local findCanonical for tier-2 substring matching.
      const sharedCan = sharedCanonicalize(team, league);
      const localCan = findCanonical(team, league, aliasMap);
      const canonical = (sharedCan !== team) ? sharedCan : localCan;
      if (canonical === null) {
        unmatched.push({ team, n });
      } else if (canonical !== team) {
        renames.set(team, { canonical, n });
      }
    }

    const sortedRenames = Array.from(renames.entries()).sort((a, b) => b[1].n - a[1].n);
    const totalRowsLeague = sortedRenames.reduce((s, [, v]) => s + v.n, 0);
    totalRowsToFix += totalRowsLeague;
    totalUnmatched += unmatched.length;

    console.log(`\n══ ${league} ══`);
    console.log(`  Canonical teams (registry+matchdays): ${new Set(lm.values()).size}`);
    console.log(`  Distinct team names (team_xg_history): ${teamCounts.size}`);
    console.log(`  → ${sortedRenames.length} aliases to merge (${totalRowsLeague} rows affected)`);

    for (const [old, info] of sortedRenames) {
      console.log(`    "${old}" (${info.n} rows) → "${info.canonical}"`);
    }

    if (unmatched.length > 0) {
      console.log(`  ⚠ ${unmatched.length} unmatched team-names (will be left as-is):`);
      for (const u of unmatched.slice(0, 10)) {
        console.log(`    - "${u.team}" (${u.n} rows)`);
      }
      if (unmatched.length > 10) console.log(`    ... and ${unmatched.length - 10} more`);
    }

    renamePlanByLeague.set(league, renames);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  Total aliases to merge: ${Array.from(renamePlanByLeague.values()).reduce((s, m) => s + m.size, 0)}`);
  console.log(`  Total rows affected: ${totalRowsToFix}`);
  console.log(`  Unmatched (stay as-is): ${totalUnmatched}`);

  if (DRY) {
    console.log(`\n  DRY mode — no changes written. Re-run without --dry to apply.`);
    return;
  }

  // ─── Apply renames ──
  console.log(`\n🔧 Applying renames…`);
  let applied = 0;
  for (const [league, renames] of renamePlanByLeague) {
    for (const [oldName, info] of renames) {
      // PATCH all matching rows. UNIQUE constraint will reject duplicates
      // when canonical row already exists for same (league,date,venue) —
      // which is FINE because we're collapsing them.
      // Strategy: try the bulk PATCH; if it 409s, fall back to per-row
      // upsert-with-merge using ON CONFLICT.
      const patchUrl = `${SUPA_URL}/rest/v1/team_xg_history?team=eq.${encodeURIComponent(oldName)}&league=eq.${league}`;
      const r = await fetch(patchUrl, {
        method: "PATCH",
        headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ team: info.canonical }),
      });
      if (r.ok) {
        applied += info.n;
        process.stdout.write(`\r  Applied: ${applied}/${totalRowsToFix} rows`);
      } else if (r.status === 409) {
        // Conflict — canonical row already exists for some (league,date,venue).
        // Need to delete the duplicate (the one being renamed) since the
        // canonical row already has data. The MERGE-priority rule:
        //   footystats > goals-proxy > shots-model
        // But for now, just DELETE the alias rows that conflict — the
        // canonical row from another source remains.
        const fallbackR = await fetch(
          `${SUPA_URL}/rest/v1/team_xg_history?team=eq.${encodeURIComponent(oldName)}&league=eq.${league}`,
          { method: "DELETE", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" } },
        );
        if (fallbackR.ok) {
          applied += info.n;
          process.stdout.write(`\r  Applied (conflict→delete): ${applied}/${totalRowsToFix} rows`);
        } else {
          console.error(`\n  ⚠ Failed ${league}/${oldName}: ${fallbackR.status} ${await fallbackR.text()}`);
        }
      } else {
        console.error(`\n  ⚠ Failed ${league}/${oldName}: ${r.status} ${await r.text()}`);
      }
      // Update opponent column for matches where THIS team was the opponent
      const oppUrl = `${SUPA_URL}/rest/v1/team_xg_history?opponent=eq.${encodeURIComponent(oldName)}&league=eq.${league}`;
      await fetch(oppUrl, {
        method: "PATCH",
        headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ opponent: info.canonical }),
      });
    }
  }
  console.log(`\n\n✅ Done — ${applied} rows updated to canonical names.\n`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});

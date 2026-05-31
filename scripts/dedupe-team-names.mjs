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

// True only when this file is executed directly (node scripts/dedupe-...mjs),
// false when imported (e.g. by tests for the pure helpers). Guards the
// env-check + main() so importing the module never triggers process.exit.
const RUN_DIRECTLY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (RUN_DIRECTLY && (!SUPA_URL || !SUPA_KEY)) {
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
 * Tier-1: exact-normalized match against the matchday-derived alias map.
 * Tier-2: substring containment fallback (length-guarded ≥ 5 chars).
 * Only invoked after sharedCanonicalize has had its say — never against
 * TEAM_REGISTRY (sharedCanonicalize already covers that).
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

// ─── Source-priority merge (conflict resolution) ───────────────────
//
// When renaming alias→canonical hits the UNIQUE (team,league,match_date,venue)
// constraint, BOTH rows describe the same real match from different ingest
// sources. We must keep the row with the richest data, not blindly delete the
// alias. Priority (higher = richer): sofascore (real per-shot xG) > understat
// (real xG) > api-sports (real xG) > footystats (xG via CSV) > shots-model
// (modelled xG) > goals-proxy (goals only, no xG). Unknown sources sort lowest.
export const SOURCE_PRIORITY = [
  "sofascore", "understat", "api-sports", "footystats",
  "shots-model-pooled", "shots-model", "goals-proxy",
];

/** Priority rank of a source string (higher = better). shots-model-<liga>
 *  variants map to the generic shots-model rank. Unknown → -1 (lowest). */
export function sourcePriority(source) {
  if (!source) return -1;
  const s = String(source);
  let best = -1;
  for (let i = 0; i < SOURCE_PRIORITY.length; i++) {
    const tag = SOURCE_PRIORITY[i];
    // prefix-match so "shots-model-bundesliga2" matches "shots-model"
    if (s === tag || s.startsWith(tag)) {
      const rank = SOURCE_PRIORITY.length - i;
      if (rank > best) best = rank;
    }
  }
  return best;
}

/**
 * Decide, per (match_date, venue) conflict, whether the ALIAS row or the
 * existing CANONICAL row wins. Pure + testable.
 *
 * @returns "alias" | "canonical" — which row to KEEP. The loser is deleted.
 *   Ties go to "canonical" (it already holds the slot; no churn, and the alias
 *   adds nothing the canonical lacks).
 */
export function pickWinner(aliasSource, canonicalSource) {
  return sourcePriority(aliasSource) > sourcePriority(canonicalSource)
    ? "alias" : "canonical";
}

/**
 * Resolve a rename conflict by per-(date,venue) source priority instead of the
 * old blind bulk-DELETE. For each conflicting slot: keep the higher-priority
 * source. Non-conflicting alias rows are renamed to canonical. Returns the
 * count of slots where the alias won (i.e. canonical row replaced), or null on
 * error. No-op in DRY mode (callers gate on DRY before invoking).
 */
async function mergeConflictingRows(league, aliasName, canonicalName) {
  const enc = encodeURIComponent;
  const aliasRows = await fetchAll(
    `${SUPA_URL}/rest/v1/team_xg_history?select=match_date,venue,source&team=eq.${enc(aliasName)}&league=eq.${enc(league)}&order=match_date`,
  );
  const canonRows = await fetchAll(
    `${SUPA_URL}/rest/v1/team_xg_history?select=match_date,venue,source&team=eq.${enc(canonicalName)}&league=eq.${enc(league)}&order=match_date`,
  );
  const canonBySlot = new Map();
  for (const c of canonRows) canonBySlot.set(`${c.match_date}|${c.venue}`, c);

  let aliasWins = 0;
  for (const a of aliasRows) {
    const slot = `${a.match_date}|${a.venue}`;
    const canon = canonBySlot.get(slot);
    if (!canon) {
      // No conflict for this slot — rename the alias row into canonical.
      const ok = await patchTeam(league, aliasName, canonicalName, a.match_date, a.venue);
      if (!ok) return null;
      continue;
    }
    if (pickWinner(a.source, canon.source) === "alias") {
      // Alias is richer: delete the canonical slot, then rename the alias in.
      const delOk = await deleteRow(league, canonicalName, a.match_date, a.venue);
      const renOk = delOk && await patchTeam(league, aliasName, canonicalName, a.match_date, a.venue);
      if (!renOk) return null;
      aliasWins++;
    } else {
      // Canonical is equal-or-richer: drop the redundant alias slot.
      const ok = await deleteRow(league, aliasName, a.match_date, a.venue);
      if (!ok) return null;
    }
  }
  return aliasWins;
}

async function patchTeam(league, fromTeam, toTeam, matchDate, venue) {
  const enc = encodeURIComponent;
  const r = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?team=eq.${enc(fromTeam)}&league=eq.${enc(league)}&match_date=eq.${enc(matchDate)}&venue=eq.${enc(venue)}`,
    { method: "PATCH", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" }, body: JSON.stringify({ team: toTeam }) },
  );
  if (!r.ok) console.error(`\n  ⚠ PATCH ${league}/${fromTeam}@${matchDate}/${venue}: ${r.status}`);
  return r.ok;
}

async function deleteRow(league, team, matchDate, venue) {
  const enc = encodeURIComponent;
  const r = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?team=eq.${enc(team)}&league=eq.${enc(league)}&match_date=eq.${enc(matchDate)}&venue=eq.${enc(venue)}`,
    { method: "DELETE", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" } },
  );
  if (!r.ok) console.error(`\n  ⚠ DELETE ${league}/${team}@${matchDate}/${venue}: ${r.status}`);
  return r.ok;
}

// Build canonical team list per league from matchdays JSONB. Each raw
// matchday name is pulled through sharedCanonicalize so the resulting
// alias-map agrees with EXTRA_ALIASES — without this, a matchday carrying
// "Arminia Bielefeld" would shadow the EXTRA_ALIASES canonical
// "DSC Arminia Bielefeld" in bundesliga2 and the inverse-direction
// disagreement triggered the dedupe false-positives.
async function buildCanonicalMap(aliasMap) {
  console.log(`📚 Loading canonical team names from matchdays JSONB...`);
  const matchdays = await fetchAll(`${SUPA_URL}/rest/v1/matchdays?select=league,data`);
  console.log(`   ${matchdays.length} matchday rows fetched`);

  const canonicalByLeague = new Map(); // league → Set<canonical_team_name>
  let aliasEntries = 0;
  for (const m of matchdays) {
    const league = m.league;
    if (!league) continue;
    if (!canonicalByLeague.has(league)) canonicalByLeague.set(league, new Set());
    if (!aliasMap.has(league)) aliasMap.set(league, new Map());
    const set = canonicalByLeague.get(league);
    const lm = aliasMap.get(league);
    const matches = m.data?.matches || [];
    for (const match of matches) {
      for (const raw of [match?.home?.name, match?.away?.name]) {
        if (!raw) continue;
        const canonical = sharedCanonicalize(raw, league);
        if (!set.has(canonical)) {
          set.add(canonical);
          lm.set(normalize(canonical), canonical);
          aliasEntries++;
        }
        // Also map the raw matchday name to its canonical (lets findCanonical
        // resolve common matchday spellings via tier-1 instead of tier-2).
        const normRaw = normalize(raw);
        if (!lm.has(normRaw)) {
          lm.set(normRaw, canonical);
          aliasEntries++;
        }
      }
    }
  }
  console.log(`   ${aliasEntries} matchday-derived alias entries\n`);

  return canonicalByLeague;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  FODZE Team Name Deduplication${DRY ? " (DRY)" : ""}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  // Canonical-direction is owned by sharedCanonicalize (TEAM_REGISTRY +
  // EXTRA_ALIASES). aliasMap here only collects matchday-derived names so
  // findCanonical can resolve teams sharedCanonicalize doesn't recognize.
  const aliasMap = new Map();
  const canonicalByLeague = await buildCanonicalMap(aliasMap);

  if (LEAGUE && !aliasMap.has(LEAGUE)) {
    console.error(`❌ League "${LEAGUE}" has no matchday rows — nothing to dedupe against.`);
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
      // sharedCanonicalize is the authoritative resolver: TEAM_REGISTRY +
      // EXTRA_ALIASES (manual lower-tier overrides) with tier-2 substring
      // fallback within the same league. It's queried first so EXTRA_ALIASES
      // can't be inverted by a registry-only fallback.
      const canonical = sharedCanonicalize(team, league);
      if (canonical !== team) {
        renames.set(team, { canonical, n });
        continue;
      }
      // No opinion from sharedCanonicalize. Fall back to matchdays-derived
      // names — already canonicalized through sharedCanonicalize at load
      // time, so this can only ever agree with EXTRA_ALIASES.
      const matchdayCanonical = findCanonical(team, league, aliasMap);
      if (matchdayCanonical === null) {
        unmatched.push({ team, n });
      } else if (matchdayCanonical !== team) {
        renames.set(team, { canonical: matchdayCanonical, n });
      }
    }

    const sortedRenames = Array.from(renames.entries()).sort((a, b) => b[1].n - a[1].n);
    const totalRowsLeague = sortedRenames.reduce((s, [, v]) => s + v.n, 0);
    totalRowsToFix += totalRowsLeague;
    totalUnmatched += unmatched.length;

    console.log(`\n══ ${league} ══`);
    console.log(`  Canonical teams (matchdays): ${canonicalByLeague.get(league)?.size ?? 0}`);
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
        // Conflict — a canonical row already exists for some (date,venue).
        // The OLD behaviour was a blind bulk-DELETE of ALL alias rows, which
        // destroyed the higher-quality source (e.g. sofascore xG) whenever the
        // canonical row came from a weaker source (goals-proxy/shots-model).
        // Now we resolve PER (date,venue) by source priority so the BEST data
        // survives the merge. See mergeConflictingRows.
        const merged = await mergeConflictingRows(league, oldName, info.canonical);
        if (merged != null) {
          applied += info.n;
          process.stdout.write(`\r  Applied (merge: ${merged} alias-wins): ${applied}/${totalRowsToFix} rows`);
        } else {
          console.error(`\n  ⚠ Merge failed ${league}/${oldName}`);
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

if (RUN_DIRECTLY) {
  main().catch((e) => {
    console.error(`Fatal: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * FODZE — team_xg_history Cross-Source Deduplication
 * ═════════════════════════════════════════════════════════════
 *
 * The 2026-05-22 data-quality audit found ~35.8 % inflation in the
 * training corpus: same physical match stored as multiple rows from
 * different sources (footystats vs understat vs sofascore) with
 * slightly different match_date values, bypassing the UNIQUE
 * constraint on (team, league, match_date, venue).
 *
 * Worst-offender example: la_liga 24/25 = 646 distinct (team, date,
 * venue) tuples vs Sofa truth of 380. 70 % inflation.
 *
 * Dedup policy:
 *   Group by (team, opponent, league, venue, season_bucket).
 *   season_bucket = floor((match_date - 2017-01-01) / 365.25 days).
 *
 *   ADDITIONAL constraint: within each group, only dedup rows whose
 *   match_dates are within ±14 days of each other. This protects:
 *     - Belgian Pro League regular-season + playoffs (same fixtures
 *       can play 2-3 times in a season at different times)
 *     - Scottish Premiership split (post-split fixtures)
 *     - Any wide-date-gap rows that are LIKELY different matches
 *       (e.g., 2023-03-05 vs 2023-06-11 = NOT dupe)
 *
 *   Within each group, keep ONE row using source-priority:
 *     sofascore > understat > footystats > goals-proxy > shots-model*
 *     > api-sports > NULL
 *
 *   Reason: sofa is the most rigorous methodology (per-shot xG from
 *   tracking-aware events); understat second; footystats third (good
 *   but methodology varies); goals-proxy is only goals; shots-model
 *   is regression-derived; api-sports has limited coverage.
 *
 * Usage:
 *   node scripts/dedup-team-xg-history.mjs --dry           # diagnose, no writes
 *   node scripts/dedup-team-xg-history.mjs --dry --verbose # show samples
 *   node scripts/dedup-team-xg-history.mjs                 # apply deletes
 *
 * Idempotent — safe to re-run. Counts in summary are honest about what
 * was deleted vs what was already clean.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── env ───────────────────────────────────────────────────────────
const envPath = resolve(PROJECT_ROOT, ".env.local");
if (existsSync(envPath)) {
  const env = readFileSync(envPath, "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

// ─── args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const VERBOSE = args.includes("--verbose");

// ─── source priority (lower number = higher priority = keep) ──────
const SOURCE_PRIORITY = {
  "sofascore": 1,
  "understat": 2,
  "footystats": 3,
  "api-sports": 4,
  "goals-proxy": 5,
  "shots-model": 6,
  "shots-model-pooled": 7,
};
// Default for anything not in map (NULL, unknown sources)
const DEFAULT_PRIORITY = 99;

function priorityFor(source) {
  if (source == null) return DEFAULT_PRIORITY;
  // Handle shots-model-<liga> variants (shots-model-bundesliga etc.)
  if (source.startsWith("shots-model-") && source !== "shots-model-pooled") {
    return 6;
  }
  return SOURCE_PRIORITY[source] ?? DEFAULT_PRIORITY;
}

// ─── season bucketing: 365.25-day windows starting 2017-07-01 ─────
// Season boundary: July 1 → June 30. Matches in 2022-08-15 → season 22/23.
const EPOCH = new Date("2017-07-01").getTime();
const SEASON_MS = 365.25 * 86400 * 1000;
function seasonBucket(matchDate) {
  const t = new Date(matchDate).getTime();
  return Math.floor((t - EPOCH) / SEASON_MS);
}

// ─── fetch all team_xg_history rows from Supabase ─────────────────
async function fetchAll() {
  const out = [];
  const PAGE = 1000;
  let from = 0;
  console.log("📥 Fetching team_xg_history from Supabase...");
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/team_xg_history?select=id,team,league,opponent,venue,match_date,source&order=id&limit=${PAGE}&offset=${from}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) {
      console.error(`  ⚠ fetch failed at offset ${from}:`, res.status, await res.text());
      break;
    }
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from % 10000 === 0) console.log(`  ${from} rows fetched...`);
  }
  console.log(`  ✓ ${out.length.toLocaleString()} rows`);
  return out;
}

// ─── dedup logic ────────────────────────────────────────────────────
const PROXIMITY_DAYS = 14;
const PROXIMITY_MS = PROXIMITY_DAYS * 86400 * 1000;

function dateMs(d) { return new Date(d).getTime(); }

function dedup(rows) {
  // Group by (team, opponent, league, venue, season_bucket)
  const groups = new Map();
  for (const row of rows) {
    if (!row.team || !row.opponent || !row.league || !row.venue || !row.match_date) {
      continue;  // skip malformed
    }
    const sb = seasonBucket(row.match_date);
    const key = `${row.team}|${row.opponent}|${row.league}|${row.venue}|${sb}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let totalGroups = 0;
  let groupsWithDupes = 0;
  let groupsSkippedDistant = 0;  // group had multiple rows but dates >14d apart
  let rowsToDelete = [];
  let rowsToKeep = [];

  // Source-distribution of kept + deleted
  const keptBySrc = {};
  const delBySrc = {};

  // Sample dupes for diagnostic
  const sampleDupes = [];

  for (const [key, grp] of groups) {
    totalGroups++;

    // Sort by date, then by source priority
    grp.sort((a, b) => {
      const ta = dateMs(a.match_date);
      const tb = dateMs(b.match_date);
      if (ta !== tb) return ta - tb;
      return priorityFor(a.source) - priorityFor(b.source);
    });

    // Cluster rows that are within PROXIMITY_DAYS of each other.
    // Sliding window: extend cluster while next row is within ±14d of cluster's
    // FIRST row (anchor-based clustering, not chained — chained would let two
    // matches 28 days apart cluster via a middle row).
    const clusters = [];
    let cur = [grp[0]];
    for (let i = 1; i < grp.length; i++) {
      const anchor = cur[0];
      if (dateMs(grp[i].match_date) - dateMs(anchor.match_date) <= PROXIMITY_MS) {
        cur.push(grp[i]);
      } else {
        clusters.push(cur);
        cur = [grp[i]];
      }
    }
    clusters.push(cur);

    if (clusters.length === grp.length) {
      // All rows are >14d apart from each other — these are LEGITIMATELY
      // different matches (Belgian playoffs, Scottish split, postponement
      // gone long). Keep all.
      for (const r of grp) {
        rowsToKeep.push(r);
        keptBySrc[r.source ?? "null"] = (keptBySrc[r.source ?? "null"] || 0) + 1;
      }
      if (grp.length > 1) groupsSkippedDistant++;
      continue;
    }

    // Some clusters have >1 row → those are dupes
    const hadDupes = clusters.some((c) => c.length > 1);
    if (hadDupes) groupsWithDupes++;

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        rowsToKeep.push(cluster[0]);
        keptBySrc[cluster[0].source ?? "null"] = (keptBySrc[cluster[0].source ?? "null"] || 0) + 1;
        continue;
      }
      // Pick best by source priority, then newest date
      cluster.sort((a, b) => {
        const pa = priorityFor(a.source);
        const pb = priorityFor(b.source);
        if (pa !== pb) return pa - pb;
        return b.match_date.localeCompare(a.match_date);
      });
      rowsToKeep.push(cluster[0]);
      keptBySrc[cluster[0].source ?? "null"] = (keptBySrc[cluster[0].source ?? "null"] || 0) + 1;
      for (const r of cluster.slice(1)) {
        rowsToDelete.push(r.id);
        delBySrc[r.source ?? "null"] = (delBySrc[r.source ?? "null"] || 0) + 1;
      }
      if (sampleDupes.length < 10 && VERBOSE) {
        sampleDupes.push({
          key,
          grp: cluster.map((r) => `${r.match_date} [${r.source ?? "null"}] id=${r.id}`),
        });
      }
    }
  }

  return {
    totalGroups, groupsWithDupes, groupsSkippedDistant,
    rowsToDelete, rowsToKeep, keptBySrc, delBySrc, sampleDupes,
  };
}

// ─── apply deletes ────────────────────────────────────────────────
async function applyDeletes(idsToDelete) {
  console.log(`\n🗑  Deleting ${idsToDelete.length.toLocaleString()} dupe rows...`);
  const BATCH = 200;
  let done = 0;
  let errors = 0;
  for (let i = 0; i < idsToDelete.length; i += BATCH) {
    const batch = idsToDelete.slice(i, i + BATCH);
    const idsClause = batch.join(",");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/team_xg_history?id=in.(${idsClause})`,
      {
        method: "DELETE",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      },
    );
    if (res.ok) {
      done += batch.length;
      if (done % 1000 === 0) process.stdout.write(`  ${done}/${idsToDelete.length}...\r`);
    } else {
      errors += batch.length;
      console.error(`\n  ⚠ batch ${i}-${i + BATCH} failed:`, res.status);
    }
  }
  console.log(`\n  ✓ ${done.toLocaleString()} deletes succeeded, ${errors} errors`);
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const rows = await fetchAll();
  const result = dedup(rows);

  console.log(`\n📊 Dedup Diagnostic (proximity threshold: ±${PROXIMITY_DAYS} days)`);
  console.log(`   Total rows:                       ${rows.length.toLocaleString()}`);
  console.log(`   Unique groupings:                 ${result.totalGroups.toLocaleString()}`);
  console.log(`   Groups with proximate dupes:      ${result.groupsWithDupes.toLocaleString()}`);
  console.log(`   Groups with distant rows (>14d):  ${result.groupsSkippedDistant.toLocaleString()}  [kept ALL]`);
  console.log(`   Rows to keep:                     ${result.rowsToKeep.length.toLocaleString()}`);
  console.log(`   Rows to delete:                   ${result.rowsToDelete.length.toLocaleString()}`);
  console.log(`   Inflation rate (deletes/total):   ${(100 * result.rowsToDelete.length / rows.length).toFixed(1)}%`);

  console.log(`\n   Kept rows by source:`);
  Object.entries(result.keptBySrc).sort((a, b) => b[1] - a[1]).forEach(([s, n]) =>
    console.log(`     ${s.padEnd(22)} ${n.toLocaleString().padStart(6)}`),
  );

  console.log(`\n   Deleted rows by source:`);
  Object.entries(result.delBySrc).sort((a, b) => b[1] - a[1]).forEach(([s, n]) =>
    console.log(`     ${s.padEnd(22)} ${n.toLocaleString().padStart(6)}`),
  );

  if (VERBOSE && result.sampleDupes.length > 0) {
    console.log(`\n   Sample duplicate groups:`);
    for (const s of result.sampleDupes) {
      console.log(`     ${s.key}`);
      for (const r of s.grp) console.log(`       ${r}`);
    }
  }

  if (DRY) {
    console.log(`\n🟡 DRY RUN — no writes. Drop --dry to apply deletes.`);
    return;
  }

  await applyDeletes(result.rowsToDelete);
  console.log(`\n✅ Done.`);
  console.log(`   Run mirror sync to update local SQLite:`);
  console.log(`     tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py --reset`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

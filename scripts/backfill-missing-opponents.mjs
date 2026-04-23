#!/usr/bin/env node
/**
 * FODZE — Backfill missing opponents in team_xg_history
 *
 * Old backfill-xg.mjs browser-script runs left `opponent` as an empty
 * string for every Understat row. Without opponent, the SoS adjustment
 * (src/lib/sos.ts) can't weight xG by defensive quality and per-match
 * breakdowns in the UI fall back to the match date.
 *
 * This script pairs each row with missing opponent to its counterparty
 * in the same (league, match_date) bucket but opposite venue:
 *
 *   (team=Arsenal, venue=home, date=2024-08-17, opp="")
 *   → match the row (venue=away, date=2024-08-17) whose team is
 *     anything other than Arsenal, and set opp = that team.
 *
 * Only writes when pairing is UNAMBIGUOUS (exactly one counterparty).
 * Ambiguous groups (rare — requires two matches for the same team on
 * the same date) are logged and left alone.
 *
 * Usage:
 *   node scripts/backfill-missing-opponents.mjs              # all leagues
 *   node scripts/backfill-missing-opponents.mjs --league bundesliga
 *   node scripts/backfill-missing-opponents.mjs --dry        # preview only
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
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
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(SUPA_URL, SUPA_KEY);

// ─── CLI ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueFilter =
  args.includes("--league") ? args[args.indexOf("--league") + 1] : null;

// ─── Fetch rows with missing opponent ──────────────────────────
async function fetchMissingOpponents(league) {
  // Page through — Supabase default cap is 1000
  const PAGE = 1000;
  let offset = 0;
  const all = [];
  while (true) {
    let q = supabase
      .from("team_xg_history")
      .select("id, team, opponent, league, venue, match_date")
      .or("opponent.is.null,opponent.eq.")
      .order("league", { ascending: true })
      .order("match_date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (league) q = q.eq("league", league);
    const { data, error } = await q;
    if (error) throw new Error(`fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// ─── Fetch counterparty candidates for a (league, date) bucket ─
async function fetchBucket(league, date) {
  const { data, error } = await supabase
    .from("team_xg_history")
    .select("id, team, venue, match_date")
    .eq("league", league)
    .eq("match_date", date);
  if (error) throw new Error(`bucket fetch failed: ${error.message}`);
  return data || [];
}

// ─── Find unambiguous opponent for a row ───────────────────────
function findOpponent(row, bucket) {
  const otherVenue = row.venue === "home" ? "away" : "home";
  const candidates = bucket.filter(
    r => r.team !== row.team && r.venue === otherVenue,
  );
  if (candidates.length === 1) return { ok: true, opponent: candidates[0].team };
  if (candidates.length === 0) return { ok: false, reason: "no-counterparty" };
  return { ok: false, reason: `ambiguous (${candidates.length})` };
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — Backfill missing opponents in team_xg_history   ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  if (DRY) console.log("  (DRY-RUN — no writes)\n");
  if (leagueFilter) console.log(`  League filter: ${leagueFilter}\n`);

  console.log("Fetching rows with missing opponent ...");
  const missing = await fetchMissingOpponents(leagueFilter);
  console.log(`  found ${missing.length} rows\n`);
  if (missing.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Group by (league, match_date) to minimize bucket queries
  const byBucket = new Map();
  for (const row of missing) {
    const key = `${row.league}|${row.match_date}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(row);
  }
  console.log(`Processing ${byBucket.size} (league, date) buckets ...\n`);

  const toUpdate = [];
  const reasonStats = { paired: 0, "no-counterparty": 0, ambiguous: 0 };
  let bucketIdx = 0;
  for (const [key, rows] of byBucket) {
    bucketIdx++;
    const [lg, date] = key.split("|");
    // Fetch the bucket once, reuse for all rows in it
    const bucket = await fetchBucket(lg, date);
    for (const row of rows) {
      const res = findOpponent(row, bucket);
      if (res.ok) {
        toUpdate.push({ id: row.id, opponent: res.opponent });
        reasonStats.paired++;
      } else {
        const k = res.reason.startsWith("ambiguous") ? "ambiguous" : res.reason;
        reasonStats[k] = (reasonStats[k] || 0) + 1;
      }
    }
    if (bucketIdx % 100 === 0) {
      console.log(`  ${bucketIdx}/${byBucket.size} buckets processed ...`);
    }
  }

  console.log(`\nPairing results:`);
  console.log(`  paired (write):    ${reasonStats.paired}`);
  console.log(`  no-counterparty:   ${reasonStats["no-counterparty"]}`);
  console.log(`  ambiguous:         ${reasonStats.ambiguous}`);

  if (DRY) {
    console.log(`\n(DRY-RUN) Would update ${toUpdate.length} rows. Re-run without --dry to apply.`);
    // Print a sample
    if (toUpdate.length > 0) {
      console.log(`\nSample (first 5):`);
      for (const u of toUpdate.slice(0, 5)) console.log(`  id=${u.id} → opponent="${u.opponent}"`);
    }
    return;
  }

  console.log(`\nWriting ${toUpdate.length} opponent updates (batches of 500) ...`);
  let written = 0;
  for (let i = 0; i < toUpdate.length; i += 500) {
    const batch = toUpdate.slice(i, i + 500);
    // We can't bulk-update with upsert on an id-only key without the full
    // row, so loop per-row. Slower but simple and correct.
    for (const u of batch) {
      const { error } = await supabase
        .from("team_xg_history")
        .update({ opponent: u.opponent })
        .eq("id", u.id);
      if (error) {
        console.warn(`  ! update failed for id=${u.id}: ${error.message}`);
      } else {
        written++;
      }
    }
    console.log(`  ${Math.min(i + 500, toUpdate.length)}/${toUpdate.length} written`);
  }
  console.log(`\nDone — ${written} rows updated.`);
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.message}`);
  process.exit(1);
});

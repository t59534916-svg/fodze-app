#!/usr/bin/env node
/**
 * FODZE Liga 3 Goals-as-xG Backfill
 *
 * The 3. Liga is not covered by football-data.co.uk CSVs, and Understat
 * doesn't carry it either. Without any data, calcMatch falls back to the
 * league-average heuristic in MatchdayContext — okay as a first pass, but
 * team-agnostic.
 *
 * This script fetches completed 3. Liga matches from The-Odds-API scores
 * endpoint and persists `goals_for` / `goals_against` as a proxy for
 * `xg` / `xga` in team_xg_history (source="goals-proxy").
 *
 * CAVEATS:
 *   - Goals are a noisier proxy than xG (random spikes pollute the signal).
 *   - Small samples for high-variance outcomes (a 5:0 scorline ≠ team is
 *     that much better than opponent — it's just what happened).
 *   - Once we have ~15 matches per team the signal starts stabilizing.
 *   - Marked source="goals-proxy" so callers can distinguish from real xG.
 *
 * Usage:
 *   node scripts/backfill-liga3-goals.mjs              # last 3 days
 *   node scripts/backfill-liga3-goals.mjs --days 30    # last 30 days
 *   node scripts/backfill-liga3-goals.mjs --dry        # preview
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

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

import { fetchOddsApi } from "./_lib/odds-api.mjs";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!process.env.ODDS_API_KEY) { console.error("❌ Missing ODDS_API_KEY"); process.exit(1); }
if (!SUPA_URL || !SUPA_KEY) { console.error("❌ Missing SUPABASE env"); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const daysArg = args.find((_, i) => args[i - 1] === "--days");
const DAYS_FROM = parseInt(daysArg) || 3;

const LEAGUE = "liga3";
const SPORT_KEY = "soccer_germany_liga3";

// ─── Fetch completed matches ─────────────────────────────────────

async function fetchCompleted() {
  const { resp } = await fetchOddsApi(`/sports/${SPORT_KEY}/scores`, {
    params: { daysFrom: String(DAYS_FROM) },
  });
  const data = await resp.json();
  return data.filter((e) => e.completed);
}

function extractScores(match) {
  if (!match.scores || !Array.isArray(match.scores)) return null;
  const homeRow = match.scores.find((s) => s.name === match.home_team);
  const awayRow = match.scores.find((s) => s.name === match.away_team);
  const h = parseInt(homeRow?.score);
  const a = parseInt(awayRow?.score);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return { home: h, away: a };
}

// ─── Supabase upsert ─────────────────────────────────────────────

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function upsertRows(rows) {
  if (DRY) return;
  // Conflict target must match the actual UNIQUE constraint
  // (team, league, match_date, venue) — see migration-phase1-2.sql.
  // Prior version used `opponent` in the conflict key, which silently 400'd
  // every run — why this script never wrote a single row for Liga 3.
  const resp = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
    {
      method: "POST",
      headers: {
        ...SUPA_HEADERS,
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Upsert failed (${resp.status}): ${msg}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`⚽ Liga 3 Goals→xG Backfill${DRY ? " (DRY)" : ""} · lookback ${DAYS_FROM}d\n`);
  const completed = await fetchCompleted();
  console.log(`📋 ${completed.length} completed matches from The-Odds-API\n`);

  if (completed.length === 0) {
    console.log("No completed matches in the lookback window. Exiting.");
    return;
  }

  const rows = [];
  let skipped = 0;
  for (const match of completed) {
    const scores = extractScores(match);
    if (!scores) { skipped++; continue; }
    const date = (match.commence_time || "").slice(0, 10);
    if (!date) { skipped++; continue; }

    // canonicalize-on-write: defends against The-Odds-API team-name variations
    // ("FC Saarbrucken" vs "1. FC Saarbrücken") which would otherwise create
    // alias-rows alongside FootyStats canonical names.
    const homeName = canonicalize(match.home_team, LEAGUE);
    const awayName = canonicalize(match.away_team, LEAGUE);

    // Home-perspective row
    rows.push({
      team: homeName,
      opponent: awayName,
      league: LEAGUE,
      venue: "home",
      match_date: date,
      xg: scores.home,           // goals-as-xG-proxy
      xga: scores.away,
      goals_for: scores.home,
      goals_against: scores.away,
      source: "goals-proxy",
    });
    // Away-perspective row
    rows.push({
      team: awayName,
      opponent: homeName,
      league: LEAGUE,
      venue: "away",
      match_date: date,
      xg: scores.away,
      xga: scores.home,
      goals_for: scores.away,
      goals_against: scores.home,
      source: "goals-proxy",
    });

    console.log(`  ${match.home_team} ${scores.home}:${scores.away} ${match.away_team}`);
  }

  console.log(`\n📦 Built ${rows.length} rows (${completed.length - skipped} matches, ${skipped} skipped)`);

  if (rows.length === 0) {
    console.log("Nothing to upsert.");
    return;
  }

  if (DRY) {
    console.log("🔍 DRY — sample row:", rows[0]);
    return;
  }

  // Batch upsert
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertRows(batch);
    inserted += batch.length;
    process.stdout.write(`\r  Upserted ${inserted}/${rows.length}...`);
  }
  console.log(`\n✅ Done — ${inserted} rows upserted (source=goals-proxy).`);
  console.log(`\nℹ️  Note: This is a proxy — goals ≠ xG. For high-quality Liga 3`);
  console.log(`   predictions, integrate FootyStats or scrape kicker.de shots.`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * FODZE — Populate match_outcomes from team_xg_history
 * ════════════════════════════════════════════════════════════════════
 *
 * The /backtest page joins match_predictions × match_outcomes to compute
 * per-engine Brier on REAL settled matches. Both tables exist (migration
 * applied 2026-04-26) but match_outcomes was never auto-populated, so
 * Brier shows 0 even when predictions exist.
 *
 * This script joins the two team_xg_history rows per match (home + away
 * perspectives) into a single match_outcomes row with goals_h/goals_a/
 * xg_h/xg_a/shots/corners/cards. Uses fodze-style match_key
 * (`league:hometeamnorm-awayteamnorm`) for compatibility with predictions.
 *
 * Idempotent — UNIQUE (match_key) ensures re-runs UPSERT.
 *
 * Usage:
 *   node scripts/populate-match-outcomes.mjs                # last 30 days, all leagues
 *   node scripts/populate-match-outcomes.mjs --days 7       # narrower window
 *   node scripts/populate-match-outcomes.mjs --league epl   # single league
 *   node scripts/populate-match-outcomes.mjs --dry          # preview, no write
 *
 * Designed for nightly cron (settle-bets.yml). Coexists with
 * monitor-live-brier.mjs which uses the same upstream join but writes to
 * a different table (live_brier_snapshots, time-series aggregates).
 * ════════════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

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
  console.error("❌ Missing SUPABASE env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const DAYS = parseInt(args.find((_, i) => args[i - 1] === "--days") || "30", 10);
const LEAGUE = args.find((_, i) => args[i - 1] === "--league");

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// fodze match_key: same format as bets.match_key + match_predictions.match_key
function matchKey(league, home, away) {
  const norm = (s) => (s || "").toLowerCase().replace(/\s/g, "");
  return `${league}:${norm(home)}-${norm(away)}`;
}

// FootyStats uses -1 as a sentinel for "no data" in shots/corners/cards
// columns. The match_outcomes table accepts int, so a literal -1 would
// pollute the data and break joined-Brier reporting (negative shots make
// no sense). Treat -1 as null at write time.
function nullIfSentinel(v) {
  if (v == null) return null;
  if (Number(v) < 0) return null;
  return v;
}

// PostgREST pagination — Supabase silently caps at 1000 per request
async function fetchAll(url, headers) {
  const out = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const r = await fetch(`${url}&limit=${PAGE}&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${await r.text()}`);
    const page = await r.json();
    if (page.length === 0) break;
    out.push(...page);
    offset += PAGE;
    if (page.length < PAGE) break;
  }
  return out;
}

async function main() {
  const since = new Date();
  since.setDate(since.getDate() - DAYS);
  const sinceStr = since.toISOString().slice(0, 10);
  console.log(`📊 Populate match_outcomes${DRY ? " (DRY)" : ""}`);
  console.log(`   Window: ${sinceStr} → today (${DAYS} days)`);
  if (LEAGUE) console.log(`   League: ${LEAGUE}`);

  // Fetch all home-perspective rows in window. Each match has both home +
  // away rows in team_xg_history (UNIQUE on team/league/date/venue) — we
  // pivot via the home row's `opponent` field, then look up the away row
  // for the matching pair to get the away perspective stats.
  let homeUrl =
    `${SUPA_URL}/rest/v1/team_xg_history?select=team,opponent,league,match_date,xg,xga,goals_for,goals_against,shots_for,shots_against,shots_on_target_for,shots_on_target_against,corners_for,corners_against,yellow_cards_for,yellow_cards_against,red_cards_for,red_cards_against,source` +
    `&venue=eq.home&match_date=gte.${sinceStr}&goals_for=not.is.null`;
  if (LEAGUE) homeUrl += `&league=eq.${LEAGUE}`;

  const homeRows = await fetchAll(homeUrl, SUPA_HEADERS);
  console.log(`   ${homeRows.length} settled home rows fetched\n`);

  if (homeRows.length === 0) {
    console.log("Nothing to populate. Exit.");
    return;
  }

  // Build outcomes — one row per match. Where a column is NULL on the
  // home row but populated on (theoretically) the away row, we'd need a
  // second JOIN — but practice: if home row has shots_for, the away row
  // has shots_against (mirror perspective), so the home row alone has
  // BOTH sides via the *_for / *_against columns. Schema design wins!
  const outcomes = [];
  for (const h of homeRows) {
    if (!h.team || !h.opponent || !h.league || !h.match_date) continue;
    if (!Number.isFinite(h.goals_for) || !Number.isFinite(h.goals_against)) continue;

    outcomes.push({
      match_key: matchKey(h.league, h.team, h.opponent),
      league: h.league,
      home_team: h.team,
      away_team: h.opponent,
      match_date: h.match_date,
      goals_h: h.goals_for,
      goals_a: h.goals_against,
      xg_h: h.xg ?? null,
      xg_a: h.xga ?? null,
      // npxg not yet populated for footystats — leave null. Understat
      // would have it but our Understat data is stale (May 2025).
      npxg_h: null,
      npxg_a: null,
      shots_h: nullIfSentinel(h.shots_for),
      shots_a: nullIfSentinel(h.shots_against),
      shots_on_target_h: nullIfSentinel(h.shots_on_target_for),
      shots_on_target_a: nullIfSentinel(h.shots_on_target_against),
      corners_h: nullIfSentinel(h.corners_for),
      corners_a: nullIfSentinel(h.corners_against),
      yellow_cards_h: nullIfSentinel(h.yellow_cards_for),
      yellow_cards_a: nullIfSentinel(h.yellow_cards_against),
      red_cards_h: nullIfSentinel(h.red_cards_for),
      red_cards_a: nullIfSentinel(h.red_cards_against),
      source: h.source || "team_xg_history",
    });
  }

  console.log(`   ${outcomes.length} outcome rows built (after filter for valid scores)`);

  // Diagnostics: what's the data coverage?
  const withXg = outcomes.filter(o => o.xg_h != null).length;
  const withShots = outcomes.filter(o => o.shots_h != null).length;
  const withCorners = outcomes.filter(o => o.corners_h != null).length;
  console.log(`   Coverage: xG ${withXg}/${outcomes.length} | shots ${withShots}/${outcomes.length} | corners ${withCorners}/${outcomes.length}\n`);

  if (DRY) {
    console.log("🔍 DRY — sample row:");
    console.log(" ", outcomes[0]);
    return;
  }

  // Batched UPSERT (PostgREST cap ~100 per request to be safe)
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < outcomes.length; i += BATCH) {
    const chunk = outcomes.slice(i, i + BATCH);
    // ON CONFLICT must match the new UNIQUE (match_key, match_date) constraint
    // (migration applied 2026-04-27 — old UNIQUE on match_key alone collapsed
    // double-round-robin fixtures in austria_bl + similar small leagues).
    const r = await fetch(
      `${SUPA_URL}/rest/v1/match_outcomes?on_conflict=match_key,match_date`,
      {
        method: "POST",
        headers: { ...SUPA_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      }
    );
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Upsert failed: ${r.status} ${txt.slice(0, 300)}`);
    }
    done += chunk.length;
    process.stdout.write(`\r   Upserted ${done}/${outcomes.length}...`);
  }
  console.log(`\n✅ Done — ${done} match_outcomes rows upserted`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

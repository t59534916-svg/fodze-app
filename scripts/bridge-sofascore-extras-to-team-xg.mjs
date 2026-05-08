#!/usr/bin/env node
/**
 * FODZE — Sofascore extras → team_xg_history Bridge
 * ═══════════════════════════════════════════════════════════════════
 *
 * Sister-bridge to bridge-sofascore-to-team-xg.mjs. Where the original
 * bridge propagates xG/shots/goals from `sofascore_team_chance_quality`
 * (built from sofascore_shotmap), this one propagates the ~18 extra
 * stat columns that come from the /event/{id}/statistics endpoint
 * (stored in sofascore_match_statistics, exposed via the
 * sofascore_team_match_stats view).
 *
 * Why split from the original bridge:
 *   - Different upstream sources (shotmap vs match-statistics)
 *   - Different cadence (shots arrive minutes after KO, full match-stats
 *     can take hours; we don't want shot-bridge blocked)
 *   - Different failure modes (statistics endpoint can 404 for older
 *     leagues even when shotmap exists)
 *   - Independent retry: if extras-bridge fails, shot-bridge already
 *     wrote xG. The engine still has its primary signal.
 *
 * Columns written:
 *   ball_possession_pct, big_chances, big_chances_missed,
 *   passes_total, passes_accurate, pass_accuracy_pct,
 *   tackles_total, tackles_won,
 *   errors_lead_to_shot, errors_lead_to_goal,
 *   ground_duels_won/_total, aerial_duels_won/_total,
 *   dribbles_won, dribbles_attempted,
 *   fouls, yellow_cards, red_cards,
 *   goals_prevented
 *
 * Columns NOT written:
 *   xg, xga, goals_*, shots_* — those are the original bridge's domain.
 *   We leave them untouched to avoid race conditions.
 *
 * Match keying:
 *   Same as original bridge — UNIQUE(team, league, match_date, venue).
 *   Uses canonicalize() to normalize team names before upsert.
 *
 * Behavior re: existing rows:
 *   PostgREST `Prefer: resolution=merge-duplicates` — only the columns
 *   we provide get overwritten; xg/xga/goals/shots stay as the original
 *   bridge wrote them.
 *
 * Usage:
 *   node scripts/bridge-sofascore-extras-to-team-xg.mjs --dry
 *   node scripts/bridge-sofascore-extras-to-team-xg.mjs --since 2026-04-01
 *   node scripts/bridge-sofascore-extras-to-team-xg.mjs              # all-time, all leagues
 *
 * Idempotent — re-run cheap.
 *
 * ENV: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── env ───────────────────────────────────────────────────────────
const envPath = resolve(PROJECT_ROOT, ".env.local");
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ─── args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const sinceArg = args.find((_, i) => args[i - 1] === "--since");
const SINCE = sinceArg || null;
const VERBOSE = args.includes("--verbose") || args.includes("-v");

// ─── helpers ───────────────────────────────────────────────────────
const headers = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function fetchAll(table, qs) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
      headers: { ...headers, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok) {
      console.error(`  ⚠ fetch ${table}: ${r.status} ${await r.text().catch(() => "")}`);
      break;
    }
    const data = await r.json();
    if (!data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Per-row PATCH — UPDATE only, never INSERT.
// Why not POST + on_conflict: when the conflict-key doesn't match an existing
// row (subtle Unicode / collation differences between the existing row's
// `team` value and our canonicalize() output), PostgREST falls back to
// INSERT and crashes on NOT NULL columns (xg, xga, opponent). PATCH with
// equality filters is deterministic — matches existing or no-ops, never
// inserts. Cost: 1 HTTP call per row instead of 500 — but we filter
// upstream to <1000 truly-needed updates per run, so ~1000 calls × 30ms
// = 30s. Acceptable for the daily-cron usage and cleaner than the upsert
// fallback hack.
async function patchOne(row) {
  const { team, league, match_date, venue, ...payload } = row;
  // PostgREST: spaces and special chars in equality values must be encoded.
  const filter =
    `team=eq.${encodeURIComponent(team)}` +
    `&league=eq.${encodeURIComponent(league)}` +
    `&match_date=eq.${encodeURIComponent(match_date)}` +
    `&venue=eq.${encodeURIComponent(venue)}`;
  const url = `${SUPA_URL}/rest/v1/team_xg_history?${filter}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal,count=exact" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`  ⚠ patch ${team}/${league}/${match_date}/${venue}: ${r.status} ${msg.slice(0, 200)}`);
    return 0;
  }
  // Content-Range header tells us how many rows were actually updated
  const cr = r.headers.get("content-range") || "0-0/0";
  const updated = parseInt((cr.split("/")[1] || "0"), 10);
  return updated;
}

// ─── pure transformation (exported for unit tests) ─────────────────
//
// Takes sofascore_team_match_stats rows (1 per team-game), groups by
// game_id, and emits team_xg_history rows (2 per game — home + away)
// with ONLY the extras columns set (no xg/goals/shots — those are the
// original bridge's job).
//
// Returns: { rows, perLeague, skippedNoOpponent, skippedCanonicalize }
export function buildTeamXgExtrasRows(tmsRows, canonicalizeFn = canonicalize) {
  // Group by game_id (1 game = 2 rows = 1 home + 1 away)
  const byGame = new Map();
  for (const r of tmsRows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, {});
    byGame.get(r.game_id)[r.is_home ? "home" : "away"] = r;
  }

  const rows = [];
  let skippedNoOpponent = 0;
  let skippedCanonicalize = 0;
  const perLeague = {};

  for (const [, game] of byGame.entries()) {
    if (!game.home || !game.away) {
      skippedNoOpponent++;
      continue;
    }
    if (!game.home.start_timestamp) {
      // No timestamp → can't compute match_date. Drop.
      skippedNoOpponent++;
      continue;
    }
    const matchDate = new Date(game.home.start_timestamp * 1000)
      .toISOString()
      .slice(0, 10);
    const lg = game.home.league;

    // Canonicalize team names — must match what other ingestion scripts use.
    let homeTeam, awayTeam;
    try {
      homeTeam = canonicalizeFn(game.home.team, lg);
      awayTeam = canonicalizeFn(game.away.team, lg);
    } catch {
      skippedCanonicalize++;
      continue;
    }
    if (!homeTeam || !awayTeam) {
      skippedCanonicalize++;
      continue;
    }

    // Build the extras subset for one side. Only includes cols that
    // sofascore_team_match_stats exposes; xg/goals/shots are NOT here
    // — those columns are owned by the primary sofascore bridge.
    const extrasFor = (side) => ({
      ball_possession_pct:  side.ball_possession_pct  ?? null,
      big_chances:          side.big_chances          ?? null,
      big_chances_missed:   side.big_chances_missed   ?? null,
      passes_total:         side.passes_total         ?? null,
      passes_accurate:      side.passes_accurate      ?? null,
      pass_accuracy_pct:    side.pass_accuracy_pct    ?? null,
      tackles_total:        side.tackles_total        ?? null,
      tackles_won:          side.tackles_won          ?? null,
      errors_lead_to_shot:  side.errors_lead_to_shot  ?? null,
      errors_lead_to_goal:  side.errors_lead_to_goal  ?? null,
      ground_duels_won:     side.ground_duels_won     ?? null,
      ground_duels_total:   side.ground_duels_total   ?? null,
      aerial_duels_won:     side.aerial_duels_won     ?? null,
      aerial_duels_total:   side.aerial_duels_total   ?? null,
      dribbles_won:         side.dribbles_won         ?? null,
      dribbles_attempted:   side.dribbles_attempted   ?? null,
      fouls:                side.fouls                ?? null,
      yellow_cards:         side.yellow_cards         ?? null,
      red_cards:            side.red_cards            ?? null,
      goals_prevented:      side.goals_prevented      ?? null,
    });

    // PostgREST upsert needs the conflict-key columns (team, league,
    // match_date, venue) for matching, plus the partial column set.
    rows.push({
      team: homeTeam,
      league: lg,
      match_date: matchDate,
      venue: "home",
      ...extrasFor(game.home),
    });
    rows.push({
      team: awayTeam,
      league: lg,
      match_date: matchDate,
      venue: "away",
      ...extrasFor(game.away),
    });

    perLeague[lg] = (perLeague[lg] || 0) + 2;
  }

  return { rows, perLeague, skippedNoOpponent, skippedCanonicalize };
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_KEY");
    process.exit(1);
  }

  console.log(`🔗 Sofascore-extras → team_xg_history Bridge${DRY ? " (DRY RUN)" : ""}`);
  if (SINCE) console.log(`   Since filter: match_date >= ${SINCE}`);
  console.log("");

  // 1. Fetch view rows (premium + partial tier — same gate as primary bridge)
  let qs = `select=*&data_quality_tier=in.(premium,partial)`;
  if (SINCE) {
    const sinceTs = Math.floor(new Date(SINCE).getTime() / 1000);
    qs += `&start_timestamp=gte.${sinceTs}`;
  }
  console.log("📥 Fetching sofascore_team_match_stats rows...");
  const tms = await fetchAll("sofascore_team_match_stats", qs);
  console.log(`   ${tms.length} rows fetched`);

  // 2. Translate via pure function (extracted for unit tests)
  const { rows: xghRows, perLeague, skippedNoOpponent, skippedCanonicalize } =
    buildTeamXgExtrasRows(tms);
  console.log(`   ${new Set(tms.map(r => r.game_id)).size} unique games\n`);

  console.log(`📊 Translation summary:`);
  console.log(`   ${xghRows.length} team_xg_history extras rows ready (${xghRows.length / 2} match-pairs)`);
  if (skippedNoOpponent > 0) console.log(`   ⚠ ${skippedNoOpponent} games skipped (missing pair or timestamp)`);
  if (skippedCanonicalize > 0) console.log(`   ⚠ ${skippedCanonicalize} games skipped (team name canonicalize failed)`);
  console.log(`\n   Per-league breakdown:`);
  for (const [lg, n] of Object.entries(perLeague).sort()) {
    console.log(`     ${lg.padEnd(20)} ${n} rows (${n / 2} matches)`);
  }

  if (VERBOSE && xghRows.length > 0) {
    console.log(`\n   Sample (first 3 rows):`);
    for (const r of xghRows.slice(0, 3)) {
      console.log(`     ${r.match_date} ${r.team} (${r.venue}) | ` +
        `poss=${r.ball_possession_pct} bc=${r.big_chances} ` +
        `pass=${r.passes_accurate}/${r.passes_total} ` +
        `tackle=${r.tackles_won}/${r.tackles_total} ` +
        `cards=${r.yellow_cards}y/${r.red_cards}r`);
    }
  }

  if (DRY) {
    console.log(`\n🟡 DRY RUN — no writes performed. Drop --dry to patch.`);
    return;
  }

  // 3. Per-row PATCH (UPDATE only). No client-side filter needed — PATCH
  //    matches by composite filter, no-ops if no row exists. ~30s for 1000
  //    rows on commodity Supabase, well within daily-cron budget.
  console.log(`\n📤 Patching team_xg_history (PATCH per row, UPDATE-only)...`);
  let updated = 0;
  let noop = 0;
  let errored = 0;
  const t0 = Date.now();
  // Sequential to avoid swamping PostgREST connection pool. With ~30ms
  // per call this hits ~33 req/s which is comfortable.
  for (let i = 0; i < xghRows.length; i++) {
    const n = await patchOne(xghRows[i]);
    if (n > 0) updated += n;
    else if (n === 0) noop++;
    else errored++;
    if ((i + 1) % 100 === 0) {
      process.stdout.write(`\r   ${i + 1}/${xghRows.length} rows  (updated=${updated} noop=${noop})`);
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n✓ Bridge complete in ${sec}s · updated=${updated} noop=${noop} (key not found in team_xg_history)`,
  );
}

// Only run when invoked directly (not when imported by tests).
// Mirrors the dual-form check in bridge-sofascore-to-team-xg.mjs (b2ae02c)
// so CI invocations where node resolves the script via a relative path
// don't accidentally execute main() during a vitest import.
const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()));

if (isEntryPoint) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

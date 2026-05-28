#!/usr/bin/env node
/**
 * FODZE Closing-Odds Snapshot
 *
 * Captures the sharp closing line for pending bets whose match is
 * imminent (default: kickoff within 2 hours). Writes to bets.closing_odds
 * and computes CLV = log(odds_placed / closing_odds) × 100.
 *
 * Positive CLV over time is the single best indicator that your model
 * has actual edge — win-rate is dominated by variance; CLV isn't.
 *
 * Usage:
 *   node scripts/snapshot-closing-odds.mjs              # window = 2h
 *   node scripts/snapshot-closing-odds.mjs --window 4h  # wider window
 *   node scripts/snapshot-closing-odds.mjs --dry
 *
 * Cron: runs alongside fetch-odds.mjs in the existing fetch-odds.yml
 * workflow. No new cron needed.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { fetchWithRetry } from "./_lib/fetch-retry.mjs";

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
  console.error("❌ Missing SUPABASE env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const windowArg = args.find((_, i) => args[i - 1] === "--window") || "2h";
const windowHours = parseFloat(windowArg) || 2;

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// Fuzzy team match — mirrors src/lib/team-resolver.ts (duplicated here
// because scripts/ can't easily import TS; keep in sync)
function fuzzyTeamMatch(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  if (la.includes(lb) || lb.includes(la)) return true;
  const words = la.split(/\s+/).filter((w) => w.length > 3);
  return words.some((w) => lb.includes(w));
}

// Map canonical market keys to the corresponding sharp-odd column in live_odds
function sharpOddColumn(market) {
  const m = String(market || "").toLowerCase();
  if (m === "1" || m === "h" || m === "home" || m === "heim") return "sharp_h";
  if (m === "x" || m === "d" || m === "draw" || m === "unent." || m === "remis") return "sharp_d";
  if (m === "2" || m === "a" || m === "away" || m === "ausw." || m === "gast") return "sharp_a";
  if (m === "ü2.5" || m === "o25" || m === "o2.5") return "sharp_over25";
  if (m === "u2.5" || m === "u25") return "sharp_under25";
  return null;
}

async function getPendingBetsForWindow(windowHours) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowHours * 3_600_000);
  // We don't have kickoff on the bet row, so we join via live_odds
  // commence_time in the scoring step. Just get all pending bets here.
  //
  // Note: we deliberately do NOT filter out bets that already have
  // closing_odds. The cron runs every 4h and the kickoff window is 2h —
  // so for any given match at most one snapshot lands inside the window
  // most of the time, but when two do, the LATER one (closer to kickoff)
  // overwrites the earlier. Sharp-lines move most in the final 30min, so
  // last-write-wins is more faithful to the "closing" semantic than the
  // previous first-write-wins that locked in whatever we caught first.
  const resp = await fetchWithRetry(
    `${SUPA_URL}/rest/v1/bets?result=eq.pending&select=*`,
    { headers: SUPA_HEADERS },
    { label: "GET pending bets" },
  );
  if (!resp.ok) throw new Error(`Supabase GET bets: ${resp.status}`);
  return resp.json();
}

async function getLiveOdds() {
  const resp = await fetchWithRetry(
    `${SUPA_URL}/rest/v1/live_odds?select=*`,
    { headers: SUPA_HEADERS },
    { label: "GET live_odds" },
  );
  if (!resp.ok) throw new Error(`Supabase GET live_odds: ${resp.status}`);
  return resp.json();
}

async function updateBet(betId, closingOdds, clv) {
  if (DRY) return;
  const resp = await fetchWithRetry(
    `${SUPA_URL}/rest/v1/bets?id=eq.${betId}`,
    {
      method: "PATCH",
      headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ closing_odds: closingOdds, clv }),
    },
    { label: `PATCH bet ${betId}` },
  );
  if (!resp.ok) {
    console.error(`  ⚠️ PATCH ${betId}: ${resp.status} ${await resp.text()}`);
  }
}

// Persist all current within-window sharp closes to odds_closing_history
// so bets placed retroactively (after kickoff but before settlement) can
// still be CLV-backfilled by fetch-results.mjs::lookupClosingFromHistory.
//
// 2026-04-26 Background: football-data.co.uk stopped publishing PSCH after
// 2026-01-14. Since the 4h cron + 2h-window combo means we already capture
// the canonical sharp close for every match in normal operation, the only
// missing piece was persistence beyond bets. This dual-write adds that.
//
// match_key uses fodze format (league:homenorm-awaynorm) — different from
// the football-data.co.uk row format (league|home|away|date) but the table
// only requires UNIQUE(match_key) so they coexist; lookups iterate both.
async function persistClosingSnapshot(league, matchDate, homeTeam, awayTeam, sharpH, sharpD, sharpA, sharpO25, sharpU25) {
  if (DRY) return;
  const norm = (s) => (s || "").toLowerCase().replace(/\s/g, "");
  const fodzeKey = `${league}:${norm(homeTeam)}-${norm(awayTeam)}`;
  const payload = {
    match_key: fodzeKey,
    league,
    match_date: matchDate,
    home_team: homeTeam,
    away_team: awayTeam,
    psch: sharpH > 1 ? sharpH : null,
    pscd: sharpD > 1 ? sharpD : null,
    psca: sharpA > 1 ? sharpA : null,
    psc_over25: sharpO25 > 1 ? sharpO25 : null,
    psc_under25: sharpU25 > 1 ? sharpU25 : null,
    source: "live-odds-snapshot",
  };
  const resp = await fetchWithRetry(
    `${SUPA_URL}/rest/v1/odds_closing_history?on_conflict=match_key`,
    {
      method: "POST",
      headers: { ...SUPA_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([payload]),
    },
    { label: `closing-history POST ${fodzeKey}` },
  );
  if (!resp.ok) {
    console.error(`  ⚠️ closing-history persist ${fodzeKey}: ${resp.status} ${await resp.text()}`);
  }
}

async function main() {
  console.log(`⏱️  FODZE Closing-Odds Snapshot${DRY ? " (DRY)" : ""} · window ${windowHours}h\n`);

  const [bets, liveOdds] = await Promise.all([
    getPendingBetsForWindow(windowHours),
    getLiveOdds(),
  ]);

  console.log(`📋 ${bets.length} pending bets (last-write-wins on closing_odds)`);
  console.log(`📊 ${liveOdds.length} live odds events\n`);

  const now = new Date();
  const windowEndMs = now.getTime() + windowHours * 3_600_000;

  // ─── Forward-looking persistence (2026-04-26 fix) ─────────────────
  // Persist EVERY in-window match's sharp close to odds_closing_history,
  // independent of whether a user bet exists yet. Why: bets placed
  // retroactively (after kickoff but before settlement) currently can't
  // be CLV-attributed because live_odds discards completed matches as
  // soon as the next 4h-cron runs. By snapshotting now, fetch-results.mjs
  // can backfill at settlement time. Idempotent via match_key UNIQUE.
  let persistedHistory = 0;
  for (const m of liveOdds) {
    const ko = m.commence_time ? new Date(m.commence_time).getTime() : null;
    if (!ko || ko < now.getTime() || ko > windowEndMs) continue;
    if (!m.league || !m.home_team || !m.away_team) continue;
    const matchDate = m.commence_time.slice(0, 10); // YYYY-MM-DD
    await persistClosingSnapshot(
      m.league, matchDate, m.home_team, m.away_team,
      Number(m.sharp_h), Number(m.sharp_d), Number(m.sharp_a),
      Number(m.sharp_over25), Number(m.sharp_under25),
    );
    persistedHistory++;
  }
  if (persistedHistory > 0) {
    console.log(`🗄️  ${persistedHistory} matches persisted to odds_closing_history (forward-CLV-cache)\n`);
  }

  if (bets.length === 0) {
    console.log("No pending bets to snapshot. (closing-history was still updated.)");
    return;
  }

  let snapped = 0;
  let skippedFuture = 0;
  let skippedPast = 0;
  let skippedNoMatch = 0;
  let skippedNoOdd = 0;

  for (const bet of bets) {
    // Find the matching live_odds row via fuzzy team match (bets might
    // use different team name conventions than live_odds)
    const match = liveOdds.find(
      (o) =>
        fuzzyTeamMatch(o.home_team, bet.home_team) &&
        fuzzyTeamMatch(o.away_team, bet.away_team),
    );
    if (!match) { skippedNoMatch++; continue; }

    // Only snapshot if kickoff is in our window
    const kickoff = match.commence_time ? new Date(match.commence_time).getTime() : null;
    if (!kickoff) { skippedNoMatch++; continue; }
    if (kickoff < now.getTime()) { skippedPast++; continue; }
    if (kickoff > windowEndMs) { skippedFuture++; continue; }

    // Get the sharp odd for this bet's market
    const oddColumn = sharpOddColumn(bet.market);
    if (!oddColumn) { skippedNoOdd++; continue; }
    const closingOdds = match[oddColumn];
    if (!closingOdds || closingOdds <= 1) { skippedNoOdd++; continue; }

    // CLV in percent: log(placed / closing) × 100
    // Positive = you beat the closing line = genuine edge signal
    const placed = Number(bet.odds_placed);
    if (!Number.isFinite(placed) || placed <= 1) { skippedNoOdd++; continue; }
    const clv = Math.log(placed / Number(closingOdds)) * 100;

    const minsToKickoff = Math.round((kickoff - now.getTime()) / 60_000);
    console.log(
      `  ${bet.home_team} vs ${bet.away_team} · ${bet.market} @ ${placed} → close ${closingOdds} · CLV ${clv >= 0 ? "+" : ""}${clv.toFixed(2)}% · kickoff in ${minsToKickoff}min`,
    );

    await updateBet(bet.id, Number(closingOdds), +clv.toFixed(4));
    snapped++;
  }

  console.log(
    `\n✅ ${snapped} bets snapshotted${DRY ? " (dry)" : ""}`,
  );
  if (skippedFuture + skippedPast + skippedNoMatch + skippedNoOdd > 0) {
    console.log(
      `⏭️  Skipped: ${skippedFuture} future (outside window), ${skippedPast} past kickoff, ${skippedNoMatch} no match in live_odds, ${skippedNoOdd} no odds for market`,
    );
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

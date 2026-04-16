#!/usr/bin/env node
/**
 * FODZE Data Quality Audit
 *
 * Scans the Supabase production DB and reports coverage gaps:
 * - team_xg_history: rows per league, latest match, unique teams, sources
 * - matchdays: per-league count, freshness, xg_h8-populated fraction
 * - live_odds: total, freshness (last fetched_at), leagues present
 * - bets: settled/pending/with-clv coverage, closing_odds population
 * - odds_snapshots: total count (cleanup indicator)
 *
 * Exits 0 on green, 1 when critical issues found (suitable for cron-alert).
 *
 * Usage:
 *   node scripts/audit-data-quality.mjs              # Full report
 *   node scripts/audit-data-quality.mjs --json       # Machine-readable
 *   node scripts/audit-data-quality.mjs --league epl # Single league
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
  console.error("❌ Missing SUPABASE env");
  process.exit(1);
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// Full FODZE league list — mirror of src/lib/dixon-coles.ts LEAGUES.
// Kept here to avoid TS import in .mjs.
const LEAGUES = {
  bundesliga:    { name: "Bundesliga",           tier: 1 },
  bundesliga2:   { name: "2. Bundesliga",        tier: 2 },
  liga3:         { name: "3. Liga",              tier: 3 },
  epl:           { name: "Premier League",       tier: 1 },
  la_liga:       { name: "La Liga",              tier: 1 },
  serie_a:       { name: "Serie A",              tier: 1 },
  ligue_1:       { name: "Ligue 1",              tier: 1 },
  eredivisie:    { name: "Eredivisie",           tier: 1 },
  championship:  { name: "Championship",         tier: 2 },
  primeira_liga: { name: "Primeira Liga",        tier: 1 },
  jupiler_pro:   { name: "Jupiler Pro League",   tier: 1 },
  super_lig:     { name: "Süper Lig",            tier: 1 },
  la_liga2:      { name: "La Liga 2",            tier: 2 },
  serie_b:       { name: "Serie B",              tier: 2 },
  ligue_2:       { name: "Ligue 2",              tier: 2 },
  scottish_prem: { name: "Scottish Premiership", tier: 1 },
  greek_sl:      { name: "Super League Greece",  tier: 1 },
  league_one:    { name: "League One",           tier: 3 },
  league_two:    { name: "League Two",           tier: 4 },
};

const leagueKeys = leagueFilter ? [leagueFilter] : Object.keys(LEAGUES);

// ─── Supabase helpers ────────────────────────────────────────────

async function count(table, filter = "") {
  const url = `${SUPA_URL}/rest/v1/${table}?select=*${filter}&limit=1`;
  const resp = await fetch(url, {
    headers: { ...SUPA_HEADERS, Prefer: "count=exact" },
  });
  const cr = resp.headers.get("content-range") || "0-0/0";
  return parseInt(cr.split("/")[1] || "0", 10);
}

async function rows(table, filter = "", limit = 1000) {
  const url = `${SUPA_URL}/rest/v1/${table}?${filter}&limit=${limit}`;
  const resp = await fetch(url, { headers: SUPA_HEADERS });
  if (!resp.ok) throw new Error(`${table} ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ─── Per-league xG audit ──────────────────────────────────────────

async function auditLeagueXG(league) {
  const filter = `select=team,venue,source,match_date,xg&league=eq.${league}&order=match_date.desc`;
  const all = await rows("team_xg_history", filter, 10000);
  const teams = new Set(all.map((r) => r.team));
  const sources = {};
  for (const r of all) sources[r.source || "unknown"] = (sources[r.source || "unknown"] || 0) + 1;
  const latest = all[0]?.match_date;
  const daysOld = latest
    ? Math.floor((Date.now() - new Date(latest).getTime()) / 86400000)
    : null;
  // Home/away balance
  let homeN = 0, awayN = 0;
  for (const r of all) {
    if (r.venue === "home") homeN++;
    else if (r.venue === "away") awayN++;
  }
  return {
    league,
    leagueName: LEAGUES[league]?.name || league,
    rows: all.length,
    uniqueTeams: teams.size,
    homeRows: homeN,
    awayRows: awayN,
    sources,
    latestMatch: latest || null,
    daysOld,
  };
}

async function auditMatchdays(league) {
  const mds = await rows(
    "matchdays",
    `select=id,matchday_label,match_date,created_at,data&league=eq.${league}&order=created_at.desc`,
    20,
  );
  if (mds.length === 0) return { league, count: 0, latest: null, withXG: 0 };
  const latest = mds[0];
  let matchesWithXG = 0;
  let totalMatches = 0;
  for (const m of latest.data?.matches || []) {
    totalMatches++;
    if (m.home?.xg_h8 && m.away?.xg_a8) matchesWithXG++;
  }
  const daysOld = Math.floor(
    (Date.now() - new Date(latest.created_at).getTime()) / 86400000,
  );
  return {
    league,
    count: mds.length,
    latestLabel: latest.matchday_label,
    latestDate: latest.created_at,
    daysOld,
    totalMatches,
    matchesWithXG,
    xgFraction: totalMatches > 0 ? matchesWithXG / totalMatches : 0,
  };
}

async function auditLiveOdds(league) {
  const odds = await rows(
    "live_odds",
    `select=event_id,fetched_at,commence_time,sharp_h,best_h&league=eq.${league}&order=commence_time.asc`,
    100,
  );
  if (odds.length === 0) return { league, count: 0, withSharp: 0, withBest: 0, latestFetch: null };
  const withSharp = odds.filter((o) => o.sharp_h && o.sharp_h > 1).length;
  const withBest = odds.filter((o) => o.best_h && o.best_h > 1).length;
  const latestFetch = odds
    .map((o) => o.fetched_at)
    .filter(Boolean)
    .sort()
    .pop();
  const hoursOld = latestFetch
    ? Math.floor((Date.now() - new Date(latestFetch).getTime()) / 3600000)
    : null;
  return { league, count: odds.length, withSharp, withBest, latestFetch, hoursOld };
}

// ─── Global audits ────────────────────────────────────────────────

async function auditBets() {
  const all = await rows(
    "bets",
    "select=result,odds_placed,closing_odds,clv,model_prob,placed_at&order=placed_at.desc",
    5000,
  );
  const total = all.length;
  const settled = all.filter((b) => b.result === "won" || b.result === "lost").length;
  const pending = all.filter((b) => b.result === "pending").length;
  const withClosing = all.filter((b) => b.closing_odds && b.closing_odds > 1).length;
  const withClv = all.filter((b) => typeof b.clv === "number" && Number.isFinite(b.clv)).length;
  const withModelProb = all.filter((b) => typeof b.model_prob === "number" && b.model_prob > 0 && b.model_prob < 1).length;
  const settledList = all.filter((b) => b.result === "won" || b.result === "lost");
  const settledWithClv = settledList.filter((b) => typeof b.clv === "number" && Number.isFinite(b.clv)).length;
  return {
    total,
    settled,
    pending,
    withClosing,
    withClv,
    withModelProb,
    settledCoverage: {
      clvCoverage: settled > 0 ? settledWithClv / settled : 0,
    },
  };
}

async function auditOddsSnapshots() {
  const total = await count("odds_snapshots");
  const recent = await rows(
    "odds_snapshots",
    "select=snapshot_time&order=snapshot_time.desc",
    1,
  );
  return { total, latestSnapshot: recent[0]?.snapshot_time || null };
}

// ─── Rendering ────────────────────────────────────────────────────

function badge(ok, warn = false) {
  if (ok) return "✓";
  if (warn) return "⚠";
  return "✗";
}

function renderReport(data) {
  const { xg, matchdays, liveOdds, bets, snapshots } = data;

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  FODZE DATA-QUALITY AUDIT");
  console.log(`  ${new Date().toLocaleString("de-DE")}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // ─── xG coverage by league ──────────────────────────────────────
  console.log("📊 team_xg_history — xG coverage per league\n");
  console.log("  League                     Rows  Teams  Home  Away  Latest      Days old");
  console.log("  ─────────────────────────  ────  ─────  ────  ────  ──────────  ────────");
  for (const x of xg) {
    const lbl = x.leagueName.padEnd(24);
    const rows = String(x.rows).padStart(5);
    const teams = String(x.uniqueTeams).padStart(5);
    const h = String(x.homeRows).padStart(4);
    const a = String(x.awayRows).padStart(4);
    const latest = (x.latestMatch || "—").slice(0, 10).padEnd(10);
    const daysOld = x.daysOld == null ? "—" : `${x.daysOld}d`;
    const b = x.rows === 0 ? "✗" : x.daysOld != null && x.daysOld > 30 ? "⚠" : "✓";
    console.log(`  ${b} ${lbl} ${rows} ${teams} ${h} ${a}  ${latest}  ${daysOld}`);
  }

  // Source breakdown
  console.log("\n📊 xG source breakdown");
  const sourceAgg = {};
  for (const x of xg) {
    for (const [src, n] of Object.entries(x.sources)) {
      sourceAgg[src] = (sourceAgg[src] || 0) + n;
    }
  }
  const total = Object.values(sourceAgg).reduce((s, n) => s + n, 0);
  for (const [src, n] of Object.entries(sourceAgg).sort((a, b) => b[1] - a[1])) {
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${src.padEnd(20)} ${String(n).padStart(6)}  ${pct}%`);
  }

  // ─── Matchdays freshness ────────────────────────────────────────
  console.log("\n📅 matchdays — enrichment + freshness per league\n");
  console.log("  League                     Count  Latest                     Days  xG cov.");
  console.log("  ─────────────────────────  ─────  ─────────────────────────  ────  ───────");
  for (const m of matchdays) {
    const lbl = (LEAGUES[m.league]?.name || m.league).padEnd(24);
    const count = String(m.count).padStart(5);
    const latestLbl = m.count === 0 ? "— nie geseedet —" : (m.latestLabel || m.latestDate?.slice(0, 10) || "?");
    const latest = latestLbl.slice(0, 25).padEnd(25);
    const daysOld = m.daysOld == null ? "—" : `${m.daysOld}d`;
    const xgPct = m.totalMatches > 0 ? (m.xgFraction * 100).toFixed(0) + "%" : "—";
    const b = m.count === 0 ? "✗" : m.daysOld > 10 ? "⚠" : "✓";
    console.log(`  ${b} ${lbl} ${count}  ${latest}  ${daysOld.padStart(4)}  ${xgPct.padStart(7)}`);
  }

  // ─── live_odds ──────────────────────────────────────────────────
  console.log("\n💰 live_odds — cron freshness per league\n");
  console.log("  League                     Count  w/Sharp  w/Best  Last fetch       Hours");
  console.log("  ─────────────────────────  ─────  ───────  ──────  ───────────────  ─────");
  for (const l of liveOdds) {
    const lbl = (LEAGUES[l.league]?.name || l.league).padEnd(24);
    const c = String(l.count).padStart(5);
    const s = String(l.withSharp).padStart(7);
    const best = String(l.withBest).padStart(6);
    const latest = (l.latestFetch || "—").slice(0, 16).padEnd(16);
    const h = l.hoursOld == null ? "—" : `${l.hoursOld}h`;
    const b = l.count === 0 ? "✗" : l.hoursOld != null && l.hoursOld > 8 ? "⚠" : "✓";
    console.log(`  ${b} ${lbl} ${c}  ${s}  ${best}  ${latest}  ${h.padStart(5)}`);
  }

  // ─── bets ────────────────────────────────────────────────────────
  console.log("\n🎯 bets — tracking completeness\n");
  console.log(`  Total:          ${bets.total}`);
  console.log(`  Settled:        ${bets.settled}`);
  console.log(`  Pending:        ${bets.pending}`);
  console.log(`  With closing:   ${bets.withClosing}  (${bets.total > 0 ? ((bets.withClosing / bets.total) * 100).toFixed(0) : 0}%)`);
  console.log(`  With CLV:       ${bets.withClv}  (${bets.total > 0 ? ((bets.withClv / bets.total) * 100).toFixed(0) : 0}%)`);
  console.log(`  With model_prob:${bets.withModelProb}  (${bets.total > 0 ? ((bets.withModelProb / bets.total) * 100).toFixed(0) : 0}%)`);
  if (bets.settled > 0) {
    const clvCov = (bets.settledCoverage.clvCoverage * 100).toFixed(0);
    const bchk = bets.settledCoverage.clvCoverage > 0.5 ? "✓" : bets.settledCoverage.clvCoverage > 0.2 ? "⚠" : "✗";
    console.log(`  ${bchk} Settled-Bet CLV coverage: ${clvCov}%  (CLV-Tracking Indikator)`);
  }

  // ─── snapshots ───────────────────────────────────────────────────
  console.log("\n📸 odds_snapshots — table size");
  console.log(`  Total rows: ${snapshots.total}`);
  console.log(`  Latest:     ${snapshots.latestSnapshot || "—"}`);
  if (snapshots.total > 50000) {
    console.log(`  ⚠ Consider cleanup: >50k rows (> 1y history not actionable)`);
  }

  // ─── Critical summary ────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  CRITICAL ISSUES");
  console.log("═══════════════════════════════════════════════════════════════════\n");
  const issues = [];

  // P0: xG empty for any league that has recent live_odds
  for (const l of liveOdds) {
    if (l.count > 0) {
      const xgRow = xg.find((x) => x.league === l.league);
      if (!xgRow || xgRow.rows === 0) {
        issues.push(`P0  ${LEAGUES[l.league]?.name || l.league}: live_odds aktiv (${l.count}) aber 0 xG-Historie → Engine-Edge unmöglich, nur Markt-Edge`);
      } else if (xgRow.daysOld != null && xgRow.daysOld > 90) {
        issues.push(`P1  ${LEAGUES[l.league]?.name || l.league}: xG ${xgRow.daysOld} Tage alt — Saison läuft, aber keine Updates`);
      }
    }
  }
  // P1: matchdays stale
  for (const m of matchdays) {
    const liveRow = liveOdds.find((l) => l.league === m.league);
    if (liveRow && liveRow.count > 0 && m.daysOld != null && m.daysOld > 14) {
      issues.push(`P1  ${LEAGUES[m.league]?.name || m.league}: Matchday ${m.daysOld}d alt — Injuries/Kontext veraltet`);
    }
  }
  // P1: live_odds cron not running
  for (const l of liveOdds) {
    if (l.count > 0 && l.hoursOld != null && l.hoursOld > 12) {
      issues.push(`P1  ${LEAGUES[l.league]?.name || l.league}: live_odds ${l.hoursOld}h alt — fetch-odds Cron läuft nicht?`);
    }
  }
  // P2: CLV coverage low
  if (bets.settled > 20 && bets.settledCoverage.clvCoverage < 0.3) {
    issues.push(`P2  CLV-Coverage nur ${(bets.settledCoverage.clvCoverage * 100).toFixed(0)}% der settled bets — snapshot-closing-odds Cron wirkungslos?`);
  }

  if (issues.length === 0) {
    console.log("  ✓ Keine kritischen Lücken gefunden.\n");
  } else {
    for (const i of issues) console.log(`  ${i}`);
    console.log("");
  }

  return issues;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.error(`[audit] Scanning ${leagueKeys.length} leagues...`);

  const [xg, matchdays, liveOdds, bets, snapshots] = await Promise.all([
    Promise.all(leagueKeys.map(auditLeagueXG)),
    Promise.all(leagueKeys.map(auditMatchdays)),
    Promise.all(leagueKeys.map(auditLiveOdds)),
    auditBets(),
    auditOddsSnapshots(),
  ]);

  const data = { xg, matchdays, liveOdds, bets, snapshots };

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const issues = renderReport(data);
  if (issues.filter((i) => i.startsWith("P0")).length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

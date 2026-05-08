#!/usr/bin/env node
/**
 * FODZE — Line Movement Backtest ("follow the money" edge analysis)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Question this answers: do sharp odds movements correctly anticipate
 * outcomes? If yes, "follow the move" is a profitable edge — bet on
 * whichever side the line shifted toward. If no, the moves are noise.
 *
 * Methodology:
 *   1. For each settled match in last N days:
 *      - Opening = earliest snapshot in odds_snapshots
 *      - Closing = latest snapshot in odds_snapshots before kickoff
 *      - Outcome from match_outcomes.outcome_1x2
 *   2. Compute per-side prob shifts (vig-removed Pinnacle): ΔH, ΔD, ΔA
 *   3. Bin matches by movement direction (H rose, D rose, A rose, no move)
 *   4. Compute hit rate per bin: % of matches where the moved-to side won
 *   5. Compare to baseline (the closing prob itself, which we know works)
 *
 * Output metrics:
 *   - "Follow-the-move" edge: hit rate when betting the side that gained
 *     >X pp, minus the closing implied prob for that side
 *   - Brier score (opening) vs Brier (closing) — lower = better calibrated
 *   - Per-league breakdown for liquidity tiers (sharp BL/EPL vs soft Liga 3)
 *
 * Data requirements:
 *   - odds_snapshots populated by fetch-odds.mjs cron (live since 2026-05-08)
 *   - match_outcomes populated by populate-match-outcomes.mjs (daily cron)
 *   - Need ≥2 snapshots per match in different time-buckets for "movement"
 *
 * Heads-up: until odds_snapshots accumulates ~2-3 weeks of cron data,
 * this script returns "0 backtestable matches" — that's expected. The
 * tool exists now so when data is ready, the analysis is one command away.
 *
 * Usage:
 *   node scripts/backtest-line-movements.mjs                # last 90 days
 *   node scripts/backtest-line-movements.mjs --days 30
 *   node scripts/backtest-line-movements.mjs --threshold 5  # only ≥5pp moves
 *   node scripts/backtest-line-movements.mjs --json         # machine-readable
 *
 * ENV: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function val(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const DAYS = parseInt(val("days") ?? "90", 10);
const THRESHOLD_PP = parseFloat(val("threshold") ?? "0");  // 0 = include all matches
const JSON_OUT = flag("json");

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

// ─── helpers ───────────────────────────────────────────────────────

function vigRemoveSharp(odds) {
  const sharp = odds?._sharp;
  const h = sharp?.h, d = sharp?.d, a = sharp?.a;
  if (!h || !d || !a) return null;
  const sum = 1 / h + 1 / d + 1 / a;
  return { h: 1 / h / sum, d: 1 / d / sum, a: 1 / a / sum };
}

async function fetchAll(table, qs) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
      headers: { ...headers, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok) throw new Error(`${table} fetch ${r.status}: ${await r.text().catch(() => "")}`);
    const data = await r.json();
    if (!data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ─── core (exported for unit tests) ────────────────────────────────

/**
 * For each match with ≥2 snapshots + an outcome, compute movement +
 * which side the move favored + whether that side won.
 *
 * @param snapshots — array of {match_key, league, odds, snapshot_time}
 * @param outcomes — array of {match_key, outcome_1x2, match_date}
 * @returns array of {match_key, league, dH, dD, dA, max_drift,
 *                    moved_to: 'H'|'D'|'A'|null, outcome, hit: bool|null,
 *                    open_pH/D/A, close_pH/D/A}
 */
export function buildBacktest(snapshots, outcomes) {
  const outcomeByKey = new Map(outcomes.map(o => [o.match_key, o]));
  const byMatch = new Map();
  for (const s of snapshots) {
    if (!s.match_key) continue;
    const arr = byMatch.get(s.match_key) || [];
    arr.push(s);
    byMatch.set(s.match_key, arr);
  }
  const rows = [];
  for (const [key, snaps] of byMatch.entries()) {
    if (snaps.length < 2) continue;
    const outcome = outcomeByKey.get(key);
    if (!outcome?.outcome_1x2) continue;
    snaps.sort((a, b) => +new Date(a.snapshot_time) - +new Date(b.snapshot_time));
    const earliest = snaps[0];
    const latest = snaps[snaps.length - 1];
    const open = vigRemoveSharp(earliest.odds);
    const close = vigRemoveSharp(latest.odds);
    if (!open || !close) continue;
    const dH = (close.h - open.h) * 100;
    const dD = (close.d - open.d) * 100;
    const dA = (close.a - open.a) * 100;
    const maxAbs = Math.max(Math.abs(dH), Math.abs(dD), Math.abs(dA));
    let moved_to = null;
    if (dH > 0 && dH >= Math.abs(dD) && dH >= Math.abs(dA)) moved_to = "H";
    else if (dA > 0 && dA >= Math.abs(dD) && dA >= Math.abs(dH)) moved_to = "A";
    else if (dD > 0 && dD >= Math.abs(dH) && dD >= Math.abs(dA)) moved_to = "D";
    const hit = moved_to ? (outcome.outcome_1x2 === moved_to) : null;

    rows.push({
      match_key: key,
      league: latest.league,
      match_date: outcome.match_date,
      open_pH: open.h, open_pD: open.d, open_pA: open.a,
      close_pH: close.h, close_pD: close.d, close_pA: close.a,
      dH, dD, dA, max_drift: maxAbs,
      moved_to, outcome: outcome.outcome_1x2, hit,
    });
  }
  return rows;
}

/**
 * Aggregate backtest rows: hit rate per movement direction + Brier scores.
 */
export function aggregateBacktest(rows, thresholdPP = 0) {
  const filtered = rows.filter(r => r.max_drift >= thresholdPP);
  const totalMoved = filtered.filter(r => r.moved_to !== null).length;
  const hits = filtered.filter(r => r.hit === true).length;
  const overall_hit_rate = totalMoved > 0 ? hits / totalMoved : null;

  // Brier scores: opening vs closing
  const indicators = (r, side) => (r.outcome === side ? 1 : 0);
  let openSumSq = 0, closeSumSq = 0, n = 0;
  for (const r of filtered) {
    if (!r.outcome) continue;
    openSumSq += Math.pow(r.open_pH - indicators(r, "H"), 2)
              + Math.pow(r.open_pD - indicators(r, "D"), 2)
              + Math.pow(r.open_pA - indicators(r, "A"), 2);
    closeSumSq += Math.pow(r.close_pH - indicators(r, "H"), 2)
               + Math.pow(r.close_pD - indicators(r, "D"), 2)
               + Math.pow(r.close_pA - indicators(r, "A"), 2);
    n++;
  }
  const brier_open = n > 0 ? openSumSq / n : null;
  const brier_close = n > 0 ? closeSumSq / n : null;

  // Per-direction breakdown
  const byDir = { H: { n: 0, hits: 0 }, D: { n: 0, hits: 0 }, A: { n: 0, hits: 0 } };
  for (const r of filtered) {
    if (!r.moved_to) continue;
    byDir[r.moved_to].n++;
    if (r.hit) byDir[r.moved_to].hits++;
  }

  return {
    n_total: filtered.length,
    n_with_movement: totalMoved,
    overall_hit_rate,
    brier_open, brier_close,
    brier_delta: (brier_open != null && brier_close != null) ? (brier_close - brier_open) : null,
    by_direction: byDir,
  };
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  if (!JSON_OUT) {
    console.log(`📊 Line-movement backtest · last ${DAYS}d · threshold ≥${THRESHOLD_PP}pp`);
  }

  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const sinceDate = since.slice(0, 10);

  // Fetch in parallel
  const [snaps, outs] = await Promise.all([
    fetchAll("odds_snapshots", `select=match_key,league,odds,snapshot_time&snapshot_time=gte.${since}`),
    fetchAll("match_outcomes", `select=match_key,outcome_1x2,match_date&match_date=gte.${sinceDate}`),
  ]);

  if (!JSON_OUT) {
    console.log(`   ${snaps.length} snapshots, ${outs.length} outcomes`);
  }

  const rows = buildBacktest(snaps, outs);
  const agg = aggregateBacktest(rows, THRESHOLD_PP);

  if (JSON_OUT) {
    console.log(JSON.stringify({ rows, agg, days: DAYS, threshold_pp: THRESHOLD_PP }, null, 2));
    return;
  }

  console.log(`   ${rows.length} matches with ≥2 snapshots + outcome (backtestable)`);
  console.log("");

  if (rows.length === 0) {
    console.log("   ⏭ no backtestable matches yet.");
    console.log("   Reason: odds_snapshots needs ≥2 snapshots per match across cron ticks.");
    console.log("   Cron baseline started 2026-05-08 ~10:07 UTC. Re-run in a few weeks");
    console.log("   when accumulated data lets us measure follow-the-move edge.");
    return;
  }

  console.log(`📈 Aggregated metrics (≥${THRESHOLD_PP}pp threshold):`);
  console.log(`   matches:                 ${agg.n_total}`);
  console.log(`   matches with movement:   ${agg.n_with_movement}`);
  if (agg.overall_hit_rate !== null) {
    console.log(`   follow-the-move hit:     ${(agg.overall_hit_rate * 100).toFixed(1)}%`);
  }
  if (agg.brier_open !== null) {
    console.log(`   brier opening:           ${agg.brier_open.toFixed(4)}`);
    console.log(`   brier closing:           ${agg.brier_close.toFixed(4)}`);
    console.log(`   delta (close-open):      ${agg.brier_delta.toFixed(4)} ${agg.brier_delta < 0 ? "(closing wins ✓)" : "(opening wins!)"}`);
  }
  console.log("");
  console.log("📋 By move direction:");
  for (const dir of ["H", "D", "A"]) {
    const b = agg.by_direction[dir];
    if (b.n === 0) continue;
    const pct = (b.hits / b.n * 100).toFixed(1);
    console.log(`   ${dir}: ${b.hits}/${b.n} hits (${pct}%)`);
  }

  // Top 10 movers (by max_drift) for forensic interest
  console.log("\n🔍 Top 10 mover-matches:");
  const top = [...rows].sort((a, b) => b.max_drift - a.max_drift).slice(0, 10);
  for (const r of top) {
    console.log(
      `   ${r.match_date}  ${r.league.padEnd(15)} ${r.match_key.slice(0, 50).padEnd(50)}  ` +
      `Δmax=${r.max_drift.toFixed(1)}pp moved_to=${r.moved_to ?? "—"} ` +
      `outcome=${r.outcome} ${r.hit === true ? "✓" : r.hit === false ? "✗" : "·"}`
    );
  }
}

const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()));

if (isEntryPoint) {
  main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
}

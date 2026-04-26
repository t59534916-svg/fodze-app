#!/usr/bin/env node
/**
 * FODZE Live Brier Monitor
 * ════════════════════════════════════════════════════════════════════
 *
 * Joins pipeline_shadow_log (predictions per engine) with team_xg_history
 * (actual results) to compute LIVE per-engine, per-league Brier on
 * recently-settled matches.
 *
 * Why this exists: backtest-summary.json shows STATIC OOT-Brier from a
 * frozen 2023-08 → 2024-06 corpus (n=6691). It tells us nothing about
 * whether the Phase 2.x calibration layers activated 2026-04-26 are
 * actually helping in production. This monitor closes that loop:
 *
 *   - Per-engine: which one performs best on real new matches?
 *   - Per-league: where is the model healthy vs drifting?
 *   - v3-promotion: is preview-mode v3 actually closer to v2 than the
 *     historical 0.6318 vs 0.6083 gap suggests?
 *
 * Usage:
 *   node scripts/monitor-live-brier.mjs                # last 7 days
 *   node scripts/monitor-live-brier.mjs --days 30      # last 30 days
 *   node scripts/monitor-live-brier.mjs --json         # JSON output
 *   node scripts/monitor-live-brier.mjs --persist      # Also UPSERT to
 *                                                      # live_brier_snapshots table
 *                                                      # (creates if missing)
 *
 * Idempotent — re-runs are safe. Use --persist for a nightly cron and
 * the table will accumulate (window_end_date, engine, league) snapshots.
 * ════════════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader (match existing scripts) ─────────────────────────────
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Missing SUPABASE env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY)");
  process.exit(1);
}

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// ─── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const DAYS = parseInt(argValue("--days") || "7", 10);
const JSON_OUT = args.includes("--json");
const PERSIST = args.includes("--persist");

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a team name for fuzzy matching: lowercase, strip umlauts,
 * strip whitespace and common prefixes ("FC ", "1. ", "VfL ", etc).
 *
 * Examples:
 *   "Bayer 04 Leverkusen" → "bayer04leverkusen"
 *   "Bayern München"      → "bayernmunchen"
 *   "Bayern Munich"       → "bayernmunich"
 *   "Borussia M'gladbach" → "borussiamgladbach"
 *
 * The fuzzy comparator afterwards uses substring containment so the
 * München/Munich pair still won't match — handled by the team-resolver
 * registry (TEAM_REGISTRY) for those cases. For the 80% of matches
 * where both sources just differ in punctuation/spaces, this normalize
 * is enough.
 */
function normalize(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip diacritics (ü → u)
    .replace(/[^a-z0-9]/g, "");        // strip space/punct
}

/**
 * Fuzzy team match — same pattern as snapshot-closing-odds.mjs and
 * src/lib/team-resolver.ts::fuzzyTeamMatch (kept duplicated because
 * scripts/ can't import .ts directly).
 *
 * Tier order:
 *   1. Normalized exact match
 *   2. Normalized substring (either direction, length-guarded ≥ 4)
 *   3. Word-overlap (any word ≥ 4 chars present in other side)
 */
function fuzzyTeamMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  // Word-overlap fallback (e.g. "Manchester City" vs "Man City")
  const wordsA = String(a).toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  return wordsA.some((w) => nb.includes(normalize(w)));
}

/**
 * Brier score for a single 1X2 prediction.
 *   Brier = (p_h - 1{actual=H})² + (p_d - 1{actual=D})² + (p_a - 1{actual=A})²
 * Range: [0, 2]. Lower = better. Uniform-baseline Brier ≈ 0.667.
 */
function brier1X2(probH, probD, probA, result) {
  const yH = result === "H" ? 1 : 0;
  const yD = result === "D" ? 1 : 0;
  const yA = result === "A" ? 1 : 0;
  return (probH - yH) ** 2 + (probD - yD) ** 2 + (probA - yA) ** 2;
}

/**
 * Brier score for a single O25 binary prediction.
 *   Brier = (p_o - 1{goals > 2.5})²
 * Range: [0, 1]. Doubled when summed with U25 Brier to match the 1X2
 * scaling, but here we just use the binary form.
 */
function brierO25(probO25, totalGoals) {
  const yO = totalGoals > 2.5 ? 1 : 0;
  return (probO25 - yO) ** 2;
}

function actualResult(goalsH, goalsA) {
  if (goalsH > goalsA) return "H";
  if (goalsH < goalsA) return "A";
  return "D";
}

// ─── Supabase fetchers (with PostgREST pagination) ───────────────────

async function fetchAll(table, params = "") {
  const out = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const url = `${SUPA_URL}/rest/v1/${table}?${params}&limit=${PAGE}&offset=${offset}`;
    const resp = await fetch(url, { headers: SUPA_HEADERS });
    if (!resp.ok) throw new Error(`Supabase GET ${table}: ${resp.status} ${await resp.text()}`);
    const page = await resp.json();
    if (page.length === 0) break;
    out.push(...page);
    offset += PAGE;
    if (page.length < PAGE) break;
  }
  return out;
}

// ─── Core: join + compute ────────────────────────────────────────────

async function main() {
  const since = new Date();
  since.setDate(since.getDate() - DAYS);
  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  if (!JSON_OUT) {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  FODZE Live Brier Monitor");
    console.log(`  Window: ${sinceStr} → ${todayStr} (${DAYS} days)`);
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("");
  }

  // Step 1: pull all pipeline_shadow_log predictions in window
  const predictions = await fetchAll(
    "pipeline_shadow_log",
    `select=match_key,league,home_team,away_team,engine_variant,prob_h,prob_d,prob_a,prob_o25,predicted_date&predicted_date=gte.${sinceStr}&predicted_date=lte.${todayStr}`
  );

  if (!JSON_OUT) console.log(`  Fetched ${predictions.length} predictions across ${new Set(predictions.map(p => p.engine_variant)).size} engines`);

  if (predictions.length === 0) {
    console.log("  No predictions in window. Exit.");
    return;
  }

  // Step 2: pull all team_xg_history rows in same window with results
  const results = await fetchAll(
    "team_xg_history",
    `select=team,opponent,league,match_date,goals_for,goals_against&venue=eq.home&match_date=gte.${sinceStr}&match_date=lte.${todayStr}&goals_for=not.is.null`
  );

  if (!JSON_OUT) console.log(`  Fetched ${results.length} settled home-rows for matching\n`);

  // Step 3: build a per-(league, date) result-map indexed for fuzzy lookup
  // O(P × R_per_day) instead of O(P × R) — for typical week, ~6 R per
  // (league, date) bucket so the inner scan is 50-100ms total.
  const resultsByDate = new Map();
  for (const r of results) {
    const key = `${r.league}|${r.match_date}`;
    if (!resultsByDate.has(key)) resultsByDate.set(key, []);
    resultsByDate.get(key).push(r);
  }

  // Step 4: per-prediction join via fuzzy team match + accumulate Brier
  // accumulator: agg[engine][league] = { n, brier1X2, brierO25, n_o25 }
  const agg = new Map();
  function bump(engine, league, brier1, brier_o25_or_null) {
    if (!agg.has(engine)) agg.set(engine, new Map());
    const byLg = agg.get(engine);
    if (!byLg.has(league)) byLg.set(league, { n: 0, brier1X2: 0, brierO25: 0, n_o25: 0 });
    const bucket = byLg.get(league);
    bucket.n += 1;
    bucket.brier1X2 += brier1;
    if (brier_o25_or_null != null) {
      bucket.brierO25 += brier_o25_or_null;
      bucket.n_o25 += 1;
    }
  }

  let resolved = 0;
  let unresolved = 0;
  const unresolvedSamples = [];

  for (const p of predictions) {
    const dayKey = `${p.league}|${p.predicted_date}`;
    const candidates = resultsByDate.get(dayKey) || [];
    const match = candidates.find(
      (r) =>
        fuzzyTeamMatch(p.home_team, r.team) &&
        fuzzyTeamMatch(p.away_team, r.opponent)
    );
    if (!match) {
      unresolved++;
      if (unresolvedSamples.length < 5) unresolvedSamples.push(`${p.league} ${p.home_team} vs ${p.away_team} ${p.predicted_date}`);
      continue;
    }
    const goalsH = Number(match.goals_for);
    const goalsA = Number(match.goals_against);
    if (!Number.isFinite(goalsH) || !Number.isFinite(goalsA)) { unresolved++; continue; }

    const result = actualResult(goalsH, goalsA);
    const b1 = brier1X2(Number(p.prob_h), Number(p.prob_d), Number(p.prob_a), result);
    const bO = p.prob_o25 != null ? brierO25(Number(p.prob_o25), goalsH + goalsA) : null;
    bump(p.engine_variant, p.league, b1, bO);
    resolved++;
  }

  if (!JSON_OUT) {
    console.log(`  Resolved ${resolved}/${predictions.length} predictions (${unresolved} skipped — match not yet played or team-name mismatch)`);
    if (unresolvedSamples.length > 0 && resolved === 0) {
      console.log("  Sample unresolved:");
      unresolvedSamples.forEach((s) => console.log(`    - ${s}`));
    }
    console.log("");
  }

  // Step 5: build report rows: per-engine overall + per-engine-per-league
  const report = [];
  for (const [engine, byLg] of agg.entries()) {
    let totalN = 0, totalBrier1 = 0, totalBrierO = 0, totalN_O = 0;
    const leagueRows = [];
    for (const [league, b] of byLg.entries()) {
      const meanBrier1 = b.brier1X2 / b.n;
      const meanBrierO = b.n_o25 > 0 ? b.brierO25 / b.n_o25 : null;
      leagueRows.push({ league, n: b.n, brier1X2: meanBrier1, brierO25: meanBrierO });
      totalN += b.n;
      totalBrier1 += b.brier1X2;
      totalBrierO += b.brierO25;
      totalN_O += b.n_o25;
    }
    leagueRows.sort((a, b) => b.n - a.n);
    report.push({
      engine,
      overall: {
        n: totalN,
        brier1X2: totalBrier1 / totalN,
        brierO25: totalN_O > 0 ? totalBrierO / totalN_O : null,
      },
      leagues: leagueRows,
    });
  }
  report.sort((a, b) => a.overall.brier1X2 - b.overall.brier1X2);

  // Step 6: render output
  if (JSON_OUT) {
    console.log(JSON.stringify({
      window: { since: sinceStr, until: todayStr, days: DAYS },
      resolved, unresolved, predictions_total: predictions.length,
      engines: report,
    }, null, 2));
  } else {
    if (resolved === 0) {
      console.log("  ⚠ No matches resolvable yet. Either:");
      console.log("    - All predictions are for future matches (nothing settled yet)");
      console.log("    - Team-name fuzzy match failed (check unresolved samples above)");
      console.log("    - team_xg_history hasn't backfilled the result rows yet");
      return;
    }

    console.log("  ENGINE OVERALL — sorted by Brier 1X2 (lower = better)");
    console.log("  ─────────────────────────────────────────────────────────────");
    console.log(`  ${"engine".padEnd(18)} ${"n".padStart(5)}  ${"Brier 1X2".padEnd(11)} ${"Brier O25"}`);
    for (const r of report) {
      const o25 = r.overall.brierO25 != null ? r.overall.brierO25.toFixed(4) : "—";
      console.log(`  ${r.engine.padEnd(18)} ${String(r.overall.n).padStart(5)}  ${r.overall.brier1X2.toFixed(4).padEnd(11)} ${o25}`);
    }
    console.log("");

    // Per-Liga breakdown for the best engine only (avoid wall-of-text)
    const best = report[0];
    console.log(`  PER-LEAGUE BREAKDOWN — ${best.engine}`);
    console.log("  ─────────────────────────────────────────────────────────────");
    console.log(`  ${"league".padEnd(18)} ${"n".padStart(5)}  ${"Brier 1X2".padEnd(11)} ${"Brier O25"}`);
    for (const lg of best.leagues) {
      const o25 = lg.brierO25 != null ? lg.brierO25.toFixed(4) : "—";
      console.log(`  ${lg.league.padEnd(18)} ${String(lg.n).padStart(5)}  ${lg.brier1X2.toFixed(4).padEnd(11)} ${o25}`);
    }
    console.log("");
  }

  // Step 7: optional persistence — write to live_brier_snapshots table
  if (PERSIST) {
    if (!JSON_OUT) console.log("  Persisting to live_brier_snapshots…");
    // Schema (CREATE TABLE if it doesn't exist — caller's responsibility):
    //   id uuid pk, window_end_date date, engine text, league text,
    //   n int, brier_1x2 numeric, brier_o25 numeric, captured_at timestamptz
    //   UNIQUE (window_end_date, engine, league)
    const rows = [];
    for (const r of report) {
      // overall row (league = '__overall')
      rows.push({
        window_end_date: todayStr,
        engine: r.engine,
        league: "__overall",
        n: r.overall.n,
        brier_1x2: r.overall.brier1X2,
        brier_o25: r.overall.brierO25,
        captured_at: new Date().toISOString(),
      });
      for (const lg of r.leagues) {
        rows.push({
          window_end_date: todayStr,
          engine: r.engine,
          league: lg.league,
          n: lg.n,
          brier_1x2: lg.brier1X2,
          brier_o25: lg.brierO25,
          captured_at: new Date().toISOString(),
        });
      }
    }
    const resp = await fetch(
      `${SUPA_URL}/rest/v1/live_brier_snapshots?on_conflict=window_end_date,engine,league`,
      {
        method: "POST",
        headers: { ...SUPA_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`  ⚠ Persist failed: ${resp.status} ${txt.slice(0, 200)}`);
      console.error(`  Tip: create table first via Supabase MCP migration. Schema in script header.`);
    } else if (!JSON_OUT) {
      console.log(`  ✓ Upserted ${rows.length} rows`);
    }
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});

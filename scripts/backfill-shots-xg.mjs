#!/usr/bin/env node
/**
 * FODZE Shots-to-xG Backfill — Populate team_xg_history from CSV shot data
 *
 * Uses the trained shots-to-xG model (public/shots-xg-model.json) to estimate
 * per-match xG from football-data.co.uk CSV shot data (HS, HST, AS, AST).
 *
 * Usage:
 *   node scripts/backfill-shots-xg.mjs --all                  # All 12 non-Understat leagues
 *   node scripts/backfill-shots-xg.mjs --league bundesliga2   # Single league
 *   node scripts/backfill-shots-xg.mjs --league bundesliga2 --dry  # Dry run
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (or .env.local)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── Load .env.local ──────────────────────────────────────────────
const envPath = resolve(PROJECT_ROOT, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ─── Config ──────────────────────────────────────────────────────
const CSV_DIR = resolve(PROJECT_ROOT, "Historie", "data-2526");
const MODEL_PATH = resolve(PROJECT_ROOT, "public", "shots-xg-model.json");

// Map FODZE league key → CSV code
const LEAGUE_CSV = {
  bundesliga2: "D2", championship: "E1", league_one: "E2", league_two: "E3",
  la_liga2: "SP2", serie_b: "I2", ligue_2: "F2",
  primeira_liga: "P1", jupiler_pro: "B1", super_lig: "T1",
  scottish_prem: "SC0", greek_sl: "G1",
  // Understat leagues — only backfill if --force
  bundesliga: "D1", epl: "E0", la_liga: "SP1", serie_a: "I1",
  ligue_1: "F1", eredivisie: "N1",
};

const UNDERSTAT_LEAGUES = new Set(["bundesliga", "epl", "la_liga", "serie_a", "ligue_1", "eredivisie"]);

// ─── Parse args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const FORCE = args.includes("--force");
const ALL = args.includes("--all");
const singleLeague = args.find((a, i) => args[i - 1] === "--league");

// ─── Load model ──────────────────────────────────────────────────
const model = JSON.parse(readFileSync(MODEL_PATH, "utf-8"));
const { intercept, coef_shots_on_target, coef_shots_off_target } = model;

function estimateXG(shotsOnTarget, shotsTotal) {
  const shotsOff = Math.max(0, shotsTotal - shotsOnTarget);
  return Math.max(0.05, intercept + coef_shots_on_target * shotsOnTarget + coef_shots_off_target * shotsOff);
}

console.log("═══ FODZE Shots-to-xG Backfill ═══");
console.log(`Model: xG = ${intercept.toFixed(4)} + ${coef_shots_on_target.toFixed(4)}×SOT + ${coef_shots_off_target.toFixed(4)}×SOFF`);
console.log(`R² = ${model.r2}, MAE = ${model.mae}`);
console.log(`Mode: ${DRY ? "DRY RUN" : "LIVE"}\n`);

// ─── Determine leagues to process ────────────────────────────────
let leagues;
if (ALL) {
  leagues = Object.keys(LEAGUE_CSV).filter(l => !UNDERSTAT_LEAGUES.has(l) || FORCE);
} else if (singleLeague) {
  leagues = [singleLeague];
} else {
  console.error("Usage: --all or --league <key>");
  process.exit(1);
}

// ─── Process each league ─────────────────────────────────────────
let totalRows = 0;
let totalSkipped = 0;

for (const league of leagues) {
  const csvCode = LEAGUE_CSV[league];
  if (!csvCode) { console.log(`❌ Unknown league: ${league}`); continue; }

  const csvPath = resolve(CSV_DIR, `${csvCode}.csv`);
  if (!existsSync(csvPath)) { console.log(`❌ CSV not found: ${csvPath}`); continue; }

  const csvContent = readFileSync(csvPath, "utf-8");
  // Simple CSV parsing (handle BOM)
  const lines = csvContent.replace(/^\uFEFF/, "").split("\n");
  const headers = lines[0].split(",").map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j]?.trim());
    rows.push(row);
  }

  const supaRows = [];

  for (const row of rows) {
    const ht = row.HomeTeam || "";
    const at = row.AwayTeam || "";
    if (!ht || !at) continue;

    const dateStr = row.Date || "";
    let dateISO;
    try {
      const parts = dateStr.split("/");
      if (parts.length !== 3) continue;
      const [d, m, y] = parts;
      const year = y.length === 4 ? y : `20${y}`;
      dateISO = `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    } catch { continue; }

    const hs = parseInt(row.HS) || 0;
    const as_ = parseInt(row.AS) || 0;
    const hst = parseInt(row.HST) || 0;
    const ast = parseInt(row.AST) || 0;
    const hg = parseInt(row.FTHG) || 0;
    const ag = parseInt(row.FTAG) || 0;

    if (hs === 0 && as_ === 0) continue; // No shot data

    const homeXG = estimateXG(hst, hs);
    const awayXG = estimateXG(ast, as_);

    // Phase 3.1: also persist corner counts when football-data.co.uk's
    // HC/AC columns are present (they are on all Main-CSV seasons since
    // 2005). Null-when-missing so rows from CSVs that drop the column
    // don't get bogus zeros.
    const hcRaw = row.HC, acRaw = row.AC;
    const hc = hcRaw !== undefined && hcRaw !== "" && !Number.isNaN(+hcRaw) ? +hcRaw : null;
    const ac = acRaw !== undefined && acRaw !== "" && !Number.isNaN(+acRaw) ? +acRaw : null;

    // Home perspective — also persist shots so backtests can score
    // expected-vs-actual (migration-team-xg-shots.sql added the cols).
    supaRows.push({
      team: ht, league, opponent: at, venue: "home",
      match_date: dateISO, xg: +homeXG.toFixed(4), xga: +awayXG.toFixed(4),
      goals_for: hg, goals_against: ag,
      corners_for: hc, corners_against: ac,
      shots_for: hs, shots_against: as_,
      shots_on_target_for: hst, shots_on_target_against: ast,
      source: "shots-model",
    });

    // Away perspective
    supaRows.push({
      team: at, league, opponent: ht, venue: "away",
      match_date: dateISO, xg: +awayXG.toFixed(4), xga: +homeXG.toFixed(4),
      goals_for: ag, goals_against: hg,
      corners_for: ac, corners_against: hc,
      shots_for: as_, shots_against: hs,
      shots_on_target_for: ast, shots_on_target_against: hst,
      source: "shots-model",
    });
  }

  console.log(`${league}: ${supaRows.length} rows from ${rows.length} matches`);

  // Show sample
  if (supaRows.length > 0) {
    const s = supaRows[0];
    console.log(`  Sample: ${s.team} (${s.venue}) ${s.match_date}: xG=${s.xg}, xGA=${s.xga}, goals=${s.goals_for}:${s.goals_against}`);
  }

  if (DRY) {
    totalRows += supaRows.length;
    continue;
  }

  // ─── Upsert to Supabase ─────────────────────────────────────
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }

  // Batch upsert in chunks of 500.
  // on_conflict=... is REQUIRED by PostgREST when a table has multiple
  // unique constraints — without it the Prefer: resolution=merge-duplicates
  // header is silently ignored and we get 23505 duplicate-key errors.
  const BATCH = 500;
  let inserted = 0;
  const upsertUrl = `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`;
  for (let i = 0; i < supaRows.length; i += BATCH) {
    const batch = supaRows.slice(i, i + BATCH);
    const res = await fetch(upsertUrl, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  ❌ Batch ${i}-${i + batch.length} failed: ${err.substring(0, 200)}`);
    } else {
      inserted += batch.length;
    }
  }
  console.log(`  ✅ ${inserted} rows upserted to Supabase`);
  totalRows += inserted;
}

console.log(`\n═══ DONE ═══`);
console.log(`Total: ${totalRows} rows ${DRY ? "(dry run)" : "upserted"}`);

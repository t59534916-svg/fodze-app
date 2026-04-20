#!/usr/bin/env node
/**
 * FODZE Historical Closing Odds Backfill — football-data.co.uk
 * ════════════════════════════════════════════════════════════
 * Fetches Buchdahl's public season CSVs and ingests the Pinnacle Closing
 * columns (PSCH/PSCD/PSCA, PSC>2.5, PSC<2.5, PSCAHH/PSCAHA) into the
 * `odds_closing_history` table.
 *
 * Source: https://www.football-data.co.uk/mmz4281/{SEASON}/{CODE}.csv
 *   - SEASON: 4-digit compact, e.g. "2425" for the 2024/25 season
 *   - CODE:   D1/D2 (Bundesliga 1/2), E0/E1 (EPL/Championship),
 *             SP1/SP2, I1/I2, F1/F2, N1, B1, P1, T1, G1, SC0.
 *
 * Encoding: CSVs are Windows-1252 (legacy Buchdahl convention for the
 * German/Portuguese/Turkish diacritics). Node 22's built-in TextDecoder
 * handles this natively when built with full-icu (default for prebuilt
 * Node binaries). Falls back to latin1 if unavailable.
 *
 * Usage:
 *   node scripts/backfill-football-data-co-uk.mjs --league bundesliga --season 2425
 *   node scripts/backfill-football-data-co-uk.mjs --league bundesliga --seasons 2021,2223,2324,2425 --dry
 *   node scripts/backfill-football-data-co-uk.mjs --all --season 2425
 *
 * Flags:
 *   --league <code>   FODZE league key (required unless --all)
 *   --season <s>      Single season (default: current season, e.g. "2526")
 *   --seasons <list>  Comma-separated list for multi-season backfill
 *   --all             Iterate all 13 supported leagues for one season
 *   --dry             Parse + preview; no DB write
 *   --csv-dir <path>  Parse local CSV files from a directory instead of
 *                     downloading. Expects files named "{CODE}.csv".
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  decodeBuffer,
  parseCsv,
  buildRows,
} from "./_lib/football-data-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader (match the rest of the pipeline) ───────────────────
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
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

// ─── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const DRY = args.includes("--dry");
const ALL = args.includes("--all");
const LEAGUE = argValue("--league");
const SEASON = argValue("--season");
const SEASONS = argValue("--seasons");
const CSV_DIR = argValue("--csv-dir");

// ─── League map (FODZE key → football-data.co.uk CSV code) ─────────
// 13 leagues total. League One (E2), League Two (E3), Liga 3 lack PSCH in
// their CSVs on football-data.co.uk — excluded, stay on live_odds-snapshot-only.
const LEAGUE_CSV = {
  bundesliga: "D1", bundesliga2: "D2",
  epl: "E0", championship: "E1",
  la_liga: "SP1", la_liga2: "SP2",
  serie_a: "I1", serie_b: "I2",
  ligue_1: "F1", ligue_2: "F2",
  eredivisie: "N1", jupiler_pro: "B1",
  primeira_liga: "P1", super_lig: "T1",
  greek_sl: "G1", scottish_prem: "SC0",
};

function currentSeason() {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? y : y - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

// ─── Fetch CSV (URL or local dir) ──────────────────────────────────
async function loadCsv(league, season, csvCode) {
  if (CSV_DIR) {
    const p = resolve(CSV_DIR, `${csvCode}.csv`);
    if (!existsSync(p)) throw new Error(`CSV not found: ${p}`);
    return decodeBuffer(readFileSync(p));
  }
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${csvCode}.csv`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = await resp.arrayBuffer();
  return decodeBuffer(new Uint8Array(buf));
}

// ─── Upsert to Supabase (batched) ──────────────────────────────────
async function upsertBatch(rows) {
  const BATCH = 500;
  let ok = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const resp = await fetch(`${SUPA_URL}/rest/v1/odds_closing_history`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(chunk),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Supabase upsert failed (${resp.status}): ${err.slice(0, 200)}`);
    }
    ok += chunk.length;
  }
  return ok;
}

// ─── Main ──────────────────────────────────────────────────────────
async function runOne(league, season) {
  const csvCode = LEAGUE_CSV[league];
  if (!csvCode) {
    console.warn(`[fd] skip ${league}: not in football-data.co.uk coverage`);
    return { league, season, ok: 0, skipped: 0, status: "unsupported" };
  }
  console.log(`[fd] ${league} ${season} (${csvCode})`);
  let csvText;
  try {
    csvText = await loadCsv(league, season, csvCode);
  } catch (e) {
    console.warn(`[fd]   → fetch failed: ${e.message}`);
    return { league, season, ok: 0, skipped: 0, status: "fetch-failed" };
  }
  const { headers, rows } = parseCsv(csvText);
  if (rows.length === 0) {
    console.warn(`[fd]   → empty CSV`);
    return { league, season, ok: 0, skipped: 0, status: "empty" };
  }
  if (!headers.includes("PSCH")) {
    console.warn(`[fd]   → CSV has no PSCH column (likely pre-2013 season)`);
    return { league, season, ok: 0, skipped: rows.length, status: "no-psch" };
  }
  const { rows: built, skipped } = buildRows(league, season, rows);
  console.log(`[fd]   → ${built.length} rows with Pinnacle Closing (${skipped} skipped)`);

  if (DRY) {
    if (built.length > 0) {
      const s = built[0];
      console.log(`[fd]   sample: ${s.home_team} vs ${s.away_team} ${s.match_date} PSCH=${s.psch} PSCD=${s.pscd} PSCA=${s.psca} → ${s.ft_result}`);
    }
    return { league, season, ok: built.length, skipped, status: "dry" };
  }

  if (!SUPA_URL || !SUPA_KEY) {
    console.error(`[fd]   → Supabase creds missing (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY)`);
    process.exit(1);
  }
  const ok = await upsertBatch(built);
  console.log(`[fd]   ✓ upserted ${ok} rows`);
  return { league, season, ok, skipped, status: "ok" };
}

async function main() {
  if (!LEAGUE && !ALL) {
    console.error("Either --league <key> or --all is required");
    process.exit(1);
  }
  const seasons = SEASONS
    ? SEASONS.split(",").map(s => s.trim()).filter(Boolean)
    : [SEASON || currentSeason()];
  const leagues = ALL ? Object.keys(LEAGUE_CSV) : [LEAGUE];

  const results = [];
  for (const lg of leagues) {
    for (const sn of seasons) {
      const r = await runOne(lg, sn);
      results.push(r);
    }
  }
  console.log();
  const tot = results.reduce((s, r) => s + r.ok, 0);
  console.log(`[fd] DONE — ${tot} rows across ${results.length} (league, season) pairs`);
  for (const r of results) {
    console.log(`     ${r.league.padEnd(14)} ${r.season}  ${String(r.ok).padStart(5)} rows  [${r.status}]`);
  }
}

main().catch((e) => {
  console.error("[fd] unhandled:", e);
  process.exit(1);
});

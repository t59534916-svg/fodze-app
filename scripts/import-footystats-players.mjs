#!/usr/bin/env node
/**
 * FODZE — FootyStats Players CSV Importer → player_season_stats
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Imports the FS Players CSV (271 cols per file) into player_season_stats,
 * keeping ~45 high-value fields. Skipped: percentile-only fields, most
 * home/away splits, shirt_number, salary GBP/USD (eur sufficient), free-
 * text "additional_info".
 *
 * Coverage scope: 16+ lower-tier leagues (since Top-5 are better covered
 * by Understat in player_xg_history). Files named:
 *   "<country>-<league>-players-<y1>-to-<y2>-stats.csv"
 *
 * Idempotent via UNIQUE (league, season, full_name, current_club).
 *
 * Usage:
 *   node scripts/import-footystats-players.mjs --dir tools/footystats/csv
 *   node scripts/import-footystats-players.mjs --file <csv> --league bundesliga2
 *   node scripts/import-footystats-players.mjs --dir <dir> --dry
 *   node scripts/import-footystats-players.mjs --dir <dir> --no-supabase
 *
 * ENV (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : f; };

const DRY = flag("dry");
const VERBOSE = flag("verbose");
const NO_SUPABASE = flag("no-supabase");
const FILE = val("file", null);
const DIR = val("dir", null);
const LEAGUE_OVERRIDE = val("league", null);
const MIN_MINUTES = parseInt(val("min-minutes", "0"), 10);  // optional: skip benchwarmers

if (!FILE && !DIR) {
  console.error("Usage: --file <CSV> [--league X]  |  --dir <DIR>  [--dry] [--no-supabase] [--verbose] [--min-minutes N]");
  process.exit(1);
}
if (!DRY && !NO_SUPABASE && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt (or use --no-supabase)");
  process.exit(1);
}

// ─── Column mapping (FS-CSV column name → our table column) ──────────
const COLS = {
  // identity
  full_name:          "full_name",
  position:           "position",
  current_club:       "Current Club",
  age:                "age",
  nationality:        "nationality",
  // volume
  minutes_played:     "minutes_played_overall",
  appearances:        "appearances_overall",
  games_started:      "games_started",
  games_subbed_in:    "games_subbed_in",
  games_subbed_out:   "games_subbed_out",
  // production
  goals:              "goals_overall",
  assists:            "assists_overall",
  xg_total:           "xg_total_overall",
  xg_per_90:          "xg_per_90_overall",
  npxg_total:         "npxg_total_overall",
  npxg_per_90:        "npxg_per_90_overall",
  xa_total:           "xa_total_overall",
  xa_per_90:          "xa_per_90_overall",
  key_passes_total:   "key_passes_total_overall",
  chances_created:    "chances_created_total_overall",
  // shooting
  shots_total:        "shots_total_overall",
  shots_on_target:    "shots_on_target_total_overall",
  shot_accuracy_pct:  "shot_accuraccy_percentage_overall",  // FS-typo "accuraccy" intentional
  shot_conversion_rate: "shot_conversion_rate_overall",
  // defensive
  tackles_successful: "tackles_successful_total_overall",
  interceptions:      "interceptions_total_overall",
  blocks:             "blocks_total_overall",
  clearances:         "clearances_total_overall",
  duels_won:          "duels_won_total_overall",
  duels_total:        "duels_total_overall",
  aerial_duels_won:   "aerial_duels_won_total_overall",
  // GK
  saves:              "saves_total_overall",
  xg_faced_total:     "xg_faced_total_overall",
  clean_sheets:       "clean_sheets_overall",
  conceded:           "conceded_overall",
  save_percentage:    "save_percentage_overall",
  // discipline
  yellow_cards:       "yellow_cards_overall",
  red_cards:          "red_cards_overall",
  fouls_committed:    "fouls_committed_total_overall",
  fouls_drawn:        "fouls_drawn_total_overall",
  penalties_committed: "pen_committed_total_overall",
  penalties_scored:   "pen_scored_total_overall",
  // value + meta
  market_value_eur:   "market_value",
  annual_salary_eur:  "annual_salary_eur",
  average_rating:     "average_rating_overall",
  man_of_the_match:   "man_of_the_match_total_overall",
};

// ─── CSV parse + helpers ─────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (field || row.length) { row.push(field); rows.push(row); }
        field = ""; row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
      } else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findCol(headerRow, name) {
  const i = headerRow.indexOf(name);
  if (i >= 0) return i;
  const ci = headerRow.findIndex(h => h.toLowerCase() === name.toLowerCase());
  return ci;
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null" || s.toUpperCase() === "N/A") return null;
  const cleaned = s.endsWith("%") ? s.slice(0, -1) : s;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}

function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === "N/A") return null;
  return s;
}

// ─── Season normalization ────────────────────────────────────────────
// FS CSV season field comes as "2024/2025", we want "24/25"
function normalizeSeason(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{4})\/(\d{4})/);
  if (m) return `${m[1].slice(2)}/${m[2].slice(2)}`;
  // Fall back to short already
  if (/^\d{2}\/\d{2}$/.test(raw)) return raw;
  return raw;
}

// ─── League inference from filename ──────────────────────────────────
const FILENAME_PREFIX_TO_LEAGUE = {
  "england-premier-league": "epl",
  "england-championship": "championship",
  "england-efl-league-one": "league_one",
  "england-efl-league-two": "league_two",
  "germany-bundesliga": "bundesliga",
  "germany-2-bundesliga": "bundesliga2",
  "germany-3-liga": "liga3",
  "spain-la-liga": "la_liga",
  "spain-segunda-division": "la_liga2",
  "italy-serie-a": "serie_a",
  "italy-serie-b": "serie_b",
  "france-ligue-1": "ligue_1",
  "france-ligue-2": "ligue_2",
  "netherlands-eredivisie": "eredivisie",
  "netherlands-eerste-divisie": "eerste_divisie",
  "portugal-liga-nos": "primeira_liga",
  "portugal-primeira-liga": "primeira_liga",
  "belgium-pro-league": "jupiler_pro",
  "belgium-jupiler-pro-league": "jupiler_pro",
  "turkey-super-lig": "super_lig",
  "scotland-premiership": "scottish_prem",
  "scotland-scottish-premiership": "scottish_prem",
  "greece-super-league": "greek_sl",
  "greece-super-league-1": "greek_sl",
  "austria-bundesliga": "austria_bl",
  "switzerland-super-league": "swiss_sl",
};

function inferLeagueFromFilename(name) {
  const lower = name.toLowerCase();
  const prefixes = Object.keys(FILENAME_PREFIX_TO_LEAGUE).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (lower.startsWith(p + "-players-")) return FILENAME_PREFIX_TO_LEAGUE[p];
  }
  return null;
}

function inferSeasonFromFilename(name) {
  const m = name.match(/-players-(\d{4})-to-(\d{4})/i);
  if (!m) return null;
  return `${m[1].slice(2)}/${m[2].slice(2)}`;
}

// ─── Supabase upsert ─────────────────────────────────────────────────
async function supaUpsert(rows) {
  if (rows.length === 0 || NO_SUPABASE) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/player_season_stats?on_conflict=league,season,full_name,current_club`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`upsert ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return rows.length;
}

// ─── File processor ──────────────────────────────────────────────────
async function processFile(filePath, leagueKey, season) {
  console.log(`\n━━━ ${basename(filePath)} → ${leagueKey} · ${season} ━━━`);
  const text = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  const rows = parseCSV(text);
  if (rows.length < 2) { console.log(`  ⚠ empty CSV`); return { rows: 0 }; }
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1);

  // Build column index map (FS-CSV header name → row index)
  const idx = {};
  const missing = [];
  for (const [ourCol, fsCol] of Object.entries(COLS)) {
    const i = findCol(header, fsCol);
    idx[ourCol] = i;
    if (i < 0) missing.push(`${ourCol}=${fsCol}`);
  }
  if (VERBOSE && missing.length) {
    console.log(`  Missing cols (${missing.length}/${Object.keys(COLS).length}): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`);
  }
  if (idx.full_name < 0 || idx.current_club < 0) {
    console.log(`  ✗ missing mandatory cols (full_name + current_club)`);
    return { rows: 0, error: "missing mandatory cols" };
  }

  const batch = [];
  let skipped_low_minutes = 0;
  for (const r of data) {
    if (r.length < header.length) continue;
    const fullName = toStr(r[idx.full_name]);
    const club = toStr(r[idx.current_club]);
    if (!fullName || !club) continue;

    const minutes = idx.minutes_played >= 0 ? toInt(r[idx.minutes_played]) : null;
    if (MIN_MINUTES > 0 && (minutes ?? 0) < MIN_MINUTES) {
      skipped_low_minutes++; continue;
    }

    const canonClub = canonicalize(club, leagueKey);

    const row = {
      full_name: fullName,
      league: leagueKey,
      season: season,
      current_club: canonClub,
      position: toStr(r[idx.position]),
      age: idx.age >= 0 ? toInt(r[idx.age]) : null,
      nationality: toStr(r[idx.nationality]),
      minutes_played: minutes,
      appearances: toInt(r[idx.appearances]),
      games_started: toInt(r[idx.games_started]),
      games_subbed_in: toInt(r[idx.games_subbed_in]),
      games_subbed_out: toInt(r[idx.games_subbed_out]),
      goals: toInt(r[idx.goals]),
      assists: toInt(r[idx.assists]),
      xg_total: toNum(r[idx.xg_total]),
      xg_per_90: toNum(r[idx.xg_per_90]),
      npxg_total: toNum(r[idx.npxg_total]),
      npxg_per_90: toNum(r[idx.npxg_per_90]),
      xa_total: toNum(r[idx.xa_total]),
      xa_per_90: toNum(r[idx.xa_per_90]),
      key_passes_total: toInt(r[idx.key_passes_total]),
      chances_created: toInt(r[idx.chances_created]),
      shots_total: toInt(r[idx.shots_total]),
      shots_on_target: toInt(r[idx.shots_on_target]),
      shot_accuracy_pct: toNum(r[idx.shot_accuracy_pct]),
      shot_conversion_rate: toNum(r[idx.shot_conversion_rate]),
      tackles_successful: toInt(r[idx.tackles_successful]),
      interceptions: toInt(r[idx.interceptions]),
      blocks: toInt(r[idx.blocks]),
      clearances: toInt(r[idx.clearances]),
      duels_won: toInt(r[idx.duels_won]),
      duels_total: toInt(r[idx.duels_total]),
      aerial_duels_won: toInt(r[idx.aerial_duels_won]),
      saves: toInt(r[idx.saves]),
      xg_faced_total: toNum(r[idx.xg_faced_total]),
      clean_sheets: toInt(r[idx.clean_sheets]),
      conceded: toInt(r[idx.conceded]),
      save_percentage: toNum(r[idx.save_percentage]),
      yellow_cards: toInt(r[idx.yellow_cards]),
      red_cards: toInt(r[idx.red_cards]),
      fouls_committed: toInt(r[idx.fouls_committed]),
      fouls_drawn: toInt(r[idx.fouls_drawn]),
      penalties_committed: toInt(r[idx.penalties_committed]),
      penalties_scored: toInt(r[idx.penalties_scored]),
      market_value_eur: toInt(r[idx.market_value_eur]),
      annual_salary_eur: toInt(r[idx.annual_salary_eur]),
      average_rating: toNum(r[idx.average_rating]),
      man_of_the_match: toInt(r[idx.man_of_the_match]),
      source: "footystats",
    };
    batch.push(row);
  }

  console.log(`  ${batch.length} players parsed${skipped_low_minutes ? ` (skipped_low_minutes=${skipped_low_minutes})` : ""}`);

  if (DRY) {
    if (batch.length > 0 && VERBOSE) {
      console.log(`  (DRY) sample: ${JSON.stringify(batch[0]).slice(0, 400)}`);
    }
    return { rows: 0, parsed: batch.length, dry: true };
  }
  if (NO_SUPABASE) {
    console.log(`  (no-supabase) skipping write`);
    return { rows: 0, parsed: batch.length };
  }

  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < batch.length; i += BATCH) {
    try {
      written += await supaUpsert(batch.slice(i, i + BATCH));
    } catch (e) {
      console.log(`  ✗ batch ${i}: ${e.message}`);
    }
  }
  console.log(`  ✓ upserted ${written}`);
  return { rows: written };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — FootyStats Players Importer (player_season_stats)║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  let files = [];
  if (FILE) {
    if (!existsSync(FILE)) { console.error(`File not found: ${FILE}`); process.exit(1); }
    files.push(FILE);
  } else {
    if (!existsSync(DIR)) { console.error(`Dir not found: ${DIR}`); process.exit(1); }
    // Filter to Players CSVs only (skip match + league CSVs)
    files = readdirSync(DIR)
      .filter(f => f.endsWith(".csv") && f.includes("-players-"))
      .map(f => resolve(DIR, f))
      .sort();
  }
  console.log(`  Mode:   ${DRY ? "DRY-RUN" : (NO_SUPABASE ? "NO-SUPABASE" : "LIVE")}`);
  console.log(`  Files:  ${files.length}`);
  if (MIN_MINUTES > 0) console.log(`  Min minutes filter: ${MIN_MINUTES}`);
  console.log();

  let total = 0, totalParsed = 0;
  const errors = [];
  for (const f of files) {
    const leagueKey = LEAGUE_OVERRIDE || inferLeagueFromFilename(basename(f));
    const season = inferSeasonFromFilename(basename(f));
    if (!leagueKey) {
      console.log(`\n⚠ Skipping ${basename(f)}: couldn't infer league`);
      errors.push({ file: basename(f), error: "no league" });
      continue;
    }
    if (!season) {
      console.log(`\n⚠ Skipping ${basename(f)}: couldn't infer season`);
      errors.push({ file: basename(f), error: "no season" });
      continue;
    }
    try {
      const res = await processFile(f, leagueKey, season);
      total += res.rows || 0;
      totalParsed += res.parsed || 0;
      if (res.error) errors.push({ file: basename(f), error: res.error });
    } catch (e) {
      console.log(`\n✗ ${basename(f)}: ${e.message}`);
      errors.push({ file: basename(f), error: e.message });
    }
  }

  console.log(`\n━━━ Summary ━━━`);
  console.log(`  ✓ files processed:  ${files.length - errors.length}/${files.length}`);
  console.log(`  ✓ players upserted: ${total}${DRY || NO_SUPABASE ? " (dry/no-supabase)" : ""}`);
  console.log(`  ℹ parsed:           ${totalParsed}`);
  if (errors.length) {
    console.log(`\n  ✗ errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`    ${e.file}: ${e.error}`);
  }
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

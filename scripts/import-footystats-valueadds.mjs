#!/usr/bin/env node
/**
 * FODZE — FootyStats CSV Importer · Value-Adds (NOT team_xg_history)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Why this exists separately from `import-footystats-csv.mjs`:
 *
 * The legacy importer writes to `team_xg_history` with `ON CONFLICT
 * (team, league, match_date, venue) merge-duplicates`. Running it on the
 * 110 existing FS CSVs would OVERWRITE ~26k high-quality Sofa-sourced
 * rows (real shotmap-derived xG, 32 unique team stats) with FS's older
 * basic parametric xG → REGRESSION.
 *
 * This importer captures only FS's UNIQUE value-adds (the fields Sofa
 * doesn't expose) into a NEW table `match_prematch_signals`, with zero
 * risk of touching team_xg_history.
 *
 * Captures per match:
 *   • home/away_prematch_ppg — pre-kickoff points-per-game forecast
 *   • home/away_prematch_xg  — FS-Model pre-match xG (3rd xG source)
 *   • prematch_btts/o15/o25/o35/o45_pct — FS's pre-match % forecasts
 *   • prematch_avg_corners / avg_cards
 *   • attendance + stadium (post-match meta)
 *
 * Does NOT capture from these CSVs:
 *   • xG/goals/shots/possession — already covered by Sofa (higher quality)
 *   • Closing odds — FS odds aren't Pinnacle-sourced, would corrupt the
 *     Benter-blend math which assumes sharp Pinnacle vig-removal
 *
 * Idempotent via UNIQUE (league, match_date, home_team, away_team).
 *
 * Usage:
 *   node scripts/import-footystats-valueadds.mjs --dir tools/footystats/csv
 *   node scripts/import-footystats-valueadds.mjs --file <csv> --league epl
 *   node scripts/import-footystats-valueadds.mjs --dir <dir> --dry
 *   node scripts/import-footystats-valueadds.mjs --dir <dir> --no-supabase  # local-only
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

// ─── .env.local ────────────────────────────────────────────────
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

// ─── CLI ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : f; };

const DRY = flag("dry");
const VERBOSE = flag("verbose");
const NO_SUPABASE = flag("no-supabase");
const FILE = val("file", null);
const DIR = val("dir", null);
const LEAGUE_OVERRIDE = val("league", null);

if (!FILE && !DIR) {
  console.error("Usage: --file <CSV> [--league X]  |  --dir <DIR>  [--dry] [--no-supabase] [--verbose]");
  process.exit(1);
}
if (!DRY && !NO_SUPABASE && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt (or use --no-supabase for local-only)");
  process.exit(1);
}

// ─── Column-Alias Mapping ──────────────────────────────────────
//
// Matched against the 66-col FS Match CSV headers.
const COLUMN_ALIASES = {
  date:              ["date_GMT", "date_gmt", "date", "Date"],
  home_team:         ["home_team_name", "Home"],
  away_team:         ["away_team_name", "Away"],
  status:            ["status", "Status"],
  game_week:         ["Game Week", "game_week"],
  // Pre-Match strength
  home_pre_ppg:      ["Pre-Match PPG (Home)", "pre_match_home_ppg"],
  away_pre_ppg:      ["Pre-Match PPG (Away)", "pre_match_away_ppg"],
  home_pre_xg:       ["Home Team Pre-Match xG", "home_team_pre_match_xg"],
  away_pre_xg:       ["Away Team Pre-Match xG", "away_team_pre_match_xg"],
  // Pre-Match market signals
  avg_goals:         ["average_goals_per_match_pre_match"],
  btts_pct:          ["btts_percentage_pre_match"],
  over15_pct:        ["over_15_percentage_pre_match"],
  over25_pct:        ["over_25_percentage_pre_match"],
  over35_pct:        ["over_35_percentage_pre_match"],
  over45_pct:        ["over_45_percentage_pre_match"],
  avg_corners:       ["average_corners_per_match_pre_match"],
  avg_cards:         ["average_cards_per_match_pre_match"],
  // Meta
  attendance:        ["attendance"],
  stadium:           ["stadium_name", "Stadium"],
};

function findColumn(headerRow, aliases) {
  for (const a of aliases) {
    const i = headerRow.indexOf(a);
    if (i >= 0) return i;
    const ci = headerRow.findIndex(h => h.toLowerCase() === a.toLowerCase());
    if (ci >= 0) return ci;
  }
  return -1;
}

// ─── CSV parsing (handles quoted fields with embedded commas) ────────
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

// ─── Date normalization ───────────────────────────────────────
function toIsoDate(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = parseInt(s, 10);
  if (!isNaN(n) && n > 1_000_000_000 && n < 3_000_000_000 && !/\D/.test(s)) {
    return new Date(n * 1000).toISOString().slice(0, 10);
  }
  const mSlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mSlash) {
    const [_, a, b, y] = mSlash;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
  }
  s = s.replace(/\s*-\s*\d{1,2}:\d{2}\s*(am|pm)?\s*$/i, "");
  const d = new Date(s + " UTC");
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
  return null;
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  const cleaned = s.endsWith("%") ? s.slice(0, -1) : s;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}

// ─── Canonical match_key (mirrors src/lib/format.ts::matchKey) ───────
function canonicalMatchKey(league, homeTeam, awayTeam) {
  const clean = (s) => (s || "").toLowerCase().replace(/\s/g, "");
  return `${league}:${clean(homeTeam)}-${clean(awayTeam)}`;
}

// ─── Infer league + season from filename ──────────────────────
// FS naming: "<country>-<league>-matches-<y1>-to-<y2>-stats.csv"
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
    if (lower.startsWith(p + "-matches-") || lower.startsWith(p + "-fixtures-")) {
      return FILENAME_PREFIX_TO_LEAGUE[p];
    }
  }
  return null;
}

function inferSeasonFromFilename(name) {
  // "...-matches-2024-to-2025-stats.csv" → "24/25"
  const m = name.match(/-matches-(\d{4})-to-(\d{4})/i);
  if (!m) return null;
  const y1 = m[1].slice(2), y2 = m[2].slice(2);
  return `${y1}/${y2}`;
}

// ─── Supabase upsert ──────────────────────────────────────────
async function supaUpsert(rows) {
  if (rows.length === 0 || NO_SUPABASE) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/match_prematch_signals?on_conflict=league,match_date,home_team,away_team`,
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
  if (!res.ok) throw new Error(`upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return rows.length;
}

// ─── File processor ───────────────────────────────────────────
async function processFile(filePath, leagueKey, season) {
  console.log(`\n━━━ ${basename(filePath)} → ${leagueKey} · ${season || "?"} ━━━`);
  const text = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  const rows = parseCSV(text);
  if (rows.length < 2) { console.log(`  ⚠ empty CSV`); return { rows: 0 }; }
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1);

  const ci = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    ci[key] = findColumn(header, aliases);
  }
  const present = Object.entries(ci).filter(([, v]) => v >= 0).map(([k]) => k);
  const missing = Object.entries(ci).filter(([, v]) => v < 0).map(([k]) => k);
  if (VERBOSE) {
    console.log(`  Mapped (${present.length}/${Object.keys(COLUMN_ALIASES).length}): ${present.join(",")}`);
    if (missing.length) console.log(`  Missing: ${missing.join(",")}`);
  }
  if (ci.date < 0 || ci.home_team < 0 || ci.away_team < 0) {
    console.log(`  ✗ missing mandatory cols (date/teams)`);
    return { rows: 0, error: "missing mandatory cols" };
  }

  const batch = [];
  let skippedIncomplete = 0;
  for (const r of data) {
    if (r.length < header.length) continue;
    const status = ci.status >= 0 ? String(r[ci.status] || "").trim().toLowerCase() : "";
    if (status && status !== "complete") { skippedIncomplete++; continue; }
    const date = toIsoDate(r[ci.date]);
    let home = (r[ci.home_team] || "").trim();
    let away = (r[ci.away_team] || "").trim();
    if (!date || !home || !away) continue;
    home = canonicalize(home, leagueKey);
    away = canonicalize(away, leagueKey);
    const row = {
      match_key: canonicalMatchKey(leagueKey, home, away),
      league: leagueKey,
      season: season,
      match_date: date,
      home_team: home,
      away_team: away,
      game_week: ci.game_week >= 0 ? toInt(r[ci.game_week]) : null,
      home_prematch_ppg: ci.home_pre_ppg >= 0 ? toNum(r[ci.home_pre_ppg]) : null,
      away_prematch_ppg: ci.away_pre_ppg >= 0 ? toNum(r[ci.away_pre_ppg]) : null,
      home_prematch_xg:  ci.home_pre_xg  >= 0 ? toNum(r[ci.home_pre_xg])  : null,
      away_prematch_xg:  ci.away_pre_xg  >= 0 ? toNum(r[ci.away_pre_xg])  : null,
      prematch_avg_goals:    ci.avg_goals    >= 0 ? toNum(r[ci.avg_goals])    : null,
      prematch_btts_pct:     ci.btts_pct     >= 0 ? toNum(r[ci.btts_pct])     : null,
      prematch_over15_pct:   ci.over15_pct   >= 0 ? toNum(r[ci.over15_pct])   : null,
      prematch_over25_pct:   ci.over25_pct   >= 0 ? toNum(r[ci.over25_pct])   : null,
      prematch_over35_pct:   ci.over35_pct   >= 0 ? toNum(r[ci.over35_pct])   : null,
      prematch_over45_pct:   ci.over45_pct   >= 0 ? toNum(r[ci.over45_pct])   : null,
      prematch_avg_corners:  ci.avg_corners  >= 0 ? toNum(r[ci.avg_corners])  : null,
      prematch_avg_cards:    ci.avg_cards    >= 0 ? toNum(r[ci.avg_cards])    : null,
      attendance: ci.attendance >= 0 ? toInt(r[ci.attendance]) : null,
      stadium:    ci.stadium    >= 0 ? ((r[ci.stadium] || "").trim() || null) : null,
      source: "footystats",
    };
    batch.push(row);
  }

  console.log(`  ${batch.length} match-rows (skipped_incomplete=${skippedIncomplete})`);

  if (DRY) {
    if (batch.length > 0) {
      const sample = { ...batch[0] };
      console.log(`  (DRY) sample row keys=${Object.keys(sample).length}`);
      if (VERBOSE) console.log(`  ${JSON.stringify(sample, null, 2).slice(0, 600)}`);
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

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — FS Value-Adds Importer (prematch_signals)      ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  let files = [];
  if (FILE) {
    if (!existsSync(FILE)) { console.error(`File not found: ${FILE}`); process.exit(1); }
    files.push(FILE);
  } else {
    if (!existsSync(DIR)) { console.error(`Dir not found: ${DIR}`); process.exit(1); }
    files = readdirSync(DIR).filter(f => f.endsWith(".csv")).map(f => resolve(DIR, f)).sort();
  }
  console.log(`  Mode:   ${DRY ? "DRY-RUN" : (NO_SUPABASE ? "NO-SUPABASE" : "LIVE")}`);
  console.log(`  Files:  ${files.length}\n`);

  let total = 0, totalParsed = 0;
  const errors = [];
  for (const f of files) {
    const leagueKey = LEAGUE_OVERRIDE || inferLeagueFromFilename(basename(f));
    const season = inferSeasonFromFilename(basename(f));
    if (!leagueKey) {
      console.log(`\n⚠ Skipping ${basename(f)}: couldn't infer league — use --league X`);
      errors.push({ file: basename(f), error: "no league" });
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
  console.log(`  ✓ rows upserted:    ${total}${DRY || NO_SUPABASE ? " (dry/no-supabase)" : ""}`);
  console.log(`  ℹ rows parsed:      ${totalParsed}`);
  if (errors.length) {
    console.log(`\n  ✗ errors (${errors.length}):`);
    for (const e of errors) console.log(`    ${e.file}: ${e.error}`);
  }
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

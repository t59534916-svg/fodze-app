#!/usr/bin/env node
/**
 * FODZE — FootyStats CSV Importer (match-level → team_xg_history)
 *
 * ═══════════════════════════════════════════════════════════════════
 * STATUS: skeleton
 * FootyStats CSVs werden vom user auf https://footystats.org/download-stats-csv
 * heruntergeladen (1 Credit pro Liga-Saison-CSV). Dieses Skript konsumiert die
 * resultierenden Dateien und schreibt pro Match 2 Rows (home + away) in
 * `team_xg_history` mit source='footystats'.
 *
 * Erwartetes Input-Format (aus FootyStats' Match-CSVs):
 *   Spalten werden unten via COLUMN_ALIASES flexibel erkannt (FootyStats
 *   hat im Lauf der Jahre Namen variiert). Bei Fehler: neue CSV sehen,
 *   COLUMN_ALIASES erweitern.
 *
 * Kerndaten pro Match:
 *   date, home_team_name, away_team_name,
 *   home_team_goal_count, away_team_goal_count,
 *   home_team_xg, away_team_xg,                         (← primary value)
 *   home_team_shots, away_team_shots,
 *   home_team_shots_on_target, away_team_shots_on_target,
 *   home_team_possession, away_team_possession,
 *   home_team_fouls, away_team_fouls,
 *   home_team_corner_count, away_team_corner_count,
 *   home_team_yellow_cards, away_team_yellow_cards,
 *
 * Idempotent via UNIQUE(team, league, match_date, venue).
 *
 * Usage:
 *   node scripts/import-footystats-csv.mjs --file path/to/championship-2024-25.csv --league championship
 *   node scripts/import-footystats-csv.mjs --dir tools/footystats/csv  # batch alle CSVs im Ordner
 *   node scripts/import-footystats-csv.mjs --file X.csv --league epl --dry  # preview
 *
 * ENV (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";

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
const FILE = val("file", null);
const DIR = val("dir", null);
const LEAGUE_OVERRIDE = val("league", null);
// If user groups multiple files in a dir, the league can be derived from
// the filename (e.g. "championship-matches-2024-to-2025.csv") — see
// inferLeagueFromFilename below.

if (!FILE && !DIR) {
  console.error("Usage: --file <CSV> [--league X]  |  --dir <DIR>  [--dry]");
  process.exit(1);
}
if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt");
  process.exit(1);
}

// ─── Column-Alias Mapping ──────────────────────────────────────
//
// FootyStats hat im Lauf der Jahre Spaltennamen variiert. COLUMN_ALIASES
// mappt die Felder die wir brauchen auf mehrere mögliche Namen.
// Bei failure: `--verbose` zeigt unmapped cols, dann einfach neuen Alias
// hier ergänzen.
const COLUMN_ALIASES = {
  date: ["date_gmt", "date_GMT", "date", "Date", "kickoff"],
  home_team: ["home_team_name", "home_team", "Home", "HomeTeam"],
  away_team: ["away_team_name", "away_team", "Away", "AwayTeam"],
  home_goals: ["home_team_goal_count", "home_goals", "home_score", "FTHG"],
  away_goals: ["away_team_goal_count", "away_goals", "away_score", "FTAG"],
  home_xg: ["team_a_xg", "home_team_xg", "home_xg", "Home_xG"],
  away_xg: ["team_b_xg", "away_team_xg", "away_xg", "Away_xG"],
  home_shots: ["home_team_shots", "home_shots", "HS"],
  away_shots: ["away_team_shots", "away_shots", "AS"],
  home_sot: ["home_team_shots_on_target", "home_shots_on_target", "HST"],
  away_sot: ["away_team_shots_on_target", "away_shots_on_target", "AST"],
  home_poss: ["home_team_possession", "home_possession"],
  away_poss: ["away_team_possession", "away_possession"],
  home_corners: ["home_team_corner_count", "home_corners", "HC"],
  away_corners: ["away_team_corner_count", "away_corners", "AC"],
  home_fouls: ["home_team_fouls", "home_fouls", "HF"],
  away_fouls: ["away_team_fouls", "away_fouls", "AF"],
  home_yellow: ["home_team_yellow_cards", "home_yellow_cards"],
  away_yellow: ["away_team_yellow_cards", "away_yellow_cards"],
  home_red: ["home_team_red_cards", "home_red_cards"],
  away_red: ["away_team_red_cards", "away_red_cards"],
  referee: ["referee", "Referee"],
  status: ["status", "Status"],  // "complete" / "incomplete"
};

function findColumn(headerRow, aliases) {
  for (const a of aliases) {
    const i = headerRow.indexOf(a);
    if (i >= 0) return i;
    // case-insensitive fallback
    const ci = headerRow.findIndex(h => h.toLowerCase() === a.toLowerCase());
    if (ci >= 0) return ci;
  }
  return -1;
}

// ─── CSV parsing ──────────────────────────────────────────────
// Minimal CSV parser that handles quoted fields + commas-in-quotes.
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
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Unix ts (FootyStats sometimes uses date_GMT as seconds since epoch)
  const n = parseInt(s, 10);
  if (!isNaN(n) && n > 1_000_000_000 && n < 3_000_000_000 && !/\D/.test(s)) {
    return new Date(n * 1000).toISOString().slice(0, 10);
  }
  // DD/MM/YYYY or MM/DD/YYYY
  const mSlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mSlash) {
    const [_, a, b, y] = mSlash;
    const yyyy = y.length === 2 ? `20${y}` : y;
    // Prefer DMY (European); FootyStats uses this format per their docs
    return `${yyyy}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
  }
  // FootyStats format: "Aug 09 2024 - 7:00pm" — strip the " - HH:MMap"
  // suffix, then force UTC interpretation (else local TZ shifts the date).
  s = s.replace(/\s*-\s*\d{1,2}:\d{2}\s*(am|pm)?\s*$/i, "");
  const d = new Date(s + " UTC");
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Fallback ohne UTC-suffix
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
  return null;
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  // Strip % if present
  const cleaned = s.endsWith("%") ? s.slice(0, -1) : s;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}

// ─── Infer league from filename ───────────────────────────────
//
// FootyStats's canonical naming: "<country>-<league-slug>-matches-<y1>-to-<y2>-stats.csv"
// Wir matchen auf den country+league-prefix (vor "-matches-"). Nur
// FODZE-Ligen werden abgebildet; fremde Ligen wie Austria/NL-Eerste/
// Switzerland fallen durch und geben null zurück → das Skript skippt.
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
  "netherlands-eerste-divisie": "eerste_divisie",
};

function inferLeagueFromFilename(name) {
  const lower = name.toLowerCase();
  // Longest-prefix match first (so "england-efl-league-two" beats "england")
  const prefixes = Object.keys(FILENAME_PREFIX_TO_LEAGUE).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (lower.startsWith(p + "-matches-") || lower.startsWith(p + "-fixtures-")) {
      return FILENAME_PREFIX_TO_LEAGUE[p];
    }
  }
  return null;
}

// ─── Supabase upsert ──────────────────────────────────────────
async function supaUpsert(rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
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
async function processFile(filePath, leagueKey) {
  console.log(`\n━━━ ${basename(filePath)} ━━━`);
  const text = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.log(`  ⚠ Empty or header-only CSV`);
    return { file: filePath, rows_imported: 0 };
  }
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1);
  console.log(`  ${data.length} data rows · ${header.length} columns`);

  // Build column index map
  const ci = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    ci[key] = findColumn(header, aliases);
  }
  const missing = Object.entries(ci).filter(([, v]) => v < 0).map(([k]) => k);
  const present = Object.entries(ci).filter(([, v]) => v >= 0).map(([k]) => k);
  if (VERBOSE) {
    console.log(`  Mapped fields (${present.length}): ${present.join(", ")}`);
    if (missing.length) console.log(`  Missing (${missing.length}): ${missing.join(", ")}`);
  }
  // Mandatory: date, teams, goals — without these we can't key rows
  if (ci.date < 0 || ci.home_team < 0 || ci.away_team < 0) {
    console.log(`  ✗ CSV missing mandatory columns (date/teams) — cannot import`);
    console.log(`  Header: ${header.slice(0, 10).join(" | ")}...`);
    return { file: filePath, rows_imported: 0, error: "missing mandatory cols" };
  }

  const supaBatch = [];
  let skipped_incomplete = 0;
  let skipped_no_xg = 0;
  for (const r of data) {
    if (r.length < header.length) continue;
    // Skip matches without final score (future fixtures included in some FS CSVs).
    // CRITICAL: must be exact match — /complete/i.test("incomplete") was TRUE
    // (substring match) and let 1502 future xg=0 / goals=0-0 rows pollute the DB
    // 2026-04-25, leaking into MatchdayContext.loadCached's slice(-8) tail and
    // systematically under-predicting team strength → 14-29% spurious edges
    // → false TRAP storms in Tier-1 leagues. Always normalize + exact-compare.
    const status = ci.status >= 0 ? String(r[ci.status] || "").trim().toLowerCase() : "";
    if (status && status !== "complete") { skipped_incomplete++; continue; }

    const date = toIsoDate(r[ci.date]);
    const home = (r[ci.home_team] || "").trim();
    const away = (r[ci.away_team] || "").trim();
    if (!date || !home || !away) continue;

    const hg = ci.home_goals >= 0 ? toInt(r[ci.home_goals]) : null;
    const ag = ci.away_goals >= 0 ? toInt(r[ci.away_goals]) : null;
    if (hg == null || ag == null) { skipped_incomplete++; continue; }

    const hxg = ci.home_xg >= 0 ? toNum(r[ci.home_xg]) : null;
    const axg = ci.away_xg >= 0 ? toNum(r[ci.away_xg]) : null;
    if (hxg == null || axg == null) { skipped_no_xg++; }

    const hShots = ci.home_shots >= 0 ? toInt(r[ci.home_shots]) : null;
    const aShots = ci.away_shots >= 0 ? toInt(r[ci.away_shots]) : null;
    const hSot = ci.home_sot >= 0 ? toInt(r[ci.home_sot]) : null;
    const aSot = ci.away_sot >= 0 ? toInt(r[ci.away_sot]) : null;
    const hCorn = ci.home_corners >= 0 ? toInt(r[ci.home_corners]) : null;
    const aCorn = ci.away_corners >= 0 ? toInt(r[ci.away_corners]) : null;
    const hFoul = ci.home_fouls >= 0 ? toInt(r[ci.home_fouls]) : null;
    const aFoul = ci.away_fouls >= 0 ? toInt(r[ci.away_fouls]) : null;
    const hPoss = ci.home_poss >= 0 ? toNum(r[ci.home_poss]) : null;
    const aPoss = ci.away_poss >= 0 ? toNum(r[ci.away_poss]) : null;
    const hYel = ci.home_yellow >= 0 ? toInt(r[ci.home_yellow]) : null;
    const aYel = ci.away_yellow >= 0 ? toInt(r[ci.away_yellow]) : null;
    const hRed = ci.home_red >= 0 ? toInt(r[ci.home_red]) : null;
    const aRed = ci.away_red >= 0 ? toInt(r[ci.away_red]) : null;
    let ref = ci.referee >= 0 ? (r[ci.referee] || "").trim() : "";
    if (!ref || /^(n\/?a|unknown|null|-)$/i.test(ref)) ref = null;

    // Home perspective
    supaBatch.push({
      team: home, league: leagueKey, opponent: away, venue: "home",
      match_date: date,
      xg: hxg, xga: axg,
      goals_for: hg, goals_against: ag,
      shots_for: hShots, shots_against: aShots,
      shots_on_target_for: hSot, shots_on_target_against: aSot,
      corners_for: hCorn, corners_against: aCorn,
      fouls: hFoul, offsides: null, gk_saves: null,
      possession_pct: hPoss,
      passes_total: null, passes_accurate: null, pass_pct: null,
      shots_blocked: null, shots_inside_box: null, shots_outside_box: null,
      yellow_cards_for: hYel, yellow_cards_against: aYel,
      red_cards_for: hRed, red_cards_against: aRed,
      referee: ref,
      source: "footystats",
    });
    // Away perspective
    supaBatch.push({
      team: away, league: leagueKey, opponent: home, venue: "away",
      match_date: date,
      xg: axg, xga: hxg,
      goals_for: ag, goals_against: hg,
      shots_for: aShots, shots_against: hShots,
      shots_on_target_for: aSot, shots_on_target_against: hSot,
      corners_for: aCorn, corners_against: hCorn,
      fouls: aFoul, offsides: null, gk_saves: null,
      possession_pct: aPoss,
      passes_total: null, passes_accurate: null, pass_pct: null,
      shots_blocked: null, shots_inside_box: null, shots_outside_box: null,
      yellow_cards_for: aYel, yellow_cards_against: hYel,
      red_cards_for: aRed, red_cards_against: hRed,
      referee: ref,
      source: "footystats",
    });
  }

  console.log(`  parseable: ${supaBatch.length} rows (${supaBatch.length / 2} matches)`);
  if (skipped_incomplete) console.log(`  skipped_incomplete: ${skipped_incomplete}`);
  if (skipped_no_xg) console.log(`  rows_without_xg: ${skipped_no_xg}`);

  if (DRY) {
    if (supaBatch.length > 0) {
      console.log(`  (DRY) sample:\n${JSON.stringify(supaBatch[0], null, 2).slice(0, 400)}`);
    }
    return { file: filePath, rows_imported: 0, dry: true, parsed: supaBatch.length };
  }

  // Upsert in batches
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < supaBatch.length; i += BATCH) {
    try {
      written += await supaUpsert(supaBatch.slice(i, i + BATCH));
    } catch (e) {
      console.log(`  ✗ batch ${i}: ${e.message}`);
    }
  }
  console.log(`  ✓ upserted ${written} rows`);
  return { file: filePath, rows_imported: written };
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — FootyStats CSV Importer                         ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  let files = [];
  if (FILE) {
    if (!existsSync(FILE)) { console.error(`File not found: ${FILE}`); process.exit(1); }
    files.push(FILE);
  } else {
    if (!existsSync(DIR)) { console.error(`Dir not found: ${DIR}`); process.exit(1); }
    files = readdirSync(DIR).filter(f => f.endsWith(".csv")).map(f => resolve(DIR, f));
  }
  console.log(`  Mode:   ${DRY ? "DRY-RUN" : "LIVE"}`);
  console.log(`  Files:  ${files.length}\n`);

  const summary = [];
  for (const f of files) {
    const leagueKey = LEAGUE_OVERRIDE || inferLeagueFromFilename(basename(f));
    if (!leagueKey) {
      console.log(`\n⚠ Skipping ${basename(f)}: couldn't infer league — use --league X`);
      summary.push({ file: f, rows_imported: 0, error: "no league" });
      continue;
    }
    console.log(`  ${basename(f)} → league: ${leagueKey}`);
    const res = await processFile(f, leagueKey);
    summary.push(res);
  }

  console.log(`\n━━━ Summary ━━━`);
  let total = 0;
  for (const s of summary) {
    total += s.rows_imported || 0;
    const marker = s.error ? "✗" : s.dry ? "~" : "✓";
    console.log(`  ${marker} ${basename(s.file)}: ${s.rows_imported} rows${s.error ? " — " + s.error : ""}${s.dry ? " (DRY)" : ""}`);
  }
  console.log(`  Total:  ${total} rows upserted${DRY ? " (DRY)" : ""}`);
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

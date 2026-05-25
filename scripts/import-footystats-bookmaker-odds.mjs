#!/usr/bin/env node
/**
 * FODZE — FootyStats CSV Bookmaker Odds — populates the bookmaker_odds_*
 * columns on match_prematch_signals (added 2026-05-25 migration).
 *
 * RUNS OVER existing 110 CSVs and PATCHES the existing rows with the
 * 9 odds fields (1X2 + Over 15/25/35/45 + BTTS yes/no).
 *
 * Doesn't touch any other fields. Uses UPSERT but only the new columns
 * will be updated (rest are NULL in our payload so PostgREST merge
 * preserves existing values).
 *
 * Why this is separate from import-footystats-valueadds.mjs:
 *   The original import (commit 0e8e76c) didn't capture odds intentionally
 *   because FS isn't Pinnacle-sourced. After bet-edge-policy revalidation
 *   (2026-05-25) we realized: for Goals/BTTS falsification testing, ANY
 *   market baseline is better than none. fd.co.uk doesn't ship historical
 *   Pinnacle O/U at all; the-odds-api historical costs money; the FS odds
 *   are at least market-implied. Use as PROXY baseline + document caveat.
 *
 * Usage:
 *   node scripts/import-footystats-bookmaker-odds.mjs --dir tools/footystats/csv
 *   node scripts/import-footystats-bookmaker-odds.mjs --dry
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
const FILE = val("file", null);
const DIR = val("dir", "tools/footystats/csv");

if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt");
  process.exit(1);
}

const COLS = {
  date:             ["date_GMT", "date_gmt", "date"],
  home_team:        ["home_team_name"],
  away_team:        ["away_team_name"],
  status:           ["status"],
  odds_home:        ["odds_ft_home_team_win"],
  odds_draw:        ["odds_ft_draw"],
  odds_away:        ["odds_ft_away_team_win"],
  odds_over15:      ["odds_ft_over15"],
  odds_over25:      ["odds_ft_over25"],
  odds_over35:      ["odds_ft_over35"],
  odds_over45:      ["odds_ft_over45"],
  odds_btts_yes:    ["odds_btts_yes"],
  odds_btts_no:     ["odds_btts_no"],
};

function parseCSV(text) {
  const rows = [];
  let f = "", row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') inQ = false;
      else f += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (f || row.length) { row.push(f); rows.push(row); }
        f = ""; row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
      } else f += ch;
    }
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function findCol(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
    const ci = header.findIndex(h => h.toLowerCase() === n.toLowerCase());
    if (ci >= 0) return ci;
  }
  return -1;
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === "N/A" || s === "0") return null;  // 0 odds = missing
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 1.0 ? n : null;  // odds must be > 1.0
}

function toIsoDate(raw) {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!isNaN(n) && n > 1_000_000_000 && n < 3_000_000_000) {
    return new Date(n * 1000).toISOString().slice(0, 10);
  }
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  s = s.replace(/\s*-\s*\d{1,2}:\d{2}\s*(am|pm)?\s*$/i, "");
  const d = new Date(s + " UTC");
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const FILENAME_PREFIX_TO_LEAGUE = {
  "england-premier-league": "epl", "england-championship": "championship",
  "england-efl-league-one": "league_one", "england-efl-league-two": "league_two",
  "germany-bundesliga": "bundesliga", "germany-2-bundesliga": "bundesliga2",
  "germany-3-liga": "liga3", "spain-la-liga": "la_liga", "spain-segunda-division": "la_liga2",
  "italy-serie-a": "serie_a", "italy-serie-b": "serie_b",
  "france-ligue-1": "ligue_1", "france-ligue-2": "ligue_2",
  "netherlands-eredivisie": "eredivisie", "netherlands-eerste-divisie": "eerste_divisie",
  "portugal-liga-nos": "primeira_liga", "portugal-primeira-liga": "primeira_liga",
  "belgium-pro-league": "jupiler_pro", "belgium-jupiler-pro-league": "jupiler_pro",
  "turkey-super-lig": "super_lig", "scotland-premiership": "scottish_prem",
  "scotland-scottish-premiership": "scottish_prem",
  "greece-super-league": "greek_sl", "greece-super-league-1": "greek_sl",
  "austria-bundesliga": "austria_bl", "switzerland-super-league": "swiss_sl",
};

function inferLeague(name) {
  const lower = name.toLowerCase();
  for (const p of Object.keys(FILENAME_PREFIX_TO_LEAGUE).sort((a,b)=>b.length-a.length)) {
    if (lower.startsWith(p + "-matches-")) return FILENAME_PREFIX_TO_LEAGUE[p];
  }
  return null;
}

async function supaUpsert(rows) {
  if (rows.length === 0 || DRY) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/match_prematch_signals?on_conflict=league,match_date,home_team,away_team`,
    { method: "POST", headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      }, body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return rows.length;
}

async function processFile(filePath, leagueKey) {
  const text = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  const rows = parseCSV(text);
  if (rows.length < 2) return { rows: 0 };
  const header = rows[0].map(h => h.trim());
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = findCol(header, names);
  if (idx.date < 0 || idx.home_team < 0 || idx.away_team < 0) return { rows: 0, err: "no mandatory cols" };
  if (idx.odds_home < 0 && idx.odds_over25 < 0 && idx.odds_btts_yes < 0) {
    return { rows: 0, err: "no odds cols (CSV has no odds — skip)" };
  }

  const batch = [];
  for (const r of rows.slice(1)) {
    if (r.length < header.length) continue;
    const status = idx.status >= 0 ? String(r[idx.status] || "").trim().toLowerCase() : "";
    if (status && status !== "complete") continue;
    const date = toIsoDate(r[idx.date]);
    let home = (r[idx.home_team] || "").trim();
    let away = (r[idx.away_team] || "").trim();
    if (!date || !home || !away) continue;
    home = canonicalize(home, leagueKey);
    away = canonicalize(away, leagueKey);
    const matchKey = `${leagueKey}:${home.toLowerCase().replace(/\s/g, "")}-${away.toLowerCase().replace(/\s/g, "")}`;
    batch.push({
      match_key: matchKey,
      league: leagueKey, match_date: date, home_team: home, away_team: away,
      bookmaker_odds_home:     idx.odds_home    >= 0 ? toNum(r[idx.odds_home])    : null,
      bookmaker_odds_draw:     idx.odds_draw    >= 0 ? toNum(r[idx.odds_draw])    : null,
      bookmaker_odds_away:     idx.odds_away    >= 0 ? toNum(r[idx.odds_away])    : null,
      bookmaker_odds_over15:   idx.odds_over15  >= 0 ? toNum(r[idx.odds_over15])  : null,
      bookmaker_odds_over25:   idx.odds_over25  >= 0 ? toNum(r[idx.odds_over25])  : null,
      bookmaker_odds_over35:   idx.odds_over35  >= 0 ? toNum(r[idx.odds_over35])  : null,
      bookmaker_odds_over45:   idx.odds_over45  >= 0 ? toNum(r[idx.odds_over45])  : null,
      bookmaker_odds_btts_yes: idx.odds_btts_yes >= 0 ? toNum(r[idx.odds_btts_yes]) : null,
      bookmaker_odds_btts_no:  idx.odds_btts_no >= 0 ? toNum(r[idx.odds_btts_no]) : null,
      bookmaker_source: "footystats-csv",
    });
  }

  if (DRY) {
    if (batch.length > 0) {
      const sample = batch.find(r => r.bookmaker_odds_over25 != null) || batch[0];
      console.log(`  (DRY) ${basename(filePath)} → ${batch.length} rows, sample:`);
      console.log(`    home/draw/away: ${sample.bookmaker_odds_home}/${sample.bookmaker_odds_draw}/${sample.bookmaker_odds_away}`);
      console.log(`    o25/u-implied: ${sample.bookmaker_odds_over25}`);
      console.log(`    btts yes/no:   ${sample.bookmaker_odds_btts_yes}/${sample.bookmaker_odds_btts_no}`);
    }
    return { rows: 0, parsed: batch.length };
  }

  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < batch.length; i += BATCH) {
    try { written += await supaUpsert(batch.slice(i, i + BATCH)); }
    catch (e) { console.log(`  ✗ batch ${i}: ${e.message}`); }
  }
  return { rows: written };
}

async function main() {
  console.log(`\nFootyStats Bookmaker Odds — populate match_prematch_signals\n`);
  if (!existsSync(DIR)) { console.error(`Dir not found: ${DIR}`); process.exit(1); }
  const files = readdirSync(DIR).filter(f => f.includes("-matches-") && f.endsWith(".csv"))
    .map(f => resolve(DIR, f)).sort();
  console.log(`  Files:  ${files.length}  Mode: ${DRY ? "DRY" : "LIVE"}`);

  let total = 0, totalParsed = 0;
  const errs = [];
  for (const f of files) {
    const lg = inferLeague(basename(f));
    if (!lg) { errs.push({f: basename(f), err: "no league"}); continue; }
    try {
      const res = await processFile(f, lg);
      total += res.rows || 0;
      totalParsed += res.parsed || 0;
      if (res.err) errs.push({f: basename(f), err: res.err});
      else process.stdout.write(`  ✓ ${basename(f)} → ${res.rows || res.parsed} rows\n`);
    } catch (e) {
      errs.push({f: basename(f), err: e.message});
    }
  }
  console.log(`\n━ Summary ━`);
  console.log(`  Files: ${files.length - errs.length}/${files.length}`);
  console.log(`  Rows upserted: ${total}${DRY ? " (dry)" : ""}`);
  if (errs.length) {
    console.log(`  Errors (${errs.length}):`);
    for (const e of errs.slice(0, 5)) console.log(`    ${e.f}: ${e.err}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

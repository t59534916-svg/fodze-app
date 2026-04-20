#!/usr/bin/env node
/**
 * FODZE Player-xG Backfill (Phase 2.3)
 * ════════════════════════════════════
 *
 * STATUS: Phase-2.3 needs a manual data-prep step.
 *
 * The worldfootballR_data GitHub repo ships player-level stats as `.rds`
 * (R's native binary format) in `data/fb_big5_advanced_season_stats/`.
 * Node.js can't parse .rds directly. Two workflows work:
 *
 * Workflow A — Local CSV conversion via R (one-shot per season):
 *   1. Install R locally. In an R console:
 *        install.packages("worldfootballR")   # first time only
 *        library(worldfootballR)
 *        # IMPORTANT: use load_*, NOT fb_*. The `fb_*` variant live-scrapes
 *        # FBref which is now Cloudflare-blocked (HTTP 403). `load_*` reads
 *        # pre-scraped .rds files from the worldfootballR_data repo.
 *        data <- load_fb_big5_advanced_season_stats(
 *          season_end_year = 2025,   # 2024/25 season
 *          stat_type       = "standard",
 *          team_or_player  = "player"
 *        )
 *        write.csv(data, "player_standard_2425.csv", row.names = FALSE)
 *   2. Copy the CSV into the repo: `Historie/data-2526/player_standard_2425.csv`
 *   3. Run this script in --csv-dir mode:
 *        node scripts/backfill-player-xg.mjs --csv-dir Historie/data-2526
 *
 * Workflow B — Direct .rds download + Python conversion:
 *   1. `pip install pyreadr pandas` in tools/venv
 *   2. `python3 tools/rds_to_csv.py`  (helper, not yet committed — ask if needed)
 *   3. Same --csv-dir run as Workflow A.
 *
 * Coverage: Big-5 only (bundesliga / epl / la_liga / serie_a / ligue_1).
 * Liga 2 / Championship / League One/Two / etc. are NOT covered by the
 * worldfootballR_data repo. For those we'd need an alternative source
 * (Understat per-player aggregation, direct FBref scrape, API-Football).
 *
 * Flags:
 *   --league <code>   FODZE league key (required unless --all)
 *   --season <s>      Short-code season ("2526" for 2025/26)
 *   --all             Iterate all supported leagues
 *   --dry             Parse + preview; no DB write
 *   --csv-dir <path>  REQUIRED until rds-convert is automated.
 *                     Reads `{league_slug}_{season}_player_standard.csv`
 *                     from this folder. If omitted, script exits with
 *                     instructions.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCsv } from "./_lib/football-data-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader ────────────────────────────────────────────────────
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

// ─── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argv = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const DRY = args.includes("--dry");
const ALL = args.includes("--all");
const LEAGUE = argv("--league");
const SEASON = argv("--season") || currentSeason();
const CSV_DIR = argv("--csv-dir");

function currentSeason() {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? y : y - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

function fbrefSeason(shortSeason) {
  if (shortSeason.length !== 4) return shortSeason;
  return `20${shortSeason.slice(0, 2)}-20${shortSeason.slice(2, 4)}`;
}

// ─── League → worldfootballR_data slug ─────────────────────────────
// Only leagues with FBref advanced-stats coverage. Liga 3, League One/Two
// lack per-player xG on FBref entirely — skipped here like elsewhere.
const LEAGUE_SLUG = {
  bundesliga:    "Bundesliga",
  bundesliga2:   "2.-Bundesliga",
  epl:           "Premier-League",
  championship:  "Championship",
  la_liga:       "La-Liga",
  la_liga2:      "Segunda-Division",
  serie_a:       "Serie-A",
  serie_b:       "Serie-B",
  ligue_1:       "Ligue-1",
  ligue_2:       "Ligue-2",
  eredivisie:    "Eredivisie",
  primeira_liga: "Primeira-Liga",
  jupiler_pro:   "Belgian-Pro-League",
  super_lig:     "Super-Lig",
  greek_sl:      "Super-League-Greece",
  scottish_prem: "Scottish-Premiership",
};

// ─── FBref position → FODZE bucket ────────────────────────────────
// FBref positions are things like "FW", "MF,DF", "GK" — we take the first
// listed as the primary bucket.
function normalizePosition(raw) {
  if (!raw) return "MID";
  const first = String(raw).split(",")[0].trim().toUpperCase();
  if (first === "GK") return "GK";
  if (first === "DF" || first === "DEF") return "DEF";
  if (first === "MF" || first === "MID") return "MID";
  if (first === "FW" || first === "FWD") return "FWD";
  return "MID";
}

// ─── Fetch + parse ────────────────────────────────────────────────
async function fetchPlayerCsv(league, season) {
  const slug = LEAGUE_SLUG[league];
  if (!slug) throw new Error(`Unsupported league: ${league}`);

  // Prefer local CSV if --csv-dir was passed. Expected filename convention:
  //   {slug}_{season}_player_standard.csv    OR
  //   player_standard_{season}.csv           (Workflow A from the header doc)
  if (CSV_DIR) {
    const candidates = [
      resolve(CSV_DIR, `${slug}_${season}_player_standard.csv`),
      resolve(CSV_DIR, `player_standard_${season}.csv`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    }
    throw new Error(`No CSV found in ${CSV_DIR}. Looked for:\n  ${candidates.join("\n  ")}`);
  }

  // Direct-fetch mode — currently broken because worldfootballR_data ships
  // player stats as .rds (R binary), not .csv. The URL below is where the
  // RDS lives; we emit a helpful error instead of a 404 so the user knows
  // to use Workflow A / B from the file header.
  const rdsUrl = `https://raw.githubusercontent.com/JaseZiv/worldfootballR_data/master/data/fb_big5_advanced_season_stats/big5_player_standard.rds`;
  throw new Error(
    `player-xg: direct download not supported — worldfootballR_data ships ` +
    `.rds (R binary) at ${rdsUrl}. See this file's header for the R or ` +
    `pyreadr workflow, then re-run with --csv-dir <path>.`
  );
}

// worldfootballR's `Comp` column value → FODZE league code
// The Big-5 CSV ships all five leagues in one file with a `Comp` column
// for routing. Non-Big-5 leagues (championship, la_liga2, ...) are simply
// absent from the file, so we'll emit 0 rows for them — that's correct.
const COMP_TO_FODZE = {
  "Bundesliga":     "bundesliga",
  "Premier League": "epl",
  "La Liga":        "la_liga",
  "Serie A":        "serie_a",
  "Ligue 1":        "ligue_1",
};

function transformRows(csvRows, league, season) {
  const out = [];
  let skipped = 0;
  const targetComp = Object.entries(COMP_TO_FODZE).find(([, v]) => v === league)?.[0];
  // Non-Big-5 leagues (championship, la_liga2, serie_b, ligue_2, liga3,
  // eredivisie, jupiler_pro, super_lig, greek_sl, scottish_prem,
  // primeira_liga, bundesliga2) aren't in the Big-5 player_standard CSV.
  // Skip them entirely — otherwise an undefined targetComp lets every
  // Big-5 row through and pollutes the table with 2500× wrong-league rows.
  if (!targetComp) return { rows: [], skipped: csvRows.length };
  for (const r of csvRows) {
    // Big-5 CSV ships all leagues in one file. Filter by `Comp` column
    // so each invocation only emits the FODZE-relevant rows.
    if (r.Comp && r.Comp !== targetComp) continue;

    // worldfootballR column names — verified from the exported CSV header:
    //   Season_End_Year, Squad, Comp, Player, Nation, Pos, Age, Born,
    //   MP_Playing, Starts_Playing, Min_Playing, Mins_Per_90_Playing,
    //   Gls, Ast, G+A, G_minus_PK, PK, PKatt, CrdY, CrdR,
    //   PrgC_Progression, PrgP_Progression, PrgR_Progression,
    //   Gls_Per, Ast_Per, ...
    //   xG_Expected, npxG_Expected, xAG_Expected, npxG+xAG_Expected,
    //   xG_Per, xAG_Per, xG+xAG_Per, npxG_Per, npxG+xAG_Per, Url
    const player = (r.Player || "").trim();
    const team = (r.Squad || "").trim();
    if (!player || !team) { skipped++; continue; }
    const minutes = parseInt(r.Min_Playing || r.Min || "", 10);
    if (!Number.isFinite(minutes) || minutes < 90) { skipped++; continue; }
    const xg = parseFloat(r.xG_Expected || r.xG || "");
    if (!Number.isFinite(xg)) { skipped++; continue; }
    const xa = parseFloat(r.xAG_Expected || r.xAG || "0");
    const npxg = parseFloat(r.npxG_Expected || r.npxG || "0");
    // Shots + key passes aren't in the `standard` stat_type CSV — they're
    // in `shooting` and `passing` respectively. Leaving 0 until/unless
    // we add shooting.csv to the R exporter.
    const per90 = 90 / minutes;
    out.push({
      player_name: player,
      team,
      league,
      season,
      position: normalizePosition(r.Pos),
      minutes_played: minutes,
      xg_per_90: +(xg * per90).toFixed(3),
      xa_per_90: +(xa * per90).toFixed(3),
      npxg_per_90: +(npxg * per90).toFixed(3),
      shots_per_90: 0,
      key_passes_per_90: 0,
      source: "fbref-worldfootballR",
    });
  }
  return { rows: out, skipped };
}

// ─── Upsert ────────────────────────────────────────────────────────
async function upsertBatch(rows) {
  const BATCH = 500;
  let ok = 0;
  // PostgREST requires on_conflict on multi-column unique indexes.
  const url = `${SUPA_URL}/rest/v1/player_xg_history?on_conflict=player_name,team,league,season`;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const resp = await fetch(url, {
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
  if (!LEAGUE_SLUG[league]) {
    return { league, ok: 0, status: "unsupported" };
  }
  console.log(`[player-xg] ${league} ${season}`);
  let csv;
  try {
    csv = await fetchPlayerCsv(league, season);
  } catch (e) {
    console.warn(`[player-xg]   → fetch failed: ${e.message}`);
    return { league, ok: 0, status: "fetch-failed" };
  }
  const { rows } = parseCsv(csv);
  if (rows.length === 0) {
    console.warn(`[player-xg]   → empty CSV`);
    return { league, ok: 0, status: "empty" };
  }
  const { rows: built, skipped } = transformRows(rows, league, season);
  console.log(`[player-xg]   → ${built.length} players (${skipped} skipped sub-90min / malformed)`);

  if (DRY) {
    if (built.length > 0) {
      const s = built[0];
      console.log(`[player-xg]   sample: ${s.player_name} (${s.team}, ${s.position}) xG90=${s.xg_per_90} minutes=${s.minutes_played}`);
    }
    return { league, ok: built.length, status: "dry" };
  }
  if (!SUPA_URL || !SUPA_KEY) {
    console.error(`[player-xg]   → Supabase creds missing`);
    process.exit(1);
  }
  const ok = await upsertBatch(built);
  console.log(`[player-xg]   ✓ upserted ${ok} rows`);
  return { league, ok, status: "ok" };
}

async function main() {
  if (!LEAGUE && !ALL) {
    console.error("Either --league <code> or --all required");
    process.exit(1);
  }
  const leagues = ALL ? Object.keys(LEAGUE_SLUG) : [LEAGUE];
  const results = [];
  for (const lg of leagues) results.push(await runOne(lg, SEASON));
  console.log();
  const tot = results.reduce((s, r) => s + r.ok, 0);
  console.log(`[player-xg] DONE — ${tot} rows across ${results.length} leagues`);
  for (const r of results) {
    console.log(`     ${r.league.padEnd(14)} ${String(r.ok).padStart(5)} rows  [${r.status}]`);
  }
}

main().catch(e => {
  console.error("[player-xg] unhandled:", e);
  process.exit(1);
});

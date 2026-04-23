#!/usr/bin/env node
/**
 * FODZE — FBref match-stats scraper
 *
 * ⚠ STATUS 2026-04-24: **NICHT LIVE-OPERATIV**
 *   FBref ist hinter Cloudflare JavaScript-Challenge — reiner node-fetch
 *   liefert 403 egal welche Header. Code bleibt als Parsing-Gerüst im
 *   Repo; aktivieren würde einen headless-Browser (Playwright) oder
 *   einen Scraper-Proxy-Service ($29+/mo) erfordern. Im jetzigen Zustand
 *   dokumentiert das Skript nur, WAS wir scrapen würden.
 *
 *   Für aktuelle xG-Daten: nutze api-sports (Saisons 2022-2024 Free-Tier)
 *   oder FootyStats (1 Monat $29 einmalig für current + historical).
 *
 * Iterates a league's season schedule on fbref.com, fetches each match
 * report, parses xG / shots / possession / passes / corners / fouls /
 * offsides / GK-saves, upserts into team_xg_history with source="fbref".
 *
 * Idempotent via UNIQUE(team, league, match_date, venue).
 *
 * Usage:
 *   node scripts/fetch-fbref-stats.mjs --league championship --season 2023-2024
 *   node scripts/fetch-fbref-stats.mjs --league championship --season 2024-2025 --limit 10 --dry
 *   node scripts/fetch-fbref-stats.mjs --league championship --season 2024-2025 --from 2024-09-01
 *
 * ENV (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   FBREF_USER_AGENT (optional override)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createFbrefClient,
  buildScheduleUrl,
  parseScheduleForMatchReports,
  parseMatchReport,
  FBREF_COMP_IDS,
} from "./_lib/fbref.mjs";

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
const LEAGUE = val("league", null);
const SEASON = val("season", null);        // e.g. "2023-2024"
const LIMIT = parseInt(val("limit", "999"), 10);
const FROM = val("from", null);            // ISO date — only matches on/after
const TO = val("to", null);                // ISO date — only matches on/before

if (!LEAGUE || !SEASON) {
  console.error("Usage: --league <key> --season YYYY-YYYY  [--limit N] [--from ISO] [--to ISO] [--dry]");
  console.error(`Leagues: ${Object.keys(FBREF_COMP_IDS).join(", ")}`);
  process.exit(1);
}
if (!/^\d{4}-\d{4}$/.test(SEASON)) {
  console.error("Season format must be YYYY-YYYY, e.g. 2023-2024");
  process.exit(1);
}
if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt");
  process.exit(1);
}

// ─── Supabase helpers ──────────────────────────────────────────
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

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — FBref Scraper (polite, 10 r/m)                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  League:   ${LEAGUE}`);
  console.log(`  Season:   ${SEASON}`);
  console.log(`  Window:   ${FROM || "season start"} → ${TO || "season end"}`);
  console.log(`  Limit:    ${LIMIT === 999 ? "unlimited" : LIMIT}`);
  console.log(`  Mode:     ${DRY ? "DRY-RUN" : "LIVE"}\n`);

  const client = createFbrefClient({ verbose: VERBOSE });

  // 1. Fetch schedule page → list of match-report URLs
  const schedUrl = buildScheduleUrl(LEAGUE, SEASON);
  if (!schedUrl) {
    console.error(`Unknown league ${LEAGUE}`); process.exit(1);
  }
  console.log(`Fetching schedule: ${schedUrl}`);
  const schedRes = await client.get(schedUrl);
  if (!schedRes.ok) {
    console.error(`Schedule fetch failed: ${schedRes.error}`);
    process.exit(1);
  }
  const matchUrls = parseScheduleForMatchReports(schedRes.html);
  console.log(`Found ${matchUrls.length} match-report URLs\n`);
  if (matchUrls.length === 0) {
    console.error(`Schedule parsed but 0 match-reports — HTML might have changed.`);
    return;
  }

  // 2. Fetch each match, parse, upsert
  const supaBatch = [];
  let scraped = 0;
  let skippedByDate = 0;
  let parseFailures = 0;

  for (const matchPath of matchUrls) {
    if (scraped >= LIMIT) { console.log(`\nLimit ${LIMIT} reached`); break; }

    const mRes = await client.get(matchPath);
    if (!mRes.ok) {
      console.log(`  ! ${matchPath}: ${mRes.error}`);
      parseFailures++;
      continue;
    }
    const parsed = parseMatchReport(mRes.html);
    if (!parsed.matchDate || !parsed.home.name || !parsed.away.name) {
      parseFailures++;
      if (VERBOSE) console.log(`  ? ${matchPath}: parse incomplete`);
      continue;
    }

    // Date filter
    if (FROM && parsed.matchDate < FROM) { skippedByDate++; continue; }
    if (TO && parsed.matchDate > TO) { skippedByDate++; continue; }

    scraped++;
    const date = parsed.matchDate;
    // Home row
    supaBatch.push({
      team: parsed.home.name, league: LEAGUE, opponent: parsed.away.name,
      venue: "home", match_date: date,
      xg: parsed.home.xg ?? null, xga: parsed.away.xg ?? null,
      goals_for: parsed.home.goals ?? null,
      goals_against: parsed.away.goals ?? null,
      corners_for: parsed.home.corners ?? null,
      corners_against: parsed.away.corners ?? null,
      shots_for: parsed.home.shots_for ?? null,
      shots_against: parsed.away.shots_for ?? null,
      shots_on_target_for: parsed.home.shots_on_target_for ?? null,
      shots_on_target_against: parsed.away.shots_on_target_for ?? null,
      possession_pct: parsed.home.possession_pct ?? null,
      passes_total: parsed.home.passes_total ?? null,
      passes_accurate: parsed.home.passes_accurate ?? null,
      pass_pct: parsed.home.pass_pct ?? null,
      fouls: parsed.home.fouls ?? null,
      offsides: parsed.home.offsides ?? null,
      gk_saves: parsed.home.gk_saves ?? null,
      source: "fbref",
    });
    // Away row — mirror
    supaBatch.push({
      team: parsed.away.name, league: LEAGUE, opponent: parsed.home.name,
      venue: "away", match_date: date,
      xg: parsed.away.xg ?? null, xga: parsed.home.xg ?? null,
      goals_for: parsed.away.goals ?? null,
      goals_against: parsed.home.goals ?? null,
      corners_for: parsed.away.corners ?? null,
      corners_against: parsed.home.corners ?? null,
      shots_for: parsed.away.shots_for ?? null,
      shots_against: parsed.home.shots_for ?? null,
      shots_on_target_for: parsed.away.shots_on_target_for ?? null,
      shots_on_target_against: parsed.home.shots_on_target_for ?? null,
      possession_pct: parsed.away.possession_pct ?? null,
      passes_total: parsed.away.passes_total ?? null,
      passes_accurate: parsed.away.passes_accurate ?? null,
      pass_pct: parsed.away.pass_pct ?? null,
      fouls: parsed.away.fouls ?? null,
      offsides: parsed.away.offsides ?? null,
      gk_saves: parsed.away.gk_saves ?? null,
      source: "fbref",
    });

    // Periodic incremental flush so a crash doesn't lose 50 pages of work
    if (!DRY && supaBatch.length >= 40) {
      try {
        const n = await supaUpsert(supaBatch);
        console.log(`  ✓ flushed ${n} rows`);
        supaBatch.length = 0;
      } catch (e) {
        console.log(`  ✗ upsert failed: ${e.message}`);
      }
    }
  }

  // Final flush
  if (!DRY && supaBatch.length > 0) {
    try {
      const n = await supaUpsert(supaBatch);
      console.log(`  ✓ flushed ${n} rows (final)`);
    } catch (e) {
      console.log(`  ✗ final upsert failed: ${e.message}`);
    }
  } else if (DRY && supaBatch.length > 0) {
    console.log(`\n(DRY) würde ${supaBatch.length} rows upserten`);
    console.log("Sample (first home row):\n", JSON.stringify(supaBatch[0], null, 2));
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Done                                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  HTTP requests:   ${client.state.requestsDone}`);
  console.log(`  Matches scraped: ${scraped}`);
  console.log(`  Skipped by date: ${skippedByDate}`);
  console.log(`  Parse failures:  ${parseFailures}`);
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

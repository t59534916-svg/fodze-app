#!/usr/bin/env node
/**
 * FODZE — api-sports Injuries Fetcher
 *
 * Pulls current-season injuries from api-sports and upserts into the
 * `player_injuries` Supabase table. Designed to REPLACE the fragile
 * Transfermarkt-scrape + Groq pipeline for new injuries going forward.
 *
 * Free-Tier-Erlaubnis (verifiziert 2026-04-24):
 *   ?league=X&date=YYYY-MM-DD  →  funktioniert für heute + ~2 Tage
 *   ?league=X&season=YYYY      →  nur Saisons 2022-2024 (historisch)
 *
 * Strategy: Loop über `--days N` (default 3) ab heute forward, call
 * injuries per (league, date). Jede Liga × Tag = 1 call.
 *
 * Budget für alle 19 Ligen × 3 Tage = 57 Calls (comfortably im 100/Tag
 * free-tier). Idempotent über UNIQUE(player_id_apisports, fixture_id_apisports).
 *
 * Vorteile vs Transfermarkt-Scrape:
 *   - Clean JSON statt HTML-Chaos + Groq-Normalisation (~350K Tokens/Tag gespart)
 *   - Strukturierte injury_type ("Missing Fixture" / "Suspended" / "Questionable")
 *   - Stabile player_id für cross-matchday tracking
 *   - Photo-URLs für UI-Enhancements
 *
 * Usage:
 *   node scripts/fetch-api-sports-injuries.mjs --league bundesliga
 *   node scripts/fetch-api-sports-injuries.mjs --all --days 3
 *   node scripts/fetch-api-sports-injuries.mjs --all --dry
 *
 * ENV (.env.local):
 *   API_SPORTS_KEY  (oder RAPIDAPI_KEY)
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createApiSportsClient,
  resolveApiSportsLeagueId,
  API_SPORTS_LEAGUE_IDS,
} from "./_lib/api-sports.mjs";

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

// ─── CLI ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : f; };

const DRY = flag("dry");
const ALL = flag("all");
const VERBOSE = flag("verbose");
const LEAGUE = val("league", null);
const DAYS = parseInt(val("days", "3"), 10);
const BUDGET = parseInt(val("budget", "80"), 10);

// ─── Target leagues ─────────────────────────────────────────────
const ALL_LEAGUES = Object.keys(API_SPORTS_LEAGUE_IDS);
let targetLeagues;
if (LEAGUE) targetLeagues = [LEAGUE];
else if (ALL) targetLeagues = ALL_LEAGUES;
else { console.error("Usage: --league <key>  |  --all  [--days N]"); process.exit(1); }

if (!process.env.API_SPORTS_KEY && !process.env.RAPIDAPI_KEY) {
  console.error("❌ API_SPORTS_KEY (oder RAPIDAPI_KEY) fehlt"); process.exit(1);
}
if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE env fehlt"); process.exit(1);
}

// ─── Supabase helpers ──────────────────────────────────────────
async function supaUpsert(rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/player_injuries?on_conflict=player_id_apisports,fixture_id_apisports`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
    },
  );
  if (!res.ok) throw new Error(`upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return rows.length;
}

// ─── Date helpers ──────────────────────────────────────────────
function isoDate(d) { return d.toISOString().slice(0, 10); }
function nextDays(n) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() + i * 86400_000);
    out.push(isoDate(d));
  }
  return out;
}

// ─── Injury mapping ────────────────────────────────────────────
//
// api-sports /injuries response:
//   [{ player: {id, name, photo, type, reason}, team: {id, name, logo},
//      fixture: {id, date, timestamp}, league: {id, season, name, ...} }]
//
// player.type values seen: "Missing Fixture", "Suspended", "Questionable"
// player.reason free-form: "Knee Injury", "Red Card Suspension", ...
function mapInjury(fodzeLeague, row) {
  const playerId = row?.player?.id;
  const fixtureId = row?.fixture?.id;
  if (!playerId || !fixtureId) return null;
  return {
    league: fodzeLeague,
    team_name: row?.team?.name ?? null,
    team_id_apisports: row?.team?.id ?? null,
    player_name: row?.player?.name ?? null,
    player_id_apisports: playerId,
    player_photo_url: row?.player?.photo ?? null,
    injury_type: row?.player?.type ?? null,
    reason: row?.player?.reason ?? null,
    fixture_id_apisports: fixtureId,
    fixture_date: row?.fixture?.date ? row.fixture.date.slice(0, 10) : null,
    source: "api-sports",
  };
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — api-sports Injuries Fetcher                     ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Leagues:  ${targetLeagues.join(", ")}`);
  console.log(`  Days:     next ${DAYS}`);
  console.log(`  Budget:   ${BUDGET}`);
  console.log(`  Mode:     ${DRY ? "DRY-RUN" : "LIVE"}\n`);

  const client = createApiSportsClient({ verbose: VERBOSE });
  const dates = nextDays(DAYS);

  let totalCalls = 0;
  let totalInjuries = 0;
  let totalUpserted = 0;
  let quotaExhausted = false;

  for (const fodzeLeague of targetLeagues) {
    if (quotaExhausted) break;
    const leagueId = resolveApiSportsLeagueId(fodzeLeague);
    if (!leagueId) {
      console.log(`${fodzeLeague}: no api-sports id mapped — skip`);
      continue;
    }
    console.log(`\n━━━ ${fodzeLeague} (api-sports id=${leagueId}) ━━━`);

    const leagueBatch = [];
    for (const date of dates) {
      if (client.state.requestsDone >= BUDGET) {
        console.log(`  ⓘ Budget ${BUDGET} erreicht`);
        quotaExhausted = true; break;
      }
      const res = await client.request("/injuries", {
        league: String(leagueId), date,
      });
      totalCalls++;
      if (!res.ok) {
        console.log(`  ${date} ! failed: ${res.error}`);
        if (res.error === "quota-exhausted") { quotaExhausted = true; break; }
        continue;
      }
      const resp = res.data?.response ?? [];
      const rows = resp.map(r => mapInjury(fodzeLeague, r)).filter(Boolean);
      if (VERBOSE || rows.length > 0) {
        console.log(`  ${date}: ${rows.length} injuries`);
      }
      leagueBatch.push(...rows);
      totalInjuries += rows.length;
    }

    // Dedupe within league batch (same player+fixture could appear for
    // multiple dates if we iterated a range that spans the fixture day).
    const seen = new Set();
    const deduped = [];
    for (const r of leagueBatch) {
      const k = `${r.player_id_apisports}|${r.fixture_id_apisports}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }

    if (DRY) {
      console.log(`  (DRY) würde ${deduped.length} injuries upserten`);
      for (const s of deduped.slice(0, 3)) {
        console.log(`    ${s.team_name} · ${s.player_name} (${s.injury_type}: ${s.reason}) @ ${s.fixture_date}`);
      }
      continue;
    }

    if (deduped.length > 0) {
      try {
        const n = await supaUpsert(deduped);
        totalUpserted += n;
        console.log(`  ✓ ${n} injuries upserted`);
      } catch (e) {
        console.log(`  ✗ upsert failed: ${e.message}`);
      }
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Done                                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  api-sports calls:  ${totalCalls}`);
  console.log(`  daily remaining:   ${client.state.dailyRemaining ?? "?"}`);
  console.log(`  injuries seen:     ${totalInjuries}`);
  console.log(`  rows upserted:     ${totalUpserted}${DRY ? " (DRY)" : ""}`);
}

main().catch(e => { console.error(`\n✗ failed: ${e.stack || e.message}`); process.exit(1); });

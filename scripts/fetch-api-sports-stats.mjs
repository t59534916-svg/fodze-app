#!/usr/bin/env node
/**
 * FODZE — api-sports fixture-stats fetcher (HISTORICAL BACKFILL)
 *
 * WICHTIG: Der api-sports Free-Tier erlaubt KEIN Current-Season-Fetching.
 * Nur die Saisons **2022, 2023, 2024** sind zugänglich — perfekt für
 * historischen Nebenliga-Backfill, ungeeignet für tägliche Live-Updates.
 *
 * Pulls per-match statistics (xG, shots, corners, possession, passes)
 * und upserted in team_xg_history mit source="api-sports". Budget-aware
 * für den 100 req/day free-tier.
 *
 * Priorisiert:
 *   - Nebenligen wo wir kein Understat haben (Championship, Liga 2,
 *     Serie B, Primeira Liga, Jupiler, Scottish, Greek, Türkei, Liga 3)
 *   - Top-5 + Eredivisie werden nur bei --include-top-5 gefetched
 *     (Understat reicht i.d.R.)
 *
 * Idempotent: überspringt bereits vorhandene rows (source='api-sports').
 *
 * Usage:
 *   node scripts/fetch-api-sports-stats.mjs --league championship --season 2024
 *   node scripts/fetch-api-sports-stats.mjs --league liga3 --season 2023 --budget 80
 *   node scripts/fetch-api-sports-stats.mjs --all --season 2024            # alle Nebenligen, 2024/25
 *   node scripts/fetch-api-sports-stats.mjs --all --season 2024 --include-top-5
 *   node scripts/fetch-api-sports-stats.mjs --league championship --season 2024 --dry
 *
 * Defaults:
 *   --season 2024           (jüngste im Free-Tier verfügbare)
 *   --budget 80             (lässt ~20 Calls Puffer für andere Scripts)
 *   --days 0                (0 = ganze Saison der angegebenen --season;
 *                            >0 = nur letzte N Tage relative zu heute —
 *                            im Free-Tier meist leer, Current nicht erlaubt)
 *
 * ENV (.env.local):
 *   API_SPORTS_KEY     — direktes api-sports Konto
 *   — ODER —
 *   RAPIDAPI_KEY       — via RapidAPI api-football-v1
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createApiSportsClient,
  resolveApiSportsLeagueId,
  FREE_TIER_LATEST,
  FREE_TIER_SEASONS,
  parseFixtureStatistics,
} from "./_lib/api-sports.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── .env.local loader ────────────────────────────────────────────
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

// ─── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const DRY = flag("dry");
const ALL = flag("all");
const INCLUDE_TOP5 = flag("include-top-5");
const VERBOSE = flag("verbose");
const LEAGUE = val("league", null);
const DAYS = parseInt(val("days", "0"), 10);     // 0 = ganze Saison
const BUDGET = parseInt(val("budget", "80"), 10);
const SEASON = parseInt(val("season", String(FREE_TIER_LATEST)), 10);

if (!FREE_TIER_SEASONS.includes(SEASON)) {
  console.error(
    `❌ Season ${SEASON} ist nicht im Free-Tier verfügbar. ` +
    `Erlaubt: ${FREE_TIER_SEASONS.join(", ")}`
  );
  process.exit(1);
}

// ─── Target leagues ───────────────────────────────────────────────
// Nebenligen = wo wir kein Understat haben
const NEBENLIGEN = [
  "bundesliga2", "liga3",
  "championship", "league_one", "league_two",
  "la_liga2", "serie_b", "ligue_2",
  "primeira_liga", "jupiler_pro", "super_lig",
  "scottish_prem", "greek_sl",
];
const TOP5 = ["bundesliga", "epl", "la_liga", "serie_a", "ligue_1", "eredivisie"];

let targetLeagues;
if (LEAGUE) {
  targetLeagues = [LEAGUE];
} else if (ALL) {
  targetLeagues = INCLUDE_TOP5 ? [...NEBENLIGEN, ...TOP5] : NEBENLIGEN;
} else {
  console.error("Usage: --league <key>  |  --all [--include-top-5]  |  --dry");
  process.exit(1);
}

// ─── Guards ───────────────────────────────────────────────────────
if (!process.env.API_SPORTS_KEY && !process.env.RAPIDAPI_KEY) {
  console.error("❌ API_SPORTS_KEY (oder RAPIDAPI_KEY) fehlt in .env.local");
  process.exit(1);
}
if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY fehlen in .env.local");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function supaGet(pathAndQuery) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`supabase GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supaUpsert(rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/team_xg_history?on_conflict=team,league,match_date,venue`,
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase upsert ${res.status}: ${body.slice(0, 300)}`);
  }
  return rows.length;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — api-sports Fixture-Stats Fetcher                ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Leagues:  ${targetLeagues.join(", ")}`);
  console.log(`  Season:   ${SEASON}/${String(SEASON + 1).slice(-2)} (api-sports start-year: ${SEASON})`);
  console.log(`  Window:   ${DAYS > 0 ? `last ${DAYS} days` : "whole season"}`);
  console.log(`  Budget:   ${BUDGET} api-sports calls (daily free-tier = 100)`);
  console.log(`  Mode:     ${DRY ? "DRY-RUN (no writes)" : "LIVE"}\n`);

  const client = createApiSportsClient({ verbose: VERBOSE });
  const season = SEASON;
  // Fenster: bei --days N nur letzte N Tage, sonst season-wide (kein from/to)
  let from = null, to = null;
  if (DAYS > 0) {
    const now = new Date();
    from = isoDate(new Date(now.getTime() - DAYS * 86400_000));
    to = isoDate(now);
  }

  let totalFixtures = 0;
  let totalStatsFetched = 0;
  let totalSkipped = 0;
  let totalUpserted = 0;
  let quotaExhausted = false;

  for (const fodzeLeague of targetLeagues) {
    if (quotaExhausted) break;
    const leagueId = resolveApiSportsLeagueId(fodzeLeague);
    if (!leagueId) {
      console.log(`${fodzeLeague}: no api-sports league id mapped — skip`);
      continue;
    }

    console.log(`\n━━━ ${fodzeLeague} (api-sports id=${leagueId}, season=${season}) ━━━`);

    // 1. Fixture-Liste abrufen (1 call pro Liga)
    const fixRes = await client.getFixtures({
      league: leagueId, season, from, to, status: "FT",
    });
    if (!fixRes.ok) {
      console.log(`  ! getFixtures failed: ${fixRes.error}`);
      if (fixRes.error === "quota-exhausted") { quotaExhausted = true; break; }
      continue;
    }
    const fixtures = fixRes.data?.response ?? [];
    console.log(`  ${fixtures.length} fertige Matches ${DAYS > 0 ? `in ${DAYS}d-Fenster` : `in Saison ${season}/${String(season+1).slice(-2)}`}`);
    totalFixtures += fixtures.length;

    if (fixtures.length === 0) continue;

    // 2. Bereits-vorhanden-Check: welche Matches sind schon mit source='api-sports' drin?
    let existingKeys = new Set();
    if (!DRY) {
      try {
        const dates = [...new Set(fixtures.map(f => f.fixture?.date?.slice(0, 10)).filter(Boolean))];
        const pathAndQuery =
          `team_xg_history?select=team,opponent,match_date,venue` +
          `&league=eq.${encodeURIComponent(fodzeLeague)}` +
          `&source=eq.api-sports` +
          `&match_date=in.(${dates.map(d => `"${d}"`).join(",")})`;
        const existing = await supaGet(pathAndQuery);
        for (const r of existing) {
          existingKeys.add(`${r.team}|${r.match_date}|${r.venue}`);
        }
      } catch (e) {
        console.log(`  ! existing-check failed: ${e.message} — fortfahren, Upsert merged`);
      }
    }

    // 3. Stats pro Match pullen, budget-aware
    const toFetch = [];
    for (const f of fixtures) {
      const homeName = f.teams?.home?.name;
      const awayName = f.teams?.away?.name;
      const date = f.fixture?.date?.slice(0, 10);
      if (!homeName || !awayName || !date) continue;
      const keyH = `${homeName}|${date}|home`;
      const keyA = `${awayName}|${date}|away`;
      if (existingKeys.has(keyH) && existingKeys.has(keyA)) {
        totalSkipped++;
        continue;
      }
      toFetch.push(f);
    }
    console.log(`  ${toFetch.length} neu (${totalSkipped} bereits mit api-sports-source)`);

    const supaBatch = [];
    let leagueXGRows = 0, leagueRows = 0;
    let consecutiveFlushFailures = 0;
    let matchesSinceFlush = 0;
    const FLUSH_EVERY = 10; // Flush to Supabase every 10 matches (20 rows)

    const flushBatch = async (reason) => {
      if (DRY || supaBatch.length === 0) return;
      try {
        const BATCH = 500;
        let written = 0;
        for (let i = 0; i < supaBatch.length; i += BATCH) {
          written += await supaUpsert(supaBatch.slice(i, i + BATCH));
        }
        totalUpserted += written;
        console.log(`  ✓ flushed ${written} rows (${reason})`);
        supaBatch.length = 0;
        consecutiveFlushFailures = 0;
        matchesSinceFlush = 0;
      } catch (e) {
        consecutiveFlushFailures++;
        console.log(`  ✗ upsert failed (${consecutiveFlushFailures}/2): ${e.message}`);
        if (consecutiveFlushFailures >= 2) {
          throw new Error(
            `Supabase upsert failed 2x — abort early to preserve API budget ` +
            `(${client.state.dailyRemaining ?? "?"} calls left).`
          );
        }
      }
    };

    for (const f of toFetch) {
      // Budget-Check
      if (client.state.requestsDone >= BUDGET) {
        console.log(`  ⓘ Budget ${BUDGET} erreicht — stoppe für heute`);
        quotaExhausted = true;
        break;
      }
      if (client.state.quotaExhausted) { quotaExhausted = true; break; }

      const fixtureId = f.fixture?.id;
      if (!fixtureId) continue;

      const statRes = await client.getFixtureStatistics(fixtureId);
      if (!statRes.ok) {
        console.log(`    ! fixture ${fixtureId} stats failed: ${statRes.error}`);
        if (statRes.error === "quota-exhausted") { quotaExhausted = true; break; }
        continue;
      }
      totalStatsFetched++;

      const statsByTeam = parseFixtureStatistics(statRes.data);
      const homeId = f.teams?.home?.id;
      const awayId = f.teams?.away?.id;
      const home = statsByTeam[homeId];
      const away = statsByTeam[awayId];
      if (!home || !away) continue;

      const date = f.fixture.date.slice(0, 10);
      const gH = f.goals?.home ?? null;
      const gA = f.goals?.away ?? null;

      // xG bevorzugt; fällt auf null wenn api-sports kein xG für diese Liga liefert
      // (downstream-Logik differenziert dann per source-Feld).
      const xgH = home.stats.xg ?? null;
      const xgA = away.stats.xg ?? null;

      // Home perspective
      supaBatch.push({
        team: home.teamName,
        league: fodzeLeague,
        opponent: away.teamName,
        venue: "home",
        match_date: date,
        xg: xgH,
        xga: xgA,
        goals_for: gH,
        goals_against: gA,
        corners_for: home.stats.corners ?? null,
        corners_against: away.stats.corners ?? null,
        shots_for: home.stats.shots_total ?? null,
        shots_against: away.stats.shots_total ?? null,
        shots_on_target_for: home.stats.shots_on_target ?? null,
        shots_on_target_against: away.stats.shots_on_target ?? null,
        possession_pct: home.stats.possession_pct ?? null,
        passes_total: home.stats.passes_total ?? null,
        passes_accurate: home.stats.passes_accurate ?? null,
        pass_pct: home.stats.pass_pct ?? null,
        fouls: home.stats.fouls ?? null,
        offsides: home.stats.offsides ?? null,
        gk_saves: home.stats.gk_saves ?? null,
        shots_blocked: home.stats.shots_blocked ?? null,
        shots_inside_box: home.stats.shots_inside_box ?? null,
        shots_outside_box: home.stats.shots_outside_box ?? null,
        source: "api-sports",
      });
      // Away perspective
      supaBatch.push({
        team: away.teamName,
        league: fodzeLeague,
        opponent: home.teamName,
        venue: "away",
        match_date: date,
        xg: xgA,
        xga: xgH,
        goals_for: gA,
        goals_against: gH,
        corners_for: away.stats.corners ?? null,
        corners_against: home.stats.corners ?? null,
        shots_for: away.stats.shots_total ?? null,
        shots_against: home.stats.shots_total ?? null,
        shots_on_target_for: away.stats.shots_on_target ?? null,
        shots_on_target_against: home.stats.shots_on_target ?? null,
        possession_pct: away.stats.possession_pct ?? null,
        passes_total: away.stats.passes_total ?? null,
        passes_accurate: away.stats.passes_accurate ?? null,
        pass_pct: away.stats.pass_pct ?? null,
        fouls: away.stats.fouls ?? null,
        offsides: away.stats.offsides ?? null,
        gk_saves: away.stats.gk_saves ?? null,
        shots_blocked: away.stats.shots_blocked ?? null,
        shots_inside_box: away.stats.shots_inside_box ?? null,
        shots_outside_box: away.stats.shots_outside_box ?? null,
        source: "api-sports",
      });
      leagueRows += 2;
      if (xgH != null) leagueXGRows++;
      if (xgA != null) leagueXGRows++;
      matchesSinceFlush++;

      // Inkrementeller Flush — 2 consecutive failures lassen den Script
      // frühzeitig aussteigen, sodass keine weiteren API-Calls verbraucht
      // werden wenn z.B. ein Schema-Mismatch die Writes blockiert.
      if (matchesSinceFlush >= FLUSH_EVERY) {
        await flushBatch("interim");
      }
    }

    // 4. Final flush für partial last batch + Row-Qualitäts-Check
    if (supaBatch.length > 0) {
      if (DRY) {
        console.log(`  (DRY) würde ${supaBatch.length} rows upserten`);
        console.log(`  Sample: ${JSON.stringify(supaBatch[0], null, 2).slice(0, 300)}`);
      } else {
        await flushBatch("final");
      }
    }
    if (leagueRows > 0) {
      const pct = (leagueXGRows / leagueRows * 100).toFixed(0);
      console.log(`  xG-Abdeckung: ${pct}% (${leagueXGRows}/${leagueRows} rows mit echtem xG)`);
      if (leagueXGRows / leagueRows < 0.5) {
        console.log(`  ⚠ api-sports liefert für diese Liga wenig xG — Stats/Shots trotzdem nützlich für shots-model`);
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Done                                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  api-sports calls:     ${client.state.requestsDone}`);
  console.log(`  daily remaining:      ${client.state.dailyRemaining ?? "?"}`);
  console.log(`  fixtures seen:        ${totalFixtures}`);
  console.log(`  already had data:     ${totalSkipped}`);
  console.log(`  stats fetched:        ${totalStatsFetched}`);
  console.log(`  rows upserted:        ${totalUpserted}${DRY ? " (DRY)" : ""}`);
  if (quotaExhausted) {
    console.log(`\n  ⓘ Lauf endete wegen Budget/Quota — nächster Lauf morgen`);
  }
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

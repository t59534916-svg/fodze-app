#!/usr/bin/env node
/**
 * FODZE Understat Shot-Timeline → Game-State xG Backfill
 * ═══════════════════════════════════════════════════════
 * For each Understat match-id, scrapes the per-match shot list
 * (shotsData JSON embedded in the match page HTML), aggregates xG and
 * minutes-played into {level, leading, trailing} buckets per team, and
 * UPDATEs the corresponding team_xg_history rows (one per team-venue).
 *
 * Why only UPDATE (not INSERT):
 *   team_xg_history is the canonical per-match row set, already populated
 *   by seed-understat-2526.mjs. We never create new rows here — we only
 *   enrich existing ones with the new state columns. If the match_date
 *   lookup misses (e.g. Understat renamed a team), we log and skip.
 *
 * Usage:
 *   node scripts/backfill-xg-by-state.mjs --match-id 19493 --league bundesliga
 *   node scripts/backfill-xg-by-state.mjs --file match-ids.json --league bundesliga --dry
 *   node scripts/backfill-xg-by-state.mjs --match-id 19493 --dry
 *
 * match-ids.json format: `[19493, 19494, 19495, ...]` or
 *   `[{"match_id": 19493, "league": "bundesliga"}, ...]`
 *
 * Rate limit: 2s/match (polite; Understat has no hard public limit but
 * aggressive scrapes would draw attention).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  inferGameState,
  computeMinutesPerState,
  aggregateXgByState,
  aggregateXgBySituation,
} from "./_lib/game-state-xg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Distinguish "run as CLI" from "imported by a test". extractShotsData +
// summarizeMatchShots are unit-tested from the backfill module, so they
// must remain importable without tripping the argv guard / main() / env
// loader below.
const IS_CLI = import.meta.url === pathToFileURL(process.argv[1] || "").href;

// ─── Env loader (CLI-only; tests import helpers directly) ─────────
if (IS_CLI) {
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
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

// ─── CLI args — only parsed when invoked as script ─────────────────
const args = process.argv.slice(2);
const argv = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const DRY = args.includes("--dry");
const MATCH_ID = argv("--match-id");
const FILE = argv("--file");
const LEAGUE = argv("--league");
const LIMIT = parseInt(argv("--limit") || "0", 10) || 0;

if (IS_CLI && !MATCH_ID && !FILE) {
  console.error("Usage: --match-id <id> OR --file <path.json> [--league <code>] [--dry] [--limit N]");
  process.exit(1);
}

// ─── Understat HTML scrape ────────────────────────────────────────
const UNDERSTAT_BASE = "https://understat.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RATE_MS = 2000;
let _nextAllowedAt = 0;

async function gentleFetch(url) {
  const wait = Math.max(0, _nextAllowedAt - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _nextAllowedAt = Date.now() + RATE_MS;
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Pull the `shotsData` JSON out of a match page.
 *
 * The HTML contains lines like:
 *   var shotsData = JSON.parse('\x7B\x22h\x22:[...],\x22a\x22:[...]\x7D');
 *
 * We match the raw argument to JSON.parse (a single-quoted string with
 * Understat's standard hex escapes \xNN), unescape the hex, unescape
 * backslash-quotes, and finally parse as JSON.
 */
export function extractShotsData(html) {
  const re = /var\s+shotsData\s*=\s*JSON\.parse\s*\(\s*'((?:\\'|[^'])*)'\s*\)/;
  const m = html.match(re);
  if (!m) return null;
  const raw = m[1]
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Turn raw Understat shots into our per-side summary.
 * Understat shot row keys of interest:
 *   minute    "23"            (string)
 *   xG        "0.15"          (string)
 *   result    "Goal" | ...
 *   h_a       "h" | "a"       (shooting side)
 *   h_team    "Bayern Munich"
 *   a_team    "Dortmund"
 *   date      "2024-03-12..."
 *
 * Understat does NOT expose per-shot pre-shot score — we compute it by
 * walking the shot list in minute order, incrementing goal counters as
 * we encounter result==="Goal" rows.
 */
export function summarizeMatchShots(shotsData) {
  const homeShots = Array.isArray(shotsData?.h) ? shotsData.h : [];
  const awayShots = Array.isArray(shotsData?.a) ? shotsData.a : [];
  if (homeShots.length + awayShots.length === 0) return null;

  // Union sorted by minute.
  const all = [...homeShots.map(s => ({ ...s, _side: "home" })), ...awayShots.map(s => ({ ...s, _side: "away" }))];
  all.sort((a, b) => (parseInt(a.minute) || 0) - (parseInt(b.minute) || 0));

  // Derive meta.
  const sample = homeShots[0] || awayShots[0];
  const homeTeam = sample?.h_team || "";
  const awayTeam = sample?.a_team || "";
  const dateISO = (sample?.date || "").slice(0, 10);

  // Walk shots, track pre-shot score. `situation` is carried through so
  // aggregateXgBySituation can split xG into open-play vs set-piece
  // without needing a second pass over the same list (Phase 2.4).
  let hGoals = 0, aGoals = 0;
  const enriched = [];
  for (const s of all) {
    enriched.push({
      minute: parseInt(s.minute) || 0,
      xG: parseFloat(s.xG) || 0,
      shootingSide: s._side,
      situation: s.situation || "",
      homeGoalsBefore: hGoals,
      awayGoalsBefore: aGoals,
    });
    if (s.result === "Goal") {
      if (s._side === "home") hGoals++;
      else aGoals++;
    }
  }

  // Goal events for the per-minute state walk.
  const goalEvents = all
    .filter(s => s.result === "Goal")
    .map(s => ({ minute: parseInt(s.minute) || 0, scoringSide: s._side }));

  const homeAgg = aggregateXgByState("home", enriched);
  const awayAgg = aggregateXgByState("away", enriched);
  const homeMinutes = computeMinutesPerState("home", goalEvents);
  const awayMinutes = computeMinutesPerState("away", goalEvents);
  // Phase 2.4 — piggy-back situation aggregation on the same enriched list.
  const homeSit = aggregateXgBySituation("home", enriched);
  const awaySit = aggregateXgBySituation("away", enriched);

  return {
    home_team: homeTeam,
    away_team: awayTeam,
    match_date: dateISO,
    home: {
      xg_while_level:    homeAgg.xg_level,
      xg_while_leading:  homeAgg.xg_leading,
      xg_while_trailing: homeAgg.xg_trailing,
      xga_while_level:    homeAgg.xga_level,
      xga_while_leading:  homeAgg.xga_leading,
      xga_while_trailing: homeAgg.xga_trailing,
      minutes_level:    homeMinutes.level,
      minutes_leading:  homeMinutes.leading,
      minutes_trailing: homeMinutes.trailing,
      xg_openplay:  homeSit.xg_openplay,
      xg_setpiece:  homeSit.xg_setpiece,
      xga_openplay: homeSit.xga_openplay,
      xga_setpiece: homeSit.xga_setpiece,
    },
    away: {
      xg_while_level:    awayAgg.xg_level,
      xg_while_leading:  awayAgg.xg_leading,
      xg_while_trailing: awayAgg.xg_trailing,
      xga_while_level:    awayAgg.xga_level,
      xga_while_leading:  awayAgg.xga_leading,
      xga_while_trailing: awayAgg.xga_trailing,
      minutes_level:    awayMinutes.level,
      minutes_leading:  awayMinutes.leading,
      minutes_trailing: awayMinutes.trailing,
      xg_openplay:  awaySit.xg_openplay,
      xg_setpiece:  awaySit.xg_setpiece,
      xga_openplay: awaySit.xga_openplay,
      xga_setpiece: awaySit.xga_setpiece,
    },
  };
}

// ─── Supabase PATCH helper ────────────────────────────────────────
const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function patchTeamXgRow(team, league, matchDate, venue, payload) {
  // Use PATCH /team_xg_history?team=eq.X&league=eq.Y&match_date=eq.Z&venue=eq.W
  const url = `${SUPA_URL}/rest/v1/team_xg_history?team=eq.${encodeURIComponent(team)}&league=eq.${league}&match_date=eq.${matchDate}&venue=eq.${venue}`;
  const resp = await fetch(url, { method: "PATCH", headers: SUPA_HEADERS, body: JSON.stringify(payload) });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`PATCH failed (${resp.status}): ${err.slice(0, 200)}`);
  }
  // return=minimal gives empty body — we just rely on status.
}

// ─── Main ─────────────────────────────────────────────────────────
async function processMatch(matchId, league) {
  const url = `${UNDERSTAT_BASE}/match/${matchId}`;
  let html;
  try {
    const resp = await gentleFetch(url);
    if (!resp.ok) return { matchId, status: `http-${resp.status}` };
    html = await resp.text();
  } catch (e) {
    return { matchId, status: `fetch-${e.message || "err"}` };
  }

  const shotsData = extractShotsData(html);
  if (!shotsData) return { matchId, status: "no-shotsData" };
  const summary = summarizeMatchShots(shotsData);
  if (!summary) return { matchId, status: "no-shots" };

  if (DRY) {
    return { matchId, status: "dry", summary };
  }
  if (!SUPA_URL || !SUPA_KEY) {
    return { matchId, status: "no-supabase-creds" };
  }
  if (!league) {
    return { matchId, status: "league-required-for-upsert" };
  }

  try {
    await patchTeamXgRow(summary.home_team, league, summary.match_date, "home", summary.home);
    await patchTeamXgRow(summary.away_team, league, summary.match_date, "away", summary.away);
    return { matchId, status: "ok", summary };
  } catch (e) {
    return { matchId, status: `patch-${e.message}` };
  }
}

function loadMatchList() {
  if (MATCH_ID) return [{ match_id: MATCH_ID, league: LEAGUE }];
  const raw = JSON.parse(readFileSync(FILE, "utf-8"));
  if (!Array.isArray(raw)) throw new Error(`--file expected JSON array`);
  return raw.map(item =>
    typeof item === "object" && item !== null
      ? { match_id: String(item.match_id || item.id), league: item.league || LEAGUE }
      : { match_id: String(item), league: LEAGUE },
  );
}

async function main() {
  const matches = loadMatchList();
  const work = LIMIT > 0 ? matches.slice(0, LIMIT) : matches;
  console.log(`[xg-state] processing ${work.length} matches (${DRY ? "DRY" : "LIVE"})`);

  let ok = 0, dry = 0, fail = 0;
  for (const m of work) {
    const r = await processMatch(m.match_id, m.league);
    if (r.status === "ok") {
      ok++;
      console.log(`  ✓ ${m.match_id} ${r.summary.home_team} vs ${r.summary.away_team} ${r.summary.match_date}`);
    } else if (r.status === "dry") {
      dry++;
      const s = r.summary;
      console.log(`  · ${m.match_id} ${s.home_team} vs ${s.away_team} ${s.match_date}`);
      console.log(`        home: level=${s.home.xg_while_level} lead=${s.home.xg_while_leading} trail=${s.home.xg_while_trailing} (mins ${s.home.minutes_level}/${s.home.minutes_leading}/${s.home.minutes_trailing})`);
      console.log(`        away: level=${s.away.xg_while_level} lead=${s.away.xg_while_leading} trail=${s.away.xg_while_trailing} (mins ${s.away.minutes_level}/${s.away.minutes_leading}/${s.away.minutes_trailing})`);
    } else {
      fail++;
      console.warn(`  ✗ ${m.match_id} ${r.status}`);
    }
  }
  console.log();
  console.log(`[xg-state] DONE — ok=${ok} dry=${dry} fail=${fail}`);
}

if (IS_CLI) {
  main().catch(e => {
    console.error("[xg-state] unhandled:", e);
    process.exit(1);
  });
}

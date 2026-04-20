#!/usr/bin/env node
/**
 * FODZE Result Fetcher — Auto-settle bets after matchday
 *
 * Fetches completed match results from The-Odds-API (scores endpoint)
 * and auto-settles pending bets in Supabase.
 *
 * Covers all 18 FODZE leagues (up from 5 in v1). Uses canonical market
 * keys from src/lib/market-labels.ts and fuzzy team matching from
 * src/lib/team-resolver.ts for robust matching across naming conventions.
 *
 * Usage:
 *   node scripts/fetch-results.mjs                    # All leagues
 *   node scripts/fetch-results.mjs --league bundesliga # Single league
 *   node scripts/fetch-results.mjs --dry               # Preview, no writes
 *   node scripts/fetch-results.mjs --days 7            # Look back N days (default 3)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
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

const API_KEY = process.env.ODDS_API_KEY;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!API_KEY) { console.error("❌ Missing ODDS_API_KEY"); process.exit(1); }
if (!SUPA_URL || !SUPA_KEY) { console.error("❌ Missing SUPABASE env"); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");
const daysArg = args.find((_, i) => args[i - 1] === "--days");
const DAYS_FROM = parseInt(daysArg) || 3;

// Full league map — mirrors scripts/fetch-odds.mjs to cover all 18 leagues
const LEAGUE_MAP = {
  bundesliga:    "soccer_germany_bundesliga",
  bundesliga2:   "soccer_germany_bundesliga2",
  liga3:         "soccer_germany_liga3",
  epl:           "soccer_epl",
  la_liga:       "soccer_spain_la_liga",
  serie_a:       "soccer_italy_serie_a",
  ligue_1:       "soccer_france_ligue_one",
  eredivisie:    "soccer_netherlands_eredivisie",
  championship:  "soccer_efl_champ",
  primeira_liga: "soccer_portugal_primeira_liga",
  jupiler_pro:   "soccer_belgium_first_div",
  super_lig:     "soccer_turkey_super_league",
  la_liga2:      "soccer_spain_segunda_division",
  serie_b:       "soccer_italy_serie_b",
  ligue_2:       "soccer_france_ligue_two",
  scottish_prem: "soccer_spl",
  greek_sl:      "soccer_greece_super_league",
  league_one:    "soccer_england_league1",
  league_two:    "soccer_england_league2",
};

// ─── Market normalization ────────────────────────────────────────
// Canonicalize stored market strings to the same set as src/lib/market-labels.ts
function canonicalMarket(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  switch (s) {
    case "1": case "h": case "home": case "heim":
      return "1";
    case "x": case "d": case "draw": case "unent.": case "unent": case "remis":
      return "X";
    case "2": case "a": case "away": case "ausw.": case "ausw": case "gast":
      return "2";
    case "o25": case "ü2.5": case "u2.5 over": case "o2.5": case "over2.5":
      return "o25";
    case "u25": case "u2.5": case "under2.5":
      return "u25";
    case "btts": case "gg": case "both teams to score":
      return "btts";
    case "no_btts": case "ng": case "no btts":
      return "no_btts";
    default:
      return null;
  }
}

function determineResult(market, homeScore, awayScore) {
  const canon = canonicalMarket(market);
  const total = homeScore + awayScore;
  switch (canon) {
    case "1":       return homeScore > awayScore ? "won" : "lost";
    case "X":       return homeScore === awayScore ? "won" : "lost";
    case "2":       return awayScore > homeScore ? "won" : "lost";
    case "o25":     return total > 2 ? "won" : "lost";
    case "u25":     return total <= 2 ? "won" : "lost";
    case "btts":    return homeScore > 0 && awayScore > 0 ? "won" : "lost";
    case "no_btts": return homeScore === 0 || awayScore === 0 ? "won" : "lost";
    default:        return null; // Unknown market — skip, don't guess
  }
}

// ─── Team name fuzzy match ───────────────────────────────────────
// Mirrors src/lib/team-resolver.ts `fuzzyTeamMatch` exactly
function fuzzyTeamMatch(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  if (la.includes(lb) || lb.includes(la)) return true;
  const words = la.split(/\s+/).filter((w) => w.length > 3);
  return words.some((w) => lb.includes(w));
}

// ─── Supabase REST helpers ───────────────────────────────────────
const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function getPendingBets() {
  const resp = await fetch(
    `${SUPA_URL}/rest/v1/bets?result=eq.pending&select=*`,
    { headers: SUPA_HEADERS },
  );
  if (!resp.ok) throw new Error(`Supabase GET bets: ${resp.status}`);
  return resp.json();
}

// Compute CLV from placed & closing odds. Returns null when either is missing
// or out-of-range — we refuse to write 0 for missing data (that would pollute
// the positive-CLV average with false zeros and make real edge invisible).
function computeClv(oddsPlaced, closingOdds) {
  const placed = Number(oddsPlaced);
  const closing = Number(closingOdds);
  if (!Number.isFinite(placed) || placed <= 1) return null;
  if (!Number.isFinite(closing) || closing <= 1) return null;
  return +((Math.log(placed / closing) * 100).toFixed(4));
}

// ─── CLV fallback via odds_closing_history (football-data.co.uk PSCH) ──
// When the live snapshot-closing-odds cron missed a bet (e.g. bet placed
// long before the cron window, or weekend crawl timed out), try to recover
// the closing price from the Buchdahl CSV ingest. Covers the 13 leagues
// in LEAGUE_CSV of backfill-football-data-co-uk.mjs; others stay null.
const MARKET_TO_CLOSING_COL = {
  "1": "psch", "X": "pscd", "2": "psca",
  "o25": "psc_over25", "u25": "psc_under25",
};

async function lookupClosingFromHistory(bet, league) {
  const canon = canonicalMarket(bet.market);
  const col = MARKET_TO_CLOSING_COL[canon];
  if (!col || !league) return null;
  // Query ±2 days around placed_at so we forgive timezone drift + fixture
  // slips. This stays league-scoped to avoid fuzzy-matching across leagues
  // (two "Club Brugge"s in Portugese + Belgian lists would be a mess).
  const placed = new Date(bet.placed_at || Date.now());
  const from = new Date(placed.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const to = new Date(placed.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const url = `${SUPA_URL}/rest/v1/odds_closing_history?select=home_team,away_team,${col}&league=eq.${league}&match_date=gte.${from}&match_date=lte.${to}`;
  try {
    const resp = await fetch(url, { headers: SUPA_HEADERS });
    if (!resp.ok) return null;
    const rows = await resp.json();
    for (const r of rows) {
      if (fuzzyTeamMatch(r.home_team, bet.home_team) && fuzzyTeamMatch(r.away_team, bet.away_team)) {
        const v = Number(r[col]);
        if (Number.isFinite(v) && v > 1) return v;
      }
    }
  } catch {
    // Table may not exist (migration not yet applied); graceful no-op.
  }
  return null;
}

async function settleBet(bet, result) {
  if (DRY) return;
  // Recompute CLV on settlement — defense-in-depth. The snapshot-closing-odds
  // cron normally sets clv atomically when it writes closing_odds, but this
  // guarantees clv is in sync even if snapshot ran before a schema change, or
  // if an admin edited closing_odds manually without updating clv.
  let closingOdds = bet.closing_odds;
  let recoveredFromHistory = false;
  if (closingOdds == null) {
    const league = (bet.match_key || "").split(":")[0];
    const fallback = await lookupClosingFromHistory(bet, league);
    if (fallback != null) {
      closingOdds = fallback;
      recoveredFromHistory = true;
    }
  }
  const clv = computeClv(bet.odds_placed, closingOdds);
  const payload = {
    result,
    settled_at: new Date().toISOString(),
    ...(clv !== null ? { clv } : {}),
    // Also persist the recovered closing_odds so it's visible in the bet
    // record and subsequent runs don't re-query the history table.
    ...(recoveredFromHistory && closingOdds != null ? { closing_odds: closingOdds } : {}),
  };
  const resp = await fetch(
    `${SUPA_URL}/rest/v1/bets?id=eq.${bet.id}`,
    {
      method: "PATCH",
      headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    },
  );
  if (!resp.ok) {
    const msg = await resp.text();
    console.error(`  ⚠️ PATCH ${bet.id}: ${resp.status} ${msg}`);
  }
}

// ─── Odds API fetch ──────────────────────────────────────────────
async function fetchScores(sportKey, daysFrom) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores?apiKey=${API_KEY}&daysFrom=${daysFrom}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${sportKey}: HTTP ${resp.status}`);
  return resp.json();
}

function extractScores(match) {
  if (!match.scores || !Array.isArray(match.scores)) return null;
  const homeRow = match.scores.find((s) => s.name === match.home_team);
  const awayRow = match.scores.find((s) => s.name === match.away_team);
  const h = parseInt(homeRow?.score);
  const a = parseInt(awayRow?.score);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return { home: h, away: a };
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`⚽ FODZE Result Fetcher${DRY ? " (DRY RUN)" : ""} · lookback ${DAYS_FROM}d\n`);

  const pending = await getPendingBets();
  console.log(`📋 ${pending.length} pending bets`);
  if (pending.length === 0) {
    console.log("No pending bets to settle. Exiting.");
    return;
  }

  // Determine which leagues are relevant (only fetch leagues that have pending bets)
  const pendingLeagues = new Set(
    pending.map((b) => (b.match_key || "").split(":")[0]).filter(Boolean),
  );
  const leagues = leagueFilter
    ? { [leagueFilter]: LEAGUE_MAP[leagueFilter] }
    : Object.fromEntries(
        Object.entries(LEAGUE_MAP).filter(([k]) => pendingLeagues.size === 0 || pendingLeagues.has(k)),
      );
  console.log(`🎯 Fetching scores for ${Object.keys(leagues).length} leagues`);

  const allScores = [];
  for (const [fodzeKey, sportKey] of Object.entries(leagues)) {
    if (!sportKey) continue;
    try {
      const scores = await fetchScores(sportKey, DAYS_FROM);
      const completed = scores.filter((s) => s.completed);
      allScores.push(...completed.map((s) => ({ ...s, fodzeLeague: fodzeKey })));
      console.log(`  📊 ${fodzeKey.padEnd(16)} ${completed.length} completed`);
    } catch (e) {
      console.error(`  ❌ ${fodzeKey}: ${e.message}`);
    }
  }

  // Match bets to results
  let settled = 0;
  let unsettled = 0;
  const unmatchedBets = [];
  for (const bet of pending) {
    const betLeague = (bet.match_key || "").split(":")[0];
    // Prefer matching within the same league for accuracy
    const candidates = betLeague
      ? allScores.filter((s) => s.fodzeLeague === betLeague)
      : allScores;

    const match = candidates.find(
      (s) =>
        fuzzyTeamMatch(s.home_team, bet.home_team) &&
        fuzzyTeamMatch(s.away_team, bet.away_team),
    );

    if (!match) {
      unmatchedBets.push(bet);
      unsettled++;
      continue;
    }

    const scores = extractScores(match);
    if (!scores) {
      console.log(`  ⚠️ ${bet.home_team}-${bet.away_team}: scores not available yet`);
      unsettled++;
      continue;
    }

    const result = determineResult(bet.market, scores.home, scores.away);
    if (!result) {
      console.log(`  ⚠️ ${bet.home_team}-${bet.away_team}: unknown market "${bet.market}"`);
      unsettled++;
      continue;
    }

    const pnl = result === "won"
      ? ((Number(bet.odds_placed) - 1) * Number(bet.stake)).toFixed(2)
      : (-Number(bet.stake)).toFixed(2);
    const icon = result === "won" ? "✅" : "❌";
    const clv = computeClv(bet.odds_placed, bet.closing_odds);
    const clvTag = clv !== null ? ` · CLV ${clv >= 0 ? "+" : ""}${clv.toFixed(2)}%` : "";
    console.log(
      `  ${icon} ${bet.home_team} ${scores.home}:${scores.away} ${bet.away_team} · ${bet.market} → ${result} (${pnl >= 0 ? "+" : ""}${pnl}€)${clvTag}`,
    );

    await settleBet(bet, result);
    settled++;
  }

  console.log(`\n✅ ${settled} bets settled${DRY ? " (dry)" : ""}`);
  if (unsettled > 0) {
    console.log(`⏳ ${unsettled} bets unsettled (match not completed yet, scores missing, or unknown market)`);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

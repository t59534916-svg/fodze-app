#!/usr/bin/env node
/**
 * FODZE Result Fetcher — Auto-settle bets after matchday
 *
 * Fetches completed match results from The-Odds-API (scores endpoint)
 * and auto-settles pending bets in Supabase.
 *
 * Usage:
 *   node scripts/fetch-results.mjs                    # All leagues
 *   node scripts/fetch-results.mjs --league bundesliga # Single league
 *   node scripts/fetch-results.mjs --dry               # Dry run
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

const API_KEY = process.env.ODDS_API_KEY;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!API_KEY) { console.error("❌ Missing ODDS_API_KEY"); process.exit(1); }
if (!SUPA_URL || !SUPA_KEY) { console.error("❌ Missing SUPABASE vars"); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const leagueFilter = args.find((a, i) => args[i - 1] === "--league");

const LEAGUE_MAP = {
  bundesliga: "soccer_germany_bundesliga",
  epl: "soccer_epl",
  la_liga: "soccer_spain_la_liga",
  serie_a: "soccer_italy_serie_a",
  ligue_1: "soccer_france_ligue_one",
};

async function fetchScores(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores?apiKey=${API_KEY}&daysFrom=3`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

async function getPendingBets() {
  const resp = await fetch(`${SUPA_URL}/rest/v1/bets?result=eq.pending&select=*`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  return resp.json();
}

async function settleBet(betId, result) {
  if (DRY) { console.log(`  [DRY] Would settle ${betId} → ${result}`); return; }
  await fetch(`${SUPA_URL}/rest/v1/bets?id=eq.${betId}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify({ result, settled_at: new Date().toISOString() }),
  });
}

function determineResult(bet, homeScore, awayScore) {
  const market = bet.market?.toLowerCase();
  const totalGoals = homeScore + awayScore;

  if (market === "heim" || market === "1") return homeScore > awayScore ? "won" : "lost";
  if (market === "unent." || market === "x") return homeScore === awayScore ? "won" : "lost";
  if (market === "ausw." || market === "2") return awayScore > homeScore ? "won" : "lost";
  if (market === "ü2.5") return totalGoals > 2 ? "won" : "lost";
  if (market === "u2.5") return totalGoals <= 2 ? "won" : "lost";
  if (market === "btts") return homeScore > 0 && awayScore > 0 ? "won" : "lost";

  return null; // Unknown market
}

async function main() {
  console.log(`⚽ FODZE Result Fetcher${DRY ? " (DRY RUN)" : ""}\n`);

  // Get all pending bets
  const pendingBets = await getPendingBets();
  console.log(`📋 ${pendingBets.length} pending bets\n`);

  if (pendingBets.length === 0) {
    console.log("No pending bets to settle.");
    return;
  }

  // Fetch scores for relevant leagues
  const leagues = leagueFilter ? { [leagueFilter]: LEAGUE_MAP[leagueFilter] } : LEAGUE_MAP;
  const allScores = [];

  for (const [fodzeKey, sportKey] of Object.entries(leagues)) {
    if (!sportKey) continue;
    try {
      const scores = await fetchScores(sportKey);
      const completed = scores.filter(s => s.completed);
      allScores.push(...completed.map(s => ({ ...s, fodzeLeague: fodzeKey })));
      console.log(`📊 ${fodzeKey}: ${completed.length} completed matches`);
    } catch (e) {
      console.error(`  ❌ ${fodzeKey}: ${e.message}`);
    }
  }

  // Match bets to results
  let settled = 0;
  for (const bet of pendingBets) {
    const homeTeam = (bet.home_team || "").toLowerCase();
    const awayTeam = (bet.away_team || "").toLowerCase();

    // Find matching score
    const match = allScores.find(s => {
      const h = s.home_team.toLowerCase();
      const a = s.away_team.toLowerCase();
      return (h.includes(homeTeam) || homeTeam.includes(h) ||
              h.split(" ").some(w => w.length > 3 && homeTeam.includes(w))) &&
             (a.includes(awayTeam) || awayTeam.includes(a) ||
              a.split(" ").some(w => w.length > 3 && awayTeam.includes(w)));
    });

    if (!match) continue;

    const homeScore = parseInt(match.scores?.find(s => s.name === match.home_team)?.score);
    const awayScore = parseInt(match.scores?.find(s => s.name === match.away_team)?.score);

    if (isNaN(homeScore) || isNaN(awayScore)) continue;

    const result = determineResult(bet, homeScore, awayScore);
    if (!result) continue;

    const pnl = result === "won"
      ? ((bet.odds_placed - 1) * bet.stake).toFixed(2)
      : (-bet.stake).toFixed(2);

    console.log(`  ${bet.home_team} ${homeScore}:${awayScore} ${bet.away_team} | ${bet.market} → ${result} (${pnl}€)`);

    await settleBet(bet.id, result);
    settled++;
  }

  console.log(`\n✅ ${settled} bets settled${DRY ? " (dry)" : ""}`);
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });

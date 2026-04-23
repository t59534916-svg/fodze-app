#!/usr/bin/env node
/**
 * FODZE Odds Fetcher — The-Odds-API → Supabase
 *
 * Fetches live odds from The-Odds-API (free tier, 500 credits/month)
 * and stores them in the Supabase `live_odds` table.
 *
 * Usage:
 *   node scripts/fetch-odds.mjs                    # fetch all FODZE leagues
 *   node scripts/fetch-odds.mjs --league bundesliga # fetch single league
 *   node scripts/fetch-odds.mjs --dry               # dry run (no DB write)
 *
 * Env vars (required):
 *   ODDS_API_KEY        — The-Odds-API key
 *   SUPABASE_URL        — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key (bypasses RLS)
 *
 * Credit cost: 2 credits per league (h2h + totals, 1 region)
 *              12 credits total for 6 leagues
 */

const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports";

// Map FODZE league keys → The-Odds-API sport keys
const LEAGUE_MAP = {
  bundesliga:   "soccer_germany_bundesliga",
  bundesliga2:  "soccer_germany_bundesliga2",
  liga3:        "soccer_germany_liga3",
  epl:          "soccer_epl",
  la_liga:      "soccer_spain_la_liga",
  serie_a:      "soccer_italy_serie_a",
  ligue_1:      "soccer_france_ligue_one",
  eredivisie:   "soccer_netherlands_eredivisie",
  championship: "soccer_efl_champ",
  cl:           "soccer_uefa_champs_league",
  el:           "soccer_uefa_europa_league",
  // Tier 1
  primeira_liga: "soccer_portugal_primeira_liga",
  jupiler_pro:   "soccer_belgium_first_div",
  super_lig:     "soccer_turkey_super_league",
  la_liga2:      "soccer_spain_segunda_division",
  serie_b:       "soccer_italy_serie_b",
  ligue_2:       "soccer_france_ligue_two",
  // Tier 2
  scottish_prem: "soccer_spl",
  greek_sl:      "soccer_greece_super_league",
  league_one:    "soccer_england_league1",
  league_two:    "soccer_england_league2",
  // Tier 2 — Central-Euro Top-Divisionen (The-Odds-API keys verified
  // gegen /v4/sports/?all=true Endpoint)
  austria_bl:       "soccer_austria_bundesliga",
  swiss_sl:         "soccer_switzerland_superleague",
  eerste_divisie:   "soccer_netherlands_eerste_divisie",
};

// Sharp bookmakers (closest to true probability)
const SHARP_BOOKS = ["pinnacle", "betfair_ex_eu"];
// Soft bookmakers (where users actually bet)
const SOFT_BOOKS = ["bet365", "unibet_eu", "betsson", "williamhill", "sport888", "betway"];

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const singleLeague = args.find((a, i) => args[i - 1] === "--league");

const API_KEY = process.env.ODDS_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

if (!API_KEY) { console.error("❌ Missing ODDS_API_KEY"); process.exit(1); }
if (!SUPA_URL && !DRY) { console.error("❌ Missing SUPABASE_URL"); process.exit(1); }
if (!SUPA_KEY && !DRY) { console.error("❌ Missing SUPABASE_SERVICE_KEY"); process.exit(1); }

async function fetchOdds(sportKey) {
  const url = `${ODDS_API_BASE}/${sportKey}/odds?` + new URLSearchParams({
    apiKey: API_KEY,
    regions: "eu",
    markets: "h2h,totals",
    oddsFormat: "decimal",
    dateFormat: "iso",
  });

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API ${resp.status}: ${txt}`);
  }

  const remaining = resp.headers.get("x-requests-remaining");
  const used = resp.headers.get("x-requests-used");
  console.log(`  Credits: ${used} used, ${remaining} remaining`);

  return resp.json();
}

function extractBestOdds(bookmakers, market) {
  const results = { sharp: null, best: null, allBooks: [] };

  for (const bk of bookmakers) {
    const mk = bk.markets?.find(m => m.key === market);
    if (!mk) continue;

    const odds = {};
    for (const o of mk.outcomes) {
      if (market === "h2h") {
        if (o.name === "Draw") odds.D = o.price;
        else if (bk.markets[0]?.outcomes?.[0]?.name === o.name) odds.H = o.price;
        else odds.A = o.price;
      } else if (market === "totals") {
        if (o.name === "Over") odds.O = o.price;
        else odds.U = o.price;
        odds.point = o.point;
      }
    }

    // For h2h, use home_team position to determine H vs A
    const entry = { book: bk.key, title: bk.title, ...odds, updated: bk.last_update };
    results.allBooks.push(entry);

    // Track sharp book
    if (SHARP_BOOKS.includes(bk.key)) results.sharp = entry;
  }

  // Find best odds across all books
  if (market === "h2h") {
    results.bestH = Math.max(...results.allBooks.map(b => b.H || 0));
    results.bestD = Math.max(...results.allBooks.map(b => b.D || 0));
    results.bestA = Math.max(...results.allBooks.map(b => b.A || 0));
  } else if (market === "totals") {
    results.bestO = Math.max(...results.allBooks.map(b => b.O || 0));
    results.bestU = Math.max(...results.allBooks.map(b => b.U || 0));
  }

  return results;
}

function processEvent(event) {
  const h2h = extractBestOdds(event.bookmakers, "h2h");
  const totals = extractBestOdds(event.bookmakers, "totals");

  // Assign H/A correctly using home_team
  for (const bk of h2h.allBooks) {
    const mk = event.bookmakers.find(b => b.key === bk.book)?.markets?.find(m => m.key === "h2h");
    if (!mk) continue;
    for (const o of mk.outcomes) {
      if (o.name === event.home_team) bk.H = o.price;
      else if (o.name === "Draw") bk.D = o.price;
      else bk.A = o.price;
    }
  }
  // Recalculate best after reassignment
  h2h.bestH = Math.max(...h2h.allBooks.filter(b => b.H).map(b => b.H));
  h2h.bestD = Math.max(...h2h.allBooks.filter(b => b.D).map(b => b.D));
  h2h.bestA = Math.max(...h2h.allBooks.filter(b => b.A).map(b => b.A));

  // Sharp book odds (Pinnacle)
  const sharpH2H = h2h.allBooks.find(b => SHARP_BOOKS.includes(b.book));
  const sharpTotals = totals.allBooks.find(b => SHARP_BOOKS.includes(b.book));

  return {
    event_id: event.id,
    home_team: event.home_team,
    away_team: event.away_team,
    commence_time: event.commence_time,
    // Best available odds (for max ROI)
    best_h: h2h.bestH || null,
    best_d: h2h.bestD || null,
    best_a: h2h.bestA || null,
    best_over25: totals.bestO || null,
    best_under25: totals.bestU || null,
    // Sharp odds (Pinnacle — closest to true probability)
    sharp_h: sharpH2H?.H || null,
    sharp_d: sharpH2H?.D || null,
    sharp_a: sharpH2H?.A || null,
    sharp_over25: sharpTotals?.O || null,
    sharp_under25: sharpTotals?.U || null,
    sharp_book: sharpH2H?.book || null,
    // All bookmaker odds (for comparison)
    bookmakers_h2h: h2h.allBooks.map(b => ({ book: b.book, H: b.H, D: b.D, A: b.A })),
    bookmakers_totals: totals.allBooks.map(b => ({ book: b.book, O: b.O, U: b.U, point: b.point })),
    num_bookmakers: h2h.allBooks.length,
  };
}

async function upsertToSupabase(league, odds) {
  if (DRY) {
    console.log(`  [DRY] Would upsert ${odds.length} events for ${league}`);
    return;
  }

  const rows = odds.map(o => ({
    league,
    event_id: o.event_id,
    home_team: o.home_team,
    away_team: o.away_team,
    commence_time: o.commence_time,
    best_h: o.best_h,
    best_d: o.best_d,
    best_a: o.best_a,
    best_over25: o.best_over25,
    best_under25: o.best_under25,
    sharp_h: o.sharp_h,
    sharp_d: o.sharp_d,
    sharp_a: o.sharp_a,
    sharp_over25: o.sharp_over25,
    sharp_under25: o.sharp_under25,
    sharp_book: o.sharp_book,
    bookmakers: { h2h: o.bookmakers_h2h, totals: o.bookmakers_totals },
    num_bookmakers: o.num_bookmakers,
    fetched_at: new Date().toISOString(),
  }));

  // Delete existing odds for this league, then insert fresh
  await fetch(`${SUPA_URL}/rest/v1/live_odds?league=eq.${league}`, {
    method: "DELETE",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });

  const resp = await fetch(`${SUPA_URL}/rest/v1/live_odds`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ❌ Supabase error: ${resp.status} ${txt}`);
  } else {
    console.log(`  ✅ Inserted ${rows.length} events (replaced old)`);
  }
}

// ─── Fixture extraction (zero extra API calls) ──────────────────
// Uses the same events already fetched for odds

async function upsertFixtures(league, events) {
  if (DRY) {
    console.log(`  [DRY] Would save ${events.length} fixtures for ${league}`);
    for (const e of events.slice(0, 3)) {
      console.log(`    ${e.home_team} vs ${e.away_team} @ ${e.commence_time}`);
    }
    return;
  }

  const rows = events.map(e => ({
    league,
    event_id: e.id,
    home_team: e.home_team,
    away_team: e.away_team,
    commence_time: e.commence_time,
    fetched_at: new Date().toISOString(),
  }));

  // Delete old fixtures for this league, then insert fresh (same pattern as odds)
  await fetch(`${SUPA_URL}/rest/v1/upcoming_fixtures?league=eq.${league}`, {
    method: "DELETE",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });

  const resp = await fetch(`${SUPA_URL}/rest/v1/upcoming_fixtures`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    // Table may not exist yet — not fatal
    if (txt.includes("relation") && txt.includes("does not exist")) {
      console.log(`  ⚠ upcoming_fixtures table not found (run migration first)`);
    } else {
      console.error(`  ❌ Fixtures upsert error: ${resp.status} ${txt}`);
    }
  } else {
    console.log(`  📅 ${rows.length} fixtures saved`);
  }
}

// Priority-ordered league list — top-6 fetch first so they're guaranteed to
// land even if The-Odds-API rate-limits or we exhaust the monthly credit
// budget mid-run. Everything after "serie_a" gets BEST-EFFORT coverage.
// Historical bug: prior default filtered to just the top-6 slice, meaning
// the other 13 leagues NEVER got fresh odds from the cron — visible stale
// data since d052c61 (league expansion) until this fix.
const PRIORITY_ORDER = [
  "bundesliga", "bundesliga2", "liga3", "epl", "la_liga", "serie_a",
  "ligue_1", "eredivisie", "championship",
  "primeira_liga", "jupiler_pro", "super_lig",
  "la_liga2", "serie_b", "ligue_2",
  "scottish_prem", "greek_sl", "league_one", "league_two",
  "austria_bl", "swiss_sl", "eerste_divisie",
  "cl", "el",
];

async function main() {
  let leagues;
  if (singleLeague) {
    leagues = { [singleLeague]: LEAGUE_MAP[singleLeague] };
  } else {
    // Default: all leagues, priority-ordered. Keep CL/EL out of the daily
    // default — they're tournament-bound (no odds most of the year) so we
    // save credits by only fetching them on explicit `--league cl` runs.
    leagues = {};
    for (const k of PRIORITY_ORDER) {
      if (k === "cl" || k === "el") continue;
      if (LEAGUE_MAP[k]) leagues[k] = LEAGUE_MAP[k];
    }
  }

  console.log(`🔥 FODZE Odds Fetcher — ${Object.keys(leagues).length} leagues`);
  console.log(`   Mode: ${DRY ? "DRY RUN" : "LIVE"}`);
  console.log(`   Priority: top-6 first so they're guaranteed under rate limits`);
  console.log();

  let totalEvents = 0;

  for (const [fodzeKey, apiKey] of Object.entries(leagues)) {
    console.log(`📊 ${fodzeKey} (${apiKey})`);

    try {
      const events = await fetchOdds(apiKey);
      console.log(`  Found ${events.length} upcoming events`);

      if (events.length === 0) continue;

      const processed = events.map(processEvent);
      totalEvents += processed.length;

      // Print summary
      for (const p of processed.slice(0, 3)) {
        const sharp = p.sharp_h ? `[Sharp: ${p.sharp_h}/${p.sharp_d}/${p.sharp_a}]` : "[no sharp]";
        console.log(`  ${p.home_team} vs ${p.away_team}: Best ${p.best_h}/${p.best_d}/${p.best_a} ${sharp}`);
      }
      if (processed.length > 3) console.log(`  ... +${processed.length - 3} more`);

      await upsertToSupabase(fodzeKey, processed);

      // Also save fixtures (zero extra API calls — uses same events)
      await upsertFixtures(fodzeKey, events);
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
    }

    console.log();
  }

  console.log(`✅ Done. ${totalEvents} total events processed.`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

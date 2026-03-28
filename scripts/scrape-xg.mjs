#!/usr/bin/env node
/**
 * FODZE Deterministic xG Scraper — Orchestration Script
 *
 * Replaces LLM-based xG collection with deterministic scraping from Understat.
 * Generates matchday JSON compatible with seed-matchday.mjs.
 *
 * Usage:
 *   node scripts/scrape-xg.mjs --league bundesliga --season 2025
 *   node scripts/scrape-xg.mjs --league bundesliga --season 2025 --dry
 *   node scripts/scrape-xg.mjs --league bundesliga --season 2025 --sos   # Include SoS ratings
 *
 * Output: writes to scripts/output/<league>_matchday.json
 */

const UNDERSTAT_LEAGUES = {
  bundesliga: "Bundesliga",
  epl: "EPL",
  la_liga: "La_liga",
  serie_a: "Serie_A",
  ligue_1: "Ligue_1",
  eredivisie: "Eredivisie",
};

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SOS = args.includes("--sos");
const leagueArg = args.find((_, i) => args[i - 1] === "--league") || "bundesliga";
const seasonArg = args.find((_, i) => args[i - 1] === "--season") || "2025";
const windowArg = parseInt(args.find((_, i) => args[i - 1] === "--window") || "8");

function decodeHex(str) {
  return str.replace(/\\x([\dA-Fa-f]{2})/g, (_, g1) =>
    String.fromCharCode(parseInt(g1, 16))
  );
}

async function scrapeUnderstatLeague(leagueSlug, season, window = 8) {
  const leagueName = UNDERSTAT_LEAGUES[leagueSlug];
  if (!leagueName) throw new Error(`Unknown league: ${leagueSlug}. Available: ${Object.keys(UNDERSTAT_LEAGUES).join(", ")}`);

  const url = `https://understat.com/league/${leagueName}/${season}`;
  console.log(`  Fetching: ${url}`);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (FODZE xG Scraper)" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);

  const html = await resp.text();

  // Extract teamsData
  const teamsMatch = html.match(/var teamsData\s*=\s*JSON\.parse\('([^']+)'\)/);
  if (!teamsMatch?.[1]) throw new Error("Could not find teamsData in HTML");
  const teamsData = JSON.parse(decodeHex(teamsMatch[1]));

  // Extract datesData (for SoS match-level data)
  let matchHistory = [];
  if (SOS) {
    const datesMatch = html.match(/var datesData\s*=\s*JSON\.parse\('([^']+)'\)/);
    if (datesMatch?.[1]) {
      const datesData = JSON.parse(decodeHex(datesMatch[1]));
      for (const m of datesData) {
        if (!m.isResult) continue;
        const date = m.datetime?.split(" ")[0] || "";
        const hTeam = m.h?.title || "";
        const aTeam = m.a?.title || "";
        const hXG = parseFloat(m.xG?.h) || 0;
        const aXG = parseFloat(m.xG?.a) || 0;
        matchHistory.push({ team: hTeam, opponent: aTeam, xg: hXG, xga: aXG, date });
        matchHistory.push({ team: aTeam, opponent: hTeam, xg: aXG, xga: hXG, date });
      }
    }
  }

  // Process team data
  const result = {};
  for (const t of Object.values(teamsData)) {
    const title = t.title;
    const history = t.history || [];
    const homeMatches = [];
    const awayMatches = [];

    for (const h of history) {
      if (!h.result) continue;
      const match = {
        date: h.datetime?.split(" ")[0] || "",
        xg: parseFloat(h.xG) || 0,
        xga: parseFloat(h.xGA) || 0,
        result: h.result,
      };
      if (h.h_a === "h") homeMatches.push(match);
      else awayMatches.push(match);
    }

    const h8 = homeMatches.slice(-window);
    const a8 = awayMatches.slice(-window);

    result[title] = {
      home: {
        matches: h8,
        xg_sum: +h8.reduce((s, m) => s + m.xg, 0).toFixed(2),
        xga_sum: +h8.reduce((s, m) => s + m.xga, 0).toFixed(2),
        games: h8.length,
      },
      away: {
        matches: a8,
        xg_sum: +a8.reduce((s, m) => s + m.xg, 0).toFixed(2),
        xga_sum: +a8.reduce((s, m) => s + m.xga, 0).toFixed(2),
        games: a8.length,
      },
    };
  }

  return { teams: result, matchHistory };
}

function computeSoSRatings(matches, leagueAvg, iterations = 10) {
  const teams = [...new Set(matches.map(m => m.team))];
  const ratings = {};
  for (const t of teams) {
    ratings[t] = { attackRating: 1.0, defenseRating: 1.0, sosAttack: 1.0, sosDefense: 1.0 };
  }

  const byTeam = {};
  for (const t of teams) byTeam[t] = matches.filter(m => m.team === t);

  for (let it = 0; it < iterations; it++) {
    const next = {};
    let sumAtk = 0, sumDef = 0, count = 0;

    for (const team of teams) {
      const tm = byTeam[team];
      if (!tm.length) continue;
      let adjXg = 0, adjXga = 0, oppDef = 0, oppAtk = 0;
      for (const m of tm) {
        const od = ratings[m.opponent]?.defenseRating || 1.0;
        const oa = ratings[m.opponent]?.attackRating || 1.0;
        adjXg += m.xg * (leagueAvg / Math.max(0.3, od));
        adjXga += m.xga * (leagueAvg / Math.max(0.3, oa));
        oppDef += od; oppAtk += oa;
      }
      const n = tm.length;
      next[team] = {
        attackRating: (adjXg / n) / leagueAvg,
        defenseRating: (adjXga / n) / leagueAvg,
        sosAttack: oppDef / n,
        sosDefense: oppAtk / n,
      };
      sumAtk += next[team].attackRating;
      sumDef += next[team].defenseRating;
      count++;
    }

    const mA = sumAtk / count, mD = sumDef / count;
    for (const t of teams) {
      if (!next[t]) continue;
      next[t].attackRating /= (mA || 1);
      next[t].defenseRating /= (mD || 1);
      Object.assign(ratings[t], next[t]);
    }
  }
  return ratings;
}

async function main() {
  console.log(`FODZE xG Scraper — ${leagueArg} ${seasonArg}`);
  console.log(`  Window: ${windowArg} games | SoS: ${SOS} | Dry: ${DRY}`);
  console.log();

  const { teams, matchHistory } = await scrapeUnderstatLeague(leagueArg, seasonArg, windowArg);

  console.log(`\n  Found ${Object.keys(teams).length} teams\n`);

  // Print xG summary
  const sorted = Object.entries(teams).sort(
    (a, b) => (b[1].home.xg_sum + b[1].away.xg_sum) - (a[1].home.xg_sum + a[1].away.xg_sum)
  );

  console.log("  Team                         | H-xG   H-xGA | A-xG   A-xGA | H-Gms A-Gms");
  console.log("  " + "-".repeat(80));
  for (const [name, data] of sorted) {
    const h = data.home, a = data.away;
    console.log(
      `  ${name.padEnd(30)} | ${h.xg_sum.toFixed(1).padStart(5)}  ${h.xga_sum.toFixed(1).padStart(5)} | ${a.xg_sum.toFixed(1).padStart(5)}  ${a.xga_sum.toFixed(1).padStart(5)} | ${String(h.games).padStart(5)} ${String(a.games).padStart(5)}`
    );
  }

  // SoS ratings
  if (SOS && matchHistory.length > 0) {
    const LEAGUE_AVGS = {
      bundesliga: 1.38, epl: 1.35, la_liga: 1.25,
      serie_a: 1.32, ligue_1: 1.30, eredivisie: 1.45,
    };
    const avg = LEAGUE_AVGS[leagueArg] || 1.35;
    const sosRatings = computeSoSRatings(matchHistory, avg);

    console.log("\n  SoS Ratings:");
    console.log("  Team                         | AtkRat  DefRat | SoS-Atk SoS-Def");
    console.log("  " + "-".repeat(70));
    const sosSorted = Object.entries(sosRatings).sort((a, b) => b[1].attackRating - a[1].attackRating);
    for (const [name, r] of sosSorted) {
      console.log(
        `  ${name.padEnd(30)} | ${r.attackRating.toFixed(3).padStart(6)}  ${r.defenseRating.toFixed(3).padStart(6)} | ${r.sosAttack.toFixed(3).padStart(7)} ${r.sosDefense.toFixed(3).padStart(7)}`
      );
    }
  }

  // Write output JSON (format compatible with seed-matchday.mjs)
  if (!DRY) {
    const { mkdirSync, writeFileSync } = await import("fs");
    const outDir = new URL("./output", import.meta.url).pathname;
    mkdirSync(outDir, { recursive: true });
    const outFile = `${outDir}/${leagueArg}_xg_${seasonArg}.json`;

    const output = {
      league: leagueArg,
      season: seasonArg,
      window: windowArg,
      scraped_at: new Date().toISOString(),
      source: "understat",
      teams,
    };

    writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`\n  Written to ${outFile}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

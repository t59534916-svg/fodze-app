#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// FODZE – 3. Liga Historical Data Seed Script
// Scraped kicker.de Spieltag-Archiv → Rolling 8-Game Windows → Supabase
//
// Verwendung:
//   node scripts/seed-3liga-history.mjs [--seasons 2023-24,2024-25]
//
// Standardmäßig: 2020-21 bis 2024-25 (5 Saisons)
// Nutzt Service Role Key (umgeht RLS, kein Login nötig)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import { load } from "cheerio";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.FODZE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars: SUPABASE_URL and FODZE_SERVICE_KEY required");
  process.exit(1);
}

const ALL_SEASONS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"];
const MATCHDAYS_PER_SEASON = 38;
const MIN_MATCHDAY = 2; // Ab Spieltag 2 (ST 1 hat 0 History)
const RATE_LIMIT_MS = 2500; // 2.5s zwischen Requests (kicker.de freundlich)

// ─── Team-Name Normalisierung ──────────────────────────────────────
const TEAM_ALIASES = {
  "Vikt. Köln": "FC Viktoria Köln", "FC Vikt. Köln": "FC Viktoria Köln",
  "Cottbus": "Energie Cottbus", "Rostock": "Hansa Rostock",
  "Bielefeld": "Arminia Bielefeld", "Dresden": "Dynamo Dresden",
  "Saarbrücken": "1. FC Saarbrücken", "Essen": "Rot-Weiss Essen",
  "Aachen": "Alemannia Aachen", "München": "TSV 1860 München",
  "1860 München": "TSV 1860 München", "Verl": "SC Verl",
  "Stuttgart II": "VfB Stuttgart II", "Unterhaching": "SpVgg Unterhaching",
  "Wiesbaden": "SV Wehen Wiesbaden", "Mannheim": "SV Waldhof Mannheim",
  "Waldhof Mannheim": "SV Waldhof Mannheim", "Hannover II": "Hannover 96 II",
  "Ingolstadt": "FC Ingolstadt 04", "Osnabrück": "VfL Osnabrück",
  "Dortmund II": "Borussia Dortmund II", "BVB II": "Borussia Dortmund II",
  "Aue": "Erzgebirge Aue", "Duisburg": "MSV Duisburg",
  "Sandhausen": "SV Sandhausen", "Elversberg": "SV 07 Elversberg",
  "Ulm": "SSV Ulm 1846", "Havelse": "TSV Havelse",
  "Schweinfurt": "1. FC Schweinfurt 05", "Regensburg": "Jahn Regensburg",
  "SSV Jahn Regensburg": "Jahn Regensburg",
  "Hoffenheim II": "TSG Hoffenheim II", "TSG 1899 Hoffenheim II": "TSG Hoffenheim II",
  "Halle": "Hallescher FC", "HFC": "Hallescher FC",
  "Freiburg II": "SC Freiburg II", "Lübeck": "VfB Lübeck",
  "Meppen": "SV Meppen", "Magdeburg": "1. FC Magdeburg",
  "Kaiserslautern": "1. FC Kaiserslautern", "FCK": "1. FC Kaiserslautern",
  "Türkgücü": "Türkgücü München", "Türkgücü Münch.": "Türkgücü München",
  "Uerdingen": "KFC Uerdingen 05", "Würzburg": "Würzburger Kickers",
  "Viktoria Berlin": "FC Viktoria 1889 Berlin",
  "Bayern II": "FC Bayern München II", "Bayern München II": "FC Bayern München II",
  "Zwickau": "FSV Zwickau", "Wiesbaden II": "SV Wehen Wiesbaden",
  "Münster": "Preußen Münster", "Braunschweig": "Eintracht Braunschweig",
  "Saarb.": "1. FC Saarbrücken", "Lok Leipzig": "1. FC Lok Leipzig",
  "Oldenburg": "VfB Oldenburg",
  "SSV Ulm 1846 Fußball": "SSV Ulm 1846",
  "Preußen Münster": "Preußen Münster",
  "SV Wehen Wiesbaden": "SV Wehen Wiesbaden",
  "Eintracht Braunschweig": "Eintracht Braunschweig",
  "1. FC Magdeburg": "1. FC Magdeburg",
  "1. FC Kaiserslautern": "1. FC Kaiserslautern",
  "Türkgücü München": "Türkgücü München",
  "KFC Uerdingen 05": "KFC Uerdingen 05",
  "FSV Zwickau": "FSV Zwickau",
  "Würzburger Kickers": "Würzburger Kickers",
  "FC Bayern München II": "FC Bayern München II",
  "SC Freiburg II": "SC Freiburg II",
  "VfB Oldenburg": "VfB Oldenburg",
  "SV Meppen": "SV Meppen",
  "Hallescher FC": "Hallescher FC",
  "VfB Lübeck": "VfB Lübeck",
};

function normalizeName(raw) {
  const name = raw.trim();
  if (TEAM_ALIASES[name]) return TEAM_ALIASES[name];
  // Try partial match
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (name.includes(alias) || alias.includes(name)) return canonical;
  }
  return name; // Return as-is if no alias found
}

// ─── Kicker.de Scraper ─────────────────────────────────────────────
async function fetchMatchday(season, matchday) {
  const url = `https://www.kicker.de/3-liga/spieltag/${season}/${matchday}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!resp.ok) {
    console.error(`  HTTP ${resp.status} for ${url}`);
    return [];
  }

  const html = await resp.text();
  const $ = load(html);

  // Extract from JSON-LD (team names + dates)
  const jsonLdEvents = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).text());
      const arr = Array.isArray(data) ? data : [data];
      for (const e of arr) {
        if (e["@type"] === "SportsEvent") {
          jsonLdEvents.push({
            home: decodeHtmlEntities(e.homeTeam?.name || ""),
            away: decodeHtmlEntities(e.awayTeam?.name || ""),
            date: e.startDate ? e.startDate.substring(0, 10) : "",
            kickoff: e.startDate ? e.startDate.substring(11, 16) : "",
          });
        }
      }
    } catch (e) {}
  });

  // Extract scores from match card elements
  const matches = [];
  const matchCards = $('a[href*="-gegen-"]')
    .filter((_, el) => ($(el).attr("href") || "").includes("liga-"))
    .closest("[class*=GameCard], div")
    .filter((_, el) => $(el).text().includes(":"));

  matchCards.each((i, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    // Pattern: "TeamA ShortA X : Y HZ1 : HZ2 TeamB ShortB" or similar
    const scoreMatch = text.match(/(\d+)\s*:\s*(\d+)/);
    if (!scoreMatch) return;

    const homeGoals = parseInt(scoreMatch[1]);
    const awayGoals = parseInt(scoreMatch[2]);

    // Get team names from JSON-LD (more reliable)
    if (jsonLdEvents[i]) {
      matches.push({
        home: normalizeName(jsonLdEvents[i].home),
        away: normalizeName(jsonLdEvents[i].away),
        home_goals: homeGoals,
        away_goals: awayGoals,
        date: jsonLdEvents[i].date,
        kickoff: jsonLdEvents[i].kickoff,
      });
    }
  });

  return matches;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

// ─── Rolling 8-Game Window Computation ─────────────────────────────
function computeRollingWindows(allMatches) {
  // Sort by date
  allMatches.sort((a, b) => a.date.localeCompare(b.date));

  const homeHistory = {}; // team → [{scored, conceded}, ...]
  const awayHistory = {};

  const enriched = [];

  for (const match of allMatches) {
    const { home, away, home_goals, away_goals } = match;

    // Initialize histories
    if (!homeHistory[home]) homeHistory[home] = [];
    if (!awayHistory[away]) awayHistory[away] = [];

    // SNAPSHOT current rolling windows BEFORE adding this match
    const hHist = homeHistory[home];
    const aHist = awayHistory[away];

    const xg_h8 = hHist.reduce((s, m) => s + m.scored, 0);
    const xga_h8 = hHist.reduce((s, m) => s + m.conceded, 0);
    const xg_a8 = aHist.reduce((s, m) => s + m.scored, 0);
    const xga_a8 = aHist.reduce((s, m) => s + m.conceded, 0);
    const games_h = hHist.length;
    const games_a = aHist.length;

    enriched.push({
      ...match,
      xg_h8: Math.round(xg_h8 * 10) / 10,
      xga_h8: Math.round(xga_h8 * 10) / 10,
      xg_a8: Math.round(xg_a8 * 10) / 10,
      xga_a8: Math.round(xga_a8 * 10) / 10,
      games_h: Math.max(games_h, 1), // min 1 to avoid division by zero
      games_a: Math.max(games_a, 1),
      hasEnoughData: games_h >= 1 && games_a >= 1,
    });

    // ADD this match result to rolling windows
    homeHistory[home].push({ scored: home_goals, conceded: away_goals });
    if (homeHistory[home].length > 8) homeHistory[home].shift();

    awayHistory[away].push({ scored: away_goals, conceded: home_goals });
    if (awayHistory[away].length > 8) awayHistory[away].shift();
  }

  return enriched;
}

// ─── Build Matchday JSONs ──────────────────────────────────────────
function buildMatchdayJsons(enrichedMatches, season) {
  // Group by matchday number
  const byMatchday = {};
  let mdCounter = 0;
  let lastDate = "";

  // Since kicker gives us matches per spieltag, we tag them during scraping
  for (const m of enrichedMatches) {
    if (!byMatchday[m.matchday]) byMatchday[m.matchday] = [];
    byMatchday[m.matchday].push(m);
  }

  const seasonLabel = season.replace("-", "/");
  const results = [];

  for (const [md, matches] of Object.entries(byMatchday).sort((a, b) => a[0] - b[0])) {
    const mdNum = parseInt(md);
    if (mdNum < MIN_MATCHDAY) continue;

    // Filter matches with enough rolling data
    const validMatches = matches.filter((m) => m.hasEnoughData);
    if (validMatches.length < 3) continue; // Skip if too few valid matches

    const firstDate = validMatches[0]?.date || "";

    const matchdayJson = {
      league: "3. Liga",
      matchday: `Spieltag ${mdNum}`,
      season: seasonLabel,
      date: firstDate,
      matches: validMatches.map((m) => ({
        home: {
          name: m.home,
          xg_h8: m.xg_h8,
          xga_h8: m.xga_h8,
          games: m.games_h,
          form: "",
          injuries: "",
          yellow_risk: "",
          notes: "historisch (Tor-Proxy)",
        },
        away: {
          name: m.away,
          xg_a8: m.xg_a8,
          xga_a8: m.xga_a8,
          games: m.games_a,
          form: "",
          injuries: "",
          yellow_risk: "",
          notes: "historisch (Tor-Proxy)",
        },
        tags: [],
        context: "",
        referee: "",
        kickoff: m.kickoff || "",
        result: { home: m.home_goals, away: m.away_goals },
      })),
      data_confidence: "LOW",
      sources: ["kicker.de (historische Ergebnisse, Tore als xG-Proxy)"],
      historical: true,
    };

    results.push({ mdNum, label: `Spieltag ${mdNum} (${seasonLabel})`, date: firstDate, data: matchdayJson });
  }

  return results;
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Parse optional --seasons flag
  let seasons = ALL_SEASONS;
  const seasonsIdx = args.indexOf("--seasons");
  if (seasonsIdx !== -1 && args[seasonsIdx + 1]) {
    seasons = args[seasonsIdx + 1].split(",");
  }

  // 1. Supabase mit Service Role Key (umgeht RLS)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log("Verbunden mit Supabase (Service Role)\n");

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const season of seasons) {
    const seasonLabel = season.replace("-", "/");
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  SAISON ${seasonLabel}`);
    console.log(`${"═".repeat(60)}`);

    // 2. Scrape all matchdays for this season
    console.log(`Scrape ${MATCHDAYS_PER_SEASON} Spieltage von kicker.de...`);
    const allMatches = [];

    for (let md = 1; md <= MATCHDAYS_PER_SEASON; md++) {
      process.stdout.write(`  Spieltag ${md}/${MATCHDAYS_PER_SEASON}... `);
      const matches = await fetchMatchday(season, md);

      if (matches.length === 0) {
        console.log("keine Spiele (Saison evtl. kürzer)");
        continue;
      }

      // Tag matches with matchday number
      for (const m of matches) {
        m.matchday = md;
      }
      allMatches.push(...matches);
      console.log(`${matches.length} Spiele`);

      // Rate limiting
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    console.log(`\n  Gesamt: ${allMatches.length} Spiele gescraped`);

    if (allMatches.length === 0) {
      console.log("  Überspringe Saison (keine Daten)");
      continue;
    }

    // 3. Compute rolling windows
    console.log("  Berechne Rolling 8-Game Windows...");
    const enriched = computeRollingWindows(allMatches);

    // 4. Build matchday JSONs
    const matchdays = buildMatchdayJsons(enriched, season);
    console.log(`  ${matchdays.length} Spieltage mit genug Daten (ab ST ${MIN_MATCHDAY})`);

    // 5. Insert into Supabase
    console.log("  Füge in Supabase ein...");
    for (const md of matchdays) {
      // Check if already exists (resumability)
      const { data: existing } = await supabase
        .from("matchdays")
        .select("id")
        .eq("league", "liga3")
        .eq("matchday_label", md.label)
        .limit(1);

      if (existing && existing.length > 0) {
        totalSkipped++;
        continue;
      }

      const { error: insertError } = await supabase.from("matchdays").insert({
        league: "liga3",
        matchday_label: md.label,
        match_date: md.date,
        data: md.data,
        created_by: null,
      });

      if (insertError) {
        console.error(`    FEHLER bei ${md.label}: ${insertError.message}`);
      } else {
        totalInserted++;
      }
    }

    console.log(`  ✓ ${season} fertig (${matchdays.length - totalSkipped} eingefügt, ${totalSkipped} übersprungen)`);
    totalSkipped = 0; // Reset per season
  }

  // 6. Final verification
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ZUSAMMENFASSUNG`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Gesamt eingefügt: ${totalInserted} Spieltage`);

  const { data: allMd } = await supabase
    .from("matchdays")
    .select("matchday_label")
    .eq("league", "liga3")
    .order("matchday_label", { ascending: true });

  console.log(`  Spieltage in DB: ${allMd?.length || 0}`);
  if (allMd?.length) {
    console.log(`  Erster: ${allMd[0].matchday_label}`);
    console.log(`  Letzter: ${allMd[allMd.length - 1].matchday_label}`);
  }

  console.log("\n✓ Fertig!");
}

main().catch(console.error);

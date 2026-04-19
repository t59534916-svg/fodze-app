import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { load } from "cheerio";

// ═══════════════════════════════════════════════════════════════════
// FODZE – 3. Liga Historical Seed API Route
// GET /api/seed-history?seasons=2023-24,2024-25
// Must be called while logged in (uses session cookie)
// ═══════════════════════════════════════════════════════════════════

const ALL_SEASONS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"];
const MATCHDAYS_PER_SEASON = 38;
const MIN_MATCHDAY = 5;
const RATE_LIMIT_MS = 2500;

// ─── Team-Name Normalisierung ──────────────────────────────────────
const TEAM_ALIASES: Record<string, string> = {
  "Vikt. Köln": "FC Viktoria Köln", "FC Vikt. Köln": "FC Viktoria Köln",
  "Cottbus": "Energie Cottbus", "Rostock": "Hansa Rostock",
  "Bielefeld": "Arminia Bielefeld", "Dresden": "Dynamo Dresden",
  "Saarbrücken": "1. FC Saarbrücken", "Saarb.": "1. FC Saarbrücken",
  "Essen": "Rot-Weiss Essen", "Aachen": "Alemannia Aachen",
  "München": "TSV 1860 München", "1860 München": "TSV 1860 München",
  "Verl": "SC Verl", "Stuttgart II": "VfB Stuttgart II",
  "Unterhaching": "SpVgg Unterhaching", "Wiesbaden": "SV Wehen Wiesbaden",
  "Mannheim": "SV Waldhof Mannheim", "Waldhof Mannheim": "SV Waldhof Mannheim",
  "Hannover II": "Hannover 96 II", "Ingolstadt": "FC Ingolstadt 04",
  "Osnabrück": "VfL Osnabrück", "Dortmund II": "Borussia Dortmund II",
  "BVB II": "Borussia Dortmund II", "Aue": "Erzgebirge Aue",
  "Duisburg": "MSV Duisburg", "Sandhausen": "SV Sandhausen",
  "Elversberg": "SV 07 Elversberg", "Ulm": "SSV Ulm 1846",
  "SSV Ulm 1846 Fußball": "SSV Ulm 1846",
  "Havelse": "TSV Havelse", "Schweinfurt": "1. FC Schweinfurt 05",
  "Regensburg": "Jahn Regensburg", "SSV Jahn Regensburg": "Jahn Regensburg",
  "Hoffenheim II": "TSG Hoffenheim II", "TSG 1899 Hoffenheim II": "TSG Hoffenheim II",
  "Halle": "Hallescher FC", "HFC": "Hallescher FC",
  "Freiburg II": "SC Freiburg II", "Lübeck": "VfB Lübeck",
  "Meppen": "SV Meppen", "Magdeburg": "1. FC Magdeburg",
  "Kaiserslautern": "1. FC Kaiserslautern", "FCK": "1. FC Kaiserslautern",
  "Türkgücü": "Türkgücü München", "Türkgücü Münch.": "Türkgücü München",
  "Uerdingen": "KFC Uerdingen 05", "Würzburg": "Würzburger Kickers",
  "Bayern II": "FC Bayern München II", "Bayern München II": "FC Bayern München II",
  "Zwickau": "FSV Zwickau", "Münster": "Preußen Münster",
  "Braunschweig": "Eintracht Braunschweig", "Oldenburg": "VfB Oldenburg",
};

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (TEAM_ALIASES[name]) return TEAM_ALIASES[name];
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (name.includes(alias) || alias.includes(name)) return canonical;
  }
  return name;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

// ─── Kicker.de Scraper ─────────────────────────────────────────────
interface Match {
  home: string; away: string;
  home_goals: number; away_goals: number;
  date: string; kickoff: string; matchday: number;
}

async function fetchMatchday(season: string, matchday: number): Promise<Match[]> {
  const url = `https://www.kicker.de/3-liga/spieltag/${season}/${matchday}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!resp.ok) return [];

  const html = await resp.text();
  const $ = load(html);

  const jsonLdEvents: { home: string; away: string; date: string; kickoff: string }[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
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
    } catch (err) {
      // kicker.de occasionally ships malformed JSON-LD in some ads/trackers.
      // Skipping is correct — match data lives in separate SportsEvent nodes.
      // Log so a full schema change doesn't produce a silent zero-match run.
      console.warn("[FODZE] seed-history JSON-LD parse skipped:", (err as Error).message);
    }
  });

  const matches: Match[] = [];
  const cards = $('a[href*="-gegen-"]')
    .filter((_, el) => ($(el).attr("href") || "").includes("liga-"))
    .closest("div")
    .filter((_, el) => $(el).text().includes(":"));

  cards.each((i, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const scoreMatch = text.match(/(\d+)\s*:\s*(\d+)/);
    if (!scoreMatch || !jsonLdEvents[i]) return;

    matches.push({
      home: normalizeName(jsonLdEvents[i].home),
      away: normalizeName(jsonLdEvents[i].away),
      home_goals: parseInt(scoreMatch[1]),
      away_goals: parseInt(scoreMatch[2]),
      date: jsonLdEvents[i].date,
      kickoff: jsonLdEvents[i].kickoff,
      matchday,
    });
  });

  return matches;
}

// ─── Rolling Windows ───────────────────────────────────────────────
interface EnrichedMatch extends Match {
  xg_h8: number; xga_h8: number; xg_a8: number; xga_a8: number;
  games_h: number; games_a: number; hasEnoughData: boolean;
}

function computeRollingWindows(allMatches: Match[]): EnrichedMatch[] {
  allMatches.sort((a, b) => a.date.localeCompare(b.date));

  const homeHistory: Record<string, { scored: number; conceded: number }[]> = {};
  const awayHistory: Record<string, { scored: number; conceded: number }[]> = {};
  const enriched: EnrichedMatch[] = [];

  for (const match of allMatches) {
    const { home, away, home_goals, away_goals } = match;
    if (!homeHistory[home]) homeHistory[home] = [];
    if (!awayHistory[away]) awayHistory[away] = [];

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
      games_h: Math.max(games_h, 1),
      games_a: Math.max(games_a, 1),
      hasEnoughData: games_h >= 3 && games_a >= 3,
    });

    homeHistory[home].push({ scored: home_goals, conceded: away_goals });
    if (homeHistory[home].length > 8) homeHistory[home].shift();
    awayHistory[away].push({ scored: away_goals, conceded: home_goals });
    if (awayHistory[away].length > 8) awayHistory[away].shift();
  }

  return enriched;
}

// ─── API Handler ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Auth via cookie session
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Nicht eingeloggt. Bitte zuerst in der App einloggen." }, { status: 401 });
  }

  // Parse seasons from query
  const seasonsParam = req.nextUrl.searchParams.get("seasons");
  const seasons = seasonsParam ? seasonsParam.split(",") : ALL_SEASONS;

  const log: string[] = [];
  let totalInserted = 0;

  for (const season of seasons) {
    const seasonLabel = season.replace("-", "/");
    log.push(`\n═══ SAISON ${seasonLabel} ═══`);

    // Scrape all matchdays
    const allMatches: Match[] = [];
    for (let md = 1; md <= MATCHDAYS_PER_SEASON; md++) {
      const matches = await fetchMatchday(season, md);
      if (matches.length === 0) {
        log.push(`  ST ${md}: keine Spiele`);
        continue;
      }
      allMatches.push(...matches);
      log.push(`  ST ${md}: ${matches.length} Spiele`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    log.push(`  Gesamt: ${allMatches.length} Spiele`);
    if (allMatches.length === 0) continue;

    // Compute rolling windows
    const enriched = computeRollingWindows(allMatches);

    // Group by matchday and build JSONs
    const byMatchday: Record<number, EnrichedMatch[]> = {};
    for (const m of enriched) {
      if (!byMatchday[m.matchday]) byMatchday[m.matchday] = [];
      byMatchday[m.matchday].push(m);
    }

    for (const [mdStr, matches] of Object.entries(byMatchday).sort((a, b) => +a[0] - +b[0])) {
      const mdNum = parseInt(mdStr);
      if (mdNum < MIN_MATCHDAY) continue;

      const validMatches = matches.filter((m) => m.hasEnoughData);
      if (validMatches.length < 3) continue;

      const label = `Spieltag ${mdNum} (${seasonLabel})`;

      // Resumability check
      const { data: existing } = await supabase
        .from("matchdays").select("id").eq("league", "liga3").eq("matchday_label", label).limit(1);
      if (existing && existing.length > 0) continue;

      const matchdayJson = {
        league: "3. Liga", matchday: `Spieltag ${mdNum}`, season: seasonLabel,
        date: validMatches[0]?.date || "",
        matches: validMatches.map((m) => ({
          home: { name: m.home, xg_h8: m.xg_h8, xga_h8: m.xga_h8, games: m.games_h,
            form: "", injuries: "", yellow_risk: "", notes: "historisch (Tor-Proxy)" },
          away: { name: m.away, xg_a8: m.xg_a8, xga_a8: m.xga_a8, games: m.games_a,
            form: "", injuries: "", yellow_risk: "", notes: "historisch (Tor-Proxy)" },
          tags: [], context: "", referee: "", kickoff: m.kickoff || "",
          result: { home: m.home_goals, away: m.away_goals },
        })),
        data_confidence: "LOW",
        sources: ["kicker.de (historische Ergebnisse, Tore als xG-Proxy)"],
        historical: true,
      };

      const { error } = await supabase.from("matchdays").insert({
        league: "liga3", matchday_label: label,
        match_date: validMatches[0]?.date || null,
        data: matchdayJson, created_by: user.id,
      });

      if (error) {
        log.push(`  FEHLER ${label}: ${error.message}`);
      } else {
        totalInserted++;
      }
    }

    log.push(`  ✓ ${seasonLabel} fertig`);
  }

  // Final count
  const { data: allMd } = await supabase
    .from("matchdays").select("matchday_label")
    .eq("league", "liga3").order("matchday_label");

  return NextResponse.json({
    success: true,
    inserted: totalInserted,
    totalInDb: allMd?.length || 0,
    log,
  });
}

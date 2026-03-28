// ═══════════════════════════════════════════════════════════════════════
// FODZE Understat Scraper — Deterministic xG Data
// Extracts team xG from Understat's embedded JSON (no headless browser)
// Covers: Bundesliga, EPL, La Liga, Serie A, Ligue 1, Eredivisie
// ═══════════════════════════════════════════════════════════════════════

import { load } from "cheerio";

export interface UnderstatMatch {
  date: string;
  xg: number;
  xga: number;
  opponent: string;
  result: string;
  isHome: boolean;
}

export interface UnderstatTeamXG {
  team: string;
  venue: "home" | "away";
  matches: UnderstatMatch[];
  xg_sum: number;
  xga_sum: number;
  games: number;
}

// Understat league slugs
export const UNDERSTAT_LEAGUES: Record<string, string> = {
  bundesliga: "Bundesliga",
  epl: "EPL",
  la_liga: "La_liga",
  serie_a: "Serie_A",
  ligue_1: "Ligue_1",
  eredivisie: "Eredivisie",
};

/**
 * Decode Understat's hex-escaped JSON strings (\x22 → ", etc.)
 */
function decodeHex(str: string): string {
  return str.replace(/\\x([\dA-Fa-f]{2})/g, (_, g1) =>
    String.fromCharCode(parseInt(g1, 16))
  );
}

/**
 * Scrape an entire league's team data from Understat.
 * Returns all teams with their last N home/away matches.
 */
export async function scrapeUnderstatLeague(
  leagueSlug: string,
  season: string,
  window: number = 8
): Promise<Record<string, { home: UnderstatTeamXG; away: UnderstatTeamXG }>> {
  const leagueName = UNDERSTAT_LEAGUES[leagueSlug];
  if (!leagueName) throw new Error(`Unknown Understat league: ${leagueSlug}`);

  const url = `https://understat.com/league/${leagueName}/${season}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (FODZE xG Scraper)" },
  });
  if (!response.ok) throw new Error(`Understat ${response.status}: ${url}`);

  const html = await response.text();
  const $ = load(html);

  // Extract teamsData JSON from <script> tags
  let teamsDataStr = "";
  $("script").each((_, el) => {
    const text = $(el).html();
    if (text && text.includes("var teamsData")) {
      const match = text.match(
        /var teamsData\s*=\s*JSON\.parse\('([^']+)'\)/
      );
      if (match?.[1]) teamsDataStr = match[1];
    }
  });

  if (!teamsDataStr) {
    throw new Error(`Could not extract teamsData from ${url}`);
  }

  const decoded: Record<string, any> = JSON.parse(decodeHex(teamsDataStr));

  // Build team ID → name lookup
  const idToName: Record<string, string> = {};
  for (const t of Object.values(decoded)) {
    idToName[t.id] = t.title;
  }

  const result: Record<string, { home: UnderstatTeamXG; away: UnderstatTeamXG }> = {};

  for (const t of Object.values(decoded) as any[]) {
    const title: string = t.title;
    const history: any[] = t.history || [];

    const homeMatches: UnderstatMatch[] = [];
    const awayMatches: UnderstatMatch[] = [];

    for (const h of history) {
      if (!h.result) continue;

      // Determine opponent from match IDs
      const oppId = h.h_a === "h" ? String(h.id).split("_")[0] : String(h.id).split("_")[0];
      // Understat history doesn't directly expose opponent name, but we can derive it:
      // Each match has xG/xGA from this team's perspective
      const opponentName = ""; // Will be enriched below

      const match: UnderstatMatch = {
        date: h.datetime?.split(" ")[0] || "",
        xg: parseFloat(h.xG) || 0,
        xga: parseFloat(h.xGA) || 0,
        opponent: opponentName,
        result: h.result,
        isHome: h.h_a === "h",
      };

      if (h.h_a === "h") homeMatches.push(match);
      else awayMatches.push(match);
    }

    // Take last N matches per venue
    const h = homeMatches.slice(-window);
    const a = awayMatches.slice(-window);

    result[title] = {
      home: {
        team: title,
        venue: "home",
        matches: h,
        xg_sum: +h.reduce((s, m) => s + m.xg, 0).toFixed(2),
        xga_sum: +h.reduce((s, m) => s + m.xga, 0).toFixed(2),
        games: h.length,
      },
      away: {
        team: title,
        venue: "away",
        matches: a,
        xg_sum: +a.reduce((s, m) => s + m.xg, 0).toFixed(2),
        xga_sum: +a.reduce((s, m) => s + m.xga, 0).toFixed(2),
        games: a.length,
      },
    };
  }

  return result;
}

/**
 * Scrape a single team's xG data.
 * Convenience wrapper for when you only need one team.
 */
export async function scrapeUnderstatTeam(
  leagueSlug: string,
  season: string,
  teamName: string,
  window: number = 8
): Promise<{ home: UnderstatTeamXG; away: UnderstatTeamXG } | null> {
  const all = await scrapeUnderstatLeague(leagueSlug, season, window);

  // Fuzzy match: try exact first, then case-insensitive contains
  if (all[teamName]) return all[teamName];

  const lowerName = teamName.toLowerCase();
  for (const [key, val] of Object.entries(all)) {
    if (key.toLowerCase() === lowerName || key.toLowerCase().includes(lowerName)) {
      return val;
    }
  }

  return null;
}

/**
 * Extract per-match xG history for a league (for SoS computation).
 * Returns flat array of { team, opponent, venue, xg, xga, date }.
 */
export async function scrapeUnderstatMatchHistory(
  leagueSlug: string,
  season: string
): Promise<Array<{
  team: string;
  opponent: string;
  venue: "home" | "away";
  xg: number;
  xga: number;
  date: string;
}>> {
  const leagueName = UNDERSTAT_LEAGUES[leagueSlug];
  if (!leagueName) throw new Error(`Unknown Understat league: ${leagueSlug}`);

  const url = `https://understat.com/league/${leagueName}/${season}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (FODZE xG Scraper)" },
  });
  if (!response.ok) throw new Error(`Understat ${response.status}: ${url}`);

  const html = await response.text();
  const $ = load(html);

  // Extract datesData JSON (contains all matches with both teams' xG)
  let datesDataStr = "";
  $("script").each((_, el) => {
    const text = $(el).html();
    if (text && text.includes("var datesData")) {
      const match = text.match(
        /var datesData\s*=\s*JSON\.parse\('([^']+)'\)/
      );
      if (match?.[1]) datesDataStr = match[1];
    }
  });

  if (!datesDataStr) {
    throw new Error(`Could not extract datesData from ${url}`);
  }

  const matches: any[] = JSON.parse(decodeHex(datesDataStr));
  const result: Array<{
    team: string; opponent: string; venue: "home" | "away";
    xg: number; xga: number; date: string;
  }> = [];

  for (const m of matches) {
    if (!m.isResult) continue;
    const date = m.datetime?.split(" ")[0] || "";
    const homeTeam = m.h?.title || m.h?.short_title || "";
    const awayTeam = m.a?.title || m.a?.short_title || "";
    const homeXG = parseFloat(m.xG?.h) || 0;
    const awayXG = parseFloat(m.xG?.a) || 0;

    // Home team perspective
    result.push({
      team: homeTeam, opponent: awayTeam, venue: "home",
      xg: homeXG, xga: awayXG, date,
    });
    // Away team perspective
    result.push({
      team: awayTeam, opponent: homeTeam, venue: "away",
      xg: awayXG, xga: homeXG, date,
    });
  }

  return result;
}

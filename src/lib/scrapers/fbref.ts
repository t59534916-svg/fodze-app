// ═══════════════════════════════════════════════════════════════════════
// FODZE FBref Scraper — Fallback for non-Understat leagues
// Covers: 2. Bundesliga, 3. Liga, Championship, etc.
// Uses goals as proxy when xG columns are unavailable
// ═══════════════════════════════════════════════════════════════════════

import { load } from "cheerio";

export interface FBrefMatch {
  date: string;
  opponent: string;
  venue: "home" | "away";
  goals_for: number;
  goals_against: number;
  xg_for: number | null;    // null if not available
  xga_against: number | null;
}

export interface FBrefTeamStats {
  team: string;
  venue: "home" | "away";
  matches: FBrefMatch[];
  games: number;
  goals_sum: number;
  goals_against_sum: number;
  xg_sum: number | null;
  xga_sum: number | null;
  // Derived: use xG if available, otherwise goals as proxy
  effective_xg_sum: number;
  effective_xga_sum: number;
}

/**
 * Scrape a team's match-by-match stats from FBref's "Scores & Fixtures" page.
 * FBref rate-limits aggressively — add delays between requests.
 */
export async function scrapeFBrefTeam(
  teamUrl: string,
  venue: "home" | "away",
  window: number = 8
): Promise<FBrefTeamStats> {
  // FBref URLs look like: /en/squads/054efa67/Bayern-Munich-Stats
  // We need the "Scores & Fixtures" page: /en/squads/054efa67/2024-2025/matchlogs/all_comps/schedule/...
  // For simplicity, we scrape the main squad page which has a summary table

  const url = teamUrl.startsWith("http") ? teamUrl : `https://fbref.com${teamUrl}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`FBref ${response.status}: ${url}`);
  }

  const html = await response.text();
  const $ = load(html);

  const teamName = $("h1 span").first().text().trim() || "Unknown";
  const matches: FBrefMatch[] = [];

  // Try to find the Scores & Fixtures table
  const fixturesTable = $("#matchlogs_for");
  if (fixturesTable.length > 0) {
    fixturesTable.find("tbody tr").each((_, row) => {
      const cells = $(row).find("td, th");
      if (cells.length < 5) return;

      const date = $(cells[0]).text().trim();
      const venueCell = $(cells[1]).text().trim().toLowerCase();
      const matchVenue: "home" | "away" = venueCell === "away" ? "away" : "home";
      const opponent = $(cells[3]).text().trim();
      const goalsForStr = $(cells[4]).text().trim();
      const goalsAgainstStr = $(cells[5]).text().trim();

      // Try to extract xG columns if they exist
      const xgForCell = cells.length > 10 ? $(cells[10]).text().trim() : "";
      const xgaCell = cells.length > 11 ? $(cells[11]).text().trim() : "";

      const goalsFor = parseInt(goalsForStr) || 0;
      const goalsAgainst = parseInt(goalsAgainstStr) || 0;
      const xgFor = xgForCell ? parseFloat(xgForCell) || null : null;
      const xga = xgaCell ? parseFloat(xgaCell) || null : null;

      if (matchVenue === venue && date) {
        matches.push({
          date,
          opponent,
          venue: matchVenue,
          goals_for: goalsFor,
          goals_against: goalsAgainst,
          xg_for: xgFor,
          xga_against: xga,
        });
      }
    });
  }

  // Take last N matches
  const windowed = matches.slice(-window);
  const goalsSum = windowed.reduce((s, m) => s + m.goals_for, 0);
  const goalsAgainstSum = windowed.reduce((s, m) => s + m.goals_against, 0);

  const hasXG = windowed.every((m) => m.xg_for !== null);
  const xgSum = hasXG ? windowed.reduce((s, m) => s + (m.xg_for || 0), 0) : null;
  const xgaSum = hasXG ? windowed.reduce((s, m) => s + (m.xga_against || 0), 0) : null;

  return {
    team: teamName,
    venue,
    matches: windowed,
    games: windowed.length,
    goals_sum: goalsSum,
    goals_against_sum: goalsAgainstSum,
    xg_sum: xgSum ? +xgSum.toFixed(2) : null,
    xga_sum: xgaSum ? +xgaSum.toFixed(2) : null,
    // Use xG where available, goals as proxy otherwise
    effective_xg_sum: xgSum !== null ? +xgSum.toFixed(2) : goalsSum,
    effective_xga_sum: xgaSum !== null ? +xgaSum.toFixed(2) : goalsAgainstSum,
  };
}

/**
 * For leagues without Understat, compute goal-proxy xG.
 * Formula: proxy_xg = (goals / games) * window
 * This matches the existing FODZE convention from WORKFLOW.md.
 */
export function goalProxyXG(
  goalsScored: number,
  gamesCounted: number,
  window: number = 8
): number {
  if (gamesCounted <= 0) return 0;
  return +((goalsScored / gamesCounted) * window).toFixed(1);
}

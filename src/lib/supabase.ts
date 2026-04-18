import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OddsData, PlacedBet } from "@/types/match";
import { resolveTeam } from "@/lib/team-resolver";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─── Database helpers ───────────────────────────────────────────────

export async function saveMatchday(supabase: SupabaseClient, league: string, label: string, data: any, userId: string) {
  const { error } = await supabase.from("matchdays").insert({
    league, matchday_label: label, data, created_by: userId,
  });
  if (error) console.error("saveMatchday error:", error);
}

export async function loadLatestMatchday(supabase: SupabaseClient, league: string) {
  const { data, error } = await supabase
    .from("matchdays")
    .select("*")
    .eq("league", league)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data;
}

export async function saveOddsSnapshot(
  supabase: SupabaseClient, league: string, matchKey: string,
  homeTeam: string, awayTeam: string, odds: OddsData, userId: string
) {
  const { error } = await supabase.from("odds_snapshots").insert({
    league, match_key: matchKey, home_team: homeTeam,
    away_team: awayTeam, odds, created_by: userId,
  });
  if (error) console.error("saveOdds error:", error);
}

export async function loadOddsHistory(supabase: SupabaseClient, matchKey: string) {
  // Only fetch the two columns callers actually consume (snapshot_time, odds).
  // `.select("*")` previously pulled id/league/match_key/home_team/away_team/
  // created_by/created_at per row — 9 useless columns × 5-10 snapshots × 10
  // matches = ~100 KB wasted bandwidth per matchday load.
  const { data, error } = await supabase
    .from("odds_snapshots")
    .select("snapshot_time, odds")
    .eq("match_key", matchKey)
    .order("snapshot_time", { ascending: true });
  if (error) return [];
  return data || [];
}

export async function deleteOddsHistory(supabase: SupabaseClient, matchKey: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("odds_snapshots").delete().eq("match_key", matchKey).eq("created_by", user.id);
}

export async function loadProfile(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  return data;
}

export async function updateProfile(supabase: SupabaseClient, userId: string, updates: Partial<{ risk_profile: string; bankroll: number; display_name: string }>) {
  await supabase.from("profiles").update(updates).eq("id", userId);
}

export async function saveBet(supabase: SupabaseClient, bet: Omit<PlacedBet, "id" | "created_by" | "placed_at" | "settled_at" | "clv">, userId: string) {
  await supabase.from("bets").insert({ ...bet, created_by: userId });
}

export async function loadUserBets(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("bets")
    .select("*")
    .eq("created_by", userId)
    .order("placed_at", { ascending: false });
  return data || [];
}

// ─── Live Odds (from The-Odds-API via GitHub Actions cron) ──────────

export interface LiveOdds {
  league: string;
  event_id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  best_h: number | null;
  best_d: number | null;
  best_a: number | null;
  best_over25: number | null;
  best_under25: number | null;
  sharp_h: number | null;
  sharp_d: number | null;
  sharp_a: number | null;
  sharp_over25: number | null;
  sharp_under25: number | null;
  sharp_book: string | null;
  bookmakers: { h2h?: any[]; totals?: any[] };
  num_bookmakers: number;
  fetched_at: string;
}

// ─── Per-Match xG History (from Understat via scrape-understat.py) ──

export interface TeamXGMatch {
  team: string;
  opponent: string;
  venue: "home" | "away";
  match_date: string;
  xg: number;
  xga: number;
  npxg: number | null;   // Non-penalty xG (v2.0)
  npxga: number | null;  // Non-penalty xGA (v2.0)
  ppda_att: number | null;    // Pressing: passes attempted (v2.1)
  ppda_def: number | null;    // Pressing: defensive actions (v2.1)
  deep: number | null;        // Deep completions (v2.1)
  deep_allowed: number | null; // Deep completions conceded (v2.1)
  goals_for: number;
  goals_against: number;
}

/**
 * Load per-match xG history for a team (last N venue-specific matches).
 * Used by the engine for rolling xG windows and SoS computation.
 */
export async function loadTeamXGHistory(
  supabase: SupabaseClient,
  team: string,
  league: string,
  venue: "home" | "away",
  limit: number = 8
): Promise<TeamXGMatch[]> {
  // Exact match first (fast path when the resolver returns a mapped name)
  const exact = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("team", team)
    .eq("league", league)
    .eq("venue", venue)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (exact.error) { console.error("loadTeamXGHistory error:", exact.error); return []; }
  if (exact.data && exact.data.length > 0) return exact.data.reverse();

  // Fuzzy fallback: the exact name didn't match. Search by the most
  // distinctive word from the FODZE name — handles cases like
  // "Hannover 96" → "Hannover", "VfB Stuttgart" → "Stuttgart",
  // "1. FC Nürnberg" → "Nurnberg", "Borussia Mönchengladbach" → "Gladbach".
  const tokens = team
    .toLowerCase()
    .replace(/[._]/g, " ")
    .split(/\s+/)
    // Strip common abbreviations / noise words
    .filter((w) => w.length > 3 && !/^(fc|sc|sv|vfl|vfb|tsg|tsv|rb|afc|the|club)$/.test(w));
  if (tokens.length === 0) return [];
  // Pick the longest token — typically the city/club name, most distinctive
  const probe = tokens.sort((a, b) => b.length - a.length)[0];
  const fuzzy = await supabase
    .from("team_xg_history")
    .select("*")
    .ilike("team", `%${probe}%`)
    .eq("league", league)
    .eq("venue", venue)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (fuzzy.error || !fuzzy.data || fuzzy.data.length === 0) return [];
  return fuzzy.data.reverse();
}

/**
 * Load all match xG data for a league (for SoS computation).
 * Returns all matches from the current season.
 */
export async function loadLeagueXGHistory(
  supabase: SupabaseClient,
  league: string,
  seasonStartDate: string = "2024-07-01"
): Promise<TeamXGMatch[]> {
  const { data, error } = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("league", league)
    .eq("venue", "home") // One row per match (home perspective)
    .gte("match_date", seasonStartDate)
    .order("match_date", { ascending: true });
  if (error) { console.error("loadLeagueXGHistory error:", error); return []; }
  return data || [];
}

/**
 * Load ALL team_xg_history rows (home + away perspectives) for a league.
 * Used by the fuck-betting loader to batch-enrich matches — one query per
 * league instead of N per team. Caller buckets by (team, venue) in JS.
 *
 * Limit is generous (3000) because each team plays ~20 games per season
 * × 2 perspectives × 2 seasons = 80 rows/team × ~20 teams = ~1600 rows.
 * Drops to default if more rows exist (recent first, by match_date desc).
 */
export async function loadAllTeamXGHistory(
  supabase: SupabaseClient,
  league: string,
  limit: number = 3000
): Promise<TeamXGMatch[]> {
  const { data, error } = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("league", league)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (error) { console.error("loadAllTeamXGHistory error:", error); return []; }
  return data || [];
}

/**
 * Sanity-check per-match xG history before it flows into the engines.
 * Engines previously trusted any length-non-zero array, so a Supabase data
 * bug producing [{xg: 2.0}, {xg: 2.0}, …] (copy-paste) would cascade into
 * false-confident predictions. This flags suspicious data via console.warn
 * but does NOT block — operator sees the signal, engine still runs.
 *
 * Checks: chronological date order, plausible xG range (0 ≤ xg ≤ 5), not
 * all identical (variance > 0), and no long runs of identical values.
 */
export function validateXGHistory(
  entries: Array<{ xg: number; xga: number; date: string }>,
  context?: string,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!entries || entries.length === 0) return { ok: true, issues };

  for (const e of entries) {
    if (e.xg < 0 || e.xg > 5 || e.xga < 0 || e.xga > 5) {
      issues.push(`xG out of [0, 5]: ${e.date} xg=${e.xg} xga=${e.xga}`);
      break;
    }
  }

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].date < entries[i - 1].date) {
      issues.push(`chronology broken at ${entries[i].date}`);
      break;
    }
  }

  if (entries.length >= 3) {
    const xgs = entries.map(e => e.xg);
    const avg = xgs.reduce((s, v) => s + v, 0) / xgs.length;
    const variance = xgs.reduce((s, v) => s + (v - avg) ** 2, 0) / xgs.length;
    if (variance < 0.001) issues.push(`zero xG variance — suspicious duplicates`);

    // Only flag EXACTLY-identical values (to 0.001) — natural variance
    // can produce xG strings like [1.50, 1.50, 1.49] that are plausible,
    // but 3× exactly 1.500000 in a row indicates a data-pipeline bug.
    let runLen = 1;
    for (let i = 1; i < xgs.length; i++) {
      if (Math.abs(xgs[i] - xgs[i - 1]) < 0.001) {
        runLen++;
        if (runLen >= 3) {
          issues.push(`3+ identical xG values in a row — copy-paste?`);
          break;
        }
      } else runLen = 1;
    }
  }

  if (issues.length > 0) {
    console.warn(`[FODZE] xG history issue${context ? ` (${context})` : ""}:`, issues.join("; "));
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Convert Supabase TeamXGMatch rows to engine-compatible XGHistoryEntry format.
 * This bridges the Understat data to calcMatchEnhanced()'s hHistory/aHistory params.
 * Runs validateXGHistory as a side-effect for early warning.
 */
export function toXGHistoryEntries(matches: TeamXGMatch[], context?: string): Array<{
  xg: number; xga: number;
  npxg?: number; npxga?: number;
  ppda_att?: number; ppda_def?: number;
  deep?: number; deep_allowed?: number;
  date: string; opponent?: string;
}> {
  const entries = matches.map((m) => ({
    xg: m.xg,
    xga: m.xga,
    npxg: m.npxg ?? undefined,
    npxga: m.npxga ?? undefined,
    ppda_att: m.ppda_att ?? undefined,
    ppda_def: m.ppda_def ?? undefined,
    deep: m.deep ?? undefined,
    deep_allowed: m.deep_allowed ?? undefined,
    date: m.match_date,
    opponent: m.opponent || undefined,
  }));
  validateXGHistory(entries, context);
  return entries;
}

// ─── League Standings (computed from team_xg_history) ─────────────

export interface StandingsRow {
  team: string;       // Understat name
  fodzeName: string;  // FODZE display name
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  pos: number;
}

/**
 * Compute league standings from team_xg_history match data.
 * Uses home-venue rows (one per match) to derive both teams' results.
 */
export function computeStandings(matches: TeamXGMatch[]): StandingsRow[] {
  const stats = new Map<string, { w: number; d: number; l: number; gf: number; ga: number }>();

  const ensure = (t: string) => {
    if (!stats.has(t)) stats.set(t, { w: 0, d: 0, l: 0, gf: 0, ga: 0 });
    return stats.get(t)!;
  };

  for (const m of matches) {
    if (m.goals_for == null || m.goals_against == null) continue;
    const gH = m.goals_for;
    const gA = m.goals_against;

    // Home team
    const home = ensure(m.team);
    home.gf += gH;
    home.ga += gA;
    if (gH > gA) home.w++;
    else if (gH === gA) home.d++;
    else home.l++;

    // Away team (opponent)
    if (m.opponent) {
      const away = ensure(m.opponent);
      away.gf += gA;
      away.ga += gH;
      if (gA > gH) away.w++;
      else if (gA === gH) away.d++;
      else away.l++;
    }
  }

  const rows: StandingsRow[] = Array.from(stats.entries()).map(([team, s]) => {
    const resolved = resolveTeam(team);
    return {
      team,
      fodzeName: resolved?.fodze || team,
      played: s.w + s.d + s.l,
      won: s.w,
      drawn: s.d,
      lost: s.l,
      gf: s.gf,
      ga: s.ga,
      gd: s.gf - s.ga,
      points: s.w * 3 + s.d,
      pos: 0,
    };
  });

  // Sort: points DESC → gd DESC → gf DESC
  rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
  rows.forEach((r, i) => r.pos = i + 1);

  return rows;
}

/**
 * Load league standings by fetching all season matches and computing W/D/L.
 */
export async function loadLeagueStandings(
  supabase: SupabaseClient,
  league: string,
  seasonStartDate: string = "2025-07-01"
): Promise<StandingsRow[]> {
  const matches = await loadLeagueXGHistory(supabase, league, seasonStartDate);
  return computeStandings(matches);
}

export async function loadLiveOdds(supabase: SupabaseClient, league: string): Promise<LiveOdds[]> {
  const { data, error } = await supabase
    .from("live_odds")
    .select("*")
    .eq("league", league)
    .gte("commence_time", new Date().toISOString())
    .order("commence_time", { ascending: true });
  if (error) { console.error("loadLiveOdds error:", error); return []; }
  return data || [];
}

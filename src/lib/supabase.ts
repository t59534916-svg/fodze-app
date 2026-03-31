import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OddsData, PlacedBet } from "@/types/match";

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
  const { data, error } = await supabase
    .from("odds_snapshots")
    .select("*")
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
  const { data, error } = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("team", team)
    .eq("league", league)
    .eq("venue", venue)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (error) { console.error("loadTeamXGHistory error:", error); return []; }
  return (data || []).reverse(); // Chronological order (oldest first)
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
 * Convert Supabase TeamXGMatch rows to engine-compatible XGHistoryEntry format.
 * This bridges the Understat data to calcMatchEnhanced()'s hHistory/aHistory params.
 */
export function toXGHistoryEntries(matches: TeamXGMatch[]): Array<{
  xg: number; xga: number;
  npxg?: number; npxga?: number;
  ppda_att?: number; ppda_def?: number;
  deep?: number; deep_allowed?: number;
  date: string; opponent?: string;
}> {
  return matches.map((m) => ({
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

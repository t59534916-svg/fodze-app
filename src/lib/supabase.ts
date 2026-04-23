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
  // Game-state-adjusted xG (Phase 1.2 — scripts/backfill-xg-by-state.mjs).
  // Optional/null on rows from shots-model / goals-proxy / pre-backfill
  // Understat. Marked optional (not required|null) so that pre-existing
  // callers that build partial TeamXGMatch literals stay type-compatible.
  // Consumers fall back to season-total × STATE_RATIO_PRIOR when absent.
  xg_while_level?: number | null;
  xg_while_leading?: number | null;
  xg_while_trailing?: number | null;
  xga_while_level?: number | null;
  xga_while_leading?: number | null;
  xga_while_trailing?: number | null;
  minutes_level?: number | null;
  minutes_leading?: number | null;
  minutes_trailing?: number | null;
  // Phase 2.4 — set-piece vs open-play xG breakdown
  // Nullable on rows scraped before the situation-aware ingestor (Phase 2.4)
  // landed. Consumers fall back to season-total × SITUATION_RATIO_PRIOR.
  xg_openplay?: number | null;
  xg_setpiece?: number | null;
  xga_openplay?: number | null;
  xga_setpiece?: number | null;
  // Corners (from football-data.co.uk CSV via backfill-shots-xg.mjs since
  // migration-corners.sql). Null on Understat-only rows + pre-backfill
  // legacy rows.
  corners_for?: number | null;
  corners_against?: number | null;
  // Shots (from football-data.co.uk HS/AS columns). Added by
  // migration-team-xg-shots.sql — backfill-shots-xg.mjs writes them
  // on next run. Null means "data not yet ingested for this row".
  shots_for?: number | null;
  shots_against?: number | null;
  shots_on_target_for?: number | null;
  shots_on_target_against?: number | null;
  // Match-level stats from api-sports /fixtures/statistics
  // (nullable auf allen Rows die nicht von fetch-api-sports-stats.mjs
  // stammen, also Understat/shots-model/goals-proxy Row-Sources).
  possession_pct?: number | null;       // Team's possession percentage (0-100)
  passes_total?: number | null;
  passes_accurate?: number | null;
  pass_pct?: number | null;             // passes_accurate / passes_total × 100
  fouls?: number | null;
  offsides?: number | null;
  gk_saves?: number | null;
  shots_blocked?: number | null;
  shots_inside_box?: number | null;
  shots_outside_box?: number | null;
}

/**
 * Global per-state ratios derived from Understat 2018–2024 top-5 data
 * (~30k matches). Mirrors STATE_RATIO_PRIOR in
 * scripts/_lib/game-state-xg.mjs — duplicated here for the browser
 * runtime which can't `import` from .mjs scripts.
 *
 * Sums to 1.0 by construction (0.58 + 0.19 + 0.23).
 */
export const STATE_RATIO_PRIOR = Object.freeze({
  level: 0.58,
  leading: 0.19,
  trailing: 0.23,
});

/**
 * Fill missing state-xG fields on a TeamXGMatch row using the global
 * prior. Returns a new row with all six state columns populated — the
 * original values win if already present.
 *
 * Callers (engine feature extraction) can treat the output as state-
 * complete without a tri-valued null check at every call site.
 */
export function fillStateXGWithPrior(row: TeamXGMatch): TeamXGMatch {
  const xg = Number(row.xg) || 0;
  const xga = Number(row.xga) || 0;
  const r = STATE_RATIO_PRIOR;
  return {
    ...row,
    xg_while_level:     row.xg_while_level ?? +(xg * r.level).toFixed(4),
    xg_while_leading:   row.xg_while_leading ?? +(xg * r.leading).toFixed(4),
    xg_while_trailing:  row.xg_while_trailing ?? +(xg * r.trailing).toFixed(4),
    xga_while_level:    row.xga_while_level ?? +(xga * r.level).toFixed(4),
    xga_while_leading:  row.xga_while_leading ?? +(xga * r.leading).toFixed(4),
    xga_while_trailing: row.xga_while_trailing ?? +(xga * r.trailing).toFixed(4),
    minutes_level:     row.minutes_level ?? 52,     // 0.58 × 90
    minutes_leading:   row.minutes_leading ?? 17,   // 0.19 × 90
    minutes_trailing:  row.minutes_trailing ?? 21,  // 0.23 × 90
  };
}

/**
 * Global open-play vs set-piece ratio (top-5 Understat 2018-2024):
 *   open-play : set-piece ≈ 73 : 27
 * Mirrors SITUATION_RATIO_PRIOR in scripts/_lib/game-state-xg.mjs.
 */
export const SITUATION_RATIO_PRIOR = Object.freeze({
  openplay: 0.73,
  setpiece: 0.27,
});

/**
 * Fill missing open-play/set-piece columns using the global prior. Real
 * values (populated by scripts/backfill-xg-by-state.mjs) always win.
 */
export function fillSituationShareWithPrior(row: TeamXGMatch): TeamXGMatch {
  const xg = Number(row.xg) || 0;
  const xga = Number(row.xga) || 0;
  const r = SITUATION_RATIO_PRIOR;
  return {
    ...row,
    xg_openplay:  row.xg_openplay  ?? +(xg * r.openplay).toFixed(4),
    xg_setpiece:  row.xg_setpiece  ?? +(xg * r.setpiece).toFixed(4),
    xga_openplay: row.xga_openplay ?? +(xga * r.openplay).toFixed(4),
    xga_setpiece: row.xga_setpiece ?? +(xga * r.setpiece).toFixed(4),
  };
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
 * As-of-date variant of `loadTeamXGHistory` — returns the last N venue-
 * specific matches strictly BEFORE the cutoff date. Needed for backtest
 * and shadow-eval use-cases where the loader must NOT leak rows that
 * hadn't happened yet at the target match's kickoff.
 *
 * `cutoffDate` is an ISO date string (e.g. "2024-03-22"). The filter is
 * strictly-less-than so passing the target match's own date excludes
 * the match itself — the standard "shift(1)" semantic the feature
 * pipeline already uses everywhere else.
 *
 * The fuzzy fallback path mirrors `loadTeamXGHistory` — it applies the
 * SAME cutoff so there's no way for future rows to sneak in through a
 * looser team-name match.
 */
export async function loadTeamXGHistoryAsOf(
  supabase: SupabaseClient,
  team: string,
  league: string,
  venue: "home" | "away",
  cutoffDate: string,
  limit: number = 8,
): Promise<TeamXGMatch[]> {
  const exact = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("team", team)
    .eq("league", league)
    .eq("venue", venue)
    .lt("match_date", cutoffDate)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (exact.error) { console.error("loadTeamXGHistoryAsOf error:", exact.error); return []; }
  if (exact.data && exact.data.length > 0) return exact.data.reverse();

  const tokens = team
    .toLowerCase()
    .replace(/[._]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(fc|sc|sv|vfl|vfb|tsg|tsv|rb|afc|the|club)$/.test(w));
  if (tokens.length === 0) return [];
  const probe = tokens.sort((a, b) => b.length - a.length)[0];
  const fuzzy = await supabase
    .from("team_xg_history")
    .select("*")
    .ilike("team", `%${probe}%`)
    .eq("league", league)
    .eq("venue", venue)
    .lt("match_date", cutoffDate)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (fuzzy.error || !fuzzy.data || fuzzy.data.length === 0) return [];
  return fuzzy.data.reverse();
}

/**
 * As-of-date variant of `loadLeagueXGHistory`. Returns every league
 * match strictly before the cutoff, ordered ascending — the shape the
 * engine's feature-engineering pipeline walks chronologically.
 */
export async function loadLeagueXGHistoryAsOf(
  supabase: SupabaseClient,
  league: string,
  cutoffDate: string,
  seasonStartDate: string = "2017-08-01",
): Promise<TeamXGMatch[]> {
  const { data, error } = await supabase
    .from("team_xg_history")
    .select("*")
    .eq("league", league)
    .eq("venue", "home") // One row per match (home perspective)
    .gte("match_date", seasonStartDate)
    .lt("match_date", cutoffDate)
    .order("match_date", { ascending: true });
  if (error) { console.error("loadLeagueXGHistoryAsOf error:", error); return []; }
  return data || [];
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

// ─── Player xG history (Phase 2.3) ──────────────────────────────────
//
// Batch-load per-player season xG for a league so the absence-parser can
// replace position-default xgShares with actual per-player values.
// Called once on matchday load; the result is cached in a Map via
// buildPlayerXgIndex in src/lib/player-impact.ts.

export interface PlayerXgHistoryRow {
  player_name: string;
  team: string;
  league: string;
  season: string;
  position: string | null;
  minutes_played: number | null;
  xg_per_90: number | null;
  xa_per_90: number | null;
  npxg_per_90: number | null;
}

export async function loadPlayerXGForLeague(
  supabase: SupabaseClient,
  league: string,
  season: string,
): Promise<PlayerXgHistoryRow[]> {
  const { data, error } = await supabase
    .from("player_xg_history")
    .select("player_name,team,league,season,position,minutes_played,xg_per_90,xa_per_90,npxg_per_90")
    .eq("league", league)
    .eq("season", season)
    .limit(2000);
  if (error) {
    // Table may not exist yet in dev environments — log-once + empty array.
    if (!(loadPlayerXGForLeague as any)._warned) {
      console.warn(`[player-xg] query failed for ${league}/${season}: ${error.message}`);
      (loadPlayerXGForLeague as any)._warned = true;
    }
    return [];
  }
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
  goals_for?: number; goals_against?: number;
  corners_for?: number; corners_against?: number;
  shots_for?: number; shots_against?: number;
  shots_on_target_for?: number; shots_on_target_against?: number;
  possession_pct?: number; passes_total?: number; passes_accurate?: number;
  pass_pct?: number; fouls?: number; offsides?: number; gk_saves?: number;
  shots_blocked?: number; shots_inside_box?: number; shots_outside_box?: number;
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
    goals_for: m.goals_for ?? undefined,
    goals_against: m.goals_against ?? undefined,
    corners_for: m.corners_for ?? undefined,
    corners_against: m.corners_against ?? undefined,
    shots_for: m.shots_for ?? undefined,
    shots_against: m.shots_against ?? undefined,
    shots_on_target_for: m.shots_on_target_for ?? undefined,
    shots_on_target_against: m.shots_on_target_against ?? undefined,
    possession_pct: m.possession_pct ?? undefined,
    passes_total: m.passes_total ?? undefined,
    passes_accurate: m.passes_accurate ?? undefined,
    pass_pct: m.pass_pct ?? undefined,
    fouls: m.fouls ?? undefined,
    offsides: m.offsides ?? undefined,
    gk_saves: m.gk_saves ?? undefined,
    shots_blocked: m.shots_blocked ?? undefined,
    shots_inside_box: m.shots_inside_box ?? undefined,
    shots_outside_box: m.shots_outside_box ?? undefined,
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

// ─── Post-Match Backtest: Predictions + Outcomes ─────────────────

export interface MatchPrediction {
  id?: string;
  match_key: string;
  league: string;
  home_team: string;
  away_team: string;
  kickoff?: string | null;
  engine: "ensemble-v1" | "poisson-ml" | "poisson-ml-v2";
  prob_h: number;
  prob_d: number;
  prob_a: number;
  prob_o25?: number | null;
  prob_btts?: number | null;
  lambda_h?: number | null;
  lambda_a?: number | null;
  expected_corners?: number | null;
  expected_yellow_cards?: number | null;
  sharp_h?: number | null;
  sharp_d?: number | null;
  sharp_a?: number | null;
  captured_at?: string;
  captured_by?: string;
}

export interface MatchOutcome {
  id?: string;
  match_key: string;
  league: string;
  home_team: string;
  away_team: string;
  match_date: string;
  goals_h: number;
  goals_a: number;
  xg_h?: number | null;
  xg_a?: number | null;
  npxg_h?: number | null;
  npxg_a?: number | null;
  shots_h?: number | null;
  shots_a?: number | null;
  shots_on_target_h?: number | null;
  shots_on_target_a?: number | null;
  corners_h?: number | null;
  corners_a?: number | null;
  yellow_cards_h?: number | null;
  yellow_cards_a?: number | null;
  red_cards_h?: number | null;
  red_cards_a?: number | null;
  // Generated columns (read-only)
  total_goals?: number;
  over25?: boolean;
  btts?: boolean;
  outcome_1x2?: "H" | "D" | "A";
  source?: string;
}

/**
 * Idempotent prediction capture. Uses ON CONFLICT to avoid duplicate
 * inserts when the same match is viewed multiple times. Only updates
 * probability fields so a later capture refines the snapshot if odds
 * changed meaningfully.
 */
export async function savePrediction(
  supabase: SupabaseClient,
  pred: MatchPrediction,
) {
  const { error } = await supabase
    .from("match_predictions")
    .upsert(pred, { onConflict: "match_key,engine" });
  if (error) console.warn("[FODZE] savePrediction failed:", error.message);
}

export async function savePredictionsBulk(
  supabase: SupabaseClient,
  preds: MatchPrediction[],
) {
  if (preds.length === 0) return;
  const { error } = await supabase
    .from("match_predictions")
    .upsert(preds, { onConflict: "match_key,engine" });
  if (error) console.warn("[FODZE] savePredictionsBulk failed:", error.message);
}

export async function loadPredictions(
  supabase: SupabaseClient,
  filters?: { league?: string; engine?: string; limit?: number },
): Promise<MatchPrediction[]> {
  let q = supabase.from("match_predictions").select("*").order("captured_at", { ascending: false });
  if (filters?.league) q = q.eq("league", filters.league);
  if (filters?.engine) q = q.eq("engine", filters.engine);
  q = q.limit(filters?.limit ?? 500);
  const { data, error } = await q;
  if (error) { console.error("loadPredictions error:", error); return []; }
  return data || [];
}

export async function saveOutcome(
  supabase: SupabaseClient,
  outcome: Omit<MatchOutcome, "total_goals" | "over25" | "btts" | "outcome_1x2">,
) {
  const { error } = await supabase
    .from("match_outcomes")
    .upsert(outcome, { onConflict: "match_key" });
  if (error) console.error("saveOutcome error:", error);
}

export async function loadOutcomes(
  supabase: SupabaseClient,
  filters?: { league?: string; since?: string; limit?: number },
): Promise<MatchOutcome[]> {
  let q = supabase.from("match_outcomes").select("*").order("match_date", { ascending: false });
  if (filters?.league) q = q.eq("league", filters.league);
  if (filters?.since) q = q.gte("match_date", filters.since);
  q = q.limit(filters?.limit ?? 500);
  const { data, error } = await q;
  if (error) { console.error("loadOutcomes error:", error); return []; }
  return data || [];
}

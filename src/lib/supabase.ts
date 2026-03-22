import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─── Database helpers ───────────────────────────────────────────────

export async function saveMatchday(supabase: any, league: string, label: string, data: any, userId: string) {
  const { error } = await supabase.from("matchdays").insert({
    league, matchday_label: label, data, created_by: userId,
  });
  if (error) console.error("saveMatchday error:", error);
}

export async function loadLatestMatchday(supabase: any, league: string) {
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
  supabase: any, league: string, matchKey: string,
  homeTeam: string, awayTeam: string, odds: any, userId: string
) {
  const { error } = await supabase.from("odds_snapshots").insert({
    league, match_key: matchKey, home_team: homeTeam,
    away_team: awayTeam, odds, created_by: userId,
  });
  if (error) console.error("saveOdds error:", error);
}

export async function loadOddsHistory(supabase: any, matchKey: string) {
  const { data, error } = await supabase
    .from("odds_snapshots")
    .select("*, profiles(display_name)")
    .eq("match_key", matchKey)
    .order("snapshot_time", { ascending: true });
  if (error) return [];
  return data || [];
}

export async function deleteOddsHistory(supabase: any, matchKey: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("odds_snapshots").delete().eq("match_key", matchKey).eq("created_by", user.id);
}

export async function loadProfile(supabase: any, userId: string) {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  return data;
}

export async function updateProfile(supabase: any, userId: string, updates: any) {
  await supabase.from("profiles").update(updates).eq("id", userId);
}

export async function saveBet(supabase: any, bet: any, userId: string) {
  await supabase.from("bets").insert({ ...bet, created_by: userId });
}

export async function loadUserBets(supabase: any, userId: string) {
  const { data } = await supabase
    .from("bets")
    .select("*")
    .eq("created_by", userId)
    .order("placed_at", { ascending: false });
  return data || [];
}

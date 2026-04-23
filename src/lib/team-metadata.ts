// ═══════════════════════════════════════════════════════════════════════
// FODZE — Team Metadata (logos, colors, stadium, cross-source IDs)
// ═══════════════════════════════════════════════════════════════════════
//
// Supabase table `team_metadata` holds TheSportsDB-sourced rows keyed by
// (fodze_league, team_name). Populated by scripts/sync-thesportsdb-metadata.mjs.
//
// Reads: client-side anon key (RLS policy is read-all).
// Writes: never from the client — service-key-only via the sync script.
// ═══════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from "@supabase/supabase-js";
import { fuzzyTeamMatch } from "@/lib/team-resolver";

export interface TeamMetadata {
  fodze_league: string;
  thesportsdb_id: number | null;
  api_sports_id: number | null;
  team_name: string;
  team_short: string | null;
  team_alternate: string | null;
  country: string | null;
  stadium: string | null;
  stadium_city: string | null;
  stadium_capacity: number | null;
  founded_year: number | null;
  logo_url: string | null;
  jersey_url: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  color_tertiary: string | null;
  website: string | null;
  description_en: string | null;
}

/** Load all team_metadata rows for a league in one query. */
export async function loadTeamMetadata(
  supabase: SupabaseClient,
  league: string,
): Promise<TeamMetadata[]> {
  const { data, error } = await supabase
    .from("team_metadata")
    .select("*")
    .eq("fodze_league", league);
  if (error) {
    console.warn(`[team-metadata] load failed for ${league}: ${error.message}`);
    return [];
  }
  return (data as TeamMetadata[]) || [];
}

/**
 * Lookup a team's metadata by name with fuzzy fallback. Mirrors the
 * xg-history-resolver matching strategy:
 *   1. Exact on team_name
 *   2. Exact on team_short
 *   3. fuzzyTeamMatch (shared word ≥4 chars)
 * Returns null if nothing matches within the provided league rows.
 */
export function findTeamMeta(
  rows: TeamMetadata[],
  teamName: string,
): TeamMetadata | null {
  if (!teamName) return null;
  const norm = teamName.toLowerCase().trim();

  // 1. exact match on team_name
  for (const r of rows) {
    if (r.team_name?.toLowerCase() === norm) return r;
  }
  // 2. exact on team_short
  for (const r of rows) {
    if (r.team_short?.toLowerCase() === norm) return r;
  }
  // 3. fuzzy
  for (const r of rows) {
    if (r.team_name && fuzzyTeamMatch(teamName, r.team_name)) return r;
  }
  // 4. alternates (semicolon or comma separated)
  for (const r of rows) {
    if (!r.team_alternate) continue;
    const parts = r.team_alternate.split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (parts.includes(norm)) return r;
  }
  return null;
}

/** Convert rows array to a Map keyed by team_name for O(1) display lookups. */
export function metaByName(rows: TeamMetadata[]): Map<string, TeamMetadata> {
  const m = new Map<string, TeamMetadata>();
  for (const r of rows) if (r.team_name) m.set(r.team_name, r);
  return m;
}

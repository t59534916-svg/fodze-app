"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/contexts/AppContext";
import {
  loadTeamMetadata,
  metaByName,
  findTeamMeta,
  type TeamMetadata,
} from "@/lib/team-metadata";

// Per-league in-memory cache — shared across component mounts so the
// MatchCard list doesn't kick off one Supabase call per card.
const cache = new Map<string, Promise<TeamMetadata[]>>();

function fetchMetadata(supabase: ReturnType<typeof useApp>["supabase"], league: string): Promise<TeamMetadata[]> {
  const key = league;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = loadTeamMetadata(supabase, league);
  cache.set(key, promise);
  // Drop the entry on rejection so retries don't stick
  promise.catch(() => cache.delete(key));
  return promise;
}

export interface TeamMetadataHook {
  rows: TeamMetadata[];
  byName: Map<string, TeamMetadata>;
  /** Fuzzy-tolerant lookup. Null if the team wasn't synced yet. */
  lookup: (teamName: string | null | undefined) => TeamMetadata | null;
  loading: boolean;
}

/**
 * Load team_metadata rows for a league once and return a memoized lookup.
 * Safe to call in many components — the Supabase query fires once per
 * league thanks to the module-level promise cache.
 */
export function useTeamMetadata(leagueOverride?: string): TeamMetadataHook {
  const { supabase, league: contextLeague } = useApp();
  const league = leagueOverride || contextLeague;
  const [rows, setRows] = useState<TeamMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!league) { setRows([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetchMetadata(supabase, league)
      .then(r => { if (alive) { setRows(r); setLoading(false); } })
      .catch(() => { if (alive) { setRows([]); setLoading(false); } });
    return () => { alive = false; };
  }, [supabase, league]);

  const byName = metaByName(rows);
  const lookup = (teamName: string | null | undefined) =>
    teamName ? findTeamMeta(rows, teamName) : null;

  return { rows, byName, lookup, loading };
}

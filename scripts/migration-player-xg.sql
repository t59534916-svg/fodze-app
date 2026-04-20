-- FODZE: Player-level xG season totals (Phase 2.3)
-- ═══════════════════════════════════════════════════════════════════════
-- Populated by scripts/backfill-player-xg.mjs (FBref per-player stats).
-- Consumed at runtime by src/lib/player-impact.ts::enrichPlayerFromXG to
-- replace the position-based xgShare defaults with per-player actuals.
--
-- McHale & Szczepański (2019, arXiv 1902.00112) show that the weighted
-- variant  missing_xg = Σ (xg_per_90 × minutes_share)  dominates the
-- flat "N players out" heuristic. For a missing goalkeeper, this table
-- lets us apply the ~0.1-0.3 Goals/Match ceiling correctly.
--
-- Scope: season-total aggregates per player per team (one row per season).
-- We don't persist per-match granularity here — that's understudied and
-- adds 100× the storage for marginal engine gain. Understat/FBref already
-- give us season-total xg90 + minutes, which is what the engine wants.

CREATE TABLE IF NOT EXISTS player_xg_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name TEXT NOT NULL,
  team TEXT NOT NULL,            -- FODZE canonical team name (match home_team)
  league TEXT NOT NULL,
  season TEXT NOT NULL,          -- "2526" = 2025/26 (matches scrape-referees)
  position TEXT,                 -- GK / DEF / MID / FWD (normalized)

  minutes_played INT,
  xg_per_90 NUMERIC,             -- team expected-goals contribution
  xa_per_90 NUMERIC,             -- expected assists
  npxg_per_90 NUMERIC,           -- non-penalty xG (harder to lose to fluke)
  shots_per_90 NUMERIC,
  key_passes_per_90 NUMERIC,

  source TEXT DEFAULT 'fbref',
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (player_name, team, league, season)
);

CREATE INDEX IF NOT EXISTS idx_player_xg_team ON player_xg_history(team, league, season);
CREATE INDEX IF NOT EXISTS idx_player_xg_name ON player_xg_history(player_name);

-- RLS: authenticated read, service-role write.
ALTER TABLE player_xg_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON player_xg_history
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Service insert" ON player_xg_history
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON player_xg_history
  FOR UPDATE USING (true);

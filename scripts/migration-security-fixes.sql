-- ═══════════════════════════════════════════════════════════════════════
-- FODZE Migration — Schritt 1: Tabellen erstellen
-- Run this FIRST in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS team_xg_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team TEXT NOT NULL,
  league TEXT NOT NULL,
  opponent TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('home', 'away')),
  match_date DATE NOT NULL,
  xg NUMERIC(5,2) NOT NULL,
  xga NUMERIC(5,2) NOT NULL,
  goals_for INT,
  goals_against INT,
  source TEXT DEFAULT 'understat',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team, league, match_date, venue)
);

CREATE TABLE IF NOT EXISTS player_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team TEXT NOT NULL,
  league TEXT NOT NULL,
  player_name TEXT NOT NULL,
  position TEXT,
  xg_share NUMERIC(4,3),
  xga_share NUMERIC(4,3),
  replacement_level NUMERIC(4,3),
  games_played INT,
  season TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team, league, player_name, season)
);

CREATE INDEX IF NOT EXISTS idx_txh_team_league ON team_xg_history(team, league, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_txh_league_date ON team_xg_history(league, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_pp_team_league ON player_profiles(team, league);

-- RLS
ALTER TABLE team_xg_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read team_xg_history" ON team_xg_history FOR SELECT USING (true);
CREATE POLICY "Public read player_profiles" ON player_profiles FOR SELECT USING (true);

CREATE POLICY "Service write team_xg_history" ON team_xg_history
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service write player_profiles" ON player_profiles
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Security fixes for existing tables
ALTER FUNCTION public.handle_new_user() SET search_path = public;

DROP POLICY IF EXISTS "Service insert" ON public.live_odds;
DROP POLICY IF EXISTS "Service update" ON public.live_odds;

CREATE POLICY "Service insert live_odds" ON public.live_odds
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service update live_odds" ON public.live_odds
  FOR UPDATE USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

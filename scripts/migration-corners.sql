-- FODZE: Corners Columns (Phase 3.1) + Corners-Odds History
-- ═══════════════════════════════════════════════════════════════════════
-- Two parallel changes so the Corners Compound-Poisson engine can train
-- on historical totals AND compare against live market odds:
--
--   1. team_xg_history gains corners_for + corners_against columns.
--      Populated by scripts/backfill-football-data-co-uk.mjs (HC/AC cols).
--      Consumed by src/lib/corners-engine.ts as the per-team rate prior.
--
--   2. corners_odds_history (new table) stores time-series of bookmaker
--      corner-total lines (e.g. "Over 10.5 corners @ 1.95"). Populated
--      by a follow-up scripts/fetch-corners-odds.mjs (API-Football Pro,
--      not built in this phase). Consumed by the Goldilocks filter to
--      produce edge-vs-market signals.
--
-- arXiv 2112.13001: Geometric-Poisson / Compound-Poisson models corners
-- markedly better than standard Poisson because corners arrive in bursts
-- (a corner often provokes the next). The model parameters live in the
-- engine; this schema just persists the raw data.

-- ── 1. Corners on team_xg_history ──
ALTER TABLE team_xg_history
  ADD COLUMN IF NOT EXISTS corners_for NUMERIC,
  ADD COLUMN IF NOT EXISTS corners_against NUMERIC;

CREATE INDEX IF NOT EXISTS idx_xg_history_has_corners
  ON team_xg_history(league, match_date)
  WHERE corners_for IS NOT NULL;

-- ── 2. Corners odds history ──
CREATE TABLE IF NOT EXISTS corners_odds_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  league TEXT NOT NULL,
  match_date DATE NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,

  -- Asian-style corner totals (common set: 7.5 / 8.5 / 9.5 / 10.5 / 11.5 / 12.5)
  over_85 NUMERIC,  under_85 NUMERIC,
  over_95 NUMERIC,  under_95 NUMERIC,
  over_105 NUMERIC, under_105 NUMERIC,
  over_115 NUMERIC, under_115 NUMERIC,

  -- Actual settled corners (post-match, for CLV)
  actual_total INT,

  source TEXT DEFAULT 'api-football',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (match_key)
);

CREATE INDEX IF NOT EXISTS idx_corners_odds_league_date
  ON corners_odds_history(league, match_date);

-- RLS: authenticated read, service-role write.
ALTER TABLE corners_odds_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON corners_odds_history
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Service insert" ON corners_odds_history
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON corners_odds_history
  FOR UPDATE USING (true);

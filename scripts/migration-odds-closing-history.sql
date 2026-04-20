-- FODZE: Historical Closing Odds (football-data.co.uk)
-- Populated by scripts/backfill-football-data-co-uk.mjs from Buchdahl's
-- public CSV dumps (PSCH/PSCD/PSCA = Pinnacle Closing 1X2, PSC>2.5 /
-- PSC<2.5 = Pinnacle Closing O/U 2.5, PSCAHH/PSCAHA = Pinnacle Closing
-- Asian Handicap).
--
-- Use cases:
--   1. Benter-Blending fit (tools/fit_benter_blend.py) — needs historical
--      model_prob × pinn_closing pairs to grid-search β₁,β₂ per league.
--   2. Dirichlet-Calibration fit (Phase 2.1) — uses pinn_closing as a
--      strong fair-prob target for ODIR-regularised calibration.
--   3. CLV fallback in fetch-results.mjs — when `bets.closing_odds` is
--      missing because no live snapshot landed, recover via match_key
--      lookup here (1X2 only, multi-market would need bets.closing_odds
--      migrated to JSONB; out of scope for this phase).
--
-- Schema conventions:
--   - match_key format: "{league}|{csvHome}|{csvAway}|{YYYY-MM-DD}"
--     Stored raw CSV-side — intentionally NOT resolved to FODZE names here,
--     so re-ingestion stays idempotent even if the team-resolver evolves.
--     Downstream Benter / Dirichlet fit scripts apply team-resolver at
--     join-time to align with `bets.match_key` (format.ts::matchKey()).
--   - ft_result: "H"/"D"/"A" derived from Ft-Home-Goals vs Ft-Away-Goals.
--   - All odds columns are NUMERIC NULL — older seasons don't carry the
--     full set (pre-2013 seasons often lack Pinnacle Closing).
--   - Coverage: 13 of 19 FODZE leagues (all Top-5 + 2./3. Bundesliga,
--     Championship, Eredivisie, Jupiler Pro, Primeira Liga, Super Lig,
--     Greek SL, Scottish Prem). League One / League Two / Liga 3 have
--     no football-data.co.uk coverage and stay on live_odds-snapshot-only.

CREATE TABLE IF NOT EXISTS odds_closing_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  league TEXT NOT NULL,
  match_date DATE NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,

  -- Pinnacle 1X2 Closing
  psch NUMERIC,
  pscd NUMERIC,
  psca NUMERIC,

  -- Pinnacle Closing O/U 2.5
  psc_over25 NUMERIC,
  psc_under25 NUMERIC,

  -- Pinnacle Closing Asian Handicap (split: line + side odds)
  pscahh NUMERIC,  -- Home side odd
  pscaha NUMERIC,  -- Away side odd
  ah_line NUMERIC, -- AHh line from CSV

  -- Final-time result (needed to train Benter + Conformal)
  ft_result TEXT CHECK (ft_result IN ('H', 'D', 'A')),
  ft_goals_h INT,
  ft_goals_a INT,

  source TEXT DEFAULT 'football-data.co.uk',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (match_key)
);

CREATE INDEX IF NOT EXISTS idx_closing_league_date
  ON odds_closing_history(league, match_date);
CREATE INDEX IF NOT EXISTS idx_closing_match_key
  ON odds_closing_history(match_key);

-- RLS: authenticated-read, service-write (GH Actions / admin scripts).
ALTER TABLE odds_closing_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON odds_closing_history
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Service insert" ON odds_closing_history
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON odds_closing_history
  FOR UPDATE USING (true);

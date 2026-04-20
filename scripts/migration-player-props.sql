-- FODZE: Player Props Infrastructure (Phase 3.2)
-- ═══════════════════════════════════════════════════════════════════════
-- Two parallel tables:
--
--   1. player_props_posteriors — output of the hierarchical-Bayes fit
--      (services/footbayes/fit_player_props.R). One row per player per
--      season, carrying the posterior MEAN of:
--         α_player (goal-rate intercept, log-scale)
--         β_player (shots-per-90 rate)
--         γ_player (cards rate)
--      plus posterior SD for uncertainty display + minutes_share of the
--      team's total minutes (predictor of expected-minutes this match).
--
--   2. player_props_odds_history — time-series of bookmaker prices for
--      Anytime Goalscorer, First Goalscorer, Player Shots Over, Player
--      Cards. Populated by a follow-up scripts/fetch-player-props.mjs
--      (API-Football Pro Props endpoint).
--
-- Prior structure (Whitaker et al. 2021, JRSS-C): partial-pooling shrinks
-- each player's rates toward league × position mean. A thin-data striker
-- in Liga 3 borrows strength from the cohort of all Liga 3 strikers, not
-- from all players or all strikers.
--
-- Consumed by src/lib/player-props-engine.ts at runtime. Posterior means
-- are enough for the expected-value calculation; SDs stay available for
-- a future "uncertainty interval" UI surface.

-- ── 1. Player-props posteriors ──
CREATE TABLE IF NOT EXISTS player_props_posteriors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name TEXT NOT NULL,
  team TEXT NOT NULL,
  league TEXT NOT NULL,
  season TEXT NOT NULL,
  position TEXT,

  -- Posterior means (log-scale unless noted)
  alpha_mean NUMERIC,     -- goal-rate intercept
  alpha_sd NUMERIC,
  beta_mean NUMERIC,      -- shots-per-90 rate (log)
  beta_sd NUMERIC,
  gamma_mean NUMERIC,     -- cards-per-90 rate (log)
  gamma_sd NUMERIC,

  minutes_share NUMERIC,  -- fraction of team's available minutes this season
  minutes_played INT,     -- raw minutes (for training diagnostics)

  -- Training diagnostics (optional)
  n_matches_in_fit INT,
  posterior_effective_samples INT,

  source TEXT DEFAULT 'footbayes',
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (player_name, team, league, season)
);

CREATE INDEX IF NOT EXISTS idx_player_props_team ON player_props_posteriors(team, league, season);
CREATE INDEX IF NOT EXISTS idx_player_props_name ON player_props_posteriors(player_name);

-- ── 2. Player-props odds history ──
CREATE TABLE IF NOT EXISTS player_props_odds_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  league TEXT NOT NULL,
  match_date DATE NOT NULL,
  player_name TEXT NOT NULL,
  team TEXT NOT NULL,

  market TEXT NOT NULL,          -- "anytime_scorer" | "first_scorer" | "shots_over_2.5" | "cards_yes"
  odds_decimal NUMERIC,
  bookmaker TEXT,

  -- Settled (post-match)
  actual_value INT,              -- 0/1 for yes/no markets, raw count for shots
  settled_at TIMESTAMPTZ,

  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_props_odds_match ON player_props_odds_history(match_key, player_name);
CREATE INDEX IF NOT EXISTS idx_player_props_odds_market ON player_props_odds_history(league, match_date, market);

-- RLS — authenticated read, service write.
ALTER TABLE player_props_posteriors ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_props_odds_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON player_props_posteriors
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Service insert" ON player_props_posteriors
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update" ON player_props_posteriors
  FOR UPDATE USING (true);

CREATE POLICY "Authenticated read" ON player_props_odds_history
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Service insert" ON player_props_odds_history
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update" ON player_props_odds_history
  FOR UPDATE USING (true);

-- ═══════════════════════════════════════════════════════════════════════
-- FODZE — Post-Match Backtest Layer
-- ═══════════════════════════════════════════════════════════════════════
-- Two new tables to close the prediction→reality feedback loop:
--
--   match_predictions   — snapshot of what each engine said PRE-MATCH.
--                         Captured once per matchday load (idempotent
--                         UPSERT on match_key + engine). Survives even
--                         after the matchday row is updated.
--
--   match_outcomes      — what actually happened. Goals, xG, shots,
--                         corners, cards. Populated by fetch-results.mjs
--                         cron OR manually imported from stats APIs.
--                         Derived booleans (over25, btts) computed in
--                         the generated columns — can't drift.
--
-- With both joined on match_key, the /backtest page can:
--   • compute Brier + log-loss per engine per market
--   • plot calibration curves (predicted vs realized)
--   • show drill-downs where engines were spectacularly right/wrong
-- ═══════════════════════════════════════════════════════════════════════

-- ─── Predictions (pre-match snapshots) ────────────────────────────

CREATE TABLE IF NOT EXISTS match_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key TEXT NOT NULL,            -- league|home|away|date composite
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff TIMESTAMPTZ,                -- nullable for manual matchdays
  engine TEXT NOT NULL,               -- "ensemble-v1" | "poisson-ml" | "poisson-ml-v2"
  -- 1X2
  prob_h NUMERIC NOT NULL CHECK (prob_h BETWEEN 0 AND 1),
  prob_d NUMERIC NOT NULL CHECK (prob_d BETWEEN 0 AND 1),
  prob_a NUMERIC NOT NULL CHECK (prob_a BETWEEN 0 AND 1),
  -- Totals
  prob_o25 NUMERIC CHECK (prob_o25 BETWEEN 0 AND 1),
  prob_btts NUMERIC CHECK (prob_btts BETWEEN 0 AND 1),
  -- Lambdas (expected goals per side)
  lambda_h NUMERIC,
  lambda_a NUMERIC,
  -- Expected corners/cards — future columns, nullable now
  expected_corners NUMERIC,
  expected_yellow_cards NUMERIC,
  -- Market context at capture time (lets us compute edge-vs-market retrospectively)
  sharp_h NUMERIC,
  sharp_d NUMERIC,
  sharp_a NUMERIC,
  -- Bookkeeping
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by UUID REFERENCES auth.users(id),
  UNIQUE (match_key, engine)
);

CREATE INDEX IF NOT EXISTS idx_predictions_league_kickoff ON match_predictions (league, kickoff);
CREATE INDEX IF NOT EXISTS idx_predictions_captured ON match_predictions (captured_at DESC);

-- ─── Outcomes (post-match reality) ────────────────────────────────

CREATE TABLE IF NOT EXISTS match_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key TEXT NOT NULL UNIQUE,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  match_date DATE NOT NULL,
  -- Final score
  goals_h INT NOT NULL CHECK (goals_h >= 0),
  goals_a INT NOT NULL CHECK (goals_a >= 0),
  -- xG (from Understat / shots-model / FootyStats / goals-proxy)
  xg_h NUMERIC,
  xg_a NUMERIC,
  npxg_h NUMERIC,
  npxg_a NUMERIC,
  -- Shots
  shots_h INT,
  shots_a INT,
  shots_on_target_h INT,
  shots_on_target_a INT,
  -- Set pieces
  corners_h INT,
  corners_a INT,
  -- Cards
  yellow_cards_h INT,
  yellow_cards_a INT,
  red_cards_h INT,
  red_cards_a INT,
  -- Derived (GENERATED — can't drift)
  total_goals INT GENERATED ALWAYS AS (goals_h + goals_a) STORED,
  over25 BOOLEAN GENERATED ALWAYS AS ((goals_h + goals_a) > 2) STORED,
  btts BOOLEAN GENERATED ALWAYS AS (goals_h > 0 AND goals_a > 0) STORED,
  outcome_1x2 TEXT GENERATED ALWAYS AS (
    CASE
      WHEN goals_h > goals_a THEN 'H'
      WHEN goals_h < goals_a THEN 'A'
      ELSE 'D'
    END
  ) STORED,
  -- Provenance
  source TEXT NOT NULL DEFAULT 'manual',  -- understat | footystats | openligadb | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outcomes_league_date ON match_outcomes (league, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_teams ON match_outcomes (home_team, away_team);

-- Auto-update updated_at on outcome edits (useful if stats-API back-fills
-- corner/card data hours after the final whistle).
CREATE OR REPLACE FUNCTION update_match_outcomes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_match_outcomes_updated_at ON match_outcomes;
CREATE TRIGGER trg_match_outcomes_updated_at
  BEFORE UPDATE ON match_outcomes
  FOR EACH ROW EXECUTE FUNCTION update_match_outcomes_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────
-- Predictions are per-user snapshots (each user sees their own captures).
-- Outcomes are public facts (anyone authenticated can read, scripts write).

ALTER TABLE match_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS predictions_read_own ON match_predictions;
CREATE POLICY predictions_read_own ON match_predictions
  FOR SELECT USING (captured_by = auth.uid() OR captured_by IS NULL);

DROP POLICY IF EXISTS predictions_write_own ON match_predictions;
CREATE POLICY predictions_write_own ON match_predictions
  FOR INSERT WITH CHECK (captured_by = auth.uid());

DROP POLICY IF EXISTS predictions_update_own ON match_predictions;
CREATE POLICY predictions_update_own ON match_predictions
  FOR UPDATE USING (captured_by = auth.uid());

DROP POLICY IF EXISTS outcomes_read_all ON match_outcomes;
CREATE POLICY outcomes_read_all ON match_outcomes
  FOR SELECT USING (auth.role() = 'authenticated');

-- Writes to outcomes come from service-role (admin scripts), not users
-- — keep INSERT/UPDATE permissions default-deny for authenticated users.

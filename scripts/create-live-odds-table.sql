-- FODZE: Live Odds Table
-- Stores automated odds from The-Odds-API, fetched via GitHub Actions cron

CREATE TABLE IF NOT EXISTS live_odds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  league TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  commence_time TIMESTAMPTZ NOT NULL,

  -- Best available odds across all bookmakers (for max ROI)
  best_h NUMERIC,
  best_d NUMERIC,
  best_a NUMERIC,
  best_over25 NUMERIC,
  best_under25 NUMERIC,

  -- Sharp bookmaker odds (Pinnacle — closest to true probability)
  sharp_h NUMERIC,
  sharp_d NUMERIC,
  sharp_a NUMERIC,
  sharp_over25 NUMERIC,
  sharp_under25 NUMERIC,
  sharp_book TEXT,

  -- All bookmaker data (JSONB for flexibility)
  bookmakers JSONB DEFAULT '{}',
  num_bookmakers INT DEFAULT 0,

  fetched_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint for upsert (one row per event per league)
  UNIQUE(league, event_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_live_odds_league ON live_odds(league);
CREATE INDEX IF NOT EXISTS idx_live_odds_commence ON live_odds(commence_time);
CREATE INDEX IF NOT EXISTS idx_live_odds_league_time ON live_odds(league, commence_time);

-- RLS: Anyone authenticated can read live odds
ALTER TABLE live_odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON live_odds
  FOR SELECT USING (auth.role() = 'authenticated');

-- Service role can insert/update (from GitHub Actions)
CREATE POLICY "Service insert" ON live_odds
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON live_odds
  FOR UPDATE USING (true);

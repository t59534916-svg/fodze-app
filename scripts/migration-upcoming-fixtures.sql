-- ═══════════════════════════════════════════════════════════════════════
-- FODZE: Upcoming Fixtures (auto-populated from The-Odds-API)
-- No extra API credits — piggybacked on fetch-odds.mjs
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS upcoming_fixtures (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  league TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  commence_time TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(league, event_id)
);

-- Index for quick lookups by league and time
CREATE INDEX IF NOT EXISTS idx_fixtures_league_time
  ON upcoming_fixtures (league, commence_time ASC);

-- RLS: Everyone can read, only service_role can write
ALTER TABLE upcoming_fixtures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Fixtures are readable by all authenticated users"
  ON upcoming_fixtures FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage fixtures"
  ON upcoming_fixtures FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

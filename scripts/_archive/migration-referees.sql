-- FODZE: Referee Statistics Table
-- Populated by scripts/scrape-referees.mjs (FBref + weltfussball fallback).
-- Read by scripts/_lib/matchday-enrich.mjs::deriveRefereeFeatures.
--
-- Design notes:
--   - referee_slug is a normalized lower-case key (first-last, no diacritics)
--     so "Felix Zwayer" and "Zwayer, Felix" both map to "felix-zwayer".
--   - last_30_games JSONB stores a rolling detail log (optional — aggregate
--     columns above are what the engine actually reads).
--   - home_yellow_bias = (yellows_to_home / yellows_to_away) normalised around 1.0;
--     1.15 means the ref gives 15% more yellows to the home side (Dohmen 2008).

CREATE TABLE IF NOT EXISTS referees (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referee_name TEXT NOT NULL,
  referee_slug TEXT NOT NULL,
  league TEXT NOT NULL,
  season TEXT NOT NULL,

  fouls_per_game NUMERIC,
  yellows_per_game NUMERIC,
  reds_per_game NUMERIC,
  pens_per_game NUMERIC,

  home_yellow_bias NUMERIC,
  home_pen_bias NUMERIC,

  matches_analyzed INT DEFAULT 0,
  last_30_games JSONB DEFAULT '[]',

  source TEXT DEFAULT 'fbref',
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (referee_slug, league, season)
);

CREATE INDEX IF NOT EXISTS idx_referees_slug_league ON referees(referee_slug, league);
CREATE INDEX IF NOT EXISTS idx_referees_league_season ON referees(league, season);

-- RLS: Authenticated read, service-role write (GitHub Actions / admin scripts).
ALTER TABLE referees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON referees
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Service insert" ON referees
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON referees
  FOR UPDATE USING (true);

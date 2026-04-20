-- FODZE: Stadium Coordinates + Metadata
-- ═══════════════════════════════════════════════════════════════════════
-- Populated by scripts/scrape-stadiums.mjs (Wikidata SPARQL). Consumed by
-- scripts/_lib/matchday-enrich.mjs::deriveTravelCongestion to compute
-- travel_km_last_7d per team using the Haversine formula on stadium
-- coordinates. Long travel + short rest is the Scoppa 2013 fatigue
-- interaction FODZE will eventually gate the EURO-FATIGUE tag on.
--
-- Scope: ~362 teams across the 19 FODZE leagues. One row per team name as
-- stored in upcoming_fixtures.home_team / away_team (resolveName output).
-- When a team is missing, deriveTravelCongestion returns travel_km=null
-- so downstream code can cleanly fall back to "rest only" features.
--
-- Optional columns (altitude_m, surface, capacity) are placeholders for
-- future Phase-2 stadium features (e.g. altitude-elo, weather×surface
-- interaction). Unused today.

CREATE TABLE IF NOT EXISTS stadiums (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  team TEXT NOT NULL,              -- FODZE canonical team name
  stadium_name TEXT,
  city TEXT,
  country TEXT,                    -- ISO 3166-1 alpha-2 where possible

  lat NUMERIC NOT NULL,            -- WGS-84 latitude
  lng NUMERIC NOT NULL,            -- WGS-84 longitude
  altitude_m NUMERIC,              -- meters ASL (Wikidata P2044)
  surface TEXT,                    -- "natural" | "artificial" | "hybrid"
  capacity INT,

  source TEXT DEFAULT 'wikidata',
  wikidata_qid TEXT,               -- stadium Q-id, e.g. "Q157597" for Allianz Arena
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (team)
);

CREATE INDEX IF NOT EXISTS idx_stadiums_team ON stadiums(team);

-- RLS: authenticated read, service-role write.
ALTER TABLE stadiums ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON stadiums
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Service insert" ON stadiums
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update" ON stadiums
  FOR UPDATE USING (true);

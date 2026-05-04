-- Migration: extend sofascore_data_quality_tier() with 5 more leagues
-- after Cloudflare unblocked retry on 2026-05-05 succeeded for all 5
-- previously-blocked Tier-B leagues.
-- Applied 2026-05-05. Depends on migration-sofascore-tier-update.sql (2026-05-03).
--
-- Audit results from sofascore_shotmap content check on 2026-05-05:
--   austria_bl     4413 shots, 99.2% xG-fill, full situation tags  → premium
--   swiss_sl       5990 shots, 99.5% xG-fill, full situation tags  → premium
--   scottish_prem  5384 shots, 99.6% xG-fill, full situation tags  → premium
--   jupiler_pro    7484 shots, 99.7% xG-fill, full situation tags  → premium
--   super_lig      6033 shots, 99.7% xG-fill, full situation tags  → premium
--
-- All 5 captured the playoff/post-split rounds (austrian Meistergruppe,
-- swiss Championship Group, scottish Top-6, belgian Champions Playoff,
-- turkish Süper Lig). Previously-confirmed as a coverage gap by user
-- on 2026-05-04 ("schweiz, österreich und schottland sind in den playoffs
-- und nicht in einer spielpause").
--
-- Existing classifications unchanged:
--   bundesliga, bundesliga2, championship, epl, eredivisie, greek_sl,
--   la_liga, ligue_1, primeira_liga, serie_a, serie_b → premium
--   liga3 → partial (full xG but no assisted/fast-break tags)
--   la_liga2, ligue_2, league_one, league_two, eerste_divisie → volume
--                                                               (no xG, shot events only)
--
-- After this migration:
--   - 16 leagues at premium tier (was 11)
--   - 1 at partial (liga3)
--   - 5 at volume (no xG)
--   - 0 at unknown (all 22 FODZE leagues now classified)

CREATE OR REPLACE FUNCTION sofascore_data_quality_tier(p_league TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_league IN ('la_liga2', 'ligue_2',
                      'league_one', 'league_two', 'eerste_divisie') THEN 'volume'
    WHEN p_league = 'liga3'                                         THEN 'partial'
    WHEN p_league IN ('bundesliga','bundesliga2','epl','la_liga',
                      'serie_a','serie_b','ligue_1','championship',
                      'eredivisie','primeira_liga','greek_sl',
                      'austria_bl','swiss_sl','scottish_prem',
                      'jupiler_pro','super_lig')                    THEN 'premium'
    ELSE 'unknown'
  END;
$$;

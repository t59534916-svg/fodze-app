-- ⚠ DEPRECATED 2026-05-05 — superseded by
--   scripts/migration-sofascore-tier-extend-2026-05-05.sql
--
-- This migration classified 11 leagues as premium. The successor adds 5
-- more (austria_bl, swiss_sl, scottish_prem, jupiler_pro, super_lig) for
-- a total of 16 premium leagues. Both are CREATE OR REPLACE FUNCTION,
-- so running them sequentially is idempotent — but on a fresh DB you
-- only need to run the SUCCESSOR (it is fully self-contained).
--
-- Kept for git history / audit trail only. Do NOT run alone on fresh
-- DB unless you specifically want the 11-premium intermediate state.
--
-- ─────────────────────────────────────────────────────────────────────
--
-- Migration: extend sofascore_data_quality_tier() with 6 new Tier-B leagues
-- Applied 2026-05-03. Depends on migration-sofascore-views.sql.
--
-- Audit results from sofascore_shotmap content check on 2026-05-03:
--   eredivisie     8114 shots, 99.8% xG-fill, full situation tags  → premium
--   primeira_liga  6887 shots, 99.7% xG-fill, full situation tags  → premium
--   greek_sl        658 shots, 99.7% xG-fill, full situation tags  → premium (sparse coverage)
--   league_one    10842 shots,  0.0% xG-fill, full situation tags  → volume
--   league_two    11055 shots,  0.0% xG-fill, full situation tags  → volume
--   eerste_divisie 10861 shots, 0.0% xG-fill, full situation tags  → volume
--
-- Existing classifications unchanged:
--   bundesliga, bundesliga2, epl, la_liga, serie_a, serie_b, ligue_1,
--   championship  → premium
--   liga3         → partial  (full xG but no assisted/fast-break tags)
--   la_liga2,
--   ligue_2       → volume   (shot events, NO xG)

CREATE OR REPLACE FUNCTION sofascore_data_quality_tier(p_league TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_league IN ('la_liga2', 'ligue_2',
                      'league_one', 'league_two', 'eerste_divisie') THEN 'volume'
    WHEN p_league = 'liga3'                                         THEN 'partial'
    WHEN p_league IN ('bundesliga','bundesliga2','epl','la_liga',
                      'serie_a','serie_b','ligue_1','championship',
                      'eredivisie','primeira_liga','greek_sl')      THEN 'premium'
    ELSE 'unknown'
  END;
$$;

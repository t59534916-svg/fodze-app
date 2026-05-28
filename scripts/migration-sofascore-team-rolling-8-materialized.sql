-- Migration: convert sofascore_team_rolling_8 from VIEW to MATERIALIZED VIEW
-- Applied 2026-05-28. Depends on scripts/migration-sofascore-views.sql.
--
-- Why: the regular VIEW does a full window-aggregation scan on every query:
--   ~1.7s service-key · ~3s anon (timeout) per CLAUDE.md areas-to-watch.
--   tools/sofascore/engine_features.py is the production consumer; at retrain
--   time we load this ~22 × per league = ~11min/full-run.
--
-- Fix: MATERIALIZED VIEW with a UNIQUE INDEX on (league, season, team_id) so
-- REFRESH MATERIALIZED VIEW CONCURRENTLY works (no read-side lock — safe to
-- run while queries are in flight). Add covering index for the (league, season,
-- team) text-name JOIN pattern that engine_features.py uses.
--
-- Schema note (Phase 4.1+ correction): the prior VIEW GROUP'd by `team` AND
-- `team_id` simultaneously. This produced duplicate rows for 5 teams whose
-- Sofa names drifted mid-season. The MATERIALIZED VIEW GROUP BYs `team_id`
-- ONLY and picks MAX(team) for the display name.
--
-- Known caveat (2026-05-28 affected teams + MAX-winner names):
--   epl|25/26|44       → 'Liverpool FC'        (vs 'Liverpool')
--   la_liga2|25/26|2832 → 'Deportivo La Coruña' (vs 'Deportivo de La Coruña')
--   serie_a|25/26|2692 → 'Milan'               (vs 'AC Milan')
--   serie_a|25/26|2702 → 'Roma'                (vs 'AS Roma')
--   serie_a|25/26|2714 → 'SSC Napoli'          (vs 'Napoli')
-- For these 5 teams, a caller querying by the non-MAX name spelling will
-- get an empty row. Preferred read pattern: JOIN by `team_id`. Fallback:
-- resolve raw name → canonical via canonical_team() (TS) /
-- canonical_team_map.canonical_team() (Python) BEFORE the lookup.
--
-- Refresh is wired as `phase: rolling-8-refresh` in scripts/refresh-all.mjs,
-- after the sofascore-shotmap sync phase so the view reflects the latest data.

BEGIN;

-- 1. Drop the current VIEW (regular)
DROP VIEW IF EXISTS sofascore_team_rolling_8 CASCADE;

-- 2. Create the MATERIALIZED VIEW
CREATE MATERIALIZED VIEW sofascore_team_rolling_8 AS
WITH ranked AS (
  SELECT
    cq.*,
    ROW_NUMBER() OVER (
      PARTITION BY league, season, team_id
      ORDER BY start_timestamp DESC NULLS LAST, week DESC
    ) AS recency
  FROM sofascore_team_chance_quality cq
  WHERE team_id IS NOT NULL
)
SELECT
  league,
  season,
  team_id,
  MAX(team)                                               AS team,
  MAX(data_quality_tier)                                  AS data_quality_tier,
  COUNT(*)                                                AS games_in_window,
  ROUND(AVG(shots)::numeric, 2)                           AS avg_shots,
  ROUND(AVG(shots_in_box)::numeric, 2)                    AS avg_shots_in_box,
  ROUND(AVG(shots_on_target)::numeric, 2)                 AS avg_shots_on_target,
  ROUND(AVG(goals)::numeric, 3)                           AS avg_goals,
  ROUND(AVG(sum_xg)::numeric, 3)                          AS avg_sum_xg,
  ROUND(AVG(sum_xgot)::numeric, 3)                        AS avg_sum_xgot,
  ROUND(AVG(mean_shot_xg)::numeric, 4)                    AS avg_mean_shot_xg,
  ROUND(AVG(setpiece_xg_share)::numeric, 4)               AS avg_setpiece_xg_share,
  ROUND(AVG(big_chance_share)::numeric, 4)                AS avg_big_chance_share,
  ROUND(AVG(header_share)::numeric, 4)                    AS avg_header_share,
  ROUND(AVG(openplay_xg)::numeric, 3)                     AS avg_openplay_xg,
  ROUND(AVG(fastbreak_xg)::numeric, 3)                    AS avg_fastbreak_xg,
  MAX(start_timestamp)                                    AS most_recent_match_ts
FROM ranked
WHERE recency <= 8
GROUP BY league, season, team_id;

-- 3. UNIQUE INDEX required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX idx_sofascore_team_rolling_8_unique
  ON sofascore_team_rolling_8 (league, season, team_id);

-- 4. Covering index for the text-name JOIN pattern
CREATE INDEX idx_sofascore_team_rolling_8_team_name
  ON sofascore_team_rolling_8 (league, season, team);

COMMENT ON MATERIALIZED VIEW sofascore_team_rolling_8 IS
  'Per-team last-8-games chance quality. MATERIALIZED 2026-05-28 to escape '
  '~1.7-3s I/O timeouts on every query. UNIQUE INDEX on (league, season, team_id) '
  'supports REFRESH CONCURRENTLY. Refresh via scripts/refresh-all.mjs after the '
  'sofascore-shotmap sync phase. JOIN by (league, season, team_id) preferred '
  '(stable); (league, season, team) also indexed for fallback text-name access.';

-- 6. RPC wrapper called from scripts/refresh-rolling-8.mjs via PostgREST.
--    SECURITY DEFINER so service_role inherits MV-owner privileges (mirrors
--    the pattern in scripts/migration-rate-limits.sql). Default public-schema
--    EXECUTE grants apply (anon/auth/service_role).
-- statement_timeout='60s' overrides PostgREST's ~9s default for the duration
-- of THIS RPC. The actual REFRESH is sub-second on a 472 KB MV but PostgREST
-- + PG-locking dance can spike; 60s is the conservative ceiling.
-- Empirical (2026-05-28): ~14s end-to-end through PostgREST.
CREATE OR REPLACE FUNCTION public.refresh_team_rolling_8()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY sofascore_team_rolling_8;
  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION public.refresh_team_rolling_8() IS
  'Concurrent refresh wrapper called by scripts/refresh-rolling-8.mjs. '
  'SECURITY DEFINER so service_role inherits MV-owner privileges. '
  'statement_timeout=60s overrides PostgREST default (~9s).';

COMMIT;

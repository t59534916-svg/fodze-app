-- Migration: sofascore_match table + chance-quality views with data_quality_tier
-- Applied 2026-04-30. Depends on sofascore_shotmap (see migration-sofascore-shotmap.sql).

-- ── 1. Match metadata table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sofascore_match (
  game_id           INT PRIMARY KEY,
  league            TEXT NOT NULL,
  season            TEXT NOT NULL,
  week              SMALLINT NOT NULL,
  home_team         TEXT NOT NULL,
  home_team_id      INT NOT NULL,
  away_team         TEXT NOT NULL,
  away_team_id      INT NOT NULL,
  home_score        SMALLINT,
  away_score        SMALLINT,
  start_timestamp   BIGINT,
  status            TEXT,
  inserted_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sofascore_match_league_season_week
  ON sofascore_match (league, season, week);
CREATE INDEX IF NOT EXISTS idx_sofascore_match_home_team
  ON sofascore_match (home_team, league, season);
CREATE INDEX IF NOT EXISTS idx_sofascore_match_away_team
  ON sofascore_match (away_team, league, season);

-- ── 2. Data-quality classifier ─────────────────────────────────────
-- Hardcoded based on empirical 25/26 audit:
--   premium  — full xG + assisted/fast-break tags
--   partial  — full xG, no assisted/fast-break (Liga 3 only)
--   volume   — shot events, NO xG (la_liga2, ligue_2)
CREATE OR REPLACE FUNCTION sofascore_data_quality_tier(p_league TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_league IN ('la_liga2', 'ligue_2')           THEN 'volume'
    WHEN p_league = 'liga3'                            THEN 'partial'
    WHEN p_league IN ('bundesliga','bundesliga2','epl','la_liga',
                      'serie_a','serie_b','ligue_1','championship') THEN 'premium'
    ELSE 'unknown'
  END;
$$;

-- ── 3. Per-team-per-game chance quality view ───────────────────────
-- JOINs match metadata to expose team_name + classifies tier.
DROP VIEW IF EXISTS sofascore_team_rolling_8;
DROP VIEW IF EXISTS sofascore_team_chance_quality;

CREATE VIEW sofascore_team_chance_quality AS
SELECT
  s.game_id,
  s.league,
  s.season,
  s.week,
  s.is_home,
  CASE WHEN s.is_home THEN m.home_team   ELSE m.away_team   END AS team,
  CASE WHEN s.is_home THEN m.home_team_id ELSE m.away_team_id END AS team_id,
  CASE WHEN s.is_home THEN m.away_team   ELSE m.home_team   END AS opponent,
  m.start_timestamp,
  sofascore_data_quality_tier(s.league)                          AS data_quality_tier,
  COUNT(*)                                                              AS shots,
  COUNT(*) FILTER (WHERE s.shot_type = 'goal')                          AS goals,
  COUNT(*) FILTER (WHERE s.shooter_x < 17)                              AS shots_in_box,
  COUNT(*) FILTER (WHERE s.shot_type IN ('save', 'goal'))               AS shots_on_target,
  ROUND(SUM(s.xg)::numeric, 3)                                          AS sum_xg,
  ROUND(SUM(s.xgot)::numeric, 3)                                        AS sum_xgot,
  ROUND(AVG(s.xg)::numeric, 4)                                          AS mean_shot_xg,
  ROUND((AVG(s.xgot) FILTER (WHERE s.xgot > 0))::numeric, 4)            AS mean_shot_xgot_on_target,
  ROUND(
    (SUM(s.xg) FILTER (WHERE s.situation IN ('corner','set-piece','throw-in-set-piece','free-kick'))
      / NULLIF(SUM(s.xg), 0))::numeric, 4)                              AS setpiece_xg_share,
  ROUND(
    (SUM(s.xg) FILTER (WHERE s.situation = 'penalty')
      / NULLIF(SUM(s.xg), 0))::numeric, 4)                              AS penalty_xg_share,
  ROUND((SUM(s.xg) FILTER (WHERE s.situation IN ('assisted','regular','fast-break')))::numeric, 3)
                                                                        AS openplay_xg,
  ROUND(((COUNT(*) FILTER (WHERE s.xg > 0.3))::numeric / COUNT(*))::numeric, 4) AS big_chance_share,
  ROUND((SUM(s.xg) FILTER (WHERE s.situation = 'fast-break'))::numeric, 3) AS fastbreak_xg,
  ROUND(((COUNT(*) FILTER (WHERE s.body_part = 'head'))::numeric / COUNT(*))::numeric, 4) AS header_share
FROM sofascore_shotmap s
LEFT JOIN sofascore_match m ON m.game_id = s.game_id
GROUP BY s.game_id, s.league, s.season, s.week, s.is_home,
         m.home_team, m.home_team_id, m.away_team, m.away_team_id, m.start_timestamp;

-- ── 4. Rolling-8-games per team (engine input shape) ───────────────
CREATE VIEW sofascore_team_rolling_8 AS
WITH ranked AS (
  SELECT
    cq.*,
    ROW_NUMBER() OVER (
      PARTITION BY league, season, team
      ORDER BY start_timestamp DESC NULLS LAST, week DESC
    ) AS recency
  FROM sofascore_team_chance_quality cq
  WHERE team IS NOT NULL
)
SELECT
  league,
  season,
  team,
  team_id,
  data_quality_tier,
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
GROUP BY league, season, team, team_id, data_quality_tier;

COMMENT ON VIEW sofascore_team_chance_quality IS
  'Per-team-per-game chance quality. NOTE: Liga 3 has no assisted/fast-break tagging — fastbreak_xg = 0 there. La Liga 2 + Ligue 2 have NO xG — all xG-derived columns NULL. Use data_quality_tier to gate features.';
COMMENT ON VIEW sofascore_team_rolling_8 IS
  'Per-team last-8-games chance quality. Engine input shape — JOIN by (league, season, team) to fixture team-name.';

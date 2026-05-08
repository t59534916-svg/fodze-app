-- Migration: Sofascore extras → team_xg_history feature columns
-- ════════════════════════════════════════════════════════════════
-- Adds 18 per-team-per-match feature columns sourced from Sofascore's
-- /statistics endpoint (period='ALL' → engine sees full-match aggregates).
--
-- Pre-existing columns (not touched by this migration):
--   xg, xga, goals_for/_against, shots_*, corners_*, npxg/npxga,
--   xg_openplay/_setpiece, xg_while_level/_leading/_trailing
--
-- New columns:
--   ball_possession_pct       — 0..100
--   big_chances, big_chances_missed
--   passes_total, passes_accurate, pass_accuracy_pct
--   tackles_total, tackles_won
--   errors_lead_to_shot, errors_lead_to_goal
--   ground_duels_won, ground_duels_total
--   aerial_duels_won, aerial_duels_total
--   dribbles_won, dribbles_attempted
--   fouls, yellow_cards, red_cards
--   goals_prevented           — GK above-expected save performance
--
-- Source: sofascore_match_statistics (period='ALL' rows) via
-- scripts/bridge-sofascore-extras-to-team-xg.mjs.
-- Engine consumption: optional new features in v3+ retrains
-- (most features are NULL for non-Sofascore rows; engine must
-- gate on coverage just like it does for npxg/setpiece today).

ALTER TABLE team_xg_history
  ADD COLUMN IF NOT EXISTS ball_possession_pct  REAL,
  ADD COLUMN IF NOT EXISTS big_chances          SMALLINT,
  ADD COLUMN IF NOT EXISTS big_chances_missed   SMALLINT,
  ADD COLUMN IF NOT EXISTS passes_total         SMALLINT,
  ADD COLUMN IF NOT EXISTS passes_accurate      SMALLINT,
  ADD COLUMN IF NOT EXISTS pass_accuracy_pct    REAL,
  ADD COLUMN IF NOT EXISTS tackles_total        SMALLINT,
  ADD COLUMN IF NOT EXISTS tackles_won          SMALLINT,
  ADD COLUMN IF NOT EXISTS errors_lead_to_shot  SMALLINT,
  ADD COLUMN IF NOT EXISTS errors_lead_to_goal  SMALLINT,
  ADD COLUMN IF NOT EXISTS ground_duels_won     SMALLINT,
  ADD COLUMN IF NOT EXISTS ground_duels_total   SMALLINT,
  ADD COLUMN IF NOT EXISTS aerial_duels_won     SMALLINT,
  ADD COLUMN IF NOT EXISTS aerial_duels_total   SMALLINT,
  ADD COLUMN IF NOT EXISTS dribbles_won         SMALLINT,
  ADD COLUMN IF NOT EXISTS dribbles_attempted   SMALLINT,
  ADD COLUMN IF NOT EXISTS fouls                SMALLINT,
  ADD COLUMN IF NOT EXISTS yellow_cards         SMALLINT,
  ADD COLUMN IF NOT EXISTS red_cards            SMALLINT,
  ADD COLUMN IF NOT EXISTS goals_prevented      REAL;

-- Coverage audit index — fastest way to count "has Sofascore extras"
CREATE INDEX IF NOT EXISTS idx_xg_history_has_extras
  ON team_xg_history (league, match_date)
  WHERE big_chances IS NOT NULL;

COMMENT ON COLUMN team_xg_history.big_chances IS
  'Sofascore Big-chance count (xg ≥ 0.3 typically). NULL for rows not bridged from sofascore_match_statistics.';
COMMENT ON COLUMN team_xg_history.tackles_won IS
  'Derived: tackles_total × tackles_won_pct/100. Sofascore returns the pct as a separate stat name.';
COMMENT ON COLUMN team_xg_history.goals_prevented IS
  'Goalkeeper performance: xG-against minus goals-conceded. Positive = above-expected. Useful for GK form features.';

-- ════════════════════════════════════════════════════════════════
-- VIEW: sofascore_team_match_stats
-- ════════════════════════════════════════════════════════════════
-- Joins sofascore_match_statistics(period='ALL') × sofascore_match to
-- expose team_name + opponent + start_timestamp + data_quality_tier in
-- one row. Mirrors sofascore_team_chance_quality's shape so the bridge
-- script can fetch from it directly.
--
-- Filter: data_quality_tier IN ('premium', 'partial') — same filter as
-- existing bridge. 'volume' tier (la_liga2, ligue_2) has no Sofascore
-- xG so its match stats are also less reliable / partially populated.
CREATE OR REPLACE VIEW sofascore_team_match_stats AS
SELECT
  ms.game_id,
  ms.is_home,
  ms.period,
  m.league,
  m.season,
  m.week,
  m.start_timestamp,
  CASE WHEN ms.is_home THEN m.home_team    ELSE m.away_team    END AS team,
  CASE WHEN ms.is_home THEN m.home_team_id ELSE m.away_team_id END AS team_id,
  CASE WHEN ms.is_home THEN m.away_team    ELSE m.home_team    END AS opponent,
  sofascore_data_quality_tier(m.league)                            AS data_quality_tier,
  -- Forward all the new feature columns (period='ALL' rows only)
  ms.ball_possession_pct,
  ms.expected_goals,
  ms.big_chances,
  ms.big_chances_missed,
  ms.total_shots,
  ms.shots_on_target,
  ms.shots_inside_box,
  ms.shots_outside_box,
  ms.passes_total,
  ms.passes_accurate,
  ms.pass_accuracy_pct,
  ms.long_balls_accurate,
  ms.long_balls_total,
  ms.crosses_accurate,
  ms.crosses_total,
  ms.tackles_total,
  ms.tackles_won,
  ms.interceptions,
  ms.recoveries,
  ms.clearances,
  ms.errors_lead_to_shot,
  ms.errors_lead_to_goal,
  ms.ground_duels_won,
  ms.ground_duels_total,
  ms.aerial_duels_won,
  ms.aerial_duels_total,
  ms.dribbles_won,
  ms.dribbles_attempted,
  ms.fouls,
  ms.yellow_cards,
  ms.red_cards,
  ms.corner_kicks,
  ms.offsides,
  ms.goalkeeper_saves,
  ms.goals_prevented
FROM sofascore_match_statistics ms
JOIN sofascore_match m ON m.game_id = ms.game_id
WHERE ms.period = 'ALL';

COMMENT ON VIEW sofascore_team_match_stats IS
  'Per-team-per-match aggregate stats (period=ALL). Use as input for bridge-sofascore-extras-to-team-xg.mjs.';

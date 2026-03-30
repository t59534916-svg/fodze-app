-- Migration: Add npxG columns to team_xg_history
-- npxG = Non-Penalty xG (xG with penalty shots excluded)
-- Used by @annafrick13 v2.0 engine

ALTER TABLE team_xg_history ADD COLUMN IF NOT EXISTS npxg NUMERIC(5,2);
ALTER TABLE team_xg_history ADD COLUMN IF NOT EXISTS npxga NUMERIC(5,2);

-- Index for efficient queries on npxg
CREATE INDEX IF NOT EXISTS idx_team_xg_history_npxg
  ON team_xg_history (team, league, match_date DESC)
  WHERE npxg IS NOT NULL;

COMMENT ON COLUMN team_xg_history.npxg IS 'Non-penalty xG scored (penalties excluded from xG sum)';
COMMENT ON COLUMN team_xg_history.npxga IS 'Non-penalty xG conceded (penalties excluded from xGA sum)';

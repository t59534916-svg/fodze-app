-- FODZE: Game-State-Adjusted xG columns on team_xg_history
-- ═══════════════════════════════════════════════════════════════════════
-- Populated by scripts/backfill-xg-by-state.mjs (Understat shot-timeline
-- re-scrape) for the 6 Understat leagues. Consumed by the v2 engine via
-- src/lib/poisson-ml-engine-v2.ts — new features such as
-- `xg_while_level_diff_ewma_l10` measure how a team generates xG in
-- specific score states.
--
-- Syzygy Analytics (Nov 2025) + StatsBomb "Game States and Loss Aversion"
-- document that raw season-total xG systematically overrates strong teams
-- that spend lots of minutes in leading-state "defensive shell" mode.
-- The `xg_while_level` columns let the engine use a cleaner strength
-- signal (xG per 90 while tied) as the team-quality prior, then layer
-- behavior-in-lead / behavior-trailing as separate features.
--
-- All columns are NUMERIC NULL — existing rows (pre-backfill, or rows from
-- shots-model / goals-proxy sources that lack shot timelines) stay lookup-
-- compatible. The runtime falls back to season-total × state-ratio-prior
-- when a state column is null (see src/lib/supabase.ts).

ALTER TABLE team_xg_history
  ADD COLUMN IF NOT EXISTS xg_while_level NUMERIC,
  ADD COLUMN IF NOT EXISTS xg_while_leading NUMERIC,
  ADD COLUMN IF NOT EXISTS xg_while_trailing NUMERIC,
  ADD COLUMN IF NOT EXISTS xga_while_level NUMERIC,
  ADD COLUMN IF NOT EXISTS xga_while_leading NUMERIC,
  ADD COLUMN IF NOT EXISTS xga_while_trailing NUMERIC,
  ADD COLUMN IF NOT EXISTS minutes_level INT,
  ADD COLUMN IF NOT EXISTS minutes_leading INT,
  ADD COLUMN IF NOT EXISTS minutes_trailing INT;

-- Partial index: speeds up the "rows that already have state data"
-- coverage check used by audit-data-quality.mjs.
CREATE INDEX IF NOT EXISTS idx_xg_history_has_state
  ON team_xg_history(league, match_date)
  WHERE xg_while_level IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- FODZE — team_xg_history shots columns
-- ═══════════════════════════════════════════════════════════════════════
-- Adds per-match shots counts so backtests can score expected-shots
-- against actual-shots. Data source: football-data.co.uk HS/HST/AS/AST
-- columns, already read by scripts/backfill-shots-xg.mjs to derive xG
-- but not previously persisted.
--
-- After applying this migration, re-run:
--   node scripts/backfill-shots-xg.mjs --all
-- to populate shots_* for every CSV-sourced league (12 non-Understat
-- leagues + Understat leagues from 2025/26). Understat-only rows stay
-- null — Understat doesn't publish per-match shots at team level.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE team_xg_history
  ADD COLUMN IF NOT EXISTS shots_for INT,
  ADD COLUMN IF NOT EXISTS shots_against INT,
  ADD COLUMN IF NOT EXISTS shots_on_target_for INT,
  ADD COLUMN IF NOT EXISTS shots_on_target_against INT;

CREATE INDEX IF NOT EXISTS idx_xg_history_has_shots
  ON team_xg_history(league, match_date)
  WHERE shots_for IS NOT NULL;

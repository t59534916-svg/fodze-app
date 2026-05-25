-- ═══════════════════════════════════════════════════════════════════════
-- migration-player-season-stats.sql
-- New table for FootyStats Players CSV: per-player × season aggregates.
--
-- Extends FODZE's player-level coverage from Top-5 Understat (player_xg_history)
-- to ALL 17 lower-tier leagues (championship, liga3, serie_b, etc.). Enables
-- lineup_quality features, GK xG-faced/goals-prevented metrics, market-value
-- weights for absence-impact, and transfer-impact detection across seasons.
--
-- Selects ~45 high-value columns from FS's 271-col Players CSV. Skipped:
-- percentile-only fields (downstream-computable), most home/away splits
-- (only overall + a few key ones kept), shirt_number, salary_gbp/usd
-- (eur sufficient), additional_info free-text, ratings_total dup.
--
-- One row per (league, season, full_name, current_club) — mid-season
-- transfers within a league create 2 separate rows (FS-default behavior).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_season_stats (
  id                BIGSERIAL PRIMARY KEY,

  -- ── Identity ──────────────────────────────────────────────────────
  full_name         TEXT      NOT NULL,
  league            TEXT      NOT NULL,                  -- FODZE league key
  season            TEXT      NOT NULL,                  -- "21/22"
  current_club      TEXT,                                 -- canonicalized
  position          TEXT,                                 -- Forward/Midfielder/Defender/Goalkeeper
  age               INT,
  nationality       TEXT,

  -- ── Volume ────────────────────────────────────────────────────────
  minutes_played    INT,
  appearances       INT,
  games_started     INT,
  games_subbed_in   INT,
  games_subbed_out  INT,

  -- ── Production (xG/xA — gold-standard fields) ────────────────────
  goals             INT,
  assists           INT,
  xg_total          NUMERIC(7,3),                        -- FS xG (parametric)
  xg_per_90         NUMERIC(6,3),
  npxg_total        NUMERIC(7,3),                        -- non-penalty xG
  npxg_per_90       NUMERIC(6,3),
  xa_total          NUMERIC(7,3),                        -- expected assists
  xa_per_90         NUMERIC(6,3),
  key_passes_total  INT,
  chances_created   INT,

  -- ── Shooting ─────────────────────────────────────────────────────
  shots_total       INT,
  shots_on_target   INT,
  shot_accuracy_pct NUMERIC(5,2),
  shot_conversion_rate NUMERIC(5,2),

  -- ── Defensive (Understat doesn't have these — engine value-add) ──
  tackles_successful INT,
  interceptions      INT,
  blocks             INT,
  clearances         INT,
  duels_won          INT,
  duels_total        INT,
  aerial_duels_won   INT,

  -- ── GK-specific (enables goals_prevented per Liga × Saison) ──────
  saves              INT,
  xg_faced_total     NUMERIC(7,3),                        -- key: saves - xg_faced = goals_prevented
  clean_sheets       INT,
  conceded           INT,
  save_percentage    NUMERIC(5,2),

  -- ── Discipline ───────────────────────────────────────────────────
  yellow_cards       INT,
  red_cards          INT,
  fouls_committed    INT,
  fouls_drawn        INT,
  penalties_committed INT,
  penalties_scored   INT,

  -- ── Value + Meta ──────────────────────────────────────────────────
  market_value_eur   BIGINT,                              -- Transfermarkt-style
  annual_salary_eur  BIGINT,
  average_rating     NUMERIC(4,2),
  man_of_the_match   INT,

  -- ── Bookkeeping ───────────────────────────────────────────────────
  source             TEXT      NOT NULL DEFAULT 'footystats',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT player_season_stats_unique
    UNIQUE (league, season, full_name, current_club),

  -- Range guards: catch parse bugs
  CONSTRAINT player_season_stats_minutes_range
    CHECK (minutes_played IS NULL OR minutes_played BETWEEN 0 AND 5500),
  CONSTRAINT player_season_stats_appearances_range
    CHECK (appearances IS NULL OR appearances BETWEEN 0 AND 80),
  CONSTRAINT player_season_stats_age_range
    CHECK (age IS NULL OR age BETWEEN 14 AND 50),
  CONSTRAINT player_season_stats_xg_nonneg
    CHECK (xg_total IS NULL OR xg_total >= 0),
  CONSTRAINT player_season_stats_save_pct_range
    CHECK (save_percentage IS NULL OR save_percentage BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_player_season_stats_league_season
  ON player_season_stats (league, season);

CREATE INDEX IF NOT EXISTS idx_player_season_stats_club
  ON player_season_stats (current_club, league, season);

CREATE INDEX IF NOT EXISTS idx_player_season_stats_name
  ON player_season_stats (full_name);

-- Hot path for lineup_quality computation: filter to active players per club
CREATE INDEX IF NOT EXISTS idx_player_season_stats_minutes_filter
  ON player_season_stats (current_club, league, season, minutes_played DESC)
  WHERE minutes_played >= 90;

-- ── Row-Level Security ──────────────────────────────────────────────
ALTER TABLE player_season_stats ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'player_season_stats'
      AND policyname = 'player_season_stats_anon_read'
  ) THEN
    EXECUTE 'CREATE POLICY player_season_stats_anon_read
             ON player_season_stats FOR SELECT TO anon USING (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'player_season_stats'
      AND policyname = 'player_season_stats_svc_all'
  ) THEN
    EXECUTE 'CREATE POLICY player_season_stats_svc_all
             ON player_season_stats FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;
END
$$;

COMMENT ON TABLE player_season_stats IS
  'FootyStats Players CSV import — per-player × season aggregates for 17 lower-tier leagues. Extends player_xg_history (Understat Top-5 only). Enables lineup_quality + GK goals_prevented for all 22 FODZE leagues.';
COMMENT ON COLUMN player_season_stats.xg_faced_total IS
  'Sum of opponent xG faced (GK only). Combined with saves_total: goals_prevented = (xg_faced_total + conceded) - (saves + clean_sheets fixup). FS parametric model — for Top-5 prefer Understat npxG.';
COMMENT ON COLUMN player_season_stats.npxg_total IS
  'Non-penalty xG — gold standard for attacker quality. Excludes penalty kicks which are high-variance + non-skill-attributable.';

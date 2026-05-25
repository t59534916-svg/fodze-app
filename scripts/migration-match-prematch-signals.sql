-- ═══════════════════════════════════════════════════════════════════════
-- migration-match-prematch-signals.sql
-- New table for FootyStats CSV pre-match value-adds (does NOT touch
-- team_xg_history — those rows are sourced from Sofa/Understat which
-- are higher-quality and must not be overwritten).
--
-- Captures:
--   • home/away_prematch_ppg — points-per-game forecast (pre-kickoff)
--   • home/away_prematch_xg  — FS-Model pre-match xG forecast
--   • prematch_btts_pct      — FS-derived BTTS% pre-match
--   • prematch_over15/25/35/45_pct — FS over/under markets pre-match
--   • prematch_avg_corners / avg_cards
--   • attendance + stadium (post-match meta)
--
-- One row per (league, match_date, home_team, away_team). Canonical FODZE
-- team names + canonicalMatchKey() string for cross-table joins.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS match_prematch_signals (
  id                BIGSERIAL PRIMARY KEY,

  -- ── Identity ──────────────────────────────────────────────────────
  -- match_key: Canonical FODZE format from src/lib/format.ts::matchKey()
  --            — same string `bets.match_key` and `odds_closing_history.match_key`
  --            use. Lets us JOIN to those without re-deriving.
  match_key         TEXT      NOT NULL,
  league            TEXT      NOT NULL,
  season            TEXT,                          -- e.g. "22/23"
  match_date        DATE      NOT NULL,
  home_team         TEXT      NOT NULL,            -- canonicalized
  away_team         TEXT      NOT NULL,            -- canonicalized
  game_week         INT,

  -- ── Pre-Match Strength (FS-Model forecasts) ───────────────────────
  home_prematch_ppg     NUMERIC(5,3),              -- 0-3 typical
  away_prematch_ppg     NUMERIC(5,3),
  home_prematch_xg      NUMERIC(6,3),              -- 0-5 typical
  away_prematch_xg      NUMERIC(6,3),

  -- ── Pre-Match Market signals (FS-published %) ─────────────────────
  prematch_avg_goals    NUMERIC(5,2),              -- 0-7 typical
  prematch_btts_pct     NUMERIC(5,2),              -- 0-100
  prematch_over15_pct   NUMERIC(5,2),
  prematch_over25_pct   NUMERIC(5,2),
  prematch_over35_pct   NUMERIC(5,2),
  prematch_over45_pct   NUMERIC(5,2),
  prematch_avg_corners  NUMERIC(5,2),              -- 0-15 typical
  prematch_avg_cards    NUMERIC(5,2),              -- 0-10 typical

  -- ── Match Meta (post-match) ───────────────────────────────────────
  attendance        INT,
  stadium           TEXT,

  -- ── Bookkeeping ───────────────────────────────────────────────────
  source            TEXT      NOT NULL DEFAULT 'footystats',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT match_prematch_signals_unique
    UNIQUE (league, match_date, home_team, away_team),

  -- Range guards: probability fields must be 0-100
  CONSTRAINT match_prematch_signals_btts_range
    CHECK (prematch_btts_pct IS NULL OR prematch_btts_pct BETWEEN 0 AND 100),
  CONSTRAINT match_prematch_signals_over25_range
    CHECK (prematch_over25_pct IS NULL OR prematch_over25_pct BETWEEN 0 AND 100),
  CONSTRAINT match_prematch_signals_ppg_h_range
    CHECK (home_prematch_ppg IS NULL OR home_prematch_ppg BETWEEN 0 AND 3),
  CONSTRAINT match_prematch_signals_ppg_a_range
    CHECK (away_prematch_ppg IS NULL OR away_prematch_ppg BETWEEN 0 AND 3),
  CONSTRAINT match_prematch_signals_xg_h_range
    CHECK (home_prematch_xg IS NULL OR home_prematch_xg BETWEEN 0 AND 10),
  CONSTRAINT match_prematch_signals_xg_a_range
    CHECK (away_prematch_xg IS NULL OR away_prematch_xg BETWEEN 0 AND 10)
);

CREATE INDEX IF NOT EXISTS idx_prematch_signals_match_key
  ON match_prematch_signals (match_key);

CREATE INDEX IF NOT EXISTS idx_prematch_signals_league_date
  ON match_prematch_signals (league, match_date);

-- ── Row-Level Security ──────────────────────────────────────────────
ALTER TABLE match_prematch_signals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'match_prematch_signals'
      AND policyname = 'match_prematch_signals_anon_read'
  ) THEN
    EXECUTE 'CREATE POLICY match_prematch_signals_anon_read
             ON match_prematch_signals FOR SELECT TO anon USING (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'match_prematch_signals'
      AND policyname = 'match_prematch_signals_svc_all'
  ) THEN
    EXECUTE 'CREATE POLICY match_prematch_signals_svc_all
             ON match_prematch_signals FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;
END
$$;

COMMENT ON TABLE match_prematch_signals IS
  'FootyStats CSV pre-match value-adds (PPG/xG-forecast/%, attendance, stadium). Does NOT touch team_xg_history (Sofa/Understat are higher-quality there).';
COMMENT ON COLUMN match_prematch_signals.match_key IS
  'Canonical FODZE format from src/lib/format.ts::matchKey(league, home, away). Use this to JOIN against bets, odds_closing_history, epistemic_trails.';
COMMENT ON COLUMN match_prematch_signals.home_prematch_xg IS
  'FS-Model pre-match xG forecast for home team. A SECOND xG signal alongside Sofa shotmap + Understat for ensemble/cross-validation.';
COMMENT ON COLUMN match_prematch_signals.prematch_over25_pct IS
  'FS-published pre-match Over 2.5 probability (0-100). Useful as calibration anchor.';

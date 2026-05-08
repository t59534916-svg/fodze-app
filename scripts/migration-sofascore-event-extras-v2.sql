-- Migration: Sofascore HIGH-SIGNAL per-event extras (v2)
-- ════════════════════════════════════════════════════════
-- Adds 3 new tables for the HIGH-SIGNAL endpoints validated 2026-05-08:
--
--   sofascore_match_managers    — per-game home + away coach (id, name, ...)
--                                 Use case: NEUER-TRAINER tag auto-detection
--                                 by comparing manager_id between consecutive
--                                 settled matches per team.
--
--   sofascore_pregame_form      — Sofa's pre-match per-team form summary:
--                                 avgRating, league position, points (or
--                                 whatever 'value' represents in label),
--                                 and last-5 W/D/L array. Predictive — this
--                                 endpoint is meant to be queried BEFORE the
--                                 match for use in pre-game UIs.
--                                 Use case: replace our derived form-string
--                                 with Sofa's recency-weighted official one.
--
--   sofascore_team_streaks      — per-game streaks across two categories:
--                                 'general' (~8 entries about each team's
--                                 recent runs) and 'head2head' (~5 entries
--                                 about the matchup history). Each entry
--                                 has {name, value, team, continued}.
--                                 Use case: momentum-aware features (Sofa's
--                                 streak summaries replace our derived
--                                 xg_momentum proxy).
--
-- Plus extending sofascore_extras_state with 3 new has_* flags so the
-- fetcher knows to pull these endpoints for games it already partially
-- pulled.
--
-- Source: api.sofascore.com/api/v1/event/{game_id}/{managers,pregame-form,team-streaks}
-- Fetcher: tools/sofascore/fetch_match_extras.py (extended in same commit;
--          requires Tor proxy via --use-tor flag — Cloudflare blocks direct
--          API access on these endpoints since 2026-05-07)
-- Loader:  tools/sofascore/load_extras_to_supabase.py (extended)
--
-- Idempotent: all CREATE TABLE / ADD COLUMN guarded with IF NOT EXISTS.
-- All new columns nullable. No existing data touched.
-- Re-applying this file on production is a no-op.
--
-- Production-safety:
--   - Does NOT touch sofascore_match, sofascore_match_statistics,
--     sofascore_player_match_stats, sofascore_incidents, sofascore_average_positions
--   - Does NOT touch team_xg_history, team_metadata, matchdays, bets
--   - Existing rows in sofascore_extras_state get NEW columns defaulting to
--     FALSE → fetcher will detect "incomplete" and pull the new endpoints
--     on next run. That's the desired behavior.

-- ── 1. Match managers (home + away) ───────────────────────────────
-- Sofa /event/{id}/managers returns:
--   {homeManager: {id, name, slug, shortName, fieldTranslations:{...}},
--    awayManager: {id, name, slug, shortName, fieldTranslations:{...}}}
-- We flatten to one row per (game, is_home). Manager id is the stable key
-- for coaching-change detection across consecutive matches per team.
CREATE TABLE IF NOT EXISTS sofascore_match_managers (
  game_id            INT NOT NULL,
  is_home            BOOLEAN NOT NULL,
  manager_id         INT NOT NULL,
  manager_name       TEXT,
  manager_short_name TEXT,
  manager_slug       TEXT,
  raw_extras         JSONB,        -- fieldTranslations + any future fields
  inserted_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_match_managers_pk PRIMARY KEY (game_id, is_home)
);

-- Index for the change-detection query: "find this manager's history".
CREATE INDEX IF NOT EXISTS idx_sofascore_managers_id
  ON sofascore_match_managers (manager_id);

COMMENT ON TABLE sofascore_match_managers IS
  'Per-game manager attribution. Source: /event/{id}/managers. Stable manager_id enables coaching-change detection by comparing consecutive matches per team. Forever cache after status=Ended.';

-- ── 2. Pregame form (per team) ────────────────────────────────────
-- Sofa /event/{id}/pregame-form returns:
--   {homeTeam: {avgRating: "6.92", position: 7, value: "7", form: ["D","L","L","W","W"]},
--    awayTeam: {...},
--    label: "Pts"}
-- Notes:
--   - avgRating + value are returned as STRINGS by Sofa (json type quirk).
--     Loader parses to REAL/INT before insert.
--   - form is a 5-element array of W/D/L letters (most-recent first per Sofa).
--   - label is typically "Pts" but spec leaves room for variations (e.g. "PG"
--     in cup competitions); store as TEXT.
CREATE TABLE IF NOT EXISTS sofascore_pregame_form (
  game_id            INT NOT NULL,
  is_home            BOOLEAN NOT NULL,
  avg_rating         REAL,
  league_position    SMALLINT,
  league_value       SMALLINT,         -- whatever the 'value' field represents (Pts in league)
  label              TEXT,             -- typically 'Pts'
  form               TEXT,             -- e.g. 'WLDDW' (5 chars, joined from array)
  raw_extras         JSONB,
  inserted_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_pregame_form_pk PRIMARY KEY (game_id, is_home)
);

COMMENT ON TABLE sofascore_pregame_form IS
  'Sofa pre-match form summary per team. Source: /event/{id}/pregame-form. avgRating is recency-weighted, position/value reflect standings BEFORE this match. Forever cache.';
COMMENT ON COLUMN sofascore_pregame_form.form IS
  'Last-5 results joined as 5-char string (W/D/L), most-recent first. Sofa-canonical letters.';

-- ── 3. Team streaks ───────────────────────────────────────────────
-- Sofa /event/{id}/team-streaks returns two categories:
--   general (~8 entries):  team-specific recent runs ("Wins", "No losses",
--                          "Less than 2.5 goals", "First to score",
--                          "Less than 4.5 cards", "Less than 10.5 corners")
--   head2head (~5 entries): matchup-specific history ("Without clean sheet",
--                          "Both teams scoring", "First to score",
--                          "Less than 4.5 cards")
-- Each entry: {name (str), value (str!), team ('home'|'away'|'both'), continued (bool)}
-- We preserve string values as-is (formats vary: "3", "5/7", "8/10") for
-- forensics; numeric extraction is loader's responsibility for engine features.
CREATE TABLE IF NOT EXISTS sofascore_team_streaks (
  game_id            INT NOT NULL,
  category           TEXT NOT NULL,    -- 'general' | 'head2head'
  streak_idx         SMALLINT NOT NULL,
  name               TEXT,
  value_text         TEXT,             -- raw string ("3", "5/7")
  value_numerator    SMALLINT,         -- parsed: "5/7" → 5, "3" → 3
  value_denominator  SMALLINT,         -- parsed: "5/7" → 7, "3" → NULL
  team               TEXT,             -- 'home' | 'away' | 'both'
  continued          BOOLEAN,
  raw_extras         JSONB,
  inserted_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_team_streaks_pk PRIMARY KEY (game_id, category, streak_idx)
);

CREATE INDEX IF NOT EXISTS idx_sofascore_streaks_game
  ON sofascore_team_streaks (game_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_streaks_category
  ON sofascore_team_streaks (category, name);

COMMENT ON TABLE sofascore_team_streaks IS
  'Per-game streak entries. Source: /event/{id}/team-streaks. value_text preserves raw Sofa format ("5/7"); value_numerator/denominator are parser convenience. Forever cache.';

-- ── 4. Extend extras-state tracker ───────────────────────────────
-- Add 3 new has_* flags so fetch_match_extras.py knows which games still
-- need the new endpoints pulled. Existing rows default to FALSE → fetcher
-- will pick them up on next run. That's intentional — we want to backfill
-- the new endpoints for already-partially-pulled games.

ALTER TABLE sofascore_extras_state
  ADD COLUMN IF NOT EXISTS has_managers      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_pregame_form  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_team_streaks  BOOLEAN NOT NULL DEFAULT FALSE;

-- Replace the v1 partial index with a v2 that includes the new flags.
-- The old index is silently fine but stops being maximally useful once
-- fetcher's pending-detection includes the new flags.
DROP INDEX IF EXISTS idx_sofascore_extras_state_pending;
CREATE INDEX IF NOT EXISTS idx_sofascore_extras_state_pending_v2
  ON sofascore_extras_state (league, season)
  WHERE NOT (
    has_statistics AND has_player_stats AND has_incidents AND has_avg_positions
    AND has_managers AND has_pregame_form AND has_team_streaks
  );

COMMENT ON COLUMN sofascore_extras_state.has_managers IS
  'Set TRUE after /event/{id}/managers payload successfully loaded into sofascore_match_managers. Added 2026-05-08.';
COMMENT ON COLUMN sofascore_extras_state.has_pregame_form IS
  'Set TRUE after /event/{id}/pregame-form payload successfully loaded into sofascore_pregame_form. Added 2026-05-08.';
COMMENT ON COLUMN sofascore_extras_state.has_team_streaks IS
  'Set TRUE after /event/{id}/team-streaks payload successfully loaded into sofascore_team_streaks. Added 2026-05-08.';

-- ── 5. Per-team manager history view ─────────────────────────────
-- Pre-joins sofascore_match_managers × sofascore_match so consumers can
-- ORDER BY start_timestamp DESC LIMIT 2 per team to detect coaching changes.
-- Filtering: ?team_id=eq.X (preferred, stable) or ?team=eq.<team_name>
-- Used by scripts/_lib/matchday-enrich.mjs::deriveCoachingChangeTag.
CREATE OR REPLACE VIEW sofascore_team_manager_history AS
SELECT
  m.start_timestamp,
  m.league,
  m.season,
  m.week,
  m.game_id,
  mgr.is_home,
  CASE WHEN mgr.is_home THEN m.home_team    ELSE m.away_team    END AS team,
  CASE WHEN mgr.is_home THEN m.home_team_id ELSE m.away_team_id END AS team_id,
  mgr.manager_id,
  mgr.manager_name,
  mgr.manager_short_name,
  mgr.manager_slug
FROM sofascore_match_managers mgr
JOIN sofascore_match m ON m.game_id = mgr.game_id;

COMMENT ON VIEW sofascore_team_manager_history IS
  'Per-team manager-by-match history. Use ORDER BY start_timestamp DESC LIMIT N to get the team''s most-recent N coaches. Coaching change = manager_id at row 0 != manager_id at row 1.';

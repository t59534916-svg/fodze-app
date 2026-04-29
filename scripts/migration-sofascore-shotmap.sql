-- Migration: Add sofascore_shotmap table for per-shot event data
-- Source: datafc library (Sofascore API via curl_cffi TLS-impersonation)
-- Use-case: chance-quality features for v2/v3 engine — mean_shot_xg,
-- pct_shots_in_box, setpiece_xg_share, xgot_per_shot, etc. — replacing
-- the Default-Werte that Phase 2.4 currently uses.

CREATE TABLE IF NOT EXISTS sofascore_shotmap (
  id              BIGSERIAL PRIMARY KEY,
  game_id         INT NOT NULL,
  league          TEXT NOT NULL,
  season          TEXT NOT NULL,
  week            SMALLINT NOT NULL,
  -- shooter
  player_id       INT NOT NULL DEFAULT 0,    -- 0 = unknown (rare; <0.1% in practice)
  player_name     TEXT,
  player_position TEXT,
  is_home         BOOLEAN NOT NULL,
  -- shot
  xg              REAL,
  xgot            REAL,
  body_part       TEXT,
  situation       TEXT,
  shot_type       TEXT NOT NULL DEFAULT '',
  goal_type       TEXT,
  goal_mouth_location TEXT,
  -- spatial (Sofascore coords [0,100]² — shooter side x>50, goal at x=100)
  shooter_x       REAL,
  shooter_y       REAL,
  goal_mouth_x    REAL,
  goal_mouth_y    REAL,
  goal_mouth_z    REAL,
  -- temporal
  minute          SMALLINT NOT NULL DEFAULT 0,
  added_minute    REAL,
  time_seconds    INT,
  -- ingest meta
  inserted_at     TIMESTAMPTZ DEFAULT NOW()
);

-- De-dupe key: same (game, player, minute, shot_type) means same shot.
-- Real UNIQUE constraint (not partial index) so PostgREST on_conflict works.
ALTER TABLE sofascore_shotmap
  ADD CONSTRAINT sofascore_shotmap_dedup
  UNIQUE (game_id, player_id, minute, shot_type);

-- Engine-feature lookups (per-team aggregates)
CREATE INDEX IF NOT EXISTS idx_sofascore_shotmap_league_season
  ON sofascore_shotmap (league, season);
CREATE INDEX IF NOT EXISTS idx_sofascore_shotmap_game
  ON sofascore_shotmap (game_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_shotmap_player
  ON sofascore_shotmap (player_id) WHERE player_id IS NOT NULL;

COMMENT ON TABLE  sofascore_shotmap IS 'Per-shot events from Sofascore via datafc lib. Used for chance-quality engine features (Phase 2.4 setpiece, big-chance share, xgot).';
COMMENT ON COLUMN sofascore_shotmap.xg IS 'Sofascore xG. NULL on ~0.2% of rows (mostly own-goals where attribution is ambiguous).';
COMMENT ON COLUMN sofascore_shotmap.xgot IS 'xG on target. 0 if shot was off-target/blocked.';
COMMENT ON COLUMN sofascore_shotmap.shooter_x IS 'Sofascore coords: x in [0,100] along pitch length, x→100 = goal end. Box is roughly x>83.';
COMMENT ON COLUMN sofascore_shotmap.situation IS 'assisted | corner | regular | fast-break | set-piece | throw-in-set-piece | free-kick | penalty';

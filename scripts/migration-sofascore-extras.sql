-- Migration: Sofascore post-match extras
-- ========================================
-- Adds 4 forever-cached tables for ended matches:
--   sofascore_match_statistics  — ~40 team-level stats (possession, passes, tackles, saves, duels, …)
--   sofascore_player_match_stats — per-player performance (rating, xA, key passes, touches in box, …)
--   sofascore_incidents          — goals, cards, subs, period changes (with minute + player attribution)
--   sofascore_average_positions  — taktische avg pitch positions per starter
--
-- Source: api.sofascore.com/api/v1/event/{game_id}/{statistics,lineups,incidents,average-positions}
-- Fetcher: tools/sofascore/fetch_match_extras.py (curl_cffi chrome124 TLS)
-- Loader:  tools/sofascore/load_extras_to_supabase.py
-- Sync:    scripts/sync-sofascore-extras.mjs (Phase 4.1 in refresh-all.mjs)
--
-- All 4 tables are forever-cache: once a match is `status='Ended'` and pulled, never refetch.
-- Idempotent via UNIQUE constraints.
-- Joins back to sofascore_match.game_id for league/season/team lookup.

-- ── 1. Team-level match statistics ─────────────────────────────────
-- Sofascore returns 4 groups (Match overview / Shots / Attack / Passes / Defence / Duels / Goalkeeping)
-- Most-useful subset flattened to columns; full payload kept in JSONB for forensics.
CREATE TABLE IF NOT EXISTS sofascore_match_statistics (
  game_id              INT NOT NULL,
  is_home              BOOLEAN NOT NULL,
  -- Period: ALL | 1ST | 2ND
  period               TEXT NOT NULL DEFAULT 'ALL',
  -- Possession + tempo
  ball_possession_pct  REAL,           -- 0..100
  expected_goals       REAL,           -- Sofascore's match-stat xG (may differ slightly from per-shot sum)
  big_chances          SMALLINT,
  big_chances_missed   SMALLINT,
  -- Shots
  total_shots          SMALLINT,
  shots_on_target      SMALLINT,
  shots_off_target     SMALLINT,
  blocked_shots        SMALLINT,
  shots_inside_box     SMALLINT,
  shots_outside_box    SMALLINT,
  hit_woodwork         SMALLINT,
  -- Attack
  corner_kicks         SMALLINT,
  free_kicks           SMALLINT,
  offsides             SMALLINT,
  goalkeeper_saves     SMALLINT,
  -- Passes
  passes_total         SMALLINT,
  passes_accurate      SMALLINT,
  pass_accuracy_pct    REAL,
  long_balls_total     SMALLINT,
  long_balls_accurate  SMALLINT,
  crosses_total        SMALLINT,
  crosses_accurate     SMALLINT,
  -- Duels
  duels_won            SMALLINT,
  duels_total          SMALLINT,
  ground_duels_won     SMALLINT,
  ground_duels_total   SMALLINT,
  aerial_duels_won     SMALLINT,
  aerial_duels_total   SMALLINT,
  dribbles_attempted   SMALLINT,
  dribbles_won         SMALLINT,
  -- Defence
  tackles_total        SMALLINT,
  tackles_won          SMALLINT,
  interceptions        SMALLINT,
  recoveries           SMALLINT,
  clearances           SMALLINT,
  errors_lead_to_shot  SMALLINT,
  errors_lead_to_goal  SMALLINT,
  -- Discipline
  fouls                SMALLINT,
  yellow_cards         SMALLINT,
  red_cards            SMALLINT,
  -- Goalkeeping
  goalkeeper_saves_inside_box  SMALLINT,
  goals_prevented      REAL,           -- xG-against minus goals-conceded
  -- Forensics (Sofascore raw payload, only stats not flattened)
  raw_extras           JSONB,
  -- Ingest meta
  inserted_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_match_statistics_pk PRIMARY KEY (game_id, is_home, period)
);

CREATE INDEX IF NOT EXISTS idx_sofascore_match_statistics_game
  ON sofascore_match_statistics (game_id);

COMMENT ON TABLE sofascore_match_statistics IS
  'Per-team match-level statistics (~40 stats × 3 periods). Forever cache after status=Ended. Source: /event/{id}/statistics';
COMMENT ON COLUMN sofascore_match_statistics.expected_goals IS
  'Sofascore match-stat xG. Aggregate of shot-level xG, but Sofascore sometimes reconciles differently (own goals etc).';
COMMENT ON COLUMN sofascore_match_statistics.goals_prevented IS
  'Goalkeeper performance: xG-against minus goals-conceded. Positive = above-expected save performance.';

-- ── 2. Per-player match statistics ─────────────────────────────────
-- One row per player per match (starters + subs that touched the ball).
-- Stats vary by position (GK gets saves, outfield gets passes/tackles), so all "extra" stats are nullable.
CREATE TABLE IF NOT EXISTS sofascore_player_match_stats (
  game_id              INT NOT NULL,
  player_id            INT NOT NULL,
  team_id              INT NOT NULL,
  is_home              BOOLEAN NOT NULL,
  is_starter           BOOLEAN NOT NULL DEFAULT FALSE,
  is_captain           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Identity
  player_name          TEXT,
  position             TEXT,             -- "G" | "D" | "M" | "F"
  jersey_number        SMALLINT,
  -- Time on pitch
  minutes_played       SMALLINT,
  substitution_in      SMALLINT,         -- minute came on (NULL if started)
  substitution_out     SMALLINT,         -- minute came off (NULL if played to end)
  -- Sofascore overall rating (0..10)
  rating               REAL,
  -- Goals + creation
  goals                SMALLINT,
  assists              SMALLINT,
  expected_assists     REAL,
  expected_goals       REAL,
  -- Shooting
  shots_total          SMALLINT,
  shots_on_target      SMALLINT,
  shots_off_target     SMALLINT,
  shots_blocked        SMALLINT,
  -- Passing
  passes_total         SMALLINT,
  passes_accurate      SMALLINT,
  pass_accuracy_pct    REAL,
  key_passes           SMALLINT,
  long_balls_accurate  SMALLINT,
  long_balls_total     SMALLINT,
  crosses_accurate     SMALLINT,
  crosses_total        SMALLINT,
  -- Carrying / dribbling
  touches              SMALLINT,
  touches_in_box       SMALLINT,
  dribbles_won         SMALLINT,
  dribbles_attempted   SMALLINT,
  was_dispossessed     SMALLINT,
  -- Defending
  tackles_won          SMALLINT,
  interceptions        SMALLINT,
  clearances           SMALLINT,
  duels_won            SMALLINT,
  duels_total          SMALLINT,
  aerial_duels_won     SMALLINT,
  aerial_duels_total   SMALLINT,
  blocks               SMALLINT,
  -- Discipline
  fouls_committed      SMALLINT,
  fouls_drawn          SMALLINT,
  yellow_card          BOOLEAN DEFAULT FALSE,
  red_card             BOOLEAN DEFAULT FALSE,
  -- Goalkeeping (only populated for GK)
  saves                SMALLINT,
  saves_inside_box     SMALLINT,
  goals_conceded       SMALLINT,
  punches              SMALLINT,
  high_claims          SMALLINT,
  -- Forensics
  raw_extras           JSONB,
  -- Ingest meta
  inserted_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_player_match_stats_pk PRIMARY KEY (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_sofascore_pms_game
  ON sofascore_player_match_stats (game_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_pms_player
  ON sofascore_player_match_stats (player_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_pms_team
  ON sofascore_player_match_stats (team_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_pms_starter
  ON sofascore_player_match_stats (game_id, is_home, is_starter)
  WHERE is_starter = TRUE;

COMMENT ON TABLE sofascore_player_match_stats IS
  'Per-player stats for each match. One row per player who touched the ball. Forever cache after status=Ended.';
COMMENT ON COLUMN sofascore_player_match_stats.rating IS
  'Sofascore overall rating, 0..10. Strong proxy for individual contribution; correlates with team xG±.';
COMMENT ON COLUMN sofascore_player_match_stats.expected_assists IS
  'Pre-shot xA (probability the assisting pass leads to a goal, given the resulting shot xG).';

-- ── 3. Match incidents (timeline) ──────────────────────────────────
-- Goal, card, sub, kickoff, halftime, fulltime, period start/end. Used for game-state xG and discipline.
CREATE TABLE IF NOT EXISTS sofascore_incidents (
  game_id              INT NOT NULL,
  incident_idx         SMALLINT NOT NULL,           -- 0-based position in timeline (stable PK)
  incident_type        TEXT NOT NULL,               -- "goal" | "card" | "substitution" | "period" | "varDecision" | "injuryTime"
  -- Time
  minute               SMALLINT,                    -- match minute (NULL for period markers)
  added_minute         SMALLINT,                    -- stoppage minute (e.g. 90+3 → minute=90, added=3)
  period               TEXT,                        -- "1H" | "2H" | "ET1" | "ET2" | "PEN"
  -- Affected entity
  is_home              BOOLEAN,                     -- NULL for period markers
  team_id              INT,
  player_id            INT,
  player_name          TEXT,
  related_player_id    INT,                         -- assist / sub-target / VAR-affected
  related_player_name  TEXT,
  -- Type-specific details
  goal_type            TEXT,                        -- "regular" | "penalty" | "ownGoal" | "freeKick" | "header"
  card_color           TEXT,                        -- "yellow" | "red" | "yellowred"
  card_reason          TEXT,                        -- "Foul" | "TimeWasting" | "Dissent" | …
  scoring_team_score   SMALLINT,                    -- after-event score for scoring side (goals only)
  conceding_team_score SMALLINT,                    -- after-event score for conceding side
  -- Forensics
  raw_extras           JSONB,
  -- Ingest meta
  inserted_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_incidents_pk PRIMARY KEY (game_id, incident_idx)
);

CREATE INDEX IF NOT EXISTS idx_sofascore_incidents_game
  ON sofascore_incidents (game_id);
CREATE INDEX IF NOT EXISTS idx_sofascore_incidents_type
  ON sofascore_incidents (incident_type);
CREATE INDEX IF NOT EXISTS idx_sofascore_incidents_player
  ON sofascore_incidents (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sofascore_incidents_cards
  ON sofascore_incidents (game_id, is_home, card_color)
  WHERE incident_type = 'card';

COMMENT ON TABLE sofascore_incidents IS
  'Match timeline: goals, cards, subs, period markers. Used for game-state xG features and discipline tracking.';

-- ── 4. Average positions (tactical map) ────────────────────────────
-- Pitch coordinates [0,100]² where each player spent the average of their time.
-- Useful for inferring formation drift, defensive line height, fullback width.
CREATE TABLE IF NOT EXISTS sofascore_average_positions (
  game_id              INT NOT NULL,
  player_id            INT NOT NULL,
  team_id              INT NOT NULL,
  is_home              BOOLEAN NOT NULL,
  -- Sofascore coords: x∈[0,100] = pitch length (own goal=0, opponent goal=100), y∈[0,100] = width
  avg_x                REAL NOT NULL,
  avg_y                REAL NOT NULL,
  -- Bonus stats sometimes returned
  points_count         SMALLINT,                    -- how many position samples were averaged
  -- Ingest meta
  inserted_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sofascore_average_positions_pk PRIMARY KEY (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_sofascore_avgpos_game
  ON sofascore_average_positions (game_id);

COMMENT ON TABLE sofascore_average_positions IS
  'Per-player avg pitch position. Source: /event/{id}/average-positions. Useful for formation inference + tactical features.';

-- ── 5. Sync state tracker ──────────────────────────────────────────
-- Per-game flag set after successful pull. Skipped on next sync to save calls.
-- Survives crashes — if a partial pull happens, retry next run.
CREATE TABLE IF NOT EXISTS sofascore_extras_state (
  game_id              INT PRIMARY KEY,
  league               TEXT NOT NULL,
  season               TEXT NOT NULL,
  has_statistics       BOOLEAN NOT NULL DEFAULT FALSE,
  has_player_stats     BOOLEAN NOT NULL DEFAULT FALSE,
  has_incidents        BOOLEAN NOT NULL DEFAULT FALSE,
  has_avg_positions    BOOLEAN NOT NULL DEFAULT FALSE,
  last_attempt_at      TIMESTAMPTZ DEFAULT NOW(),
  last_success_at      TIMESTAMPTZ,
  attempt_count        SMALLINT NOT NULL DEFAULT 0,
  last_error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sofascore_extras_state_pending
  ON sofascore_extras_state (league, season)
  WHERE NOT (has_statistics AND has_player_stats AND has_incidents AND has_avg_positions);

COMMENT ON TABLE sofascore_extras_state IS
  'Per-game sync state. Used by fetch_match_extras.py to skip games already fully pulled. Cooldown via attempt_count.';

-- ══════════════════════════════════════════════════════════════════════
-- Pipeline Shadow-Log — runtime snapshot of engine predictions
-- ══════════════════════════════════════════════════════════════════════
-- Populated by /api/shadow-log (client-side hook in MatchdayContext
-- posts a batch whenever all engines finish computing for a matchday).
-- Each (match_key, engine_variant, predicted_date) tuple is unique so
-- repeated calls from the same user or different users are idempotent
-- (ON CONFLICT DO NOTHING on the upsert).
--
-- Downstream eval: join pipeline_shadow_log ↔ odds_closing_history
-- (ft_result + psch/pscd/psca) via match_key once matches settle →
-- Brier / LogLoss / CLV per engine_variant without any backfill work.
--
-- RLS is ENABLED but no public policies exist — the /api/shadow-log
-- route uses SUPABASE_SERVICE_ROLE_KEY to bypass. Authenticated users
-- cannot read/write the table directly.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_shadow_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key TEXT NOT NULL,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff TIMESTAMPTZ,
  engine_variant TEXT NOT NULL,
  prob_h NUMERIC(6,5),
  prob_d NUMERIC(6,5),
  prob_a NUMERIC(6,5),
  prob_o25 NUMERIC(6,5),
  feature_version TEXT NOT NULL DEFAULT 'v1',
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  predicted_date DATE GENERATED ALWAYS AS (((predicted_at AT TIME ZONE 'UTC')::date)) STORED,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT pipeline_shadow_log_unique UNIQUE (match_key, engine_variant, predicted_date)
);

CREATE INDEX IF NOT EXISTS pipeline_shadow_log_match_key_idx
  ON pipeline_shadow_log(match_key);
CREATE INDEX IF NOT EXISTS pipeline_shadow_log_kickoff_idx
  ON pipeline_shadow_log(kickoff);
CREATE INDEX IF NOT EXISTS pipeline_shadow_log_league_date_idx
  ON pipeline_shadow_log(league, predicted_date);

ALTER TABLE pipeline_shadow_log ENABLE ROW LEVEL SECURITY;

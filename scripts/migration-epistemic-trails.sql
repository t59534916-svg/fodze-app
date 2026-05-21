-- ═══════════════════════════════════════════════════════════════════════
-- migration-epistemic-trails.sql
-- v1.1 Asymmetric Negation Protocol · M8 CLV-reflexivity tracking storage
--
-- Persists every trap firing from `evaluateLatentTopology()` so downstream
-- crons can:
--   (a) burn-in SHADOW_LOG_ONLY signals over 200 matches before graduation
--   (b) detect when sharp markets price in our edges (CLV-decay watcher),
--       triggering auto-deprecation of the trap.
--
-- One row per (trap_kind, match_key, detected_at). The UNIQUE constraint
-- makes the writer idempotent (ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS epistemic_trails (
  id                BIGSERIAL PRIMARY KEY,

  -- ── Trap firing context ───────────────────────────────────────────
  trap_kind         TEXT      NOT NULL,
  -- match_key:  Canonical FODZE format from src/lib/format.ts::matchKey()
  --             — same string `bets.match_key` and `odds_closing_history.match_key`
  --             use. Custom formats here silently break the CLV-decay join.
  match_key         TEXT      NOT NULL,
  -- match_kickoff: Unix epoch SECONDS (NOT milliseconds). The CLV-decay cron
  --                filters with `match_kickoff=lt.${Math.floor(Date.now()/1000)}`
  --                — writing ms pushes the timestamp ~1000× into the future and
  --                the row never qualifies as "past kickoff" → silent dead-zone.
  match_kickoff     BIGINT    NOT NULL,
  league            TEXT,
  -- detected_at:  Unix epoch MILLISECONDS. Sub-second granularity is intentional:
  --               re-emissions across page-reloads each get their own row so the
  --               audit-history of when traps fired is preserved.
  detected_at       BIGINT    NOT NULL,
  raw_signals       JSONB     NOT NULL,                      -- e.g. {"possessionDiff": 18.2, "xgEwma3": 0.62}
  predicted_hw_rate NUMERIC(6,4) NOT NULL,                  -- engine's baseline win-rate, ∈ [0, 1] (CHECKed below)
  shadow            BOOLEAN   NOT NULL,                      -- M2 SHADOW_LOG_ONLY flag

  -- ── M8 CLV-decay tracking (filled by clv-trap-decay.mjs cron) ────
  closing_odds      NUMERIC(8,4),                            -- Pinnacle close at kickoff, > 1.0 if set (CHECKed below)
  moved_against_us  BOOLEAN,                                  -- TRUE = market converged
  -- clv_resolved_at: Unix epoch MILLISECONDS (the cron uses Date.now()).
  --                  NULL = unresolved, picked up by next cron run via the
  --                  partial idx_epistemic_trails_unresolved index.
  clv_resolved_at   BIGINT,

  -- ── Bookkeeping ───────────────────────────────────────────────────
  created_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT epistemic_trails_unique UNIQUE (trap_kind, match_key, detected_at),

  -- Range guards: catch caller bugs that would silently corrupt the audit.
  --   predicted_hw_rate is a probability, must be in [0, 1].
  --   closing_odds is a decimal odds value, strictly > 1.0 (or NULL pre-resolve).
  CONSTRAINT epistemic_trails_predicted_hw_rate_range
    CHECK (predicted_hw_rate BETWEEN 0 AND 1),
  CONSTRAINT epistemic_trails_closing_odds_valid
    CHECK (closing_odds IS NULL OR closing_odds > 1.0)
);

CREATE INDEX IF NOT EXISTS idx_epistemic_trails_match_key
  ON epistemic_trails (match_key);

CREATE INDEX IF NOT EXISTS idx_epistemic_trails_kickoff
  ON epistemic_trails (match_kickoff);

-- Hot path for CLV-decay cron: scan unresolved rows
CREATE INDEX IF NOT EXISTS idx_epistemic_trails_unresolved
  ON epistemic_trails (match_kickoff)
  WHERE clv_resolved_at IS NULL;

-- Hot path for burn-in cron: aggregate by trap_kind
CREATE INDEX IF NOT EXISTS idx_epistemic_trails_trap_kind
  ON epistemic_trails (trap_kind, shadow);

-- ── Row-Level Security ──────────────────────────────────────────────
-- Anon users can READ trails (for the /health dashboard + transparency).
-- Writes restricted to service_role (only the FODZE app + crons can write).
ALTER TABLE epistemic_trails ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'epistemic_trails'
      AND policyname = 'epistemic_trails_anon_read'
  ) THEN
    EXECUTE 'CREATE POLICY epistemic_trails_anon_read
             ON epistemic_trails FOR SELECT TO anon USING (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'epistemic_trails'
      AND policyname = 'epistemic_trails_svc_all'
  ) THEN
    EXECUTE 'CREATE POLICY epistemic_trails_svc_all
             ON epistemic_trails FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;
END
$$;

COMMENT ON TABLE epistemic_trails IS
  'v1.1 Asymmetric Negation · per-trap firings · drives burn-in + CLV-decay';
COMMENT ON COLUMN epistemic_trails.shadow IS
  'TRUE = SHADOW_LOG_ONLY (did NOT alter stake), FALSE = active veto';
COMMENT ON COLUMN epistemic_trails.moved_against_us IS
  'CLV-decay signal: TRUE = sharp market converged on our edge → deprecate';
COMMENT ON COLUMN epistemic_trails.match_key IS
  'Canonical FODZE format produced by src/lib/format.ts::matchKey(league, home, away) — same string used by bets.match_key and odds_closing_history.match_key. Custom formats break the CLV-decay join silently.';
COMMENT ON COLUMN epistemic_trails.match_kickoff IS
  'Unix epoch SECONDS (not ms). CLV-decay cron filters via match_kickoff < now/1000 — writing ms here makes the cron skip the row forever.';
COMMENT ON COLUMN epistemic_trails.detected_at IS
  'Unix epoch MILLISECONDS. Part of UNIQUE (trap_kind, match_key, detected_at) — sub-second granularity intentional so re-emissions across page-reloads each get a row for audit history.';
COMMENT ON COLUMN epistemic_trails.clv_resolved_at IS
  'Unix epoch MILLISECONDS (when the CLV-decay cron processed this row). NULL = unresolved, picked up by next cron run via partial idx_epistemic_trails_unresolved.';

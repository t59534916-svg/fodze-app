-- ══════════════════════════════════════════════════════════════════════
-- FK covering indexes — matchdays.created_by + pipeline_shadow_log.created_by
-- ══════════════════════════════════════════════════════════════════════
-- Both columns are foreign keys to `auth.users(id)` with ON DELETE SET NULL
-- (matchdays) / ON DELETE SET NULL (pipeline_shadow_log). Without a covering
-- index, any DELETE on auth.users forces Postgres to sequentially scan the
-- referencing table to find dependent rows, and UPDATEs to the referenced
-- column trigger the same scan.
--
-- At the current table sizes (matchdays: 370 rows, pipeline_shadow_log:
-- growing daily from the client-side shadow-log hook) the scan is cheap,
-- but the indexes stay useful as the shadow-log accumulates — the advisor
-- is calling this out proactively before it becomes a problem.
--
-- Docs:
--   https://supabase.com/docs/guides/database/database-linter
--     ?lint=0001_unindexed_foreign_keys
-- ══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS matchdays_created_by_idx
  ON public.matchdays(created_by);

CREATE INDEX IF NOT EXISTS pipeline_shadow_log_created_by_idx
  ON public.pipeline_shadow_log(created_by);

-- ══════════════════════════════════════════════════════════════════════
-- RLS cleanup — drop redundant "Service write" ALL policies
-- ══════════════════════════════════════════════════════════════════════
-- Removes two FOR ALL policies that check `auth.role() = 'service_role'`
-- on tables that also carry a sibling "Public read" SELECT policy.
-- Supabase advisor flagged these as `multiple_permissive_policies` WARN
-- across 5 roles × 2 tables = 10 entries, because ALL includes SELECT
-- and both permissive policies OR-merge on SELECT.
--
-- Why it's safe:
--   - The `service_role` Postgres role has `bypassrls = true`, so any
--     policy that checks `auth.role() = 'service_role'` is a no-op for
--     real service-role traffic. The policy added nothing; the bypass
--     does the work.
--   - No app code inserts/updates player_profiles or team_xg_history as
--     anon or authenticated — all writes come from backfill scripts
--     using the service-role key (scripts/seed-*, scripts/backfill-*,
--     scripts/scrape-*). Those continue to work via bypassrls.
--   - "Public read" SELECT policy remains → read access unchanged.
--
-- Docs:
--   https://supabase.com/docs/guides/database/database-linter
--     ?lint=0006_multiple_permissive_policies
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Service write player_profiles" ON public.player_profiles;
DROP POLICY IF EXISTS "Service write team_xg_history" ON public.team_xg_history;

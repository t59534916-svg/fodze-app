-- ══════════════════════════════════════════════════════════════════════
-- RLS auth_rls_initplan fix — (SELECT auth.*()) subquery-wrap
-- ══════════════════════════════════════════════════════════════════════
-- Wraps auth.uid() / auth.role() in RLS policies with a subquery so the
-- planner caches the result as an InitPlan node once per query instead
-- of re-evaluating it per row. Flagged by the Supabase advisor
-- `auth_rls_initplan` lint (WARN, perf) across 21 policies on 15 tables.
--
-- Docs:
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--     #call-functions-with-select
--   https://supabase.com/docs/guides/database/database-linter
--     ?lint=0003_auth_rls_initplan
--
-- Behavior is bit-preserving: same predicates, same roles, same actions,
-- same `permissive` flag. The `TO public` clause matches pg_policies'
-- original roles array `{public}` (not explicitly restricted to
-- `authenticated` — the qual does the role check). Keep it that way
-- to avoid silent access-control drift.
-- ══════════════════════════════════════════════════════════════════════

-- ── Pattern A: SELECT policies, qual = auth.role() = 'authenticated' ──

DROP POLICY IF EXISTS "Authenticated read" ON public.corners_odds_history;
CREATE POLICY "Authenticated read" ON public.corners_odds_history FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.live_match_events;
CREATE POLICY "Authenticated read" ON public.live_match_events FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.live_odds;
CREATE POLICY "Authenticated read" ON public.live_odds FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.live_wp_snapshots;
CREATE POLICY "Authenticated read" ON public.live_wp_snapshots FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.odds_closing_history;
CREATE POLICY "Authenticated read" ON public.odds_closing_history FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.player_props_odds_history;
CREATE POLICY "Authenticated read" ON public.player_props_odds_history FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.player_props_posteriors;
CREATE POLICY "Authenticated read" ON public.player_props_posteriors FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.player_xg_history;
CREATE POLICY "Authenticated read" ON public.player_xg_history FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.referees;
CREATE POLICY "Authenticated read" ON public.referees FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read" ON public.stadiums;
CREATE POLICY "Authenticated read" ON public.stadiums FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

-- ── Pattern B: "Authenticated read all" (SELECT) ──

DROP POLICY IF EXISTS "Authenticated read all" ON public.matchdays;
CREATE POLICY "Authenticated read all" ON public.matchdays FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read all" ON public.odds_snapshots;
CREATE POLICY "Authenticated read all" ON public.odds_snapshots FOR SELECT TO public
  USING ((SELECT auth.role()) = 'authenticated');

-- ── Pattern C: INSERT policies, with_check = auth.role() = 'authenticated' ──

DROP POLICY IF EXISTS "Authenticated insert" ON public.matchdays;
CREATE POLICY "Authenticated insert" ON public.matchdays FOR INSERT TO public
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated insert" ON public.odds_snapshots;
CREATE POLICY "Authenticated insert" ON public.odds_snapshots FOR INSERT TO public
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

-- ── Pattern D: DELETE policy, qual = auth.uid() = created_by ──

DROP POLICY IF EXISTS "Authenticated delete own" ON public.odds_snapshots;
CREATE POLICY "Authenticated delete own" ON public.odds_snapshots FOR DELETE TO public
  USING ((SELECT auth.uid()) = created_by);

-- ── Pattern E: ALL policies, qual = auth.uid() = id/created_by ──
-- For FOR ALL without explicit WITH CHECK, Postgres defaults WITH CHECK
-- to the USING expression. Preserved here by omitting WITH CHECK, same
-- as the original policy definitions.

DROP POLICY IF EXISTS "Authenticated manage own" ON public.bets;
CREATE POLICY "Authenticated manage own" ON public.bets FOR ALL TO public
  USING ((SELECT auth.uid()) = created_by);

DROP POLICY IF EXISTS "Authenticated manage own" ON public.profiles;
CREATE POLICY "Authenticated manage own" ON public.profiles FOR ALL TO public
  USING ((SELECT auth.uid()) = id);

-- ── Pattern F: Service-role policies ──
-- Note: the `service_role` Postgres role has `bypassrls` → these
-- policies are effectively no-ops for actual service-role traffic.
-- Kept for schema symmetry with existing migrations; wrapping still
-- silences the advisor for the planner's anon/authenticated paths.

DROP POLICY IF EXISTS "Service insert live_odds" ON public.live_odds;
CREATE POLICY "Service insert live_odds" ON public.live_odds FOR INSERT TO public
  WITH CHECK ((SELECT auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Service update live_odds" ON public.live_odds;
CREATE POLICY "Service update live_odds" ON public.live_odds FOR UPDATE TO public
  USING ((SELECT auth.role()) = 'service_role')
  WITH CHECK ((SELECT auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Service write player_profiles" ON public.player_profiles;
CREATE POLICY "Service write player_profiles" ON public.player_profiles FOR ALL TO public
  USING ((SELECT auth.role()) = 'service_role')
  WITH CHECK ((SELECT auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Service write team_xg_history" ON public.team_xg_history;
CREATE POLICY "Service write team_xg_history" ON public.team_xg_history FOR ALL TO public
  USING ((SELECT auth.role()) = 'service_role')
  WITH CHECK ((SELECT auth.role()) = 'service_role');

-- ═══════════════════════════════════════════════════════════════════════
-- FODZE Migration — Tighten RLS on bets + profiles
--
-- SECURITY P0: The original schema had "Authenticated read all" policies
-- on bets and profiles, meaning ANY logged-in user could query every other
-- user's stakes, P&L, bankroll, and display_name. DSGVO + competitive-
-- intel leak on any public deploy.
--
-- Fix: Drop the broad read policies. The existing "Authenticated manage own"
-- (FOR ALL USING auth.uid() = created_by/id) policy already covers
-- SELECT for the owner's own rows — users can still read their own bets
-- and profile, just not anyone else's.
--
-- RUN THIS IN: Supabase Dashboard → SQL Editor
-- IDEMPOTENT: safe to re-run, uses IF EXISTS guards
-- ═══════════════════════════════════════════════════════════════════════

-- ─── bets ──────────────────────────────────────────────────────────
-- Before: any authenticated user reads all bets
-- After:  users read only their own (via the "manage own" policy)

DROP POLICY IF EXISTS "Authenticated read all" ON public.bets;

-- Sanity: confirm the "manage own" policy still exists. If not, the table
-- would become completely read-denied — uncomment this as a safety net:
-- CREATE POLICY "Users read own bets" ON public.bets
--   FOR SELECT USING (auth.uid() = created_by);

-- ─── profiles ──────────────────────────────────────────────────────
-- Before: any authenticated user reads all profiles (incl. bankroll)
-- After:  users read only their own profile

DROP POLICY IF EXISTS "Authenticated read all" ON public.profiles;

-- Sanity check (defensive):
-- CREATE POLICY "Users read own profile" ON public.profiles
--   FOR SELECT USING (auth.uid() = id);

-- ─── odds_snapshots ────────────────────────────────────────────────
-- Odds themselves aren't PII, but they are user-scoped (odds YOU entered).
-- Broad read is acceptable for cross-user "what did others see for this
-- match" features that don't currently exist. Leaving as-is but noting
-- that a future release might want user-scoping.
--
-- No change applied here — intentional.

-- ─── Verification query (run this after applying the migration) ────
-- SELECT tablename, policyname, cmd, qual
-- FROM pg_policies
-- WHERE tablename IN ('bets', 'profiles')
-- ORDER BY tablename, policyname;
--
-- Expected output: only "Authenticated manage own" policies remain.

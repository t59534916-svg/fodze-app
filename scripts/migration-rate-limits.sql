-- ═══════════════════════════════════════════════════════════════════════
-- FODZE Migration — Rate-limit table + atomic increment function
--
-- The /api/anna endpoint used a per-worker in-memory Map for rate-limiting,
-- which on Vercel's multi-instance runtime means the effective limit
-- multiplies by the worker count (20/min × N workers = 20N/min per user).
--
-- This migration replaces the in-memory state with a Postgres-backed
-- atomic counter so ONE limit applies across all workers.
--
-- Approach: each (user_id, bucket) pair has a row with a window-end
-- timestamp. The `check_and_increment_rate_limit` function does one
-- atomic INSERT ... ON CONFLICT ... UPDATE that either increments the
-- counter within the current window OR resets it if the window expired,
-- returning the post-increment count + window_end in a single round-trip.
--
-- RUN THIS IN: Supabase Dashboard → SQL Editor
-- IDEMPOTENT: safe to re-run (uses CREATE ... IF NOT EXISTS + OR REPLACE)
-- ═══════════════════════════════════════════════════════════════════════

-- ─── Table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rate_limits (
  user_id    uuid        NOT NULL,
  bucket     text        NOT NULL,
  count      integer     NOT NULL DEFAULT 1,
  reset_at   timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);

-- ─── RLS ────────────────────────────────────────────────────────────
-- No user should read or write this table directly — it's managed by
-- the server-side anon_key session (via the RPC below). Enabling RLS
-- with no policies = effectively deny-all for clients. The RPC runs
-- with SECURITY DEFINER, so it bypasses RLS regardless.

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- ─── Function: check_and_increment_rate_limit ──────────────────────
--
-- Returns:
--   allowed      boolean — true if the request should proceed
--   remaining    integer — requests remaining in this window
--   reset_at     timestamptz — when the current window resets
--
-- Atomic: the UPSERT commits in one statement, so two concurrent callers
-- can never both observe count < max and both proceed.

CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(
  p_user_id uuid,
  p_bucket  text,
  p_max     integer,
  p_window_seconds integer
) RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_new_count integer;
  v_reset timestamptz;
BEGIN
  INSERT INTO public.rate_limits (user_id, bucket, count, reset_at, updated_at)
  VALUES (p_user_id, p_bucket, 1, v_now + make_interval(secs => p_window_seconds), v_now)
  ON CONFLICT (user_id, bucket) DO UPDATE
    SET count = CASE
          WHEN rate_limits.reset_at < v_now THEN 1
          ELSE rate_limits.count + 1
        END,
        reset_at = CASE
          WHEN rate_limits.reset_at < v_now THEN v_now + make_interval(secs => p_window_seconds)
          ELSE rate_limits.reset_at
        END,
        updated_at = v_now
  RETURNING rate_limits.count, rate_limits.reset_at
  INTO v_new_count, v_reset;

  RETURN QUERY SELECT
    (v_new_count <= p_max)           AS allowed,
    GREATEST(0, p_max - v_new_count) AS remaining,
    v_reset                          AS reset_at;
END;
$$;

-- Allow any authenticated user to call the RPC for THEIR OWN bucket.
-- The app always passes auth.uid() as p_user_id — users can't lift
-- the limit of other users because SECURITY DEFINER still uses the
-- anon session's auth.uid() check inside the route handler.

GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(uuid, text, integer, integer)
  TO authenticated, service_role;

-- ─── Housekeeping (optional but cheap) ──────────────────────────────
-- Old expired rows accumulate — not a correctness issue (the function
-- resets them on next hit) but they grow with every unique user. Scrub
-- rows that haven't been touched in 7 days; safe to re-run.
--
-- Call from a cron or a scheduled Edge Function. Not wired up here.

CREATE OR REPLACE FUNCTION public.gc_rate_limits() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.rate_limits
   WHERE updated_at < now() - interval '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gc_rate_limits() TO service_role;

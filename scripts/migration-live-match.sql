-- FODZE: Live Match Events + WP Snapshots (Phase 3.3)
-- ═══════════════════════════════════════════════════════════════════════
-- Two tables support in-play Win-Probability calculation:
--
--   1. live_match_events — append-only event log per match. Populated by
--      services/betfair-stream (Betfair Exchange Streaming API, Delayed
--      App Key tier — free). Events include goals, red cards, substitutions,
--      kick-off + half-time markers. Each event bumps the current score
--      state and re-triggers WP computation.
--
--   2. live_wp_snapshots — per-minute-or-per-event WP readings. Stored as
--      a time-series so historical Live-WP-vs-actual analysis is possible
--      (Croxson & Reade 2014 style efficiency audit).
--
-- Compute path:
--   Betfair stream → `live_match_events` (append)
--     → Supabase Edge Function triggers on INSERT
--     → computes λ_remaining from pre-game engine output × time-remaining × score-state
--     → upserts `live_wp_snapshots` (one row per minute)
--   Browser/`/live` page reads via Realtime subscription.

CREATE TABLE IF NOT EXISTS live_match_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,        -- same format as live_odds.match_key
  minute INT NOT NULL,            -- 0-95 (95 = injury time cap)
  event_type TEXT NOT NULL,       -- "goal"|"red_card"|"penalty_awarded"|"sub"|"kickoff"|"halftime"|"fulltime"
  team TEXT,                      -- home/away/opposing team for assigned events
  player TEXT,                    -- scorer / booked player (best-effort)

  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_ts TIMESTAMPTZ DEFAULT NOW(),  -- ingest-side timestamp (delayed-key has ~5s lag)
  source TEXT DEFAULT 'betfair-stream'
);

CREATE INDEX IF NOT EXISTS idx_live_match_events_match ON live_match_events(match_key, minute);
CREATE INDEX IF NOT EXISTS idx_live_match_events_ts ON live_match_events(created_at);

CREATE TABLE IF NOT EXISTS live_wp_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  minute INT NOT NULL,
  score_home INT NOT NULL,
  score_away INT NOT NULL,
  red_cards_home INT DEFAULT 0,
  red_cards_away INT DEFAULT 0,

  -- Live WP (model output)
  wp_home NUMERIC,
  wp_draw NUMERIC,
  wp_away NUMERIC,
  lambda_h_remaining NUMERIC,
  lambda_a_remaining NUMERIC,

  -- Live market odds (for CLV / efficiency audit)
  market_home NUMERIC,
  market_draw NUMERIC,
  market_away NUMERIC,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (match_key, minute)
);

CREATE INDEX IF NOT EXISTS idx_live_wp_match ON live_wp_snapshots(match_key, minute);

-- RLS — authenticated read, service write.
ALTER TABLE live_match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_wp_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON live_match_events
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Service insert" ON live_match_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Authenticated read" ON live_wp_snapshots
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Service insert" ON live_wp_snapshots
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update" ON live_wp_snapshots
  FOR UPDATE USING (true);

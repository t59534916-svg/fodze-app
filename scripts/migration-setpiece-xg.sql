-- FODZE: Set-Piece vs Open-Play xG Columns (Phase 2.4)
-- ═══════════════════════════════════════════════════════════════════════
-- Populated by the same Understat-shot-timeline scrape that fills the
-- Game-State columns (scripts/backfill-xg-by-state.mjs) — one traversal
-- of the shot list aggregates by both score-state AND situation in one
-- pass. Consumed by the v2 engine retrain (tools/retrain_v2.py) as the
-- Arsenal-style Set-Piece-share features.
--
-- Analytics FC (Oct 2024): Pearson correlation between team open-play
-- xGDiff and set-piece-xG is ~-0.36 — i.e. they're genuinely independent
-- dimensions of team quality. Teams near 50% set-piece-xG-share (e.g.
-- Arsenal 2025) are specifically mispriced against weak set-piece
-- defences; the v2 feature `sp_share_diff_ewma` captures that edge.
--
-- Understat `situation` taxonomy (directly mapped here):
--   OpenPlay, SetPiece, FromCorner, DirectFreekick, Penalty
-- We collapse SetPiece + FromCorner + DirectFreekick + Penalty → "setpiece"
-- and OpenPlay → "openplay". The granular breakdown is a future extension.

ALTER TABLE team_xg_history
  ADD COLUMN IF NOT EXISTS xg_openplay NUMERIC,
  ADD COLUMN IF NOT EXISTS xg_setpiece NUMERIC,
  ADD COLUMN IF NOT EXISTS xga_openplay NUMERIC,
  ADD COLUMN IF NOT EXISTS xga_setpiece NUMERIC;

-- Partial index for coverage audits (xg_openplay is the fastest way to
-- tell "has set-piece breakdown" since every scraped match sets both).
CREATE INDEX IF NOT EXISTS idx_xg_history_has_situation
  ON team_xg_history(league, match_date)
  WHERE xg_openplay IS NOT NULL;

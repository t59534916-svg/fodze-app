// ═══════════════════════════════════════════════════════════════════════
// FODZE — Per-League CLV Feedback Loop (Auto-Kelly Dampening)
// ═══════════════════════════════════════════════════════════════════════
//
// PROBLEM
//   Wenn das Modell systematisch in einer bestimmten Liga vom Closing-
//   Line-Wert (CLV) fällt — z.B. die Quoten driften pre-game gegen uns
//   — ist das Modell in dieser Liga "blind" (Model Drift). Die Brier-
//   metrik hinkt aber 30+ Tage hinterher, weil Settlement langsam ist.
//   CLV ist der Frühindikator: negative CLV-Mittelwerte = wir bewerten
//   die Wahrscheinlichkeit konsistent zu hoch.
//
// LÖSUNG
//   Per-Liga CLV-Z-Score auf den letzten N settled bets. Wenn Z-Score
//   signifikant negativ (< -1.0), halbieren wir Kelly-Stakes für diese
//   Liga, bis sich das Modell durch neue settled bets re-kalibriert.
//
// CRITICAL DESIGN: VOLUMEN- statt zeit-basiert
//   Eine zeit-basierte Schwelle (z.B. "last-30-days, count >= 30")
//   triggert in Nebenligen NIE: Eredivisie hat 9 Matches/Woche, davon
//   1-3 Value-Picks → max 12-15 Bets in 30 Tagen → unter der Schwelle.
//   Genau dort wo soft markets am häufigsten fehlerhafte Linien haben,
//   würde der Schutz nie greifen.
//
//   Fix: window = "last 40 settled bets per league" (CLV_FEEDBACK_WINDOW).
//   Unabhängig davon, ob diese 40 Bets aus 3 Wochen oder 3 Monaten
//   stammen. Statistisch valides N für den Mittelwert-Z-Score.
// ═══════════════════════════════════════════════════════════════════════

import type { PlacedBet } from "@/types/match";

/** Volume-based window for per-league CLV feedback. */
export const CLV_FEEDBACK_WINDOW = 40;

/** Z-score threshold below which Kelly is halved for that league. */
export const CLV_FEEDBACK_Z_THRESHOLD = -1.0;

/** Multiplier applied when drift is detected. */
export const CLV_FEEDBACK_MULTIPLIER = 0.5;

/**
 * Extracts the league key from a match_key. matchKey format is
 * `${league}:${homeTeam}-${awayTeam}` (see src/lib/format.ts::matchKey).
 * Returns null if the format doesn't match.
 */
export function extractLeagueFromMatchKey(matchKey: string | undefined): string | null {
  if (!matchKey) return null;
  const colonIdx = matchKey.indexOf(":");
  if (colonIdx <= 0) return null;
  return matchKey.slice(0, colonIdx);
}

/**
 * Per-league Kelly multiplier for drift protection.
 *
 * Algorithm:
 *   1) Filter to settled bets in this league with finite CLV
 *   2) Take the most recent CLV_FEEDBACK_WINDOW (=40) bets
 *   3) If fewer than CLV_FEEDBACK_WINDOW bets → return 1.0 (insufficient sample)
 *   4) Compute mean Z-score: avgClv / (sdClv / sqrt(N))
 *   5) If Z-score < CLV_FEEDBACK_Z_THRESHOLD (=-1.0) → return CLV_FEEDBACK_MULTIPLIER (=0.5)
 *   6) Otherwise return 1.0
 *
 * Returns 1.0 (no dampening) for unknown leagues, empty bet lists, or
 * any defensive failure mode. NEVER returns 0 (would block all bets).
 */
export function computeLeagueKellyMultiplier(
  leagueKey: string | undefined,
  allBets: readonly PlacedBet[],
): number {
  if (!leagueKey || !allBets || allBets.length === 0) return 1.0;

  // Filter: same league (via match_key prefix) + settled + finite CLV
  const matching: { clv: number; settledAt: string }[] = [];
  for (const b of allBets) {
    if (b.result === "pending") continue;
    if (b.clv == null || !Number.isFinite(b.clv)) continue;
    const lg = extractLeagueFromMatchKey(b.match_key);
    if (lg !== leagueKey) continue;
    matching.push({
      clv: b.clv,
      settledAt: b.settled_at || b.placed_at || "",
    });
  }

  if (matching.length < CLV_FEEDBACK_WINDOW) return 1.0;

  // Sort by settled_at descending (most recent first), take window
  matching.sort((a, b) => (b.settledAt > a.settledAt ? 1 : b.settledAt < a.settledAt ? -1 : 0));
  const window = matching.slice(0, CLV_FEEDBACK_WINDOW);
  const n = window.length;

  // Mean and sample std dev
  const mean = window.reduce((s, x) => s + x.clv, 0) / n;
  const variance = window.reduce((s, x) => s + (x.clv - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  // Defensive: degenerate variance → no signal, no dampening
  if (!Number.isFinite(sd) || sd <= 0) return 1.0;

  // z-score of the mean: how many SE units below 0?
  const zScore = mean / (sd / Math.sqrt(n));

  if (!Number.isFinite(zScore)) return 1.0;
  if (zScore < CLV_FEEDBACK_Z_THRESHOLD) return CLV_FEEDBACK_MULTIPLIER;
  return 1.0;
}

/** Diagnostic structure for the per-league CLV table on /performance. */
export interface LeagueCLVStats {
  league: string;
  count: number;
  meanClv: number | null;
  sdClv: number | null;
  zScore: number | null;
  kellyMultiplier: number;
}

/**
 * Per-league CLV breakdown for UI display. Returns one row per league
 * present in the bets list. Leagues with < CLV_FEEDBACK_WINDOW bets
 * still appear (with kellyMultiplier=1.0) so the user sees them building
 * up toward the trigger threshold.
 */
export function computeLeagueCLVBreakdown(
  allBets: readonly PlacedBet[],
): LeagueCLVStats[] {
  const byLeague = new Map<string, number[]>();
  for (const b of allBets) {
    if (b.result === "pending") continue;
    if (b.clv == null || !Number.isFinite(b.clv)) continue;
    const lg = extractLeagueFromMatchKey(b.match_key);
    if (!lg) continue;
    const arr = byLeague.get(lg);
    if (arr) arr.push(b.clv);
    else byLeague.set(lg, [b.clv]);
  }

  const rows: LeagueCLVStats[] = [];
  for (const [league, clvs] of byLeague.entries()) {
    const n = clvs.length;
    if (n === 0) continue;
    const mean = clvs.reduce((s, x) => s + x, 0) / n;
    const variance = n > 1
      ? clvs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
      : 0;
    const sd = Math.sqrt(variance);
    const zScore = (n >= 2 && sd > 0) ? mean / (sd / Math.sqrt(n)) : null;
    const km = computeLeagueKellyMultiplier(league, allBets);
    rows.push({
      league,
      count: n,
      meanClv: mean,
      sdClv: n > 1 ? sd : null,
      zScore,
      kellyMultiplier: km,
    });
  }

  // Sort: leagues with active dampening first, then by count desc
  return rows.sort((a, b) => {
    if (a.kellyMultiplier !== b.kellyMultiplier) return a.kellyMultiplier - b.kellyMultiplier;
    return b.count - a.count;
  });
}

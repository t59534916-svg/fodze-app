// ─────────────────────────────────────────────────────────────────────
// Deserved-Outcome — turn the engine's λ (expected goals per side) into an
// honest "who deserves to win / how close" picture for the match view.
//
// WHY THIS EXISTS (validated 2026-06-01, docs/FORECAST-QUALITY-ANALYSIS.md §12/§13):
// dev-03's λ_home/λ_away IS an expected-goals forecast — the "deserved" lens. An
// xG-target A/B (§12) confirmed an xG-shaped view is a measurably better "who
// SHOULD have won" signal (xG-RMSE 0.69→0.67, robust) than goals, at no cost to
// win-probabilities. We do NOT swap the production target (§12 verdict); instead
// we SURFACE the already-computed λ as a deserved-outcome view.
//
// CRITICAL HONESTY (§13): this is a PRESENTATION of an existing signal, NOT a more
// accurate one. λ is the same information the win-% bar already shows, expressed as
// expected goals. It answers "how did the model see the matchup" — a forecast of the
// *expected* picture, NOT a prediction of the actual score (which carries irreducible
// Poisson noise, §11). The copy must never imply more certainty than the win-% bar.
//
// Pure functions only — single source of truth for the boundaries + labels so the
// component can't drift. Unit-tested in tests/deserved-outcome.test.ts.
// ─────────────────────────────────────────────────────────────────────

export type DeservedSide = "home" | "away" | "even";

export interface DeservedPicture {
  /** Expected goals per side (the engine λ), rounded for display. */
  homeXg: number;
  awayXg: number;
  /** Which side the expected-goals margin favours. */
  side: DeservedSide;
  /** |λH − λA| — the expected-goals margin (absolute). */
  margin: number;
  /** Total expected goals λH + λA (the "how open / goal-heavy" axis). */
  total: number;
  /** How decisive the expected picture is, from the margin. */
  clarity: "klar" | "leicht" | "offen";
  /** One-line plain-German descriptor of the deserved picture. */
  label: string;
}

// Margin thresholds (in expected goals). A ~0.7-goal expected edge ≈ a clear
// favourite; below ~0.25 the matchup is essentially even. Chosen to align with
// the win-% bar's own "klarer/leichter Favorit" copy in MatchDetail (mk.H>0.55 /
// >0.42), so the two readings never visibly contradict.
const MARGIN_CLEAR = 0.7;
const MARGIN_SLIGHT = 0.25;

/**
 * Derive the deserved-outcome picture from the engine's expected goals (λ).
 *
 * `lambdaHome` / `lambdaAway` are the calc object's `lambdaH` / `lambdaA` — the
 * Dixon-Coles expected goals each side, already computed by every engine. NaN or
 * non-finite inputs degrade to an "even / offen" picture (never throws).
 */
export function deservedPicture(lambdaHome: number, lambdaAway: number): DeservedPicture {
  const lh = Number.isFinite(lambdaHome) ? Math.max(0, lambdaHome) : 0;
  const la = Number.isFinite(lambdaAway) ? Math.max(0, lambdaAway) : 0;
  const margin = Math.abs(lh - la);
  const total = lh + la;

  const side: DeservedSide = margin < MARGIN_SLIGHT ? "even" : lh > la ? "home" : "away";
  const clarity: DeservedPicture["clarity"] =
    margin >= MARGIN_CLEAR ? "klar" : margin >= MARGIN_SLIGHT ? "leicht" : "offen";

  let label: string;
  if (side === "even") {
    label = "Erwartet ausgeglichen";
  } else {
    const who = side === "home" ? "Heim" : "Auswärts";
    label = clarity === "klar" ? `${who} verdient klar vorn` : `${who} leicht vorn`;
  }

  return {
    homeXg: round1(lh),
    awayXg: round1(la),
    side,
    margin: round1(margin),
    total: round1(total),
    clarity,
    label,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

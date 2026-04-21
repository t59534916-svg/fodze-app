"use client";

/*
═══════════════════════════════════════════════════════════════════════
  MatchPulse — three signals on one ~180×24 strip:

    1. Favorit-Pfeil (links)       arrow toward the predicted winner;
                                   length ∝ edge over 2nd-best outcome,
                                   color gold (home) / warn (away) /
                                   gold-muted (draw / toss-up).

    2. Spannung-Dots (mitte)       5 circles, filled proportional to
                                   normalised Shannon entropy over the
                                   1X2 distribution. All five glowing
                                   = 0,34 / 0,33 / 0,33 (total drama);
                                   one dot = 0,90 / 0,05 / 0,05 (clear).

    3. Mismatch-Pulse (ring)       halo around the favorit-pfeil,
                                   intensity ∝ max |model − market|
                                   across H/D/A. Only fires when the
                                   max delta ≥ 2,5 pp (Goldilocks
                                   lower bound) — otherwise no glow,
                                   no animation. This is the visual
                                   hook for "der Markt weiß etwas
                                   anderes als das Modell".

  All three encode independent axes:
    · Favorit  = who should win       (argmax direction)
    · Spannung = how contested        (entropy)
    · Mismatch = where the Edge lives (|model − market|)

  Three at a glance without crowding — reads in <500 ms once the user
  learns the visual language.

  Brand-voice (docs/BRAND-VOICE.md):
    ✓ Quantitativ-erste: every axis is a measurable number. Title-attr
      shows the three values as German sentences on hover.
    ✓ Präzise: no data → flat strip (no pulse, no arrow, all dots grey).
    ✓ Leather+Gold: colors through tokens.ts. warn for
      underdog-favored rendering.
═══════════════════════════════════════════════════════════════════════
*/

import { useEffect, useState } from "react";
import { color } from "@/styles/tokens";
import type { MatchCalc } from "@/types/match";

// Goldilocks lower bound — below this the mismatch is statistical
// noise and the pulse stays dark. Matches the app's value-detection
// floor in src/lib/dixon-coles.ts.
const MISMATCH_FLOOR = 0.025;
// Where a mismatch saturates the glow animation. A 10 pp
// model-vs-market delta on a single outcome is already a "der Markt
// weiß was" red flag — no extra visual weight beyond this.
const MISMATCH_CEIL = 0.10;

const DOT_COUNT = 5;

export interface MatchPulseProps {
  calc: MatchCalc | null;
  width?: number;    // default 180
  height?: number;   // default 24
}

// Normalised Shannon entropy on 3 outcomes — maps [most-certain … uniform]
// to [0 … 1]. log(3) is the max achievable entropy on a 3-outcome
// distribution; dividing gives a clean axis readable as a percentage.
function entropy3(pH: number, pD: number, pA: number): number {
  const eps = 1e-9;
  const log3 = Math.log(3);
  const h = -(
    pH * Math.log(pH + eps) +
    pD * Math.log(pD + eps) +
    pA * Math.log(pA + eps)
  );
  return Math.max(0, Math.min(1, h / log3));
}

// Max delta between model and market across the three 1X2 outcomes.
// Returns 0 when market data isn't available on any leg — the pulse
// then stays dark.
function maxMismatch(calc: MatchCalc): number {
  if (!calc.bets || calc.bets.length === 0) return 0;
  let m = 0;
  // BetCalc label set mirrors src/lib/dixon-coles.ts:978 — {"Heim","Unent.","Gast"}.
  for (const label of ["Heim", "Unent.", "Gast"]) {
    const b = calc.bets.find((x) => x.label === label);
    if (!b || typeof b.pMarket !== "number" || typeof b.pModel !== "number") continue;
    const d = Math.abs(b.pModel - b.pMarket);
    if (d > m) m = d;
  }
  return m;
}

export default function MatchPulse({ calc, width = 180, height = 24 }: MatchPulseProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!calc) {
    // Empty rail — match the height exactly so the card layout is stable
    // whether or not calc has landed yet.
    return <div style={{ width, height }} aria-hidden />;
  }

  const pH = calc.mk.H, pD = calc.mk.D, pA = calc.mk.A;
  const ent = entropy3(pH, pD, pA);
  const mm = maxMismatch(calc);
  const mmGlow = mm >= MISMATCH_FLOOR
    ? Math.min(1, (mm - MISMATCH_FLOOR) / (MISMATCH_CEIL - MISMATCH_FLOOR))
    : 0;

  // Determine favorite + arrow direction + color
  const maxP = Math.max(pH, pD, pA);
  const sortedProbs = [pH, pD, pA].sort((a, b) => b - a);
  const edgeOver2nd = sortedProbs[0] - sortedProbs[1];  // always ≥ 0
  // Arrow length ∝ edge-over-2nd, capped at 50 pp (absolute dominance).
  const arrowLen = Math.min(1, edgeOver2nd / 0.50);

  let favSide: "home" | "away" | "draw" = "draw";
  let arrowColor: string = color.goldMuted;
  if (maxP === pH) {
    favSide = "home";
    arrowColor = color.gold;
  } else if (maxP === pA) {
    favSide = "away";
    arrowColor = color.warn;
  }

  // Layout: arrow on the left occupies 28 px, dots fill the rest.
  const arrowZone = 28;
  const arrowCx = 14;
  const arrowCy = height / 2;
  // Arrow tip reaches up to (arrowZone - 4) at full length.
  const arrowTipX = favSide === "home"
    ? arrowCx + Math.max(1, arrowLen * 10)
    : favSide === "away"
      ? arrowCx - Math.max(1, arrowLen * 10)
      : arrowCx;

  const dotZoneStart = arrowZone + 4;
  const dotZoneWidth = width - dotZoneStart;
  const dotSpacing = dotZoneWidth / (DOT_COUNT + 1);
  // Filled-dot count reflects entropy smoothly (can be fractional;
  // we draw each dot with opacity = saturation at that dot's position).
  const entDots = ent * DOT_COUNT;

  const title = [
    `Favorit: ${favSide === "home" ? "Heim" : favSide === "away" ? "Gast" : "offen (Toss-up)"} (${(maxP * 100).toFixed(1)} %)`,
    `Spannung: ${(ent * 100).toFixed(1)} % (0 = klar, 100 = Münzwurf)`,
    `Mismatch: ${(mm * 100).toFixed(1)} pp max |Modell − Markt|${mmGlow > 0 ? " — Goldilocks-Kandidat" : ""}`,
  ].join("\n");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Match-Puls: Favorit, Spannung, Mismatch"
      style={{ display: "block", opacity: mounted ? 1 : 0, transition: "opacity 220ms ease-out" }}
    >
      <title>{title}</title>

      {/* Mismatch-Glow — soft disk behind the arrow. Opacity scales
          with mm magnitude. Pulsing animation when glow > 0, so the
          user's eye gets drawn to the cards where the engine actually
          disagrees with the market. */}
      {mmGlow > 0 && (
        <circle
          cx={arrowCx}
          cy={arrowCy}
          r={12}
          fill={arrowColor}
          opacity={0.12 + 0.18 * mmGlow}
          style={{
            transformOrigin: `${arrowCx}px ${arrowCy}px`,
            animation: "fodze-pulse 2.4s ease-in-out infinite",
          }}
        />
      )}

      {/* Favorit-Pfeil — a single line from center outward with a
          triangular head. Zero-length for true toss-ups renders a dot. */}
      {arrowLen > 0.02 ? (
        <g>
          <line
            x1={arrowCx}
            y1={arrowCy}
            x2={arrowTipX}
            y2={arrowCy}
            stroke={arrowColor}
            strokeWidth={2}
            strokeLinecap="round"
            style={{ transition: "x2 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
          {/* arrow head (triangle) */}
          <polygon
            points={
              favSide === "home"
                ? `${arrowTipX},${arrowCy} ${arrowTipX - 4},${arrowCy - 4} ${arrowTipX - 4},${arrowCy + 4}`
                : `${arrowTipX},${arrowCy} ${arrowTipX + 4},${arrowCy - 4} ${arrowTipX + 4},${arrowCy + 4}`
            }
            fill={arrowColor}
          />
        </g>
      ) : (
        <circle cx={arrowCx} cy={arrowCy} r={3} fill={arrowColor} opacity={0.7} />
      )}

      {/* Spannung-Dots — 5 circles, each with its own saturation so the
          boundary between "filled" and "empty" dots reads as a smooth
          gradient at fractional entropy values. */}
      {Array.from({ length: DOT_COUNT }, (_, i) => {
        const cx = dotZoneStart + dotSpacing * (i + 1);
        // Each dot lights up as entDots crosses its slot (0..DOT_COUNT).
        const fill = Math.max(0, Math.min(1, entDots - i));
        return (
          <circle
            key={`dot-${i}`}
            cx={cx}
            cy={height / 2}
            r={2.6}
            fill={color.gold}
            opacity={0.2 + 0.8 * fill}
            style={{ transition: "opacity 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        );
      })}

      <style>{`
        @keyframes fodze-pulse {
          0%, 100% { transform: scale(1); opacity: ${(0.12 + 0.18 * mmGlow).toFixed(2)}; }
          50% { transform: scale(1.3); opacity: ${(0.22 + 0.25 * mmGlow).toFixed(2)}; }
        }
      `}</style>
    </svg>
  );
}

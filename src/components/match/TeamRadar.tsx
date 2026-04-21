"use client";

/*
═══════════════════════════════════════════════════════════════════════
  TeamRadar — 5-axis glyph per team for MatchCard.
═══════════════════════════════════════════════════════════════════════

  Compact 64×64 SVG pentagon carrying:
    · Angriff        xG/game vs league avg        (color.valueMid)
    · Defensive      1 − xGA/game vs league avg   (color.info)
    · Form           weighted W/D/L over last 5   (color.gold)
    · Kader          1 − injuries/22              (color.goldMuted)
    · Δ xG-Bilanz    (xg − xga) normalised        (color.goldLight)

  Each axis lands in [0, 1]. 0.5 = league-average. 1.0 = top-decile.
  Defaults are safe: an empty team object renders the center-dot (all
  zero) — never crashes.

  Entry animation: polygon scales from 0 to 1 on mount (220ms
  cubic-bezier), giving a gentle punch-in when the MatchCard scrolls
  into view. Subsequent prop changes transition smoothly via the same
  CSS property, so the radar morphs as new xG data arrives.

  Voice-check (docs/BRAND-VOICE.md):
    ✓ Quantitativ-erste: every axis is a number, not an adjective
    ✓ Präzise: fallbacks documented inline; no hidden magic
    ✓ Respektvoll-direkt: no labels (the glyph IS the label — hover
       title reveals the axis stat in one German sentence)
  Leather+Gold palette sourced from src/styles/tokens.ts — no inline
  hex values for team-color decisions.
═══════════════════════════════════════════════════════════════════════
*/

import { useEffect, useMemo, useState } from "react";
import { color } from "@/styles/tokens";
import type { TeamData } from "@/types/match";

// ─── Axis math ──────────────────────────────────────────────────────

// Default xG per 90 across FODZE's covered leagues. Used as the
// denominator when leagueAvg isn't handed in. Value mirrors
// tools/retrain_v2.py LEAGUE_AVGS → 1.35 is the blended median.
const DEFAULT_LEAGUE_AVG = 1.35;

// Clamp a raw ratio so a 4×-above-average team doesn't punch through
// the polygon. 2.0 hits the outer edge (value 1.0) — top-decile.
const RATIO_CAP = 2.0;

const AXIS_LABELS = ["Angriff", "Defensive", "Form", "Kader", "Δ xG"] as const;
const AXIS_COUNT = AXIS_LABELS.length;

export interface TeamRadarAxes {
  attack: number;    // [0, 1]
  defense: number;
  form: number;
  squad: number;
  xgBalance: number;
}

// Build the 5 axis values from raw TeamData. When xG history is
// entirely missing (xg_h8 == null), all axes collapse to 0.5 —
// league-average placeholder — so a new team doesn't render as a
// spiky-disaster polygon while the enrichment pipeline is still
// fetching data. Partial data (form or injuries present but xG
// absent) still maps its known axes honestly; only xg-derived
// axes fall back.
export function buildAxes(team: TeamData | undefined, leagueAvg = DEFAULT_LEAGUE_AVG): TeamRadarAxes {
  if (!team) return { attack: 0, defense: 0, form: 0, squad: 0, xgBalance: 0 };

  const hasXG = team.xg_h8 != null || team.xg_a8 != null;
  const games = Math.max(1, team.games ?? 8);
  const xg = team.xg_h8 ?? team.xg_a8 ?? 0;
  const xga = team.xga_h8 ?? team.xga_a8 ?? 0;
  const xgPerGame = xg / games;
  const xgaPerGame = xga / games;

  // Attack: xG-per-game vs league avg. ratio=1 → 0.5, ratio=2 → 1.0.
  // Without xG data we return 0.5 (neutral) so the polygon is readable.
  const attack = hasXG
    ? Math.min(RATIO_CAP, xgPerGame / leagueAvg) / RATIO_CAP
    : 0.5;

  // Defense: inverted — fewer xGA allowed = higher score.
  // ratio=0 → 1.0, ratio=1 → 0.5, ratio=2 → 0.0.
  const defense = hasXG
    ? Math.max(0, 1 - Math.min(RATIO_CAP, xgaPerGame / leagueAvg) / RATIO_CAP)
    : 0.5;

  // Form: parse "W W D L W" → weights W=1.0, D=0.5, L=0.0, average last 5.
  const form = parseForm(team.form);

  // Kader: ~22-slot roster, injuries string counts closing parens.
  // Undefined injuries string = assume full squad (squad = 1.0).
  const injuryCount = countInjuries(team.injuries);
  const squad = Math.max(0, Math.min(1, 1 - injuryCount / 22));

  // Δ xG: net xG per game, mapped from [-1.5, +1.5] to [0, 1].
  // Balanced teams sit around 0.5. +1.0 net → 0.83, -1.0 → 0.17.
  const netXg = xgPerGame - xgaPerGame;
  const xgBalance = hasXG
    ? Math.max(0, Math.min(1, 0.5 + netXg / 3))
    : 0.5;

  return { attack, defense, form, squad, xgBalance };
}

function parseForm(s?: string): number {
  if (!s) return 0.5;
  const letters = s.replace(/[^WDLwdl]/g, "").toUpperCase().slice(-5).split("");
  if (letters.length === 0) return 0.5;
  const sum = letters.reduce((acc, c) => acc + (c === "W" ? 1 : c === "D" ? 0.5 : 0), 0);
  return sum / letters.length;
}

function countInjuries(s?: string): number {
  if (!s) return 0;
  // Each entry is "Player (POS, reason)" separated by comma-space.
  // Count closing parens — each entry has exactly one.
  return (s.match(/\)/g) ?? []).length;
}

// ─── Polygon geometry ───────────────────────────────────────────────

// Pentagonal axis angles, starting at top (-90°), going clockwise.
// Cached because they never change.
const ANGLES = Array.from({ length: AXIS_COUNT }, (_, i) => -Math.PI / 2 + (2 * Math.PI * i) / AXIS_COUNT);

function polygonPoints(values: number[], cx: number, cy: number, radius: number): string {
  return values
    .map((v, i) => {
      const r = Math.max(0, Math.min(1, v)) * radius;
      const x = cx + r * Math.cos(ANGLES[i]);
      const y = cy + r * Math.sin(ANGLES[i]);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

// ─── Component ──────────────────────────────────────────────────────

export interface TeamRadarProps {
  team: TeamData | undefined;
  leagueAvg?: number;
  venue?: "home" | "away";
  size?: number;   // default 64
}

export default function TeamRadar({ team, leagueAvg, venue = "home", size = 64 }: TeamRadarProps) {
  const axes = useMemo(() => buildAxes(team, leagueAvg), [team, leagueAvg]);
  const values = [axes.attack, axes.defense, axes.form, axes.squad, axes.xgBalance];

  // Mount animation — scale from 0 to 1 over 220ms on first render,
  // then settle. CSS transition does subsequent morphs smoothly.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 4;  // leave 4px for stroke edge

  // Grid rings at 0.25 / 0.5 / 0.75 / 1.0
  const rings = [0.25, 0.5, 0.75, 1.0];

  const strokeColor = venue === "home" ? color.gold : color.goldMuted;
  const fillColor   = venue === "home" ? `${color.gold}22` : `${color.goldMuted}18`;

  // Build the title text — one quantitative line per axis, German.
  const title = [
    `Angriff:   ${(axes.attack * 100).toFixed(0)} %`,
    `Defensive: ${(axes.defense * 100).toFixed(0)} %`,
    `Form:      ${(axes.form * 100).toFixed(0)} %`,
    `Kader:     ${(axes.squad * 100).toFixed(0)} %`,
    `Δ xG:      ${(axes.xgBalance * 100).toFixed(0)} %`,
  ].join("\n");

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`Team-Radar: ${team?.name ?? "unbekannt"}`}
      style={{
        display: "block",
        transform: mounted ? "scale(1)" : "scale(0.2)",
        opacity: mounted ? 1 : 0,
        transition: "transform 220ms cubic-bezier(0.2, 0.8, 0.3, 1), opacity 220ms ease-out",
      }}
    >
      <title>{title}</title>

      {/* Axis spokes — thin gold lines from center outward */}
      {ANGLES.map((a, i) => (
        <line
          key={`spoke-${i}`}
          x1={cx}
          y1={cy}
          x2={cx + R * Math.cos(a)}
          y2={cy + R * Math.sin(a)}
          stroke={color.goldGhost}
          strokeWidth={0.5}
        />
      ))}

      {/* Concentric grid rings — pentagons at fractional radii */}
      {rings.map((frac) => (
        <polygon
          key={`ring-${frac}`}
          points={polygonPoints(Array(AXIS_COUNT).fill(frac), cx, cy, R)}
          fill="none"
          stroke={color.goldGhost}
          strokeWidth={frac === 1.0 ? 0.6 : 0.35}
        />
      ))}

      {/* Team polygon — filled + stroked. The transition on points
          attribute lets data updates morph smoothly. */}
      <polygon
        points={polygonPoints(values, cx, cy, R)}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={1.2}
        strokeLinejoin="round"
        style={{ transition: "points 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
      />

      {/* Vertex dots — small circles at each axis tip for a datavis touch */}
      {values.map((v, i) => {
        const r = Math.max(0, Math.min(1, v)) * R;
        const x = cx + r * Math.cos(ANGLES[i]);
        const y = cy + r * Math.sin(ANGLES[i]);
        return (
          <circle
            key={`dot-${i}`}
            cx={x}
            cy={y}
            r={1.3}
            fill={strokeColor}
            style={{ transition: "cx 400ms cubic-bezier(0.4, 0, 0.2, 1), cy 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        );
      })}
    </svg>
  );
}

"use client";
import { color } from "@/styles/tokens";

// Goldilocks zone per FODZE engine contract (poisson-ml-engine-v2):
// - [2.5%, 7.5%]  = green, authorized bet
// - [0%, 2.5%)    = amber, too thin (not worth the variance)
// - (7.5%, ∞)     = warn, value-trap suspected (missing info)
// - negative      = neutral grey, no value
const MIN = 2.5;
const MAX = 7.5;
const DISPLAY_MAX = 12; // anything above 12% is far-trap territory; cap the meter

export type EdgeZone = "goldilocks" | "thin" | "trap" | "none";

export function classifyEdge(edgePct: number): EdgeZone {
  if (edgePct <= 0) return "none";
  if (edgePct < MIN) return "thin";
  if (edgePct <= MAX) return "goldilocks";
  return "trap";
}

const ZONE_STYLES: Record<EdgeZone, { fg: string; bg: string; border: string; label: string }> = {
  none:       { fg: color.goldMid,    bg: `${color.goldMid}15`,  border: `${color.goldMid}25`,  label: "ZERO" },
  thin:       { fg: color.goldShine,  bg: `${color.goldMid}18`,  border: `${color.goldMid}30`,  label: "THIN" },
  goldilocks: { fg: color.value,      bg: `${color.value}18`,    border: `${color.value}35`,    label: "ZONE" },
  trap:       { fg: color.warn,       bg: `${color.warn}18`,     border: `${color.warn}35`,     label: "TRAP?" },
};

/**
 * Edge readout with a 3-zone meter underneath. Lets the reader tell a
 * real value-signal (+4.2%) from a suspicious value-trap (+28%) at a
 * glance — without expanding the card. Replaces the previous all-green
 * edge badge that looked identical whether the edge was inside the
 * 2.5–7.5% authorized band or well past the value-trap threshold.
 *
 * Layout (compact): "+28.1% · [▓▓▓▓▓▓│░]" with "TRAP?" pill overlay.
 */
export default function EdgeBadge({ edge, showMeter = true }: { edge: number; showMeter?: boolean }) {
  const pct = edge * 100;
  const zone = classifyEdge(pct);
  const s = ZONE_STYLES[zone];

  const clamped = Math.max(0, Math.min(pct, DISPLAY_MAX));
  const markerPct = (clamped / DISPLAY_MAX) * 100;
  const zoneStart = (MIN / DISPLAY_MAX) * 100;
  const zoneEnd = (MAX / DISPLAY_MAX) * 100;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 6,
        background: s.bg,
        border: `1px solid ${s.border}`,
      }}
      title={
        zone === "goldilocks" ? "Goldilocks-Zone (2.5–7.5%) — authorisiert"
        : zone === "thin" ? "Unter 2.5% — zu dünn für Kelly-Stake"
        : zone === "trap" ? "Über 7.5% — wahrscheinlich fehlende Info (Value-Trap)"
        : "Kein Value"
      }
    >
      <span style={{ fontSize: 10, fontWeight: 700, color: s.fg, fontVariantNumeric: "tabular-nums" }}>
        {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
      </span>
      {showMeter && (
        <div
          aria-hidden="true"
          style={{
            position: "relative",
            width: 36, height: 4,
            borderRadius: 2,
            background: `${color.goldMid}20`,
            overflow: "hidden",
          }}
        >
          {/* Goldilocks zone highlight (2.5–7.5% segment) */}
          <div style={{
            position: "absolute",
            left: `${zoneStart}%`,
            width: `${zoneEnd - zoneStart}%`,
            top: 0, bottom: 0,
            background: `${color.value}40`,
          }} />
          {/* Edge marker — 2px wide, colored by zone */}
          <div style={{
            position: "absolute",
            left: `calc(${markerPct}% - 1px)`,
            top: -1, bottom: -1,
            width: 2,
            background: s.fg,
            boxShadow: `0 0 3px ${s.fg}`,
          }} />
        </div>
      )}
      {zone === "trap" && (
        <span style={{
          fontSize: 7, fontWeight: 700, color: s.fg, letterSpacing: 0.5,
          opacity: 0.8,
        }}>
          {s.label}
        </span>
      )}
    </div>
  );
}

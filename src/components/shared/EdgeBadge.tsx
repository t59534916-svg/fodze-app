"use client";
import { color } from "@/styles/tokens";
import { getLeagueLiquidityTier, DEFAULT_TIER } from "@/lib/league-liquidity";

// Goldilocks zone is now PER-LEAGUE (Phase 4, 2026-04-25):
// - Tier-1 (sharp: EPL/La Liga/Serie A/Buli/Ligue 1/UEFA): 1.5-5% goldilocks, trap >10%
// - Tier-2 (moderate, default for unknown): 2.5-7.5% goldilocks, trap >12%
// - Tier-3 (soft: Liga 3/L1/L2/Greek/Eerste): 3.5-8.5% goldilocks, trap >15%
//
// EdgeBadge previously used hardcoded MIN=2.5/MAX=7.5/trap>7.5% globally,
// which mislabeled e.g. EPL +8.7% as "TRAP?" even though the engine's
// per-Liga classification correctly placed it in the soft-skip zone
// (8% < trapHard=10%). Symptom: EPL/Buli matches showed 80%+ TRAP rate
// in UI even though Kelly stakes were correctly calibrated.
const DISPLAY_MAX = 12; // anything above 12% is far-trap territory; cap the meter

export type EdgeZone = "goldilocks" | "thin" | "soft" | "trap" | "none";

export function classifyEdge(edgePct: number, leagueKey?: string): EdgeZone {
  if (edgePct <= 0) return "none";
  const tier = leagueKey ? getLeagueLiquidityTier(leagueKey) : DEFAULT_TIER;
  const minPct = tier.goldilocksMin * 100;
  const maxPct = tier.goldilocksMax * 100;
  const trapHardPct = tier.trapHard * 100;
  if (edgePct < minPct) return "thin";
  if (edgePct <= maxPct) return "goldilocks";
  // Above goldilocksMax but ≤ trapHard = soft skip (no Kelly, no LOUD
  // alarm — UI mirrors engine's silent skip in poisson-ml-engine-v2.ts).
  if (edgePct <= trapHardPct) return "soft";
  // Above trapHard = hard trap (matches engine bet.valueTrap=true).
  return "trap";
}

const ZONE_STYLES: Record<EdgeZone, { fg: string; bg: string; border: string; label: string }> = {
  none:       { fg: color.goldMid,    bg: `${color.goldMid}15`,  border: `${color.goldMid}25`,  label: "ZERO" },
  thin:       { fg: color.goldShine,  bg: `${color.goldMid}18`,  border: `${color.goldMid}30`,  label: "THIN" },
  goldilocks: { fg: color.value,      bg: `${color.value}18`,    border: `${color.value}35`,    label: "ZONE" },
  // Soft skip: outside Goldilocks but below hard-trap threshold. Subtle
  // gold-tone styling — visible enough to flag, not loud enough to alarm.
  soft:       { fg: color.goldShine,  bg: `${color.goldMid}20`,  border: `${color.goldMid}40`,  label: "SOFT" },
  trap:       { fg: color.warn,       bg: `${color.warn}18`,     border: `${color.warn}35`,     label: "TRAP?" },
};

/**
 * Edge readout with a 3-zone meter underneath. Lets the reader tell a
 * real value-signal (+4.2%) from a suspicious value-trap (+28%) at a
 * glance — without expanding the card. Replaces the previous all-green
 * edge badge that looked identical whether the edge was inside the
 * 2.5–7.5% authorized band or well past the value-trap threshold.
 *
 * @param edge - Model edge as a FRACTION (0.042 = 4.2%, NOT 4.2). The
 *   caller's `bestBet.edge` is already in this form. Passing a percentage
 *   here silently misclassifies every bet as "thin" or "none" because
 *   classifyEdge() uses percentage thresholds internally.
 *
 * Layout (compact): "+28.1% · [▓▓▓▓▓▓│░]" with "TRAP?" pill overlay.
 */
export default function EdgeBadge({ edge, showMeter = true, league }: { edge: number; showMeter?: boolean; league?: string }) {
  const pct = edge * 100;
  const zone = classifyEdge(pct, league);
  const s = ZONE_STYLES[zone];
  const tier = league ? getLeagueLiquidityTier(league) : DEFAULT_TIER;
  const minPct = tier.goldilocksMin * 100;
  const maxPct = tier.goldilocksMax * 100;

  const clamped = Math.max(0, Math.min(pct, DISPLAY_MAX));
  const markerPct = (clamped / DISPLAY_MAX) * 100;
  const zoneStart = (minPct / DISPLAY_MAX) * 100;
  const zoneEnd = (maxPct / DISPLAY_MAX) * 100;

  // Sign-in-number pattern avoids "+−0.5%" when edge is negative. We
  // still want the leading character to be part of the number for
  // tabular alignment, so the entire string is built once.
  const signed = `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;

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
        zone === "goldilocks" ? `Goldilocks-Zone (${minPct.toFixed(1)}–${maxPct.toFixed(1)}%) — authorisiert`
        : zone === "thin" ? `Unter ${minPct.toFixed(1)}% — zu dünn für Kelly-Stake`
        : zone === "soft" ? `Über ${maxPct.toFixed(1)}% — außerhalb Goldilocks (kein Bet, keine Trap)`
        : zone === "trap" ? `Über ${(tier.trapHard * 100).toFixed(1)}% — wahrscheinlich fehlende Info (Value-Trap)`
        : "Kein Value"
      }
    >
      <span style={{ fontSize: 10, fontWeight: 700, color: s.fg, fontVariantNumeric: "tabular-nums" }}>
        {signed}
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
      {(zone === "trap" || zone === "soft") && (
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

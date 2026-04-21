"use client";
import { color } from "@/styles/tokens";
import type { ConversionSignal, SoSSignal } from "@/lib/xg-quality";

// ─── Visual Contract ─────────────────────────────────────────────────
//
// Two 6×6 dots inline with the team name. No color = no signal.
// Colored only when deviation is meaningful (|conv-1| > 15%, SoS > ±7%),
// so a casual scan sees trouble on teams that need a second look and
// skips past teams with clean signal profiles.
//
//   ● (conversion)  ● (schedule)
//   ─────────────   ─────────────
//   green           = over-performing    strong schedule
//   red             = under-performing   (unused; "weak" shown as warn)
//   warn-red        = under-conv warn    weak schedule (xG inflated)
//   transparent     = normal / unknown   normal / unknown
//
// Tooltip surfaces the note string — full explanation on hover.

const DOT_SIZE = 6;
const GAP = 3;

function convColor(label: ConversionSignal["label"]): string | null {
  if (label === "under") return color.warn;        // wasting chances — flag
  if (label === "over") return color.value;         // overperforming / clinical
  return null; // normal / unknown = no dot
}

function sosColor(label: SoSSignal["label"]): string | null {
  if (label === "weak") return color.warn;          // xG inflated by weak D
  if (label === "strong") return color.value;       // xG earned vs strong D
  return null; // normal / unknown = no dot
}

function Dot({ fill, title, ariaLabel }: { fill: string | null; title: string; ariaLabel: string }) {
  return (
    <span
      aria-label={ariaLabel}
      title={title}
      style={{
        display: "inline-block",
        width: DOT_SIZE,
        height: DOT_SIZE,
        borderRadius: "50%",
        background: fill || "transparent",
        border: fill ? `1px solid ${fill}` : `1px solid ${color.goldMid}25`,
        flexShrink: 0,
      }}
    />
  );
}

export default function XGQualityDots({
  conversion,
  sos,
}: {
  conversion: ConversionSignal;
  sos: SoSSignal;
}) {
  const cFill = convColor(conversion.label);
  const sFill = sosColor(sos.label);

  // Skip entirely if both signals are neutral — keeps clean teams visually clean
  if (!cFill && !sFill) return null;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: GAP, marginLeft: 4 }}
      role="group"
      aria-label="xG-Qualität"
    >
      <Dot fill={cFill} title={conversion.note} ariaLabel={`Chancenverwertung: ${conversion.label}`} />
      <Dot fill={sFill} title={sos.note} ariaLabel={`Spielplan-Stärke: ${sos.label}`} />
    </span>
  );
}

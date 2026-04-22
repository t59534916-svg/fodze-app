"use client";
import { color } from "@/styles/tokens";
import type { ConversionSignal, SoSSignal } from "@/lib/xg-quality";

// ─── Visual Contract ─────────────────────────────────────────────────
//
// Replaced the earlier dot-pair (required hover to decode) with short
// self-explaining chips. Reader sees "–xG" / "+xG" / "weich-Ø" / "hart-Ø"
// and gets the signal direction from the label itself, color from the
// deviation severity, detail from the tooltip.
//
//   chip       color   meaning
//   ────────   ─────   ──────────────────────────────────────
//   −xG        warn    Chancenverwertung unter xG (vergibt)
//   +xG        value   Chancenverwertung über xG (klinisch)
//   weich-Ø    warn    Gegner schwächer als Liga-Ø (xG inflated)
//   hart-Ø     value   Gegner stärker als Liga-Ø (xG impressiv)
//
// Only rendered for actionable deviations — clean teams stay chip-less
// so the eye learns to skip past them and pounces on whatever is flagged.

function Chip({ label, fg, title }: { label: string; fg: string; title: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        padding: "2px 5px",
        borderRadius: 3,
        background: `${fg}18`,
        color: fg,
        border: `1px solid ${fg}30`,
        letterSpacing: "0.02em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export default function XGQualityChips({
  conversion,
  sos,
}: {
  conversion: ConversionSignal;
  sos: SoSSignal;
}) {
  const chips: React.ReactNode[] = [];

  if (conversion.label === "under") {
    chips.push(
      <Chip key="c-" label="−xG" fg={color.warn} title={conversion.note} />
    );
  } else if (conversion.label === "over") {
    chips.push(
      <Chip key="c+" label="+xG" fg={color.value} title={conversion.note} />
    );
  }

  if (sos.label === "weak") {
    chips.push(
      <Chip key="s-" label="weich-Ø" fg={color.warn} title={sos.note} />
    );
  } else if (sos.label === "strong") {
    chips.push(
      <Chip key="s+" label="hart-Ø" fg={color.value} title={sos.note} />
    );
  }

  if (chips.length === 0) return null;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 4, flexWrap: "wrap" }}
      role="group"
      aria-label="xG-Qualität"
    >
      {chips}
    </span>
  );
}

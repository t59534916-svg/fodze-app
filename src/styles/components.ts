// ═══════════════════════════════════════════════════════════════════════
// FODZE Component Styles — Shared Factories
// Replaces 6 independently declared const S objects across pages
// ═══════════════════════════════════════════════════════════════════════

import { color, fontSize, fontWeight, fontFamily, space, radius, shadow, transition } from "./tokens";
import type { CSSProperties } from "react";

// ─── Page Layout ─────────────────────────────────────────────────────

export const page: CSSProperties = {
  maxWidth: 480,
  margin: "0 auto",
  padding: `${space[5]}px`,
  paddingBottom: 72, // room for bottom nav
  minHeight: "100dvh",
  background: `radial-gradient(ellipse at 50% 0%, ${color.leather3} 0%, ${color.leather} 70%)`,
  fontFamily: fontFamily.sans,
  color: color.text,
  fontSize: fontSize.base,
  lineHeight: 1.5,
};

export const pageTablet: CSSProperties = {
  maxWidth: 720,
  paddingLeft: 236, // room for sidebar nav
  paddingBottom: space[5],
};

// ─── Cards ───────────────────────────────────────────────────────────

type CardVariant = "default" | "elevated" | "ghost" | "value" | "warn";

export function card(variant: CardVariant = "default"): CSSProperties {
  const base: CSSProperties = {
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: radius.md,
    padding: space[5],
    transition: `all ${transition.normal}`,
  };

  switch (variant) {
    case "elevated":
      return { ...base, boxShadow: shadow.card, background: color.leather2 };
    case "ghost":
      return { ...base, background: "transparent", border: `1px dashed ${color.border}` };
    case "value":
      return { ...base, background: color.valueBg, borderColor: `${color.value}30` };
    case "warn":
      return { ...base, background: color.warnBg, borderColor: `${color.warn}30` };
    default:
      return base;
  }
}

// ─── Buttons ─────────────────────────────────────────────────────────

type ButtonVariant = "gold" | "outline" | "ghost";

export function button(variant: ButtonVariant = "gold"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space[3],
    padding: `${space[3]}px ${space[5]}px`,
    borderRadius: radius.sm,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    fontFamily: fontFamily.sans,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    cursor: "pointer",
    transition: `all ${transition.fast}`,
    border: "none",
    textDecoration: "none",
    minHeight: 44, // WCAG 2.5.5 touch target minimum
  };

  switch (variant) {
    case "gold":
      return {
        ...base,
        background: `linear-gradient(135deg, ${color.goldDark}, ${color.gold})`,
        color: color.leather,
        boxShadow: shadow.subtle,
      };
    case "outline":
      return {
        ...base,
        background: "transparent",
        color: color.gold,
        border: `1px solid ${color.goldMuted}`,
      };
    case "ghost":
      return {
        ...base,
        background: "transparent",
        color: color.textMuted,
        padding: `${space[3]}px ${space[4]}px`, // 8px 12px → min 44px touch target
        minHeight: 44, // WCAG 2.5.5 touch target
      };
  }
}

// ─── Inputs ──────────────────────────────────────────────────────────

export function input(filled = false): CSSProperties {
  return {
    width: "100%",
    height: 48,
    padding: `${space[3]}px ${space[4]}px`,
    background: filled ? color.goldGhost : "transparent",
    border: `1px ${filled ? "solid" : "dashed"} ${filled ? color.goldMuted : color.border}`,
    borderRadius: radius.sm,
    color: color.goldShine,
    fontSize: fontSize.base,
    fontFamily: fontFamily.mono,
    textAlign: "center" as const,
    outline: "none",
    transition: `all ${transition.fast}`,
  };
}

export const inputFocusStyle: CSSProperties = {
  borderColor: color.gold,
  borderStyle: "solid",
  boxShadow: `0 0 0 2px ${color.borderFocus}`,
};

// ─── Badges ──────────────────────────────────────────────────────────

type BadgeColor = "value" | "warn" | "neutral" | "info" | "gold";

export function badge(color_: BadgeColor = "neutral"): CSSProperties {
  const colors = {
    value:   { bg: color.valueBg, text: color.value, border: `${color.value}40` },
    warn:    { bg: color.warnBg, text: color.warn, border: `${color.warn}40` },
    info:    { bg: color.infoBg, text: color.info, border: `${color.info}40` },
    gold:    { bg: color.goldGhost, text: color.gold, border: color.goldMuted },
    neutral: { bg: color.surface, text: color.textMuted, border: color.border },
  };
  const c = colors[color_];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    padding: `${space[1]}px ${space[3]}px`,
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: radius.full,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: c.text,
    letterSpacing: "0.03em",
    whiteSpace: "nowrap" as const,
  };
}

// ─── Metrics (large numbers) ─────────────────────────────────────────

export function metric(size: "sm" | "md" | "lg" = "md"): CSSProperties {
  const sizes = { sm: fontSize.lg, md: fontSize.xl, lg: fontSize.xxl };
  return {
    fontSize: sizes[size],
    fontWeight: fontWeight.bold,
    fontFamily: fontFamily.mono,
    color: color.goldShine,
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
  };
}

// ─── Section Headers ─────────────────────────────────────────────────

export const sectionHeader: CSSProperties = {
  fontSize: fontSize.xs,
  fontWeight: fontWeight.semibold,
  color: color.goldMuted,
  textTransform: "uppercase" as const,
  letterSpacing: "0.1em",
  marginBottom: space[3],
  paddingBottom: space[2],
  borderBottom: `1px solid ${color.border}`,
};

// ─── Dividers ────────────────────────────────────────────────────────

export const divider: CSSProperties = {
  height: 1,
  background: color.border,
  margin: `${space[4]}px 0`,
  border: "none",
};

// ─── Probability Bar ─────────────────────────────────────────────────

export const probBar = {
  container: {
    display: "flex",
    height: 6,
    borderRadius: radius.full,
    overflow: "hidden" as const,
    gap: 1,
  } as CSSProperties,
  segment: (width: number, bgColor: string): CSSProperties => ({
    width: `${width}%`,
    background: bgColor,
    borderRadius: radius.full,
    transition: `width ${transition.normal}`,
    minWidth: width > 0 ? 4 : 0,
  }),
};

// ─── Grid Helpers ────────────────────────────────────────────────────

export function grid(cols: number, gap = space[3]): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gap,
  };
}

export function flex(
  justify: CSSProperties["justifyContent"] = "flex-start",
  align: CSSProperties["alignItems"] = "center",
  gap = space[3]
): CSSProperties {
  return {
    display: "flex",
    justifyContent: justify,
    alignItems: align,
    gap,
  };
}

// ─── Text Helpers ────────────────────────────────────────────────────

export const text = {
  heading: {
    fontFamily: fontFamily.serif,
    fontWeight: fontWeight.bold,
    color: color.goldShine,
    letterSpacing: "0.06em",
  } as CSSProperties,
  body: {
    fontSize: fontSize.base,
    color: color.text,
    lineHeight: 1.5,
  } as CSSProperties,
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: color.textMuted,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  } as CSSProperties,
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    color: color.goldLight,
  } as CSSProperties,
  muted: {
    fontSize: fontSize.sm,
    color: color.textMuted,
  } as CSSProperties,
  value: {
    fontWeight: fontWeight.bold,
    color: color.value,
  } as CSSProperties,
  warn: {
    fontWeight: fontWeight.bold,
    color: color.warn,
  } as CSSProperties,
};

// ─── Skeleton Loading ────────────────────────────────────────────────

export const skeleton: CSSProperties = {
  background: `linear-gradient(90deg, ${color.surface} 25%, ${color.goldGhost} 50%, ${color.surface} 75%)`,
  backgroundSize: "200% 100%",
  animation: "skeletonPulse 1.5s ease-in-out infinite",
  borderRadius: radius.sm,
};

// ═══════════════════════════════════════════════════════════════════════
// FODZE Formatters — Locale-aware display helpers
//
// Single source of truth for currency and date formatting. Previously
// inlined across performance/page.tsx, BetTracker, bet-share-card,
// BetHistoryShare, LiveCalibration — all with slightly different
// conventions. This module fixes that.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Format a euro amount. Round to 0 decimals for |n| ≥ 100, else 2.
 * With `sign: true`, emits a leading "+" or "−" (U+2212 minus, not hyphen).
 */
export function fmtEuro(n: number, sign = false): string {
  if (!Number.isFinite(n)) return "€—";
  const abs = Math.abs(n);
  const body = abs.toFixed(abs >= 100 ? 0 : 2);
  if (sign) return `${n >= 0 ? "+" : "−"}€${body}`;
  return `€${body}`;
}

/**
 * Parse any ISO-ish date string defensively. Returns null for empty or
 * invalid input. `new Date("garbage").toISOString()` throws, so every
 * consumer previously had its own try/catch.
 */
export function safeDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "12.04" — short day + month, German locale.
 *  Node/browser Intl sometimes emits a trailing "." ("12.04." in newer ICU);
 *  strip it so the output is stable across environments. */
export function fmtDateShort(iso?: string | null): string {
  const d = safeDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }).replace(/\.$/, "");
}

/** "12.04.2026" — full German short date. */
export function fmtDateLong(iso?: string | null): string {
  const d = safeDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "2026-04-12" — ISO date slug for filenames. Falls back to today. */
export function fmtDateSlug(iso?: string | null): string {
  const d = safeDate(iso) || new Date();
  return d.toISOString().slice(0, 10);
}

/** "Sa, 12.04 15:30" — weekday + date + time, for list rows. */
export function fmtDateTime(iso?: string | null): string {
  const d = safeDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

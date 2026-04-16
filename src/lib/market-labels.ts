// ═══════════════════════════════════════════════════════════════════════
// FODZE Market Labels — Canonical type + display maps
//
// The codebase historically mixed multiple key conventions for the same
// markets:
//   1X2:   "1"/"X"/"2"       (goldilocks, types) | "h"/"d"/"a"  (odds rows)
//   O/U:   "Ü2.5"/"U2.5"     (goldilocks)        | "o25"/"u25"  (legacy)
//   BTTS:  "btts"/"no_btts"
//
// This file centralizes:
//   - MarketKey — the canonical string union
//   - canonicalMarket(raw) — normalizes any legacy key to canonical
//   - MARKET_LABELS_SHORT — terse UI labels ("Heim", "Ü 2.5")
//   - MARKET_LABELS_LONG  — long share-card labels ("HEIMSIEG", "ÜBER 2.5 TORE")
// ═══════════════════════════════════════════════════════════════════════

/** Canonical market identifiers used across the app. */
export type MarketKey =
  | "1" | "X" | "2"
  | "o25" | "u25"
  | "btts" | "no_btts";

/**
 * Normalize any raw market string to a canonical MarketKey, or return it
 * unchanged if it's already canonical. Returns `null` for unknown input.
 */
export function canonicalMarket(raw: string | null | undefined): MarketKey | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  switch (s) {
    case "1": case "h": case "home":
      return "1";
    case "x": case "d": case "draw":
      return "X";
    case "2": case "a": case "away":
      return "2";
    case "o25": case "ü2.5": case "o2.5": case "over2.5":
      return "o25";
    case "u25": case "u2.5": case "under2.5":
      return "u25";
    case "btts": case "gg":
      return "btts";
    case "no_btts": case "ng":
      return "no_btts";
    default:
      return null;
  }
}

/** Short UI labels (compact, for list rows and chips). */
export const MARKET_LABELS_SHORT: Record<MarketKey, string> = {
  "1": "Heim",
  "X": "Remis",
  "2": "Gast",
  "o25": "Ü 2.5",
  "u25": "U 2.5",
  "btts": "BTTS",
  "no_btts": "Kein BTTS",
};

/** Long labels (uppercase, for share cards and prominent display). */
export const MARKET_LABELS_LONG: Record<MarketKey, string> = {
  "1": "HEIMSIEG",
  "X": "UNENTSCHIEDEN",
  "2": "AUSWÄRTSSIEG",
  "o25": "ÜBER 2.5 TORE",
  "u25": "UNTER 2.5 TORE",
  "btts": "BEIDE TREFFEN",
  "no_btts": "KEIN BTTS",
};

/**
 * Look up a market label, accepting raw (possibly legacy) keys.
 * Falls back to the uppercased raw string if normalization fails.
 */
export function marketLabel(
  raw: string | null | undefined,
  variant: "short" | "long" = "short",
): string {
  const key = canonicalMarket(raw);
  if (key) {
    return variant === "long" ? MARKET_LABELS_LONG[key] : MARKET_LABELS_SHORT[key];
  }
  return (raw || "").toString().toUpperCase() || "—";
}

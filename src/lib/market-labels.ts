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
  | "btts" | "no_btts"
  | "corners_o85" | "corners_u85"
  | "corners_o95" | "corners_u95"
  | "corners_o105" | "corners_u105"
  | "anytime_scorer" | "first_scorer"
  | "shots_o15" | "shots_o25" | "shots_o35"
  | "player_yellow";

/**
 * Normalize any raw market string to a canonical MarketKey, or return it
 * unchanged if it's already canonical. Returns `null` for unknown input.
 */
export function canonicalMarket(raw: string | null | undefined): MarketKey | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  switch (s) {
    case "1": case "h": case "home": case "heim":
      return "1";
    case "x": case "d": case "draw": case "unent.": case "unent": case "remis":
      return "X";
    case "2": case "a": case "away": case "ausw.": case "ausw": case "gast":
      return "2";
    case "o25": case "ü2.5": case "o2.5": case "over2.5":
      return "o25";
    case "u25": case "u2.5": case "under2.5":
      return "u25";
    case "btts": case "gg":
      return "btts";
    case "no_btts": case "ng":
      return "no_btts";
    case "corners_o85": case "corners o8.5": case "corners over 8.5":
      return "corners_o85";
    case "corners_u85": case "corners u8.5": case "corners under 8.5":
      return "corners_u85";
    case "corners_o95": case "corners o9.5": case "corners over 9.5":
      return "corners_o95";
    case "corners_u95": case "corners u9.5": case "corners under 9.5":
      return "corners_u95";
    case "corners_o105": case "corners o10.5": case "corners over 10.5":
      return "corners_o105";
    case "corners_u105": case "corners u10.5": case "corners under 10.5":
      return "corners_u105";
    case "anytime_scorer": case "anytime goalscorer": case "anytime_goalscorer": case "ags":
      return "anytime_scorer";
    case "first_scorer": case "first goalscorer": case "first_goalscorer":
      return "first_scorer";
    case "shots_o15": case "shots over 1.5":
      return "shots_o15";
    case "shots_o25": case "shots over 2.5":
      return "shots_o25";
    case "shots_o35": case "shots over 3.5":
      return "shots_o35";
    case "player_yellow": case "player yellow card": case "anytime_yellow":
      return "player_yellow";
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
  "corners_o85": "Ecken Ü 8.5",
  "corners_u85": "Ecken U 8.5",
  "corners_o95": "Ecken Ü 9.5",
  "corners_u95": "Ecken U 9.5",
  "corners_o105": "Ecken Ü 10.5",
  "corners_u105": "Ecken U 10.5",
  "anytime_scorer": "Torschütze",
  "first_scorer": "1. Torschütze",
  "shots_o15": "Schüsse Ü 1.5",
  "shots_o25": "Schüsse Ü 2.5",
  "shots_o35": "Schüsse Ü 3.5",
  "player_yellow": "Gelbe Karte",
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
  "corners_o85": "ÜBER 8.5 ECKEN",
  "corners_u85": "UNTER 8.5 ECKEN",
  "corners_o95": "ÜBER 9.5 ECKEN",
  "corners_u95": "UNTER 9.5 ECKEN",
  "corners_o105": "ÜBER 10.5 ECKEN",
  "corners_u105": "UNTER 10.5 ECKEN",
  "anytime_scorer": "TORSCHÜTZE",
  "first_scorer": "ERSTER TORSCHÜTZE",
  "shots_o15": "ÜBER 1.5 SCHÜSSE",
  "shots_o25": "ÜBER 2.5 SCHÜSSE",
  "shots_o35": "ÜBER 3.5 SCHÜSSE",
  "player_yellow": "GELBE KARTE (SPIELER)",
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

import { describe, it, expect } from "vitest";
import {
  canonicalMarket,
  marketLabel,
  MARKET_LABELS_SHORT,
  MARKET_LABELS_LONG,
} from "@/lib/market-labels";

// ─── canonicalMarket ─────────────────────────────────────────────

describe("canonicalMarket", () => {
  it("normalizes 1X2 canonical keys", () => {
    expect(canonicalMarket("1")).toBe("1");
    expect(canonicalMarket("X")).toBe("X");
    expect(canonicalMarket("2")).toBe("2");
  });

  it("handles lowercase variants", () => {
    expect(canonicalMarket("x")).toBe("X");
  });

  it("normalizes legacy h/d/a keys (odds-row format)", () => {
    expect(canonicalMarket("h")).toBe("1");
    expect(canonicalMarket("d")).toBe("X");
    expect(canonicalMarket("a")).toBe("2");
  });

  it("normalizes English semantic keys", () => {
    expect(canonicalMarket("home")).toBe("1");
    expect(canonicalMarket("draw")).toBe("X");
    expect(canonicalMarket("away")).toBe("2");
  });

  it("normalizes German semantic keys", () => {
    expect(canonicalMarket("heim")).toBe("1");
    expect(canonicalMarket("remis")).toBe("X");
    expect(canonicalMarket("gast")).toBe("2");
    expect(canonicalMarket("unent.")).toBe("X");
    expect(canonicalMarket("ausw.")).toBe("2");
  });

  it("normalizes Over 2.5 variants", () => {
    expect(canonicalMarket("o25")).toBe("o25");
    expect(canonicalMarket("Ü2.5")).toBe("o25");
    expect(canonicalMarket("ü2.5")).toBe("o25");
    expect(canonicalMarket("over2.5")).toBe("o25");
    expect(canonicalMarket("o2.5")).toBe("o25");
  });

  it("normalizes Under 2.5 variants", () => {
    expect(canonicalMarket("u25")).toBe("u25");
    expect(canonicalMarket("U2.5")).toBe("u25");
    expect(canonicalMarket("u2.5")).toBe("u25");
    expect(canonicalMarket("under2.5")).toBe("u25");
  });

  it("normalizes BTTS variants", () => {
    expect(canonicalMarket("btts")).toBe("btts");
    expect(canonicalMarket("gg")).toBe("btts");
    expect(canonicalMarket("BTTS")).toBe("btts");
  });

  it("normalizes No-BTTS variants", () => {
    expect(canonicalMarket("no_btts")).toBe("no_btts");
    expect(canonicalMarket("ng")).toBe("no_btts");
  });

  it("is whitespace-tolerant", () => {
    expect(canonicalMarket("  1  ")).toBe("1");
    expect(canonicalMarket("\thome\n")).toBe("1");
  });

  it("returns null for unknown markets", () => {
    expect(canonicalMarket("xyz")).toBeNull();
    expect(canonicalMarket("handicap")).toBeNull();
  });

  it("returns null for empty / null / undefined", () => {
    expect(canonicalMarket("")).toBeNull();
    expect(canonicalMarket(null)).toBeNull();
    expect(canonicalMarket(undefined)).toBeNull();
  });
});

// ─── MARKET_LABELS maps ──────────────────────────────────────────

describe("MARKET_LABELS_SHORT / LONG", () => {
  it("has all 7 canonical markets in both maps", () => {
    const keys = ["1", "X", "2", "o25", "u25", "btts", "no_btts"] as const;
    for (const k of keys) {
      expect(MARKET_LABELS_SHORT[k]).toBeDefined();
      expect(MARKET_LABELS_LONG[k]).toBeDefined();
      expect(typeof MARKET_LABELS_SHORT[k]).toBe("string");
      expect(typeof MARKET_LABELS_LONG[k]).toBe("string");
    }
  });

  it("short labels are shorter than long ones", () => {
    expect(MARKET_LABELS_SHORT["1"].length).toBeLessThan(MARKET_LABELS_LONG["1"].length);
    expect(MARKET_LABELS_SHORT["o25"].length).toBeLessThan(MARKET_LABELS_LONG["o25"].length);
  });

  it("has German labels (tests a representative sample)", () => {
    expect(MARKET_LABELS_SHORT["1"]).toBe("Heim");
    expect(MARKET_LABELS_LONG["1"]).toBe("HEIMSIEG");
    expect(MARKET_LABELS_SHORT["X"]).toBe("Remis");
    expect(MARKET_LABELS_LONG["X"]).toBe("UNENTSCHIEDEN");
  });
});

// ─── marketLabel ─────────────────────────────────────────────────

describe("marketLabel", () => {
  it("returns short label by default", () => {
    expect(marketLabel("1")).toBe("Heim");
    expect(marketLabel("o25")).toBe("Ü 2.5");
  });

  it("returns long label when variant='long'", () => {
    expect(marketLabel("1", "long")).toBe("HEIMSIEG");
    expect(marketLabel("o25", "long")).toBe("ÜBER 2.5 TORE");
  });

  it("normalizes legacy inputs before looking up", () => {
    // "h" is canonical → "1" → short "Heim"
    expect(marketLabel("h")).toBe("Heim");
    expect(marketLabel("Ü2.5")).toBe("Ü 2.5");
    expect(marketLabel("Ü2.5", "long")).toBe("ÜBER 2.5 TORE");
  });

  it("falls back to uppercased raw for unknown inputs (not empty)", () => {
    expect(marketLabel("xyz")).toBe("XYZ");
    expect(marketLabel("custom_market")).toBe("CUSTOM_MARKET");
  });

  it("returns — for null/undefined/empty", () => {
    expect(marketLabel(null)).toBe("—");
    expect(marketLabel(undefined)).toBe("—");
    expect(marketLabel("")).toBe("—");
  });
});

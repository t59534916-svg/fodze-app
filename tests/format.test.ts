import { describe, it, expect } from "vitest";
import {
  fmtEuro,
  safeDate,
  fmtDateShort,
  fmtDateLong,
  fmtDateSlug,
  fmtDateTime,
  percent,
  matchKey,
} from "@/lib/format";

// ─── fmtEuro ─────────────────────────────────────────────────────

describe("fmtEuro", () => {
  it("formats positive amount with 2 decimals under 100", () => {
    expect(fmtEuro(42.5)).toBe("€42.50");
    expect(fmtEuro(9.99)).toBe("€9.99");
  });

  it("rounds to integer for amounts >= 100", () => {
    expect(fmtEuro(100)).toBe("€100");
    expect(fmtEuro(1234.5)).toBe("€1235");
    expect(fmtEuro(99.99)).toBe("€99.99"); // strictly less than 100
  });

  it("handles zero", () => {
    expect(fmtEuro(0)).toBe("€0.00");
  });

  it("uses U+2212 minus (not hyphen) for signed negative", () => {
    const result = fmtEuro(-30, true);
    expect(result).toBe("\u2212€30.00");
    expect(result[0]).not.toBe("-"); // ensure it's NOT a regular hyphen
  });

  it("emits + prefix for signed positive", () => {
    expect(fmtEuro(42.5, true)).toBe("+€42.50");
    expect(fmtEuro(0, true)).toBe("+€0.00"); // 0 is treated as non-negative
  });

  it("no prefix when sign=false (default)", () => {
    expect(fmtEuro(42.5)).toBe("€42.50");
    expect(fmtEuro(-42.5)).toBe("€42.50"); // abs value
  });

  it("returns €— for non-finite inputs", () => {
    expect(fmtEuro(NaN)).toBe("€—");
    expect(fmtEuro(Infinity)).toBe("€—");
    expect(fmtEuro(-Infinity)).toBe("€—");
  });
});

// ─── safeDate ────────────────────────────────────────────────────

describe("safeDate", () => {
  it("parses valid ISO strings", () => {
    const d = safeDate("2026-04-12T10:00:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(3); // April = 3
    expect(d?.getUTCDate()).toBe(12);
  });

  it("returns null for empty string", () => {
    expect(safeDate("")).toBeNull();
  });

  it("returns null for null / undefined", () => {
    expect(safeDate(null)).toBeNull();
    expect(safeDate(undefined)).toBeNull();
  });

  it("returns null for garbage strings (no RangeError thrown)", () => {
    expect(safeDate("garbage")).toBeNull();
    expect(safeDate("not-a-date")).toBeNull();
    expect(safeDate("2026-13-50")).toBeNull(); // invalid month/day
  });

  it("defensive: does not throw on pathological input", () => {
    expect(() => safeDate("\\x00")).not.toThrow();
    expect(() => safeDate("9999-99-99T99:99:99Z")).not.toThrow();
  });
});

// ─── fmtDateShort ────────────────────────────────────────────────

describe("fmtDateShort", () => {
  it("formats as DD.MM (German locale)", () => {
    expect(fmtDateShort("2026-04-12T10:00:00Z")).toMatch(/^12\.04$/);
    expect(fmtDateShort("2026-01-05T12:00:00Z")).toMatch(/^05\.01$/);
  });

  it("returns empty string for invalid input (graceful)", () => {
    expect(fmtDateShort(null)).toBe("");
    expect(fmtDateShort(undefined)).toBe("");
    expect(fmtDateShort("")).toBe("");
    expect(fmtDateShort("garbage")).toBe("");
  });
});

// ─── fmtDateLong ─────────────────────────────────────────────────

describe("fmtDateLong", () => {
  it("formats as DD.MM.YYYY", () => {
    expect(fmtDateLong("2026-04-12T10:00:00Z")).toMatch(/^12\.04\.2026$/);
  });

  it("returns empty for invalid", () => {
    expect(fmtDateLong("garbage")).toBe("");
  });
});

// ─── fmtDateSlug ─────────────────────────────────────────────────
// This one was specifically added to fix the RangeError in shareBetCard

describe("fmtDateSlug", () => {
  it("formats valid ISO as YYYY-MM-DD", () => {
    expect(fmtDateSlug("2026-04-12T10:00:00Z")).toBe("2026-04-12");
  });

  it("falls back to today for null/undefined (no crash)", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(fmtDateSlug(null)).toBe(today);
    expect(fmtDateSlug(undefined)).toBe(today);
    expect(fmtDateSlug("")).toBe(today);
  });

  it("falls back to today for garbage (no RangeError)", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(fmtDateSlug("garbage")).toBe(today);
    expect(fmtDateSlug("not-iso")).toBe(today);
  });

  it("does not throw on pathological input", () => {
    expect(() => fmtDateSlug("9999-99-99")).not.toThrow();
  });
});

// ─── fmtDateTime ─────────────────────────────────────────────────

describe("fmtDateTime", () => {
  it("formats as 'Weekday, DD.MM HH:MM' (German locale)", () => {
    const result = fmtDateTime("2026-04-12T15:30:00Z");
    // Weekday abbreviation varies ("So.", "So"), date+time is stable format
    expect(result).toMatch(/\d{2}\.\d{2}/); // DD.MM
    expect(result).toMatch(/\d{2}:\d{2}/); // HH:MM
  });

  it("empty string for invalid", () => {
    expect(fmtDateTime(null)).toBe("");
    expect(fmtDateTime("garbage")).toBe("");
  });
});

// ─── percent ─────────────────────────────────────────────────────

describe("percent", () => {
  it("formats fractions with 1 decimal by default", () => {
    expect(percent(0.423)).toBe("42.3%");
    expect(percent(0.5)).toBe("50.0%");
    expect(percent(1)).toBe("100.0%");
    expect(percent(0)).toBe("0.0%");
  });

  it("respects custom decimals", () => {
    expect(percent(0.423, 0)).toBe("42%");
    expect(percent(0.423, 2)).toBe("42.30%");
  });

  it("signs output when signed=true", () => {
    expect(percent(0.04, 1, true)).toBe("+4.0%");
    expect(percent(-0.04, 1, true)).toBe("-4.0%");
    expect(percent(0, 1, true)).toBe("+0.0%"); // 0 is non-negative
  });

  it("returns — for non-finite inputs", () => {
    expect(percent(NaN)).toBe("—");
    expect(percent(Infinity)).toBe("—");
    expect(percent(-Infinity)).toBe("—");
  });

  it("handles negatives without signed flag", () => {
    expect(percent(-0.1)).toBe("-10.0%");
  });
});

// ─── matchKey ────────────────────────────────────────────────────

describe("matchKey", () => {
  it("joins league + teams with : and -", () => {
    expect(matchKey("bundesliga", "Bayern", "Dortmund")).toBe("bundesliga:bayern-dortmund");
  });

  it("lowercases and strips whitespace", () => {
    expect(matchKey("bundesliga", "FC Bayern München", "Borussia Dortmund"))
      .toBe("bundesliga:fcbayernmünchen-borussiadortmund");
  });

  it("handles empty team names defensively", () => {
    expect(matchKey("epl", "", "Arsenal")).toBe("epl:-arsenal");
    expect(matchKey("epl", "Arsenal", "")).toBe("epl:arsenal-");
  });

  it("is deterministic (same inputs = same output)", () => {
    const a = matchKey("la_liga", "Real Madrid", "Barcelona");
    const b = matchKey("la_liga", "Real Madrid", "Barcelona");
    expect(a).toBe(b);
  });
});

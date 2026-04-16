import { describe, it, expect } from "vitest";
import { parseAbsences } from "@/lib/absence-parser";

describe("parseAbsences", () => {
  it("returns [] for empty/nullish input", () => {
    expect(parseAbsences("", "Bayern")).toEqual([]);
    expect(parseAbsences(null, "Bayern")).toEqual([]);
    expect(parseAbsences(undefined, "Bayern")).toEqual([]);
    expect(parseAbsences("  ", "Bayern")).toEqual([]);
  });

  it("returns [] for dash placeholders", () => {
    expect(parseAbsences("-", "Bayern")).toEqual([]);
    expect(parseAbsences("—", "Bayern")).toEqual([]);
  });

  it("parses a single name without parentheses", () => {
    const r = parseAbsences("Kane", "Bayern");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Kane");
    expect(r[0].team).toBe("Bayern");
    // Default position when unknown = MID
    expect(r[0].position).toBe("MID");
  });

  it("maps German position hints to canonical codes", () => {
    const bundesliga = parseAbsences(
      "Neuer (TW, Verletzung), Kimmich (MF, Muskel), Kane (ST, Oberschenkel), Upamecano (IV, Knie)",
      "Bayern",
    );
    expect(bundesliga).toHaveLength(4);
    expect(bundesliga[0].position).toBe("GK");
    expect(bundesliga[1].position).toBe("MID");
    expect(bundesliga[2].position).toBe("FWD");
    expect(bundesliga[3].position).toBe("DEF");
  });

  it("splits correctly even when reasons contain commas inside parentheses", () => {
    // Real example from enrichment scripts — comma inside the reason block
    const r = parseAbsences(
      "Fujita (MF, 5. Gelbe Karte Sperre), Sands (MF, Knöchel-OP, Saison-Aus)",
      "St. Pauli",
    );
    expect(r).toHaveLength(2);
    expect(r[0].name).toBe("Fujita");
    expect(r[1].name).toBe("Sands");
  });

  it("skips players flagged as returning / fit", () => {
    const r = parseAbsences(
      "Kane (ST, zurück im Training), Kimmich (MF, Muskel)",
      "Bayern",
    );
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Kimmich");
  });

  it("marks all parsed players as key (higher xG share)", () => {
    const keyFwd = parseAbsences("Kane (ST, Verletzung)", "Bayern")[0];
    // defaultPlayerProfile with isKeyPlayer=true gives xgShare ≥ raw default
    // FWD default xgShare = 0.25, key multiplier 1.5 = 0.375
    expect(keyFwd.xgShare).toBeGreaterThanOrEqual(0.25);
  });

  it("handles messy whitespace and punctuation gracefully", () => {
    const r = parseAbsences(
      "  Kane (ST)  ,   Neuer ( TW , bruch )  ",
      "Bayern",
    );
    expect(r).toHaveLength(2);
    expect(r[0].name).toBe("Kane");
    expect(r[1].name).toBe("Neuer");
  });

  it("handles names without meta", () => {
    const r = parseAbsences("Kane, Kimmich, Neuer", "Bayern");
    expect(r).toHaveLength(3);
    expect(r.map(p => p.name)).toEqual(["Kane", "Kimmich", "Neuer"]);
    // All default to MID when no hint
    expect(r.every(p => p.position === "MID")).toBe(true);
  });
});

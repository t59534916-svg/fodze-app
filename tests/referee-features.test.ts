import { describe, it, expect } from "vitest";
import { predictYellowCards } from "@/lib/dixon-coles";
// referee-aliases.mjs archived 2026-05-28 (referees table dropped). Test
// preserved as regression coverage for the archived chain — if a future
// sprint resurrects the referee feature, this catches breakage at the
// helper-function level. Import path points to _archive/.
// .mjs helpers — vitest + native ESM handle the extension explicitly.
import { slugifyReferee, resolveRefereeName } from "../scripts/_archive/referee-aliases.mjs";
import {
  deriveRefereeFeatures,
  formatRefereeCardString,
  lookupReferee,
} from "../scripts/_lib/matchday-enrich.mjs";

describe("slugifyReferee", () => {
  it("collapses 'First Last' and 'Last, First' to the same slug", () => {
    expect(slugifyReferee("Felix Zwayer")).toBe("felix-zwayer");
    expect(slugifyReferee("Zwayer, Felix")).toBe("felix-zwayer");
  });

  it("strips diacritics and punctuation", () => {
    expect(slugifyReferee("José María Sánchez")).toBe("jose-maria-sanchez");
    expect(slugifyReferee("Dr. Felix Brych")).toBe("dr-felix-brych");
  });

  it("handles ß correctly", () => {
    // "Weißbach" → "weissbach", stable slug even after NFD normalization.
    expect(slugifyReferee("Klaus Weißbach")).toBe("klaus-weissbach");
  });

  it("collapses whitespace and preserves order", () => {
    expect(slugifyReferee("  Mike   Dean  ")).toBe("mike-dean");
  });

  it("returns empty string for empty/null input", () => {
    expect(slugifyReferee("")).toBe("");
    expect(slugifyReferee(null as unknown as string)).toBe("");
    expect(slugifyReferee(undefined as unknown as string)).toBe("");
  });
});

describe("resolveRefereeName", () => {
  it("returns canonical name from alias", () => {
    expect(resolveRefereeName("F. Zwayer")).toBe("Felix Zwayer");
    expect(resolveRefereeName("M. Dean")).toBe("Mike Dean");
  });

  it("passes unknown names through unchanged", () => {
    expect(resolveRefereeName("Unknown Ref")).toBe("Unknown Ref");
  });

  it("handles empty input gracefully", () => {
    expect(resolveRefereeName("")).toBe("");
    expect(resolveRefereeName(undefined as unknown as string)).toBe("");
  });
});

describe("formatRefereeCardString", () => {
  it("formats a row in schema-compliant format", () => {
    const row = { referee_name: "Felix Zwayer", yellows_per_game: 4.3 };
    expect(formatRefereeCardString(row)).toBe("Felix Zwayer, Ø 4.3 Karten/Spiel");
  });

  it("always uses one decimal place", () => {
    const row = { referee_name: "Mike Dean", yellows_per_game: 4 };
    expect(formatRefereeCardString(row)).toBe("Mike Dean, Ø 4.0 Karten/Spiel");
  });

  it("returns empty string when row is null or yellows missing", () => {
    expect(formatRefereeCardString(null)).toBe("");
    expect(formatRefereeCardString({ referee_name: "X", yellows_per_game: null })).toBe("");
  });
});

describe("lookupReferee", () => {
  const refMap = new Map([
    ["felix-zwayer", { referee_name: "Felix Zwayer", referee_slug: "felix-zwayer", yellows_per_game: 4.3 }],
    ["mike-dean", { referee_name: "Mike Dean", referee_slug: "mike-dean", yellows_per_game: 3.5 }],
  ]);

  it("resolves alias then slug", () => {
    const hit = lookupReferee(refMap, "F. Zwayer");
    expect(hit?.referee_name).toBe("Felix Zwayer");
  });

  it("matches 'Last, First' via slug normalization", () => {
    const hit = lookupReferee(refMap, "Zwayer, Felix");
    expect(hit?.referee_name).toBe("Felix Zwayer");
  });

  it("returns null for unknown referee", () => {
    expect(lookupReferee(refMap, "Some Stranger")).toBeNull();
  });

  it("returns null for empty name", () => {
    expect(lookupReferee(refMap, "")).toBeNull();
    expect(lookupReferee(refMap, null)).toBeNull();
  });
});

describe("deriveRefereeFeatures", () => {
  const refMap = new Map([
    ["felix-zwayer", {
      referee_name: "Felix Zwayer",
      referee_slug: "felix-zwayer",
      yellows_per_game: 4.3,
      reds_per_game: 0.2,
      home_yellow_bias: 1.12,
      matches_analyzed: 42,
      source: "fbref-schedule",
    }],
  ]);

  it("returns enriched shape for a known referee", () => {
    const f = deriveRefereeFeatures(refMap, "Felix Zwayer");
    expect(f.ref_string).toBe("Felix Zwayer, Ø 4.3 Karten/Spiel");
    expect(f.yellows_pg).toBe(4.3);
    expect(f.home_yellow_bias).toBe(1.12);
    expect(f.matches_analyzed).toBe(42);
  });

  it("returns neutral-safe defaults for unknown referee", () => {
    const f = deriveRefereeFeatures(refMap, "Some Stranger");
    expect(f.ref_string).toBe("");
    expect(f.yellows_pg).toBeNull();
    expect(f.home_yellow_bias).toBe(1.0); // neutral prior
    expect(f.matches_analyzed).toBe(0);
  });

  it("handles null input gracefully (current pre-upgrade behavior)", () => {
    const f = deriveRefereeFeatures(refMap, null);
    expect(f.ref_string).toBe("");
    expect(f.home_yellow_bias).toBe(1.0);
  });
});

describe("predictYellowCards (with homeBias)", () => {
  it("defaults to neutral split when homeBias is omitted", () => {
    const out = predictYellowCards("Zwayer, Ø 4.0 Karten/Spiel", "bundesliga");
    expect(out.expected).toBe(4.0);
    expect(out.home).toBeCloseTo(2.0, 3);
    expect(out.away).toBeCloseTo(2.0, 3);
  });

  it("distributes yellows according to homeBias", () => {
    const out = predictYellowCards("Ref, Ø 4.0 Karten/Spiel", "bundesliga", 1.5);
    // home = 1.5 * 4.0 / 2.5 = 2.4; away = 4.0 / 2.5 = 1.6
    expect(out.home).toBeCloseTo(2.4, 3);
    expect(out.away).toBeCloseTo(1.6, 3);
    expect(out.home + out.away).toBeCloseTo(4.0, 3);
  });

  it("clamps pathological homeBias values", () => {
    // 10x should clamp to 2.0 (our hard cap) → home=2*avg*2/3, away=avg/3
    const out = predictYellowCards("Ref, Ø 3.0 Karten/Spiel", "bundesliga", 10.0);
    // clamped bias = 2.0 → home = 2*3/3 = 2.0, away = 3/3 = 1.0
    expect(out.home).toBeCloseTo(2.0, 3);
    expect(out.away).toBeCloseTo(1.0, 3);
  });

  it("still works backward-compatibly for existing callers (no refereeStr)", () => {
    const out = predictYellowCards(undefined, "bundesliga");
    expect(out.expected).toBe(3.8); // LEAGUE_AVG_CARDS fallback
    expect(out.home).toBeCloseTo(1.9, 3);
    expect(out.away).toBeCloseTo(1.9, 3);
  });

  it("parses EN 'cards' variant in referee string", () => {
    const out = predictYellowCards("Mike Dean, Avg 3.5 cards", "epl");
    expect(out.expected).toBe(3.5);
  });
});

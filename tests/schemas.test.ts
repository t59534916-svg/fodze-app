import { describe, it, expect } from "vitest";
import { validateMatchdayJSON, TeamDataSchema, MatchdayDataSchema } from "@/lib/schemas";

describe("TeamDataSchema", () => {
  it("accepts valid team data", () => {
    const result = TeamDataSchema.safeParse({
      name: "FC Bayern München",
      xg_h8: 14.2,
      xga_h8: 8.5,
      games: 8,
      form: "W W D L W",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty team name", () => {
    const result = TeamDataSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("coerces string xG values to numbers", () => {
    const result = TeamDataSchema.safeParse({
      name: "Test Team",
      xg_h8: "14.2",  // String statt Number
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.xg_h8).toBe(14.2);
      expect(typeof result.data.xg_h8).toBe("number");
    }
  });

  it("rejects xG values out of range", () => {
    const result = TeamDataSchema.safeParse({
      name: "Test",
      xg_h8: 50,  // > 40 = unmöglich
    });
    expect(result.success).toBe(false);
  });
});

describe("validateMatchdayJSON", () => {
  const validMatchday = {
    league: "Bundesliga",
    matchday: "Spieltag 28",
    date: "2026-04-04",
    data_confidence: "HIGH",
    matches: [{
      home: { name: "Bayern", xg_h8: 14.2, xga_h8: 8.5, games: 8 },
      away: { name: "Dortmund", xg_a8: 10.8, xga_a8: 12.1, games: 8 },
      kickoff: "15:30",
      referee: "Daniel Siebert, Ø 4.2 Karten/Spiel",
    }],
  };

  it("validates correct matchday data", () => {
    const result = validateMatchdayJSON(validMatchday);
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("warns on suspiciously low xG (likely averages)", () => {
    const result = validateMatchdayJSON({
      ...validMatchday,
      matches: [{
        home: { name: "Bayern", xg_h8: 1.5, xga_h8: 1.0, games: 8 },  // Durchschnitte!
        away: { name: "Dortmund", xg_a8: 1.2, xga_a8: 1.8, games: 8 },
        kickoff: "15:30",
      }],
    });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings!.some(w => w.includes("zu niedrig"))).toBe(true);
  });

  it("warns on missing referee card average", () => {
    const result = validateMatchdayJSON({
      ...validMatchday,
      matches: [{
        home: { name: "Bayern", xg_h8: 14.2, xga_h8: 8.5, games: 8 },
        away: { name: "Dortmund", xg_a8: 10.8, xga_a8: 12.1, games: 8 },
        referee: "Daniel Siebert",  // Fehlt: Ø X.X
      }],
    });
    expect(result.success).toBe(true);
    expect(result.warnings!.some(w => w.includes("Karten-Schnitt"))).toBe(true);
  });

  it("rejects empty matches array", () => {
    const result = validateMatchdayJSON({
      league: "Bundesliga",
      matchday: "Spieltag 28",
      matches: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects completely invalid input", () => {
    const result = validateMatchdayJSON("nicht json");
    expect(result.success).toBe(false);
  });

  it("warns on implausible top scorer probability", () => {
    const result = validateMatchdayJSON({
      ...validMatchday,
      matches: [{
        home: { name: "Bayern", xg_h8: 14.2, xga_h8: 8.5, games: 8 },
        away: { name: "Dortmund", xg_a8: 10.8, xga_a8: 12.1, games: 8 },
        top_scorers: [{ name: "Kane", team: "H", prob: 0.95 }],  // 95% ist unplausibel
      }],
    });
    expect(result.success).toBe(true);
    expect(result.warnings!.some(w => w.includes("unplausibel"))).toBe(true);
  });
});

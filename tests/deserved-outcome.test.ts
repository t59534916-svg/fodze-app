import { describe, it, expect } from "vitest";
import { deservedPicture } from "../src/lib/deserved-outcome";

// ─────────────────────────────────────────────────────────────────────
// Pins the deserved-outcome boundaries + labels. This is user-facing copy
// derived from the engine λ (expected goals). It is a PRESENTATION of an
// existing signal (§13), so the test guards the thresholds against drift,
// not any accuracy claim. Margin bands: ≥0.7 "klar", ≥0.25 "leicht", else
// "offen"/"even".
// ─────────────────────────────────────────────────────────────────────

describe("deservedPicture — side + clarity bands", () => {
  it("clear home edge (≥0.7 goal margin)", () => {
    const d = deservedPicture(2.1, 0.9);
    expect(d.side).toBe("home");
    expect(d.clarity).toBe("klar");
    expect(d.label).toBe("Heim verdient klar vorn");
    expect(d.homeXg).toBe(2.1);
    expect(d.awayXg).toBe(0.9);
    expect(d.margin).toBe(1.2);
    expect(d.total).toBe(3.0);
  });

  it("clear away edge", () => {
    const d = deservedPicture(0.8, 1.7);
    expect(d.side).toBe("away");
    expect(d.clarity).toBe("klar");
    expect(d.label).toBe("Auswärts verdient klar vorn");
  });

  it("slight edge (0.25 ≤ margin < 0.7)", () => {
    const d = deservedPicture(1.6, 1.2);
    expect(d.side).toBe("home");
    expect(d.clarity).toBe("leicht");
    expect(d.label).toBe("Heim leicht vorn");
  });

  it("even matchup (margin < 0.25)", () => {
    const d = deservedPicture(1.4, 1.3);
    expect(d.side).toBe("even");
    expect(d.clarity).toBe("offen");
    expect(d.label).toBe("Erwartet ausgeglichen");
  });

  it("exact boundary 0.7 = klar (inclusive)", () => {
    expect(deservedPicture(1.7, 1.0).clarity).toBe("klar");
  });

  it("exact boundary 0.25 = leicht (inclusive lower edge of slight)", () => {
    expect(deservedPicture(1.25, 1.0).clarity).toBe("leicht");
    expect(deservedPicture(1.25, 1.0).side).toBe("home");
  });

  it("just below 0.25 = even/offen", () => {
    const d = deservedPicture(1.24, 1.0);
    expect(d.side).toBe("even");
    expect(d.clarity).toBe("offen");
  });
});

describe("deservedPicture — total / goal-heaviness", () => {
  it("reports total expected goals", () => {
    expect(deservedPicture(1.8, 1.4).total).toBe(3.2);
    expect(deservedPicture(0.9, 0.8).total).toBe(1.7);
  });
});

describe("deservedPicture — degenerate inputs never throw", () => {
  it("NaN home clamps to 0 → away picture, finite output (graceful)", () => {
    const d = deservedPicture(NaN, 1.5);
    // NaN clamps to 0, so margin = |0 − 1.5| = 1.5 → away klar. The point of this
    // case is graceful degradation (finite, no throw), not a specific side.
    expect(d.homeXg).toBe(0);
    expect(d.awayXg).toBe(1.5);
    expect(d.side).toBe("away");
    expect(d.clarity).toBe("klar");
    expect(Number.isFinite(d.homeXg)).toBe(true);
    expect(Number.isFinite(d.awayXg)).toBe(true);
  });

  it("both NaN → fully even", () => {
    const d = deservedPicture(NaN, NaN);
    expect(d.side).toBe("even");
    expect(d.clarity).toBe("offen");
    expect(d.homeXg).toBe(0);
    expect(d.awayXg).toBe(0);
    expect(d.label).toBe("Erwartet ausgeglichen");
  });

  it("negative λ clamps to 0", () => {
    const d = deservedPicture(-1, 1.0);
    expect(d.homeXg).toBe(0);
    expect(d.side).toBe("away");
  });
});

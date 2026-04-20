import { describe, it, expect } from "vitest";
import { haversineKm, totalTravelKm } from "../scripts/_lib/geo.mjs";
import {
  deriveTravelCongestion,
  flagShortRestEuropean,
} from "../scripts/_lib/matchday-enrich.mjs";

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm(48.2188, 11.6247, 48.2188, 11.6247)).toBe(0);
  });

  it("matches reference distance Munich ↔ Dortmund within 1%", () => {
    // Munich (Allianz Arena): 48.2188, 11.6247
    // Dortmund (Signal Iduna): 51.4926, 7.4517
    // Reference from geodesic tools: ~478 km
    const d = haversineKm(48.2188, 11.6247, 51.4926, 7.4517);
    expect(d).not.toBeNull();
    expect(d).toBeGreaterThan(470);
    expect(d).toBeLessThan(490);
  });

  it("matches reference Munich ↔ Madrid within 1%", () => {
    // Madrid (Santiago Bernabéu): 40.4531, -3.6884
    // Munich ↔ Madrid ≈ 1480 km
    const d = haversineKm(48.2188, 11.6247, 40.4531, -3.6884);
    expect(d).not.toBeNull();
    expect(d).toBeGreaterThan(1470);
    expect(d).toBeLessThan(1495);
  });

  it("returns null when any coordinate is missing or non-finite", () => {
    expect(haversineKm(NaN, 0, 0, 0)).toBeNull();
    expect(haversineKm(0, 0, 0, Infinity)).toBeNull();
    expect(haversineKm(null as unknown as number, 0, 0, 0)).toBeNull();
    expect(haversineKm(undefined as unknown as number, 0, 0, 0)).toBeNull();
  });

  it("is symmetric", () => {
    const ab = haversineKm(48, 11, 51, 7);
    const ba = haversineKm(51, 7, 48, 11);
    expect(ab).toBeCloseTo(ba!, 6);
  });
});

describe("totalTravelKm", () => {
  it("returns null on empty input", () => {
    expect(totalTravelKm([])).toBeNull();
    expect(totalTravelKm(null as any)).toBeNull();
  });

  it("accumulates consecutive legs when coords are provided", () => {
    const matches = [
      { home_lat: 48, home_lng: 11, away_lat: 51, away_lng: 7, team_side: "home" as const },
      { home_lat: 48, home_lng: 11, away_lat: 52, away_lng: 13, team_side: "away" as const },
      { home_lat: 48, home_lng: 11, away_lat: 51, away_lng: 7, team_side: "home" as const },
    ];
    const total = totalTravelKm(matches);
    expect(total).not.toBeNull();
    expect(total).toBeGreaterThan(0);
  });
});

describe("deriveTravelCongestion", () => {
  const teamStadium = { lat: 48.2188, lng: 11.6247 };      // Munich
  const oppStadium  = { lat: 51.4926, lng: 7.4517, team: "Dortmund" };   // Dortmund (~478 km)
  const stadiumMap = new Map<string, { lat: number; lng: number }>([
    ["Dortmund", { lat: 51.4926, lng: 7.4517 }],
    ["Hamburg",  { lat: 53.5875, lng: 10.0027 }],
  ]);

  const KO = "2025-09-20T15:30:00Z";

  it("counts matches_last_14d", () => {
    const rows = [
      { venue: "away", opponent: "Dortmund", match_date: "2025-09-13" },
      { venue: "home", opponent: "Dortmund", match_date: "2025-09-17" },
      { venue: "away", opponent: "Hamburg",  match_date: "2025-09-10" },
      { venue: "home", opponent: "Dortmund", match_date: "2025-08-20" }, // outside 14d
    ];
    const out = deriveTravelCongestion({
      team: "Bayern", teamStadium, historyRows: rows, stadiumMap, kickoff: KO,
    });
    expect(out.matches_last_14d).toBe(3);
  });

  it("sums travel only for away matches within 7 days (round-trip doubles)", () => {
    const rows = [
      { venue: "away", opponent: "Dortmund", match_date: "2025-09-17" }, // 3d ago — counts
      { venue: "home", opponent: "Dortmund", match_date: "2025-09-13" }, // home — 0 travel
      { venue: "away", opponent: "Hamburg",  match_date: "2025-09-01" }, // >7d ago — excluded
    ];
    const out = deriveTravelCongestion({
      team: "Bayern", teamStadium, historyRows: rows, stadiumMap, kickoff: KO,
    });
    expect(out.travel_km_last_7d).not.toBeNull();
    // Dortmund round-trip ≈ 478 × 2 ≈ 956 km
    expect(out.travel_km_last_7d!).toBeGreaterThan(900);
    expect(out.travel_km_last_7d!).toBeLessThan(1000);
  });

  it("returns null travel when teamStadium is missing", () => {
    const rows = [{ venue: "away", opponent: "Dortmund", match_date: "2025-09-17" }];
    const out = deriveTravelCongestion({
      team: "X", teamStadium: null, historyRows: rows, stadiumMap, kickoff: KO,
    });
    expect(out.travel_km_last_7d).toBeNull();
    expect(out.matches_last_14d).toBe(1);
  });

  it("detects consecutive-away streak from newest", () => {
    const rows = [
      { venue: "away", opponent: "Dortmund", match_date: "2025-09-17" },
      { venue: "away", opponent: "Hamburg",  match_date: "2025-09-14" },
      { venue: "home", opponent: "Dortmund", match_date: "2025-09-10" },
      { venue: "away", opponent: "Hamburg",  match_date: "2025-09-07" },
    ];
    const out = deriveTravelCongestion({
      team: "Bayern", teamStadium, historyRows: rows, stadiumMap, kickoff: KO,
    });
    expect(out.consecutive_away_count).toBe(2);
  });

  it("ignores future matches (kickoff is the anchor)", () => {
    const rows = [
      { venue: "away", opponent: "Dortmund", match_date: "2025-09-25" }, // future
      { venue: "away", opponent: "Dortmund", match_date: "2025-09-17" },
    ];
    const out = deriveTravelCongestion({
      team: "Bayern", teamStadium, historyRows: rows, stadiumMap, kickoff: KO,
    });
    expect(out.matches_last_14d).toBe(1);
  });
});

describe("flagShortRestEuropean", () => {
  it("always returns false when no European-Away flag is set", () => {
    // Current state — UEFA-fixtures source not yet wired, so euroAwayRecent=false.
    expect(flagShortRestEuropean({ travel_km_last_7d: 2000, matches_last_14d: 10 }, false)).toBe(false);
  });

  it("triggers on long travel within 7d when European-Away is set", () => {
    const out = flagShortRestEuropean(
      { travel_km_last_7d: 900, matches_last_14d: 2 },
      true,
    );
    expect(out).toBe(true);
  });

  it("triggers on high match density even without long travel", () => {
    expect(flagShortRestEuropean({ travel_km_last_7d: 100, matches_last_14d: 5 }, true)).toBe(true);
  });

  it("stays false when neither travel nor congestion threshold hit", () => {
    expect(flagShortRestEuropean({ travel_km_last_7d: 200, matches_last_14d: 3 }, true)).toBe(false);
  });

  it("handles null/undefined fatigue safely", () => {
    expect(flagShortRestEuropean({}, true)).toBe(false);
    expect(flagShortRestEuropean(null as any, true)).toBe(false);
  });
});

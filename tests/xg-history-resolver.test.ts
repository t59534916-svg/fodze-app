import { describe, it, expect } from "vitest";
import { resolveBucket, extractProbeToken } from "@/lib/xg-history-resolver";
import type { TeamXGMatch } from "@/lib/supabase";

// Minimal helper so the tests read like fixtures, not mock machinery.
function row(team: string, opponent: string, venue: "home" | "away", xg = 1.5, xga = 1.0): TeamXGMatch {
  return {
    team,
    opponent,
    venue,
    match_date: "2026-04-01",
    xg,
    xga,
    npxg: null, npxga: null,
    ppda_att: null, ppda_def: null,
    deep: null, deep_allowed: null,
    goals_for: 1,
    goals_against: 1,
  };
}

function bucket(entries: Array<{ team: string; venue: "home" | "away"; count?: number }>): Map<string, TeamXGMatch[]> {
  const m = new Map<string, TeamXGMatch[]>();
  for (const { team, venue, count = 1 } of entries) {
    const key = `${team}|${venue}`;
    m.set(key, Array.from({ length: count }, (_, i) => row(team, `Opp${i}`, venue)));
  }
  return m;
}

// ─── extractProbeToken ──────────────────────────────────────────────
// Critical because the substring matcher probes with a SINGLE token —
// if we pick a stop-word by accident, every team with "FC" in its name
// matches every other one. Guard the filter and the longest-wins rule.

describe("extractProbeToken", () => {
  it("picks the longest non-stop token", () => {
    expect(extractProbeToken("FC Bayern München")).toBe("münchen");
    expect(extractProbeToken("Borussia Dortmund")).toBe("borussia");
  });

  it("filters out common club prefixes", () => {
    expect(extractProbeToken("FC SC SV")).toBe(null); // all stop tokens
    expect(extractProbeToken("RB Leipzig")).toBe("leipzig"); // RB dropped
  });

  it("filters out tokens of length ≤ 3", () => {
    expect(extractProbeToken("The FC")).toBe(null);
  });

  it("handles separators like . and _", () => {
    expect(extractProbeToken("VfL.Wolfsburg")).toBe("wolfsburg");
  });

  it("lowercases the result", () => {
    expect(extractProbeToken("BAYERN MUNICH")).toBe("bayern");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(extractProbeToken("")).toBe(null);
    expect(extractProbeToken("   ")).toBe(null);
  });
});

// ─── resolveBucket ──────────────────────────────────────────────────
// The resolver is the fallback chain for every match in a matchday.
// A regression here would silently replace a team's real 8-game xG
// window with either the wrong team's history or the league-average
// fallback — hard to notice in the UI.

describe("resolveBucket", () => {
  it("hits the exact key first — no fuzzy fallback when there's a match", () => {
    const b = bucket([
      { team: "Bayern Munich", venue: "home", count: 8 },
      { team: "Bayern Munich", venue: "away", count: 8 },
    ]);
    // TEAM_SCRAPER_MAP maps "FC Bayern München" → understat "Bayern Munich",
    // so the exact lookup finds it without needing the fuzzy path.
    const result = resolveBucket(b, "FC Bayern München", "home");
    expect(result.length).toBe(8);
    expect(result[0].team).toBe("Bayern Munich");
  });

  it("respects venue — home query never returns away bucket", () => {
    const b = bucket([{ team: "Bayern Munich", venue: "away", count: 8 }]);
    const result = resolveBucket(b, "FC Bayern München", "home");
    expect(result).toEqual([]);
  });

  it("falls back to substring match when exact key misses", () => {
    // Simulate a team in Supabase with slightly different naming than
    // TEAM_SCRAPER_MAP expects — the probe-token path should catch it.
    const b = bucket([{ team: "Werder Bremen", venue: "home", count: 5 }]);
    const result = resolveBucket(b, "SV Werder Bremen", "home");
    expect(result.length).toBe(5);
  });

  it("substring fallback only matches within the same venue", () => {
    const b = bucket([{ team: "Werder Bremen", venue: "away", count: 5 }]);
    const result = resolveBucket(b, "SV Werder Bremen", "home");
    expect(result).toEqual([]);
  });

  it("returns empty when no tokens are distinctive", () => {
    const b = bucket([{ team: "The FC Club", venue: "home", count: 5 }]);
    // "FC" and "The" are stop-tokens → no probe → no fuzzy hit.
    const result = resolveBucket(b, "FC SV", "home");
    expect(result).toEqual([]);
  });

  it("never returns an empty bucket as a fuzzy match", () => {
    // If a team-name happens to exist in the map but with zero rows, we
    // should still try the fuzzy path; here there's no other option so
    // we return empty.
    const b = new Map<string, TeamXGMatch[]>();
    b.set("Bayern Munich|home", []);
    const result = resolveBucket(b, "FC Bayern München", "home");
    // The exact-key path short-circuits on empty-length, so fuzzy is
    // attempted; no other bucket exists → empty.
    expect(result).toEqual([]);
  });

  it("longest-token probe picks the most distinctive word", () => {
    // Two buckets both contain "united" as a substring, but only one
    // matches the team's longest distinctive token.
    const b = bucket([
      { team: "Manchester United", venue: "home", count: 8 },
      { team: "Leeds United", venue: "home", count: 4 },
    ]);
    const result = resolveBucket(b, "Manchester Utd", "home");
    // Longest token of "Manchester Utd" is "manchester" → should find
    // the Manchester United bucket, not Leeds.
    expect(result.length).toBe(8);
    expect(result[0].team).toBe("Manchester United");
  });
});

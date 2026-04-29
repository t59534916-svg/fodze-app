// ═══════════════════════════════════════════════════════════════════════
// Locks down `canonicalizeTeamName(name, league)` from team-resolver.ts
// against the SAME alias-set as scripts/_lib/canonical-team.mjs.
//
// Why this matters: MatchdayContext.loadCached calls canonicalizeTeamName
// BEFORE resolving the xG-history bucket. If the TS-side EXTRA_LEAGUE_ALIASES
// drift away from the JS-side EXTRA_ALIASES, ingest writes one canonical
// (e.g. "Stade Brest") but engine-read looks up another (e.g. "Brest")
// → tier-1 misses, tier-2 fuzzy fallback runs (slower, less deterministic).
//
// These two files are paired by hand. This test catches it when they drift.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { canonicalizeTeamName } from "@/lib/team-resolver";

describe("canonicalizeTeamName — TS mirror of scripts/_lib/canonical-team.mjs", () => {
  it("Ligue 1: maps short matchday names to long FootyStats canonical", () => {
    expect(canonicalizeTeamName("Brest", "ligue_1")).toBe("Stade Brest");
    expect(canonicalizeTeamName("Lens", "ligue_1")).toBe("RC Lens");
    expect(canonicalizeTeamName("Lille", "ligue_1")).toBe("LOSC Lille");
    expect(canonicalizeTeamName("Lyon", "ligue_1")).toBe("Olympique Lyon");
    expect(canonicalizeTeamName("Marseille", "ligue_1")).toBe("Olympique Marseille");
    expect(canonicalizeTeamName("Monaco", "ligue_1")).toBe("AS Monaco");
  });

  it("Ligue 1: PSG aliases via EXTRA_LEAGUE_ALIASES", () => {
    expect(canonicalizeTeamName("PSG", "ligue_1")).toBe("Paris Saint Germain");
    expect(canonicalizeTeamName("Paris SG", "ligue_1")).toBe("Paris Saint Germain");
    expect(canonicalizeTeamName("Paris S.G.", "ligue_1")).toBe("Paris Saint Germain");
  });

  it("Bundesliga 2: relegated/promoted teams not in registry's bundesliga section", () => {
    expect(canonicalizeTeamName("Hertha Berlin", "bundesliga2")).toBe("Hertha BSC");
    expect(canonicalizeTeamName("Hertha", "bundesliga2")).toBe("Hertha BSC");
    expect(canonicalizeTeamName("SC Paderborn", "bundesliga2")).toBe("SC Paderborn 07");
    expect(canonicalizeTeamName("Greuther Fürth", "bundesliga2")).toBe("SpVgg Greuther Fürth");
    expect(canonicalizeTeamName("Greuther Fuerth", "bundesliga2")).toBe("SpVgg Greuther Fürth");  // umlaut-strip
    expect(canonicalizeTeamName("Arminia Bielefeld", "bundesliga2")).toBe("DSC Arminia Bielefeld");
    expect(canonicalizeTeamName("Elversberg", "bundesliga2")).toBe("SV 07 Elversberg");
  });

  it("Liga 3: OpenLigaDB long-form vs FootyStats short-form", () => {
    expect(canonicalizeTeamName("Schweinfurt", "liga3")).toBe("1. FC Schweinfurt 05");
    expect(canonicalizeTeamName("Wehen Wiesbaden", "liga3")).toBe("SV Wehen Wiesbaden");
    expect(canonicalizeTeamName("TSG Hoffenheim II", "liga3")).toBe("TSG 1899 Hoffenheim II");
    expect(canonicalizeTeamName("Viktoria Köln", "liga3")).toBe("FC Viktoria Köln");
  });

  it("Greek SL: typo aliases (Larisa/Larissa, Panaitolikos/Panetolikos)", () => {
    expect(canonicalizeTeamName("Larisa", "greek_sl")).toBe("Larissa");
    expect(canonicalizeTeamName("Panetolikos", "greek_sl")).toBe("Panaitolikos");
  });

  it("Jupiler Pro: Leuven canonical disambiguation", () => {
    expect(canonicalizeTeamName("Leuven", "jupiler_pro")).toBe("OH Leuven");
    expect(canonicalizeTeamName("Oud-Heverlee Leuven", "jupiler_pro")).toBe("OH Leuven");
  });

  it("La Liga 2: Reserve-team and short-name canonicals", () => {
    expect(canonicalizeTeamName("Cultural Leonesa", "la_liga2")).toBe("Cultural y Deportiva Leonesa");
    expect(canonicalizeTeamName("Real Sociedad B", "la_liga2")).toBe("Real Sociedad II");
    expect(canonicalizeTeamName("Andorra CF", "la_liga2")).toBe("FC Andorra");
  });

  it("League Two: Bristol Rvs typo from shots-model", () => {
    expect(canonicalizeTeamName("Bristol Rvs", "league_two")).toBe("Bristol Rovers");
  });

  it("Ligue 2: Saint Etienne aliases", () => {
    expect(canonicalizeTeamName("St Etienne", "ligue_2")).toBe("Saint Etienne");
    expect(canonicalizeTeamName("AS Saint-Etienne", "ligue_2")).toBe("Saint Etienne");
  });

  it("Primeira Liga: short FootyStats vs long FC suffix", () => {
    expect(canonicalizeTeamName("Moreirense", "primeira_liga")).toBe("Moreirense FC");
    expect(canonicalizeTeamName("Rio Ave", "primeira_liga")).toBe("Rio Ave FC");
    expect(canonicalizeTeamName("Braga", "primeira_liga")).toBe("SC Braga");
  });

  it("Serie B: Bari with year suffix", () => {
    expect(canonicalizeTeamName("Bari", "serie_b")).toBe("Bari 1908");
  });

  it("Idempotent: canonical name resolves to itself", () => {
    expect(canonicalizeTeamName("FC Bayern München", "bundesliga")).toBe("FC Bayern München");
    expect(canonicalizeTeamName("Hertha BSC", "bundesliga2")).toBe("Hertha BSC");
    expect(canonicalizeTeamName("Stade Brest", "ligue_1")).toBe("Stade Brest");
  });

  it("Unknown teams: pass through unchanged (no canonical known)", () => {
    expect(canonicalizeTeamName("Some Brand New Team", "bundesliga")).toBe("Some Brand New Team");
    expect(canonicalizeTeamName("Test", "test_league")).toBe("Test");
  });

  it("Empty/falsy inputs return unchanged", () => {
    expect(canonicalizeTeamName("", "bundesliga")).toBe("");
    expect(canonicalizeTeamName("Bayern", "")).toBe("Bayern");
  });

  it("Cross-league: same name in different leagues resolves per-league", () => {
    // Hertha BSC is canonical in bundesliga2 (current). In bundesliga (Top-5
    // registry), it's also canonical. Both should resolve correctly.
    expect(canonicalizeTeamName("Hertha", "bundesliga2")).toBe("Hertha BSC");
    expect(canonicalizeTeamName("Hertha Berlin", "bundesliga2")).toBe("Hertha BSC");
  });
});

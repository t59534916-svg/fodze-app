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

  it("2026-05-29 sync: 5 aliases that were missing TS-side (JS had 27, TS had 22)", () => {
    // Regression guard for the EXTRA_ALIASES JS↔TS desync fixed 2026-05-29.
    // These five entries existed in scripts/_lib/canonical-team.mjs but were
    // absent from team-resolver.ts, so the engine read-side under-canonicalized
    // them (tier-1 miss → fuzzy fallback or silent drift).
    expect(canonicalizeTeamName("OFI Crete", "greek_sl")).toBe("OFI Kreta");
    expect(canonicalizeTeamName("Milton Keynes Dons", "league_two")).toBe("MK Dons");
    expect(canonicalizeTeamName("Rennes", "ligue_1")).toBe("Stade Rennes");
    expect(canonicalizeTeamName("Sporting Lisbon", "primeira_liga")).toBe("Sporting CP");
    expect(canonicalizeTeamName("Sporting Lissabon", "primeira_liga")).toBe("Sporting CP");
    expect(canonicalizeTeamName("WSG Tirol", "austria_bl")).toBe("Wattens");
  });

  it("2026-05-31 rollover fix: DB-verified source-fragmented teams merge to JSON canonical", () => {
    // These had 2-3 spellings in team_xg_history (one per ingest source) that
    // the read-side did NOT merge → engine read partial xG history. Canonical
    // target = the matchday-JSON spelling (read-path + bets consistent).
    expect(canonicalizeTeamName("SG Dynamo Dresden", "bundesliga2")).toBe("Dynamo Dresden");
    expect(canonicalizeTeamName("Dresden", "bundesliga2")).toBe("Dynamo Dresden");
    expect(canonicalizeTeamName("Bochum", "bundesliga2")).toBe("VfL Bochum");
    expect(canonicalizeTeamName("VfL Bochum 1848", "bundesliga2")).toBe("VfL Bochum");
    expect(canonicalizeTeamName("Darmstadt", "bundesliga2")).toBe("SV Darmstadt 98");
    expect(canonicalizeTeamName("Schalke 04", "bundesliga2")).toBe("FC Schalke 04");
    expect(canonicalizeTeamName("Basel", "swiss_sl")).toBe("FC Basel");
    expect(canonicalizeTeamName("Servette FC", "swiss_sl")).toBe("Servette");
    expect(canonicalizeTeamName("Valladolid", "la_liga2")).toBe("Real Valladolid CF");
    expect(canonicalizeTeamName("UD Las Palmas", "la_liga2")).toBe("Las Palmas");
    expect(canonicalizeTeamName("Falkirk", "scottish_prem")).toBe("Falkirk F.C.");
    expect(canonicalizeTeamName("Konyaspor", "super_lig")).toBe("Torku Konyaspor");
    expect(canonicalizeTeamName("SK Rapid Wien", "austria_bl")).toBe("Rapid Wien");
    expect(canonicalizeTeamName("Atromitos", "greek_sl")).toBe("Atromitos Athens");
  });

  it("Cross-league: same name in different leagues resolves per-league", () => {
    // Hertha BSC is canonical in bundesliga2 (current). In bundesliga (Top-5
    // registry), it's also canonical. Both should resolve correctly.
    expect(canonicalizeTeamName("Hertha", "bundesliga2")).toBe("Hertha BSC");
    expect(canonicalizeTeamName("Hertha Berlin", "bundesliga2")).toBe("Hertha BSC");
  });
});

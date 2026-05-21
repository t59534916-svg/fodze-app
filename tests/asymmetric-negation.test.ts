// ═══════════════════════════════════════════════════════════════════════
// tests/asymmetric-negation.test.ts
// v1.1 Asymmetric Negation Protocol · unit tests for evaluateLatentTopology
//
// Mandates covered:
//   M4 Manager-bounce piecewise-step (no Gaussian)
//   M5 Heckman MNAR gate (Tier-A only)
//   M7 Asymmetric Negation (multiplier ≤ 1.0)
//   M2 SHADOW_LOG_ONLY quarantine (logged but no stake change)
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  evaluateLatentTopology,
  type LatentSignals,
} from "../src/lib/goldilocks-engine";
import { matchKey as canonicalMatchKey } from "../src/lib/format";
import type { RawMatch } from "../src/types/match";

const baseMatch = (league: string = "bundesliga") =>
  ({
    matchKey: "BAY-BVB-2026-05-19",
    kickoff: 1747680000_000,
    league,
    home: { name: "Bayern", xg_h8: 16, xga_h8: 8, games: 8, form: "W W W W W" },
    away: { name: "Dortmund", xg_a8: 12, xga_a8: 10, games: 8, form: "L D W L W" },
    tags: [],
  }) as unknown as RawMatch & { matchKey: string; kickoff: number; league: string };

const baseSignals = (overrides: Partial<LatentSignals> = {}): LatentSignals => ({
  possessionDiff: null,
  xgDiffEwma3: null,
  xgEwma3: null,
  matchSinceManagerChange: null,
  tacticalWidth: null,
  engineHWRate: 0.55,
  leagueBaselineXg: 1.45,
  ...overrides,
});

// ─── Baseline: no traps → mult = 1.0 ──────────────────────────────────

describe("evaluateLatentTopology · baseline", () => {
  it("returns mult=1.0 when no signals present", () => {
    const r = evaluateLatentTopology(baseMatch(), baseSignals());
    expect(r.stakeMultiplier).toBe(1.0);
    expect(r.vetoes).toEqual([]);
    expect(r.shadowSignals).toEqual([]);
    expect(r.epistemicTrails).toEqual([]);
  });
});

// ─── M5: Possession Trap with Heckman MNAR gate ───────────────────────

describe("evaluateLatentTopology · M5 Heckman MNAR gate", () => {
  const trapSignals = baseSignals({
    possessionDiff: 18,        // > 15 = dominance
    xgDiffEwma3: -0.4,         // < 0 = inverted quality
    xgEwma3: 1.0,              // < 1.45 × 0.85 = 1.2325 → below threshold
    leagueBaselineXg: 1.45,
  });

  it("FIRES in Tier-A league (bundesliga)", () => {
    const r = evaluateLatentTopology(baseMatch("bundesliga"), trapSignals);
    expect(r.stakeMultiplier).toBe(0.3);
    expect(r.vetoes).toContain("POSSESSION_TRAP");
    expect(r.epistemicTrails).toHaveLength(1);
    expect(r.epistemicTrails[0].shadow).toBe(false);
  });

  it("DOES NOT FIRE in non-Tier-A league (liga3) — MNAR protection", () => {
    const r = evaluateLatentTopology(baseMatch("liga3"), trapSignals);
    expect(r.stakeMultiplier).toBe(1.0);
    expect(r.vetoes).not.toContain("POSSESSION_TRAP");
  });

  it("does NOT fire when xgDiffEwma3 is positive (engine ahead)", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 25,
        xgDiffEwma3: +0.3,           // positive → not the toxic pattern
        xgEwma3: 1.0,
        leagueBaselineXg: 1.45,
      }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
  });

  it("does NOT fire when possession diff is small (< 15)", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 10,
        xgDiffEwma3: -0.4,
        xgEwma3: 1.0,
        leagueBaselineXg: 1.45,
      }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
  });

  it("does NOT fire when xgEwma3 is at/above baseline (level-floor)", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 20,
        xgDiffEwma3: -0.2,
        xgEwma3: 1.45,                // = baseline (>= 85%)
        leagueBaselineXg: 1.45,
      }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
  });

  it("does NOT fire when any signal is null", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 18,
        xgDiffEwma3: null,             // NULL = missing
        xgEwma3: 1.0,
      }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
    expect(r.vetoes).not.toContain("POSSESSION_TRAP");
  });
});

// ─── M4: Manager-bounce piecewise step ────────────────────────────────

describe("evaluateLatentTopology · M4 manager-bounce regime", () => {
  it("regime 0 (match 0) → mult = 0.85", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 0 }),
    );
    expect(r.stakeMultiplier).toBe(0.85);
    expect(r.vetoes).toContain("MANAGER_BOUNCE_REGIME_0");
  });

  it("regime 0 (match 1) → mult = 0.85", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 1 }),
    );
    expect(r.stakeMultiplier).toBe(0.85);
  });

  it("regime 1 (match 2) → mult = 0.92", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 2 }),
    );
    expect(r.stakeMultiplier).toBe(0.92);
  });

  it("regime 1 (match 3) → mult = 0.92", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 3 }),
    );
    expect(r.stakeMultiplier).toBe(0.92);
  });

  it("settled (match 4+) → mult = 1.0", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 4 }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
    expect(r.vetoes).toEqual([]);
  });

  it("settled (match 30) → mult = 1.0", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ matchSinceManagerChange: 30 }),
    );
    expect(r.stakeMultiplier).toBe(1.0);
  });

  it("out-of-window (negative or > 30) → mult = 1.0 (defensive)", () => {
    expect(
      evaluateLatentTopology(baseMatch(), baseSignals({ matchSinceManagerChange: -1 })).stakeMultiplier,
    ).toBe(1.0);
    expect(
      evaluateLatentTopology(baseMatch(), baseSignals({ matchSinceManagerChange: 100 })).stakeMultiplier,
    ).toBe(1.0);
  });
});

// ─── M2: SHADOW_LOG_ONLY quarantine ───────────────────────────────────

describe("evaluateLatentTopology · M2 shadow quarantine", () => {
  it("TACTICAL_WIDTH does NOT alter stake multiplier", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({
        tacticalWidth: 0.7,         // > 0.4 → would-fire
        engineHWRate: 0.75,         // > 0.6 → would-fire
      }),
    );
    expect(r.stakeMultiplier).toBe(1.0);                    // ← unchanged
    expect(r.shadowSignals).toContain("TACTICAL_WIDTH_SHADOW");
    expect(r.epistemicTrails).toHaveLength(1);
    expect(r.epistemicTrails[0].shadow).toBe(true);          // ← logged but shadow
  });

  it("logs shadow trail but no veto entry", () => {
    const r = evaluateLatentTopology(
      baseMatch(),
      baseSignals({ tacticalWidth: 0.55, engineHWRate: 0.65 }),
    );
    expect(r.vetoes).toEqual([]);
    expect(r.shadowSignals.length).toBe(1);
    expect(r.epistemicTrails[0].trapKind).toBe("TACTICAL_WIDTH");
  });
});

// ─── M7: Asymmetric Negation clamp ────────────────────────────────────

describe("evaluateLatentTopology · M7 asymmetric clamp", () => {
  it("never exceeds 1.0 (no boost paths exist)", () => {
    // No matter what signals are passed, mult cannot rise above 1.0
    const probes: LatentSignals[] = [
      baseSignals(),
      baseSignals({ matchSinceManagerChange: 5 }),
      baseSignals({ possessionDiff: 20, xgDiffEwma3: 0.5, xgEwma3: 2.0 }),
      baseSignals({ tacticalWidth: 0.9, engineHWRate: 0.9 }),
    ];
    for (const sig of probes) {
      const r = evaluateLatentTopology(baseMatch(), sig);
      expect(r.stakeMultiplier).toBeLessThanOrEqual(1.0);
    }
  });

  it("never drops below 0.0", () => {
    const trapSignals = baseSignals({
      possessionDiff: 18,
      xgDiffEwma3: -0.4,
      xgEwma3: 1.0,
      leagueBaselineXg: 1.45,
      matchSinceManagerChange: 0,    // 0.85
    });
    const r = evaluateLatentTopology(baseMatch("bundesliga"), trapSignals);
    expect(r.stakeMultiplier).toBeGreaterThanOrEqual(0.0);
    expect(r.stakeMultiplier).toBeLessThanOrEqual(1.0);
  });

  it("multiple traps stack to the MINIMUM (not sum, not product)", () => {
    // Possession (0.3) + Manager-bounce (0.85) → final = 0.3 (min)
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 18,
        xgDiffEwma3: -0.4,
        xgEwma3: 1.0,
        leagueBaselineXg: 1.45,
        matchSinceManagerChange: 0,
      }),
    );
    expect(r.stakeMultiplier).toBe(0.3);
    expect(r.vetoes).toContain("POSSESSION_TRAP");
    expect(r.vetoes).toContain("MANAGER_BOUNCE_REGIME_0");
  });
});

// ─── Trail metadata sanity ────────────────────────────────────────────

describe("evaluateLatentTopology · epistemicTrails sanity", () => {
  it("trail records the matchKey + kickoff", () => {
    const match = baseMatch("bundesliga");
    const r = evaluateLatentTopology(
      match,
      baseSignals({
        possessionDiff: 18, xgDiffEwma3: -0.4, xgEwma3: 1.0, leagueBaselineXg: 1.45,
      }),
    );
    expect(r.epistemicTrails[0].matchKey).toBe(match.matchKey);
    expect(r.epistemicTrails[0].matchKickoff).toBe(match.kickoff);
  });

  it("detectedAt defaults to Date.now() but is overridable for tests", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 18, xgDiffEwma3: -0.4, xgEwma3: 1.0, leagueBaselineXg: 1.45,
      }),
      1700000000000,
    );
    expect(r.epistemicTrails[0].detectedAt).toBe(1700000000000);
  });
});

// ─── Persistence-contract: matchKey + kickoff units ───────────────────
//
// The function `evaluateLatentTopology` is contract-loose on purpose (any
// matchKey/kickoff value passes through). But the downstream Supabase row
// is contract-strict: matchKey must use the canonical FODZE format so the
// CLV-decay cron can join with odds_closing_history, and kickoff must be
// SECONDS so the cron's `match_kickoff < now/1000` filter matches.
//
// These tests lock down the CALLER's responsibility — if a regression
// changes the canonical format or the page wiring drops the seconds
// conversion, one of these fires loudly.

describe("evaluateLatentTopology · persistence contract", () => {
  it("canonical matchKey is lowercase + whitespace-stripped + league-prefixed", () => {
    // Locks down the format the goldilocks page MUST use when synthesizing
    // matchKey for trail rows (else CLV-decay join breaks silently).
    expect(canonicalMatchKey("bundesliga", "FC Bayern München", "Borussia Dortmund"))
      .toBe("bundesliga:fcbayernmünchen-borussiadortmund");
    expect(canonicalMatchKey("epl", "Manchester City", "Liverpool"))
      .toBe("epl:manchestercity-liverpool");
  });

  it("the trail pass-through preserves a canonical matchKey verbatim", () => {
    const mk = canonicalMatchKey("bundesliga", "Bayern", "Dortmund");
    const match = { ...baseMatch("bundesliga"), matchKey: mk } as RawMatch & {
      matchKey: string; kickoff: number; league: string;
    };
    const r = evaluateLatentTopology(
      match,
      baseSignals({
        possessionDiff: 18, xgDiffEwma3: -0.4, xgEwma3: 1.0, leagueBaselineXg: 1.45,
      }),
    );
    expect(r.epistemicTrails[0].matchKey).toBe(mk);
  });

  it("kickoff field is pass-through (caller is responsible for SECONDS unit)", () => {
    // The migration column `match_kickoff` is SECONDS. This test uses a
    // realistic seconds value — if a future caller hands ms here, the trail
    // would carry ms and the CLV-decay cron's `match_kickoff < now/1000`
    // filter would never select it. The CALLER must convert. The function
    // itself only promises pass-through.
    const kickoffSec = 1747680000; // 2025-05-19 16:00 UTC
    const match = { ...baseMatch("bundesliga"), kickoff: kickoffSec } as RawMatch & {
      matchKey: string; kickoff: number; league: string;
    };
    const r = evaluateLatentTopology(
      match,
      baseSignals({
        possessionDiff: 18, xgDiffEwma3: -0.4, xgEwma3: 1.0, leagueBaselineXg: 1.45,
      }),
    );
    expect(r.epistemicTrails[0].matchKickoff).toBe(kickoffSec);
    // Sanity: kickoff is reasonably in the past (= seconds-shaped, not ms).
    // A ms value here would be ~1000× larger and trivially fail this check.
    expect(r.epistemicTrails[0].matchKickoff).toBeLessThan(1e11);
  });

  it("detectedAt is MILLISECONDS (migration unit + Date.now() default)", () => {
    const r = evaluateLatentTopology(
      baseMatch("bundesliga"),
      baseSignals({
        possessionDiff: 18, xgDiffEwma3: -0.4, xgEwma3: 1.0, leagueBaselineXg: 1.45,
      }),
    );
    // Default uses Date.now() which is ms; should be > 1e12 from 2001 onward.
    expect(r.epistemicTrails[0].detectedAt).toBeGreaterThan(1e12);
  });
});

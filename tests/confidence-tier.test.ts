import { describe, it, expect } from "vitest";
import { confidenceTier, type ConfTierKey } from "@/lib/confidence-tier";

// Single source of truth for the confidence-badge (MatchDetail full badge +
// MatchCard compact pill). These tests lock the BOUNDARIES and the calibrated
// HIT-RATE CLAIMS so a future edit to one badge can't silently drift the
// numbers — the values are validated against the production Benter-blended
// path (validate_confidence_production_path.py, 2026-05-28).

describe("confidenceTier — boundaries", () => {
  it("≥0.65 → HOCH (inclusive on the boundary)", () => {
    expect(confidenceTier(0.65).key).toBe("HOCH");
    expect(confidenceTier(0.72).key).toBe("HOCH");
    expect(confidenceTier(1.0).key).toBe("HOCH");
  });

  it("[0.55, 0.65) → MITTEL", () => {
    expect(confidenceTier(0.55).key).toBe("MITTEL");
    expect(confidenceTier(0.6499).key).toBe("MITTEL");
    expect(confidenceTier(0.6499999).key).toBe("MITTEL");
  });

  it("[0.45, 0.55) → NIEDRIG", () => {
    expect(confidenceTier(0.45).key).toBe("NIEDRIG");
    expect(confidenceTier(0.5499).key).toBe("NIEDRIG");
  });

  it("<0.45 → TOSS_UP", () => {
    expect(confidenceTier(0.4499).key).toBe("TOSS_UP");
    expect(confidenceTier(0.34).key).toBe("TOSS_UP");
    expect(confidenceTier(0).key).toBe("TOSS_UP");
  });

  it("the four boundary points land in the higher tier (>= semantics)", () => {
    // exact boundary values belong to the tier they open
    expect(confidenceTier(0.65).key).toBe("HOCH");
    expect(confidenceTier(0.55).key).toBe("MITTEL");
    expect(confidenceTier(0.45).key).toBe("NIEDRIG");
  });
});

describe("confidenceTier — calibrated claims (drift-lock)", () => {
  const claims: Record<ConfTierKey, number> = {
    HOCH: 0.73, MITTEL: 0.53, NIEDRIG: 0.48, TOSS_UP: 0.40,
  };
  it("claim per tier matches the validated production-path floors", () => {
    expect(confidenceTier(0.80).claim).toBe(claims.HOCH);
    expect(confidenceTier(0.60).claim).toBe(claims.MITTEL);
    expect(confidenceTier(0.50).claim).toBe(claims.NIEDRIG);
    expect(confidenceTier(0.30).claim).toBe(claims.TOSS_UP);
  });

  it("claims are weakly monotone decreasing as confidence drops", () => {
    const order = [0.80, 0.60, 0.50, 0.30].map((p) => confidenceTier(p).claim);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeLessThan(order[i - 1]);
    }
  });

  it("only HOCH claims clearly above coin-flip; the rest sit near/below 0.53", () => {
    expect(confidenceTier(0.80).claim).toBeGreaterThanOrEqual(0.70);
    expect(confidenceTier(0.60).claim).toBeLessThanOrEqual(0.55);
    expect(confidenceTier(0.50).claim).toBeLessThanOrEqual(0.50);
  });
});

describe("confidenceTier — display fields", () => {
  it("labels are human-facing; TOSS_UP renders with a hyphen not underscore", () => {
    expect(confidenceTier(0.80).label).toBe("HOCH");
    expect(confidenceTier(0.60).label).toBe("MITTEL");
    expect(confidenceTier(0.50).label).toBe("NIEDRIG");
    expect(confidenceTier(0.30).label).toBe("TOSS-UP");
  });

  it("hist phrases carry the per-tier hit-rate hint", () => {
    expect(confidenceTier(0.80).hist).toContain("73%");
    expect(confidenceTier(0.60).hist).toContain("53%");
    expect(confidenceTier(0.50).hist).toContain("48%");
    expect(confidenceTier(0.30).hist).toContain("40%");
  });

  it("returns a stable, non-empty key/label/hist for every tier", () => {
    for (const p of [0.9, 0.6, 0.5, 0.2]) {
      const t = confidenceTier(p);
      expect(t.key.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.hist.length).toBeGreaterThan(0);
      expect(t.claim).toBeGreaterThan(0);
      expect(t.claim).toBeLessThanOrEqual(1);
    }
  });
});

describe("confidenceTier — NaN safety", () => {
  it("NaN falls through every >= comparison to TOSS_UP (degenerate but defined)", () => {
    expect(confidenceTier(NaN).key).toBe("TOSS_UP");
  });
});

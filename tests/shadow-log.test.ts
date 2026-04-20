import { describe, it, expect } from "vitest";
import {
  ShadowLogPredictionSchema,
  ShadowLogBatchSchema,
  SHADOW_LOG_ENGINE_VARIANTS,
} from "@/lib/schemas";

const validPrediction = {
  match_key: "epl:mancity-arsenal",
  league: "epl",
  home_team: "Man City",
  away_team: "Arsenal",
  kickoff: "2026-04-25T19:30:00.000Z",
  engine_variant: "ensemble" as const,
  prob_h: 0.5,
  prob_d: 0.25,
  prob_a: 0.25,
  prob_o25: 0.6,
  feature_version: "v1",
};

describe("ShadowLogPredictionSchema", () => {
  it("accepts a complete valid prediction", () => {
    const r = ShadowLogPredictionSchema.safeParse(validPrediction);
    expect(r.success).toBe(true);
  });

  it("enforces prob sum ≈ 1 (rejects when drifting > 0.05)", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      prob_h: 0.9,
      prob_d: 0.2,
      prob_a: 0.5,
    });
    expect(r.success).toBe(false);
  });

  it("accepts prob sum within tolerance (0.33 each)", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      prob_h: 0.33,
      prob_d: 0.33,
      prob_a: 0.33,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown engine_variant", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      engine_variant: "v3-new",
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative probabilities", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      prob_h: -0.1,
      prob_d: 0.6,
      prob_a: 0.5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects probabilities above 1", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      prob_h: 1.5,
      prob_d: 0,
      prob_a: -0.5,
    });
    expect(r.success).toBe(false);
  });

  it("accepts null kickoff and null prob_o25", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      kickoff: null,
      prob_o25: null,
    });
    expect(r.success).toBe(true);
  });

  it("applies feature_version default when omitted", () => {
    const { feature_version: _fv, ...withoutVersion } = validPrediction;
    void _fv;
    const r = ShadowLogPredictionSchema.safeParse(withoutVersion);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.feature_version).toBe("v1");
  });

  it("rejects empty match_key", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      match_key: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-ISO kickoff", () => {
    const r = ShadowLogPredictionSchema.safeParse({
      ...validPrediction,
      kickoff: "19:30",
    });
    expect(r.success).toBe(false);
  });

  it("covers all 4 declared engine variants", () => {
    for (const v of SHADOW_LOG_ENGINE_VARIANTS) {
      const r = ShadowLogPredictionSchema.safeParse({
        ...validPrediction,
        engine_variant: v,
      });
      expect(r.success, `should accept variant ${v}`).toBe(true);
    }
  });
});

describe("ShadowLogBatchSchema", () => {
  const minimalPrediction = {
    match_key: "epl:mancity-arsenal",
    league: "epl",
    home_team: "Man City",
    away_team: "Arsenal",
    engine_variant: "ensemble" as const,
    prob_h: 0.5,
    prob_d: 0.25,
    prob_a: 0.25,
  };

  it("accepts a batch of 200 predictions", () => {
    const predictions = Array.from({ length: 200 }, () => ({ ...minimalPrediction }));
    const r = ShadowLogBatchSchema.safeParse({ predictions });
    expect(r.success).toBe(true);
  });

  it("rejects a batch of 201 predictions", () => {
    const predictions = Array.from({ length: 201 }, () => ({ ...minimalPrediction }));
    const r = ShadowLogBatchSchema.safeParse({ predictions });
    expect(r.success).toBe(false);
  });

  it("rejects an empty batch", () => {
    const r = ShadowLogBatchSchema.safeParse({ predictions: [] });
    expect(r.success).toBe(false);
  });

  it("rejects missing predictions field", () => {
    const r = ShadowLogBatchSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

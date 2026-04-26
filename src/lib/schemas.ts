// ═══════════════════════════════════════════════════════════════════════
// FODZE Runtime Schemas — Zod Validation at Data Boundaries
//
// TypeScript schützt zur Compile-Time. Zod schützt zur Runtime.
// Validierung passiert an den Grenzen: Supabase → App, JSON Import → App
// ═══════════════════════════════════════════════════════════════════════

import { z } from "zod";

// ─── xG History Entry ────────────────────────────────────────────────

export const XGHistoryEntrySchema = z.object({
  xg: z.number().min(0).max(10),
  xga: z.number().min(0).max(10),
  date: z.string().optional(),
  result: z.string().optional(),
  opponent: z.string().optional(),
});

// ─── Team Data ───────────────────────────────────────────────────────
// KRITISCH: xG-Werte sind SUMMEN über 8 Spiele (5-25), NICHT Durchschnitte (0.8-2.5)!
// Zod fängt ab wenn ein Scraper/AI versehentlich Durchschnitte liefert.

const xgSumField = z.union([
  z.number().min(0).max(40),
  z.string().transform(v => {           // Akzeptiert auch Strings ("14.2") → parsed zu Number
    const n = parseFloat(v);
    if (isNaN(n)) throw new Error(`Ungültige xG-Zahl: "${v}"`);
    return n;
  }),
]).optional();

export const TeamDataSchema = z.object({
  name: z.string().min(1, "Teamname darf nicht leer sein"),
  xg_h8: xgSumField,
  xga_h8: xgSumField,
  xg_a8: xgSumField,
  xga_a8: xgSumField,
  games: z.number().min(1).max(38).optional().default(8),
  form: z.string().optional(),
  injuries: z.string().optional(),
  yellow_risk: z.string().optional(),
  notes: z.string().optional(),
  xg_h_history: z.array(XGHistoryEntrySchema).optional(),
  xg_a_history: z.array(XGHistoryEntrySchema).optional(),
}).passthrough();  // Erlaubt zusätzliche Felder ohne Fehler

// ─── Top Scorer ──────────────────────────────────────────────────────

export const TopScorerSchema = z.object({
  name: z.string().min(1),
  team: z.enum(["H", "A"]),
  prob: z.number().min(0).max(1),
});

// ─── Raw Match ───────────────────────────────────────────────────────

export const RawMatchSchema = z.object({
  home: TeamDataSchema,
  away: TeamDataSchema,
  tags: z.array(z.string()).optional().default([]),
  context: z.string().optional(),
  referee: z.string().optional(),
  kickoff: z.string().optional(),
  top_scorers: z.array(TopScorerSchema).optional(),
}).passthrough();

// ─── Matchday Data ───────────────────────────────────────────────────

export const MatchdayDataSchema = z.object({
  league: z.string().min(1),
  matchday: z.string().min(1),
  date: z.string().optional(),
  matches: z.array(RawMatchSchema).min(1, "Mindestens 1 Spiel erforderlich"),
  data_confidence: z.enum(["HIGH", "MEDIUM", "LOW", "MANUAL"]).optional(),
  sources: z.array(z.string()).optional(),
});

// ─── Anna Chat Request ───────────────────────────────────────────────
// Limits mirror the constants in /api/anna/route.ts; keeping them here
// so route.ts can parse once and drop all the manual typeof guards.

export const ANNA_LIMITS = {
  MAX_SYSTEM_PROMPT_CHARS: 20_000,
  MAX_TOTAL_MESSAGES_CHARS: 40_000,
  MAX_MESSAGE_CHARS: 10_000,
  MAX_MESSAGE_COUNT: 30,
} as const;

export const AnnaMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(ANNA_LIMITS.MAX_MESSAGE_CHARS,
    `Single message too long (max ${ANNA_LIMITS.MAX_MESSAGE_CHARS} chars)`),
}).passthrough();

export const AnnaChatRequestSchema = z.object({
  messages: z.array(AnnaMessageSchema)
    .max(ANNA_LIMITS.MAX_MESSAGE_COUNT, `Too many messages (max ${ANNA_LIMITS.MAX_MESSAGE_COUNT})`),
  systemPrompt: z.string()
    .max(ANNA_LIMITS.MAX_SYSTEM_PROMPT_CHARS,
      `systemPrompt too long (max ${ANNA_LIMITS.MAX_SYSTEM_PROMPT_CHARS} chars)`),
}).refine(
  (d) => d.messages.reduce((s, m) => s + m.content.length, 0) <= ANNA_LIMITS.MAX_TOTAL_MESSAGES_CHARS,
  { message: `Combined messages too long (max ${ANNA_LIMITS.MAX_TOTAL_MESSAGES_CHARS} chars)` },
);

export type AnnaChatRequest = z.infer<typeof AnnaChatRequestSchema>;
export type AnnaMessage = z.infer<typeof AnnaMessageSchema>;

// ─── Pipeline Shadow-Log ─────────────────────────────────────────────
// Batched engine predictions posted from MatchdayContext after all
// engines finish. Table-level UNIQUE(match_key, engine_variant,
// predicted_date) makes the upsert idempotent; this schema bounds
// payload size so a compromised client can't flood the table.

export const SHADOW_LOG_ENGINE_VARIANTS = [
  "ensemble",
  "poisson-ml",
  "poisson-ml-v2",
  // v3 added 2026-04-26 — preview engine, but its independent predictions
  // are captured here for retrospective Brier comparison vs v2_dirichlet.
  "poisson-ml-v3",
  "footbayes-hierarchical",
] as const;

export const ShadowLogPredictionSchema = z.object({
  match_key: z.string().min(1).max(256),
  league: z.string().min(1).max(64),
  home_team: z.string().min(1).max(128),
  away_team: z.string().min(1).max(128),
  kickoff: z.string().datetime().nullable().optional(),
  engine_variant: z.enum(SHADOW_LOG_ENGINE_VARIANTS),
  prob_h: z.number().min(0).max(1),
  prob_d: z.number().min(0).max(1),
  prob_a: z.number().min(0).max(1),
  prob_o25: z.number().min(0).max(1).nullable().optional(),
  feature_version: z.string().min(1).max(32).default("v1"),
}).refine(
  (p) => Math.abs(p.prob_h + p.prob_d + p.prob_a - 1) < 0.05,
  { message: "prob_h+prob_d+prob_a must sum to ~1.0 (±0.05)" },
);

export const ShadowLogBatchSchema = z.object({
  predictions: z.array(ShadowLogPredictionSchema).min(1).max(200),
});

export type ShadowLogPrediction = z.infer<typeof ShadowLogPredictionSchema>;
export type ShadowLogBatch = z.infer<typeof ShadowLogBatchSchema>;

// ─── Validation Helpers ──────────────────────────────────────────────

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
  warnings?: string[];
}

/**
 * Validate matchday JSON with plausibility checks.
 * Returns parsed data + warnings for suspicious values.
 */
export function validateMatchdayJSON(input: unknown): ValidationResult<z.infer<typeof MatchdayDataSchema>> {
  const result = MatchdayDataSchema.safeParse(input);

  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
    };
  }

  // Plausibility warnings (not errors — data may still be usable)
  const warnings: string[] = [];
  const data = result.data;

  for (let i = 0; i < data.matches.length; i++) {
    const m = data.matches[i];
    const prefix = `matches[${i}]`;

    // xG Summen-Check: Werte < 4.0 sind verdächtig (wahrscheinlich Durchschnitte)
    if (m.home.xg_h8 !== undefined && m.home.xg_h8 < 4.0) {
      warnings.push(`${prefix}.home.xg_h8 = ${m.home.xg_h8} — zu niedrig! Durchschnitt statt Summe?`);
    }
    if (m.away.xg_a8 !== undefined && m.away.xg_a8 < 4.0) {
      warnings.push(`${prefix}.away.xg_a8 = ${m.away.xg_a8} — zu niedrig! Durchschnitt statt Summe?`);
    }

    // xGA-Check
    if (m.home.xga_h8 !== undefined && m.home.xga_h8 < 3.0) {
      warnings.push(`${prefix}.home.xga_h8 = ${m.home.xga_h8} — verdächtig niedrig`);
    }
    if (m.away.xga_a8 !== undefined && m.away.xga_a8 < 3.0) {
      warnings.push(`${prefix}.away.xga_a8 = ${m.away.xga_a8} — verdächtig niedrig`);
    }

    // Referee-Format Check (soll Dezimalzahl enthalten)
    if (m.referee && !m.referee.match(/\d+[.,]\d+/)) {
      warnings.push(`${prefix}.referee "${m.referee}" — Karten-Schnitt fehlt (erwartet "Name, Ø X.X Karten/Spiel")`);
    }

    // Top Scorers Plausibilität
    if (m.top_scorers) {
      for (const ts of m.top_scorers) {
        if (ts.prob > 0.5) {
          warnings.push(`${prefix}.top_scorers "${ts.name}" prob=${ts.prob} — über 50% ist unplausibel`);
        }
      }
    }

    // Teamname leer?
    if (!m.home.name.trim()) warnings.push(`${prefix}.home.name ist leer`);
    if (!m.away.name.trim()) warnings.push(`${prefix}.away.name ist leer`);
  }

  return { success: true, data, warnings: warnings.length > 0 ? warnings : undefined };
}

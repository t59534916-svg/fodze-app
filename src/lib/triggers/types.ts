// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/types.ts — Shared trigger types
//
// TriggerResult is the contract between detectors (pure functions over
// match-data) and UI rendering. Parts is a structured token stream so
// the UI can apply consistent styling without parsing text.
// ═══════════════════════════════════════════════════════════════════════

export type TriggerPart =
  | { kind: "text"; value: string }
  | { kind: "highlight"; value: string }  // gold
  | { kind: "warn"; value: string }        // red/warn
  | { kind: "sub"; value: string };        // muted block under main line

export type TriggerType = "xg_market" | "coaching_change" | "streak_pattern";

export interface TriggerResult {
  type: TriggerType;
  /** 0-1, used for ordering when multiple triggers fire. */
  severity: number;
  parts: TriggerPart[];
  /** Raw values for L2 audit drill-down (UI doesn't render this directly). */
  data: Record<string, unknown>;
}

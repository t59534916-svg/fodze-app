// ═══════════════════════════════════════════════════════════════════════
// src/lib/epistemic-trails.ts
// v1.1 Asymmetric Negation · persistence helper for EpistemicTrail records.
//
// Idempotent via UNIQUE (trap_kind, match_key, detected_at) — caller can
// re-emit the same trail on page-refresh without polluting the table.
//
// SAFE-FAIL: any network error is swallowed (logged in dev, silent in
// production). Persistence is observability, not correctness — never let
// a Supabase hiccup break the user's matchday load.
// ═══════════════════════════════════════════════════════════════════════

import type { EpistemicTrail } from "./goldilocks-engine";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// Persisting trails requires INSERT permission. Server-side code can use the
// service key; on the client, RLS would block the write (anon = SELECT only).
// We bypass the client write entirely — see persistEpistemicTrails() guard.
const SUPA_SVC = process.env.SUPABASE_SERVICE_KEY ?? "";

interface TrailInsertRow {
  trap_kind: string;
  /** Canonical FODZE matchKey — see EpistemicTrail.matchKey for the contract. */
  match_key: string;
  /** Unix epoch SECONDS — see EpistemicTrail.matchKickoff for why. */
  match_kickoff: number;
  league: string | null;
  /** Unix epoch MILLISECONDS — see EpistemicTrail.detectedAt. */
  detected_at: number;
  /** Numeric-only by design — must match EpistemicTrail.rawSignals contract.
   *  Looser `Record<string, unknown>` was the pre-review type and is no longer
   *  accepted: burn-in's `predicted_hw_rate_sum += ...` would NaN on a string. */
  raw_signals: Record<string, number>;
  /** Probability in [0, 1] — CHECKed at the DB level via
   *  `epistemic_trails_predicted_hw_rate_range`. */
  predicted_hw_rate: number;
  shadow: boolean;
}

function trailToRow(
  t: EpistemicTrail,
  matchKey: string,
  league: string | null,
): TrailInsertRow {
  return {
    trap_kind: t.trapKind,
    match_key: matchKey,
    match_kickoff: t.matchKickoff,
    league,
    detected_at: t.detectedAt,
    raw_signals: t.rawSignals,
    predicted_hw_rate: t.predictedHWRate,
    shadow: t.shadow,
  };
}

/**
 * Persist a batch of EpistemicTrails to Supabase. Idempotent via UNIQUE.
 *
 * Server-side ONLY — checks for the service-role key and skips otherwise.
 * (Client-side anon writes are blocked by RLS; trying would produce 401s.)
 *
 * Never throws — observability layer, not a correctness gate.
 */
export async function persistEpistemicTrails(
  trails: EpistemicTrail[],
  matchKey: string,
  league: string | null,
): Promise<{ inserted: boolean; reason?: string }> {
  if (trails.length === 0) return { inserted: false, reason: "empty" };
  if (!SUPA_URL || !SUPA_SVC) {
    return { inserted: false, reason: "missing-server-keys" };
  }

  const rows = trails.map((t) => trailToRow(t, matchKey, league));

  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/epistemic_trails?on_conflict=trap_kind,match_key,detected_at`,
      {
        method: "POST",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(rows),
      },
    );
    if (!r.ok) {
      if (process.env.NODE_ENV !== "production") {
        const txt = await r.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.warn(
          `[epistemic-trails] insert ${r.status}: ${txt.slice(0, 200)}`,
        );
      }
      return { inserted: false, reason: `http-${r.status}` };
    }
    return { inserted: true };
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(`[epistemic-trails] network error:`, e);
    }
    return { inserted: false, reason: "network" };
  }
}

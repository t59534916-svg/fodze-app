// ═══════════════════════════════════════════════════════════════════════
// /api/persist-trails — server-side proxy for epistemic-trail persistence
// v1.1 Asymmetric Negation Protocol · M8 storage gateway
//
// The client (e.g. /goldilocks/page.tsx) computes `evaluateLatentTopology`
// for every visible match and POSTs the resulting trails here. We forward
// to `persistEpistemicTrails`, which requires SUPABASE_SERVICE_KEY (only
// available server-side — RLS blocks anon INSERTs by design).
//
// Body shape:
//   { batches: Array<{ matchKey: string; league: string|null; trails: EpistemicTrail[] }> }
//
// Returns a per-batch result list. Never throws on individual failures —
// persistence is observability, not a correctness gate.
// ═══════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import {
  persistEpistemicTrails,
} from "@/lib/epistemic-trails";
import type { EpistemicTrail } from "@/lib/goldilocks-engine";

interface Batch {
  matchKey: string;
  league: string | null;
  trails: EpistemicTrail[];
}

// Hard caps — defensive against malformed clients. The goldilocks page only
// ever sends a few hundred matches at most.
const MAX_BATCHES = 2000;
const MAX_TRAILS_PER_BATCH = 16;

export async function POST(req: NextRequest) {
  let body: { batches?: Batch[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const batches = Array.isArray(body.batches) ? body.batches : null;
  if (!batches) {
    return NextResponse.json({ error: "missing-batches-array" }, { status: 400 });
  }
  if (batches.length > MAX_BATCHES) {
    return NextResponse.json(
      { error: `too-many-batches (max ${MAX_BATCHES})` },
      { status: 413 },
    );
  }

  const results: Array<{ matchKey: string; inserted: boolean; reason?: string }> = [];
  let totalTrails = 0;

  for (const b of batches) {
    if (
      typeof b?.matchKey !== "string" ||
      !Array.isArray(b?.trails) ||
      b.trails.length === 0 ||
      b.trails.length > MAX_TRAILS_PER_BATCH
    ) {
      results.push({ matchKey: String(b?.matchKey ?? ""), inserted: false, reason: "invalid-batch" });
      continue;
    }
    totalTrails += b.trails.length;
    const out = await persistEpistemicTrails(b.trails, b.matchKey, b.league ?? null);
    results.push({ matchKey: b.matchKey, ...out });
  }

  return NextResponse.json({
    batches_total: batches.length,
    trails_total: totalTrails,
    results,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { ShadowLogBatchSchema } from "@/lib/schemas";

// ═══════════════════════════════════════════════════════════════════
// FODZE — Pipeline Shadow-Log
// POST /api/shadow-log
//
// Client-side hook in MatchdayContext batches engine predictions and
// posts them here whenever all engines finish computing for a matchday.
// Idempotency lives at 3 levels:
//   1. Client sessionStorage (no re-post within same page-session)
//   2. This route (service_role upsert with ignoreDuplicates)
//   3. DB UNIQUE(match_key, engine_variant, predicted_date)
// Failures are logged but never propagated — a broken shadow-log must
// never break the prediction UI.
// ═══════════════════════════════════════════════════════════════════

// Cheap burst allowance — each POST is one batched upsert, not an LLM
// call. 60/min/user covers admin browsing across all 19 leagues with
// comfortable headroom for hot-reloads during dev.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_BUCKET = "shadow-log";

export async function POST(req: NextRequest) {
  // ── Auth via cookie session (matches /api/anna pattern) ──
  const cookieStore = await cookies();
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Rate-limit via shared Postgres RPC ──
  const { data: rateData, error: rateErr } = await authClient.rpc(
    "check_and_increment_rate_limit",
    {
      p_user_id: user.id,
      p_bucket: RATE_LIMIT_BUCKET,
      p_max: RATE_LIMIT_MAX,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    },
  );
  if (!rateErr) {
    const row = Array.isArray(rateData) ? rateData[0] : rateData;
    if (row && row.allowed === false) {
      const resetMs = row.reset_at
        ? new Date(row.reset_at).getTime() - Date.now()
        : RATE_LIMIT_WINDOW_SECONDS * 1000;
      return NextResponse.json(
        { error: `Rate limit exceeded (max ${RATE_LIMIT_MAX}/min)` },
        {
          status: 429,
          headers: { "Retry-After": String(Math.max(1, Math.ceil(resetMs / 1000))) },
        },
      );
    }
  }
  // RPC unavailable (fresh DB, missing fn, etc.) → fail-open, same as /api/anna.

  // ── Body validation ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ShadowLogBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  // ── Service-role client (bypass RLS for inserts) ──
  // Support multiple legacy env-var names that existing scripts use
  // (seed-matchday.mjs uses FODZE_SERVICE_KEY, scrape-referees.mjs uses
  // SUPABASE_SERVICE_ROLE_KEY). First non-empty wins.
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.FODZE_SERVICE_KEY;
  if (!serviceKey) {
    console.warn("[FODZE] shadow-log: no SERVICE_ROLE key configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const rows = parsed.data.predictions.map((p) => ({
    match_key: p.match_key,
    league: p.league,
    home_team: p.home_team,
    away_team: p.away_team,
    kickoff: p.kickoff ?? null,
    engine_variant: p.engine_variant,
    prob_h: p.prob_h,
    prob_d: p.prob_d,
    prob_a: p.prob_a,
    prob_o25: p.prob_o25 ?? null,
    feature_version: p.feature_version,
    created_by: user.id,
  }));

  const { error } = await svc
    .from("pipeline_shadow_log")
    .upsert(rows, {
      onConflict: "match_key,engine_variant,predicted_date",
      ignoreDuplicates: true,
    });
  if (error) {
    console.warn("[FODZE] shadow-log insert failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ logged: rows.length });
}

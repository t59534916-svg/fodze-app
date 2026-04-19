import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { AnnaChatRequestSchema, type AnnaMessage } from "@/lib/schemas";

// Priority: GROQ_API_KEY (free) → CLAUDE_API_KEY (paid) → error
// Groq: Free, fast (Llama 3.3 70B) — https://console.groq.com
// Claude: Paid but higher quality — https://console.anthropic.com

// Size limits live in lib/schemas.ts (ANNA_LIMITS) — single source of
// truth that the Zod schema enforces. Rate-limit is separate.

// Rate-limit: 20 requests/minute per user. Enforced by Postgres via the
// `check_and_increment_rate_limit` RPC (see migration-rate-limits.sql),
// so the limit holds across all Vercel worker instances instead of
// fragmenting per-worker like the previous in-memory Map did.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_BUCKET = "anna";

async function checkRateLimit(supabase: SupabaseClient, userId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
    p_user_id: userId,
    p_bucket: RATE_LIMIT_BUCKET,
    p_max: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (error) {
    // Fail-open on DB blips — better to serve a legitimate request than
    // lock out every user when the rate-limit table is unreachable.
    // The previous in-memory Map had the same failure semantics (a
    // worker restart zeroed every counter). Log so persistent issues
    // show up in Vercel logs.
    console.warn("[FODZE] rate_limit RPC failed, failing open:", error.message);
    return { allowed: true };
  }
  // RPC returns a single-row TABLE — supabase-js gives us an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { allowed: true };
  if (row.allowed) return { allowed: true };
  const resetMs = row.reset_at ? new Date(row.reset_at).getTime() - Date.now() : RATE_LIMIT_WINDOW_SECONDS * 1000;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)) };
}

// ─── Auth guard ────────────────────────────────────────────────────

async function getSessionOrUnauthorized(): Promise<{ supabase: SupabaseClient; userId: string } | Response> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return { supabase, userId: user.id };
}

export async function POST(req: NextRequest) {
  const session = await getSessionOrUnauthorized();
  if (session instanceof Response) return session;
  const { supabase, userId } = session;

  const rate = await checkRateLimit(supabase, userId);
  if (!rate.allowed) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests/minute.` }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rate.retryAfterSeconds ?? RATE_LIMIT_WINDOW_SECONDS),
        },
      },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsed = AnnaChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Surface the first issue — keeps error responses short; full detail
    // goes to server logs for postmortem if a bug request starts failing.
    const first = parsed.error.issues[0];
    return new Response(
      JSON.stringify({ error: first?.message || "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const { messages, systemPrompt } = parsed.data;

  const groqKey = process.env.GROQ_API_KEY;
  const claudeKey = process.env.CLAUDE_API_KEY;

  if (groqKey) return streamGroq(groqKey, messages, systemPrompt);
  if (claudeKey) return streamClaude(claudeKey, messages, systemPrompt);

  return new Response(JSON.stringify({ error: "NO_KEY", offline: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── Groq (Free: Llama 3.3 70B) ─────────────────────────────────────

async function streamGroq(apiKey: string, messages: AnnaMessage[], systemPrompt: string) {
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 4000,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
    }

    // Groq returns OpenAI-compatible SSE — transform to Anthropic format for frontend
    const transform = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const json = JSON.parse(raw);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              // Convert to Anthropic SSE format
              controller.enqueue(new TextEncoder().encode(
                `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`
              ));
            }
          } catch (err) {
            // Rare: a partial SSE chunk lands here when Groq splits a JSON
            // object across TCP frames. Dropping it is fine (next chunk
            // contains the rest), but log so a real format change doesn't
            // silently eat every delta.
            console.warn("[FODZE] anna SSE parse skipped:", (err as Error).message);
          }
        }
      },
    });

    return new Response(resp.body!.pipeThrough(transform), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// ─── Claude (Paid) ───────────────────────────────────────────────────

async function streamClaude(apiKey: string, messages: AnnaMessage[], systemPrompt: string) {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        stream: true,
        system: systemPrompt,
        messages,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
    }

    return new Response(resp.body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// Check which API is configured — no auth gate (public status indicator)
export async function GET() {
  return new Response(JSON.stringify({
    hasGroq: !!process.env.GROQ_API_KEY,
    hasClaude: !!process.env.CLAUDE_API_KEY,
    provider: process.env.GROQ_API_KEY ? "groq" : process.env.CLAUDE_API_KEY ? "claude" : "offline",
  }), { headers: { "Content-Type": "application/json" } });
}

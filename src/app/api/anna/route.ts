import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Priority: GROQ_API_KEY (free) → CLAUDE_API_KEY (paid) → error
// Groq: Free, fast (Llama 3.3 70B) — https://console.groq.com
// Claude: Paid but higher quality — https://console.anthropic.com

// ─── Limits (defense against LLM-credit drain) ─────────────────────
// The endpoint was previously unauthenticated + unlimited. An attacker
// with the URL could drain Groq free tier or run up Anthropic bills
// by hammering POST /api/anna. These limits + cookie auth close that.
const MAX_SYSTEM_PROMPT_CHARS = 20_000; // ~5k tokens, plenty for context
const MAX_TOTAL_MESSAGES_CHARS = 40_000; // ~10k tokens across history
const MAX_MESSAGE_CHARS = 10_000; // per-message cap — prevents a single
                                  // message from consuming the whole budget
const MAX_MESSAGE_COUNT = 30; // no runaway back-and-forth

// Simple in-memory rate-limit (per Next.js worker). Not a proper defense
// against distributed abuse — that would need Upstash or similar — but
// catches casual script-kiddies and accidental loops.
const rateLimit = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20; // 20 requests/min per user

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const bucket = rateLimit.get(userId);
  if (!bucket || bucket.resetAt < now) {
    rateLimit.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

// ─── Auth guard ────────────────────────────────────────────────────

async function getUserIdOrUnauthorized(): Promise<string | Response> {
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
  return user.id;
}

export async function POST(req: NextRequest) {
  const userIdOrError = await getUserIdOrUnauthorized();
  if (userIdOrError instanceof Response) return userIdOrError;
  const userId = userIdOrError;

  if (!checkRateLimit(userId)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Max 20 requests/minute." }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const { messages, systemPrompt } = body as { messages?: unknown; systemPrompt?: unknown };

  // Validate shapes — reject anything that would pass garbage to the LLM
  if (!Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ error: "messages must be an array" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (typeof systemPrompt !== "string") {
    return new Response(
      JSON.stringify({ error: "systemPrompt must be a string" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (messages.length > MAX_MESSAGE_COUNT) {
    return new Response(
      JSON.stringify({ error: `Too many messages (max ${MAX_MESSAGE_COUNT})` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return new Response(
      JSON.stringify({ error: `systemPrompt too long (max ${MAX_SYSTEM_PROMPT_CHARS} chars)` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  let totalChars = 0;
  for (const m of messages) {
    if (typeof m !== "object" || !m || !("content" in m)) continue;
    const c = (m as { content: unknown }).content;
    if (typeof c !== "string") continue;
    if (c.length > MAX_MESSAGE_CHARS) {
      // Per-message cap closes a loophole where a single 40k message was
      // valid under the combined total but still flooded the LLM budget.
      return new Response(
        JSON.stringify({ error: `Single message too long (max ${MAX_MESSAGE_CHARS} chars)` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    totalChars += c.length;
  }
  if (totalChars > MAX_TOTAL_MESSAGES_CHARS) {
    return new Response(
      JSON.stringify({ error: `Combined messages too long (max ${MAX_TOTAL_MESSAGES_CHARS} chars)` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const groqKey = process.env.GROQ_API_KEY;
  const claudeKey = process.env.CLAUDE_API_KEY;

  if (groqKey) return streamGroq(groqKey, messages as any[], systemPrompt);
  if (claudeKey) return streamClaude(claudeKey, messages as any[], systemPrompt);

  return new Response(JSON.stringify({ error: "NO_KEY", offline: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── Groq (Free: Llama 3.3 70B) ─────────────────────────────────────

async function streamGroq(apiKey: string, messages: any[], systemPrompt: string) {
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
          } catch {}
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

async function streamClaude(apiKey: string, messages: any[], systemPrompt: string) {
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

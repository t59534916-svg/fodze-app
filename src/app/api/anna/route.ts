import { NextRequest } from "next/server";

// Priority: GROQ_API_KEY (free) → CLAUDE_API_KEY (paid) → error
// Groq: Free, fast (Llama 3.3 70B) — https://console.groq.com
// Claude: Paid but higher quality — https://console.anthropic.com

export async function POST(req: NextRequest) {
  const { messages, systemPrompt } = await req.json();

  const groqKey = process.env.GROQ_API_KEY;
  const claudeKey = process.env.CLAUDE_API_KEY;

  // Try Groq first (free)
  if (groqKey) {
    return streamGroq(groqKey, messages, systemPrompt);
  }

  // Fall back to Claude (paid)
  if (claudeKey) {
    return streamClaude(claudeKey, messages, systemPrompt);
  }

  // No API key — return offline signal
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

// Check which API is configured
export async function GET() {
  return new Response(JSON.stringify({
    hasGroq: !!process.env.GROQ_API_KEY,
    hasClaude: !!process.env.CLAUDE_API_KEY,
    provider: process.env.GROQ_API_KEY ? "groq" : process.env.CLAUDE_API_KEY ? "claude" : "offline",
  }), { headers: { "Content-Type": "application/json" } });
}

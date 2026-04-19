import { describe, it, expect } from "vitest";
import { AnnaChatRequestSchema, ANNA_LIMITS } from "@/lib/schemas";

// The /api/anna route is public-facing and costs money every time it
// gets hit (Groq free tier + Anthropic credits). The Zod schema is the
// only thing between a malformed/hostile body and the LLM — if it goes
// wrong we silently burn the quota. Every limit here must stay tight.

describe("AnnaChatRequestSchema", () => {
  const validMessage = { role: "user" as const, content: "Was ist der Value-Bet in der 2. Liga?" };

  it("accepts a minimal valid request", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [validMessage],
      systemPrompt: "You are Anna, a betting analyst.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when messages is missing", () => {
    const result = AnnaChatRequestSchema.safeParse({
      systemPrompt: "You are Anna.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when messages is not an array", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: "hello",
      systemPrompt: "You are Anna.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when a message role is unknown", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [{ role: "hacker", content: "hi" }],
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when systemPrompt is missing", () => {
    const result = AnnaChatRequestSchema.safeParse({ messages: [validMessage] });
    expect(result.success).toBe(false);
  });

  it("rejects when systemPrompt is not a string", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [validMessage],
      systemPrompt: { injected: "prompt" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects message count above the cap", () => {
    const overLimit = Array.from({ length: ANNA_LIMITS.MAX_MESSAGE_COUNT + 1 }, () => validMessage);
    const result = AnnaChatRequestSchema.safeParse({
      messages: overLimit,
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a single message over MAX_MESSAGE_CHARS", () => {
    const huge = "x".repeat(ANNA_LIMITS.MAX_MESSAGE_CHARS + 1);
    const result = AnnaChatRequestSchema.safeParse({
      messages: [{ role: "user", content: huge }],
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects combined messages over MAX_TOTAL_MESSAGES_CHARS even when each is under the single-message cap", () => {
    // 5 messages × 9000 chars = 45,000 > 40,000 cap, each under 10,000.
    const chunk = "x".repeat(9_000);
    const result = AnnaChatRequestSchema.safeParse({
      messages: Array.from({ length: 5 }, () => ({ role: "user", content: chunk })),
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects systemPrompt over MAX_SYSTEM_PROMPT_CHARS", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [validMessage],
      systemPrompt: "x".repeat(ANNA_LIMITS.MAX_SYSTEM_PROMPT_CHARS + 1),
    });
    expect(result.success).toBe(false);
  });

  it("accepts extra fields on messages (passthrough) so new SDK versions don't break old clients", () => {
    // `passthrough()` on the message schema means future fields from the
    // Anthropic SDK (like `cache_control` tokens) won't make a request
    // fail validation just because our schema predates them.
    const result = AnnaChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
      systemPrompt: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts assistant and system roles (conversation history)", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "A" },
        { role: "system", content: "note" },
      ],
      systemPrompt: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects messages with non-string content", () => {
    const result = AnnaChatRequestSchema.safeParse({
      messages: [{ role: "user", content: { parts: ["hi"] } }],
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero messages — the client may send just a system prompt", () => {
    // Arguable design choice; today the schema only enforces the upper
    // bound. If we add a min(1) later, update this test to match.
    const result = AnnaChatRequestSchema.safeParse({
      messages: [],
      systemPrompt: "hi",
    });
    expect(result.success).toBe(true);
  });
});

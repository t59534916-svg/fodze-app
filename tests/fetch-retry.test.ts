// Tests for scripts/_lib/fetch-retry.mjs — the dependency-free resilient
// fetch helper (Task 3, 2026-05-28). Mocks global fetch to exercise the
// retry/backoff/Retry-After logic without real network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// .mjs script helper — resolved via allowJs + JSDoc (same as bridge tests).
import { fetchWithRetry, withRetry, parseRetryAfter } from "../scripts/_lib/fetch-retry.mjs";

function mockResp(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => `body-${status}`,
    json: async () => ({ status }),
  } as unknown as Response;
}

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("parses HTTP-date (future → positive ms)", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it("returns null for garbage / empty", () => {
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter(null as unknown as string)).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("returns immediately on 200 (no retry)", async () => {
    const f = vi.fn().mockResolvedValue(mockResp(200));
    vi.stubGlobal("fetch", f);
    const p = fetchWithRetry("http://x", {}, { retries: 3, baseMs: 1 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 404 (non-retryable 4xx)", async () => {
    const f = vi.fn().mockResolvedValue(mockResp(404));
    vi.stubGlobal("fetch", f);
    const p = fetchWithRetry("http://x", {}, { retries: 3, baseMs: 1 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 503 then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(mockResp(503))
      .mockResolvedValueOnce(mockResp(503))
      .mockResolvedValueOnce(mockResp(200));
    vi.stubGlobal("fetch", f);
    const p = fetchWithRetry("http://x", {}, { retries: 4, baseMs: 1 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("returns the last 503 after exhausting retries (no throw on HTTP)", async () => {
    const f = vi.fn().mockResolvedValue(mockResp(503));
    vi.stubGlobal("fetch", f);
    const p = fetchWithRetry("http://x", {}, { retries: 2, baseMs: 1 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects retryableStatus override (429 excluded → no retry)", async () => {
    const f = vi.fn().mockResolvedValue(mockResp(429));
    vi.stubGlobal("fetch", f);
    // odds-api pattern: only 502/503/504 retry, 429 handled by caller rotation
    const p = fetchWithRetry("http://x", {}, {
      retries: 3, baseMs: 1, retryableStatus: [502, 503, 504],
    });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1); // NOT retried
  });

  it("retries network error then succeeds", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND db.supabase.co"))
      .mockResolvedValueOnce(mockResp(200));
    vi.stubGlobal("fetch", f);
    const p = fetchWithRetry("http://x", {}, { retries: 3, baseMs: 1 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws non-retryable error immediately", async () => {
    // Lazy-throw (async impl) so the rejection is created per-call, not
    // eagerly — avoids vitest's PromiseRejectionHandled warning. Immediate
    // throw means no timer advance needed.
    const f = vi.fn().mockImplementation(async () => { throw new Error("TLS cert invalid"); });
    vi.stubGlobal("fetch", f);
    await expect(
      fetchWithRetry("http://x", {}, { retries: 3, baseMs: 1 }),
    ).rejects.toThrow("TLS cert invalid");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry (generic async)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries a throwing fn on network-pattern error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    const p = withRetry(fn, { retries: 3, baseMs: 1 });
    await vi.runAllTimersAsync();
    expect(await p).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors custom shouldRetry predicate", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce("ok");
    const p = withRetry(fn, {
      retries: 2, baseMs: 1, shouldRetry: (e) => /rate limited/.test(String((e as Error).message)),
    });
    await vi.runAllTimersAsync();
    expect(await p).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

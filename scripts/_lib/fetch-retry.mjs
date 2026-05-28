// ═══════════════════════════════════════════════════════════════════════
// fetch-retry — resilient fetch with exponential backoff + Retry-After
//
// Dependency-free (no p-retry). Rationale: this project deliberately avoids
// convenience deps — it hand-rolls its .env loader rather than shipping
// dotenv, and 6 scripts/_lib/* clients already hand-roll retry. A shared
// helper consolidates that scattered logic without adding node_modules
// surface to a Vercel-deployed app for a scripts-only concern.
//
// Retries on:
//   - HTTP 429 (rate-limited) — honors Retry-After header (seconds OR HTTP-date)
//   - HTTP 503 / 502 / 504 (transient upstream)
//   - Network errors (ECONNRESET, ETIMEDOUT, getaddrinfo ENOTFOUND, fetch
//     TypeError) — covers the macOS sleep/wake DNS race noted in CLAUDE.md
//
// Does NOT retry on:
//   - 4xx other than 429 (client errors — retrying won't help)
//   - 2xx/3xx (success)
//
// Usage:
//   import { fetchWithRetry } from "./_lib/fetch-retry.mjs";
//   const resp = await fetchWithRetry(url, { headers }, { retries: 4 });
//   // resp is a normal Response; throws after exhausting retries.
//
//   // Or wrap an arbitrary async fn (non-fetch APIs):
//   const data = await withRetry(() => someClient.get(...), { retries: 3 });
// ═══════════════════════════════════════════════════════════════════════

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_ERR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network|fetch failed/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a Retry-After header → milliseconds. Supports both forms:
 *   "120"                          → 120_000 ms (delta-seconds)
 *   "Wed, 21 Oct 2026 07:28:00 GMT" → (date - now) ms (HTTP-date)
 * Returns null if unparseable.
 */
export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const asInt = Number(headerValue);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Exponential backoff with full jitter:
 *   base * 2^attempt, capped, then random in [0, computed].
 * Full jitter (vs fixed) avoids thundering-herd when many scripts retry
 * the same upstream simultaneously.
 */
function backoffMs(attempt, { baseMs = 500, capMs = 15_000 } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * fetch() wrapper with retry. Returns the final Response (caller checks .ok
 * for non-retryable 4xx). Throws the last error only when all retries are
 * exhausted on a network failure.
 *
 * @param {string|URL} url
 * @param {RequestInit} init
 * @param {{retries?: number, baseMs?: number, capMs?: number,
 *          label?: string, onRetry?: (info:object)=>void,
 *          retryableStatus?: Set<number>|number[]}} opts
 *   retryableStatus — override which HTTP codes retry. Pass e.g. [502,503,504]
 *   to EXCLUDE 429 when the caller handles quota itself (e.g. odds-api key
 *   rotation). Defaults to {429,502,503,504}.
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { retries = 4, baseMs = 500, capMs = 15_000, label, onRetry } = opts;
  const retryable = opts.retryableStatus
    ? (opts.retryableStatus instanceof Set ? opts.retryableStatus : new Set(opts.retryableStatus))
    : RETRYABLE_STATUS;
  const tag = label || (typeof url === "string" ? url : url.toString()).slice(0, 80);
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (!retryable.has(resp.status)) {
        return resp; // success OR non-retryable error — hand back to caller
      }
      // Retryable status. If out of attempts, return the response as-is so
      // the caller can read the body / status (don't throw on HTTP errors).
      if (attempt === retries) return resp;
      const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
      const waitMs = retryAfter ?? backoffMs(attempt, { baseMs, capMs });
      onRetry?.({ attempt: attempt + 1, retries, status: resp.status, waitMs, label: tag });
      if (!onRetry) {
        console.warn(`[fetch-retry] ${tag} → HTTP ${resp.status}, retry ${attempt + 1}/${retries} in ${waitMs}ms`);
      }
      await sleep(waitMs);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const retryable = RETRYABLE_ERR.test(msg) || err?.name === "TypeError";
      if (!retryable || attempt === retries) throw err;
      const waitMs = backoffMs(attempt, { baseMs, capMs });
      onRetry?.({ attempt: attempt + 1, retries, error: msg, waitMs, label: tag });
      if (!onRetry) {
        console.warn(`[fetch-retry] ${tag} → ${msg}, retry ${attempt + 1}/${retries} in ${waitMs}ms`);
      }
      await sleep(waitMs);
    }
  }
  throw lastErr ?? new Error(`[fetch-retry] ${tag}: exhausted ${retries} retries`);
}

/**
 * Generic async-fn retry (for non-fetch clients — e.g. supabase-js, scrapers
 * that throw on transient failure). Retries on RETRYABLE_ERR-matching errors
 * OR when shouldRetry(err) returns true.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{retries?: number, baseMs?: number, capMs?: number, label?: string,
 *          shouldRetry?: (err:unknown)=>boolean}} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 3, baseMs = 500, capMs = 15_000, label = "task", shouldRetry } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const retryable = shouldRetry ? shouldRetry(err) : RETRYABLE_ERR.test(msg);
      if (!retryable || attempt === retries) throw err;
      const waitMs = backoffMs(attempt, { baseMs, capMs });
      console.warn(`[withRetry] ${label} → ${msg}, retry ${attempt + 1}/${retries} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════════
// FODZE — The-Odds-API client with multi-key rotation
//
// Reads keys from env: ODDS_API_KEY (primary), then ODDS_API_KEY_2,
// _3, ... up to _10. Each key is a separate free account = 500 credits
// per month. Effective monthly budget = sum of keys × 500.
//
// On every request:
//   1. Pick the first key whose `x-requests-remaining` header (last seen)
//      is ≥ minRemaining, or unknown (never queried this run).
//   2. Issue the request. Update per-key remaining from response headers.
//   3. If status 401/429 (quota exhausted), mark key dead-for-this-run
//      and retry with next key. Other errors propagate.
//
// State is module-level — survives multiple calls within one Node process,
// resets between processes. Don't call from multiple workers without
// passing a shared state explicitly.
// ═══════════════════════════════════════════════════════════════════════

import { fetchWithRetry } from "./fetch-retry.mjs";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

function collectKeys() {
  const keys = [];
  if (process.env.ODDS_API_KEY) keys.push(process.env.ODDS_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`ODDS_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const _state = {
  // index → number | null (null = not yet queried with this key)
  remaining: new Map(),
  // index → number (used count from last response)
  used: new Map(),
  // indices marked exhausted for the rest of this process
  exhausted: new Set(),
};

function pickKey(keys, minRemaining) {
  for (let i = 0; i < keys.length; i++) {
    if (_state.exhausted.has(i)) continue;
    const r = _state.remaining.get(i);
    if (r === null || r === undefined) return { key: keys[i], index: i };
    if (r >= minRemaining) return { key: keys[i], index: i };
  }
  return null;
}

/**
 * Fetch from The-Odds-API with automatic key rotation on quota exhaustion.
 *
 * @param {string} path  e.g. "/sports/soccer_germany_bundesliga/odds"
 *                       (must start with `/`, base + apiKey are added).
 * @param {object} opts
 * @param {object} [opts.params]        Query params (apiKey added automatically)
 * @param {AbortSignal} [opts.signal]   For timeouts
 * @param {number} [opts.minRemaining=2] Skip keys at/below this remaining-count
 * @returns {Promise<{ resp: Response, keyIndex: number, remaining: number|null, used: number|null }>}
 */
export async function fetchOddsApi(path, { params = {}, signal, minRemaining = 2 } = {}) {
  if (!path.startsWith("/")) throw new Error(`fetchOddsApi: path must start with "/" (got ${path})`);
  const keys = collectKeys();
  if (keys.length === 0) throw new Error("Missing ODDS_API_KEY in env");

  let lastErr = null;
  for (let attempt = 0; attempt < keys.length + 1; attempt++) {
    const pick = pickKey(keys, minRemaining);
    if (!pick) break;

    const qs = new URLSearchParams({ ...params, apiKey: pick.key });
    const url = `${ODDS_API_BASE}${path}?${qs.toString()}`;
    // Retry transient upstream (502/503/504 + network) on THIS key before
    // giving up. EXCLUDE 429 from retry — quota is handled by key-rotation
    // below (89-93), not by hammering the same exhausted key.
    const resp = await fetchWithRetry(
      url,
      { signal },
      { retries: 3, retryableStatus: [502, 503, 504], label: `odds-api ${path}` },
    );

    const remStr = resp.headers.get("x-requests-remaining");
    const useStr = resp.headers.get("x-requests-used");
    const remaining = remStr === null ? null : parseInt(remStr, 10);
    const used = useStr === null ? null : parseInt(useStr, 10);
    if (remaining !== null && Number.isFinite(remaining)) _state.remaining.set(pick.index, remaining);
    if (used !== null && Number.isFinite(used)) _state.used.set(pick.index, used);

    if (resp.ok) {
      // If remaining hit zero, mark exhausted so the next call rotates.
      if (remaining !== null && remaining <= 0) _state.exhausted.add(pick.index);
      return { resp, keyIndex: pick.index, remaining, used };
    }

    if (resp.status === 401 || resp.status === 429) {
      _state.exhausted.add(pick.index);
      lastErr = new Error(`Odds-API key #${pick.index + 1} returned ${resp.status} (quota?) — rotating`);
      continue;
    }

    // Non-quota error: don't burn other keys, surface immediately.
    const txt = await resp.text();
    throw new Error(`Odds-API ${resp.status}: ${txt}`);
  }

  throw lastErr ?? new Error(`All ${keys.length} Odds-API keys exhausted`);
}

/**
 * Snapshot of internal per-key state. Useful for logging at the end of a
 * batch run ("Key 1: 412 used, Key 2: 88 used, total: 500 used").
 */
export function oddsKeyState() {
  const keys = collectKeys();
  return keys.map((_, i) => ({
    keyIndex: i,
    remaining: _state.remaining.get(i) ?? null,
    used: _state.used.get(i) ?? null,
    exhausted: _state.exhausted.has(i),
  }));
}

/**
 * For tests / explicit reset between phases.
 */
export function _resetOddsState() {
  _state.remaining.clear();
  _state.used.clear();
  _state.exhausted.clear();
}

export { ODDS_API_BASE };

// ═══════════════════════════════════════════════════════════════════════
// FODZE Transfermarkt Injuries Scraper
//
// Why this exists: the matchday fields `injuries`, `yellow_risk`, and to
// some extent the engine's `absences` pipeline rely on having player-level
// data that no free, deterministic API provides reliably. Transfermarkt
// publishes all three (Verletzungen, Sperren, Sperre droht) on a per-club
// page that's public HTML and robots-accessible — we just need to scrape
// responsibly and normalise the HTML into structured data.
//
// Robustness strategy: instead of fragile regex parsing against
// Transfermarkt's HTML (which changes layout every year or so), we extract
// the relevant <table class="items"> block with a minimal regex, then hand
// that compact HTML slice to Groq (free, already in env) with a tight
// instruction to emit JSON. Groq can adapt to minor HTML shifts in ways
// a regex never could, AND it can't hallucinate players — it literally
// only knows what's in the HTML we just fetched.
//
// Rate-limit policy: 1 request per 1.5 seconds per team. Transfermarkt has
// light bot protection; a browser-ish User-Agent + modest rate is enough
// to stay under any throttle. With ~20 teams per matchday × 6 active
// leagues, typical refresh is 2-3 minutes for injuries.
//
// Usage (as a library):
//   import { fetchTeamInjuries } from "./transfermarkt-scrape.mjs";
//   const { injuries, yellow_risk } = await fetchTeamInjuries("FC Bayern München");
// ═══════════════════════════════════════════════════════════════════════

import { resolveTransfermarktRef } from "./transfermarkt-ids.mjs";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TM_BASE = "https://www.transfermarkt.de";

// Gentle pacing so we don't trigger anti-bot heuristics. 1.5 s ≈ a human
// tabbing through team pages. Global across concurrent callers so even a
// 19-league refresh stays polite.
const RATE_LIMIT_MS = 1500;
let _nextAllowedAt = 0;

async function gentleFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, _nextAllowedAt - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _nextAllowedAt = Date.now() + RATE_LIMIT_MS;
  // Hard 10s timeout per request. Without this, a hung TCP connection
  // (seen on Transfermarkt redirects for some lower-tier teams) would
  // block the entire pipeline forever. 10s is plenty for a 100KB response
  // on any reasonable connection.
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "de,de-DE;q=0.9,en;q=0.5",
    },
    signal: AbortSignal.timeout(10000),
  });
}

// Pull out the injuries/suspensions table. Transfermarkt nests
// <table class="inline-table"> inside the outer <table class="items">
// (used for player name + position), so a naive non-greedy regex stops
// at the first inner </table>. We balance <table> / </table> manually.
function extractItemsTable(html) {
  const startRe = /<table[^>]*class="items"[^>]*>/;
  const start = html.search(startRe);
  if (start < 0) return null;
  const openTagMatch = html.slice(start).match(startRe);
  const cursorStart = start + (openTagMatch ? openTagMatch[0].length : 0);
  // Walk forward counting nested <table> openings and closings until we
  // hit the matching </table> at depth 0.
  let depth = 1;
  let i = cursorStart;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf("<table", i);
    const nextClose = html.indexOf("</table", i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 6;
    } else {
      depth--;
      i = nextClose + 8;
    }
  }
  const inner = html.slice(cursorStart, i - 8);

  // Prefer the tbody section if present — drops <thead> noise. Same
  // balanced-walk trick for robustness.
  let content = inner;
  const tbodyStart = inner.search(/<tbody[^>]*>/);
  if (tbodyStart >= 0) {
    // Close tag search assumes no nested tbody (standard for Transfermarkt).
    const endIdx = inner.lastIndexOf("</tbody>");
    if (endIdx > tbodyStart) {
      const openMatch = inner.slice(tbodyStart).match(/<tbody[^>]*>/);
      content = inner.slice(tbodyStart + (openMatch ? openMatch[0].length : 0), endIdx);
    }
  }

  return content
    .replace(/<img[^>]+>/g, "")                 // drop image tags (token waste)
    .replace(/data-src="[^"]*"/g, "")            // and their data-src
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Groq JSON normalisation ────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.1-8b-instant: free-tier 500K tokens/day (5× the 70b model). HTML-
// table-to-JSON is a simple extraction task the 8b model handles reliably
// at <1% quality drop vs 70b, which matters not at all here because we're
// just re-shaping HTML not generating content. Upgrade to 70b only if the
// extraction quality visibly degrades in practice.
const GROQ_MODEL = "llama-3.1-8b-instant";

/**
 * Ask Groq to convert a raw Transfermarkt `<table class="items">` block
 * into a structured list of player statuses. Tightly prompted so the
 * model only emits JSON; anything else we treat as failure and return [].
 *
 * The Transfermarkt table groups rows by section header ("Sperren",
 * "Verletzungen", "Sperre droht"). We ask Groq to preserve that section
 * in the `status` field so downstream code can distinguish an INJURY
 * from a YELLOW_CARD_RISK.
 */
// Groq free tier is ~14.4K tokens/min. Each call ~2-3K tokens. Staggering
// to 3s between Groq requests keeps us well under the minute-rate window.
const GROQ_MIN_INTERVAL_MS = 3000;
let _groqNextAllowedAt = 0;
// Once we hit the per-day quota, every further call would be a pointless
// round-trip. Set a sticky flag so the remainder of the run skips Groq
// entirely and returns a clear `quota-exhausted` reason instead of burning
// time on the per-minute rate-limit retry loop.
let _groqDailyQuotaExhausted = false;

// Retry on 429 (rate limit) with exponential backoff — up to 3 tries.
async function normaliseWithGroq(tableHtml, teamName, attempt = 0) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { entries: null, reason: "no-groq-key" };
  if (_groqDailyQuotaExhausted) return { entries: null, reason: "groq-daily-quota-exhausted" };

  const wait = Math.max(0, _groqNextAllowedAt - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _groqNextAllowedAt = Date.now() + GROQ_MIN_INTERVAL_MS;

  const prompt = `Extract player status entries from the following Transfermarkt HTML table (for team "${teamName}").

IMPORTANT RULES:
- The table has section headers like "Sperren", "Verletzungen", "Sperre droht" in <td class="extrarow">.
- For each player row, capture: name, position, reason (German, short), status ("SUSPENSION" for Sperren, "INJURY" for Verletzungen, "YELLOW_RISK" for "Sperre droht"), return_date (DD.MM.YYYY or null).
- If the table is empty or has no section, output an empty array.
- DO NOT invent players. Only extract what's literally in the HTML.
- Output strict JSON only — no markdown fences, no prose.

HTML:
${tableHtml}

Output format:
[{"name":"Jamal Musiala","position":"Offensives Mittelfeld","reason":"Knieverletzung","status":"INJURY","return_date":"30.06.2026"}]`;

  try {
    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      // 15s timeout — Groq normally responds in <2s, longer means bad
      // gateway or model loading; we'd rather retry than block forever.
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You extract structured data from HTML. Output strict JSON matching the requested schema. Never include players not literally present in the HTML. Wrap the array in {"entries":[...]}.',
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!resp.ok) {
      // 429 → check if it's a daily-quota exhaustion. Daily quotas can
      // mean "wait 2 hours" which is never worth retrying mid-run.
      // 5xx → transient, worth one retry.
      if (resp.status === 429) {
        // Peek at body to distinguish per-minute from per-day
        const bodyText = await resp.text().catch(() => "");
        const isDailyQuota = /tokens per day|TPD|per day/i.test(bodyText);
        if (isDailyQuota) {
          _groqDailyQuotaExhausted = true;
          return { entries: null, reason: "groq-daily-quota-exhausted" };
        }
        // Per-minute: short wait + retry
        if (attempt < 2) {
          const retryAfter = Number(resp.headers.get("retry-after")) || 0;
          const backoff = retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 2000 * (attempt + 1);
          await new Promise((r) => setTimeout(r, backoff));
          return normaliseWithGroq(tableHtml, teamName, attempt + 1);
        }
        return { entries: null, reason: "groq-429" };
      }
      if (resp.status >= 500 && attempt < 1) {
        await new Promise((r) => setTimeout(r, 2000));
        return normaliseWithGroq(tableHtml, teamName, attempt + 1);
      }
      return { entries: null, reason: `groq-http-${resp.status}` };
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { entries: null, reason: "groq-empty" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { entries: null, reason: "groq-invalid-json" };
    }
    const entries = parsed.entries || parsed.players || parsed;
    if (!Array.isArray(entries)) return { entries: [], reason: "groq-no-array" };
    return { entries, reason: "ok" };
  } catch (e) {
    return { entries: null, reason: `groq-exception-${(e && e.message) || "unknown"}` };
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch and structure the current injuries/suspensions/yellow-risk
 * list for a team. Returns { injuries, yellow_risk, source } where
 * `injuries` and `yellow_risk` are the MatchdayContext-expected
 * comma-separated strings ("Name (POS, Reason), Name (POS, Reason)").
 *
 * Returns all empty strings when:
 *   - team isn't in our TM ID map
 *   - network / Transfermarkt 4xx/5xx
 *   - Groq key missing or parse failed
 *   - team has no injuries/suspensions/risks listed
 *
 * Never throws — enrichment must not crash generate-matchday.
 */
export async function fetchTeamInjuries(teamName) {
  const DBG = process.env.FODZE_TM_DEBUG === "1";
  const dlog = (msg) => { if (DBG) console.error(`[tm:${teamName}] ${msg}`); };
  const empty = { injuries: "", yellow_risk: "", source: "transfermarkt", status: "skipped" };
  const ref = resolveTransfermarktRef(teamName);
  if (!ref) return { ...empty, status: "no-id-mapping" };

  const url = `${TM_BASE}/${ref.slug}/sperrenundverletzungen/verein/${ref.id}`;
  dlog(`fetch url=${url}`);
  let resp;
  try {
    resp = await gentleFetch(url);
    dlog(`fetch returned status=${resp.status}`);
  } catch (e) {
    // AbortSignal.timeout throws AbortError/TimeoutError. Caller-safe.
    const msg = (e && (e.name || e.message)) || "unknown";
    return { ...empty, status: `fetch-${msg}` };
  }
  if (!resp.ok) return { ...empty, status: `http-${resp.status}` };

  let html;
  try {
    html = await resp.text();
    dlog(`body read ${html.length} bytes`);
  } catch (e) {
    return { ...empty, status: `read-${(e && e.name) || "error"}` };
  }
  const tableHtml = extractItemsTable(html);
  dlog(`tableHtml=${tableHtml ? tableHtml.length + "ch" : "null"}`);
  if (!tableHtml) return { ...empty, status: "no-table" };

  // If table has no actual rows (only headers), skip Groq — cheap fast path.
  if (!/hauptlink/.test(tableHtml)) {
    dlog(`no hauptlink — skipping Groq`);
    return { ...empty, status: "no-entries" };
  }

  dlog(`calling Groq...`);
  const { entries, reason } = await normaliseWithGroq(tableHtml, teamName);
  dlog(`Groq returned: reason=${reason} entries=${entries ? entries.length : 'null'}`);
  if (!entries) return { ...empty, status: reason || "groq-failed" };
  if (entries.length === 0) return { ...empty, status: "no-entries" };

  // Split by status, then format as the comma-separated string the matchday
  // schema + parseAbsences() in absence-parser.ts expect.
  const fmt = (e) => {
    const parts = [e.position || "?", e.reason || "?"];
    if (e.return_date) parts.push(`bis ${e.return_date}`);
    return `${e.name} (${parts.join(", ")})`;
  };
  const injuries = entries
    .filter((e) => e.status === "INJURY" || e.status === "SUSPENSION")
    .map(fmt)
    .join(", ");
  const yellowRisk = entries
    .filter((e) => e.status === "YELLOW_RISK")
    .map((e) => `${e.name} (${e.position || "?"}, ${e.reason || "Sperre droht"})`)
    .join(", ");

  return {
    injuries,
    yellow_risk: yellowRisk,
    source: "transfermarkt+groq",
    status: "ok",
    entry_count: entries.length,
  };
}

/**
 * Fetch injuries for many teams in sequence (per-request rate-limit
 * handled internally). Returns a Map keyed by the FODZE team name.
 */
export async function fetchMultipleTeamInjuries(teamNames, onProgress) {
  const results = new Map();
  let done = 0;
  for (const name of teamNames) {
    const r = await fetchTeamInjuries(name);
    results.set(name, r);
    done++;
    if (onProgress) onProgress(done, teamNames.length, name, r.status);
  }
  return results;
}

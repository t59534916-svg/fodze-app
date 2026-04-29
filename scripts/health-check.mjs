#!/usr/bin/env node
/**
 * FODZE Health Monitor
 * ═══════════════════
 * Pings all 5 external data sources + the Supabase DB and reports what's
 * alive. Use before kicking off a full refresh — if Groq or TM is down
 * you can skip that phase instead of waiting for the refresh to fail.
 *
 * Also surfaces quota / freshness signals that predict upcoming trouble:
 *   - The-Odds-API credits remaining (refresh ~= 38/run, 500/month free)
 *   - Groq daily-quota header (tests with 1-token ping)
 *   - Supabase live_odds freshness per league (> 12h = cron likely stuck)
 *
 * Usage:
 *   npm run health
 *   node scripts/health-check.mjs --json    # machine-readable
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { USER_AGENT as TM_USER_AGENT } from "./_lib/transfermarkt-scrape.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ─── Checks ────────────────────────────────────────────────────────

async function timed(fn) {
  const t0 = Date.now();
  try {
    const res = await fn();
    return { ...res, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, msg: e.message || String(e), ms: Date.now() - t0 };
  }
}

const checks = [
  {
    name: "Supabase DB",
    fn: () => timed(async () => {
      if (!SUPA_URL || !SUPA_KEY) return { ok: false, msg: "env keys missing" };
      const r = await fetch(`${SUPA_URL}/rest/v1/matchdays?select=id&limit=1`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      return { ok: r.ok, msg: r.ok ? "reachable" : `HTTP ${r.status}` };
    }),
  },
  {
    name: "The-Odds-API",
    fn: () => timed(async () => {
      // Probe each configured key with a free `/sports` call (0 credits)
      // so the health check reports per-key budget — useful when one key
      // is exhausted but a second is fresh.
      const keys = [process.env.ODDS_API_KEY, process.env.ODDS_API_KEY_2, process.env.ODDS_API_KEY_3]
        .filter(Boolean);
      if (keys.length === 0) return { ok: false, msg: "ODDS_API_KEY missing" };
      const perKey = [];
      for (let i = 0; i < keys.length; i++) {
        const r = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${keys[i]}`, {
          signal: AbortSignal.timeout(5000),
        });
        const remaining = parseInt(r.headers.get("x-requests-remaining") ?? "", 10);
        const used = parseInt(r.headers.get("x-requests-used") ?? "", 10);
        perKey.push({ ok: r.ok, status: r.status, remaining, used });
      }
      const totalRemaining = perKey.reduce((s, k) => s + (Number.isFinite(k.remaining) ? k.remaining : 0), 0);
      const anyOk = perKey.some((k) => k.ok);
      const summary = perKey
        .map((k, i) => k.ok ? `K${i + 1}=${k.remaining}` : `K${i + 1}=HTTP${k.status}`)
        .join(" · ");
      return {
        ok: anyOk && totalRemaining > 0,
        msg: `${totalRemaining} credits across ${keys.length} key${keys.length > 1 ? "s" : ""} (${summary})`,
        detail: { perKey, totalRemaining },
      };
    }),
  },
  {
    name: "OpenLigaDB",
    fn: () => timed(async () => {
      const r = await fetch("https://api.openligadb.de/getmatchdata/bl1/2025", {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
      const data = await r.json();
      return { ok: true, msg: `${data.length} BL matches this season` };
    }),
  },
  {
    name: "Transfermarkt",
    fn: () => timed(async () => {
      const r = await fetch("https://www.transfermarkt.de/fc-bayern-munchen/sperrenundverletzungen/verein/27", {
        headers: { "User-Agent": TM_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
      const html = await r.text();
      const hasItems = /<table[^>]*class="items"/.test(html);
      return {
        ok: hasItems,
        msg: hasItems ? `${Math.round(html.length / 1024)} KB, items table present` : "items table missing (layout change?)",
      };
    }),
  },
  {
    name: "Groq API",
    fn: () => timed(async () => {
      if (!GROQ_KEY) return { ok: false, msg: "GROQ_API_KEY missing" };
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 5,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      // Groq exposes quota in headers
      const tokRemaining = r.headers.get("x-ratelimit-remaining-tokens");
      const tokLimit = r.headers.get("x-ratelimit-limit-tokens");
      const reqRemaining = r.headers.get("x-ratelimit-remaining-requests");
      if (!r.ok) {
        const bodyText = await r.text();
        const isDaily = /tokens per day|TPD/i.test(bodyText);
        return {
          ok: false,
          msg: isDaily ? "DAILY QUOTA EXHAUSTED" : `HTTP ${r.status}`,
          detail: { daily_exhausted: isDaily },
        };
      }
      return {
        ok: true,
        msg: `${tokRemaining}/${tokLimit} tokens·minute  ·  ${reqRemaining} requests·minute`,
        detail: { tokens_remaining: Number(tokRemaining), tokens_limit: Number(tokLimit) },
      };
    }),
  },
];

// ─── FODZE internal data freshness ──────────────────────────────────

async function internalFreshness() {
  if (!SUPA_URL || !SUPA_KEY) return null;
  const r = await fetch(`${SUPA_URL}/rest/v1/matchdays?select=league,created_at&order=created_at.desc&limit=100`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const latest = {};
  for (const row of data) {
    if (!latest[row.league]) latest[row.league] = row.created_at;
  }
  const now = Date.now();
  return Object.entries(latest).map(([lg, ts]) => ({
    league: lg,
    hours: Math.round((now - new Date(ts).getTime()) / 3600000),
    ts,
  })).sort((a, b) => a.hours - b.hours);
}

// ─── Rendering ──────────────────────────────────────────────────────

async function main() {
  const results = [];
  for (const c of checks) {
    const res = await c.fn();
    results.push({ name: c.name, ...res });
  }
  const freshness = await internalFreshness();

  if (JSON_OUT) {
    console.log(JSON.stringify({ checks: results, freshness }, null, 2));
    return;
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  FODZE Health Check");
  console.log(`  ${new Date().toLocaleString("de-DE")}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const color = r.ok ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(`  ${color}${icon}${reset} ${r.name.padEnd(16)} ${String(r.ms).padStart(5)}ms  ${r.msg}`);
  }

  if (freshness) {
    console.log("");
    console.log("  Matchday-Freshness per League:");
    for (const f of freshness) {
      const h = f.hours;
      const icon = h < 48 ? "✓" : h < 168 ? "⚠" : "✗";
      const color = h < 48 ? "\x1b[32m" : h < 168 ? "\x1b[33m" : "\x1b[31m";
      const reset = "\x1b[0m";
      const age = h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
      console.log(`  ${color}${icon}${reset} ${f.league.padEnd(16)} ${age.padStart(5)} alt`);
    }
  }

  const broken = results.filter((r) => !r.ok).length;
  console.log("");
  if (broken === 0) {
    console.log("  \x1b[32m✓ Alle Systeme operational\x1b[0m");
  } else {
    console.log(`  \x1b[31m✗ ${broken} von ${results.length} Quellen offline\x1b[0m`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

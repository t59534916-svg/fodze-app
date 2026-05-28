#!/usr/bin/env node
/**
 * scripts/refresh-rolling-8.mjs
 *
 * Calls the SECURITY-DEFINER RPC `public.refresh_team_rolling_8()` which
 * executes `REFRESH MATERIALIZED VIEW CONCURRENTLY sofascore_team_rolling_8`.
 *
 * Wired into scripts/refresh-all.mjs as phase `rolling-8-refresh`, after
 * `sync-sofascore` (the upstream that writes to sofascore_shotmap → which
 * sofascore_team_chance_quality reads → which the materialized view aggregates).
 *
 * Requires SUPABASE_SERVICE_KEY in env. Idempotent (CONCURRENTLY = safe to
 * run during read queries — short access-exclusive lock only during swap).
 *
 * Exit codes:
 *   0 — refresh succeeded
 *   1 — env missing or HTTP error
 *
 * Migration that creates the RPC + MV:
 *   scripts/migration-sofascore-team-rolling-8-materialized.sql
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env.local loader (mirrors scripts/snapshot-closing-odds.mjs pattern —
// no `dotenv` dependency; project doesn't ship one)
const envPath = resolve(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && !process.env[t.slice(0, eq)]) {
      process.env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
}

const SUPA_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
// Project uses SUPABASE_SERVICE_KEY (NOT SUPABASE_SERVICE_ROLE_KEY)
const SUPA_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error(
    "[refresh-rolling-8] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local"
  );
  process.exit(1);
}

const url = `${SUPA_URL}/rest/v1/rpc/refresh_team_rolling_8`;
const t0 = Date.now();
console.log(`[refresh-rolling-8] POST ${url}`);

try {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: "{}",
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[refresh-rolling-8] HTTP ${resp.status} after ${ms}ms: ${body.slice(0, 300)}`
    );
    process.exit(1);
  }
  const result = await resp.text();
  console.log(
    `[refresh-rolling-8] ✓ MV refreshed in ${ms}ms (status=${resp.status} body=${result.trim() || "ok"})`
  );
  process.exit(0);
} catch (err) {
  const ms = Date.now() - t0;
  console.error(
    `[refresh-rolling-8] ${err.name || "Error"} after ${ms}ms: ${err.message || err}`
  );
  process.exit(1);
}

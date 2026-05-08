#!/usr/bin/env node
/**
 * FODZE — Movement Alerts (Telegram push when sharp odds move significantly)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Reads odds_snapshots time-series and surfaces matches where the sharp
 * (Pinnacle vig-removed) probability moved by ≥5pp on any 1X2 outcome
 * compared to the EARLIEST snapshot still within the alert window
 * (default last 24h). Sends a Telegram digest.
 *
 * Why 5pp threshold: empirically, sharp moves below 5pp are noise; ≥5pp
 * almost always reflects new information (lineup news, tactical reveal,
 * sharp money following an edge). This is the threshold used by sharp
 * betting communities.
 *
 * Why "earliest still in window" baseline: gives us "movement during this
 * news cycle" rather than full history. Match that opened 5pp away from
 * its current line a week ago shouldn't keep alerting.
 *
 * Failure-safe: missing TELEGRAM_BOT_TOKEN → log to stdout, don't crash.
 *   (Same pattern as scripts/value-alerts.mjs, which this is modeled on.)
 *
 * Idempotency: this script runs as the LAST step in fetch-odds.yml cron.
 * Each cron run picks up the new snapshot it just inserted as the
 * "latest" and compares to its 24h-old peer. No state needed — alerts
 * may repeat across cron-ticks if movement persists, but that's
 * desirable (you want to keep seeing the strongest movers).
 *
 * Usage:
 *   node scripts/movement-alerts.mjs                   # default: 24h window, 5pp threshold
 *   node scripts/movement-alerts.mjs --window 12h      # last 12h only
 *   node scripts/movement-alerts.mjs --threshold 3     # 3pp threshold (more alerts)
 *   node scripts/movement-alerts.mjs --dry             # preview, no telegram
 *
 * ENV: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── env ───────────────────────────────────────────────────────────
const envPath = resolve(PROJECT_ROOT, ".env.local");
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

// ─── args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function val(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const DRY = flag("dry");
const THRESHOLD_PP = parseFloat(val("threshold") ?? "5");  // pct-points
const WINDOW_RAW = val("window") ?? "24h";
const WINDOW_HOURS = (() => {
  const m = WINDOW_RAW.match(/^(\d+)([hd])$/);
  if (!m) return 24;
  return parseInt(m[1], 10) * (m[2] === "h" ? 1 : 24);
})();

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ─── helpers ───────────────────────────────────────────────────────

const headers = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function fetchSnapshots() {
  // Pull all snapshots within window — should be small enough to fit
  // in one PostgREST page (1000-row default). At ~250 matches × 6
  // ticks/day × N days, 24h window ≈ 1500 rows; bump page if needed.
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
  const qs = `select=match_key,league,home_team,away_team,odds,snapshot_time` +
             `&snapshot_time=gte.${since}` +
             `&order=snapshot_time.desc&limit=2000`;
  const r = await fetch(`${SUPA_URL}/rest/v1/odds_snapshots?${qs}`, { headers });
  if (!r.ok) throw new Error(`snapshots fetch ${r.status}: ${await r.text().catch(() => "")}`);
  return r.json();
}

// Vig-removed prob from sharp odds. Returns {h, d, a} in [0,1].
function vigRemoveSharp(odds) {
  const sharp = odds?._sharp;
  const h = sharp?.h, d = sharp?.d, a = sharp?.a;
  if (!h || !d || !a) return null;
  const sum = 1 / h + 1 / d + 1 / a;
  return {
    h: (1 / h) / sum,
    d: (1 / d) / sum,
    a: (1 / a) / sum,
  };
}

// ─── core: pure transformation (exported for unit tests) ───────────

/**
 * Group snapshots by match_key, compute earliest vs latest within
 * window, return alerts where any of {dH, dD, dA} ≥ thresholdPP.
 *
 * @param snapshots — array of {match_key, league, home_team, away_team,
 *                              odds JSONB, snapshot_time}
 * @param thresholdPP — minimum pct-point shift to flag (default 5)
 * @returns array of alert objects sorted by max-drift DESC
 */
export function buildAlerts(snapshots, thresholdPP = 5) {
  // Group by match_key; for each, find earliest + latest snapshot
  const byMatch = new Map();
  for (const s of snapshots) {
    const key = s.match_key;
    if (!key) continue;
    const arr = byMatch.get(key) || [];
    arr.push(s);
    byMatch.set(key, arr);
  }

  const alerts = [];
  for (const [key, snaps] of byMatch.entries()) {
    if (snaps.length < 2) continue;  // need ≥2 to compare
    snaps.sort((a, b) => new Date(a.snapshot_time) - new Date(b.snapshot_time));
    const earliest = snaps[0];
    const latest = snaps[snaps.length - 1];
    const earlyP = vigRemoveSharp(earliest.odds);
    const lateP = vigRemoveSharp(latest.odds);
    if (!earlyP || !lateP) continue;

    const dH = (lateP.h - earlyP.h) * 100;
    const dD = (lateP.d - earlyP.d) * 100;
    const dA = (lateP.a - earlyP.a) * 100;
    const maxAbs = Math.max(Math.abs(dH), Math.abs(dD), Math.abs(dA));

    if (maxAbs < thresholdPP) continue;

    alerts.push({
      match_key: key,
      league: latest.league,
      home_team: latest.home_team,
      away_team: latest.away_team,
      earliest_at: earliest.snapshot_time,
      latest_at: latest.snapshot_time,
      n_snapshots: snaps.length,
      open_pH: earlyP.h, open_pD: earlyP.d, open_pA: earlyP.a,
      now_pH: lateP.h,   now_pD: lateP.d,   now_pA: lateP.a,
      dH, dD, dA,
      max_drift_pp: maxAbs,
    });
  }
  alerts.sort((a, b) => b.max_drift_pp - a.max_drift_pp);
  return alerts;
}

// Direction-arrow + colored sign for a delta.
function fmtDelta(pp) {
  const arrow = pp > 0.5 ? "↑" : pp < -0.5 ? "↓" : "·";
  return `${arrow}${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`;
}

function formatTelegramMessage(alerts, windowHours) {
  if (!alerts.length) return null;
  const lines = [];
  lines.push(`📈 *Sharp odds movements* (last ${windowHours}h, ≥${THRESHOLD_PP}pp threshold)`);
  lines.push("");
  // Cap at top 10 to keep message readable
  for (const a of alerts.slice(0, 10)) {
    const ko = new Date(a.latest_at).toUTCString().slice(5, 17);
    lines.push(`*${a.home_team} vs ${a.away_team}* (${a.league})`);
    lines.push(
      `  H ${(a.open_pH * 100).toFixed(0)}→${(a.now_pH * 100).toFixed(0)}% ${fmtDelta(a.dH)}  ` +
      `D ${(a.open_pD * 100).toFixed(0)}→${(a.now_pD * 100).toFixed(0)}% ${fmtDelta(a.dD)}  ` +
      `A ${(a.open_pA * 100).toFixed(0)}→${(a.now_pA * 100).toFixed(0)}% ${fmtDelta(a.dA)}`
    );
  }
  if (alerts.length > 10) {
    lines.push(`\n_+${alerts.length - 10} more — full list at /movements_`);
  }
  return lines.join("\n");
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — printing to stdout instead:\n");
    console.log(text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    console.error(`telegram send failed: ${r.status} ${await r.text().catch(() => "")}`);
  }
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
    process.exit(1);
  }

  console.log(`📈 Movement alerts · window=${WINDOW_HOURS}h threshold=${THRESHOLD_PP}pp${DRY ? " (DRY)" : ""}`);
  const snaps = await fetchSnapshots();
  console.log(`   ${snaps.length} snapshots fetched`);

  const alerts = buildAlerts(snaps, THRESHOLD_PP);
  console.log(`   ${alerts.length} matches with movement ≥${THRESHOLD_PP}pp`);

  if (!alerts.length) {
    console.log("   no alerts to send.");
    return;
  }

  // Always log to stdout for cron-log readability
  for (const a of alerts.slice(0, 15)) {
    console.log(
      `   ${a.league.padEnd(15)} ${a.home_team.slice(0, 18).padEnd(18)} vs ${a.away_team.slice(0, 18).padEnd(18)}  ` +
      `${fmtDelta(a.dH).padStart(8)} ${fmtDelta(a.dD).padStart(8)} ${fmtDelta(a.dA).padStart(8)}  ` +
      `(max ${a.max_drift_pp.toFixed(1)}pp, n=${a.n_snapshots})`
    );
  }

  const msg = formatTelegramMessage(alerts, WINDOW_HOURS);
  if (DRY) {
    console.log("\n🟡 DRY — would send to Telegram:\n");
    console.log(msg);
    return;
  }
  await sendTelegram(msg);
  console.log(`\n✓ alert sent (${Math.min(alerts.length, 10)} of ${alerts.length} top movers)`);
}

// Entry-point guard (mirrors b2ae02c pattern from bridge-sofascore-to-team-xg)
const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()));

if (isEntryPoint) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

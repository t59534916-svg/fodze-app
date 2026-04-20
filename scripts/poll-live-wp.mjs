#!/usr/bin/env node
/**
 * FODZE Live-WP Snapshot Poller (Phase 3.3)
 * ═════════════════════════════════════════
 * Walks `live_match_events` from oldest to newest and materialises
 * `live_wp_snapshots` rows by calling the pure TS helper in
 * src/lib/live-wp.ts. This is the "cheap" deployment path — a cron job
 * every 60s polls the event log and upserts new snapshots.
 *
 * Alternative: a Supabase Edge Function triggered on INSERT. That's the
 * production-grade path (sub-second latency) but adds a second language
 * (Deno) to the ops surface, so we ship the pull-based poller first.
 *
 * Usage:
 *   node scripts/poll-live-wp.mjs --match-key "bundesliga|Bayern|Dortmund|2025-09-01"
 *   node scripts/poll-live-wp.mjs --all --dry
 *
 * Flags:
 *   --match-key <k>  Single match
 *   --all            Every match with events in the last 24h
 *   --dry            Compute + print; no DB write
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const IS_CLI = import.meta.url === pathToFileURL(process.argv[1] || "").href;

// ─── Env loader (CLI-only) ─────────────────────────────────────────
if (IS_CLI) {
  const envPath = resolve(REPO_ROOT, ".env.local");
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
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

// ─── Pure helpers (mirror of src/lib/live-wp.ts — keep in sync) ───
// The TS source is the canonical implementation; this is a minimal
// .mjs mirror so the script stays self-contained (no bundler step).
// Any future math tweak must land in both files — tests guard the TS side.

const REMAINING_DECAY = 0.84;
const MAX_GOALS_PER_TEAM = 12;
const STATE_MULTIPLIERS = {
  "0-0": { mH: 0.98, mA: 0.98 }, "0-1": { mH: 1.04, mA: 1.03 },
  "0-2": { mH: 0.98, mA: 1.20 }, "0-3": { mH: 0.86, mA: 1.25 },
  "1-0": { mH: 1.00, mA: 1.00 }, "1-1": { mH: 1.01, mA: 1.01 },
  "1-2": { mH: 1.02, mA: 1.05 }, "1-3": { mH: 0.90, mA: 1.15 },
  "2-0": { mH: 0.92, mA: 1.08 }, "2-1": { mH: 1.00, mA: 1.05 },
  "2-2": { mH: 1.05, mA: 1.05 }, "3-0": { mH: 0.85, mA: 1.12 },
  "3-1": { mH: 0.90, mA: 1.08 },
};
const RED_PENALTY = 0.75;
const RED_BOOST = 1.30;

function stateMult(h, a) {
  const key = `${h}-${a}`;
  if (STATE_MULTIPLIERS[key]) return STATE_MULTIPLIERS[key];
  const d = h - a;
  if (d > 0) return { mH: Math.max(0.8, 1 - 0.04 * d), mA: Math.min(1.4, 1 + 0.06 * d) };
  if (d < 0) return { mH: Math.min(1.4, 1 + 0.06 * (-d)), mA: Math.max(0.8, 1 - 0.04 * (-d)) };
  return { mH: 1, mA: 1 };
}

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let t = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) t = t * lambda / i;
  return t;
}

export function computeWP(pregame, state) {
  const minute = Math.max(0, Math.min(95, Math.floor(state.minute || 0)));
  const decay = Math.pow(Math.max(0, (90 - minute) / 90), REMAINING_DECAY);
  const sm = stateMult(state.scoreH, state.scoreA);
  const redNet = state.redCardsH - state.redCardsA;
  const hRed = redNet > 0 ? Math.pow(RED_PENALTY, redNet) : redNet < 0 ? Math.pow(RED_BOOST, -redNet) : 1;
  const aRed = redNet > 0 ? Math.pow(RED_BOOST, redNet) : redNet < 0 ? Math.pow(RED_PENALTY, -redNet) : 1;
  const lH = pregame.lambdaH * decay * sm.mH * hRed;
  const lA = pregame.lambdaA * decay * sm.mA * aRed;

  if (decay <= 1e-9) {
    const d = state.scoreH - state.scoreA;
    return {
      wp_home: d > 0 ? 1 : 0, wp_draw: d === 0 ? 1 : 0, wp_away: d < 0 ? 1 : 0,
      lambda_h_remaining: 0, lambda_a_remaining: 0,
    };
  }
  const pH = [], pA = [];
  for (let k = 0; k <= MAX_GOALS_PER_TEAM; k++) { pH.push(poissonPMF(k, lH)); pA.push(poissonPMF(k, lA)); }
  let H = 0, D = 0, A = 0;
  for (let kh = 0; kh <= MAX_GOALS_PER_TEAM; kh++)
    for (let ka = 0; ka <= MAX_GOALS_PER_TEAM; ka++) {
      const fh = state.scoreH + kh, fa = state.scoreA + ka;
      const p = pH[kh] * pA[ka];
      if (fh > fa) H += p; else if (fh < fa) A += p; else D += p;
    }
  const s = H + D + A;
  if (s > 0) { H /= s; D /= s; A /= s; }
  return {
    wp_home: +H.toFixed(4), wp_draw: +D.toFixed(4), wp_away: +A.toFixed(4),
    lambda_h_remaining: +lH.toFixed(4), lambda_a_remaining: +lA.toFixed(4),
  };
}

// ─── Event → state walker ─────────────────────────────────────────
function eventsToState(events) {
  const state = { scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0, minute: 0 };
  const snapshots = [];
  for (const ev of events) {
    if (typeof ev.minute === "number") state.minute = ev.minute;
    if (ev.event_type === "goal") {
      if (ev.team === "home") state.scoreH++;
      else if (ev.team === "away") state.scoreA++;
    } else if (ev.event_type === "red_card") {
      if (ev.team === "home") state.redCardsH++;
      else if (ev.team === "away") state.redCardsA++;
    }
    snapshots.push({ ...state });
  }
  return snapshots;
}

// ─── CLI entry (only when invoked directly) ────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const matchKey = args[args.indexOf("--match-key") + 1];
  const DRY = args.includes("--dry");
  const ALL = args.includes("--all");
  if (!matchKey && !ALL) {
    console.error("Usage: --match-key <k> OR --all [--dry]");
    process.exit(1);
  }
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("Supabase creds missing (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY)");
    process.exit(1);
  }

  // Discover match keys — either the single requested one, or every
  // match with events in the last 24h when --all.
  let keys = matchKey ? [matchKey] : [];
  if (ALL) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await fetch(`${SUPA_URL}/rest/v1/live_match_events?select=match_key&created_at=gte.${since}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!r.ok) { console.error(`live_match_events GET failed ${r.status}`); process.exit(1); }
    const rows = await r.json();
    keys = Array.from(new Set(rows.map(x => x.match_key))).filter(Boolean);
  }
  console.log(`[live-wp] processing ${keys.length} match_key(s)${DRY ? " (dry)" : ""}`);

  for (const key of keys) {
    // Pull the event log in chronological order.
    const evResp = await fetch(
      `${SUPA_URL}/rest/v1/live_match_events?match_key=eq.${encodeURIComponent(key)}&order=minute.asc&order=created_at.asc`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } },
    );
    if (!evResp.ok) { console.warn(`[live-wp] ${key}: events GET ${evResp.status}`); continue; }
    const events = await evResp.json();
    if (!events.length) { console.log(`[live-wp] ${key}: no events`); continue; }

    // Pre-game λ comes from the latest matchday JSON — caller expected to
    // have `match_calc.lambda_h` persisted somewhere. For this skeleton we
    // synth λ=1.4/1.2 (Top-5 average) so the poller always produces
    // something; production must plumb real pre-game engine output in.
    const pregame = { lambdaH: 1.4, lambdaA: 1.2 };

    const states = eventsToState(events);
    const snapshots = states.map((s, i) => {
      const wp = computeWP(pregame, s);
      return {
        match_key: key,
        minute: events[i].minute,
        score_home: s.scoreH, score_away: s.scoreA,
        red_cards_home: s.redCardsH, red_cards_away: s.redCardsA,
        wp_home: wp.wp_home, wp_draw: wp.wp_draw, wp_away: wp.wp_away,
        lambda_h_remaining: wp.lambda_h_remaining, lambda_a_remaining: wp.lambda_a_remaining,
      };
    });

    if (DRY) {
      const s = snapshots[snapshots.length - 1];
      console.log(`[live-wp] ${key}: ${snapshots.length} snapshots, final ${s.score_home}-${s.score_away} wp(${s.wp_home}/${s.wp_draw}/${s.wp_away})`);
      continue;
    }
    const up = await fetch(`${SUPA_URL}/rest/v1/live_wp_snapshots`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(snapshots),
    });
    if (!up.ok) console.warn(`[live-wp] ${key}: upsert ${up.status}: ${(await up.text()).slice(0, 200)}`);
    else console.log(`[live-wp] ${key}: ✓ ${snapshots.length} snapshots`);
  }
}

if (IS_CLI) {
  main().catch(e => {
    console.error("[live-wp] unhandled:", e);
    process.exit(1);
  });
}

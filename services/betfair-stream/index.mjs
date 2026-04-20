#!/usr/bin/env node
/**
 * FODZE Betfair Exchange Stream Consumer (Phase 3.3 — SKELETON)
 * ═════════════════════════════════════════════════════════════
 * Subscribes to the Betfair Exchange Streaming API on a single "Match
 * Odds" market, detects goals + red cards from price discontinuities,
 * and writes events to Supabase `live_match_events`.
 *
 * REQUIRED ENV:
 *   BETFAIR_APP_KEY         — Delayed App Key (free tier)
 *   BETFAIR_SESSION_TOKEN   — login-produced session, refresh every 8h
 *   BETFAIR_MARKET_ID       — the Match Odds market (e.g. "1.234567")
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * NOT IMPLEMENTED (track it — real deployment needs):
 *   - Multi-market subscription manager
 *   - Session-token auto-refresh via Betfair login-interactive endpoint
 *   - Price-discontinuity classifier (goals vs red cards vs false-positive)
 *   - Graceful reconnect on 24h idle-kill (Betfair stream spec §2.4)
 *
 * The skeleton exits with code 0 when required env is missing, so a cron
 * runner doesn't loop-fail while the operator sets things up.
 */

import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const REQ = ["BETFAIR_APP_KEY", "BETFAIR_SESSION_TOKEN", "BETFAIR_MARKET_ID", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
const missing = REQ.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[betfair-stream] missing env: ${missing.join(", ")}`);
  console.error(`[betfair-stream] → see services/betfair-stream/README.md for setup`);
  process.exit(0);
}

const { BETFAIR_APP_KEY, BETFAIR_SESSION_TOKEN, BETFAIR_MARKET_ID, BETFAIR_MATCH_KEY,
  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY);
const STREAM_URL = "wss://stream-api.betfair.com/api";

// ─── Event-inference state ─────────────────────────────────────────
// Price jumps > JUMP_THRESHOLD on the Match Odds market, while status is
// SUSPENDED, indicate a goal or red card. Heuristic only — real deployment
// should cross-check with a secondary source (e.g. Opta goal-push via
// alternate feed) for authoritative classification.
const JUMP_THRESHOLD = 0.15;
let lastPrices = { home: null, draw: null, away: null };
let lastMinute = 0;
let scoreH = 0, scoreA = 0;

function inferEventFromJump(prev, next) {
  if (!prev || !next) return null;
  const dH = Math.abs(next.home - prev.home);
  const dA = Math.abs(next.away - prev.away);
  if (dH < JUMP_THRESHOLD && dA < JUMP_THRESHOLD) return null;
  // Home odds dropped = home became more likely → home scored.
  if (next.home < prev.home - JUMP_THRESHOLD) return { event_type: "goal", team: "home" };
  if (next.away < prev.away - JUMP_THRESHOLD) return { event_type: "goal", team: "away" };
  // Home odds rose sharply → home got weaker (goal against OR red card).
  // We can't disambiguate reliably from 1X2 alone — log as "event" and
  // let a manual-review flow classify, or attach a Correct Score market
  // stream to narrow it.
  return { event_type: "event", team: "unknown" };
}

async function insertEvent(minute, event_type, team) {
  const { error } = await supabase.from("live_match_events").insert({
    match_key: BETFAIR_MATCH_KEY || BETFAIR_MARKET_ID,
    minute, event_type, team,
    source: "betfair-stream",
  });
  if (error) console.error(`[betfair-stream] insert failed: ${error.message}`);
  else console.log(`[betfair-stream] ✓ ${minute}' ${event_type} (${team})`);
}

// ─── Minimal stream consumer ───────────────────────────────────────
const ws = new WebSocket(STREAM_URL);

ws.on("open", () => {
  console.log("[betfair-stream] connected, authenticating");
  ws.send(JSON.stringify({
    op: "authentication",
    id: 1,
    appKey: BETFAIR_APP_KEY,
    session: BETFAIR_SESSION_TOKEN,
  }));
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { return; }

  if (msg.op === "status" && msg.id === 1) {
    console.log(`[betfair-stream] auth status: ${msg.statusCode}`);
    if (msg.statusCode === "SUCCESS") {
      // Subscribe to the requested Match Odds market.
      ws.send(JSON.stringify({
        op: "marketSubscription",
        id: 2,
        marketFilter: { marketIds: [BETFAIR_MARKET_ID] },
        marketDataFilter: { fields: ["EX_BEST_OFFERS", "EX_MARKET_DEF"] },
      }));
    } else {
      process.exit(1);
    }
    return;
  }
  if (msg.op !== "mcm") return;

  for (const mc of msg.mc || []) {
    // Market definition carries minute + status (for half-time etc.).
    if (mc.marketDefinition) {
      const md = mc.marketDefinition;
      if (md.status === "CLOSED") {
        insertEvent(90, "fulltime", "match");
        process.exit(0);
      }
      // Betfair stream doesn't give a literal minute; approximate from
      // the bet-delay field or markerTime. Real deployment should pair
      // with a secondary kick-off clock.
    }

    // Price updates — extract best-back for home/draw/away runners.
    if (mc.rc) {
      // Runner order: home, draw, away (Betfair convention for Match Odds).
      const [home, draw, away] = [0, 1, 2].map(i => mc.rc[i]?.ltp ?? null);
      const next = { home, draw, away };
      const inferred = inferEventFromJump(lastPrices, next);
      if (inferred) {
        if (inferred.event_type === "goal") {
          if (inferred.team === "home") scoreH++; else if (inferred.team === "away") scoreA++;
        }
        insertEvent(lastMinute, inferred.event_type, inferred.team);
      }
      lastPrices = next;
    }
  }
});

ws.on("close", () => {
  console.log("[betfair-stream] disconnected");
  process.exit(0);
});
ws.on("error", (e) => {
  console.error(`[betfair-stream] error: ${e.message}`);
});

// Clean shutdown on SIGTERM (Fly.io restart).
process.on("SIGTERM", () => {
  console.log("[betfair-stream] SIGTERM — closing");
  ws.close();
});

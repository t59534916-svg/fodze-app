#!/usr/bin/env node
/**
 * FODZE Value Alerts — Scans live_odds + matchday data → Telegram alerts
 *
 * Runs after fetch-odds.mjs. Compares model probabilities against live odds.
 * Sends Telegram alerts for bets with Edge ≥ 5%.
 *
 * Usage:
 *   node scripts/value-alerts.mjs                    # scan all leagues
 *   node scripts/value-alerts.mjs --league bundesliga # single league
 *   node scripts/value-alerts.mjs --dry               # preview without sending
 *   node scripts/value-alerts.mjs --threshold 3       # custom edge threshold (%)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — Telegram bot token from @BotFather
 *   TELEGRAM_CHAT_ID     — Channel ID (e.g., @fodze_alerts or -100xxxxx)
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key
 */

// ─── Dixon-Coles Engine (inline, minimal version) ───────────────────

const RHO = -0.05;
const MAX_GOALS = 15;

const LEAGUES = {
  bundesliga:  { name: "Bundesliga", hf: 1.28, avg: 1.38 },
  bundesliga2: { name: "2. Bundesliga", hf: 1.29, avg: 1.35 },
  liga3:       { name: "3. Liga", hf: 1.22, avg: 1.40 },
  epl:         { name: "Premier League", hf: 1.22, avg: 1.35 },
  la_liga:     { name: "La Liga", hf: 1.30, avg: 1.25 },
  serie_a:     { name: "Serie A", hf: 1.27, avg: 1.32 },
};

function poissonPMF(k, lam) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  let logP = -lam + k * Math.log(lam);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function buildMatrix(lamH, lamA) {
  const mx = Array.from({ length: MAX_GOALS }, () => Array(MAX_GOALS).fill(0));
  for (let i = 0; i < MAX_GOALS; i++)
    for (let j = 0; j < MAX_GOALS; j++)
      mx[i][j] = poissonPMF(i, lamH) * poissonPMF(j, lamA);
  if (lamH > 0 && lamA > 0) {
    mx[0][0] *= Math.max(0, 1 - lamH * lamA * RHO);
    mx[1][0] *= Math.max(0, 1 + lamA * RHO);
    mx[0][1] *= Math.max(0, 1 + lamH * RHO);
    mx[1][1] *= Math.max(0, 1 - RHO);
  }
  let sum = 0;
  for (const row of mx) for (const v of row) sum += v;
  if (sum > 0) for (const row of mx) for (let j = 0; j < MAX_GOALS; j++) row[j] /= sum;
  return mx;
}

function queryMatrix(mx, cond) {
  let p = 0;
  for (let i = 0; i < mx.length; i++)
    for (let j = 0; j < mx.length; j++)
      if (cond(i, j)) p += mx[i][j];
  return p;
}

// ─── Grade + Kelly ──────────────────────────────────────────────────

function grade(edge) {
  if (edge >= 0.08) return "A";
  if (edge >= 0.05) return "B";
  if (edge >= 0.03) return "C";
  if (edge > 0) return "D";
  return "F";
}

function gradeEmoji(g) {
  return { A: "🟢", B: "🔵", C: "🟡", D: "⚪", F: "🔴" }[g] || "⚪";
}

function kelly(pModel, odds, frac = 0.25) {
  const q = 1 - pModel;
  const b = odds - 1;
  const k = (b * pModel - q) / b;
  return Math.max(0, Math.min(k * frac, 0.05)); // cap at 5%
}

// ─── Main Logic ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const singleLeague = args.find((a, i) => args[i - 1] === "--league");
const thresholdArg = args.find((a, i) => args[i - 1] === "--threshold");
const EDGE_THRESHOLD = (parseFloat(thresholdArg) || 5) / 100;

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

if (!SUPA_URL || !SUPA_KEY) { console.error("❌ Missing SUPABASE_URL/KEY"); process.exit(1); }
if (!TG_TOKEN && !DRY) { console.error("❌ Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }
if (!TG_CHAT && !DRY) { console.error("❌ Missing TELEGRAM_CHAT_ID"); process.exit(1); }

async function supaFetch(path) {
  const resp = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  return resp.json();
}

async function sendTelegram(text) {
  if (DRY) { console.log("[DRY] Would send:", text.substring(0, 100) + "..."); return; }
  const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) console.error("Telegram error:", await resp.text());
}

async function main() {
  const leagueKeys = singleLeague ? [singleLeague] : Object.keys(LEAGUES);
  console.log(`🔔 FODZE Value Alerts — ${leagueKeys.length} leagues, threshold ${(EDGE_THRESHOLD*100).toFixed(0)}%`);

  const alerts = [];

  for (const lgKey of leagueKeys) {
    const ld = LEAGUES[lgKey];
    if (!ld) continue;

    // Load matchday data
    const matchdays = await supaFetch(`matchdays?league=eq.${lgKey}&order=created_at.desc&limit=1`);
    if (!matchdays.length) { console.log(`  ${lgKey}: no matchday data`); continue; }
    const matchday = matchdays[0];
    const matches = matchday.data?.matches || [];

    // Load live odds
    const liveOdds = await supaFetch(`live_odds?league=eq.${lgKey}&commence_time=gte.${new Date().toISOString()}&order=commence_time.asc`);
    console.log(`  ${lgKey}: ${matches.length} matches, ${liveOdds.length} live odds`);

    for (const match of matches) {
      const h = match.home, a = match.away;
      if (!h?.xg_h8 || !a?.xg_a8 || h.xg_h8 === 0 || a.xg_a8 === 0) continue;

      // Calculate lambdas
      const hXGpg = h.xg_h8 / (h.games || 8);
      const hXGApg = h.xga_h8 / (h.games || 8);
      const aXGpg = a.xg_a8 / (a.games || 8);
      const aXGApg = a.xga_a8 / (a.games || 8);
      const avg = ld.avg, hf = ld.hf;
      const lambdaH = avg * (hXGpg / avg) * (aXGApg / avg) * hf;
      const lambdaA = avg * (aXGpg / avg) * (hXGApg / avg);

      const mx = buildMatrix(lambdaH, lambdaA);
      const pH = queryMatrix(mx, (i, j) => i > j);
      const pD = queryMatrix(mx, (i, j) => i === j);
      const pA = queryMatrix(mx, (i, j) => i < j);
      const pO25 = queryMatrix(mx, (i, j) => i + j > 2);

      // Match with live odds (fuzzy)
      const homeName = (h.name || "").toLowerCase();
      const awayName = (a.name || "").toLowerCase();
      const lo = liveOdds.find(o => {
        const oH = o.home_team.toLowerCase();
        const oA = o.away_team.toLowerCase();
        return (oH.includes(homeName) || homeName.includes(oH) ||
                oH.split(" ").some(w => w.length > 3 && homeName.includes(w))) &&
               (oA.includes(awayName) || awayName.includes(oA) ||
                oA.split(" ").some(w => w.length > 3 && awayName.includes(w)));
      });

      if (!lo) continue;

      // Check each market for value
      const markets = [
        { label: "1 (Heim)", pModel: pH, odds: lo.best_h, sharp: lo.sharp_h },
        { label: "X (Remis)", pModel: pD, odds: lo.best_d, sharp: lo.sharp_d },
        { label: "2 (Gast)", pModel: pA, odds: lo.best_a, sharp: lo.sharp_a },
        { label: "Ü2.5", pModel: pO25, odds: lo.best_over25, sharp: lo.sharp_over25 },
        { label: "U2.5", pModel: 1 - pO25, odds: lo.best_under25, sharp: lo.sharp_under25 },
      ];

      for (const mk of markets) {
        if (!mk.odds || mk.odds <= 1) continue;
        const pMarket = 1 / mk.odds;
        const edge = mk.pModel - pMarket;
        if (edge < EDGE_THRESHOLD) continue;

        const g = grade(edge);
        const k = kelly(mk.pModel, mk.odds);
        const ev = edge * mk.odds;

        alerts.push({
          league: ld.name,
          home: h.name,
          away: a.name,
          market: mk.label,
          odds: mk.odds,
          sharpOdds: mk.sharp,
          pModel: mk.pModel,
          pMarket,
          edge,
          grade: g,
          kelly: k,
          ev,
          kickoff: match.kickoff || "",
          commence: lo.commence_time,
        });
      }
    }
  }

  // Sort by edge descending
  alerts.sort((a, b) => b.edge - a.edge);

  console.log(`\n🚨 ${alerts.length} Value Alerts found (Edge ≥ ${(EDGE_THRESHOLD*100).toFixed(0)}%)`);

  if (alerts.length === 0) {
    console.log("  Keine Value Bets gefunden.");
    return;
  }

  // Print summary
  for (const a of alerts) {
    console.log(`  ${gradeEmoji(a.grade)} ${a.grade} | ${a.home} vs ${a.away} | ${a.market} @ ${a.odds.toFixed(2)} | Edge ${(a.edge*100).toFixed(1)}% | Kelly ${(a.kelly*100).toFixed(1)}%`);
  }

  // Build Telegram message
  const now = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  let msg = `🚨 <b>FODZE VALUE ALERTS</b> — ${now}\n`;
  msg += `${alerts.length} Bets mit Edge ≥ ${(EDGE_THRESHOLD*100).toFixed(0)}%\n\n`;

  for (const a of alerts.slice(0, 10)) { // Max 10 per message
    const kickoff = a.commence ? new Date(a.commence).toLocaleString("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const sharpInfo = a.sharpOdds ? ` (Sharp: ${Number(a.sharpOdds).toFixed(2)})` : "";
    msg += `${gradeEmoji(a.grade)} <b>${a.grade}</b> | ${a.league}\n`;
    msg += `${a.home} vs ${a.away}\n`;
    msg += `📊 <b>${a.market} @ ${a.odds.toFixed(2)}</b>${sharpInfo}\n`;
    msg += `Edge: <b>${(a.edge*100).toFixed(1)}%</b> | Modell: ${(a.pModel*100).toFixed(0)}% | Kelly: ${(a.kelly*100).toFixed(1)}%\n`;
    msg += `⏰ ${kickoff}\n\n`;
  }

  msg += `<i>FODZE · Dixon-Coles · Isotonic Calibration</i>`;

  await sendTelegram(msg);
  console.log(`\n✅ ${DRY ? "[DRY] Would have sent" : "Sent"} Telegram alert with ${Math.min(alerts.length, 10)} bets`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });

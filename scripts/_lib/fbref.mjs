// ═══════════════════════════════════════════════════════════════════════
// FODZE — FBref scraping client (polite, rate-limited)
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠ STATUS 2026-04-24: **NICHT OPERATIV**
//   FBref steht vollständig hinter einer Cloudflare JavaScript-Challenge
//   (selbst /robots.txt liefert die "Just a moment..."-Seite). Ein reiner
//   node-fetch()-Client — egal mit welchen Headern oder User-Agent —
//   erhält konsistent 403. Um diese Daten zu holen wäre ein headless
//   Browser nötig (Playwright/Puppeteer mit stealth-plugin) — aber selbst
//   das wird von Cloudflare in vielen Fällen erkannt und eskaliert nach
//   kurzer Zeit zu IP-Block.
//
//   Dieses Modul bleibt als dokumentiertes Parsing-Gerüst im Repo
//   (URL-Schemata, HTML-Strukturen, data-stat mapping), falls wir
//   jemals über einen bezahlten Proxy-Service wie ScraperAPI oder
//   ScrapingBee ($29-99/mo) den Content-Fetch lösen — die Parsing-Logik
//   bleibt dann identisch.
//
// LEGAL NOTE:
//   FBref hostet Match-Stats lizenziert von Opta/StatsPerform. Ihre ToS
//   untersagen kommerzielle Redistribution. Persönliches Research ist
//   grauzone — aber da Cloudflare den Zugriff technisch blockiert, ist
//   dieser Punkt moot.
//
// RATE LIMIT:
//   FBref's Cloudflare setup enforces 10 requests / minute / IP. Exceeding
//   triggers 429s and can escalate to longer IP-block. We use 7000ms base
//   delay (= ~8.5 r/m), well under the cap.
//
// TECHNICAL NOTES:
//   FBref wraps many tables in HTML <!-- comment --> blocks to defeat
//   naive scrapers. We strip comments before cheerio-parse, which exposes
//   all hidden tables. The data-stat attribute on each <td> tells you
//   which metric the cell holds.
//
// Data-stat names we rely on (FBref "Team Stats" panel, 2023-2024+):
//   xg, npxg, shots, shots_on_target, possession, passes,
//   passes_completed, passes_pct, fouls, offsides, cards_yellow,
//   cards_red, corner_kicks
// ═══════════════════════════════════════════════════════════════════════

import * as cheerio from "cheerio";

const BASE = "https://fbref.com";

// UA-Strategie: FBref's Cloudflare-Setup blockt unbekannte UAs sofort mit
// 403. Der "Mozilla/5.0 (compatible; …)" Prefix ist das von RFC 7231
// vorgesehene Format für Bots, die sich transparent identifizieren aber
// Browser-Parser-Kompatibilität signalisieren — durchläuft Cloudflare
// und bleibt gleichzeitig ehrlich über die Natur des Requests.
const DEFAULT_UA =
  process.env.FBREF_USER_AGENT ||
  "Mozilla/5.0 (compatible; FODZE-Research/1.0; personal football analysis, rate-limited <10 r/m)";

// Competition IDs on FBref. Verified against https://fbref.com/en/comps/
// Sub-pages. Add new IDs here if coverage expands.
export const FBREF_COMP_IDS = {
  epl: 9,
  bundesliga: 20,
  la_liga: 12,
  serie_a: 11,
  ligue_1: 13,
  eredivisie: 23,
  championship: 10,
  bundesliga2: 33,
  liga3: 59,
  la_liga2: 17,
  serie_b: 18,
  ligue_2: 60,
  primeira_liga: 32,
  jupiler_pro: 37,
  super_lig: 26,
  scottish_prem: 40,
  greek_sl: 27,
  league_one: 15,
  league_two: 16,
  austria_bl: 56,
  swiss_sl: 57,
  eerste_divisie: 51,
};

export const FBREF_COMP_SLUGS = {
  epl: "Premier-League",
  bundesliga: "Bundesliga",
  la_liga: "La-Liga",
  serie_a: "Serie-A",
  ligue_1: "Ligue-1",
  eredivisie: "Eredivisie",
  championship: "Championship",
  bundesliga2: "2-Bundesliga",
  liga3: "3-Liga",
  la_liga2: "Segunda-Division",
  serie_b: "Serie-B",
  ligue_2: "Ligue-2",
  primeira_liga: "Primeira-Liga",
  jupiler_pro: "Belgian-Pro-League",
  super_lig: "Super-Lig",
  scottish_prem: "Scottish-Premiership",
  greek_sl: "Super-League",
  league_one: "League-One",
  league_two: "League-Two",
  austria_bl: "Austrian-Bundesliga",
  swiss_sl: "Swiss-Super-League",
  eerste_divisie: "Eerste-Divisie",
};

// ─── Client ──────────────────────────────────────────────────────

export function createFbrefClient({
  userAgent = DEFAULT_UA,
  perRequestDelay = 7000, // ms — 8.5 r/m, safely under the 10 r/m cap
  verbose = false,
} = {}) {
  const state = {
    requestsDone: 0,
    backoffUntil: 0,
  };
  const log = (...args) => { if (verbose) console.log("[fbref]", ...args); };

  async function sleep(ms) { if (ms > 0) await new Promise(r => setTimeout(r, ms)); }

  async function get(path) {
    // Cloudflare-detected 429 → exponential backoff pausing all requests
    const now = Date.now();
    if (state.backoffUntil > now) {
      const wait = state.backoffUntil - now;
      log(`in backoff, sleeping ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }

    const url = path.startsWith("http") ? path : BASE + path;
    const start = Date.now();
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      return { ok: false, error: `network: ${e.message}`, html: null };
    }
    state.requestsDone++;

    if (res.status === 429) {
      // Cloudflare rate-limit — back off 60s and retry once
      log("429 — backing off 60s");
      state.backoffUntil = Date.now() + 60_000;
      await sleep(60_000);
      return get(path);
    }
    if (res.status === 403) {
      // Forbidden → permanent block? Abort hard.
      return { ok: false, error: `403 Forbidden — IP likely blocked`, html: null };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${body.slice(0, 150)}`, html: null };
    }

    const html = await res.text();
    await sleep(perRequestDelay);
    log(`${res.status} · ${html.length} bytes · ${Date.now() - start}ms · ${path}`);
    return { ok: true, error: null, html };
  }

  return {
    get,
    state,
  };
}

// ─── HTML Helpers ────────────────────────────────────────────────

/**
 * FBref hides many tables inside HTML comments like:
 *   <div class="placeholder">...</div>
 *   <!--
 *     <div class="table_wrapper"> <table>...</table> </div>
 *   -->
 * to defeat naive scraping. We rewrite comments to plain content so
 * cheerio can parse everything.
 */
export function stripHtmlComments(html) {
  return html.replace(/<!--([\s\S]*?)-->/g, "$1");
}

export function loadCheerio(html) {
  return cheerio.load(stripHtmlComments(html));
}

// ─── Fixture-list extraction ─────────────────────────────────────
//
// Competition schedule page URL pattern:
//   /en/comps/{compId}/{season}/schedule/{season}-{Slug}-Scores-and-Fixtures
// Season format: "2023-2024" (hyphenated start-end).
//
// Each fixture row in the "sched_*" table has:
//   <td data-stat="match_report"><a href="/en/matches/<matchId>/...">Match Report</a></td>
// Extracting match-report URLs is the clean way to enumerate matches.

export function buildScheduleUrl(fodzeLeague, season /* "2023-2024" */) {
  const cid = FBREF_COMP_IDS[fodzeLeague];
  const slug = FBREF_COMP_SLUGS[fodzeLeague];
  if (!cid || !slug) return null;
  return `/en/comps/${cid}/${season}/schedule/${season}-${slug}-Scores-and-Fixtures`;
}

export function parseScheduleForMatchReports(html) {
  const $ = loadCheerio(html);
  const out = [];
  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    const text = ($(a).text() || "").trim();
    // "Match Report" anchor → match report page
    if (/match report/i.test(text) && /\/en\/matches\//.test(href)) {
      out.push(href);
    }
  });
  return [...new Set(out)];
}

// ─── Match-report extraction ─────────────────────────────────────
//
// FBref match-report page has two "Team Stats" tables (one per team) in
// the main content, plus the "scorebox" at top with xG.
//
// Scorebox xG appears as:
//   <div class="scorebox_meta"> ... </div>
//   <div class="score">2</div> <div class="score_xg">1.8</div>
// for each team. The .score_xg div holds xG.
//
// Team stats panel has rows with data-stat attributes:
//   possession, shots, shots_on_target, passes, passes_pct,
//   passes_completed, fouls, corner_kicks, offsides, cards_yellow,
//   cards_red, saves.

export function parseMatchReport(html) {
  const $ = loadCheerio(html);

  // Teams from scorebox
  const scoreboxDivs = $(".scorebox > div").slice(0, 2);
  const teamNames = [];
  scoreboxDivs.each((_, el) => {
    const strong = $(el).find("a strong").first().text().trim() ||
                   $(el).find("a").first().text().trim();
    teamNames.push(strong || "");
  });

  // Date from the scorebox meta div — typically "Venue Date: <Mon DD, YYYY>"
  let matchDate = null;
  $("div.scorebox_meta").find("div, strong").each((_, el) => {
    const t = $(el).text().trim();
    const m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) { matchDate = `${m[1]}-${m[2]}-${m[3]}`; }
  });
  // Fallback: look for datetime attribute in anchor
  if (!matchDate) {
    $("span[data-venue-date], a.tooltip, a.poptip").each((_, el) => {
      const t = $(el).attr("data-venue-date") || $(el).text().trim();
      const m = t?.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m && !matchDate) matchDate = `${m[1]}-${m[2]}-${m[3]}`;
    });
  }

  // Goals from scorebox
  const goals = [null, null];
  $(".scorebox > div").slice(0, 2).each((i, el) => {
    const s = $(el).find(".score").first().text().trim();
    const n = parseInt(s, 10);
    if (Number.isFinite(n)) goals[i] = n;
  });

  // xG from scorebox
  const xgs = [null, null];
  $(".scorebox > div").slice(0, 2).each((i, el) => {
    const x = $(el).find(".score_xg").first().text().trim();
    const n = parseFloat(x);
    if (Number.isFinite(n)) xgs[i] = n;
  });

  // Team-stats panel — look for the "Team Stats" container or the
  // #team_stats table. FBref uses a grid of rows per team.
  const teamStats = [{}, {}];

  // Try #team_stats first
  const tsTable = $("#team_stats");
  if (tsTable.length) {
    // Layout: rows contain label, home val, away val
    tsTable.find("tr").each((_, tr) => {
      const th = $(tr).find("th").first().text().trim().toLowerCase();
      const tds = $(tr).find("td");
      if (tds.length !== 2) return;
      const homeVal = $(tds[0]).text().trim();
      const awayVal = $(tds[1]).text().trim();
      // Known fields we want
      if (/possession/i.test(th)) {
        teamStats[0].possession_pct = parsePctOrNum(homeVal);
        teamStats[1].possession_pct = parsePctOrNum(awayVal);
      } else if (/passing accuracy|pass(ing)? accuracy|passes completed|pass accuracy/i.test(th)) {
        // format: "226 of 296 — 76%"
        const pH = parsePassingCell(homeVal);
        const pA = parsePassingCell(awayVal);
        Object.assign(teamStats[0], pH);
        Object.assign(teamStats[1], pA);
      } else if (/shots on target/i.test(th)) {
        const sH = parseShotsCell(homeVal);
        const sA = parseShotsCell(awayVal);
        Object.assign(teamStats[0], sH);
        Object.assign(teamStats[1], sA);
      } else if (/saves/i.test(th)) {
        // "3 of 5 — 60%"
        teamStats[0].gk_saves = parseFirstInt(homeVal);
        teamStats[1].gk_saves = parseFirstInt(awayVal);
      } else if (/cards/i.test(th)) {
        // Shown as yellow/red badges; skip parsing
      }
    });
  }

  // Additional Tables: #stats_*_summary rows per team for fouls, corners, etc.
  // The home/away team-ids are present in the table IDs as hashes.
  $('table[id^="stats_"][id$="_summary"]').each((_, tbl) => {
    // These are player-level tables; skip for now. Could aggregate later.
  });

  // Shot-counts often live in a wrapped table "stats_shots" or inline
  // "Shots" events. Use aggregation of the shots_* tfoot row.
  $('table[id*="shots"]').each((_, tbl) => {
    // Optional enhancement; the main xG + summary covers the needs.
  });

  // Corners — FBref doesn't always expose in Team Stats. Try pulling
  // from misc_stats tfoot:
  $('table[id^="stats_"][id$="_misc"] tfoot tr').each((i, tr) => {
    if (i > 1) return;
    const ck = $(tr).find('td[data-stat="corner_kicks"]').text().trim();
    const fl = $(tr).find('td[data-stat="fouls"]').text().trim();
    const off = $(tr).find('td[data-stat="offsides"]').text().trim();
    const target = i; // row 0 = home, row 1 = away (convention on FBref)
    if (ck) teamStats[target].corners = parseFirstInt(ck);
    if (fl) teamStats[target].fouls = parseFirstInt(fl);
    if (off) teamStats[target].offsides = parseFirstInt(off);
  });

  return {
    matchDate,
    home: { name: teamNames[0], goals: goals[0], xg: xgs[0], ...teamStats[0] },
    away: { name: teamNames[1], goals: goals[1], xg: xgs[1], ...teamStats[1] },
  };
}

// ─── Small value parsers ─────────────────────────────────────────
function parsePctOrNum(v) {
  const s = (v || "").trim();
  if (s.endsWith("%")) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function parseFirstInt(v) {
  const m = (v || "").match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}
/** "226 of 296 — 76%" → { passes_accurate: 226, passes_total: 296, pass_pct: 76 } */
function parsePassingCell(v) {
  const out = {};
  const s = v || "";
  const mFrac = s.match(/(\d+)\s*(?:of|\/|-)\s*(\d+)/i);
  if (mFrac) {
    out.passes_accurate = parseInt(mFrac[1], 10);
    out.passes_total = parseInt(mFrac[2], 10);
  }
  const mPct = s.match(/(\d+)\s*%/);
  if (mPct) out.pass_pct = parseInt(mPct[1], 10);
  return out;
}
/** "5 of 12 — 42%" → { shots_on_target_for: 5, shots_for: 12 } */
function parseShotsCell(v) {
  const out = {};
  const s = v || "";
  const mFrac = s.match(/(\d+)\s*(?:of|\/|-)\s*(\d+)/i);
  if (mFrac) {
    out.shots_on_target_for = parseInt(mFrac[1], 10);
    out.shots_for = parseInt(mFrac[2], 10);
  }
  return out;
}

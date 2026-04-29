#!/usr/bin/env node
/**
 * FODZE Referee Stats Scraper
 * ═══════════════════════════
 *
 * STATUS: direct FBref scraping is blocked by Cloudflare (HTTP 403 on all
 * `/en/comps/*` endpoints since late 2024). This script stays in the repo
 * for two reasons:
 *   1. The `--csv-dir` mode still works for any manually-supplied CSV
 *      in the "Date,HomeTeam,AwayTeam,Referee" shape (e.g. an R-export
 *      from worldfootballR::fb_match_results()).
 *   2. FBref sometimes loosens protection for narrow IP ranges. If your
 *      IP isn't blocked, direct-fetch mode still produces the intended
 *      output. Run with `--try-fetch` to opt in.
 *
 * ── Workarounds ──────────────────────────────────────────────────────
 *
 * Workflow A (R-export from worldfootballR_data, recommended):
 *   1. In R:
 *        install.packages("worldfootballR")
 *        library(worldfootballR)
 *        # IMPORTANT: use load_*, NOT fb_*. The `fb_*` functions live-scrape
 *        # FBref which is now Cloudflare-blocked (403). `load_*` functions
 *        # read pre-scraped .rds files from the worldfootballR_data repo.
 *        data <- load_match_results(
 *          country = "GER", gender = "M", season_end_year = 2026, tier = "1st"
 *        )
 *        write.csv(data[,c("Date","Home","Away","Referee")],
 *                  "referees-bundesliga-2526.csv", row.names = FALSE)
 *   2. Run:
 *        node scripts/scrape-referees.mjs --league bundesliga \
 *          --csv-file Historie/referees-bundesliga-2526.csv
 *
 * Workflow B (manual seed, small leagues):
 *   Edit a CSV by hand with rows  "Date,HomeTeam,AwayTeam,Referee"
 *   and pass via --csv-file.
 *
 * Workflow C (playwright/puppeteer bypass):
 *   Not implemented — install playwright + cookie-jar if you want live
 *   FBref access. High complexity for marginal benefit.
 *
 * Live-scrape (only use when FBref isn't blocking your IP):
 *   node scripts/scrape-referees.mjs --league bundesliga --try-fetch
 *
 * Flags:
 *   --league <code>   FODZE league key (required)
 *   --season <s>      Short-code season ("2526")
 *   --csv-file <p>    Read rows from CSV instead of fetching FBref
 *   --try-fetch       Attempt live FBref fetch (usually fails with 403)
 *   --dry             Parse + preview; no DB write
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { slugifyReferee, resolveRefereeName } from "./_lib/referee-aliases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader ─────────────────────────────────────────────────────
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

// ─── CLI args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LEAGUE = argValue("--league");
const SEASON = argValue("--season") || currentSeason();
const DRY = args.includes("--dry");
const CSV_FILE = argValue("--csv-file");
const TRY_FETCH = args.includes("--try-fetch");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function currentSeason() {
  // "2526" for 2025/26 (current). FBref uses "2025-2026" in URLs.
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const startYear = mo >= 6 ? y : y - 1; // season flips in July
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

function fbrefSeason(shortSeason) {
  // "2526" → "2025-2026"
  if (shortSeason.length !== 4) return shortSeason;
  const start = `20${shortSeason.slice(0, 2)}`;
  const end = `20${shortSeason.slice(2, 4)}`;
  return `${start}-${end}`;
}

// ─── FBref league map (comp-id + schedule-slug) ─────────────────────
const FBREF_COMPS = {
  bundesliga: { id: 20, slug: "Bundesliga" },
  bundesliga2: { id: 33, slug: "2-Bundesliga" },
  liga3: { id: 59, slug: "3-Liga" },
  epl: { id: 9, slug: "Premier-League" },
  championship: { id: 10, slug: "Championship" },
  league_one: { id: 15, slug: "League-One" },
  league_two: { id: 16, slug: "League-Two" },
  la_liga: { id: 12, slug: "La-Liga" },
  la_liga2: { id: 17, slug: "Segunda-Division" },
  serie_a: { id: 11, slug: "Serie-A" },
  serie_b: { id: 18, slug: "Serie-B" },
  ligue_1: { id: 13, slug: "Ligue-1" },
  ligue_2: { id: 60, slug: "Ligue-2" },
  eredivisie: { id: 23, slug: "Eredivisie" },
  jupiler_pro: { id: 37, slug: "Belgian-Pro-League" },
  primeira_liga: { id: 32, slug: "Primeira-Liga" },
  super_lig: { id: 26, slug: "Super-Lig" },
  greek_sl: { id: 27, slug: "Super-League-Greece" },
  scottish_prem: { id: 40, slug: "Scottish-Premiership" },
};

// League → average yellows/game bootstrap (mirrors LEAGUE_AVG_CARDS
// in src/lib/dixon-coles.ts — kept local because .mjs can't import TS).
const LEAGUE_AVG_YELLOWS = {
  bundesliga: 3.8, bundesliga2: 3.9, liga3: 3.7,
  epl: 3.2, championship: 3.4, league_one: 3.4, league_two: 3.5,
  la_liga: 4.5, la_liga2: 4.4, serie_a: 4.2, serie_b: 4.2,
  ligue_1: 3.6, ligue_2: 3.6,
  eredivisie: 3.5, jupiler_pro: 3.7, primeira_liga: 4.0,
  super_lig: 4.4, greek_sl: 4.3, scottish_prem: 3.3,
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// FBref soft-limits around 10 req/min. 6-second gap is safe and doesn't
// bog down a single-league run (one URL fetched, done).
const RATE_LIMIT_MS = 6000;
let _nextAllowedAt = 0;

async function gentleFetch(url) {
  const wait = Math.max(0, _nextAllowedAt - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _nextAllowedAt = Date.now() + RATE_LIMIT_MS;
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-GB,en;q=0.9,de;q=0.5",
    },
    signal: AbortSignal.timeout(15000),
  });
}

// ─── HTML parse: extract referees from schedule table ───────────────
//
// FBref schedule rows look like:
//   <tr>
//     <th ... data-stat="gameweek">3</th>
//     <td data-stat="dayofweek">Sat</td>
//     <td data-stat="date"><a href="/en/matches/...">2025-09-13</a></td>
//     ...
//     <td data-stat="referee">Felix Zwayer</td>
//     ...
//   </tr>
//
// We extract data-stat="referee" cell values with a simple regex — FBref
// keeps the data-stat attribute stable across redesigns because their own
// CSV export depends on it.
function extractReferees(html) {
  const refs = [];
  // Matches <td data-stat="referee" ...>Name</td> — also handles the rarer
  // <a href>-wrapped referee link variant.
  const re = /<td[^>]*data-stat="referee"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cellHtml = m[1];
    const text = cellHtml.replace(/<[^>]+>/g, "").trim();
    if (text && text !== "") refs.push(text);
  }
  return refs;
}

function aggregateReferees(rawNames) {
  const counts = {};
  for (const raw of rawNames) {
    const canonical = resolveRefereeName(raw);
    const slug = slugifyReferee(canonical);
    if (!slug) continue;
    if (!counts[slug]) counts[slug] = { name: canonical, slug, matches: 0 };
    counts[slug].matches++;
  }
  return Object.values(counts).sort((a, b) => b.matches - a.matches);
}

// ─── CSV fallback source (Workflow A / B from header) ──────────────
function extractRefereesFromCsv(csvPath) {
  const text = readFileSync(csvPath, "utf-8");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const refIdx = headers.findIndex(h => /^referee$/i.test(h));
  if (refIdx < 0) {
    die(`CSV header has no "Referee" column. Found: ${headers.join(", ")}`);
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted cells with embedded commas (rare but possible).
    const cells = lines[i].match(/("[^"]*"|[^,]*)(?:,|$)/g)?.map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").trim()) || [];
    const name = cells[refIdx];
    if (name) out.push(name);
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  if (!LEAGUE) die("--league is required (e.g. --league bundesliga)");
  const comp = FBREF_COMPS[LEAGUE];
  if (!comp) die(`Unsupported league "${LEAGUE}". Supported: ${Object.keys(FBREF_COMPS).join(", ")}`);

  const leagueAvg = LEAGUE_AVG_YELLOWS[LEAGUE] ?? 3.8;
  let rawNames;

  if (CSV_FILE) {
    console.log(`[referees] reading from CSV ${CSV_FILE}`);
    rawNames = extractRefereesFromCsv(CSV_FILE);
  } else if (TRY_FETCH) {
    const url = `https://fbref.com/en/comps/${comp.id}/${fbrefSeason(SEASON)}/schedule/${fbrefSeason(SEASON)}-${comp.slug}-Scores-and-Fixtures`;
    console.log(`[referees] try-fetch ${LEAGUE} ${SEASON} url=${url}`);
    try {
      const resp = await gentleFetch(url);
      if (!resp.ok) die(`FBref HTTP ${resp.status} — Cloudflare usually blocks with 403. Use --csv-file instead (see script header).`);
      const html = await resp.text();
      rawNames = extractReferees(html);
    } catch (e) {
      die(`Fetch failed: ${e.message || e}`);
    }
  } else {
    console.error("[referees] direct FBref fetch is blocked by Cloudflare (HTTP 403).");
    console.error("[referees] Either:");
    console.error("[referees]   (a) pass --csv-file <path> with an R-exported CSV (see script header)");
    console.error("[referees]   (b) pass --try-fetch to attempt a live FBref fetch anyway");
    process.exit(0);  // exit clean so a refresh-all cron doesn't fail on this
  }

  console.log(`[referees] extracted ${rawNames.length} referee cells`);
  if (rawNames.length === 0) {
    console.warn("[referees] no referees found — CSV may be empty or FBref HTML layout changed");
    return;
  }

  const refs = aggregateReferees(rawNames);
  console.log(`[referees] aggregated ${refs.length} unique referees`);
  for (const r of refs.slice(0, 10)) {
    console.log(`  ${r.name.padEnd(30)} ${r.matches} matches`);
  }
  if (refs.length > 10) console.log(`  …and ${refs.length - 10} more`);

  if (DRY) {
    console.log("[referees] --dry → skipping upsert");
    return;
  }

  // ─── Upsert to Supabase ──────────────────────────────────────────
  // Use the service key (bypasses RLS). FODZE's convention across all
  // scripts is SUPABASE_SERVICE_KEY or FODZE_SERVICE_KEY — checking both
  // to stay forward-compatible. The anon key is INSUFFICIENT for writes
  // because the `referees` RLS policy only allows SELECT from authenticated
  // users; INSERT/UPDATE require service-role.
  const url_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.FODZE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url_ || !key) die("Supabase env missing (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY)");

  const supabase = createClient(url_, key);
  const rows = refs.map((r) => ({
    referee_name: r.name,
    referee_slug: r.slug,
    league: LEAGUE,
    season: SEASON,
    fouls_per_game: null, // not-yet-scraped; engine falls back to Liga-Avg
    yellows_per_game: leagueAvg, // bootstrap from Liga-Avg until match-detail scrape
    reds_per_game: null,
    pens_per_game: null,
    home_yellow_bias: 1.0, // neutral prior
    home_pen_bias: 1.0,
    matches_analyzed: r.matches,
    source: CSV_FILE ? "csv-import" : "fbref-schedule",
    last_updated: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("referees")
    .upsert(rows, { onConflict: "referee_slug,league,season" });

  if (error) die(`Supabase upsert failed: ${error.message}`);
  console.log(`[referees] ✓ upserted ${rows.length} rows into referees (${LEAGUE} ${SEASON})`);
}

function die(msg) {
  console.error(`[referees] ERROR: ${msg}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("[referees] unhandled error:", e);
  process.exit(1);
});

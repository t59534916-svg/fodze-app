#!/usr/bin/env node
/**
 * FODZE Transfermarkt Team-ID Map Generator
 *
 * Scrapes Transfermarkt's league-overview pages to extract the full team
 * list per league (name + URL slug + numeric ID) and writes a ready-to-
 * use `scripts/_lib/transfermarkt-ids.mjs`.
 *
 * Running this by hand once per season (or after mid-season promotions)
 * is much faster than maintaining ~300 team entries by hand and avoids
 * the inevitable drift between what FODZE thinks a team is called vs
 * Transfermarkt's convention.
 *
 * Rate-limit: 2s between leagues (19 leagues × 2s = ~40s total). TM
 * has no hard limit on the league-overview endpoint from a browser UA.
 *
 * Usage:
 *   node scripts/build-tm-team-ids.mjs
 *   node scripts/build-tm-team-ids.mjs --league super_lig   # single league
 *   node scripts/build-tm-team-ids.mjs --dry                # print, don't write
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_PATH = resolve(__dirname, "_lib", "transfermarkt-ids.mjs");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const singleLeague = args.find((_, i) => args[i - 1] === "--league");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Maps FODZE league key → Transfermarkt league path. Each league has:
//   slug:  URL-safe name Transfermarkt uses in the path
//   code:  competition code (L1, TR1, ES1, etc.) — the actual DB primary key
// The full URL is https://www.transfermarkt.de/{slug}/startseite/wettbewerb/{code}
const LEAGUES = {
  bundesliga:     { slug: "bundesliga",             code: "L1"  },
  bundesliga2:    { slug: "2-bundesliga",           code: "L2"  },
  liga3:          { slug: "3-liga",                 code: "L3"  },
  epl:            { slug: "premier-league",         code: "GB1" },
  la_liga:        { slug: "laliga",                 code: "ES1" },
  serie_a:        { slug: "serie-a",                code: "IT1" },
  ligue_1:        { slug: "ligue-1",                code: "FR1" },
  eredivisie:     { slug: "eredivisie",             code: "NL1" },
  championship:   { slug: "championship",           code: "GB2" },
  primeira_liga:  { slug: "liga-portugal-bwin",     code: "PO1" },
  jupiler_pro:    { slug: "jupiler-pro-league",     code: "BE1" },
  super_lig:      { slug: "super-lig",              code: "TR1" },
  la_liga2:       { slug: "laliga2",                code: "ES2" },
  serie_b:        { slug: "serie-b",                code: "IT2" },
  ligue_2:        { slug: "ligue-2",                code: "FR2" },
  scottish_prem:  { slug: "scottish-premiership",   code: "SC1" },
  greek_sl:       { slug: "super-league-1",         code: "GR1" },
  league_one:     { slug: "league-one",             code: "GB3" },
  league_two:     { slug: "league-two",             code: "GB4" },
  austria_bl:     { slug: "admiral-bundesliga",     code: "A1"  },
  swiss_sl:       { slug: "super-league",           code: "C1"  },
  eerste_divisie: { slug: "keuken-kampioen-divisie", code: "NL2" },
};

// ─── Scraper ─────────────────────────────────────────────────────────

async function fetchLeaguePage(slug, code) {
  const url = `https://www.transfermarkt.de/${slug}/startseite/wettbewerb/${code}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "de,de-DE;q=0.9,en;q=0.5",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// Extract { name, slug, id } for every team on the league overview.
// The reliable signal in Transfermarkt HTML is the badge-image anchor:
//   <a href="/TEAM-SLUG/startseite/verein/NUMBER/..." ...>
//     <img ... alt="TEAM-NAME" ...>
//   </a>
// We dedupe by ID and take the first occurrence's alt-text (which is the
// official display name in Transfermarkt's German portal).
// HTML-entity decode for the alt= attribute. TM emits `&amp;` for `&`
// (Brighton & Hove Albion was hitting this) plus the usual umlauts as
// numeric refs like `&#252;`. Without this the name leaks "amp" into
// the registry key and the lookup never matches the FODZE display name.
function htmlDecode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function extractTeams(html) {
  const rx = /href="\/([a-z0-9-]+)\/startseite\/verein\/(\d+)[^"]*"[^>]*>[^<]*<img[^>]+alt="([^"]+)"/g;
  const seen = new Map();
  let m;
  while ((m = rx.exec(html)) !== null) {
    const [, slug, id, name] = m;
    if (seen.has(id)) continue;
    seen.set(id, { name: htmlDecode(name).trim(), slug, id });
  }
  return Array.from(seen.values());
}

// ─── Output formatter ────────────────────────────────────────────────

function formatMjs(leagueGroups) {
  const header = `// ═══════════════════════════════════════════════════════════════════════
// FODZE Transfermarkt Team-ID Map
//
// GENERATED by scripts/build-tm-team-ids.mjs — do not edit by hand.
// Re-run when teams get promoted / relegated or to refresh drift.
//
// Transfermarkt URL pattern for injuries + suspensions + yellow-card risk:
//   https://www.transfermarkt.de/{slug}/sperrenundverletzungen/verein/{id}
//
// Keys are Transfermarkt's display name in German — the scraper's lookup
// helper does fuzzy matching so minor drift against FODZE names is OK.
// ═══════════════════════════════════════════════════════════════════════

export const TRANSFERMARKT_IDS = {
`;

  const body = [];
  for (const [leagueKey, teams] of Object.entries(leagueGroups)) {
    if (teams.length === 0) continue;
    body.push(`  // ─── ${leagueKey} (${teams.length} teams) ───`);
    for (const t of teams) {
      // Align columns visually for readability
      const nameLit = JSON.stringify(t.name).padEnd(50);
      const slugLit = JSON.stringify(t.slug).padEnd(45);
      body.push(`  [${nameLit}]: { slug: ${slugLit}, id: ${t.id} },`);
    }
    body.push("");
  }

  const footer = `};

import { TRANSFERMARKT_ALIASES } from "./transfermarkt-aliases.mjs";

/**
 * Normalise a FODZE team name to match this map's keys. Light touch —
 * strips common prefixes that drift ("TSG 1899 Hoffenheim" vs "TSG
 * Hoffenheim") and does case-insensitive + substring fallback. The
 * TRANSFERMARKT_ALIASES bridge handles the cases substring can't (e.g.
 * "Hertha Berlin" → "Hertha BSC", "FC Zurich" → "FC Zürich").
 */
export function resolveTransfermarktRef(teamName) {
  if (!teamName) return null;
  if (TRANSFERMARKT_IDS[teamName]) return TRANSFERMARKT_IDS[teamName];
  // Alias bridge — explicit FODZE/Odds-API → TM canonical mapping
  const aliased = TRANSFERMARKT_ALIASES[teamName];
  if (aliased && TRANSFERMARKT_IDS[aliased]) return TRANSFERMARKT_IDS[aliased];
  const lower = teamName.toLowerCase();
  for (const [k, v] of Object.entries(TRANSFERMARKT_IDS)) {
    if (k.toLowerCase() === lower) return v;
  }
  // Substring match after stripping common club prefixes
  const cleaned = teamName.replace(/\\b(FC|SC|SV|TSG|VfB|VfL|RB|1\\.)\\b\\s*/g, "").trim().toLowerCase();
  if (cleaned.length >= 4) {
    for (const [k, v] of Object.entries(TRANSFERMARKT_IDS)) {
      const kc = k.replace(/\\b(FC|SC|SV|TSG|VfB|VfL|RB|1\\.)\\b\\s*/g, "").trim().toLowerCase();
      if (kc === cleaned || (kc.length >= 4 && (kc.includes(cleaned) || cleaned.includes(kc)))) {
        return v;
      }
    }
  }
  return null;
}
`;

  return header + body.join("\n") + "\n" + footer;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const leagueKeys = singleLeague ? [singleLeague] : Object.keys(LEAGUES);
  console.log(`🔨 Transfermarkt ID Map Builder`);
  console.log(`   Leagues: ${leagueKeys.length}${DRY ? " (DRY)" : ""}\n`);

  const leagueGroups = {};
  let totalTeams = 0;

  for (const key of leagueKeys) {
    const lg = LEAGUES[key];
    if (!lg) {
      console.warn(`   ⚠ Unknown league: ${key}`);
      continue;
    }
    try {
      const html = await fetchLeaguePage(lg.slug, lg.code);
      const teams = extractTeams(html);
      leagueGroups[key] = teams;
      totalTeams += teams.length;
      console.log(`   ✓ ${key.padEnd(16)} ${teams.length} teams   (${lg.slug})`);
    } catch (e) {
      console.warn(`   ✗ ${key.padEnd(16)} ${e.message}`);
      leagueGroups[key] = [];
    }
    // Gentle pacing between leagues — TM has no overt rate limit on the
    // overview but we don't want to look like a bot.
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n   Total: ${totalTeams} unique teams across ${leagueKeys.length} leagues`);

  const mjsContent = formatMjs(leagueGroups);
  if (DRY) {
    console.log("\n--- Generated transfermarkt-ids.mjs (DRY, first 40 lines) ---");
    console.log(mjsContent.split("\n").slice(0, 40).join("\n"));
    console.log("...");
    return;
  }

  writeFileSync(OUT_PATH, mjsContent);
  console.log(`\n   ✅ Written to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

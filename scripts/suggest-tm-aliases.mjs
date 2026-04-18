#!/usr/bin/env node
/**
 * FODZE TM Alias Suggester
 * ═══════════════════════
 * Reads missing-tm-aliases.log (appended by generate-matchday.mjs every
 * time a team can't be resolved to a Transfermarkt ID) and suggests
 * alias entries by searching Transfermarkt for each name.
 *
 * Output is a ready-to-paste snippet for transfermarkt-aliases.mjs.
 * Human review still required — the TM search can return multiple
 * matches and picking the right one needs judgement (e.g. is "Sporting"
 * → Sporting Lissabon or Sporting Gijón?).
 *
 * Usage:
 *   npm run suggest-aliases
 *   node scripts/suggest-tm-aliases.mjs
 *   node scripts/suggest-tm-aliases.mjs --league super_lig   # filter
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "..", "missing-tm-aliases.log");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";

const args = process.argv.slice(2);
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");
const CLEAR = args.includes("--clear");

// ─── Load log ──────────────────────────────────────────────────────

if (!existsSync(LOG_PATH)) {
  console.log("No missing-tm-aliases.log yet — nothing to suggest.");
  console.log("Run `node scripts/generate-matchday.mjs --league X --injuries`");
  console.log("and come back here when some teams fail to resolve.");
  process.exit(0);
}

const lines = readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
const byTeam = new Map();
for (const line of lines) {
  const [ts, league, team] = line.split("\t");
  if (!team || (leagueFilter && league !== leagueFilter)) continue;
  if (!byTeam.has(team)) byTeam.set(team, { league, first: ts, count: 0 });
  byTeam.get(team).count++;
}

if (byTeam.size === 0) {
  console.log(`No missing teams${leagueFilter ? ` for league ${leagueFilter}` : ""}.`);
  process.exit(0);
}

console.log(`🔎 Analysing ${byTeam.size} unmapped teams across ${new Set([...byTeam.values()].map(v => v.league)).size} leagues\n`);

// ─── TM search ─────────────────────────────────────────────────────

async function searchTM(query) {
  const url = `https://www.transfermarkt.de/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(query)}&Verein_page=1`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "de-DE,de;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    // Parse search-result rows — each linked team appears as
    //   <a title="Team Name" href="/slug/startseite/verein/ID">
    const rows = [];
    const rx = /<a[^>]+title="([^"]+)"[^>]+href="\/([a-z0-9-]+)\/startseite\/verein\/(\d+)[^"]*"/g;
    const seen = new Set();
    let m;
    while ((m = rx.exec(html)) !== null) {
      const [, name, slug, id] = m;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ name: name.trim(), slug, id });
      if (rows.length >= 5) break;
    }
    return rows;
  } catch {
    return [];
  }
}

// ─── Main ──────────────────────────────────────────────────────────

console.log("// Paste into scripts/_lib/transfermarkt-aliases.mjs");
console.log("// ═══════════════════════════════════════════════════");
console.log("");

const suggestions = [];
let i = 0;
for (const [team, info] of byTeam.entries()) {
  i++;
  process.stderr.write(`\r  [${i}/${byTeam.size}] searching "${team}"...                 `);
  const results = await searchTM(team);
  await new Promise((r) => setTimeout(r, 1500)); // rate-limit
  if (results.length === 0) {
    suggestions.push(`  // [${info.league}] "${team}" — no search results on Transfermarkt`);
    continue;
  }
  const first = results[0];
  const alts = results.slice(1, 3).map(r => r.name).join(", ");
  suggestions.push(
    `  ["${team}"]:${" ".repeat(Math.max(1, 28 - team.length))}"${first.name}",   // ${info.league}${alts ? ` · alt: ${alts}` : ""}`,
  );
}
process.stderr.write("\r" + " ".repeat(80) + "\r");

console.log(suggestions.join("\n"));
console.log("");
console.log(`// ${suggestions.length} suggestions — review each line and confirm the TM name`);
console.log(`// is the one that actually appears as a key in TRANSFERMARKT_IDS.`);
console.log(`// After pasting, re-run generate-matchday to verify.`);

if (CLEAR) {
  writeFileSync(LOG_PATH, "");
  console.error(`\n[log cleared]`);
}

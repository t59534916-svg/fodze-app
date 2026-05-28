#!/usr/bin/env node
/**
 * Backfill Pinnacle close odds from odds_closing_history → match_prematch_signals.
 *
 * Why a Node script not pure SQL: the two tables use different match_key
 * formats. odds_closing_history uses raw football-data.co.uk team names
 * (e.g. "Man United", "Wolves"), while match_prematch_signals uses
 * canonical FODZE names ("Manchester United", "Wolverhampton Wanderers").
 * The canonicalization logic lives in scripts/_lib/canonical-team.mjs.
 * Bridging in JS is the cleanest path.
 *
 * Strategy:
 *   1. Pull odds_closing_history rows with non-null psch + psc_over25
 *   2. Canonicalize och team names → join key
 *   3. Pull match_prematch_signals (already canonical names)
 *   4. Match by (league, match_date, canonical_home, canonical_away)
 *   5. Batch UPDATE match_prematch_signals.pinnacle_close_* fields
 *
 * Usage:
 *   node scripts/backfill-pinnacle-close-to-mps.mjs           # live update
 *   node scripts/backfill-pinnacle-close-to-mps.mjs --dry     # preview
 *   node scripts/backfill-pinnacle-close-to-mps.mjs --season 24/25  # filter
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { canonicalize } from "./_lib/canonical-team.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SEASON_FILTER = (() => {
  const i = args.indexOf("--season");
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
})();

const HDRS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

async function pull(table, select, filters = "") {
  const out = [];
  let offset = 0;
  while (true) {
    const url = `${SUPA_URL}/rest/v1/${table}?select=${select}${filters}&limit=1000&offset=${offset}`;
    const r = await fetch(url, { headers: HDRS });
    if (!r.ok) throw new Error(`${table} pull ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
    if (offset > 200000) { console.warn(`  ⚠ stopped at ${offset}`); break; }
  }
  return out;
}

async function batchUpdate(rows, batchSize = 500) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const url = `${SUPA_URL}/rest/v1/match_prematch_signals?on_conflict=league,match_date,home_team,away_team`;
    const r = await fetch(url, {
      method: "POST",
      headers: { ...HDRS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(slice),
    });
    if (!r.ok) {
      console.error(`  ✗ batch ${i}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      continue;
    }
    written += slice.length;
    process.stdout.write(`\r  upserted ${written}/${rows.length}`);
  }
  process.stdout.write("\n");
  return written;
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Backfill Pinnacle close → match_prematch_signals                ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);
  console.log(`  Mode: ${DRY ? "DRY-RUN" : "LIVE"}`);
  if (SEASON_FILTER) console.log(`  Season filter: ${SEASON_FILTER}`);

  console.log(`\n[1/4] Pulling odds_closing_history (Pinnacle-populated rows)...`);
  const och = await pull(
    "odds_closing_history",
    "league,match_date,home_team,away_team,psch,pscd,psca,psc_over25,psc_under25",
    "&psch=not.is.null&match_date=gte.2021-07-01"
  );
  console.log(`  ${och.length.toLocaleString()} rows pulled`);

  // Build lookup: (league, match_date, canonical_home, canonical_away) → Pinnacle odds
  console.log(`\n[2/4] Canonicalizing och team-names + building lookup...`);
  const lookup = new Map();
  for (const r of och) {
    const cHome = canonicalize(r.home_team, r.league);
    const cAway = canonicalize(r.away_team, r.league);
    const key = `${r.league}|${r.match_date}|${cHome}|${cAway}`;
    lookup.set(key, r);
  }
  console.log(`  ${lookup.size.toLocaleString()} unique keys in lookup`);

  console.log(`\n[3/4] Pulling match_prematch_signals to update...`);
  const mpsFilter = SEASON_FILTER
    ? `&season=eq.${encodeURIComponent(SEASON_FILTER)}`
    : "";
  const mps = await pull(
    "match_prematch_signals",
    "league,match_date,home_team,away_team,pinnacle_close_over25",
    mpsFilter
  );
  console.log(`  ${mps.length.toLocaleString()} mps rows`);

  // Match + build update payloads
  console.log(`\n[4/4] Matching mps × och via canonical keys...`);
  const updates = [];
  let matched = 0, alreadyPopulated = 0;
  for (const row of mps) {
    const key = `${row.league}|${row.match_date}|${row.home_team}|${row.away_team}`;
    const odds = lookup.get(key);
    if (!odds) continue;
    matched++;
    if (row.pinnacle_close_over25 != null) { alreadyPopulated++; continue; }
    // PostgREST merge-duplicates requires NOT NULL fields in payload.
    // Reconstruct canonical match_key (matches src/lib/format.ts::matchKey).
    const cleanH = row.home_team.toLowerCase().replace(/\s/g, "");
    const cleanA = row.away_team.toLowerCase().replace(/\s/g, "");
    const matchKey = `${row.league}:${cleanH}-${cleanA}`;
    updates.push({
      match_key: matchKey,
      league: row.league,
      match_date: row.match_date,
      home_team: row.home_team,
      away_team: row.away_team,
      pinnacle_close_over25: odds.psc_over25 != null ? Number(odds.psc_over25) : null,
      pinnacle_close_under25: odds.psc_under25 != null ? Number(odds.psc_under25) : null,
      pinnacle_close_h: odds.psch != null ? Number(odds.psch) : null,
      pinnacle_close_d: odds.pscd != null ? Number(odds.pscd) : null,
      pinnacle_close_a: odds.psca != null ? Number(odds.psca) : null,
    });
  }
  console.log(`  matched: ${matched.toLocaleString()} / ${mps.length.toLocaleString()} mps rows`);
  console.log(`  already populated: ${alreadyPopulated.toLocaleString()}`);
  console.log(`  updates to apply: ${updates.length.toLocaleString()}`);

  if (DRY) {
    console.log(`\n  (DRY) sample update:\n  ${JSON.stringify(updates[0] || {}, null, 2).slice(0, 300)}`);
    return;
  }

  if (updates.length === 0) {
    console.log(`\n  ✓ Nothing to update`);
    return;
  }

  console.log(`\n  Writing updates to Supabase...`);
  const written = await batchUpdate(updates);
  console.log(`\n✓ Done: ${written.toLocaleString()} rows updated with Pinnacle close odds`);
}

main().catch(e => { console.error(`\n✗ failed: ${e.stack || e.message}`); process.exit(1); });

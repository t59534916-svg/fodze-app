#!/usr/bin/env node
/**
 * FODZE — Fill missing team_metadata rows via TheSportsDB searchteams.php
 *
 * TheSportsDB's search_all_teams.php?l=<league> returnt nur die ersten
 * 10 Teams je Liga. Bundesliga hat 18 Teams, so 8 fehlen. Dieser Script
 * füllt die Lücken:
 *
 *   1. Lade alle Team-Namen aus matchdays.data.matches[] pro Liga
 *      (plus team_xg_history als Fallback für Saisons ohne matchdays)
 *   2. Für jeden Team der NICHT in team_metadata steht:
 *        searchteams.php?t=<name>  →  filter zu passendem strLeague
 *        →  parse + upsert
 *   3. Idempotent, kann mehrmals laufen
 *
 * Rate-Limit: ~2 calls/second to respect free-tier (Cloudflare 1015).
 * Ein Lauf für alle 19 Ligen mit je ~8 fehlenden Teams = ~150 calls =
 * ~75 seconds.
 *
 * Usage:
 *   node scripts/fill-thesportsdb-missing.mjs --all
 *   node scripts/fill-thesportsdb-missing.mjs --league bundesliga
 *   node scripts/fill-thesportsdb-missing.mjs --all --dry
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createThesportsdbClient,
  resolveThesportsdbLeague,
  THESPORTSDB_LEAGUES,
  parseTeamRecord,
} from "./_lib/thesportsdb.mjs";
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : f; };

const DRY = flag("dry");
const ALL = flag("all");
const VERBOSE = flag("verbose");
const LEAGUE = val("league", null);

let targetLeagues;
if (LEAGUE) targetLeagues = [LEAGUE];
else if (ALL) targetLeagues = Object.keys(THESPORTSDB_LEAGUES);
else { console.error("Usage: --league <key>  |  --all  [--dry]"); process.exit(1); }

if (!SUPA_URL || !SUPA_KEY) { console.error("❌ SUPABASE env fehlt"); process.exit(1); }

// ─── Supabase helpers ─────────────────────────────────────────
async function supaGet(pathAndQuery) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supaUpsert(rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/team_metadata?on_conflict=fodze_league,team_name`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
    },
  );
  if (!res.ok) throw new Error(`upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return rows.length;
}

// ─── Collect unique team names per league from matchdays + xg history ──

async function collectTeamNames(fodzeLeague) {
  const names = new Set();

  // 1. Aus matchdays.data.matches (zukünftig geplante Matches).
  // BUG-FIX (2026-04-29): column is `match_date`, not `date` — old query
  // silently 400'd via try/catch and contributed nothing. Without this
  // step, only team_xg_history sourced names, which (paired with the
  // limit=1000 PostgREST cap on history-heavy leagues) returned only
  // 5/20 EPL teams.
  try {
    const mds = await supaGet(
      `matchdays?select=data&league=eq.${encodeURIComponent(fodzeLeague)}&order=match_date.desc&limit=4`
    );
    for (const md of mds) {
      const matches = md?.data?.matches || [];
      for (const m of matches) {
        if (m?.home?.name) names.add(m.home.name);
        if (m?.away?.name) names.add(m.away.name);
      }
    }
  } catch { /* matchdays may be empty */ }

  // 2. Aus team_xg_history — restrict to current season AND paginate.
  // BUG-FIX (2026-04-29): without match_date filter, PostgREST 1000-row
  // cap returns the FIRST 1000 by insertion order — which for EPL is
  // 2017-era data with only ~5 teams populated. With currentSeasonStart
  // filter we get ~666 rows (well under 1000) covering all 20 active
  // teams. Pagination loop is defensive against future high-volume leagues.
  const SEASON_START = currentSeasonStart();
  try {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const rows = await supaGet(
        `team_xg_history?select=team&league=eq.${encodeURIComponent(fodzeLeague)}&match_date=gte.${SEASON_START}&limit=${PAGE}&offset=${offset}`
      );
      if (!rows || rows.length === 0) break;
      for (const r of rows) if (r?.team) names.add(r.team);
      offset += PAGE;
      if (rows.length < PAGE) break;
    }
  } catch { /* ignore */ }

  return [...names];
}

// Aug 1 of the current European season — same convention as score_current_season.py.
// Aug-Dec → current calendar year; Jan-Jul → previous calendar year.
function currentSeasonStart() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based: Aug=7
  return m >= 7 ? `${y}-08-01` : `${y - 1}-08-01`;
}

// ─── Match search result to the right league ─────────────────

function pickBestMatch(candidates, expectedLeagueName, expectedLeagueId, teamQuery) {
  if (!candidates || candidates.length === 0) return null;
  const leagueFields = ["strLeague","strLeague2","strLeague3","strLeague4","strLeague5","strLeague6","strLeague7"];

  // Tier 1: idLeague match — bulletproof, TheSportsDB returns idLeague
  // consistently from searchteams.php (verified live: Tottenham → idLeague=4328
  // for EPL). Avoids brittle string-matching of league-name variants.
  if (expectedLeagueId != null) {
    const wantId = Number(expectedLeagueId);
    for (const c of candidates) {
      if (c.idLeague && Number(c.idLeague) === wantId) return c;
    }
  }

  // Tier 2: strict league-name equality (legacy path, preserved for
  // candidates without idLeague populated)
  for (const c of candidates) {
    for (const f of leagueFields) {
      if (c[f] && c[f].toLowerCase() === expectedLeagueName.toLowerCase()) return c;
    }
  }

  // Tier 3: substring match on league-name — handles "Premier League" vs
  // "English Premier League" or "La Liga" vs "Spanish La Liga" variants.
  // Min length guard prevents "Premier" matching too eagerly into other comps.
  const wantLower = expectedLeagueName.toLowerCase();
  if (wantLower.length >= 8) {
    for (const c of candidates) {
      for (const f of leagueFields) {
        const got = c[f]?.toLowerCase();
        if (!got) continue;
        if (got.includes(wantLower) || wantLower.includes(got)) return c;
      }
    }
  }

  // Tier 4: Soccer + single-result fallback
  const soccer = candidates.filter(c => (c.strSport || "").toLowerCase() === "soccer");
  if (soccer.length === 1) return soccer[0];

  // Tier 5: exact team-name match within soccer results
  const exact = soccer.find(c => (c.strTeam || "").toLowerCase() === teamQuery.toLowerCase());
  return exact || null;
}

/**
 * Ableitung alternativer Suchbegriffe wenn der Original-Name bei
 * searchteams.php 0 Hits liefert. Beispiele:
 *   "Mainz 05"             → ["Mainz"]
 *   "M'gladbach"           → ["Gladbach", "Monchengladbach"]
 *   "Borussia M.Gladbach"  → ["Borussia Monchengladbach", "Gladbach"]
 *   "1. FC Heidenheim"     → ["Heidenheim"]
 *   "RasenBallsport Leipzig"→ ["RB Leipzig", "Leipzig"]
 */
function deriveSearchFallbacks(name) {
  const fallbacks = [];
  const push = (s) => { const v = s?.trim(); if (v && v !== name && !fallbacks.includes(v)) fallbacks.push(v); };

  // Kürze führende Prefixe wie "1.", "FC", "SC" etc.
  const stripped = name.replace(/^(\d+\.?\s+|FC\s+|SC\s+|SV\s+|VfL\s+|VfB\s+|TSG\s+|RB\s+)+/i, "");
  push(stripped);

  // Spezialfälle für Gladbach
  if (/gladbach/i.test(name)) {
    push("Monchengladbach");
    push("Borussia Monchengladbach");
  }
  // "Mainz 05" / "Mainz" etc
  if (/^mainz/i.test(name)) push("Mainz");
  // RasenBallsport → RB
  if (/rasenballsport/i.test(name)) push("RB Leipzig");

  // Letzter Token wenn > 3 chars (meist Stadt)
  const tokens = name.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (last && last.length > 3) push(last);

  return fallbacks;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — Fill missing team_metadata via searchteams      ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Leagues: ${targetLeagues.join(", ")}`);
  console.log(`  Mode:    ${DRY ? "DRY-RUN" : "LIVE"}\n`);

  const client = createThesportsdbClient({ verbose: VERBOSE });
  let grandTotalFound = 0;
  let grandTotalMatched = 0;
  let grandTotalNoMatch = 0;
  let grandTotalUpserted = 0;

  for (const fodzeLeague of targetLeagues) {
    const info = resolveThesportsdbLeague(fodzeLeague);
    if (!info) { console.log(`${fodzeLeague}: no mapping — skip`); continue; }

    console.log(`\n━━━ ${fodzeLeague} (expected: "${info.leagueName}") ━━━`);

    // 1. Welche Teams kennen wir?
    const candidateNames = await collectTeamNames(fodzeLeague);
    if (candidateNames.length === 0) {
      console.log(`  keine Team-Namen in matchdays/team_xg_history`);
      continue;
    }

    // 2. Welche sind schon in team_metadata?
    const existing = await supaGet(
      `team_metadata?select=team_name&fodze_league=eq.${encodeURIComponent(fodzeLeague)}`
    );
    const existingLC = new Set(existing.map(r => r.team_name.toLowerCase()));

    const missing = candidateNames.filter(n => !existingLC.has(n.toLowerCase()));
    console.log(`  ${candidateNames.length} Teams insgesamt · ${missing.length} fehlen in team_metadata`);
    if (missing.length === 0) continue;

    // 3. Pro fehlendem Team: searchteams (mit Fallback-Queries wenn 0 hits)
    const batch = [];
    for (const name of missing) {
      let best = null;
      const queries = [name, ...deriveSearchFallbacks(name)];
      for (const q of queries) {
        const res = await client.searchTeam(q);
        if (!res.ok) break;
        const hits = res.data?.teams || [];
        best = pickBestMatch(hits, info.leagueName, info.leagueId, name);
        if (best) {
          if (VERBOSE && q !== name) console.log(`    ↳ retry "${q}" hit ${best.strTeam}`);
          break;
        }
      }
      if (!best) {
        console.log(`    ? ${name}: keiner der Query-Varianten passte zur Liga`);
        grandTotalNoMatch++;
        continue;
      }
      const parsed = parseTeamRecord(best, fodzeLeague);
      if (parsed) {
        // canonicalize-on-write: source `name` came from matchdays/team_xg_history
        // which are post-2026-04-27 dedup-canonical, but defense-in-depth against
        // future alias-input (new-season imports before dedupe-pass).
        parsed.team_name = canonicalize(name, fodzeLeague);
        batch.push(parsed);
        grandTotalMatched++;
        if (VERBOSE) console.log(`    ✓ ${name} → ${best.strTeam} (id=${best.idTeam})`);
      }
      grandTotalFound++;
    }

    // Dedupe: wenn im batch mehrere rows für denselben (fodze_league,
    // team_name) sind — letztes gewinnt. Idempotent beim Upsert.
    const seen = new Set();
    const deduped = [];
    for (const r of batch) {
      const k = `${r.fodze_league}|${r.team_name.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }

    if (DRY) {
      console.log(`  (DRY) würde ${deduped.length} Teams upserten (${batch.length - deduped.length} duplicates deduped)`);
      for (const b of deduped.slice(0, 3)) {
        console.log(`    ${b.team_name}  logo=${b.logo_url?.slice(0, 70)}`);
      }
      continue;
    }

    if (deduped.length > 0) {
      try {
        const n = await supaUpsert(deduped);
        grandTotalUpserted += n;
        console.log(`  ✓ ${n} rows upserted (${batch.length - deduped.length} deduped)`);
      } catch (e) {
        console.log(`  ✗ upsert failed: ${e.message}`);
      }
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Done                                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  searchteams calls:  ${client.state.requestsDone}`);
  console.log(`  candidates found:   ${grandTotalFound}`);
  console.log(`  matched (league OK): ${grandTotalMatched}`);
  console.log(`  no-match:           ${grandTotalNoMatch}`);
  console.log(`  rows upserted:      ${grandTotalUpserted}${DRY ? " (DRY)" : ""}`);
}

main().catch(e => { console.error(`\n✗ failed: ${e.stack || e.message}`); process.exit(1); });

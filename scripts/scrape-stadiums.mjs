#!/usr/bin/env node
/**
 * FODZE Stadium Coordinates Scraper (Wikidata SPARQL)
 * ═══════════════════════════════════════════════════
 * Looks up each team's home stadium on Wikidata and upserts coordinates,
 * altitude, surface, and capacity into the `stadiums` table.
 *
 * Input set: distinct team names from `upcoming_fixtures` — so only
 * teams the odds pipeline already tracks get hit (no wasted queries).
 *
 * Rate: Wikidata Query Service (query.wikidata.org) has no documented
 * hard limit but asks for courteous use. 1 query per 1.2 s stays safely
 * under any soft throttle; full pipeline for ~400 teams completes in
 * <10 minutes (one-off per season).
 *
 * Usage:
 *   node scripts/scrape-stadiums.mjs --league bundesliga
 *   node scripts/scrape-stadiums.mjs --all --dry
 *   node scripts/scrape-stadiums.mjs --team "FC Bayern München"
 *
 * Flags:
 *   --league <code>   Scope to one league's distinct teams
 *   --all             All distinct teams across upcoming_fixtures
 *   --team <name>     Scrape exactly one team (for debugging)
 *   --dry             Parse + preview; no DB write
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ─── Env loader ────────────────────────────────────────────────────
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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY;

// ─── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argv = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const DRY = args.includes("--dry");
const ALL = args.includes("--all");
const LEAGUE = argv("--league");
const TEAM = argv("--team");

// ─── Wikidata SPARQL ──────────────────────────────────────────────
const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
// Wikidata requires a descriptive UA per their terms of service.
const USER_AGENT = "FODZE-stadium-scraper/1.0 (analysis; https://github.com/fodze-app)";
const RATE_MS = 1200;
let _nextAllowedAt = 0;

async function sparql(query) {
  const wait = Math.max(0, _nextAllowedAt - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _nextAllowedAt = Date.now() + RATE_MS;
  const url = `${WIKIDATA_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/sparql-results+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Wikidata HTTP ${resp.status}`);
  return resp.json();
}

// Parse a Wikidata Point("Point(lng lat)") literal into [lat, lng].
function parsePoint(wkt) {
  if (!wkt) return null;
  const m = wkt.match(/^Point\(\s*([-\d.]+)\s+([-\d.]+)\s*\)$/);
  if (!m) return null;
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

function buildQuery(teamName) {
  // Escape double-quotes in the team name before embedding. Wikidata
  // accepts UTF-8 directly, so German umlauts pass through untouched.
  const safe = teamName.replace(/"/g, '\\"');
  // Match any entity that has a home venue (P115) AND whose rdfs:label or
  // skos:altLabel matches the team name in EN, DE, IT, ES, FR, or PT.
  // This is looser than filtering on "instance of football club" but P115
  // effectively means "is a sports team" so false positives are rare.
  // The old query's property-path `wdt:P118 | wdt:P31/wdt:P279*` was
  // syntactically invalid — SPARQL needs parens around alternatives.
  return `
    SELECT ?team ?teamLabel ?stadium ?stadiumLabel ?coord ?altitude ?capacity ?surfaceLabel WHERE {
      ?team wdt:P115 ?stadium .
      { ?team rdfs:label "${safe}"@en . }
      UNION { ?team rdfs:label "${safe}"@de . }
      UNION { ?team rdfs:label "${safe}"@it . }
      UNION { ?team rdfs:label "${safe}"@es . }
      UNION { ?team rdfs:label "${safe}"@fr . }
      UNION { ?team rdfs:label "${safe}"@pt . }
      UNION { ?team skos:altLabel "${safe}"@en . }
      UNION { ?team skos:altLabel "${safe}"@de . }
      OPTIONAL { ?stadium wdt:P625 ?coord }
      OPTIONAL { ?stadium wdt:P2044 ?altitude }
      OPTIONAL { ?stadium wdt:P1083 ?capacity }
      OPTIONAL { ?stadium wdt:P8511 ?surface }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
    LIMIT 1
  `;
}

async function fetchStadiumFor(teamName) {
  let data;
  try {
    data = await sparql(buildQuery(teamName));
  } catch (e) {
    return { team: teamName, status: `sparql-${e.message || "err"}` };
  }
  const row = data?.results?.bindings?.[0];
  if (!row) return { team: teamName, status: "not-found" };
  const coord = parsePoint(row.coord?.value);
  if (!coord) return { team: teamName, status: "no-coord" };
  const qid = (row.stadium?.value || "").split("/").pop() || null;
  return {
    team: teamName,
    stadium_name: row.stadiumLabel?.value || null,
    lat: coord.lat,
    lng: coord.lng,
    altitude_m: row.altitude?.value ? Number(row.altitude.value) : null,
    capacity: row.capacity?.value ? parseInt(row.capacity.value, 10) : null,
    surface: row.surfaceLabel?.value || null,
    wikidata_qid: qid,
    source: "wikidata",
    status: "ok",
  };
}

// ─── Supabase helpers (fetch distinct teams + upsert) ──────────────
async function distinctTeams() {
  if (!SUPA_URL || !SUPA_KEY) throw new Error("Supabase creds missing");
  const filter = LEAGUE ? `&league=eq.${LEAGUE}` : "";
  const url = `${SUPA_URL}/rest/v1/upcoming_fixtures?select=home_team,away_team,league${filter}`;
  const resp = await fetch(url, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
  if (!resp.ok) throw new Error(`upcoming_fixtures GET ${resp.status}`);
  const rows = await resp.json();
  const set = new Set();
  for (const r of rows) {
    if (r.home_team) set.add(r.home_team);
    if (r.away_team) set.add(r.away_team);
  }
  return Array.from(set).sort();
}

async function upsertOne(payload) {
  // PostgREST needs on_conflict in the URL to route a POST as UPSERT when
  // a uniqueness violation would otherwise 409. Without this flag Supabase
  // treats the request as a pure INSERT and rejects the row.
  const resp = await fetch(`${SUPA_URL}/rest/v1/stadiums?on_conflict=team`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      team: payload.team,
      stadium_name: payload.stadium_name,
      lat: payload.lat,
      lng: payload.lng,
      altitude_m: payload.altitude_m,
      capacity: payload.capacity,
      surface: payload.surface,
      wikidata_qid: payload.wikidata_qid,
      source: payload.source,
      last_updated: new Date().toISOString(),
    }),
  });
  if (!resp.ok) throw new Error(`upsert ${resp.status}: ${await resp.text()}`);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  let teams;
  if (TEAM) {
    teams = [TEAM];
  } else if (ALL || LEAGUE) {
    console.log(`[stadium] loading distinct teams from upcoming_fixtures${LEAGUE ? ` (league=${LEAGUE})` : ""}`);
    teams = await distinctTeams();
  } else {
    console.error("Usage: --league <code> | --all | --team <name>");
    process.exit(1);
  }
  console.log(`[stadium] ${teams.length} teams to scrape`);

  let ok = 0, fail = 0;
  for (const t of teams) {
    const r = await fetchStadiumFor(t);
    if (r.status === "ok") {
      console.log(`  ✓ ${t.padEnd(32)} → ${r.stadium_name ?? "?"} (${r.lat}, ${r.lng})`);
      if (!DRY) {
        try { await upsertOne(r); } catch (e) {
          fail++;
          console.warn(`  ⚠ upsert ${t}: ${e.message}`);
          continue;
        }
      }
      ok++;
    } else {
      fail++;
      console.warn(`  · ${t.padEnd(32)} ${r.status}`);
    }
  }
  console.log();
  console.log(`[stadium] DONE — ok=${ok} fail=${fail}${DRY ? " (DRY)" : ""}`);
}

main().catch(e => {
  console.error("[stadium] unhandled:", e);
  process.exit(1);
});

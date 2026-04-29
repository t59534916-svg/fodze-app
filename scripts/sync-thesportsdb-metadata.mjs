#!/usr/bin/env node
/**
 * FODZE — TheSportsDB Team-Metadata Sync
 *
 * Pulls team metadata (logos, colors, venue, stable IDs) from TheSportsDB
 * for all FODZE leagues and upserts into the `team_metadata` Supabase
 * table. One call per league = 19 calls total (no rate-limit concerns).
 *
 * Daten die wir befüllen:
 *   - thesportsdb_id (stabile cross-source Anchor-ID)
 *   - logo_url + jersey_url (für UI-Badges)
 *   - stadium, stadium_city, stadium_capacity (für potenzielle future-
 *     features wie weather-adjusted home-factor)
 *   - colors (für Match-Card Accent-Tint)
 *   - founded_year, description (für Info-Tooltips)
 *
 * Idempotent via UPSERT on (fodze_league, team_name).
 *
 * Usage:
 *   node scripts/sync-thesportsdb-metadata.mjs --all
 *   node scripts/sync-thesportsdb-metadata.mjs --league bundesliga
 *   node scripts/sync-thesportsdb-metadata.mjs --all --dry
 *
 * ENV (.env.local):
 *   THESPORTSDB_KEY          # optional, default = "123" (free public test key)
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY
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

// ─── .env.local ─────────────────────────────────────────────────
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

// ─── CLI ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const DRY = flag("dry");
const ALL = flag("all");
const VERBOSE = flag("verbose");
const LEAGUE = val("league", null);

let targetLeagues;
if (LEAGUE) {
  targetLeagues = [LEAGUE];
} else if (ALL) {
  targetLeagues = Object.keys(THESPORTSDB_LEAGUES);
} else {
  console.error("Usage: --league <key>  |  --all  [--dry] [--verbose]");
  process.exit(1);
}

if (!DRY && (!SUPA_URL || !SUPA_KEY)) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY fehlen");
  process.exit(1);
}

// ─── Supabase helpers ──────────────────────────────────────────
async function supaUpsert(rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(
    `${SUPA_URL}/rest/v1/team_metadata?on_conflict=fodze_league,team_name`,
    {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase upsert ${res.status}: ${body.slice(0, 300)}`);
  }
  return rows.length;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  FODZE — TheSportsDB Team-Metadata Sync                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  Leagues: ${targetLeagues.join(", ")}`);
  console.log(`  Mode:    ${DRY ? "DRY-RUN" : "LIVE"}\n`);

  const client = createThesportsdbClient({ verbose: VERBOSE });
  let totalUpserted = 0;
  let totalMissed = 0;

  for (const fodzeLeague of targetLeagues) {
    const info = resolveThesportsdbLeague(fodzeLeague);
    if (!info) {
      console.log(`${fodzeLeague}: no TheSportsDB mapping — skip`);
      totalMissed++;
      continue;
    }
    console.log(`\n━━━ ${fodzeLeague}  ↔  "${info.leagueName}" (id=${info.leagueId}) ━━━`);

    // Wir nutzen search_all_teams?l=<name> obwohl es auf 10 Teams limitiert,
    // weil lookup_all_teams?id=<leagueId> in TheSportsDB v1 offenbar einen
    // Bug hat (returnt teils falsche Liga — id=4331 liefert English League
    // One Teams trotz korrektem Liga-Name). 10 Top-Teams pro Liga decken
    // den Großteil unserer betting-relevanten Matches ab; fehlende kleine
    // Clubs bekommen weiterhin Text-Fallback in der UI.
    const res = await client.searchAllTeams(info.leagueName);
    if (!res.ok) {
      console.log(`  ! fetch failed: ${res.error}`);
      totalMissed++;
      continue;
    }
    const teams = res.data?.teams;
    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      console.log(`  ⚠ keine Teams zurück — Liga-ID stimmt evtl. nicht. ` +
                  `Check https://www.thesportsdb.com/api/v1/json/123/lookup_all_teams.php?id=${info.leagueId}`);
      totalMissed++;
      continue;
    }

    const rows = teams
      .map(t => parseTeamRecord(t, fodzeLeague))
      .filter(Boolean)
      // canonicalize-on-write: TheSportsDB returns names like "Bayern Munich"
      // which the FODZE TEAM_REGISTRY canonicalizes to "Bayern München".
      // Without this, sync creates an alias-row that dedupe-team-metadata
      // would have to merge later — better to write canonical from the start.
      .map(r => ({ ...r, team_name: canonicalize(r.team_name, fodzeLeague) }));

    console.log(`  ${rows.length} Teams geparsed`);

    // Coverage-Report
    const withLogo = rows.filter(r => r.logo_url).length;
    const withVenue = rows.filter(r => r.stadium).length;
    const withColors = rows.filter(r => r.color_primary).length;
    console.log(`  Coverage: ${withLogo}/${rows.length} Logo · ${withVenue}/${rows.length} Venue · ${withColors}/${rows.length} Colors`);

    if (DRY) {
      if (rows.length > 0) {
        console.log(`  Sample: ${JSON.stringify({
          team: rows[0].team_name,
          logo: rows[0].logo_url?.slice(0, 60),
          venue: rows[0].stadium,
          capacity: rows[0].stadium_capacity,
          colors: rows[0].color_primary,
        }, null, 2).slice(0, 400)}`);
      }
      continue;
    }

    try {
      const written = await supaUpsert(rows);
      totalUpserted += written;
      console.log(`  ✓ ${written} rows upserted`);
    } catch (e) {
      console.log(`  ✗ upsert failed: ${e.message}`);
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Done                                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  TheSportsDB calls:  ${client.state.requestsDone}`);
  console.log(`  Leagues synced:     ${targetLeagues.length - totalMissed}`);
  console.log(`  Leagues missed:     ${totalMissed}`);
  console.log(`  Rows upserted:      ${totalUpserted}${DRY ? " (DRY)" : ""}`);
}

main().catch(e => {
  console.error(`\n✗ failed: ${e.stack || e.message}`);
  process.exit(1);
});

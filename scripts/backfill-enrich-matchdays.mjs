#!/usr/bin/env node
/**
 * FODZE Matchday Enrichment Backfill
 *
 * Re-enriches every stored matchday in `matchdays` with:
 *   • xg_h8 / xga_h8 / xg_h_history from team_xg_history (was 0 for most)
 *   • form string (W/D/L over last 5 results) — was "" everywhere
 *   • tags (DERBY, ROTATION) — was [] everywhere
 *
 * Why needed: generate-matchday.mjs used to persist skelett JSONs and rely
 * on MatchdayContext re-enriching in the browser on every visit. That left
 * the stored matchdays structurally empty, which broke any code path that
 * reads Supabase directly (Goldilocks engine-edge, fuck-betting fallback,
 * audit metrics). This script catches up the existing rows once; new ones
 * are enriched at generation time.
 *
 * Idempotent: running it again rewrites with the same data, safe to cron.
 * Only touches the `data` column — label/date/created_at/created_by untouched.
 *
 * Usage:
 *   node scripts/backfill-enrich-matchdays.mjs            # all leagues
 *   node scripts/backfill-enrich-matchdays.mjs --league bundesliga
 *   node scripts/backfill-enrich-matchdays.mjs --dry      # preview
 *   node scripts/backfill-enrich-matchdays.mjs --latest   # only newest per league
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  lookupTeamXG, deriveForm, deriveTags,
  computeStandingsFromXG, findStanding, deriveStandingsTags,
  deriveH2H, loadOpenLigaDBSeason, findOpenLigaMatch, inferMatchdayLabel,
} from "./_lib/matchday-enrich.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
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
if (!SUPA_URL || !SUPA_KEY) {
  console.error("❌ Missing SUPABASE env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LATEST_ONLY = args.includes("--latest");
const leagueFilter = args.find((_, i) => args[i - 1] === "--league");

const SUPA_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  "Content-Type": "application/json",
};

// ─── Helpers ──────────────────────────────────────────────────────

async function loadMatchdays(league) {
  const base = `${SUPA_URL}/rest/v1/matchdays?select=id,league,matchday_label,match_date,data,created_at`;
  const params = [];
  if (league) params.push(`league=eq.${league}`);
  params.push("order=created_at.desc");
  // Raise the limit — default is 1000 but we'd like all of them so nothing
  // is silently skipped. --latest handled client-side below.
  params.push("limit=5000");
  const url = `${base}&${params.join("&")}`;
  const resp = await fetch(url, { headers: SUPA_HEADERS });
  if (!resp.ok) throw new Error(`GET matchdays: ${resp.status} ${await resp.text()}`);
  let rows = await resp.json();
  // --latest: keep only the newest matchday per league (post-sorted desc).
  if (LATEST_ONLY) {
    const seen = new Set();
    rows = rows.filter((r) => {
      if (seen.has(r.league)) return false;
      seen.add(r.league);
      return true;
    });
  }
  return rows;
}

async function loadLeagueXGHistory(lg) {
  const url = `${SUPA_URL}/rest/v1/team_xg_history?league=eq.${lg}&order=match_date.desc&limit=3000`;
  const resp = await fetch(url, { headers: SUPA_HEADERS });
  if (!resp.ok) return [];
  return resp.json();
}

async function updateMatchdayData(id, data) {
  if (DRY) return;
  const resp = await fetch(`${SUPA_URL}/rest/v1/matchdays?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ data }),
  });
  if (!resp.ok) {
    throw new Error(`PATCH ${id}: ${resp.status} ${await resp.text()}`);
  }
}

function summarizeXG(entries) {
  if (!entries || entries.length === 0) return null;
  return {
    xg: +entries.reduce((s, r) => s + Number(r.xg || 0), 0).toFixed(2),
    xga: +entries.reduce((s, r) => s + Number(r.xga || 0), 0).toFixed(2),
    games: entries.length,
    history: [...entries].reverse().map((r) => ({
      xg: Number(r.xg),
      xga: Number(r.xga),
      date: r.match_date,
      opponent: r.opponent || undefined,
    })),
  };
}

// Enrich a single stored matchday JSON. Never mutates the input; returns
// a fresh object. Preserves any fields already populated (injuries, context,
// referee) — we're only FILLING IN the empty ones, not overwriting.
//
// `ctx` carries league-wide enrichment inputs computed once upstream:
//   { standings, leagueSize, openLigaMatches, leagueKey }
// This avoids re-loading them per matchday of the same league.
function enrichMatchday(md, xgHistory, ctx = {}) {
  if (!md?.matches?.length) return { updated: md, stats: null };
  const { standings = [], leagueSize = 18, openLigaMatches = [] } = ctx;

  // For DERBY/ROTATION detection we need the full fixture list of this
  // matchday. The stored shape uses m.home.name / m.away.name / m.kickoff
  // — the helper accepts either shape via its duck-typing.
  const allFixtures = md.matches.map((m) => ({
    home_team: m.home?.name,
    away_team: m.away?.name,
    home: m.home, away: m.away,
    kickoff: m.kickoff,
    commence_time: m.kickoff,
  }));

  let xgFilled = 0;
  let formFilled = 0;
  let tagsFilled = 0;
  let standingsFilled = 0;
  let h2hFilled = 0;
  const updatedMatches = md.matches.map((m) => {
    const homeName = m.home?.name;
    const awayName = m.away?.name;
    if (!homeName || !awayName) return m;

    // Only backfill fields that are missing/empty. Hand-enriched matchdays
    // (via AI /api/matchday) may already have richer data — don't clobber.
    const needHomeXG = !(m.home?.xg_h8) || !(m.home?.xg_h_history?.length);
    const needAwayXG = !(m.away?.xg_a8) || !(m.away?.xg_a_history?.length);
    const needHomeForm = !m.home?.form;
    const needAwayForm = !m.away?.form;
    // Tags: only add STANDINGS-derived ones if existing tags don't already
    // include them. ROTATION can't be inferred from stored matchday alone
    // (needs league-wide fixture density) so we keep existing tags intact.
    const existingTags = Array.isArray(m.tags) ? m.tags : [];
    const needStandings = !m.home?.standings_pos || !m.away?.standings_pos;
    const needH2H = !Array.isArray(m.h2h) || m.h2h.length === 0;

    let homeXG = null, awayXG = null, homeForm = null, awayForm = null;
    let newTags = [...existingTags];
    let h2h = null;
    let homeStanding = null, awayStanding = null;

    if (needHomeXG) {
      const entries = lookupTeamXG(xgHistory, [homeName], "home", 8);
      homeXG = summarizeXG(entries);
    }
    if (needAwayXG) {
      const entries = lookupTeamXG(xgHistory, [awayName], "away", 8);
      awayXG = summarizeXG(entries);
    }
    if (needHomeForm) homeForm = deriveForm(xgHistory, [homeName]);
    if (needAwayForm) awayForm = deriveForm(xgHistory, [awayName]);

    // Standings lookup — deterministic, cheap, always attempt even if existing
    // values look present (they might be stale from an earlier season).
    if (standings.length > 0) {
      homeStanding = findStanding(standings, [homeName]);
      awayStanding = findStanding(standings, [awayName]);
      if (homeStanding && awayStanding) standingsFilled++;
      // Standings-derived tags (MEISTERKAMPF / ABSTIEGSKAMPF) — merge
      // unique with existing tags.
      const stTags = deriveStandingsTags(
        homeStanding?.pos, awayStanding?.pos, leagueSize,
      );
      for (const t of stTags) if (!newTags.includes(t)) newTags.push(t);
    }

    // DERBY from fixture data (in case existing tags missed it)
    if (existingTags.length === 0) {
      const fx = allFixtures.find(
        (x) => x.home_team === homeName && x.away_team === awayName,
      );
      if (fx) {
        const dTags = deriveTags(fx, allFixtures);
        for (const t of dTags) if (!newTags.includes(t)) newTags.push(t);
      }
    }

    if (needH2H && xgHistory.length > 0) {
      h2h = deriveH2H(xgHistory, [homeName], [awayName], 5);
      if (h2h.length > 0) h2hFilled++;
    }

    // OpenLigaDB match-ID join (only for German leagues where openLigaMatches
    // is non-empty) — useful for future data enrichment joins.
    const oldMatch = openLigaMatches.length > 0
      ? findOpenLigaMatch(openLigaMatches, homeName, awayName)
      : null;

    if (homeXG) xgFilled++;
    else if (!needHomeXG) xgFilled++;
    if (homeForm) formFilled++;
    else if (!needHomeForm) formFilled++;
    if (newTags.length > 0) tagsFilled++;

    return {
      ...m,
      home: {
        ...m.home,
        ...(homeXG ? {
          xg_h8: homeXG.xg,
          xga_h8: homeXG.xga,
          games: homeXG.games,
          xg_h_history: homeXG.history,
        } : {}),
        ...(homeForm ? { form: homeForm } : {}),
        ...(homeStanding ? {
          standings_pos: homeStanding.pos,
          standings_points: homeStanding.points,
          standings_gd: homeStanding.gd,
        } : {}),
      },
      away: {
        ...m.away,
        ...(awayXG ? {
          xg_a8: awayXG.xg,
          xga_a8: awayXG.xga,
          games: awayXG.games,
          xg_a_history: awayXG.history,
        } : {}),
        ...(awayForm ? { form: awayForm } : {}),
        ...(awayStanding ? {
          standings_pos: awayStanding.pos,
          standings_points: awayStanding.points,
          standings_gd: awayStanding.gd,
        } : {}),
      },
      ...(newTags.length > 0 ? { tags: newTags } : {}),
      ...(h2h && h2h.length > 0 ? { h2h } : {}),
      ...(oldMatch ? { _openliga_match_id: oldMatch.matchID } : {}),
    };
  });

  const updated = {
    ...md,
    matches: updatedMatches,
    _enrichment: {
      home_xg: `${updatedMatches.filter(m => m.home?.xg_h_history?.length).length}/${md.matches.length}`,
      away_xg: `${updatedMatches.filter(m => m.away?.xg_a_history?.length).length}/${md.matches.length}`,
      home_form: `${updatedMatches.filter(m => m.home?.form).length}/${md.matches.length}`,
      away_form: `${updatedMatches.filter(m => m.away?.form).length}/${md.matches.length}`,
      tags_applied: `${updatedMatches.filter(m => Array.isArray(m.tags) && m.tags.length > 0).length}/${md.matches.length}`,
      standings_matched: `${standingsFilled}/${md.matches.length}`,
      h2h_found: `${h2hFilled}/${md.matches.length}`,
      source: "retroactive backfill-enrich-matchdays",
      enriched_at: new Date().toISOString(),
    },
  };

  return { updated, stats: updated._enrichment };
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`📅 FODZE Matchday Enrichment Backfill${DRY ? " (DRY)" : ""}`);
  if (leagueFilter) console.log(`   Liga-Filter: ${leagueFilter}`);
  if (LATEST_ONLY) console.log(`   Modus: nur letzter Matchday pro Liga`);
  console.log();

  // Load all (or league-filtered) matchdays once, group by league so we
  // can pull the right xG history per league just once each.
  const matchdays = await loadMatchdays(leagueFilter);
  if (matchdays.length === 0) {
    console.log("   Keine Matchdays gefunden.");
    return;
  }
  console.log(`   ${matchdays.length} Matchdays zu enrichen\n`);

  const byLeague = {};
  for (const md of matchdays) (byLeague[md.league] ||= []).push(md);

  let totalMatches = 0;
  let totalXG = 0;
  let totalForm = 0;
  let totalTags = 0;
  let errored = 0;

  for (const [league, mds] of Object.entries(byLeague)) {
    const xgHistory = await loadLeagueXGHistory(league);
    // Compute per-league standings + OpenLigaDB labels ONCE, reuse across
    // all matchdays of this league. Major perf win when enriching many
    // historical matchdays in a single run.
    const seasonStart = "2025-07-01";
    const currentSeasonXG = xgHistory.filter((r) => (r.match_date || "") >= seasonStart);
    const rawStandings = computeStandingsFromXG(currentSeasonXG);
    // Prune to teams appearing in any of THIS league's matchdays so the
    // "bottom 3" / "top 3" thresholds match actual league size.
    const activeTeams = new Set();
    for (const md of mds) {
      for (const m of md.data?.matches || []) {
        if (m.home?.name) activeTeams.add(m.home.name);
        if (m.away?.name) activeTeams.add(m.away.name);
      }
    }
    const standings = rawStandings.filter((s) =>
      Array.from(activeTeams).some((t) => !!findStanding([s], [t])),
    );
    standings.forEach((s, i) => { s.pos = i + 1; });
    const leagueSize = standings.length || 18;
    const openLigaMatches = await loadOpenLigaDBSeason(league);
    const ctx = { standings, leagueSize, openLigaMatches, leagueKey: league };
    console.log(
      `─── ${league.padEnd(20)} ${mds.length} Matchdays · ${xgHistory.length} xG · ${standings.length} Tabelle${openLigaMatches.length ? ` · ${openLigaMatches.length} OpenLigaDB` : ""}`,
    );

    for (const md of mds) {
      try {
        const { updated, stats } = enrichMatchday(md.data, xgHistory, ctx);
        await updateMatchdayData(md.id, updated);
        const [h_xg] = stats.home_xg.split("/");
        const [h_form] = stats.home_form.split("/");
        const [tags] = stats.tags_applied.split("/");
        const total = updated.matches.length;
        totalMatches += total;
        totalXG += Number(h_xg);
        totalForm += Number(h_form);
        totalTags += Number(tags);
        console.log(
          `     ✓ ${md.matchday_label?.slice(0, 24).padEnd(24)}  xG ${stats.home_xg}  Form ${stats.home_form}  Tags ${stats.tags_applied}  Stand ${stats.standings_matched}  H2H ${stats.h2h_found}`,
        );
      } catch (e) {
        errored++;
        console.error(`     ✗ ${md.id}: ${e.message}`);
      }
    }
  }

  console.log();
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  Summary${DRY ? " (dry-run, nothing written)" : ""}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  Matches enriched:  ${totalMatches}`);
  console.log(`  With home xG:      ${totalXG}/${totalMatches}  (${totalMatches > 0 ? ((totalXG / totalMatches) * 100).toFixed(0) : 0}%)`);
  console.log(`  With home form:    ${totalForm}/${totalMatches}  (${totalMatches > 0 ? ((totalForm / totalMatches) * 100).toFixed(0) : 0}%)`);
  console.log(`  With tags:         ${totalTags}/${totalMatches}  (${totalMatches > 0 ? ((totalTags / totalMatches) * 100).toFixed(0) : 0}%)`);
  if (errored) console.log(`  ⚠ Errored:         ${errored}`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

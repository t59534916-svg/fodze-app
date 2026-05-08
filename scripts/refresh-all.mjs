#!/usr/bin/env node
/**
 * FODZE Full Refresh Pipeline
 * ═══════════════════════════
 * Runs the same chain the GitHub Actions crons would run on a matchday, but
 * locally and in one command. Use this when:
 *   - The GH Actions cron is disabled / failing and you want fresh data now
 *   - You want a manual full refresh before opening /fuck-betting or /goldilocks
 *   - You've just seeded new xG data and want matchdays re-enriched
 *
 * Pipeline (sequential — each step depends on the previous):
 *   1. fetch-odds                    — live_odds + upcoming_fixtures × 19 leagues
 *   2. settle completed bets         — fetch-results for any pending bets
 *   3. Liga 3 OpenLigaDB backfill    — catches last matchday's results
 *   4. sync-sofascore                — Tier-A shot events (incl. xG)
 *   5. bridge-sofascore              — propagate sofascore → team_xg_history
 *   6. referees (opt-in)             — FBref scrape per league
 *   7. generate-matchday × 19        — enriched + seeded matchdays
 *   8. retro-enrich latest matchdays — fills any remaining form/tag gaps
 *   9. audit-data-quality            — final green/red summary
 *
 * Expected runtime: ~3–5 minutes (dominated by sync-sofascore + matchday gen).
 *
 * Behavior:
 *   - Step 1 is MANDATORY. If it fails, the whole pipeline aborts — later
 *     steps need fresh upcoming_fixtures to populate matchdays.
 *   - Steps 2–6 continue past individual-league failures; a single broken
 *     league doesn't nuke the rest.
 *   - No --dry flag: this is a "run it live" command. Use the individual
 *     scripts with --dry for testing.
 *
 * Usage:
 *   npm run refresh
 *   node scripts/refresh-all.mjs
 *   node scripts/refresh-all.mjs --skip-odds     # assume odds already fresh
 *   node scripts/refresh-all.mjs --skip-matchday # don't regenerate matchdays
 *   node scripts/refresh-all.mjs --skip-bridge   # don't propagate sofa→team_xg_history
 *   node scripts/refresh-all.mjs --quiet         # just phase headers, no per-step output
 *   node scripts/refresh-all.mjs --resume        # skip leagues already matchday-
 *                                                # seeded by an earlier crashed run
 *                                                # (progress file < 6h old)
 *   node scripts/refresh-all.mjs --injuries      # include Transfermarkt injury scrape
 *   node scripts/refresh-all.mjs --referees      # include FBref referee-stats scrape
 *   node scripts/refresh-all.mjs --extras        # include Sofascore post-match extras
 *                                                # (stats + lineups + incidents + avg-positions)
 *                                                # — capped via FODZE_EXTRAS_MAX=N (default 50)
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Load .env.local so the pipeline works under `npm run refresh` (which
// doesn't source env files). Each child script also loads it, but by
// injecting into process.env here we guarantee even steps without their
// own loader (e.g. fetch-odds.mjs) see the keys.
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

// Mirror src/lib/dixon-coles.ts LEAGUES — kept in sync manually since .mjs
// can't import TS. Check against audit output if you add a league.
const LEAGUES = [
  "bundesliga", "bundesliga2", "liga3",
  "epl", "la_liga", "serie_a", "ligue_1", "eredivisie",
  "championship", "primeira_liga", "jupiler_pro", "super_lig",
  "la_liga2", "serie_b", "ligue_2",
  "scottish_prem", "greek_sl", "league_one", "league_two",
];

const args = process.argv.slice(2);
const SKIP_ODDS = args.includes("--skip-odds");
const SKIP_MATCHDAY = args.includes("--skip-matchday");
const SKIP_BRIDGE = args.includes("--skip-bridge");
const QUIET = args.includes("--quiet");
const SKIP_AUDIT = args.includes("--skip-audit");
const RESUME = args.includes("--resume");
// Opt-in: propagate --injuries to generate-matchday so each team gets a
// Transfermarkt scrape. Adds ~3s/team but populates the `injuries` field
// the absence-parser + calcAbsenceImpact actually use.
const WITH_INJURIES = args.includes("--injuries");
// Opt-in: scrape FBref schedule pages per league to populate the
// `referees` table. Adds ~6s/league (rate-limited) = ~2 min for all 19.
// Matchdays will hydrate match.referee from this table when a pre-match
// source supplies referee_name.
const WITH_REFEREES = args.includes("--referees");
// Opt-in: pull Sofascore post-match extras (statistics + lineups +
// incidents + avg-positions) into 4 forever-cached tables. First run is
// heavy (~5000 games × 4 calls) so it's capped via FODZE_EXTRAS_MAX=N
// (default 50). Once the backfill is amortized, leave the flag on so
// every refresh keeps the new matches synced (~80 games/week incremental).
const WITH_EXTRAS = args.includes("--extras");

// ─── Progress File (resumability) ───────────────────────────────────
//
// Only the matchdays phase is resumable — it's the one that takes 20min
// and iterates 19 leagues. If Groq quota dies on league 12, re-running
// with --resume skips the first 11. Stale file (>6h) is ignored so an
// ancient interrupted run doesn't silently skip today's work.
const PROGRESS_FILE = resolve(REPO_ROOT, ".fodze-refresh-progress.json");
const PROGRESS_TTL_MS = 6 * 3600 * 1000;

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    if (!data?.started_at) return null;
    const age = Date.now() - new Date(data.started_at).getTime();
    if (age > PROGRESS_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveProgress(data) {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`   ⚠ Konnte Progress-File nicht schreiben: ${e.message}`);
  }
}

function clearProgress() {
  if (existsSync(PROGRESS_FILE)) {
    try { unlinkSync(PROGRESS_FILE); } catch { /* best-effort */ }
  }
}

// ─── Runner ─────────────────────────────────────────────────────────

/**
 * Spawn a script and pipe its stdio. Resolves on exit code 0, rejects
 * otherwise. In --quiet mode, output is suppressed and captured for
 * emergency print-on-failure only.
 */
function runScript(script, scriptArgs = [], label = null) {
  return new Promise((res, rej) => {
    const buf = [];
    const child = spawn("node", [script, ...scriptArgs], {
      cwd: REPO_ROOT,
      stdio: QUIET ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    if (QUIET) {
      child.stdout?.on("data", (d) => buf.push(d.toString()));
      child.stderr?.on("data", (d) => buf.push(d.toString()));
    }
    child.on("exit", (code) => {
      if (code === 0) return res();
      if (QUIET) process.stderr.write(buf.join(""));
      rej(new Error(`${label || script} exited with code ${code}`));
    });
    child.on("error", rej);
  });
}

// ─── Phases ─────────────────────────────────────────────────────────

const phases = [
  {
    name: "fetch-odds",
    emoji: "💰",
    description: "Live-Quoten + Fixtures für alle Ligen",
    skip: () => SKIP_ODDS,
    run: () => runScript("scripts/fetch-odds.mjs", [], "fetch-odds"),
    abortOnFail: true,
  },
  {
    name: "settle-bets",
    emoji: "🎯",
    description: "Pending Bets auswerten",
    run: () => runScript("scripts/fetch-results.mjs", [], "fetch-results"),
    abortOnFail: false,
  },
  {
    name: "liga3-backfill",
    emoji: "⚽",
    description: "Liga 3 xG aus OpenLigaDB nachziehen",
    run: () => runScript("scripts/backfill-liga3-openligadb.mjs", [], "liga3-backfill"),
    abortOnFail: false,
  },
  {
    name: "sync-sofascore",
    emoji: "🎯",
    description: "Sofascore Shot-Events (Tier-A) inkrementell sync",
    skip: () => !existsSync(resolve(REPO_ROOT, "tools/venv/bin/python3")),
    run: () => runScript("scripts/sync-sofascore-shotmap.mjs", [], "sync-sofascore"),
    abortOnFail: false,  // experimental data-source, must not break the pipeline
  },
  {
    name: "bridge-sofascore",
    emoji: "🔗",
    description: "Sofascore-xG → team_xg_history bridge (last 30d window, premium+partial tier)",
    skip: () => SKIP_BRIDGE,
    run: () => {
      // Pass --since (today - 30d) so the daily cron only churns recent
      // matches. Why this matters:
      //   1. Cloudflare hiccup risk: if sync-sofascore partially fails,
      //      chance_quality might have slightly-stale data. Limiting to
      //      30d means at most the last 30d of matches get the (possibly
      //      slightly-old) Sofascore values upserted; older months stay
      //      pinned to whatever source last wrote them.
      //   2. footystats overwrite resilience: if you import a fresh
      //      FootyStats CSV with corrected xG for an older match, the
      //      next bridge run won't re-overwrite that with stale Sofa
      //      data — the older match is outside the --since window.
      //   3. Performance: ~600 rows vs ~10k for full-corpus bridge.
      //
      // For backfill / one-off full bridge, run the script directly
      // without --since.
      const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      return runScript("scripts/bridge-sofascore-to-team-xg.mjs", ["--since", since], "bridge-sofascore");
    },
    // Idempotent upsert. Failure here just means engine reads run on
    // pre-bridge xG (still functional, just slightly more stale for
    // non-DE leagues between FootyStats CSV imports).
    abortOnFail: false,
  },
  {
    name: "sync-sofascore-extras",
    emoji: "📝",
    description: "Sofascore extras (stats + lineups + incidents + avg-pos + managers + pregame-form + team-streaks)",
    // Opt-in: --extras flag. Default off because first-run is heavy
    // (~5000 games × 7 endpoints). Use --extras with FODZE_EXTRAS_MAX=N
    // (default 50) the first few runs to amortize, then enable
    // unconditionally for incremental cron.
    skip: () => !WITH_EXTRAS || !existsSync(resolve(REPO_ROOT, "tools/venv/bin/python3")),
    run: () => {
      // Cap per run so a stalled fetch doesn't blow the refresh budget.
      // Direct: 50 games × 4 endpoints × 1.5s pace ≈ 5min.
      // Tor (7 endpoints × 5s pace): ~30min for 50 games — drop max
      // to ~25 in cron when FODZE_EXTRAS_USE_TOR=1.
      const maxN = process.env.FODZE_EXTRAS_MAX ?? "50";
      // Optional: route via Tor SOCKS5 (127.0.0.1:9050). REQUIRED for v2
      // endpoints (managers/pregame-form/team-streaks) since Cloudflare
      // started blocking direct API access on 2026-05-07. Setup once:
      // `brew install tor && brew services start tor`. Activate via env
      // FODZE_EXTRAS_USE_TOR=1 in launchd plist or shell.
      const cliArgs = ["--all-tiers", "--max", maxN];
      if (process.env.FODZE_EXTRAS_USE_TOR === "1") cliArgs.push("--use-tor");
      return runScript("scripts/sync-sofascore-extras.mjs",
        cliArgs, "sync-sofascore-extras");
    },
    // Forever-cache + idempotent — safe to fail and retry next run.
    abortOnFail: false,
  },
  {
    name: "bridge-sofascore-extras",
    emoji: "🔗",
    description: "Sofascore-extras → team_xg_history (possession, big_chances, tackles, cards, ...)",
    // Same gate as the extras fetch: skip if --extras flag absent OR
    // bridge has been globally suppressed (--skip-bridge). The bridge
    // itself reads sofascore_team_match_stats VIEW which is built from
    // sofascore_match_statistics, so without the upstream sync there's
    // nothing to propagate.
    skip: () => !WITH_EXTRAS || SKIP_BRIDGE,
    run: () => {
      // 30-day window matches the primary sofascore bridge — cron-safe.
      // For backfill of older matches, run the script directly without --since.
      const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      return runScript("scripts/bridge-sofascore-extras-to-team-xg.mjs",
        ["--since", since], "bridge-sofascore-extras");
    },
    // Idempotent merge-duplicates upsert. Failure here just means the
    // engine reads on yesterday's extras (still functional — primary xG
    // bridge already wrote the critical features).
    abortOnFail: false,
  },
  {
    name: "referees",
    emoji: "🟨",
    description: "Referee-Stats per Liga von FBref ziehen",
    skip: () => !WITH_REFEREES,
    run: async () => {
      // Iterate the same LEAGUES list we use for matchdays — non-fatal
      // per-league failures (league not in FBREF_COMPS, HTML 404, etc.)
      // just skip that league, rest proceeds.
      let ok = 0, fail = 0;
      for (const lg of LEAGUES) {
        try {
          await runScript("scripts/scrape-referees.mjs", ["--league", lg], `referees ${lg}`);
          ok++;
        } catch (e) {
          fail++;
          if (!QUIET) console.warn(`     ⚠ ${lg}: ${e.message}`);
        }
      }
      console.log(`   ${ok}/${LEAGUES.length} Ligen referees geseedet${fail ? ` (${fail} failed)` : ""}`);
    },
    abortOnFail: false,
  },
  {
    name: "matchdays",
    emoji: "📅",
    description: `Matchdays generieren + seeden (pro Liga)${WITH_INJURIES ? " + Injuries scrape" : ""}`,
    skip: () => SKIP_MATCHDAY,
    run: async () => {
      // Resume: if a recent progress file exists, skip already-completed
      // leagues. First call to saveProgress initializes the file for the
      // current run; subsequent calls append each successful league.
      const existing = RESUME ? loadProgress() : null;
      const completed = new Set(existing?.completed || []);
      const progress = {
        started_at: existing?.started_at || new Date().toISOString(),
        completed: existing?.completed || [],
      };
      if (existing && completed.size > 0) {
        console.log(`   ↻ Resume: ${completed.size}/${LEAGUES.length} Ligen bereits erledigt — überspringen`);
      }
      saveProgress(progress);

      let ok = 0, fail = 0, skipped = 0;
      for (const lg of LEAGUES) {
        if (completed.has(lg)) { skipped++; continue; }
        try {
          await runScript(
            "scripts/generate-matchday.mjs",
            ["--league", lg, "--seed", ...(WITH_INJURIES ? ["--injuries"] : [])],
            `generate-matchday ${lg}`,
          );
          ok++;
          progress.completed.push(lg);
          saveProgress(progress);
        } catch (e) {
          // "No fixtures" isn't a real failure — the script just prints a
          // warning and exits cleanly. But exit code might be non-zero for
          // other edge cases. Count + continue.
          fail++;
          if (!QUIET) console.warn(`     ⚠ ${lg}: ${e.message}`);
        }
      }
      const resumed = skipped > 0 ? ` (${skipped} resumed)` : "";
      console.log(`   ${ok + skipped}/${LEAGUES.length} Ligen geseedet${resumed}${fail ? ` (${fail} failed/no-fixtures)` : ""}`);

      // Only clear the progress file when all leagues succeeded; on any
      // failure, keep it so the next --resume run can pick up the rest.
      if (fail === 0) clearProgress();
    },
    abortOnFail: false,
  },
  {
    name: "retro-enrich",
    emoji: "✨",
    description: "Form + Tags auf latest Matchdays nachfüllen",
    run: () => runScript("scripts/backfill-enrich-matchdays.mjs", ["--latest"], "retro-enrich"),
    abortOnFail: false,
  },
  {
    name: "audit",
    emoji: "🔍",
    description: "Daten-Qualität final prüfen",
    skip: () => SKIP_AUDIT,
    run: () => runScript("scripts/audit-data-quality.mjs", [], "audit"),
    abortOnFail: false, // audit returns non-zero on P0 — don't abort, that's informative
  },
];

// ─── DNS warm-up (defense against macOS sleep/wake cron failures) ──
//
// launchd fires us at 07:30 daily — but on a Mac that just woke up, DNS
// can take 5-30s to be ready while the network stack reconnects. Symptom:
// `Fatal: fetch failed / getaddrinfo ENOTFOUND` on the first phase
// (typically fetch-odds), which then cascades because odds_snapshots
// stays stale and the audit complains. Observed 2026-05-08 morning run.
//
// Fix: probe Supabase host's DNS before any phase runs. If it fails,
// sleep + retry up to 6×10s. Total wait worst-case 60s; cheap insurance.
//
// We deliberately use `dns.promises.lookup` (not a fetch) so we test the
// resolver layer in isolation — fetch-failures could be CORS, SSL,
// upstream-down, etc., but DNS-readiness is the actual cron-trigger
// failure mode and the only one we can trivially recover from.
async function waitForDNS(maxRetries = 6, intervalMs = 10_000) {
  const dns = await import("dns/promises");
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!supaUrl) return;  // env not loaded yet, fetch-odds will fail loudly
  let host;
  try { host = new URL(supaUrl).hostname; } catch { return; }
  for (let i = 0; i < maxRetries; i++) {
    try {
      await dns.lookup(host);
      if (i > 0) console.log(`  ✓ DNS ready for ${host} (after ${i + 1} attempts)`);
      return;
    } catch (e) {
      if (i === maxRetries - 1) {
        console.warn(`  ⚠ DNS still failing after ${maxRetries} attempts (${e.code}). ` +
                     `Continuing — phases will fail loudly if network is genuinely down.`);
        return;
      }
      console.log(`  … DNS not ready (${e.code}), retry ${i + 1}/${maxRetries} in ${intervalMs / 1000}s`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  FODZE Full Refresh Pipeline");
  console.log(`  ${new Date().toLocaleString("de-DE")}`);
  console.log("═══════════════════════════════════════════════════════════════════");

  // Wait for DNS resolver to be ready — defends against post-wake cron
  // running before the network stack is fully online.
  await waitForDNS();

  const results = [];
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p.skip?.()) {
      console.log(`\n${p.emoji} [${i + 1}/${phases.length}] ${p.description} — SKIPPED`);
      results.push({ name: p.name, status: "skipped", ms: 0 });
      continue;
    }
    const t = Date.now();
    console.log(`\n${p.emoji} [${i + 1}/${phases.length}] ${p.description}`);
    try {
      await p.run();
      const ms = Date.now() - t;
      console.log(`   ✓ fertig (${(ms / 1000).toFixed(1)}s)`);
      results.push({ name: p.name, status: "ok", ms });
    } catch (e) {
      const ms = Date.now() - t;
      results.push({ name: p.name, status: "failed", ms, error: e.message });
      if (p.abortOnFail) {
        console.error(`   ✗ kritisch: ${e.message}`);
        console.error("");
        console.error("   Pipeline abgebrochen — fetch-odds ist Voraussetzung für alle");
        console.error("   folgenden Schritte.");
        break;
      } else {
        console.warn(`   ⚠ fehlgeschlagen (weiter): ${e.message}`);
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────
  const totalMs = Date.now() - t0;
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  Summary — ${(totalMs / 1000).toFixed(1)}s total`);
  console.log("═══════════════════════════════════════════════════════════════════");
  for (const r of results) {
    const icon = r.status === "ok" ? "✓" : r.status === "skipped" ? "·" : "✗";
    const time = r.status === "skipped" ? "      " : `${(r.ms / 1000).toFixed(1).padStart(5)}s`;
    console.log(`  ${icon}  ${r.name.padEnd(18)} ${time}  ${r.error || ""}`);
  }

  const failed = results.filter((r) => r.status === "failed").length;
  if (failed > 0) {
    console.log("");
    console.log(`  ${failed} Phase(n) fehlgeschlagen — App läuft aber mit vorhandenen Daten.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});

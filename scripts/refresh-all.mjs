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
 *   4. generate-matchday × 19        — enriched + seeded matchdays
 *   5. retro-enrich latest matchdays — fills any remaining form/tag gaps
 *   6. audit-data-quality            — final green/red summary
 *
 * Expected runtime: ~2–3 minutes (dominated by fetch-odds credits + enrichment).
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
 *   node scripts/refresh-all.mjs --quiet         # just phase headers, no per-step output
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
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
const QUIET = args.includes("--quiet");
const SKIP_AUDIT = args.includes("--skip-audit");
// Opt-in: propagate --injuries to generate-matchday so each team gets a
// Transfermarkt scrape. Adds ~3s/team but populates the `injuries` field
// the absence-parser + calcAbsenceImpact actually use.
const WITH_INJURIES = args.includes("--injuries");

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
    name: "matchdays",
    emoji: "📅",
    description: `Matchdays generieren + seeden (pro Liga)${WITH_INJURIES ? " + Injuries scrape" : ""}`,
    skip: () => SKIP_MATCHDAY,
    run: async () => {
      let ok = 0, fail = 0, skipped = 0;
      for (const lg of LEAGUES) {
        try {
          await runScript(
            "scripts/generate-matchday.mjs",
            ["--league", lg, "--seed", ...(WITH_INJURIES ? ["--injuries"] : [])],
            `generate-matchday ${lg}`,
          );
          ok++;
        } catch (e) {
          // "No fixtures" isn't a real failure — the script just prints a
          // warning and exits cleanly. But exit code might be non-zero for
          // other edge cases. Count + continue.
          fail++;
          if (!QUIET) console.warn(`     ⚠ ${lg}: ${e.message}`);
        }
      }
      console.log(`   ${ok}/${LEAGUES.length} Ligen geseedet${fail ? ` (${fail} failed/no-fixtures)` : ""}`);
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

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  FODZE Full Refresh Pipeline");
  console.log(`  ${new Date().toLocaleString("de-DE")}`);
  console.log("═══════════════════════════════════════════════════════════════════");

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

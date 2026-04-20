#!/usr/bin/env node
/**
 * FODZE worldfootballR CSV Importer
 * ═════════════════════════════════
 * Orchestrates the two-step import of the CSVs produced by
 * tools/export-worldfootballr.R:
 *
 *   tools/wfr-export/
 *     referees-{league}.csv       → import via scrape-referees.mjs --csv-file
 *     player_standard.csv         → import via backfill-player-xg.mjs --csv-dir
 *
 * Usage:
 *   Rscript tools/export-worldfootballr.R   # produces the CSVs
 *   node scripts/import-wfr-csvs.mjs        # imports them all
 *
 * Flags:
 *   --dry           Preview only — no Supabase writes
 *   --skip-refs     Skip referee import
 *   --skip-players  Skip player import
 *   --dir <path>    Override wfr-export location (default: tools/wfr-export)
 */

import { readdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const argv = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const DRY = args.includes("--dry");
const SKIP_REFS = args.includes("--skip-refs");
const SKIP_PLAYERS = args.includes("--skip-players");
const EXPORT_DIR = resolve(REPO_ROOT, argv("--dir") || "tools/wfr-export");

if (!existsSync(EXPORT_DIR)) {
  console.error(`[import-wfr] export dir missing: ${EXPORT_DIR}`);
  console.error(`[import-wfr] run this first:  Rscript tools/export-worldfootballr.R`);
  process.exit(1);
}

// Utility: run a node script as a subprocess, inheriting stdio so the
// user sees each sub-script's own output inline.
function runScript(script, scriptArgs = []) {
  return new Promise((res, rej) => {
    const child = spawn("node", [resolve(REPO_ROOT, script), ...scriptArgs], {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
    child.on("exit", (code) => code === 0 ? res() : rej(new Error(`${script} exited ${code}`)));
    child.on("error", rej);
  });
}

// ─── 1. Referees ──────────────────────────────────────────────────
async function importReferees() {
  const files = readdirSync(EXPORT_DIR).filter(f => f.startsWith("referees-") && f.endsWith(".csv"));
  if (files.length === 0) {
    console.log(`[import-wfr] no referee CSVs in ${EXPORT_DIR}`);
    return { ok: 0, fail: 0, skipped: 0 };
  }
  console.log(`\n═══ Importing ${files.length} referee CSV(s) ═══`);
  let ok = 0, fail = 0, skipped = 0;
  for (const f of files) {
    // filename: referees-{league}.csv → league code
    const league = basename(f, ".csv").replace(/^referees-/, "");
    const path = resolve(EXPORT_DIR, f);
    const size = readFileSync(path, "utf-8").split("\n").length - 1; // quick row-count
    if (size < 2) {
      console.log(`[import-wfr] ${league}: CSV empty, skipping`);
      skipped++;
      continue;
    }
    console.log(`\n--- ${league} (${size} rows) ---`);
    try {
      const scriptArgs = ["--league", league, "--csv-file", path];
      if (DRY) scriptArgs.push("--dry");
      await runScript("scripts/scrape-referees.mjs", scriptArgs);
      ok++;
    } catch (e) {
      console.warn(`[import-wfr]  ⚠ ${league} failed: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail, skipped };
}

// ─── 2. Player stats ──────────────────────────────────────────────
async function importPlayers() {
  // backfill-player-xg.mjs looks for `{slug}_{season}_player_standard.csv`
  // OR `player_standard_{season}.csv`. Our R export writes plain
  // `player_standard.csv` — rename/alias it so the downstream matches.
  const raw = resolve(EXPORT_DIR, "player_standard.csv");
  if (!existsSync(raw)) {
    console.log(`[import-wfr] no player_standard.csv in ${EXPORT_DIR}`);
    return;
  }
  // backfill-player-xg.mjs tries player_standard_{season}.csv first; the
  // cleanest way is to pass the current season override through that
  // loader. Our R export writes last-completed season (season_end - 1),
  // so the season code is e.g. "2425" for 2024/25. Match it by symlink
  // or copy: we'll just copy on-the-fly via a wrapper arg.
  console.log(`\n═══ Importing player_standard.csv ═══`);
  // Let backfill-player-xg do its default season-code derivation and
  // look for player_standard_<season>.csv. We copy-in a renamed file.
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? y : y - 1;
  const currentSeason = `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
  // Canonical filename expected by backfill-player-xg.mjs
  const target = resolve(EXPORT_DIR, `player_standard_${currentSeason}.csv`);
  if (!existsSync(target)) {
    // Hard-link or copy. Use copyFileSync from fs for portability.
    const { copyFileSync } = await import("fs");
    copyFileSync(raw, target);
    console.log(`[import-wfr] symlinked player_standard.csv → player_standard_${currentSeason}.csv`);
  }
  const scriptArgs = ["--all", "--season", currentSeason, "--csv-dir", EXPORT_DIR];
  if (DRY) scriptArgs.push("--dry");
  await runScript("scripts/backfill-player-xg.mjs", scriptArgs);
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`[import-wfr] export dir: ${EXPORT_DIR}`);
  console.log(`[import-wfr] mode: ${DRY ? "DRY" : "LIVE"}`);
  let refResult = { ok: 0, fail: 0, skipped: 0 };
  if (!SKIP_REFS) {
    refResult = await importReferees();
  }
  if (!SKIP_PLAYERS) {
    try { await importPlayers(); }
    catch (e) { console.warn(`[import-wfr] player import failed: ${e.message}`); }
  }
  console.log(`\n═══ DONE — referees: ${refResult.ok} ok, ${refResult.fail} failed, ${refResult.skipped} skipped ═══`);
}

main().catch(e => {
  console.error("[import-wfr] unhandled:", e);
  process.exit(1);
});

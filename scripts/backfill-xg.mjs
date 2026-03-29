#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * FODZE Historical xG Backfill — Browser-Script Methode
 * ═══════════════════════════════════════════════════════════════════
 *
 * Understat und FBref blocken automatisiertes Scraping.
 * Dieses Script führt den Admin Schritt für Schritt:
 *
 * 1. Zeigt ein Browser-Script für Understat
 * 2. Admin öffnet Understat im Browser, führt Script aus
 * 3. Admin fügt die JSON-Daten hier ein
 * 4. Script seeded in Supabase team_xg_history
 *
 * Usage:
 *   node scripts/backfill-xg.mjs                    # Interaktiv
 *   node scripts/backfill-xg.mjs --league bundesliga # Nur eine Liga
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.FODZE_SERVICE_KEY
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));
const askMultiline = async (prompt) => {
  console.log(prompt);
  console.log(`${c.dim}  (Eingabe mit leerer Zeile + Enter beenden)${c.reset}\n`);
  let lines = [];
  while (true) {
    const line = await ask('');
    if (line.trim() === '' && lines.length > 0) break;
    lines.push(line);
  }
  return lines.join('\n');
};

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const ok = (msg) => console.log(`${c.green}✓ ${msg}${c.reset}`);
const warn = (msg) => console.log(`${c.yellow}⚠ ${msg}${c.reset}`);
const info = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`);

// ─── Config ──────────────────────────────────────────────────────────

const UNDERSTAT_LEAGUES = {
  bundesliga:  { slug: "Bundesliga",  seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
  epl:         { slug: "EPL",         seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
  la_liga:     { slug: "La_liga",     seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
  serie_a:     { slug: "Serie_A",     seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
  ligue_1:     { slug: "Ligue_1",     seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
  eredivisie:  { slug: "Eredivisie",  seasons: ["2017","2018","2019","2020","2021","2022","2023","2024"] },
};

// ─── Browser Script Generator ────────────────────────────────────────

function generateBrowserScript(leagueSlug) {
  return `// ═══ FODZE xG Backfill — ${leagueSlug} ═══
// Dieses Script extrahiert ALLE per-Match xG-Daten für die Supabase team_xg_history Tabelle
const result = [];
Object.values(teamsData).forEach(t => {
  t.history.forEach(g => {
    result.push({
      team: t.title,
      opponent: "", // wird beim Seed ergänzt
      venue: g.h_a === "h" ? "home" : "away",
      match_date: (g.date||g.datetime || "").split(" ")[0],
      xg: +parseFloat(g.xG).toFixed(2),
      xga: +parseFloat(g.xGA).toFixed(2),
      goals_for: parseInt(g.scored) || 0,
      goals_against: parseInt(g.missed) || 0,
      result: g.result
    });
  });
});
copy(JSON.stringify(result));
console.log("✅ " + result.length + " Einträge in Clipboard!");
console.log("Teams:", [...new Set(result.map(r => r.team))].length);`;
}

// ─── Seed to Supabase ────────────────────────────────────────────────

async function seedRows(league, rows) {
  // Filter out rows with empty/invalid dates
  const valid = rows.filter(r => r.match_date && r.match_date.match(/^\d{4}-\d{2}-\d{2}$/));
  if (valid.length < rows.length) {
    warn(`${rows.length - valid.length} Einträge ohne gültiges Datum übersprungen`);
  }

  let inserted = 0;
  for (let i = 0; i < valid.length; i += 500) {
    const batch = valid.slice(i, i + 500).map(r => ({
      team: r.team,
      opponent: r.opponent || "",
      league,
      venue: r.venue,
      match_date: r.match_date,
      xg: r.xg,
      xga: r.xga,
      goals_for: r.goals_for,
      goals_against: r.goals_against,
    }));
    const { error } = await supabase.from("team_xg_history").upsert(batch, {
      onConflict: "team,league,venue,match_date",
    });
    if (error) warn(`Seed error: ${error.message}`);
    else inserted += batch.length;
  }
  return inserted;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${c.bold}${c.cyan}⚽ FODZE xG BACKFILL${c.reset}`);
  console.log(`${c.dim}Historische xG-Daten via Browser-Script → Supabase${c.reset}\n`);

  const args = process.argv.slice(2);
  const leagueFilter = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;

  // Liga auswählen
  const keys = Object.keys(UNDERSTAT_LEAGUES);
  if (!leagueFilter) {
    console.log(`${c.bold}Verfügbare Ligen:${c.reset}`);
    keys.forEach((k, i) => console.log(`  ${c.cyan}${i + 1}${c.reset}  ${UNDERSTAT_LEAGUES[k].slug}`));
  }

  const targetKeys = leagueFilter ? [leagueFilter] : keys;

  for (const key of targetKeys) {
    const config = UNDERSTAT_LEAGUES[key];
    if (!config) { warn(`Liga ${key} nicht gefunden`); continue; }

    console.log(`\n${c.bold}${c.green}━━━ ${config.slug.toUpperCase()} ━━━${c.reset}\n`);

    for (const season of config.seasons) {
      const url = `https://understat.com/league/${config.slug}/${season}`;

      console.log(`${c.cyan}${c.bold}┌─── Saison ${season}/${parseInt(season)+1} ───${c.reset}`);
      console.log(`${c.cyan}│${c.reset}  1. Öffne: ${c.bold}${url}${c.reset}`);
      console.log(`${c.cyan}│${c.reset}  2. Chrome DevTools (F12) → Console`);
      console.log(`${c.cyan}│${c.reset}  3. Paste dieses Script:`);
      console.log(`${c.cyan}│${c.reset}`);
      const script = generateBrowserScript(config.slug);
      for (const line of script.split('\n')) {
        console.log(`${c.cyan}│${c.reset}  ${c.dim}${line}${c.reset}`);
      }
      console.log(`${c.cyan}│${c.reset}`);
      console.log(`${c.cyan}│${c.reset}  4. Daten sind im Clipboard`);
      console.log(`${c.cyan}${c.bold}└───────────────────────────${c.reset}\n`);

      const input = await askMultiline(`${c.bold}JSON für ${config.slug} ${season} hier einfügen (oder "skip" zum Überspringen):${c.reset}`);

      if (input.trim().toLowerCase() === 'skip') {
        warn(`${config.slug} ${season} übersprungen`);
        continue;
      }

      try {
        const data = JSON.parse(input.match(/\[[\s\S]*\]/)?.[0] || input);
        if (!Array.isArray(data) || data.length === 0) {
          warn("Keine Daten geparst");
          continue;
        }

        // Validierung
        const teams = new Set(data.map(r => r.team));
        const homeCount = data.filter(r => r.venue === "home").length;
        const awayCount = data.filter(r => r.venue === "away").length;
        info(`${data.length} Einträge, ${teams.size} Teams, ${homeCount} Heim / ${awayCount} Auswärts`);

        // Plausibilitätscheck
        const avgXG = data.reduce((s, r) => s + r.xg, 0) / data.length;
        if (avgXG < 0.5 || avgXG > 3.0) warn(`Durchschnitt xG = ${avgXG.toFixed(2)} — verdächtig!`);

        const confirm = await ask(`${c.bold}In Supabase seeden? (j/n): ${c.reset}`);
        if (confirm.toLowerCase() === 'j' || confirm.toLowerCase() === 'y') {
          const inserted = await seedRows(key, data);
          ok(`${inserted} Einträge für ${config.slug} ${season} geseeded!`);
        } else {
          // Speichere als Backup
          const outFile = resolve(__dirname, `${key}-${season}-xg.json`);
          writeFileSync(outFile, JSON.stringify(data, null, 2));
          ok(`JSON gespeichert: ${outFile}`);
        }
      } catch (e) {
        warn(`Parse-Fehler: ${e.message}`);
      }
    }
  }

  console.log(`\n${c.bold}${c.cyan}Backfill abgeschlossen.${c.reset}\n`);
  rl.close();
}

main().catch(e => { console.error(`${c.red}Fatal: ${e.message}${c.reset}`); process.exit(1); });

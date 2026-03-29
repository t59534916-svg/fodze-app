#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * FODZE xG Export — Lokales Backup aus Supabase
 * ═══════════════════════════════════════════════════════════════════
 *
 * Exportiert alle team_xg_history Einträge als lokale JSON-Dateien.
 * Ein File pro Liga, plus ein Gesamt-Export.
 *
 * Usage:
 *   node scripts/export-xg.mjs                    # Alle Ligen
 *   node scripts/export-xg.mjs --league bundesliga # Nur eine Liga
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

const c = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m' };
const ok = (msg) => console.log(`${c.green}✓ ${msg}${c.reset}`);
const info = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`);

async function main() {
  console.log(`\n${c.bold}${c.cyan}⚽ FODZE xG EXPORT${c.reset}\n`);

  const args = process.argv.slice(2);
  const leagueFilter = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;

  // Create backup directory
  const backupDir = resolve(__dirname, '..', 'backups');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);

  // Known leagues (don't rely on SELECT DISTINCT which is limited to 1000 rows)
  const ALL_LEAGUES = ['bundesliga', 'epl', 'la_liga', 'serie_a', 'ligue_1', 'eredivisie', 'bundesliga2', 'liga3', 'championship'];
  const leagues = [];
  for (const lg of ALL_LEAGUES) {
    const { count } = await supabase.from('team_xg_history').select('*', { count: 'exact', head: true }).eq('league', lg);
    if (count && count > 0) leagues.push(lg);
  }

  info(`${leagues.length} Ligen in Supabase gefunden`);

  let totalRows = 0;
  const allData = {};

  for (const league of leagues) {
    if (leagueFilter && league !== leagueFilter) continue;

    // Fetch all rows for this league (paginated, max 1000 per request)
    let rows = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('team_xg_history')
        .select('team, opponent, league, venue, match_date, xg, xga, goals_for, goals_against')
        .eq('league', league)
        .order('match_date', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) { console.log(`${c.yellow}⚠ ${league}: ${error.message}${c.reset}`); break; }
      if (!data || data.length === 0) break;

      rows = rows.concat(data);
      offset += pageSize;
      if (data.length < pageSize) break;
    }

    if (rows.length === 0) continue;

    const teams = new Set(rows.map(r => r.team));
    const dates = rows.map(r => r.match_date).filter(Boolean);
    const minDate = dates.length ? dates[0] : '?';
    const maxDate = dates.length ? dates[dates.length - 1] : '?';

    // Save per-league file
    const filename = `xg-${league}-${timestamp}.json`;
    const filepath = resolve(backupDir, filename);
    writeFileSync(filepath, JSON.stringify(rows, null, 2));
    ok(`${league}: ${rows.length} Einträge, ${teams.size} Teams (${minDate} → ${maxDate}) → ${filename}`);

    allData[league] = rows;
    totalRows += rows.length;
  }

  // Save combined file
  if (Object.keys(allData).length > 1) {
    const allFilename = `xg-all-${timestamp}.json`;
    const allFilepath = resolve(backupDir, allFilename);
    const combined = Object.values(allData).flat();
    writeFileSync(allFilepath, JSON.stringify(combined, null, 2));
    ok(`Gesamt: ${totalRows} Einträge → ${allFilename}`);
  }

  // Summary
  console.log(`\n${c.bold}${c.cyan}━━━ BACKUP ZUSAMMENFASSUNG ━━━${c.reset}`);
  console.log(`  Verzeichnis: ${backupDir}`);
  console.log(`  Ligen:       ${Object.keys(allData).length}`);
  console.log(`  Einträge:    ${totalRows}`);
  console.log(`  Datum:       ${timestamp}\n`);
}

main().catch(e => { console.error(`Fehler: ${e.message}`); process.exit(1); });

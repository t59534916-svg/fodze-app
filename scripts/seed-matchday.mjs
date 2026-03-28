#!/usr/bin/env node
/**
 * FODZE Universal Matchday Seeder
 * ════════════════════════════════
 * Lädt eine JSON-Datei in Supabase für die FODZE App.
 *
 * Usage:
 *   node scripts/seed-matchday.mjs --file spieltag.json --league bundesliga
 *   node scripts/seed-matchday.mjs --file pl-mw32.json --league epl --label "Matchweek 32"
 *
 * Flags:
 *   --file    Pfad zur JSON-Datei (Pflicht)
 *   --league  Liga-Code: bundesliga, bundesliga2, liga3, epl, la_liga, serie_a, ligue_1 (Pflicht)
 *   --label   Spieltag-Label (optional, wird aus JSON gelesen wenn nicht angegeben)
 *   --date    Match-Datum YYYY-MM-DD (optional, wird aus JSON gelesen)
 *   --dry     Nur validieren, nicht seeden
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Load .env.local automatically ───────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ─── Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://resdrxgfcpaxosiwnxiu.supabase.co';
const SERVICE_ROLE_KEY = process.env.FODZE_SERVICE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('❌ FODZE_SERVICE_KEY fehlt.');
  console.error('   Option 1: In .env.local eintragen (empfohlen)');
  console.error('   Option 2: export FODZE_SERVICE_KEY="eyJ..."');
  console.error('   Key findest du: Supabase Dashboard → Settings → API → service_role (secret)');
  process.exit(1);
}

const VALID_LEAGUES = [
  'bundesliga', 'bundesliga2', 'liga3',
  'epl', 'la_liga', 'serie_a', 'ligue_1',
  'championship', 'eredivisie',
  'cl', 'el', 'pokal',
];

// ─── Parse CLI Args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
const isDry = args.includes('--dry');
const filePath = getArg('file');
const league = getArg('league');
const labelOverride = getArg('label');
const dateOverride = getArg('date');

if (!filePath || !league) {
  console.error(`
╔══════════════════════════════════════════════════════════════╗
║  FODZE Matchday Seeder                                      ║
╠══════════════════════════════════════════════════════════════╣
║  Usage:                                                     ║
║    node scripts/seed-matchday.mjs --file data.json \\        ║
║         --league bundesliga                                 ║
║                                                             ║
║  Liga-Codes: ${VALID_LEAGUES.join(', ')}
║                                                             ║
║  Flags:                                                     ║
║    --file    JSON-Datei (Pflicht)                            ║
║    --league  Liga-Code (Pflicht)                             ║
║    --label   Spieltag-Label (optional)                       ║
║    --date    Datum YYYY-MM-DD (optional)                     ║
║    --dry     Nur validieren                                  ║
╚══════════════════════════════════════════════════════════════╝
  `);
  process.exit(1);
}

if (!VALID_LEAGUES.includes(league)) {
  console.error(`❌ Unbekannte Liga: "${league}". Gültige Codes: ${VALID_LEAGUES.join(', ')}`);
  process.exit(1);
}

// ─── Read & Validate JSON ────────────────────────────────────────────
let data;
try {
  const raw = readFileSync(filePath, 'utf-8');
  data = JSON.parse(raw);
} catch (e) {
  console.error(`❌ Kann Datei nicht lesen/parsen: ${filePath}`);
  console.error(e.message);
  process.exit(1);
}

// Validate structure
const errors = [];
if (!data.matches || !Array.isArray(data.matches)) {
  errors.push('Fehlt: "matches" Array');
}
if (data.matches) {
  data.matches.forEach((m, i) => {
    if (!m.home?.name) errors.push(`Match ${i + 1}: home.name fehlt`);
    if (!m.away?.name) errors.push(`Match ${i + 1}: away.name fehlt`);

    // xG validation
    const hxg = m.home?.xg_h8, axg = m.away?.xg_a8;
    if (hxg !== undefined && hxg > 0) {
      const perGame = hxg / (m.home?.games || 8);
      if (perGame > 3.5) errors.push(`Match ${i + 1}: ${m.home.name} xg_h8=${hxg} → ${perGame.toFixed(1)}/Spiel unrealistisch hoch`);
      if (hxg < 1 && hxg > 0) errors.push(`Match ${i + 1}: ${m.home.name} xg_h8=${hxg} → vermutlich Durchschnitt statt Summe?`);
    }
    if (axg !== undefined && axg > 0) {
      const perGame = axg / (m.away?.games || 8);
      if (perGame > 3.5) errors.push(`Match ${i + 1}: ${m.away.name} xg_a8=${axg} → ${perGame.toFixed(1)}/Spiel unrealistisch hoch`);
      if (axg < 1 && axg > 0) errors.push(`Match ${i + 1}: ${m.away.name} xg_a8=${axg} → vermutlich Durchschnitt statt Summe?`);
    }
  });
}

if (errors.length > 0) {
  console.error('❌ Validierungsfehler:');
  errors.forEach(e => console.error(`   • ${e}`));
  process.exit(1);
}

const label = labelOverride || data.matchday || data.matchday_label || 'Import';
const matchDate = dateOverride || data.date || new Date().toISOString().slice(0, 10);

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  FODZE Matchday Seeder                                      ║
╠══════════════════════════════════════════════════════════════╣
║  Liga:     ${league.padEnd(48)}║
║  Spieltag: ${label.padEnd(48)}║
║  Datum:    ${matchDate.padEnd(48)}║
║  Spiele:   ${String(data.matches.length).padEnd(48)}║
║  Modus:    ${(isDry ? 'DRY RUN (nur Validierung)' : 'LIVE').padEnd(48)}║
╚══════════════════════════════════════════════════════════════╝
`);

// Show matches
data.matches.forEach((m, i) => {
  const hxg = m.home?.xg_h8 || '—';
  const axg = m.away?.xg_a8 || '—';
  const src = hxg !== '—' && Number(hxg) > 0 ? '✅' : '⚠️';
  console.log(`  ${src} ${m.home?.name?.padEnd(25) || '?'} vs  ${m.away?.name || '?'}  (xG: ${hxg}/${axg})`);
});

if (isDry) {
  console.log('\n✅ Validierung erfolgreich. Verwende ohne --dry zum Seeden.');
  process.exit(0);
}

// ─── Get User ID ─────────────────────────────────────────────────────
async function getUserId() {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const users = await resp.json();
  return users.users?.[0]?.id;
}

// ─── Seed to Supabase ────────────────────────────────────────────────
async function seed() {
  const userId = await getUserId();
  if (!userId) {
    console.error('❌ Kein User in Supabase gefunden. Erstelle zuerst einen Account.');
    process.exit(1);
  }

  console.log(`\n→ Seeding als User: ${userId}`);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/matchdays`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      league,
      matchday_label: label,
      match_date: matchDate,
      data,
      created_by: userId,
    }),
  });

  if (resp.ok) {
    const result = await resp.json();
    console.log(`✅ Erfolgreich geseeded! ID: ${result[0]?.id}`);
    console.log(`   ${data.matches.length} Spiele in "${league}" / "${label}"`);
  } else {
    const err = await resp.text();
    console.error(`❌ Seed fehlgeschlagen: ${resp.status}`);
    console.error(err);
    process.exit(1);
  }
}

seed().catch(e => {
  console.error('❌ Fehler:', e.message);
  process.exit(1);
});

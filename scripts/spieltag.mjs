#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * FODZE Spieltag-Wizard — Interaktiver Admin-Workflow
 * ═══════════════════════════════════════════════════════════════
 *
 * Führt den Admin Schritt für Schritt durch den Workflow.
 * Generiert Prompts → Admin fügt in seine AIs ein → Ergebnisse zurück.
 *
 * Usage:  node scripts/spieltag.mjs
 *         npm run spieltag
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createClient } from '@supabase/supabase-js';

// ─── Setup ──────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

const LEAGUES = {
  bundesliga:   "Bundesliga",
  bundesliga2:  "2. Bundesliga",
  liga3:        "3. Liga",
  epl:          "Premier League",
  la_liga:      "La Liga",
  serie_a:      "Serie A",
  ligue_1:      "Ligue 1",
  championship: "Championship",
  eredivisie:   "Eredivisie",
  cl:           "Champions League",
  el:           "Europa League",
  pokal:        "DFB-Pokal",
};

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

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Colors ─────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  red: '\x1b[31m', cyan: '\x1b[36m', gold: '\x1b[33m',
};
const log = (msg) => console.log(msg);
const step = (n, title) => log(`\n${c.gold}${c.bold}═══ SCHRITT ${n}/6: ${title} ═══${c.reset}\n`);
const ok = (msg) => log(`${c.green}✓ ${msg}${c.reset}`);
const warn = (msg) => log(`${c.yellow}⚠ ${msg}${c.reset}`);
const info = (msg) => log(`${c.dim}  ${msg}${c.reset}`);
const prompt_box = (title, text) => {
  log(`\n${c.cyan}${c.bold}┌─── PROMPT: ${title} ───${c.reset}`);
  log(`${c.cyan}│${c.reset}`);
  for (const line of text.split('\n')) log(`${c.cyan}│${c.reset}  ${line}`);
  log(`${c.cyan}│${c.reset}`);
  log(`${c.cyan}${c.bold}└─── Kopiere diesen Prompt in Claude/Gemini/ChatGPT ───${c.reset}\n`);
};

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  log(`\n${c.gold}${c.bold}  ⚽ FODZE SPIELTAG-WIZARD${c.reset}`);
  log(`${c.dim}  Interaktiver Admin-Workflow für Spieltag-Updates${c.reset}`);
  log(`${c.dim}  Prompts werden generiert → Du fügst sie in deine AIs ein${c.reset}\n`);

  // ─── Liga auswählen ───────────────────────────────────────────
  log(`${c.bold}Verfügbare Ligen:${c.reset}`);
  const keys = Object.keys(LEAGUES);
  keys.forEach((k, i) => log(`  ${c.cyan}${String(i + 1).padStart(2)}${c.reset}  ${LEAGUES[k]}`));

  const ligaIdx = parseInt(await ask(`\n${c.bold}Liga wählen (1-${keys.length}): ${c.reset}`)) - 1;
  if (ligaIdx < 0 || ligaIdx >= keys.length) { log(`${c.red}Ungültige Auswahl.${c.reset}`); process.exit(1); }
  const leagueKey = keys[ligaIdx];
  const leagueName = LEAGUES[leagueKey];
  ok(`Liga: ${leagueName}`);

  const spieltag = await ask(`${c.bold}Spieltag (z.B. "Spieltag 28"): ${c.reset}`);
  const datum = await ask(`${c.bold}Datum (YYYY-MM-DD): ${c.reset}`);
  log('');

  // ═══ SCHRITT 1: SPIELPLAN ═════════════════════════════════════
  step(1, "SPIELPLAN HOLEN");

  prompt_box("Spielplan", `Du bist ein Fußball-Datenanalyst. Gib mir alle Spiele der ${leagueName} am ${spieltag} (${datum}).

Format pro Spiel:
- Heim vs Gast (Anstoßzeit)
- Tabellenposition beider Teams
- Relevanter Kontext (Derby? Abstiegskampf? Aufstiegsrennen? CL-Sandwich?)

Quellen: kicker.de, sofascore.com, transfermarkt.de`);

  info("Kopiere den Prompt → Füge in Claude/Gemini/ChatGPT ein → Kopiere Ergebnis");
  const spielplanText = await askMultiline(`\n${c.bold}Spielplan-Ergebnis hier einfügen:${c.reset}`);
  ok(`Spielplan eingefügt (${spielplanText.split('\n').length} Zeilen)`);

  // ═══ SCHRITT 2: xG-DATEN ═════════════════════════════════════
  step(2, "xG-DATEN HOLEN");

  const hasUnderstat = ["bundesliga", "epl", "la_liga", "serie_a", "ligue_1"].includes(leagueKey);

  if (hasUnderstat) {
    const understatMap = { bundesliga: "Bundesliga", epl: "EPL", la_liga: "La_liga", serie_a: "Serie_A", ligue_1: "Ligue_1" };
    log(`  ${c.bold}Understat verfügbar!${c.reset} Echte xG-Daten.\n`);
    log(`  ${c.cyan}1.${c.reset} Öffne: ${c.bold}https://understat.com/league/${understatMap[leagueKey]}${c.reset}`);
    log(`  ${c.cyan}2.${c.reset} Chrome DevTools (F12) → Console`);
    log(`  ${c.cyan}3.${c.reset} Paste dieses Script:\n`);

    prompt_box("Understat Console Script", `const result = {};
Object.keys(teamsData).forEach(id => {
  const t = teamsData[id];
  const home = t.history.filter(g => g.h_a === 'h');
  const away = t.history.filter(g => g.h_a === 'a');
  const hL8 = home.slice(-8), aL8 = away.slice(-8);
  result[t.title] = {
    xg_h8:  +hL8.reduce((s,g) => s + parseFloat(g.xG), 0).toFixed(1),
    xga_h8: +hL8.reduce((s,g) => s + parseFloat(g.xGA), 0).toFixed(1),
    xg_a8:  +aL8.reduce((s,g) => s + parseFloat(g.xG), 0).toFixed(1),
    xga_a8: +aL8.reduce((s,g) => s + parseFloat(g.xGA), 0).toFixed(1),
  };
});
copy(JSON.stringify(result, null, 2));
console.log('✓ xG-Daten in Clipboard!');`);

    log(`  ${c.cyan}4.${c.reset} Daten sind automatisch im Clipboard.\n`);
  } else {
    warn(`${leagueName} hat keine Understat-Daten. Nutze Tore als Proxy.\n`);

    prompt_box("Tore-Proxy Prompt", `Gib mir für ALLE Teams der ${leagueName} (Stand ${spieltag}) die Heim- und Auswärtsstatistiken.

Format pro Team:
Team: Heimspiele/Heimtore/Heimgegentore | Auswärtsspiele/Auswärtstore/Auswärtsgegentore

Quelle: kicker.de/${leagueKey}/tabelle (Heim/Auswärts-Tabelle)
Antworte als JSON: { "Team": { "home_games": X, "home_goals": X, "home_conceded": X, "away_games": X, "away_goals": X, "away_conceded": X } }`);
  }

  const xgInput = await askMultiline(`${c.bold}xG-Daten / Tor-Daten hier einfügen (JSON):${c.reset}`);
  let xgData = null;
  if (xgInput.trim()) {
    try {
      xgData = JSON.parse(xgInput.match(/\{[\s\S]*\}/)?.[0] || xgInput);
      ok(`xG-Daten für ${Object.keys(xgData).length} Teams geladen.`);
    } catch { warn("JSON konnte nicht geparst werden — wird in Schritt 4 manuell ergänzt."); }
  }

  // ═══ SCHRITT 3: VERLETZUNGEN ══════════════════════════════════
  step(3, "VERLETZUNGEN & KONTEXT");
  info("Sende diesen Prompt an 2-3 AIs parallel für Cross-Check!\n");

  prompt_box("Verletzungen (an Claude + Gemini + ChatGPT)", `Du bist ein Fußball-Datenanalyst. Recherchiere für die ${leagueName} ${spieltag} (${datum}) die aktuellsten Informationen.

${spielplanText.split('\n').slice(0, 15).join('\n')}

Pro Spiel brauche ich:
1. VERLETZUNGEN & SPERREN: Wer fehlt? (Name, Grund)
2. FORM: Letzte 5 Ergebnisse (W/D/L mit Gegnern)
3. GELBGEFÄHRDETE: Spieler auf 4 Gelben Karten
4. SCHIEDSRICHTER: Wer pfeift? Karten-Schnitt als DEZIMALZAHL (z.B. "Ø 4.2", NICHT "Ø 4")
5. KONTEXT: Derby? Sandwich? Abstiegskampf?
6. TOP-TORSCHÜTZEN: Die 3 wahrscheinlichsten Torschützen pro Spiel (basierend auf Saisontore, xG-Anteil, aktuelle Form). NUR angeben wenn SICHERE Daten vorhanden — lieber weglassen als raten!

Quellen: transfermarkt.de, kicker.de, sofascore.com, understat.com

Antworte als strukturiertes JSON:
{
  "matches": [
    {
      "match": "Heim vs Gast",
      "injuries_home": "Spieler1 (Grund), Spieler2 (Grund)",
      "injuries_away": "...",
      "form_home": "W W D L W",
      "form_away": "...",
      "yellow_risk_home": "Spieler auf 4 Gelben",
      "yellow_risk_away": "...",
      "referee": "Name, Ø 4.2 Karten/Spiel",
      "context": "Kurzbeschreibung",
      "top_scorers": [
        {"name": "Spieler", "team": "H oder A", "prob": 0.30}
      ]
    }
  ]
}

WICHTIG: top_scorers nur angeben wenn du dir SICHER bist (Saisontore + aktuelle Form + Aufstellung bestätigt). Probability = geschätzte Trefferwahrscheinlichkeit für dieses Spiel (0.10 bis 0.50). Weglassen wenn unsicher.`);

  info("Tipp: Verletzungen die 2+ AIs nennen → sicher. Nur 1 AI → als 'fraglich' markieren.");
  const injText = await askMultiline(`\n${c.bold}Verletzungs-Daten hier einfügen (bestes Ergebnis oder Zusammenfassung):${c.reset}`);
  ok(`Verletzungsdaten eingefügt (${injText.split('\n').length} Zeilen)`);

  // ═══ SCHRITT 4: JSON ZUSAMMENBAUEN ════════════════════════════
  step(4, "JSON ZUSAMMENBAUEN");

  prompt_box("JSON-Assembly (an deine beste AI)", `Baue aus diesen Daten ein FODZE-JSON für ${leagueName} ${spieltag} (${datum}).

═══ SPIELPLAN ═══
${spielplanText.slice(0, 1500)}

═══ xG-DATEN ═══
${xgData ? JSON.stringify(xgData, null, 2).slice(0, 2000) : "Nicht verfügbar — schätze basierend auf Tabelle/Form"}

═══ VERLETZUNGEN ═══
${injText.slice(0, 2000)}

═══ REGELN ═══
- xg_h8 = SUMME der xG der letzten 8 HEIMSPIELE (Bereich 5.0-25.0, NICHT Durchschnitte!)
- xga_h8 = SUMME der xGA kassiert in letzten 8 HEIMSPIELEN
- xg_a8 = SUMME der xG der letzten 8 AUSWÄRTSSPIELE
- xga_a8 = SUMME der xGA in letzten 8 AUSWÄRTSSPIELEN
- Faustregel: Wert / 8 ≈ 0.8–2.5 pro Spiel. Wenn Wert < 5.0 → wahrscheinlich Durchschnitt statt Summe!
- Tags: DERBY, SANDWICH, RELEGATION wenn zutreffend
- data_confidence: HIGH (Understat xG), MEDIUM (geschätzt), LOW (wenig Daten)
- referee: IMMER mit Dezimal-Karten-Schnitt: "Name, Ø 4.2 Karten/Spiel"
- top_scorers: NUR wenn sichere Daten vorhanden (Saisontore + Form). Weglassen wenn unsicher!

Antworte NUR mit dem JSON:
{
  "league": "${leagueName}",
  "matchday": "${spieltag}",
  "date": "${datum}",
  "data_confidence": "...",
  "sources": ["..."],
  "matches": [
    {
      "home": { "name": "...", "xg_h8": 12.5, "xga_h8": 7.2, "games": 8, "form": "W W D L W", "injuries": "...", "yellow_risk": "...", "notes": "" },
      "away": { "name": "...", "xg_a8": 9.0, "xga_a8": 11.5, "games": 8, "form": "L W W D W", "injuries": "...", "yellow_risk": "...", "notes": "" },
      "tags": [], "context": "...", "referee": "Name, Ø 4.2 Karten/Spiel", "kickoff": "15:30",
      "top_scorers": [{"name": "Spieler", "team": "H", "prob": 0.30}]
    }
  ]
}`);

  const jsonInput = await askMultiline(`\n${c.bold}Fertiges FODZE-JSON hier einfügen:${c.reset}`);
  let matchdayData = null;

  try {
    const jsonMatch = jsonInput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Kein JSON gefunden");
    const rawParsed = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());

    // Zod Runtime-Validierung
    try {
      const { validateMatchdayJSON } = await import('../src/lib/schemas.ts');
      const validation = validateMatchdayJSON(rawParsed);
      if (!validation.success) {
        warn("Zod-Validierung fehlgeschlagen:");
        validation.errors?.forEach(e => warn(`  ${e}`));
      } else {
        if (validation.warnings?.length) {
          validation.warnings.forEach(w => warn(w));
        }
        matchdayData = validation.data;
      }
    } catch {
      // Zod nicht verfügbar (TS import failed) — fallback auf manuelles Parsing
      matchdayData = rawParsed;
    }
    if (!matchdayData) matchdayData = rawParsed;
    ok(`JSON geparst: ${matchdayData.matches?.length || 0} Spiele`);
  } catch (e) {
    log(`${c.red}✗ JSON-Fehler: ${e.message}${c.reset}`);
    log(`${c.red}  Bitte korrigiere das JSON und versuche es erneut.${c.reset}`);
    process.exit(1);
  }

  // Validierung
  log(`\n${c.bold}Validierung:${c.reset}`);
  let warnings = 0;
  for (const m of matchdayData.matches || []) {
    const h = m.home, a = m.away;
    log(`  ${h?.name || "?"} vs ${a?.name || "?"} (${m.kickoff || "?"})`);

    if (!h?.xg_h8 || h.xg_h8 === 0) { warn(`  ${h?.name}: xg_h8 fehlt!`); warnings++; }
    else if (h.xg_h8 < 4) { warn(`  ${h?.name}: xg_h8=${h.xg_h8} — zu niedrig! Durchschnitt statt Summe?`); warnings++; }
    else { info(`  H: xG=${h.xg_h8} xGA=${h.xga_h8} (${(h.xg_h8/(h.games||8)).toFixed(2)}/Sp)`); }

    if (!a?.xg_a8 || a.xg_a8 === 0) { warn(`  ${a?.name}: xg_a8 fehlt!`); warnings++; }
    else if (a.xg_a8 < 4) { warn(`  ${a?.name}: xg_a8=${a.xg_a8} — zu niedrig! Durchschnitt statt Summe?`); warnings++; }
    else { info(`  A: xG=${a.xg_a8} xGA=${a.xga_a8} (${(a.xg_a8/(a.games||8)).toFixed(2)}/Sp)`); }

    if (m.tags?.length > 0) info(`  Tags: ${m.tags.join(', ')}`);
    log('');
  }

  if (warnings === 0) ok("Alle Werte im erwarteten Bereich!");
  else warn(`${warnings} Warnung(en) — bitte prüfen bevor du seedest.`);

  // Vorschau
  log(`\n${c.bold}Zusammenfassung:${c.reset}`);
  log(`  Liga:      ${matchdayData.league || leagueName}`);
  log(`  Spieltag:  ${matchdayData.matchday || spieltag}`);
  log(`  Datum:     ${matchdayData.date || datum}`);
  log(`  Konfidenz: ${matchdayData.data_confidence || "?"}`);
  log(`  Spiele:    ${matchdayData.matches?.length || 0}`);
  log(`  Quellen:   ${matchdayData.sources?.join(', ') || "?"}`);

  // JSON speichern
  const outFile = resolve(__dirname, `${leagueKey}-${spieltag.replace(/\s/g, "-").toLowerCase()}.json`);
  writeFileSync(outFile, JSON.stringify(matchdayData, null, 2));
  ok(`JSON gespeichert: ${outFile}`);

  // ═══ SCHRITT 5: IN SUPABASE SEEDEN ════════════════════════════
  step(5, "IN SUPABASE SEEDEN");

  if (warnings > 0) {
    warn(`Es gibt ${warnings} Warnung(en). Trotzdem seeden?`);
  }

  const confirm = await ask(`${c.bold}In Supabase seeden? (j/n): ${c.reset}`);
  if (confirm.toLowerCase() !== 'j' && confirm.toLowerCase() !== 'y') {
    warn("Seed übersprungen. JSON liegt bereit zum manuellen Import.");
  } else {
    try {
      const { error } = await supabase.from('matchdays').insert({
        league: leagueKey,
        matchday_label: matchdayData.matchday || spieltag,
        match_date: matchdayData.date || datum,
        data: matchdayData,
        created_by: (await supabase.auth.getUser()).data?.user?.id || null,
      });
      if (error) throw error;
      ok(`${leagueName} ${spieltag} erfolgreich in Supabase gespeichert!`);
      info("Die App zeigt den Spieltag jetzt automatisch an.");
    } catch (e) {
      warn(`Seed-Fehler: ${e.message}`);
      info(`Alternativ: JSON-Datei in der App importieren.`);
      info(`Datei: ${outFile}`);
    }
  }

  // ═══ SCHRITT 6: QUOTEN ════════════════════════════════════════
  step(6, "QUOTEN EINGEBEN");
  log(`  Öffne die FODZE App und navigiere zu ${c.bold}${leagueName}${c.reset}.\n`);
  log(`  Pro Spiel:`);
  log(`  ${c.cyan}1.${c.reset} Spiel antippen → Quoten-Tab`);
  log(`  ${c.cyan}2.${c.reset} 1/X/2 Quoten von deinem Buchmacher eingeben`);
  log(`  ${c.cyan}3.${c.reset} Auto-Save nach 1.5s`);
  log(`  ${c.cyan}4.${c.reset} Value-Bets erscheinen automatisch im Überblick-Tab\n`);
  log(`  ${c.dim}Tipp: Wenn Live-Odds aktiv sind, werden Quoten automatisch befüllt.${c.reset}\n`);

  // ═══ FERTIG ═══════════════════════════════════════════════════
  log(`${c.gold}${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  log(`${c.gold}${c.bold}  ✓ SPIELTAG-WIZARD ABGESCHLOSSEN${c.reset}`);
  log(`${c.gold}${c.bold}═══════════════════════════════════════════════════════${c.reset}`);
  log(`\n  Liga:      ${leagueName}`);
  log(`  Spieltag:  ${spieltag}`);
  log(`  Spiele:    ${matchdayData.matches?.length || 0}`);
  log(`  JSON:      ${outFile}`);
  log(`  Supabase:  ${confirm?.toLowerCase() === 'j' ? '✓ Geseeded' : '○ Nicht geseeded'}`);
  log(`  Warnungen: ${warnings}`);
  log(`\n  ${c.dim}Nächster Schritt: App öffnen → Quoten eingeben → Value Bets finden${c.reset}\n`);

  rl.close();
}

main().catch(e => { console.error(`${c.red}Fehler: ${e.message}${c.reset}`); process.exit(1); });

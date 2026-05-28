#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// FODZE – 3. Liga Spieltag 31 Seed Script (Enriched)
// Kombiniert echte xG-Werte (PDF-Analyse), Tor-Proxys (kicker.de),
// Context-Tags, Verletzungen, Schiedsrichter & Wetterdaten.
//
// Verwendung:
//   node scripts/seed-3liga.mjs <email> <password>
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
// 2026-05-28: service_role EXCLUSIVELY (ingestion script). Bypasses RLS
// entirely — no per-row auth-subquery CPU (migration-rls-auth-subquery.sql),
// and anon can't INSERT past the service-only write policies anyway.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars: SUPABASE_URL and SUPABASE_SERVICE_KEY required");
  process.exit(1);
}

// ─── Heim/Auswärts-Statistiken (Stand: Spieltag 30) ────────────────
// Quelle: kicker.de Heim-/Auswärtstabelle
// Format: [Spiele, Tore, Gegentore]
const HOME = {
  "VfL Osnabrück":       [15, 21, 10],
  "Hansa Rostock":       [15, 27, 20],
  "TSV Havelse":         [15, 23, 32],
  "TSV 1860 München":    [15, 27, 19],
  "Erzgebirge Aue":      [15, 19, 24],
  "VfB Stuttgart II":    [14, 19, 19],
  "Rot-Weiss Essen":     [15, 32, 19],
  "SSV Ulm 1846":        [15, 19, 31],
  "1. FC Saarbrücken":   [14, 24, 17],
  "Alemannia Aachen":    [14, 19, 26],
  "SC Verl":             [15, 40, 16],
  "Energie Cottbus":     [16, 33, 21],
  "MSV Duisburg":        [14, 31, 15],
  "SV Waldhof Mannheim": [15, 28, 23],
  "SV Wehen Wiesbaden":  [15, 31, 16],
  "FC Viktoria Köln":    [15, 22, 19],
  "FC Ingolstadt 04":    [15, 22, 20],
  "TSG Hoffenheim II":   [15, 27, 26],
  "Jahn Regensburg":     [15, 25, 22],
  "1. FC Schweinfurt 05":[15, 20, 29],
};

const AWAY = {
  "VfL Osnabrück":       [14, 28, 16],
  "Hansa Rostock":       [15, 26, 12],
  "TSV Havelse":         [15, 20, 37],
  "TSV 1860 München":    [14, 18, 18],
  "Erzgebirge Aue":      [15, 15, 30],
  "VfB Stuttgart II":    [16, 17, 30],
  "Rot-Weiss Essen":     [14, 27, 29],
  "SSV Ulm 1846":        [15, 20, 31],
  "1. FC Saarbrücken":   [16, 16, 29],
  "Alemannia Aachen":    [16, 34, 25],
  "SC Verl":             [15, 30, 25],
  "Energie Cottbus":     [14, 22, 23],
  "MSV Duisburg":        [15, 21, 25],
  "SV Waldhof Mannheim": [15, 21, 31],
  "SV Wehen Wiesbaden":  [15, 11, 17],
  "FC Viktoria Köln":    [14, 18, 20],
  "FC Ingolstadt 04":    [15, 28, 21],
  "TSG Hoffenheim II":   [14, 26, 27],
  "Jahn Regensburg":     [15, 17, 23],
  "1. FC Schweinfurt 05":[15,  9, 40],
};

// ─── Echte xG-Werte aus PDF-Analyse (wo verfügbar) ─────────────────
// Überschreiben die Tor-Proxy-Berechnung für diese Teams
// Format: { xg8: number|null, xga8: number|null }
// null = kein Wert bekannt, Tor-Proxy wird verwendet
const REAL_XG_HOME = {
  "VfL Osnabrück":   { xg8: null, xga8: 6.1 },   // PDF: xGA-Conceded = 6.1
  "Rot-Weiss Essen": { xg8: null, xga8: null },   // PDF: Proxy "15.0 (Tore)" für xG
};
const REAL_XG_AWAY = {
  "SC Verl":         { xg8: 18.2, xga8: null },   // PDF: xG = 18.2 (letzte 8)
  "TSV Havelse":     { xg8: 8.1,  xga8: null },   // PDF: xG = 8.1
  "SV Waldhof Mannheim": { xg8: 10.3, xga8: null }, // PDF: xG = 10.3
};

// ─── xG-Berechnung mit Fallback auf Tor-Proxy ─────────────────────
// Echte xG-Werte überschreiben den Proxy wo verfügbar.
// Proxy-Info wird in notes gespeichert (Engine braucht numerische Werte).
function xg8(stats, realOverrides) {
  const [games, goals, against] = stats;
  const proxyXg  = Math.round((goals / games) * 8 * 10) / 10;
  const proxyXga = Math.round((against / games) * 8 * 10) / 10;
  return {
    xg:      realOverrides?.xg8  ?? proxyXg,
    xga:     realOverrides?.xga8 ?? proxyXga,
    xgIsProxy:  realOverrides?.xg8  == null,
    xgaIsProxy: realOverrides?.xga8 == null,
  };
}

// ─── Spieltag 31 – Angereicherte Paarungen (4.-5. April 2026) ──────
const MATCHES = [
  // ── Samstag, 4. April 2026 ──────────────────────────────────────
  {
    home: "VfL Osnabrück", away: "1. FC Schweinfurt 05",
    kickoff: "14:00", date: "2026-04-04",
    context_tags: ["promotion_race", "home_fortress"],
    home_injuries: ["Robin Fabinski (IV, Knieverletzung)"],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "S S S U S",
    away_form: "N N N N U",
    referee: "Daniel Siebert",
    referee_avg_yellows: 4.41,
    referee_avg_fouls: 23.71,
    weather: "14°C, leicht bewölkt",
    pitch: "gut",
    context: "Tabellenführer empfängt Absteiger. Osnabrück mit 10 Heimsiegen in 15 Spielen (home_fortress). Schweinfurt auf letztem Platz mit nur 1 Auswärtssieg in 15 Spielen (away_weak). Siebert pfeift extrem restriktiv – zerhackt den Spielfluss.",
    h2h_last5: "",
  },
  {
    home: "Hansa Rostock", away: "FC Viktoria Köln",
    kickoff: "14:00", date: "2026-04-04",
    context_tags: ["promotion_race"],
    home_injuries: [],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "S U S U S",
    away_form: "N S N S N",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "gut",
    context: "Rostock (4., 53 Pkt) verteidigt Aufstiegsplatz. Stark defensiv auswärts (12 Gegentore in 15 Auswärtsspielen).",
    h2h_last5: "",
  },
  {
    home: "TSV Havelse", away: "Energie Cottbus",
    kickoff: "14:00", date: "2026-04-04",
    context_tags: ["relegation_battle", "key_player_out"],
    home_injuries: ["Torben Engelking (MS, Innenbandverletzung)"],
    away_injuries: ["Jonas Hofmann (ZM, Muskelverletzung)", "Tolga Cigerci (ZM, Muskelfaserriss – Rückkehr Ende März)"],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "N N U N N",
    away_form: "S U S N S",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "schlecht",
    context: "Havelse (19., 23 Pkt) kämpft gegen Abstieg. Nur 8.1 xG in letzten 8 Spielen – extreme Offensivschwäche. Cottbus (3., 54 Pkt) fehlt das kreative Zentrum (Hofmann + Cigerci), aber Erik Engelhardt (15 Saisontore) liefert weiter.",
    h2h_last5: "",
  },
  {
    home: "TSV 1860 München", away: "SV Waldhof Mannheim",
    kickoff: "14:00", date: "2026-04-04",
    context_tags: ["key_player_out"],
    home_injuries: ["Max Christiansen (ZDM, kürzlich operiert – Knie)", "Tunay Deniz (ZDM, Knieverletzung)", "Damjan Dordan (ZDM, Knieverletzung)"],
    away_injuries: ["Jascha Brandt (LM, Kreuzbandriss – Langzeitausfall)"],
    home_suspensions: [],
    away_suspensions: ["Terrence Boyd (ST, Rotsperre – Tätlichkeit)"],
    home_form: "U S S N S",
    away_form: "S N S N N",
    referee: "Felix Zwayer",
    referee_avg_yellows: 3.82,
    referee_avg_fouls: 17.76,
    weather: "11°C, Nieselregen",
    pitch: "schlecht / rutschig",
    context: "1860 fehlt das gesamte defensive Mittelfeld (3 ZDMs mit Knieverletzung). Mannheim ohne Boyd (Rotsperre) – nicht nur Torschütze, sondern Zielspieler für lange Bälle. Zwayer lässt das Spiel laufen (niedrigster Unterbrechungswert aller Top-Schiedsrichter). Nasser Rasen im Grünwalder Stadion.",
    h2h_last5: "",
  },
  {
    home: "Erzgebirge Aue", away: "TSG Hoffenheim II",
    kickoff: "14:00", date: "2026-04-04",
    context_tags: ["relegation_battle"],
    home_injuries: ["Maxim Burghardt (Verletzung)"],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "N U N U N",
    away_form: "S N S N N",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "",
    context: "Aue (17., 24 Pkt) im Abstiegskampf. Hoffenheim II (15., 35 Pkt) noch nicht sicher. Beide Teams mit negativer Tordifferenz.",
    h2h_last5: "",
  },
  {
    home: "VfB Stuttgart II", away: "Jahn Regensburg",
    kickoff: "16:30", date: "2026-04-04",
    context_tags: [],
    home_injuries: [],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "S N S N N",
    away_form: "S N N S S",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "gut",
    context: "Stuttgart II (14., 38 Pkt) mit ausgeglichener Heimbilanz. Regensburg (12., 39 Pkt) schwach auswärts (4S 3U 8N).",
    h2h_last5: "",
  },
  {
    home: "Rot-Weiss Essen", away: "MSV Duisburg",
    kickoff: "16:30", date: "2026-04-04",
    context_tags: ["derby", "promotion_race", "key_player_out"],
    home_injuries: ["Jannik Mause (ST, Ellenbogenverletzung)", "Marek Janssen (ST, Achillessehnenprobleme)"],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "S S N S S",
    away_form: "U S N U S",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "",
    context: "Revierderby! RWE (5., 52 Pkt) vs Duisburg (6., 51 Pkt) – direktes Duell um den Aufstieg. Essen mit 59 Saisontoren, aber beide abschlussstarken Neuner (Mause, Janssen) fallen aus. Duisburg zu Hause ungeschlagen (10S 4U 0N), aber auswärts schwächer.",
    h2h_last5: "",
  },
  // ── Sonntag, 5. April 2026 ──────────────────────────────────────
  {
    home: "SSV Ulm 1846", away: "SC Verl",
    kickoff: "13:30", date: "2026-04-05",
    context_tags: ["relegation_battle", "defensive_crisis", "momentum_negative"],
    home_injuries: ["Johannes Reichert (IV, Kreuzbandriss)", "Marcel Wenig (ZM, Kreuzbandriss)", "Jonas David (IV, Kreuzbandriss)", "Dominik Martinovic (ST, Knieverletzung)"],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "N N N U N",
    away_form: "S S S U S",
    referee: "Sascha Stegemann",
    referee_avg_yellows: 3.38,
    referee_avg_fouls: 19.81,
    weather: "15°C, trocken",
    pitch: "gut",
    context: "Existenzkampf trifft auf Torfestival. Ulm (18., 25 Pkt) mit historischer defensive_crisis: 15.2 xGA in 8 Spielen, 4 Kreuzbandrisse (3 Innenverteidiger!). Verl (2., 54 Pkt) mit elitärer Offensive: 18.2 xG in 8 Spielen, 67 Saisontore. Berkan Taz (13 Assists), Timur Gayret. Stegemann pfeift moderat – begünstigt Verls Kurzpassspiel.",
    h2h_last5: "",
  },
  {
    home: "1. FC Saarbrücken", away: "FC Ingolstadt 04",
    kickoff: "16:30", date: "2026-04-05",
    context_tags: ["momentum_negative", "key_player_out"],
    home_injuries: ["Richard Neudecker (ZM, Kreuzbandriss)", "Abdoulaye Kamara (ZM, Wadenverletzung)", "Manuel Zeitz (ZM, Zahn-OP)", "Sebastian Vasiliadis (ZM, Infektion)"],
    away_injuries: [],
    home_suspensions: [],
    away_suspensions: [],
    home_form: "N U N U N",
    away_form: "S U N S U",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "",
    context: "Saarbrücken (16., 33 Pkt) im freien Fall – 0 Siege in letzten 5 Spielen, komplettes zentrales Mittelfeld verletzt. Nur 2 Auswärtssiege in der gesamten Saison (away_weak). Ingolstadt (11., 40 Pkt) mit starker Auswärtsoffensive (28 Tore in 15 Auswärtsspielen).",
    h2h_last5: "",
  },
  {
    home: "Alemannia Aachen", away: "SV Wehen Wiesbaden",
    kickoff: "19:30", date: "2026-04-05",
    context_tags: ["key_player_out"],
    home_injuries: ["Gideon Jung (IV, Prellung)", "Mika Hanraths (IV, Muskelbündelriss)"],
    away_injuries: [],
    home_suspensions: ["Lars Gindorf (ST, Gelbsperre – 20 Saisontore, ~40% der Teamproduktion)"],
    away_suspensions: [],
    home_form: "S N S S N",
    away_form: "N U N N U",
    referee: "",
    referee_avg_yellows: null,
    referee_avg_fouls: null,
    weather: "",
    pitch: "",
    context: "Aachen (10., 44 Pkt) fehlt der unangefochtene Torschützenkönig Gindorf (20 Tore = 40% der offensiven Produktion) – fatale Gelbsperre. Defensiv zusätzlich geschwächt (Jung, Hanraths out). Wiesbaden (8., 48 Pkt) extrem schwach auswärts (11 Tore in 15 Spielen).",
    h2h_last5: "",
  },
];

// ─── Matchday-JSON bauen ───────────────────────────────────────────
function buildMatchday() {
  const matches = MATCHES.map((m) => {
    const hRaw = xg8(HOME[m.home], REAL_XG_HOME[m.home]);
    const aRaw = xg8(AWAY[m.away], REAL_XG_AWAY[m.away]);

    // Proxy-Hinweis für notes (Engine braucht numerische Werte)
    const hNotes = [
      hRaw.xgIsProxy  ? `xG ${hRaw.xg} = Tor-Proxy (Tore)` : `xG ${hRaw.xg} = echte xG`,
      hRaw.xgaIsProxy ? `xGA ${hRaw.xga} = Tor-Proxy (Tore)` : `xGA ${hRaw.xga} = echte xG`,
    ].join("; ");
    const aNotes = [
      aRaw.xgIsProxy  ? `xG ${aRaw.xg} = Tor-Proxy (Tore)` : `xG ${aRaw.xg} = echte xG`,
      aRaw.xgaIsProxy ? `xGA ${aRaw.xga} = Tor-Proxy (Tore)` : `xGA ${aRaw.xga} = echte xG`,
    ].join("; ");

    return {
      home: {
        name: m.home,
        xg_h8: hRaw.xg,
        xga_h8: hRaw.xga,
        games: 8,
        form: m.home_form,
        injuries: m.home_injuries.join("; ") || "",
        yellow_risk: "",
        notes: hNotes,
      },
      away: {
        name: m.away,
        xg_a8: aRaw.xg,
        xga_a8: aRaw.xga,
        games: 8,
        form: m.away_form,
        injuries: m.away_injuries.join("; ") || "",
        yellow_risk: "",
        notes: aNotes,
      },
      tags: m.context_tags,
      context: m.context,
      referee: m.referee,
      referee_avg_yellows: m.referee_avg_yellows,
      referee_avg_fouls: m.referee_avg_fouls,
      home_injuries: m.home_injuries,
      away_injuries: m.away_injuries,
      home_suspensions: m.home_suspensions,
      away_suspensions: m.away_suspensions,
      h2h_last5: m.h2h_last5,
      weather: m.weather,
      pitch: m.pitch,
      kickoff: m.kickoff,
    };
  });

  return {
    league: "3. Liga",
    matchday: "Spieltag 31",
    date: "2026-04-04",
    matches,
    data_confidence: "MEDIUM-HIGH",
    sources: [
      "kicker.de (Heim-/Auswärtstabelle Spieltag 30)",
      "PDF-Analyse '3. Liga Datenquellen für JSON' (echte xG für Verl, Havelse, Mannheim, Osnabrück-xGA, Ulm-xGA)",
      "transfermarkt.de (Verletzungen, Sperren)",
      "playerstats.football (Schiedsrichter-Statistiken)",
    ],
  };
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Verwendung: node scripts/seed-3liga.mjs <email> <password>");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Einloggen
  console.log(`Logging in as ${email}...`);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) {
    console.error("Login fehlgeschlagen:", authError.message);
    process.exit(1);
  }
  const userId = authData.user.id;
  console.log(`Eingeloggt als ${authData.user.email} (${userId})`);

  // 2. Matchday bauen
  const matchday = buildMatchday();
  console.log(`\n${matchday.matches.length} Spiele für ${matchday.league} ${matchday.matchday}:\n`);
  for (const m of matchday.matches) {
    const h = m.home;
    const a = m.away;
    const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    console.log(`  ${h.name} (xG ${h.xg_h8} / xGA ${h.xga_h8})`);
    console.log(`    vs ${a.name} (xG ${a.xg_a8} / xGA ${a.xga_a8})  ${m.kickoff}${tags}`);
    if (m.referee) console.log(`    Schiri: ${m.referee} (${m.referee_avg_yellows} Gelbe/Spiel)`);
    if (m.home_injuries.length) console.log(`    Heim-Ausfälle: ${m.home_injuries.join(", ")}`);
    if (m.away_injuries.length) console.log(`    Gast-Ausfälle: ${m.away_injuries.join(", ")}`);
    if (m.home_suspensions.length) console.log(`    Heim-Sperren: ${m.home_suspensions.join(", ")}`);
    if (m.away_suspensions.length) console.log(`    Gast-Sperren: ${m.away_suspensions.join(", ")}`);
    console.log();
  }

  // 3. In Supabase einfügen
  console.log("Füge Spieltag in Datenbank ein...");
  const { error: insertError } = await supabase.from("matchdays").insert({
    league: "liga3",
    matchday_label: matchday.matchday,
    match_date: matchday.date,
    data: matchday,
    created_by: userId,
  });

  if (insertError) {
    console.error("Insert fehlgeschlagen:", insertError.message);
    process.exit(1);
  }

  console.log("✓ Spieltag 31 der 3. Liga erfolgreich in die Datenbank eingefügt!");

  // 4. Verifizieren
  const { data: verify } = await supabase
    .from("matchdays")
    .select("id, league, matchday_label, created_at")
    .eq("league", "liga3")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (verify) {
    console.log(`\nVerifizierung: ID=${verify.id}, Liga=${verify.league}, Spieltag=${verify.matchday_label}`);
  }

  await supabase.auth.signOut();
}

main().catch(console.error);

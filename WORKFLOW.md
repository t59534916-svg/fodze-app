# FODZE Workflow — Spieltag-Analyse ohne API

Dieses Dokument beschreibt den kompletten Workflow für einen Spieltag-Analysezyklus.
Da FODZE keine API-Integration nutzt, werden Daten manuell über externe AIs gesammelt und in die Datenbank geladen.

---

## Übersicht: 6 Tasks pro Spieltag

```
1. Spielplan holen ─────► 2. xG-Daten holen ─────► 3. Verletzungen sammeln
                                                            │
6. Quoten & Value Bets ◄── 5. In DB seeden ◄──── 4. JSON zusammenbauen
```

---

## Task 1: Spielplan holen

**Ziel:** Alle Spiele eines Spieltags mit Datum, Anstoßzeit und Kontext.

**Warum zuerst?** Der Spielplan ist die Grundlage — ohne Paarungen können wir keine xG-Daten zuordnen.

### Prompt (kopiere in Claude/Gemini/ChatGPT):

```
Du bist ein Fußball-Datenanalyst. Gib mir alle Spiele der [LIGA] am [SPIELTAG] [DATUM].

Format pro Spiel:
- Heim vs Gast (Anstoßzeit)
- Tabellenposition beider Teams
- Relevanter Kontext (Derby? Abstiegskampf? Aufstiegsrennen? CL-Sandwich?)

Quellen: kicker.de, sofascore.com, transfermarkt.de
```

**Beispiel-Eingabe:** `Bundesliga Spieltag 28, 04.04.2026`

---

## Task 2: xG-Daten holen

**Ziel:** Echte Expected-Goals-Summen der letzten 8 Heim-/Auswärtsspiele pro Team.

**Warum xG statt Tore?** xG misst die Qualität der Chancen, nicht nur ob sie reingingen. Ein Team mit xG 2.0 aber 0 Toren hatte Pech — das Modell erkennt die echte Stärke.

### Ligen MIT xG-Daten (Understat):
- Bundesliga, Premier League, La Liga, Serie A, Ligue 1

### Browser-Console Script (Chrome DevTools → Console):

1. Öffne die Understat-Seite der Liga:
   - BL: `https://understat.com/league/Bundesliga`
   - PL: `https://understat.com/league/EPL`
   - La Liga: `https://understat.com/league/La_liga`
   - Serie A: `https://understat.com/league/Serie_A`
   - Ligue 1: `https://understat.com/league/Ligue_1`

2. Öffne Chrome DevTools (F12) → Console-Tab

3. Paste dieses Script:

```javascript
// ═══ FODZE xG Fetcher — Copy-Paste in Browser Console ═══
// Extrahiert xG-Summen der letzten 8 Heim/Auswärtsspiele pro Team
const result = {};
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
// Kopiere die Ausgabe
copy(JSON.stringify(result, null, 2));
console.log('✅ xG-Daten in Clipboard kopiert!');
console.table(result);
```

4. Die Daten werden automatisch in dein Clipboard kopiert.

### Ligen OHNE xG-Daten (Tore als Proxy):
- 2. Bundesliga, 3. Liga, andere

Für diese Ligen verwenden wir Tore als Proxy. Die Formel:
```
xg_h8 = (Heimtore_gesamt / Heimspiele) × 8
```

**Prompt für Tore-Proxy:**
```
Gib mir für folgende Teams der [LIGA] die Heim- und Auswärtsstatistiken (Stand [SPIELTAG]):
- Heimspiele: Anzahl, Tore geschossen, Tore kassiert
- Auswärtsspiele: Anzahl, Tore geschossen, Tore kassiert

Quelle: kicker.de/[liga]/tabelle (Heim/Auswärts-Tabelle)
Format: JSON mit team → {home_games, home_goals, home_conceded, away_games, away_goals, away_conceded}
```

---

## Task 3: Verletzungen & Kontext sammeln

**Ziel:** Aktuelle Ausfälle, Sperren, Formkurve und Kontext für jedes Spiel.

**Warum 3 AIs parallel?** Einzelne AIs haben oft veraltete oder unvollständige Daten. Durch Cross-Check steigt die Zuverlässigkeit.

### Multi-AI Prompt (an Claude, Gemini UND ChatGPT senden):

```
Du bist ein Fußball-Datenanalyst. Recherchiere für diese Spiele der [LIGA] ([SPIELTAG], [DATUM]) die aktuellsten Informationen.

SPIEL 1: [Heim] vs [Gast] ([Anstoßzeit])
SPIEL 2: [Heim] vs [Gast] ([Anstoßzeit])
[... weitere Spiele ...]

Recherchiere für JEDES Spiel:

1. VERLETZUNGEN & SPERREN (aktuell, Stand heute):
   - Wer fehlt? (Name, Position, Grund: Verletzung/Gelbsperre/Rotsperre)
   - Wer ist fraglich/angeschlagen?
   - Rückkehrer?

2. FORM (letzte 5 Spiele):
   - Ergebnisse mit Gegnern (z.B. "2:1 vs Dresden (H), 0:1 vs Aue (A)")

3. TAKTIK & AUFSTELLUNG:
   - Erwartete Formation
   - Trainerzitate/Pressekonferenz-Aussagen falls verfügbar

4. SCHIEDSRICHTER:
   - Wer pfeift?
   - Karten-/Foul-Schnitt pro Spiel

5. WETTER in der jeweiligen Stadt zur Anstoßzeit

6. KONTEXT:
   - Tabellensituation beider Teams
   - Ist es ein Derby / Abstiegskampf / Aufstiegsrennen?
   - CL/EL-Sandwich? (Europaspiel vor oder nach dem Spieltag)
   - Besonderheiten (Nachholspiel, englische Woche, etc.)

Quellen: sofascore.com, transfermarkt.de, kicker.de, ligaportal.de

Antworte als strukturiertes JSON mit diesem Format:
{
  "data_confidence": "HIGH/MEDIUM/LOW",
  "matches": [
    {
      "match": "Heim vs Gast",
      "injuries_suspensions": { "Heim": "...", "Gast": "..." },
      "form_last_5": { "Heim": "W W L D W", "Gast": "..." },
      "referee": "Name",
      "context": "..."
    }
  ]
}

Nur FAKTEN, keine Vorhersagen.
```

### Auswertung der 3 AI-Antworten:
- Verletzungen die **alle 3** nennen → sicher
- Verletzungen die **2 von 3** nennen → wahrscheinlich
- Verletzungen die **nur 1** nennt → mit Vorsicht, als "fraglich" markieren

---

## Task 4: JSON zusammenbauen

**Ziel:** Alle gesammelten Daten in das exakte Format bringen, das die FODZE Engine erwartet.

**Warum dieses Format?** Die Dixon-Coles Engine liest `xg_h8` als Summe der xG der letzten 8 Heimspiele. Falsche Werte (z.B. Durchschnitte statt Summen) führen zu komplett falschen Vorhersagen.

### JSON-Template:

```json
{
  "league": "Bundesliga",
  "matchday": "Spieltag 28",
  "date": "2026-04-04",
  "data_confidence": "HIGH",
  "sources": ["understat.com", "transfermarkt.de", "kicker.de"],
  "matches": [
    {
      "home": {
        "name": "Bayer 04 Leverkusen",
        "xg_h8": 18.6,
        "xga_h8": 7.9,
        "games": 8,
        "form": "W W W D W",
        "injuries": "Tapsoba (Gelbsperre)",
        "yellow_risk": "Grimaldo",
        "notes": "xG Understat"
      },
      "away": {
        "name": "VfL Wolfsburg",
        "xg_a8": 7.8,
        "xga_a8": 15.5,
        "games": 8,
        "form": "D W W L D",
        "injuries": "Dárdai (Kreuzband), Fischer (Oberschenkel)",
        "yellow_risk": "Wimmer, Eriksen",
        "notes": "xG Understat"
      },
      "tags": [],
      "context": "Leverkusen Heimfestung. Wolfsburg auswärts schwach.",
      "referee": "Daniel Siebert",
      "kickoff": "15:30"
    }
  ]
}
```

### Feld-Erklärungen:

| Feld | Typ | Erklärung | Typischer Bereich |
|------|-----|-----------|-------------------|
| `xg_h8` | number | **SUMME** der xG in den letzten 8 Heimspielen | 5.0 – 25.0 |
| `xga_h8` | number | **SUMME** der xGA (kassierte xG) in letzten 8 Heimspielen | 5.0 – 20.0 |
| `xg_a8` | number | **SUMME** der xG in den letzten 8 Auswärtsspielen | 5.0 – 20.0 |
| `xga_a8` | number | **SUMME** der xGA in letzten 8 Auswärtsspielen | 5.0 – 25.0 |
| `games` | number | Anzahl der Spiele im Window (normalerweise 8) | 4 – 8 |
| `form` | string | Letzte 5 Ergebnisse (W/D/L oder S/U/N) | "W W D L W" |
| `injuries` | string | Ausfälle mit Grund | "Name (Grund)" |
| `tags` | string[] | Context-Tags | `["DERBY", "SANDWICH"]` |

### Validierungsregeln:
- ❌ `xg_h8: 1.5` → Das ist ein Durchschnitt, nicht eine Summe!
- ✅ `xg_h8: 12.0` → Summe über 8 Spiele (≈1.5/Spiel)
- ❌ `xg_h8: 0` → Fehlt! Engine kann nicht rechnen
- Faustregel: Wert / games ≈ 0.8 – 2.5 pro Spiel

### Mögliche Tags:
- `DERBY` — Emotionales Duell, mehr Fouls/Karten erwartet
- `SANDWICH` — CL/EL-Spiel vor/nach dem Spieltag → Rotation wahrscheinlich
- `RELEGATION` — Abstiegskampf-Duell
- `promotion_race` — Aufstiegsrennen
- `home_fortress` — Team mit extremer Heimbilanz
- `key_player_out` — Schlüsselspieler fehlt
- `momentum_negative` — Team in Formkrise

### Prompt für AI-gestütztes JSON-Assembly:

```
Baue aus diesen Daten ein FODZE-JSON. Beachte:
- xg_h8/xga_h8 = SUMME der letzten 8 Heimspiele (nicht Durchschnitt!)
- xg_a8/xga_a8 = SUMME der letzten 8 Auswärtsspiele
- Typischer Bereich: 5.0–25.0
- Tags: DERBY, SANDWICH, RELEGATION, etc.
- Injuries: Name (Grund, voraussichtliche Rückkehr)

xG-Daten: [paste xG output from Task 2]
Verletzungen: [paste from Task 3]
Spielplan: [paste from Task 1]

Gib das JSON exakt im FODZE-Format aus (siehe Template).
```

---

## Task 5: In Supabase seeden

**Ziel:** Das fertige JSON in die Datenbank laden, damit die App es anzeigt.

**Warum Supabase?** Die App lädt beim Start automatisch den neuesten Spieltag pro Liga aus Supabase. Ohne DB-Eintrag → keine Daten in der App.

### Option A: Universelles Seed-Script (empfohlen)

1. Speichere dein JSON als Datei, z.B. `bundesliga-st28.json`
2. Führe aus:

```bash
cd fodze-app
node scripts/seed-matchday.mjs --file bundesliga-st28.json --league bundesliga
```

Unterstützte Liga-Codes:
- `bundesliga`, `bundesliga2`, `liga3`
- `epl`, `la_liga`, `serie_a`, `ligue_1`
- `championship`, `eredivisie`
- `cl`, `el`, `pokal`

### Option B: Import-Modus in der App

1. Öffne FODZE App → Wähle Liga
2. Klick auf "Import (JSON)"
3. Paste das komplette JSON
4. Klick "ANALYSIEREN"

Die Daten werden automatisch in Supabase gespeichert.

---

## Task 6: Quoten eingeben & Value Bets finden

**Ziel:** Buchmacher-Quoten mit Modell-Wahrscheinlichkeiten vergleichen.

**Warum Quoten eingeben?** Das Dixon-Coles Modell berechnet faire Wahrscheinlichkeiten. Der Edge (= pModel - pMarket) zeigt, wo der Buchmacher falsch liegt.

### In der App:

1. Klick auf ein Spiel → Expandieren
2. Unter "DEINE QUOTEN": 1, X, 2, Ü2.5, U2.5, BTTS eingeben
3. Klick "SPEICHERN"
4. Die App zeigt automatisch:
   - **Edge** pro Markt (grün = Value, rot = kein Value)
   - **Kelly-Einsatz** (optimale Einsatzhöhe)
   - **Konfidenz** (HIGH/MEDIUM/LOW basierend auf Edge-Signifikanz)

### Grading-System:
- **Grade A**: Edge ≥ 8% — Starker Value Bet
- **Grade B**: Edge 5-8% — Guter Value Bet
- **Grade C**: Edge 3-5% — Marginaler Value
- **Grade D**: Edge < 3% — Zu knapp
- **Grade F**: Negativer Edge — Finger weg!

### Einsatz-Empfehlung:
- ¼ Kelly (konservativ) — Standard
- Kelly-Cap: Maximal 5% der Bankroll pro Wette
- Gesamtexposure: Maximal 15% der Bankroll pro Spieltag

---

## Liga-spezifische Heimfaktoren

Das Modell nutzt team-spezifische Heimfaktoren für die 3. Liga:

| Team | Heimfaktor | Grund |
|------|-----------|-------|
| SV Waldhof Mannheim | 1.65 | Carl-Benz-Stadion Atmosphäre |
| Hallescher FC | 1.56 | Erdgas Sportpark Heimstärke |
| Rot-Weiss Essen | 1.47 | Hafenstraße Kult |
| Energie Cottbus | 1.44 | Stadion der Freundschaft |
| MSV Duisburg | 1.31 | Schauinsland-Reisen-Arena |
| TSV 1860 München | 1.30 | Grünwalder Stadion |
| Dynamo Dresden | 1.28 | Rudolf-Harbig-Stadion |
| BVB II / Bayern II | 0.78-0.84 | Kaum Fans bei Reserve-Teams |
| Alle anderen | 1.22 | Liga-Standard |

---

## Checkliste: Neuer Spieltag

- [ ] Task 1: Spielplan geholt
- [ ] Task 2: xG-Daten von Understat/kicker.de
- [ ] Task 3: Verletzungen von 3 AIs gesammelt
- [ ] Task 4: JSON zusammengebaut und validiert
- [ ] Task 5: In Supabase geseeded
- [ ] Task 6: Quoten eingegeben, Value Bets identifiziert

# CLAUDE.md — Entwickler-Guide für Claude Code

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App mit drei Prediction Engines:
- **Standard**: 4-Modell Ensemble (Dixon-Coles + Elo + Logistic EWMA + Market) mit Bayesian Bootstrap Confidence
- **@annafrick13 v1**: ML-Poisson Engine — Poisson GLM prädiktiert λH/λA → Dixon-Coles 15×15 Matrix → alle Märkte aus einer Quelle
- **@annafrick13 v2**: LightGBM Tweedie → 14 npxG-Features + Monotonic Constraints → Dixon-Coles Matrix → Dual-Track Calibration → Goldilocks Guard (Brier 0.5808)

Vergleicht mit Buchmacher-Quoten, findet Value-Bets und berechnet Kelly-Einsätze.

## Projekt starten

```bash
npm install
npm run dev       # http://localhost:3000
npm run test      # 49 Tests (Engine + Poisson + Zod Schemas)
npm run build     # Production Build
```

## Architektur auf einen Blick

```
Supabase (DB + Auth)
  ↕
Next.js 14 App Router
  ├── Contexts: AppContext (User/Liga) → MatchdayContext (Matches/Odds)
  ├── Pages: / → /matchday → /matchday/combos → /anna → /anna-analysen → /simulator → /performance
  ├── API: /api/anna (Groq/Claude Streaming), /api/matchday (Claude — nur Text, kein xG)
  ├── Engines: dixon-coles.ts (Standard) + poisson-ml-engine.ts (v1) + poisson-ml-engine-v2.ts (v2)
  └── Engine Registry: engine-registry.ts (Multi-Engine Dispatch)
```

## Wichtige Dateien

| Datei | Was es tut | Wann anfassen |
|-------|-----------|---------------|
| `src/lib/dixon-coles.ts` | Prediction Engine (NICHT ändern ohne Tests) | Nur bei Modell-Verbesserungen |
| `src/contexts/MatchdayContext.tsx` | Matchday State + calcMatch | Bei neuen Datenfeldern |
| `src/contexts/AppContext.tsx` | User/Liga/Profil State | Bei neuen User-Settings |
| `src/app/matchday/page.tsx` | Haupt-Analyseseite | Bei UI-Änderungen an Matchday |
| `src/components/match/MatchDetail.tsx` | Tab-System (Überblick/Quoten/Statistik) | Bei neuen Analyse-Features |
| `src/app/anna/page.tsx` | Ask Anna Chat | Bei AI-Flow-Änderungen |
| `src/lib/anna-prompt.ts` | System-Prompt für Anna | Bei Prompt-Tuning |
| `src/styles/tokens.ts` | Design Tokens (Source of Truth) | Bei Design-Änderungen |
| `src/types/match.ts` | TypeScript Interfaces | Bei neuen Datenstrukturen |
| `src/lib/poisson-ml-engine.ts` | @annafrick13 v1 (Poisson GLM) | Bei v1-Engine-Änderungen |
| `src/lib/poisson-ml-engine-v2.ts` | @annafrick13 v2 (LightGBM Tweedie) | Bei v2-Engine-Änderungen |
| `src/lib/lgbm-runtime.ts` | LightGBM Tree-Traversierung (Browser) | Bei Modell-Format-Änderungen |
| `src/lib/poisson-regression.ts` | Poisson GLM Runtime (v1 λ predict) | Bei v1 Feature-Änderungen |
| `src/lib/calibration.ts` | Isotonic Calibration + Dual-Track | Bei Kalibrierungs-Änderungen |
| `src/lib/system-bets.ts` | Kombi-Engine (SGM + Akku + Kelly) | Bei Multi-Bet-Änderungen |
| `src/lib/engine-registry.ts` | Engine-Definitionen + Dispatch | Bei neuen Engines |
| `public/lgbm-model-v2.json` | Trainiertes LightGBM Modell (v2) | Nach Retraining |
| `src/app/fuck-betting/page.tsx` | Anna's Analysen — quotenfreier Vollreport | Bei Report-Erweiterungen |
| `src/lib/team-colors.ts` | Trikot-Farben (21 Ligen, ~350 Teams) | Bei Team-Änderungen |
| `src/lib/team-resolver.ts` | FODZE↔CSV↔Understat Team-Name-Mapping (~350 Teams) | Bei neuen Teams/Ligen |
| `src/lib/calibration.ts` | Per-League Kalibrierung (Platt + Isotonic, 18 Ligen) | Bei Kalibrierungs-Änderungen |

## Unterstützte Ligen (21)

| Liga | Key | xG | Kalibrierung | Datenquelle |
|------|-----|:--:|:------------:|-------------|
| Bundesliga | `bundesliga` | ✅ | Per-League | Understat + CSV |
| Premier League | `epl` | ✅ | Per-League | Understat + CSV |
| La Liga | `la_liga` | ✅ | Per-League | Understat + CSV |
| Serie A | `serie_a` | ✅ | Per-League | Understat + CSV |
| Ligue 1 | `ligue_1` | ✅ | Per-League | Understat + CSV |
| Eredivisie | `eredivisie` | ✅ | Per-League | Understat + CSV |
| Championship | `championship` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| 2. Bundesliga | `bundesliga2` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| 3. Liga | `liga3` | ✅ FootyStats | ❌ | FootyStats (echte xG) |
| Champions League | `cl` | ❌ | ❌ | Placeholder |
| Europa League | `el` | ❌ | ❌ | Placeholder |
| Primeira Liga | `primeira_liga` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Jupiler Pro | `jupiler_pro` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Süper Lig | `super_lig` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| La Liga 2 | `la_liga2` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Serie B | `serie_b` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Ligue 2 | `ligue_2` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Scottish Prem | `scottish_prem` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| Super League Greece | `greek_sl` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| League One | `league_one` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |
| League Two | `league_two` | ✅ Shots | Per-League | CSV Shots-to-xG Modell |

**Elo-Ratings**: 655 Teams aus 146.382 historischen Matches (football-data.co.uk CSVs, 25 Saisons)
**Kalibrierung**: Platt-Params + Isotonic-Kurven per Liga (18 Ligen mit ≥300 Matches)
**Shots-to-xG Modell**: `xG = -0.045 + 0.242×SOT + 0.065×SOFF` (R²=0.57, trainiert auf 3.283 Matches mit echtem Understat-xG)
**Per-Match xG-History**: 7.350 Einträge in `team_xg_history` für 12 non-Understat-Ligen (source: `shots-model`)
**xG-Quellen**: Understat (6 Top-Ligen, echte xG) → Shots-Modell (12 weitere Ligen, geschätzte xG aus Schussdaten) → FootyStats (3. Liga)

## Konventionen

### Styling
- **Inline Styles** mit Token-Referenzen (`color.gold`, `fontSize.sm`, `space[5]`)
- **Kein Tailwind, kein CSS-in-JS** — alles über `src/styles/tokens.ts` + `components.ts`
- Farben: Leather (#1a0f0a) + Gold (#d4b86a) Theme
- Cards: `card()` Factory aus `components.ts`
- Buttons: `button("gold" | "outline" | "ghost")`

### Komponenten
- **"use client"** auf allen Komponenten (Next.js Client Components)
- Props typisieren mit Interfaces aus `@/types/match`
- Shared Components in `src/components/shared/`
- Seitenspezifische in `src/components/match/`, `anna/`, `home/`, `matchday/`

### State
- **AppContext**: User, Liga, Profil, Bankroll, Engine-Auswahl — global
- **MatchdayContext**: Matchday-Daten, Odds, berechnete Matches — überlebt Navigation
- **sessionStorage**: Combo-Auswahl — überlebt Seitenwechsel
- **Lokaler State**: UI-State (selectedMatch, showTips, tab)

### Neue Seite hinzufügen
1. `src/app/neue-seite/page.tsx` erstellen
2. `<AppShell>` wrappen
3. Navbar-Tab in `src/components/layout/Navbar.tsx` hinzufügen (falls nötig)

### Neue Berechnung hinzufügen
1. Funktion in `src/lib/dixon-coles.ts` exportieren
2. In `MatchdayContext.tsx` → `calcMatch()` einbinden
3. In `MatchDetail.tsx` anzeigen (passendem Tab)
4. Test in `tests/dixon-coles.test.ts` schreiben

## xG-Daten Format

**KRITISCH**: xG-Werte sind **SUMMEN** über 8 Spiele, NICHT Durchschnitte!

```
xg_h8 = 14.2  ← Summe xG der letzten 8 HEIMSPIELE (Bereich 5-25)
xga_h8 = 8.5  ← Summe xGA kassiert in letzten 8 HEIMSPIELEN
xg_a8 = 10.8  ← Summe xG der letzten 8 AUSWÄRTSSPIELE
xga_a8 = 12.1 ← Summe xGA in letzten 8 AUSWÄRTSSPIELEN
```

Faustregel: Wert / 8 ≈ 0.8–2.5 pro Spiel. Wenn < 5.0 → wahrscheinlich Durchschnitt!

## AI-Integration

```
Priority: GROQ_API_KEY (kostenlos) → CLAUDE_API_KEY (bezahlt) → Offline (Templates)
```

- **Groq**: Llama 3.3 70B, SSE Streaming, OpenAI-kompatibel → transformiert zu Anthropic-Format
- **Claude**: Sonnet 4, native SSE
- **Offline**: `generateOfflineAnalysis()` in anna/page.tsx — rein aus berechneten Daten

## Tests

```bash
npm run test              # Alle Tests
npm run test:watch        # Watch-Mode
npx vitest run --reporter=verbose  # Detailliert
```

Tests decken ab:
- LEAGUES Konfiguration (21 Ligen)
- xG-Daten Validierung
- Vig-Removal (Overround-Berechnung)
- Dixon-Coles λ-Berechnung + Score-Matrix
- Kelly-Criterion Staking
- Home-Factor Lookup
- Poisson GLM λ-Prediction (9 Features, Clamping, Dimension Guard)
- Feature-Sync TS↔Python (Rest Days, SoS, Derby)

## Prediction Engines

### Standard (ensemble-v1)
4-Modell Ensemble: Dixon-Coles (5%) + Elo (12%) + Logistic (64%) + Market (20%). Blended 1X2-Wahrscheinlichkeiten. O25 aus Matrix, 1X2 aus Ensemble.

### @annafrick13 v1 (poisson-ml)
ML-Poisson GLM → Dixon-Coles Matrix → ALLE Märkte aus einer Quelle.

**Pipeline:** Supabase xG History → EWMA → SoS-Adjust → 9 Features → Poisson GLM → λH, λA → 15×15 Matrix

**Training:** `python3 tools/retrain_all.py` → `public/ensemble-model.json`

### @annafrick13 v2 (poisson-ml-v2)
LightGBM Tweedie → Monotonic Constraints → Dixon-Coles Matrix → Dual-Track Calibration.

**Pipeline:** Understat npxG → EWMA → SoS → 14 Features → LightGBM Tweedie (Optuna) → λH, λA → optimiertes ρ → 15×15 Matrix → Track A (Display) + Track B (Kelly)

**Features (14):**
| # | Name | Beschreibung | Mono H/A |
|---|------|-------------|----------|
| 0 | npxg_diff_ewma | Non-Penalty xG Differenz (EWMA) | +1 / -1 |
| 1 | npxga_diff_ewma | Defensive npxG Differenz | -1 / +1 |
| 2 | elo_diff | (Elo H - Elo A) / 400 | +1 / -1 |
| 3 | total_npxg | Kombinierte Angriffsstaerke | — |
| 4 | home_factor | Liga/Team Heimfaktor | +1 / -1 |
| 5 | league_avg | Liga-Durchschnitt Tore/Spiel | — |
| 6 | rest_days_diff | (Rest Home - Rest Away) / 7 | +1 / -1 |
| 7 | sos_strength | SoS-Korrektur Differenz | — |
| 8 | is_derby | Binaer (25 Derby-Paarungen) | — |
| 9 | npxg_momentum | Akute Form vs. Saison-Baseline | +1 / -1 |
| 10 | npxg_volatility | Konsistenz (Std 8-Spiele) | — |
| 11 | h2h_npxg_diff | Letzte 5 H2H-Begegnungen | — |
| 12 | ppda_ratio_diff | Pressing-Intensitaet (EWMA) | — |
| 13 | deep_completions_diff | Final-Third Qualitaet (EWMA) | +1 / -1 |

**Guardrails:**
- Monotonic Constraints (physisch unmoeglich unreale Extreme zu produzieren)
- Lambda Clamping [0.3, 4.5]
- Goldilocks Edge Guard: 2.5% - 7.5% (< = Rauschen, > = fehlende Info)
- Dual-Track Divergenz-Warnung (Track A +EV, Track B -EV = overconfident)
- Volatilitaets-Dampener in Kombiwetten (Kelly -15% bis -45%)
- Feature-Dimension Guard (14≠14 → null)
- Kein LLM-Daten Fallback (ohne History → null)

**Training:**
```bash
source tools/venv/bin/activate
DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v2.py --use-full-csv --n-trials 50
```
Output: `public/lgbm-model-v2.json` (Tree-Struktur + Golden Tests, ~300 KB)

**Matchday Predictions:**
```bash
python3 tools/matchday-predict.py --analyse          # Naechster Spieltag
python3 tools/matchday-predict.py --all-leagues --json  # JSON Export
python3 tools/matchday-enrich.py --all-leagues          # + Wetter + Schiedsrichter
```

## Anna's Analysen (/fuck-betting)

Quotenfreier Vollreport über ALLE geladenen Ligen. Erreichbar über den "Anna's Analysen" Tile auf der Startseite.

**Engine-Hierarchie:**
1. **@annafrick13 v2** — wenn LightGBM-Modell geladen UND per-Match xG-History vorhanden
2. **Standard** (`calcLambdas`) — wenn v2 `null` zurückgibt oder kein Modell/History
3. **Liga-Durchschnitt** — wenn gar keine xG-Daten (z.B. 3. Liga), mit "Ohne xG"-Warnung

**Datenfluss:**
```
Supabase matchdays → loadLatestMatchday() pro Liga
  → loadTeamXGHistory() für EWMA-Features (v2)
  → calcMatchPoissonMLv2() || calcLambdas() → buildMatrix()
  → deriveAllMarkets() + alle Spezial-Märkte → MatchReport
```

**Report-Sektionen (30+):**
1X2, Double Chance, DNB, Goals O/U 1.5-5.5, BTTS, Clean Sheet, Win to Nil,
Team Goals, Exact Team Goals, Odd/Even, Race to 2 Goals, HT 1X2, HT Goals O/U,
HT Correct Scores, HT/FT, 2nd Half Markets, Goal in Both Halves, Score Matrix
Heatmap (7x7), Correct Score FT, Winning Margin, Asian Handicap, Yellow Cards,
First Goal Timing, xG Comparison Bar, Form Visual

**Badges im Match-Header:**
- `@annafrick13` (grün) — v2 Engine aktiv
- `Ohne xG` (rot) — keine xG-Daten, Liga-Durchschnitt als Fallback

## Team-Daten System

### Team Colors (`src/lib/team-colors.ts`)
`[primary, secondary]` Hex-Paare für Trikot-SVG. Abgedeckte Ligen:
Bundesliga, 2. Bundesliga, 3. Liga, Premier League, Championship,
La Liga, La Liga 2, Serie A, Serie B, Ligue 1, Ligue 2, Eredivisie,
Primeira Liga, Jupiler Pro, Süper Lig, Scottish Premiership,
Super League Greece, League One, League Two.
Alias-Einträge für Kurzformen (z.B. "QPR", "West Brom").

### Team Resolver (`src/lib/team-resolver.ts`)
Mapped zwischen drei Namensräumen:
- **FODZE**: "FC Bayern München" (App-intern)
- **CSV**: "Bayern Munich" (football-data.co.uk, Elo)
- **Understat**: "Bayern Munich" (Supabase xG History)

Resolution: exact FODZE → exact CSV → exact Understat → case-insensitive → substring.

### Team Scraper Map (`src/lib/scrapers/team-map.ts`)
Zusätzliches Mapping für Scraper-Kontexte (Understat HTML → FODZE Name).

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- Lint → TypeCheck → Test → Build
- Triggered auf Push/PR zu `main`
- Lint + TypeCheck dürfen feilen (continue-on-error)
- Tests + Build müssen bestehen

## Type System

### TeamData — Strikte xG-Keys (kein Index-Signatur)
`TeamData` hat explizite Properties (`xg_h8`, `xga_h8`, `xg_a8`, `xga_a8`) statt `[key: string]: any`. Dynamischer Key-Zugriff (`t[xk]`) wurde durch explizite Property-Zugriffe ersetzt.

### MatchCalc — Interface Segregation
`ProcessedMatch.calc` ist `MatchCalc | null` mit strukturell getyptem `enh`-Feld. Die Engine gibt `EnhancedResult` zurück, das via `as MatchCalc` assertion zugewiesen wird. Core-Fields (lambdaH, mk, matrix, ciH, formH, tagCorrections) sind strikt typisiert, Engine-Erweiterungen via `Record<string, any>` intersection erlaubt.

### OddsData — Index-Signatur für parseFloat(o[k])
`OddsData` hat typisierte Haupt-Keys (`h`, `d`, `a`, `o25`) plus Index-Signatur `[key: string]: string | OddsSharpData | number | undefined` für den dynamischen `parseFloat(String(o[k]))` Zugriff.

## Bekannte Einschränkungen

- `MatchCalc.enh` nutzt `Record<string, any> &` Intersection — ein Kompromiss weil `Markets` (Engine-intern) und `MarketProbs` (types/match.ts) strukturell identisch aber nominell verschieden sind
- Standalone-Seiten (Simulator, SGP, Season-Sim) haben eigene Inline-Engines die nicht den zentralen dixon-coles.ts nutzen
- Kein E2E Testing — nur Unit-Tests für die Engine
- Anna's Analysen nutzt v2 ohne SoS-Ratings und Absences (diese kommen nur über MatchdayContext-Flow)
- Team-Resolver: Teams die in mehreren Ligen spielen (Auf-/Abstieg) haben den letzten Eintrag als Default-Liga
- **WICHTIG**: Vercel Hobby Plan — KEIN `Co-Authored-By` in Commits! Blockiert Deployment.
- Ligen ohne Understat-xG (PT, BE, TR, SP2, I2, F2, SC, GR, E2, E3) nutzen nur ensemble-v1 (Standard-Engine). Poisson-ML v1/v2 verweigern ohne xG-History.
- ~9 Teams (Aufsteiger/Neulinge) haben Default-Elo 1500 mangels historischer CSV-Daten
- Champions League / Europa League sind Placeholder (wechselnde Teams, keine konsistente Kalibrierung)

## Datenbank

```sql
-- Wichtigste Tabellen:
matchdays          -- Spieltag-JSON pro Liga (JSONB)
odds_snapshots     -- Quotenverlauf mit Timestamps
bets               -- Platzierte Wetten + P&L
profiles           -- Bankroll, Risikoprofil
live_odds          -- Auto-Import via GitHub Actions Cron
team_xg_history    -- 36.068 per-Match xG-Einträge (2017-2026)
                   -- 28.718 echte xG (Understat, 6 Ligen, 2017-2025)
                   -- 7.350 geschätzte xG (Shots-Modell, 12 Ligen, 2025/26)
                   -- Felder: team, opponent, league, venue, match_date, xg, xga, goals_for, goals_against, source
upcoming_fixtures  -- Auto-Spielplan aus The-Odds-API (piggybacked auf fetch-odds.mjs)
                   -- Felder: league, event_id, home_team, away_team, commence_time
```

**Standings**: Keine eigene Tabelle — wird client-side aus `team_xg_history` berechnet (`computeStandings()` in `supabase.ts`). Zeigt W/U/N/Tore/Punkte/Position an.

RLS aktiv: User sehen alles, ändern nur eigene Daten.

## Admin Workflow — Spieltag-Analyse Schritt für Schritt

### Übersicht

Ein neuer Spieltag durchläuft **6 Schritte**. Die Workflow-Seite `/workflow` hat Prompts und Scripts zum Copy-Paste.

```
1. Spielplan holen    → AI: Paarungen, Anstoßzeiten, Kontext
2. xG-Daten holen    → Understat Browser-Script (DETERMINISTISCH, kein AI)
3. Verletzungen       → 3 AIs parallel befragen + Cross-Check
4. JSON bauen         → Alle Daten im FODZE-Format zusammenführen
5. In DB seeden       → JSON per Script/App nach Supabase
6. Quoten eingeben    → Buchmacher-Quoten → Value Bets + Kelly
```

### Schritt 1: Spielplan holen (AUTOMATISCH)

**Was:** Paarungen + Anstoßzeiten werden automatisch aus The-Odds-API gezogen.

**Automatisch (empfohlen):**
```bash
# 1. fetch-odds.mjs speichert Fixtures automatisch mit (GitHub Actions Cron)
# 2. Matchday-Skelett generieren:
node scripts/generate-matchday.mjs --league bundesliga
# → Erzeugt matchday-bundesliga-auto.json mit allen Paarungen + Anstoßzeiten
```

**Manuell (Fallback):** Prompt an Claude/Gemini/ChatGPT:
```
Gib mir alle Spiele der [LIGA] am [SPIELTAG] [DATUM].
Format: Heim vs Gast (HH:MM), Tabellenposition, Kontext.
Quellen: kicker.de, sofascore.com
```

**Tabelle:** Wird automatisch aus `team_xg_history` berechnet und in Anna's Analysen angezeigt (Position-Badges + klappbare Tabelle pro Liga).

**Oder:** `npm run spieltag` (interaktiver Wizard)

### Schritt 2: xG-Daten holen (DETERMINISTISCH)

**KRITISCH: Kein AI! Nur Understat-Daten aus dem Browser.**

1. Öffne `https://understat.com/league/Bundesliga` (oder EPL/La_liga/Serie_A/Ligue_1)
2. F12 → Console → Script einfügen:

```javascript
// ═══ FODZE xG Fetcher v2 (with per-match history for EWMA) ═══
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
    xg_h_history: hL8.map(g => ({ xg: +parseFloat(g.xG).toFixed(2), xga: +parseFloat(g.xGA).toFixed(2), date: g.datetime?.split(' ')[0] || '' })),
    xg_a_history: aL8.map(g => ({ xg: +parseFloat(g.xG).toFixed(2), xga: +parseFloat(g.xGA).toFixed(2), date: g.datetime?.split(' ')[0] || '' })),
  };
});
copy(JSON.stringify(result, null, 2));
console.log('✅ xG-Daten in Clipboard kopiert!');
```

3. Daten sind im Clipboard → in Schritt 4 einfügen

**Validierung:** `xg_h8 / 8 ≈ 0.8–2.5` pro Spiel. Wenn < 5.0 → wahrscheinlich Durchschnitt statt Summe!

**Für 2. Bundesliga / 3. Liga:** Kein Understat. Tore als Proxy: `xg_h8 = avg_goals * 8`.

**Alternativ automatisiert:**
```bash
npm run update-xg -- --league bundesliga --season 2025
```
Scraped Understat per HTTP, berechnet xG-Summen, upserted per-Match History nach Supabase.

### Schritt 3: Verletzungen & Kontext

**Sende denselben Prompt an 3 AIs parallel** (Claude + Gemini + ChatGPT):

```
Du bist ein Fußball-Datenanalyst. Recherchiere für diese Spiele:
[SPIELE HIER]

Pro Spiel:
1. VERLETZUNGEN & SPERREN (Name, Position, Grund)
2. FORM (letzte 5 Spiele: W/D/L)
3. SCHIEDSRICHTER (Name, Karten-Durchschnitt als Dezimalzahl!)
4. KONTEXT (Derby? Abstiegskampf? CL-Sandwich?)

Quellen: sofascore.com, transfermarkt.de, kicker.de
Antworte als JSON.
```

**Cross-Check — WICHTIG: Bei Widersprüchen den Admin fragen!**

Claude führt den Cross-Check durch und kategorisiert:
- ✅ 3/3 AIs nennen es → **sicher** — direkt übernehmen
- ⚠️ 2/3 → **wahrscheinlich** — übernehmen, aber im JSON als unsicher markieren
- ❌ 1/3 → **fraglich** — weglassen
- 🔴 **Widersprüche** → **ADMIN FRAGEN!**

**Wann den Admin fragen (nicht still entscheiden):**
- Tabellenpositionen weichen >3 Plätze ab zwischen den Quellen
- Ein AI sagt "verletzt", ein anderes "fit" für denselben Spieler
- Form-Serien widersprechen sich komplett (z.B. "3 Siege" vs "3 Niederlagen")
- Trainerwechsel oder Sperren nur von 1 Quelle genannt, aber spielentscheidend
- Taktische Infos (Rotation, Sandwich) widersprechen sich
- Schiedsrichter-Zuordnung unterschiedlich

**Format der Rückfrage an den Admin:**
```
⚠️ Widerspruch bei [SPIEL]:
- Quelle A: [Info A]
- Quelle B: [Info B]
- Quelle C: [Info C]
→ Was stimmt? Oder weglassen?
```

Claude fasst ALLE Widersprüche gesammelt zusammen (nicht einzeln fragen), damit der Admin einmal entscheiden kann.

### Schritt 4: JSON zusammenbauen

Alle Daten ins FODZE-Format. Template:

```json
{
  "league": "Bundesliga",
  "matchday": "Spieltag 28",
  "date": "2026-04-04",
  "matches": [
    {
      "home": {
        "name": "VfB Stuttgart",
        "xg_h8": 14.2,
        "xga_h8": 8.5,
        "games": 8,
        "form": "W W D L W",
        "injuries": "Undav (Muskel), Millot (Gelb-Rot-Sperre)",
        "yellow_risk": "Karazor auf 4 Gelben"
      },
      "away": {
        "name": "SC Freiburg",
        "xg_a8": 10.8,
        "xga_a8": 12.1,
        "games": 8,
        "form": "L W W D W",
        "injuries": "",
        "yellow_risk": ""
      },
      "tags": [],
      "context": "Stuttgart braucht Punkte für CL-Platz",
      "referee": "Stegemann, Ø 4.2 Karten/Spiel",
      "kickoff": "2026-04-04 15:30"
    }
  ]
}
```

**Kickoff-Format:** `"YYYY-MM-DD HH:MM"` (mit Datum!) oder `"HH:MM"` (dann wird `date` vom Spieltag prepended).

**Häufige Fehler:**
- ❌ `xg_h8: 1.5` — Durchschnitt statt Summe
- ❌ `xg_h8: 0` — Fehlt komplett
- ❌ Schiedsrichter ohne Dezimal: `"Ø 4"` statt `"Ø 4.2"`
- ✅ `xg_h8: 14.2` → `14.2 / 8 = 1.78 pro Spiel` → plausibel

### Schritt 5: In Supabase seeden

**Option A — CLI (empfohlen):**
```bash
node scripts/seed-matchday.mjs --file spieltag.json --league bundesliga
```
Flags: `--dry` (nur validieren), `--label "Custom"`, `--date "YYYY-MM-DD"`

**Option B — In der App:**
1. Liga wählen → "Import (JSON)" → JSON pasten → "ANALYSIEREN" → "SPEICHERN"

**Was passiert:** JSON wird in Supabase `matchdays`-Tabelle geschrieben. Die App lädt automatisch den neuesten Spieltag pro Liga.

### Schritt 6: Quoten eingeben

1. App öffnen → Spieltag-Seite → Spiel aufklappen
2. Unter "DEINE QUOTEN": 1, X, 2, Ü2.5, U2.5, BTTS
3. Grün = Value Bet (Edge positiv), Kelly wird automatisch berechnet

**Edge-Grading:**
- **A**: Edge ≥ 8% (starker Value)
- **B**: Edge 5–8% (gut)
- **C**: Edge 3–5% (marginal)
- **D/F**: Edge < 3% (skip)

## Alle Admin-Scripts

| Script | Befehl | Was es tut |
|--------|--------|-----------|
| `spieltag.mjs` | `npm run spieltag` | Interaktiver 6-Schritt Wizard |
| `update-matchday.mjs` | `npm run update-xg` | Understat scrape → Supabase upsert |
| `backfill-xg.mjs` | `npm run backfill` | Historisches xG Backfill (Browser-Script) |
| `export-xg.mjs` | `npm run export-xg` | Supabase → lokale JSON-Backups |
| `fetch-results.mjs` | `npm run fetch-results` | Ergebnisse holen, Wetten abrechnen |
| `fetch-odds.mjs` | `node scripts/fetch-odds.mjs` | Live-Quoten + Fixtures von The-Odds-API |
| `generate-matchday.mjs` | `node scripts/generate-matchday.mjs --league bundesliga` | Fixtures → Matchday-JSON Skelett |
| `value-alerts.mjs` | `node scripts/value-alerts.mjs` | Telegram-Alerts bei Edge ≥ 5% |
| `seed-matchday.mjs` | `node scripts/seed-matchday.mjs` | JSON → Supabase einfügen |
| `matchday-predict.py` | `python3 tools/matchday-predict.py` | LightGBM Prediction (alle Features) |
| `matchday-enrich.py` | `python3 tools/matchday-enrich.py` | + Schiedsrichter + Wetter |
| `retrain_v2.py` | `python3 tools/retrain_v2.py` | LightGBM Modell neu trainieren |
| `train-shots-xg.py` | `python3 tools/train-shots-xg.py` | Shots→xG Regression trainieren (R²=0.57) |
| `backfill-shots-xg.mjs` | `node scripts/backfill-shots-xg.mjs --all` | CSV Schuss-Daten → per-Match xG nach Supabase |

## Python-Tools (Fortgeschritten)

### matchday-predict.py — Vollständige Prediction-Pipeline
```bash
source tools/venv/bin/activate
python3 tools/matchday-predict.py --analyse              # Nächster Spieltag
python3 tools/matchday-predict.py --all-leagues --json    # JSON Export
```
Scraped Understat live → Elo berechnen → 14-Feature-Vektor → LightGBM → Dixon-Coles Matrix → Wahrscheinlichkeiten.

### matchday-enrich.py — Anreicherung
```bash
python3 tools/matchday-enrich.py --all-leagues
```
Fügt Schiedsrichter (Transfermarkt) + Wetter (Open-Meteo) hinzu.

### retrain_v2.py — Modell-Training
```bash
source tools/venv/bin/activate
DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v2.py --use-full-csv --n-trials 50
```
Output: `public/lgbm-model-v2.json` (~300 KB). Monatlich oder nach Saisonwechsel.

### Backfill-Methode (historische xG)
Understat blockiert automatisiertes Scraping (SPA). Stattdessen:
1. `npm run backfill` zeigt Browser-Console-Script pro Liga/Saison
2. Admin öffnet Understat → führt Script aus → JSON ins Terminal
3. Wird validiert und nach Supabase geseeded
4. Backup: `npm run export-xg`

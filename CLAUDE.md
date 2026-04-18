# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App für 19 Ligen. Drei Prediction Engines (Standard Ensemble, @annafrick13 v1 Poisson-ML, @annafrick13 v2 LightGBM Tweedie), Value-Bet-Detection mit Goldilocks-Guard (Edge 2.5–7.5%, dual-source Markt + Engine), Kelly-Staking mit K/M/A Risk-Profilen, automatisches Bet-Settlement + CLV-Tracking, live Injuries via Transfermarkt-Scrape + Groq HTML-Parser.

---

## Commands

### Development
```bash
npm install
npm run dev         # http://localhost:3000
npm run test        # 186 Tests (vitest)
npm run test:watch
npm run build       # Production Build (läuft auch in CI)
npm run lint        # Next lint (warnings nur, non-blocking)
```

### Daily Operations (neue Workflow-Commands)
```bash
npm run health              # 5s Statuscheck: Supabase + Odds-API + OpenLigaDB + TM + Groq
npm run audit               # Daten-Qualität per Liga (coverage-Report)
npm run refresh             # Update odds + matchdays ohne Injuries (~3 min)
npm run refresh:full        # Vollständig inkl. TM-Injuries (~25 min)
npm run refresh:quick       # Nur Odds + Audit (~30s)
npm run refresh:odds        # Nur fetch-odds.mjs
npm run suggest-aliases     # TM-Alias-Vorschläge für ungemappte Teams
```

### Single test file
```bash
npx vitest run tests/bet-metrics.test.ts
npx vitest run --reporter=verbose tests/format.test.ts
```

### TypeScript check
```bash
./node_modules/.bin/tsc --noEmit
```
Zero errors in `src/` expected. Two pre-existing errors in `tests/dixon-coles.test.ts` are known and untouched.

### Admin-Scripts (via node)

| Script | Zweck | Wann |
|---|---|---|
| `scripts/refresh-all.mjs` | Full-Pipeline Orchestrator (6 Phasen) | `npm run refresh[:full]` |
| `scripts/fetch-odds.mjs` | Live-Quoten + Fixtures von The-Odds-API (alle 19 Ligen) | Cron alle 4h (Fr-So + Mi) |
| `scripts/snapshot-closing-odds.mjs` | Closing-odds für pending bets innerhalb 2h vor Kickoff — füllt `bets.closing_odds` + `bets.clv`. Last-write-wins. | Im fetch-odds-Cron |
| `scripts/fetch-results.mjs` | Auto-Settlement + CLV-Recompute beim Settlement | Täglich 02:17 + 08:17 UTC |
| `scripts/backfill-liga3-openligadb.mjs` | Liga 3 xG via OpenLigaDB (ersetzt alten goals-proxy) | Täglich in settle-bets cron |
| `scripts/backfill-footystats.mjs` | Echte xG von FootyStats (Skeleton, no-op ohne API-Key) | Im settle-bets-Cron |
| `scripts/backfill-shots-xg.mjs` | CSV-Shots → per-Match xG (football-data.co.uk) | On demand |
| `scripts/backfill-enrich-matchdays.mjs` | Retroaktiv Form + Tags + Standings + H2H in bestehende Matchdays | Nach backfill-Runs |
| `scripts/generate-matchday.mjs --league X --seed [--injuries]` | Matchday bauen mit xG + Form + Tags + H2H + Standings + Injuries | Pro Liga, orchestriert via refresh-all |
| `scripts/seed-matchday.mjs` | JSON → Supabase `matchdays` | Manuell mit eigenem JSON |
| `scripts/build-tm-team-ids.mjs` | Transfermarkt-Liga-Seiten → 362 Team-IDs regenerieren | Season-Wechsel (Mai/Aug) |
| `scripts/suggest-tm-aliases.mjs` | missing-tm-aliases.log → ready-to-paste Alias-Vorschläge | Nach neuen Ligen / unmapped teams |
| `scripts/health-check.mjs` | 5s Statuscheck aller externen Quellen + Matchday-Freshness | `npm run health` |
| `scripts/audit-data-quality.mjs` | xG / Form / Tags / Injuries Coverage pro Liga | `npm run audit` |
| `scripts/seed-understat-2526.mjs` | Understat-Browser-JSON → Supabase xG-Historie | Manuell zu Saisonstart |
| `scripts/backfill-xg.mjs` | Interaktiver Browser-Script-Guide | Für neue Saisons |
| `scripts/spieltag.mjs` | Interaktiver 6-Schritt Spieltag-Wizard | Manueller Enrichment-Flow |
| `scripts/value-alerts.mjs --threshold 5` | Telegram-Alerts bei Edge ≥ 5% | Optional, im fetch-odds-Cron |
| `scripts/export-xg.mjs` | Supabase → lokale JSON-Backups | Vor Migrationen |

Alle Scripts nehmen `--dry` für Preview-ohne-Schreiben und `--league X` (wo applicable). `.env.local` wird auto-geladen.

### Shared Libraries in scripts/_lib/

| File | Zweck |
|---|---|
| `matchday-enrich.mjs` | `deriveForm`, `deriveTags`, `deriveStandingsTags`, `deriveH2H`, `computeStandingsFromXG`, `findStanding`, `loadOpenLigaDBSeason`, `inferMatchdayLabel`, Normalisierungshelfer |
| `transfermarkt-ids.mjs` | GENERIERTE 362-Team-ID-Map + 5-Tier fuzzy resolver |
| `transfermarkt-aliases.mjs` | 146 manual aliases (Odds-API name → TM name). DE↔EN↔Local Varianten |
| `transfermarkt-scrape.mjs` | fetchTeamInjuries mit rate-limit + Groq HTML→JSON normalisation + quota detection |

### Python Tools (nur für Model-Retraining)
```bash
source tools/venv/bin/activate
DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v2.py --use-full-csv --n-trials 50
python3 tools/matchday-predict.py --all-leagues --json
python3 tools/train-shots-xg.py
```

---

## Architektur-Big-Picture

```
Supabase (DB + Auth + RLS)
  ↕
Next.js 14 App Router (alle pages "use client")
  │
  ├── AppContext (global: user, league, profile, bankroll, engine)
  │      └── MatchdayContext (matches, odds, calcs) — hängt an AppContext
  │
  ├── Engines (hot path)
  │      ensemble-v1  ← src/lib/dixon-coles.ts + ensemble.ts + calibration.ts
  │      poisson-ml   ← src/lib/poisson-ml-engine.ts + poisson-regression.ts
  │      poisson-ml-v2 ← src/lib/poisson-ml-engine-v2.ts + lgbm-runtime.ts
  │      Alle 3 werden parallel in MatchdayContext.calcMatch berechnet und
  │      im 2-Layer-Memo gecacht. `engine` Toggle ist dann microseconds.
  │
  ├── Shared Libs (pure functions, gut getestet)
  │      bet-metrics.ts    ← betProfit, computeBetStats, computeCalibration, computeClvStats
  │      format.ts         ← fmtEuro, percent, matchKey, fmtDate*
  │      market-labels.ts  ← MarketKey type, canonicalMarket, marketLabel
  │      absence-parser.ts ← Verletzungs-Strings → PlayerProfile[] → calcAbsenceImpact
  │      elo-seeding.ts    ← Liga-Median-basierter Elo-Fallback (+league hint)
  │      goldilocks-engine.ts ← FODZE ensemble probs for dual-source Goldilocks
  │      bet-share-card.ts ← Canvas 2D PNG Renderer (1080×1350)
  │
  ├── API-Routes
  │      /api/anna         ← Groq/Claude Streaming SSE (auth + rate-limit + size guards)
  │      /api/matchday     ← AI-Enrichment via Claude web_search (optional)
  │      /api/seed-history ← Historischer xG-Seed (admin only)
  │
  ├── Cron (auto-refresh)
  │      GitHub Actions (wenn aktiviert):
  │        fetch-odds.yml (alle 4h): odds + closing-snapshot + value-alerts
  │        settle-bets.yml (täglich): fetch-results + liga3-openligadb + footystats
  │        ci.yml (push/PR): lint → typecheck → test → build
  │      Alternative: scripts/launchd/ (macOS LaunchAgents)
  │        com.fodze.refresh        — täglich 07:30, npm run refresh
  │        com.fodze.refresh.full   — Di + Fr 19:00, npm run refresh:full
  │
  └── Data Sources (alle via scripts/)
         Supabase            ← primary DB, Quoten, Bets, xG-Historie
         The-Odds-API        ← Live odds, fixtures (500 credits/month free)
         OpenLigaDB          ← Liga 3 goals, echte "30. Spieltag" labels (DE)
         Transfermarkt       ← Injuries + Sperren + Yellow-Risk (scraped, per-team)
         Groq Llama 3.1 8b   ← HTML-Table → JSON Normalisation (500K tokens/day free)
         Understat           ← echte xG für Top-5 Ligen (browser-script manually)
         football-data.co.uk ← CSV historical shots → shots-model xG
```

### Engine-Hierarchy im Main-Path (MatchdayContext.calcMatch)

1. Alle 3 Engines laufen immer parallel in `allEngineCalcs` (memo ohne `engine` in deps)
2. `processed` wählt primary basierend auf `engine` + hängt `allEnginesMk` an (cheap)
3. Fallback bei missing xG: engine returns null → primary = ensembleCalc
4. Fallback bei missing xG-Historie: MatchdayContext.loadCached füllt `xg_h8` aus `team_xg_history` Summen oder Liga-Avg (× 0.55 home / 0.45 away)
5. `leagueHint` wird an `eloPrediction` + `ensemblePrediction` durchgeschleust, damit promoted/relegated Teams den richtigen Liga-Tier-Seed kriegen

### Goldilocks Option A (dual-source edges)

`src/app/goldilocks/page.tsx` berechnet jetzt ZWEI Edge-Quellen pro Match:
- **Markt-Edge**: Pinnacle sharp vig-removed (original Verhalten)
- **Engine-Edge**: FODZE ensemble (`computeEngineProbs` in goldilocks-engine.ts)

Tags: `market` · `engine` · `consensus` (beide in Zone). Konsens-Filter zeigt nur Bets wo beide agree — robuster Edge-Indikator.

### Neue Seite hinzufügen
1. `src/app/neue-seite/page.tsx` mit `"use client"`
2. `<AppShell>` wrappen
3. Navbar-Tab in `src/components/layout/Navbar.tsx` (optional — floating help icon existiert für Hilfe-Seiten)

### Neue Engine-Berechnung hinzufügen
1. Funktion in `src/lib/dixon-coles.ts` exportieren
2. In `MatchdayContext.tsx` → `computeAllEngines` einbinden
3. In `MatchDetail.tsx` anzeigen (default View oder im collapsible `<details>`)
4. Test in `tests/dixon-coles.test.ts` schreiben

---

## Daten-Pipelines

### xG-Coverage

| Layer | Ligen | Status |
|---|---|---|
| Understat (echte xG, 2017–25) | 6 Top-Ligen | ~28.718 Einträge |
| Shots-Modell (CSV, R²=0.57) | 12 Nebenligen + Top-5 2025/26 | ~8.000 Einträge |
| OpenLigaDB goals-proxy | Liga 3 (2024/25 + 2025/26) | 1.418 Rows, idempotent upserts täglich |
| FootyStats (echte xG) | 3. Liga | Skeleton — aktiviert sich bei `FOOTYSTATS_API_KEY` |
| Liga-Avg Fallback | Teams ohne Historie | Runtime in MatchdayContext |

**Fallback-Chain in loadTeamXGHistory** (`src/lib/supabase.ts`): Exact Understat-Name → fuzzy (längstes distinctives Token) → (in loadCached) Liga-Avg × 0.55/0.45.

**xg_h8-Format (KRITISCH)**: SUMMEN über 8 Spiele, NICHT Durchschnitte. Faustregel: `xg_h8 / 8 ≈ 0.8–2.5` pro Spiel. Wert < 5.0 → wahrscheinlich Fehler.

### Enrichment-Pipeline (generate-matchday.mjs)

Pro Match werden diese Felder automatisch befüllt:

```js
{
  home: {
    name, xg_h8, xga_h8, games,
    form: "W W D L W",                // last-5 from team_xg_history
    standings_pos, standings_points,   // current season only, filtered to active teams
    xg_h_history: [...8 entries],      // from Understat/shots-model/goals-proxy
    injuries: "Player (POS, Reason, bis DATE), ...",   // Transfermarkt + Groq
    yellow_risk: "Player (POS, Sperre droht), ...",    // Transfermarkt "Sperre droht"
  },
  away: { /* same shape */ },
  tags: ["DERBY", "MEISTERKAMPF"],     // Rivalry map + standings + fixture density
  h2h: [{ date, venue, gf, ga, result }],  // last 5 direct meetings
  kickoff,
  _openliga_match_id: 77518,           // DE leagues only, for future joins
  _enrichment: { ...coverage counters },
}
```

Matchday-root label: echtes `"30. Spieltag"` aus OpenLigaDB für DE-Ligen, sonst `"Spieltag (auto)"`.

### Tag-System (applyTagCorrections)

TAG_MAP in `src/lib/dixon-coles.ts` definiert λ-Multiplier pro Tag:

| Tag | λH | λA | Auto-Quelle |
|-----|----|----|-----------| 
| DERBY | 1.05 | 1.05 | TEAM_RIVALRIES in matchday-enrich.mjs |
| ROTATION | 0.82 | 1.00 | Fixture-Dichte (≥3 Spiele/7 Tage) |
| MEISTERKAMPF | 1.03 | 1.03 | Beide Teams top-3 Standings |
| ABSTIEGSKAMPF | 1.06 | 1.06 | Beide Teams bottom-3 Standings |
| NEUER-TRAINER | 1.08 | 1.00 | Nur manuell (AI-enrichment via /api/matchday) |
| SANDWICH | 0.90 | 1.00 | Nur manuell (braucht European-cup Fixture-Kontext) |

Auto-Pipeline deckt 4 von 10 Tags ab. Die restlichen 6 kommen nur durch manuelles AI-Enrichment (z.B. via `/api/matchday` mit CLAUDE_API_KEY).

### Injuries-Pipeline (Transfermarkt + Groq)

1. Pro Liga Batch-Load `team_xg_history` + Standings + OpenLigaDB-Season
2. Pro unique Team: `scripts/_lib/transfermarkt-scrape.mjs::fetchTeamInjuries`
   - Rate-limited gentle fetch (1.5s/team)
   - `resolveTransfermarktRef` mit 5-tier fuzzy lookup (exact → alias → case-insensitive → normalized → substring)
   - Extract `<table class="items">` via balanced-table-walker (handles nested inline-tables)
   - Groq llama-3.1-8b-instant mit strict JSON output format → structured entries
   - Classify: SUSPENSION / INJURY → `injuries` string; YELLOW_RISK → `yellow_risk` string
3. Daily-quota detection: sticky module flag `_groqDailyQuotaExhausted` skippt folgende Calls sofort, kein 2min-Retry-Loop
4. Unresolvable Team-Names landen in `missing-tm-aliases.log` für späteren Review via `npm run suggest-aliases`

Format entspricht dem was `parseAbsences` in `absence-parser.ts` erwartet → `PlayerProfile[]` → `calcAbsenceImpact` → λ-Scaling.

### Team-Name-Resolution

Drei Namensräume für dasselbe Team:
- **FODZE** (App-intern): "FC Bayern München"
- **CSV** (football-data.co.uk, Elo): "Bayern Munich"
- **Understat** (team_xg_history): "Bayern Munich"
- **OddsAPI** (live_odds): "Bayern Munich"
- **Transfermarkt** (Injuries): "Bayern München" bzw. deutsche Versionen für alle Länder ("Olympiakos Piräus", "Standard Lüttich", "OGC Nizza", "Sporting Lissabon")

Mapping-Systeme:
- `src/lib/team-resolver.ts` → TEAM_REGISTRY (~330 Einträge, FODZE↔CSV↔Understat↔OddsAPI)
- `src/lib/scrapers/team-map.ts` → TEAM_SCRAPER_MAP (Understat-spezifische Aliase)
- `scripts/_lib/transfermarkt-ids.mjs` → GENERIERTE TM-Team-IDs (362 Teams, 19 Ligen)
- `scripts/_lib/transfermarkt-aliases.mjs` → 146 manual aliases (FODZE/OddsAPI → TM canonical)

`fuzzyTeamMatch(a, b)` in team-resolver.ts fängt Substring-Matches + geteilte Wörter > 3 Chars ab — wird von mehreren Call-Sites genutzt (MatchdayContext live-odds-matching, snapshot-closing-odds.mjs).

`resolveTransfermarktRef` in transfermarkt-ids.mjs hat 5 Tiers:
1. Exact TRANSFERMARKT_IDS
2. TRANSFERMARKT_ALIASES bridge
3. Case-insensitive exact
4. Normalized equality (NFD + umlaut-strip + prefix-strip)
5. Normalized substring (both directions, length-guarded ≥4 chars, longest wins)

### Absences → Engine-Input

`src/lib/absence-parser.ts` parst die `match.home.injuries` Free-Text-Strings (Format: `"Name (Pos, Reason, bis DATE), Name2 (Pos, Reason)"` — exakt das Format das Transfermarkt-Scrape produziert). Deutsche Positions-Hints werden gemapped (TW→GK, IV→DEF, MF→MID, ST→FWD). Ergebnis geht als `absences: { home, away }` in v1/v2 + calcMatchEnhanced → `calcAbsenceImpact` skaliert λH/λA um typisch ±5-15%.

### CLV-Tracking

`bets.closing_odds` + `bets.clv` Columns. Der `snapshot-closing-odds.mjs` Cron läuft alle 4h (last-write-wins, nicht first-write-wins) und snapshoted sharp-Quoten für pending bets innerhalb 2h vor Kickoff. `CLV = log(odds_placed / closing_odds) × 100`. `fetch-results.mjs` recomputed CLV beim Settlement als Defense-in-Depth. `computeClvStats` in `bet-metrics.ts` aggregiert (null statt 0 für fehlende Werte — kein False-Positive). `/performance` LiveCalibration zeigt live CLV-Chart.

---

## Konventionen

### Styling
- Inline Styles mit Token-Referenzen (`color.gold`, `fontSize.sm`, `space[5]`)
- Kein Tailwind, kein CSS-in-JS — alles über `src/styles/tokens.ts` + `components.ts`
- Farben: Leather (#1a0f0a) + Gold (#d4b86a) Theme
- Cards: `card()` Factory aus `components.ts`
- Buttons: `button("gold" | "outline" | "ghost")`
- Badges: `badge("value" | "warn" | "gold" | "neutral" | "info")`

### State
- **AppContext**: User, Liga, Profil, Bankroll, Engine-Auswahl — global
- **MatchdayContext**: Matchday-Daten, Odds, calcs — überlebt Navigation
- **Lokaler State**: UI-State (selectedMatch, showTips, tab)

### Commit / Deploy
- **Vercel Hobby Plan** blockiert Commits mit `Co-Authored-By` Trailer. NIEMALS dran hängen.
- Vercel auto-deployed bei push auf `main`.
- Service-Worker `public/sw.js` nutzt Network-First Strategy (Cache-Version bumpen bei jedem Deploy).

---

## Tests (186 total, 12 files)

```bash
npm run test              # alle Tests
npm run test:watch        # Watch-Mode
npx vitest run tests/bet-metrics.test.ts  # einzelne Datei
```

Coverage-Hotspots:
- `dixon-coles.test.ts` — λ-Berechnung, Vig-Removal, Kelly, Home-Factor
- `kelly.test.ts` — K/M/A Risk-Profile mit caps (2.5% / 4% / 6%)
- `bet-metrics.test.ts` — betProfit, computeBetStats, computeCalibration, computeClvStats (8 CLV cases)
- `format.test.ts` — fmtEuro, safeDate (garbage-Input-Schutz), percent, matchKey
- `market-labels.test.ts` — canonicalMarket (DE + EN + legacy Aliase)
- `absence-parser.test.ts` — Position-Hints, returning-Player-Skip, Klammern-Nesting
- `elo-seeding.test.ts` — Liga-Tier-Defaults, Promotion-Penalty, Cache
- `team-resolver.test.ts` — fuzzyTeamMatch (kritisch, 3 Call-Sites)
- `goldilocks-engine.test.ts` — computeEngineProbs, classifyEdgeSource (11 cases)
- `lgbm-runtime.test.ts` + `poisson-regression.test.ts` — Model-Runtime
- `schemas.test.ts` — Zod Matchday-JSON Validation

**NICHT getestet**: React-Contexts (MatchdayContext, AppContext), Components (MatchDetail, BetHistoryShare, etc.), API-Routes, Hooks, Pages, Scripts.

---

## Bekannte Einschränkungen

- **Kein E2E-Testing** — nur Unit-Tests (React Testing Library nicht installiert)
- **Standalone-Seiten** (`/simulator`, `/sgp`, `/season-sim`) haben Inline-Engines die nicht `dixon-coles.ts` nutzen
- **`fuck-betting/page.tsx` (~1500 LOC)** — eigene Engine-Selection-Logik, nicht über MatchdayContext
- **Champions/Europa League**: Placeholder (wechselnde Teams, keine konsistente Kalibrierung) — deshalb nicht in `refresh-all.mjs` LEAGUE-Liste
- **Lineup-aware Predictions**: Design-doc in `docs/LINEUP-INTEGRATION.md`, nicht implementiert (Sofascore blockt 403, freie Sources zu brittle)
- **Team-Resolver**: Teams mit Auf-/Abstieg haben den letzten Eintrag als Default-Liga — ok für xG, Elo wird über League-Hint aufgelöst
- **Groq Daily-Quota**: 500K Tokens/day (8b model) — ein `refresh:full` ≈ 350K. Zweimal am Tag bricht mittendrin ab (sticky flag verhindert endlose Retries)
- **Transfermarkt-Scrape**: Empfindlich gegen 5+ parallele Prozesse → Prozess-Kill + sequenzieller Re-run hilft
- **GitHub Actions Cron**: Kann inactive-Repo-Pause treffen. Workaround: `scripts/launchd/install.sh` für lokale macOS-Cron

---

## Supabase-Tabellen

```
matchdays          — Spieltag-JSON pro Liga (JSONB), label, date, created_by
                     data.matches[] hat seit 04/2026 zusätzlich:
                       standings_pos, standings_points, standings_gd,
                       injuries, yellow_risk, h2h, _openliga_match_id
                     data.matchday ist jetzt echt ("30. Spieltag") für DE-Ligen
odds_snapshots     — Quotenverlauf mit Timestamps (source: manual/live/import)
bets               — id, match_key, home_team, away_team, market, odds_placed, stake,
                     model_prob, edge, result, closing_odds, clv, placed_at, settled_at
profiles           — Bankroll, risk_profile (K/M/A), display_name, prediction_engine
live_odds          — Auto-Import (sharp_h/d/a, best_*, commence_time) — ersetzt bei jedem Fetch
team_xg_history    — Per-Match xG (team, opponent, league, venue, match_date, xg, xga,
                     goals_for, goals_against, source)
                     Sources: "understat" | "shots-model" | "goals-proxy" | "footystats"
                     UNIQUE constraint: (team, league, match_date, venue)
upcoming_fixtures  — Fixture-Spielplan (aus fetch-odds.mjs piggybacked)
```

Standings werden client-side aus `team_xg_history` berechnet (`computeStandings()` in `supabase.ts`) ODER pipeline-side in `matchday-enrich.mjs::computeStandingsFromXG`. RLS aktiv — User lesen alles, schreiben nur eigene Rows (`bets`, `profiles`). `migration-rls-tighten.sql` hat das 2024 gepatched.

---

## Prediction Engines — Details

### Standard (ensemble-v1)
4-Modell Blend aus `public/ensemble-model.json`: Dixon-Coles (6%) + Elo (22%) + Logistic (51%) + Market (20%). 1X2-Wahrscheinlichkeiten aus Ensemble, O25 aus Dixon-Coles Matrix. `eloPrediction` + `ensemblePrediction` nehmen jetzt optionalen `leagueHint` für korrekte Fallback-Seeds bei unbekannten Teams.

### @annafrick13 v1 (poisson-ml)
Poisson GLM (9 Features) → Dixon-Coles 15×15 Matrix → alle Märkte konsistent. Refuses to predict ohne per-Match xG-Historie (kein GIGO).

### @annafrick13 v2 (poisson-ml-v2)
LightGBM Tweedie, **21 Features** (npxG diff/momentum/volatility, Elo, home factor, rest days, SoS, h2h, PPDA, deep completions, setpiece/late-game/losing-state xG shares), Monotonic Constraints auf 10/14 physisch-eindeutige Features, Optuna-tuned ρ=-0.094, Dual-Track Calibration (display roh vs. Kelly isotonisch). Declared OOS Brier: **0.5844** auf 1.752 Matches.

Guardrails:
- Lambda Clamping [0.3, 4.5]
- Goldilocks Edge Guard 2.5–7.5% (< = Rauschen, > = fehlende Info)
- Dual-Track Divergenz-Warnung
- Feature-Dimension Guard
- Kein LLM-Daten Fallback (ohne History → null)

Retraining: `tools/retrain_v2.py` → `public/lgbm-model-v2.json` (~300 KB).

---

## Admin Workflow — Weekly Update

**Automatisch (empfohlen):**
```bash
bash scripts/launchd/install.sh   # macOS LaunchAgents einmal installieren
# Ab jetzt: täglich 07:30 npm run refresh, Di+Fr 19:00 npm run refresh:full
```

**Manuell:**
```bash
npm run health         # 5s — check all 5 sources
npm run refresh:full   # 25min — fetch-odds + settle-bets + liga3-backfill
                       # + generate-matchday × 19 (xG/form/tags/standings/h2h/injuries)
                       # + retro-enrich + audit
```

**Nach Auf-/Abstieg (Saisonwechsel):**
```bash
node scripts/build-tm-team-ids.mjs   # 40s — regeneriert 362 TM-IDs aus Liga-Seiten
npm run refresh:full
npm run suggest-aliases              # Falls missings in missing-tm-aliases.log
# → TM-Vorschläge pasten in transfermarkt-aliases.mjs
```

**Nach Spielende:** Auto via settle-bets.yml Cron (oder täglich 02:17/08:17 UTC via GitHub Actions, oder täglich 07:30 lokal via launchd).

---

## AI-Integration

Priority: `GROQ_API_KEY` (free) → `CLAUDE_API_KEY` (paid) → Offline (Templates)

- **Groq Llama 3.3 70B**: Ask Anna streaming SSE
- **Groq Llama 3.1 8b-instant**: Transfermarkt HTML→JSON normalisation (500K tokens/day free)
- **Claude Sonnet 4**: Ask Anna alternative (paid), `/api/matchday` AI-enrichment mit web_search
- **Offline**: `generateOfflineAnalysis()` in `anna/page.tsx` — rein aus berechneten Daten

---

## Zusätzliche Docs

- `docs/ARCHITECTURE.md` — tiefer Architektur-Überblick
- `docs/ENGINE.md` — Engine-Internals, Training, Backtest-Methodik
- `docs/HANDBUCH.md` — End-User Handbuch (auch als `/handbuch` In-App)
- `docs/LINEUP-INTEGRATION.md` — Design für Lineup-aware Predictions (nicht implementiert)
- `docs/DESIGN-HANDOFF.md` — Design-System-Spec

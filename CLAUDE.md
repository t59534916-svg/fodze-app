# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App für 21 Ligen. Drei Prediction Engines (Standard Ensemble, @annafrick13 v1 Poisson-ML, @annafrick13 v2 LightGBM Tweedie), Value-Bet-Detection mit Goldilocks-Guard (Edge 2.5–7.5%), Kelly-Staking, automatisches Bet-Settlement + CLV-Tracking.

---

## Commands

### Development
```bash
npm install
npm run dev       # http://localhost:3000
npm run test      # 156 Tests (vitest)
npm run test:watch
npm run build     # Production Build (läuft auch in CI)
npm run lint      # Next lint (warnings nur, non-blocking)
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
| `scripts/fetch-odds.mjs` | Live-Quoten + Fixtures von The-Odds-API | Cron alle 4h (Fr-So + Mi) |
| `scripts/snapshot-closing-odds.mjs` | Closing-odds für pending bets innerhalb 2h vor Kickoff — füllt `bets.closing_odds` + `bets.clv` | Im fetch-odds-Cron |
| `scripts/fetch-results.mjs` | Auto-Settlement für alle 18 Ligen | Täglich 02:17 + 08:17 UTC |
| `scripts/backfill-liga3-goals.mjs` | Goals-als-xG-Proxy für Liga 3 | Im settle-bets-Cron |
| `scripts/backfill-footystats.mjs` | Echte xG von FootyStats (Skeleton, no-op ohne API-Key) | Im settle-bets-Cron |
| `scripts/backfill-shots-xg.mjs` | CSV-Shots → per-Match xG (football-data.co.uk) | On demand |
| `scripts/seed-matchday.mjs` | JSON → Supabase `matchdays` | Neuer Spieltag |
| `scripts/generate-matchday.mjs --league X` | Fixtures → Matchday-Skelett | Vor Enrichment |
| `scripts/seed-understat-2526.mjs` | Understat-Browser-JSON → Supabase xG-Historie | Manuell |
| `scripts/update-matchday.mjs` | Live Understat-Scrape (nur Top-5-Ligen) | Blockiert — Understat SPA |
| `scripts/backfill-xg.mjs` | Interaktiver Browser-Script-Guide | Für neue Saisons |
| `scripts/spieltag.mjs` | Interaktiver 6-Schritt Spieltag-Wizard | Manueller Enrichment-Flow |
| `scripts/value-alerts.mjs --threshold 5` | Telegram-Alerts bei Edge ≥ 5% | Optional, im fetch-odds-Cron |
| `scripts/export-xg.mjs` | Supabase → lokale JSON-Backups | Vor Migrationen |

Alle Scripts nehmen `--dry` für Preview-ohne-Schreiben und `--league X` (wo applicable). `.env.local` wird auto-geladen.

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
  │      bet-metrics.ts    ← betProfit, computeBetStats, computeCalibration
  │      format.ts         ← fmtEuro, percent, matchKey, fmtDate*
  │      market-labels.ts  ← MarketKey type, canonicalMarket, marketLabel
  │      absence-parser.ts ← Verletzungs-Strings → PlayerProfile[]
  │      elo-seeding.ts    ← Liga-Median-basierter Elo-Fallback
  │      bet-share-card.ts ← Canvas 2D PNG Renderer (1080×1350)
  │
  ├── API-Routes
  │      /api/anna         ← Groq/Claude Streaming SSE
  │      /api/matchday     ← Matchday-Enrichment (nur Text, keine xG-Werte)
  │      /api/seed-history ← Historischer xG-Seed (admin only)
  │
  └── Cron via GitHub Actions
         fetch-odds.yml (alle 4h): odds + closing-odds-snapshot + value-alerts
         settle-bets.yml (täglich): bet settlement + liga3-goals + footystats
         ci.yml (push/PR): lint → typecheck → test → build
```

### Engine-Hierarchy im Main-Path (MatchdayContext.calcMatch)

1. Alle 3 Engines laufen immer parallel in `allEngineCalcs` (memo ohne `engine` in deps)
2. `processed` wählt primary basierend auf `engine` + hängt `allEnginesMk` an (cheap)
3. Fallback bei missing xG: engine returns null → primary = ensembleCalc
4. Fallback bei missing xG-Historie: MatchdayContext.loadCached füllt `xg_h8` aus `team_xg_history` Summen oder Liga-Avg (× 0.55 home / 0.45 away)

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

### xG-Coverage (Stand dieser Revision)

| Layer | Ligen | Status |
|---|---|---|
| Understat (echte xG, 2017–25) | 6 Top-Ligen | 28.718 Einträge |
| Shots-Modell (CSV, R²=0.57) | 12 Nebenligen + Top-5 2025/26 | ~8.000 Einträge |
| Goals-Proxy (The-Odds-API scores) | 3. Liga | Automatisch via Cron |
| FootyStats (echte xG) | 3. Liga | Skeleton — aktiviert sich bei `FOOTYSTATS_API_KEY` |
| Liga-Avg Fallback | Teams ohne Historie | Runtime in MatchdayContext |

**Fallback-Chain in loadTeamXGHistory** (`src/lib/supabase.ts`): Exact CSV-Name → fuzzy (längstes distinctives Token) → (in loadCached) Liga-Avg × 0.55/0.45.

**xg_h8-Format (KRITISCH)**: SUMMEN über 8 Spiele, NICHT Durchschnitte. Faustregel: `xg_h8 / 8 ≈ 0.8–2.5` pro Spiel. Wert < 5.0 → wahrscheinlich Fehler.

### Elo-System (src/lib/ensemble.ts + elo-seeding.ts)

- 655 Teams aus 146.382 historischen Matches (football-data.co.uk, 25 Saisons)
- Fallback für unbekannte Teams: `seedElo(league)` statt flat 1500
- Liga-Tier-Defaults: BL 1730, EPL 1800, Liga 3 1250, League Two 1200 (-50 Promotion-Penalty)
- Coverage bei aktuellen Matchdays: 84.9% real-Elo, 15.1% seeded

### Team-Name-Resolution

Drei Namensräume für dasselbe Team:
- **FODZE** (App-intern): "FC Bayern München"
- **CSV** (football-data.co.uk, Elo): "Bayern Munich"
- **Understat** (team_xg_history): "Bayern Munich"

Zwei Mapping-Systeme:
- `src/lib/team-resolver.ts` → TEAM_REGISTRY (~330 Einträge, FODZE↔CSV↔Understat↔OddsAPI)
- `src/lib/scrapers/team-map.ts` → TEAM_SCRAPER_MAP (Understat-spezifische Aliase)

`fuzzyTeamMatch(a, b)` in team-resolver.ts fängt Substring-Matches + geteilte Wörter > 3 Chars ab — wird von mehreren Call-Sites genutzt (MatchdayContext live-odds-matching, snapshot-closing-odds.mjs).

### Absences → Engine-Input

`src/lib/absence-parser.ts` parst die `match.home.injuries` Free-Text-Strings (Format: `"Name (Pos, Reason), Name2 (Pos, Reason)"`). Deutsche Positions-Hints werden gemapped (TW→GK, IV→DEF, MF→MID, ST→FWD). Ergebnis geht als `absences: { home, away }` in v1/v2 + calcMatchEnhanced → `calcAbsenceImpact` skaliert λH/λA.

### CLV-Tracking (neu)

`bets.closing_odds` + `bets.clv` Columns. Der `snapshot-closing-odds.mjs` Cron läuft alle 4h und snapshoted sharp-Quoten für pending bets innerhalb 2h vor Kickoff. `CLV = log(odds_placed / closing_odds) × 100`. Positive CLV über Zeit = einziger Indikator echter Edge.

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

## Tests (156 total, 10 files)

```bash
npm run test              # alle Tests
npm run test:watch        # Watch-Mode
npx vitest run tests/bet-metrics.test.ts  # einzelne Datei
```

Coverage-Hotspots:
- `dixon-coles.test.ts` — λ-Berechnung, Vig-Removal, Kelly, Home-Factor
- `bet-metrics.test.ts` — betProfit (inkl. NaN-Guard), computeBetStats, computeCalibration (Brier-Buckets)
- `format.test.ts` — fmtEuro, safeDate (garbage-Input-Schutz), percent, matchKey
- `market-labels.test.ts` — canonicalMarket (DE + EN + legacy Aliase)
- `absence-parser.test.ts` — Position-Hints, returning-Player-Skip, Klammern-Nesting
- `elo-seeding.test.ts` — Liga-Tier-Defaults, Promotion-Penalty, Cache
- `team-resolver.test.ts` — fuzzyTeamMatch (kritisch, 3 Call-Sites)
- `lgbm-runtime.test.ts` + `poisson-regression.test.ts` — Model-Runtime
- `schemas.test.ts` — Zod Matchday-JSON Validation

**NICHT getestet**: React-Contexts (MatchdayContext, AppContext), Components (MatchDetail, BetHistoryShare, etc.), API-Routes, Hooks, Pages, Scripts.

---

## Bekannte Einschränkungen

- **Kein E2E-Testing** — nur Unit-Tests (React Testing Library nicht installiert)
- **Standalone-Seiten** (`/simulator`, `/sgp`, `/season-sim`) haben Inline-Engines die nicht `dixon-coles.ts` nutzen
- **`fuck-betting/page.tsx` (~1500 LOC)** — eigene Engine-Selection-Logik, nicht über MatchdayContext
- **Champions/Europa League**: Placeholder (wechselnde Teams, keine konsistente Kalibrierung)
- **Lineup-aware Predictions**: Design-doc in `docs/LINEUP-INTEGRATION.md`, nicht implementiert (Sofascore blockt 403, freie Sources zu brittle)
- **Team-Resolver**: Teams mit Auf-/Abstieg haben den letzten Eintrag als Default-Liga — ok für xG, Elo wird über League-Hint aufgelöst

---

## Supabase-Tabellen

```
matchdays          — Spieltag-JSON pro Liga (JSONB), label, date, created_by
odds_snapshots     — Quotenverlauf mit Timestamps (source: manual/live/import)
bets               — id, match_key, home_team, away_team, market, odds_placed, stake,
                     model_prob, edge, result, closing_odds, clv, placed_at, settled_at
profiles           — Bankroll, risk_profile (K/M/A), display_name, prediction_engine
live_odds          — Auto-Import (sharp_h/d/a, best_*, commence_time) — ersetzt bei jedem Fetch
team_xg_history    — Per-Match xG (team, opponent, league, venue, match_date, xg, xga,
                     goals_for, goals_against, source)
                     Sources: "understat" | "shots-model" | "goals-proxy" | "footystats"
upcoming_fixtures  — Fixture-Spielplan (aus fetch-odds.mjs piggybacked)
```

Standings werden client-side aus `team_xg_history` berechnet (`computeStandings()` in `supabase.ts`). RLS aktiv — User lesen alles, schreiben nur eigene Rows.

---

## Prediction Engines — Details

### Standard (ensemble-v1)
4-Modell Blend aus `public/ensemble-model.json`: Dixon-Coles (6%) + Elo (22%) + Logistic (51%) + Market (20%). 1X2-Wahrscheinlichkeiten aus Ensemble, O25 aus Dixon-Coles Matrix.

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

## Admin Workflow — Neuer Spieltag

```
1. Fixtures holen     → node scripts/fetch-odds.mjs  (auto via Cron, oder manuell)
2. Matchday-Skelett   → node scripts/generate-matchday.mjs --league bundesliga
3. xG-Daten anfügen   → Understat Browser-Script ODER seed-understat-2526.mjs
4. Enrichment         → Verletzungen/Form/Kontext per AI recherchieren + ins JSON
5. Seed                → node scripts/seed-matchday.mjs --file X.json --league Y
6. Quoten              → In App unter /matchday eingeben → Goldilocks-Filter
```

Alternativ: `npm run spieltag` — interaktiver Wizard durch alle 6 Schritte.

Nach Spielende:
- **Auto-Settlement**: Cron ruft `fetch-results.mjs` täglich — pending bets werden settled, `bets.result` + `settled_at` befüllt
- **CLV**: `snapshot-closing-odds.mjs` hat vorher closing-Quoten snapshotted → `clv` fällt automatisch mit an

---

## AI-Integration

Priority: `GROQ_API_KEY` (free) → `CLAUDE_API_KEY` (paid) → Offline (Templates)

- **Groq**: Llama 3.3 70B, SSE, OpenAI-kompatibel → transformiert zu Anthropic-Format
- **Claude**: Sonnet 4, native SSE
- **Offline**: `generateOfflineAnalysis()` in `anna/page.tsx` — rein aus berechneten Daten

---

## Zusätzliche Docs

- `docs/ARCHITECTURE.md` — tiefer Architektur-Überblick
- `docs/ENGINE.md` — Engine-Internals, Training, Backtest-Methodik
- `docs/HANDBUCH.md` — End-User Handbuch (auch als `/handbuch` In-App)
- `docs/LINEUP-INTEGRATION.md` — Design für Lineup-aware Predictions (nicht implementiert)
- `docs/DESIGN-HANDOFF.md` — Design-System-Spec

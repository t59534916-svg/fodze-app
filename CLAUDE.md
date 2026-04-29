# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App für **22 Ligen** (+ 2 European cups). Vier Prediction-Engines: Standard Ensemble, @annafrick13 v1 (Poisson-ML), v2 (LightGBM Tweedie, production), v3 (Lean 20-Feature LightGBM Tweedie, preview-only — internally delegates to v2). **Phase 2.x Calibration Layer LIVE** (mit Korrektur 2026-04-26 Abend): isotonic curves + per-Liga Benter Market×Modell-Blend + Conformal Staking-Gate (warn-mode) + per-Liga Negative-Binomial Overdispersion. Dirichlet wurde aktiviert + nach n=8306 current-season backtest gleichen Tag wieder REVERTED (drift +0.0075 Brier vs raw — frozen 2023-24 cluster overfittet). Per-Liga Goldilocks 3-Tier (Sharp 1.5-5% / Moderate 2.5-7.5% / Soft 3.5-8.5%). Kelly-Staking mit K/M/A Risk-Profilen + Variance-Haircut + Per-Liga CLV-Feedback-Dampening, automatisches Bet-Settlement + CLV-Forward-Cache.

**Daten-Bestand (post 2026-04-27 cleanup)**: 86.007 team-match rows in `team_xg_history` (war 106k vor multi-source dedupe — 35k+ Aliase gemerged), ALLE 22 Ligen current season bei exakt-korrekter Team-Anzahl (drift=0). 24.686+ Closing-Odds rows in `odds_closing_history` (football-data.co.uk historical bis 2026-01-14 + live-odds-snapshot forward-cache going-forward). 2.548 match_outcomes (predictions×reality bridge), 1.509+ pipeline_shadow_log (4 engines), 27+ live_brier_snapshots. Drei UI-Enhancement-Layer: Team-Logos + Colors via TheSportsDB (~398 Teams, deduped 2026-04-27), MatchCard-Accent-Gradients, per-match referee + discipline features. **Live System-State auf `/health`** Dashboard.

**Team-Name Canonicalization (Architectural Invariant seit 2026-04-27, härter seit 2026-04-29)**:
Multi-source ingestion (FootyStats CSV / OpenLigaDB / shots-model / api-sports / Understat / TheSportsDB) hatte zuvor verschiedene Schreibweisen für dasselbe Team in dieselbe Liga geschrieben — "Bayern München" / "FC Bayern München" / "Bayern Munich" als 3 separate rows. UNIQUE-constraint griff nicht weil `team` string-different. Standings + EWMA + Engine-Predictions silent verzerrt. **Fix in 2 Lagen:**
1. **Ingest-Layer:** `scripts/_lib/canonical-team.mjs::canonicalize(team, league)` — **alle 14 active write-scripts** (5 Top-Tier backfills + 4 MEDIUM-RISK syncs + 3 metadata writers + 2 follow-up importers) mappen team-names zu canonical via TEAM_REGISTRY (354 entries) + EXTRA_ALIASES (22 lower-tier overrides). 2026-04-29 erweitert: `backfill-xg.mjs` (HIGH), `seed-understat-2526.mjs` (HIGH), `backfill-liga3-goals.mjs` (HIGH disabled-but-callable), `sync-xg-to-supabase.mjs`, `sync-npxg-to-supabase.mjs`, `fetch-fbref-stats.mjs`, `backfill-xg-by-state.mjs`, `sync-thesportsdb-metadata.mjs`, `fill-thesportsdb-missing.mjs`. 4 dormant scripts archived to `scripts/_archive/`.
2. **Read-Layer:** `src/lib/team-resolver.ts::canonicalizeTeamName(name, league)` (TS-mirror) wird in `MatchdayContext.loadCached` BEFORE `resolveXGBucket` aufgerufen — matchdays JSON darf inkonsistent sein, MatchdayContext löst über canonical auf. Fallback: `xg-history-resolver.ts` tier-2 substring.

**Known JS↔TS canonical inconsistency (2026-04-29):** `dedupe-team-names.mjs::buildAliasMap` baut alias-map nur aus TEAM_REGISTRY und ignoriert EXTRA_ALIASES. Bei Konflikt-Cases (z.B. bundesliga2 "DSC Arminia Bielefeld" via EXTRA_ALIASES vs "Arminia Bielefeld" via TEAM_REGISTRY) flaggt der dedupe-dry false-positives. DB-state ist konsistent mit `canonicalize()` (canonical-team.mjs), nicht mit `findCanonical()` (lokal in dedupe-team-names.mjs). Fix: `dedupe-team-names.mjs` muss `sharedCanonicalize` als single source of truth verwenden, ohne TEAM_REGISTRY-fallback. **Out-of-scope für 2026-04-29** — separate task, low-risk weil cron nicht auto-runned wird.

---

## Commands

### Development
```bash
npm install
npm run dev         # http://localhost:3000
npm run test        # 565 Tests (vitest)
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
| `scripts/backfill-shots-xg.mjs` | CSV-Shots → per-Match xG (football-data.co.uk), liga-spezifisch seit Per-Liga-Retraining | On demand |
| `scripts/fetch-api-sports-stats.mjs --league X --season 2024` | Echtes xG + Stats via api-sports für Saisons 2022–2024 (Free-Tier hat KEIN current season). Priorisiert Nebenligen. Idempotent via source='api-sports'. Budget-aware 100 calls/Tag. | Historical Backfill, Liga für Liga |
| `scripts/fetch-api-sports-injuries.mjs --all --days 3` | Current-season injuries via api-sports `?league=X&date=Y` (Free-Tier erlaubt date im Range [heute-2, heute+2]). Ersetzt Transfermarkt-Scrape + Groq für neue Injuries (~350K Groq-Tokens/Tag gespart). Schreibt in `player_injuries` mit stabiler player_id. | Daily cron |
| `scripts/sync-thesportsdb-metadata.mjs --all` | TheSportsDB Team-Metadata-Sync (logos, colors, stadium, IDs). 1 call/Liga. 10-Teams-Limit. | Season-Wechsel / initial |
| `scripts/fill-thesportsdb-missing.mjs --all` | Fill-Skript mit alias-retry für Teams jenseits des 10-Team-Limits (searchteams + Fallback-Queries). | Nach sync-thesportsdb / neue Teams |
| `scripts/backfill-missing-opponents.mjs [--league X]` | Paart existierende team_xg_history rows mit leerem opponent via (league, date, venue-flip) | Einmalig / nach backfill-xg-Runs |
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
| `api-sports.mjs` | api-sports v3 Client mit daily+per-minute Rate-Limit-Guards; League-ID-Map; parseFixtureStatistics Helper |
| `thesportsdb.mjs` | TheSportsDB v1 Client + Liga-ID/Name-Map (19 Ligen) + parseTeamRecord Helper (liefert `api_sports_id` als Cross-Source-Bridge) |

### Python Tools (nur für Model-Retraining)
```bash
source tools/venv/bin/activate
DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v2.py --use-full-csv --n-trials 50
DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v3.py --dry-run  # skeleton — needs ≥1500 api-sports rows
python3 tools/matchday-predict.py --all-leagues --json
python3 tools/train-shots-xg.py

# StatsBomb Open Data (Event-Level, für Training-Rohstoff)
python3 tools/statsbomb/download.py                  # alle 12 Priority-Comps (~1800 matches, ~600 MB)
python3 tools/statsbomb/download.py --only wc_2022   # einzelne Comp (64 matches, ~200 MB)
python3 tools/statsbomb/parse.py                     # events → aggregates.csv (34 Features pro team-match)
python3 tools/statsbomb/parse.py --only-competition "1. Bundesliga"
```

`tools/statsbomb/aggregates.csv` liefert für Model-Training Event-level aggregates:
shots (total/SoT/in-box/out-box/under-pressure/head/foot), xG (StatsBomb's kalibriertes Model), goals,
avg_shot_x/y, xg_per_shot, pct_shots_in_box, passes (total/completed/%), carries, pressures, fouls, offsides.
Use-Case: Richer shots-to-xG regression (>R²=0.57 Baseline) + validation-corpus für v3.

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
         football-data.co.uk ← CSV historical shots → shots-model xG (liga-spezifisch)
         api-sports v3       ← echtes xG + Stats für Nebenligen, Saisons 2022–2024 (free 100/Tag, KEIN current)
```

### Engine-Hierarchy im Main-Path (MatchdayContext.calcMatch)

1. Alle 4 Engines laufen parallel in `allEngineCalcs` (memo ohne `engine` in deps); v3 ist `preview: true` und returnt null bis `public/lgbm-model-v3.json` existiert
2. `processed` wählt primary basierend auf `engine` + hängt `allEnginesMk` an (cheap)
3. Fallback bei missing xG: engine returns null → primary = ensembleCalc
4. Fallback bei missing xG-Historie: MatchdayContext.loadCached füllt `xg_h8` aus `team_xg_history` Summen oder Liga-Avg (× 0.55 home / 0.45 away)
5. `leagueHint` wird an `eloPrediction` + `ensemblePrediction` durchgeschleust, damit promoted/relegated Teams den richtigen Liga-Tier-Seed kriegen

### Goldilocks Option A (dual-source edges)

`src/app/goldilocks/page.tsx` berechnet ZWEI Edge-Quellen pro Match:
- **Markt-Edge**: Pinnacle sharp vig-removed (original Verhalten)
- **Engine-Edge**: FODZE ensemble (`computeEngineProbs` in goldilocks-engine.ts)

Tags: `market` · `engine` · `consensus` (beide in Zone). Konsens-Filter zeigt nur Bets wo beide agree — robuster Edge-Indikator.

**Per-Match Konsens auf MatchDetail** (seit `0e30c67` / `d7c395e`):
Dieselbe Konsens-Logik läuft auf jedem Value-Bet im `MatchDetail.tsx`. Lokale Helpers:
- `buildSharpProbs(odds)` — Pinnacle vig-removed via `vigAdjustBest([sharp_h, sharp_d, sharp_a])` → `{H,D,A}` oder `null`
- `isConsensus(bet, sharpProbs)` — mappt BetCalc-Label auf sharp-prob, prüft ob `marketEdge ∈ [0.025, 0.075]` zusätzlich zu `bet.isValue`
- `<ConsensusBadge>` — Click-toggle Popover mit Erklärung (statt `title=` damit Mobile auch was sieht). Goldener Hintergrund + `aria-expanded` + keyboard-fokussierbar.

Limit: `OddsSharpData` enthält aktuell nur H/D/A. Sharp-O25/U25 in `live_odds` vorhanden aber nicht im Type — Erweiterung wäre 1-zeilig in `MatchdayContext.tsx:208` + Type-Update.

### MatchDetail enrichment-surfacing (TabOverview Header-Strip)

Der `<details>`-Block "MEHR DETAILS" in MatchDetail enthielt bisher die Pipeline-enriched Felder (form, injuries, tags), die default kollabiert waren. Seit `be3eca1` werden die wichtigsten Signale in einem **Context-Strip** ÜBER der Probability-Bar gerendert:

- **Form-Dots** pro Team — `<FormDots form="W W D L W"/>` parst die letzten-5-Sequenz, rendert 5 farbcodierte Punkte (Grün/Grau/Rot) mit `title=` für Hover und `tabIndex` für Keyboard
- **Injury-Counter** — `countInjuries(str)` zählt `)` im Comma-separated TM-Format → "🩹 H:2  🩹 A:3" mit Tooltip = vollständige Liste
- **Tag-Pills** — nur die 4 ersten Tags, durch `tagLabel()` von UPPER-Case zu Pascal de-shouted ("Meisterkampf"). Engine TAG_MAP-Keys werden vorher übersetzt.

Strip rendert nur wenn `stripHasContent` (mindestens ein Signal vorhanden) — keine leere Box bei Skelett-Matchdays.

### Neue Seite hinzufügen
1. `src/app/neue-seite/page.tsx` mit `"use client"`
2. `<AppShell>` wrappen
3. Navbar-Tab in `src/components/layout/Navbar.tsx` (optional — floating help icon existiert für Hilfe-Seiten)

### Neue Engine-Berechnung hinzufügen
1. Funktion in `src/lib/dixon-coles.ts` exportieren
2. In `MatchdayContext.tsx` → `computeAllEngines` einbinden
3. In `MatchDetail.tsx` anzeigen (default View oder im collapsible `<details>`)
4. Test in `tests/dixon-coles.test.ts` schreiben

### Engine Health Dashboard (`/health`, 2026-04-26)

URL-only diagnostic page (kein Navbar-Tab). 4 Sections in `src/app/health/page.tsx`:

1. **CALIBRATION LAYER** — synchroner Read aus Module-Level State (`isDirichletLoaded()`, `isBenterActive()`, `isConformalLoaded()`, `isOverdispersionLoaded()`, `isV3ModelLoaded()`) + `process.env.NEXT_PUBLIC_*` env-vars. Zeigt pro Layer: Status-Pill, Detail, env-var-Wert, gemessenen Brier-Impact.
2. **SUPABASE TABLES** — 14 tracked tables mit row count + latest-row freshness + status pill. Nutzt `supabase.from(...).select("*", {head:true, count:"exact"})` für fast-counts ohne row-data-transfer.
3. **DATA SOURCE FRESHNESS** — per-source `MAX(match_date)` für team_xg_history + odds_closing_history. Zeigt Stale-Sources (z.B. football-data.co.uk PSCH seit 2026-01-14).
4. **BET PORTFOLIO** — total/settled/with-CLV/pending counts + Yellow-Warning bei null CLV-Coverage.

Wenn neue Loader/Calibration-Layer hinzukommen: in `layers` array von `health/page.tsx:96-120` einen LayerRow ergänzen mit (status, detail, envVar, brierImpact).

---

## Daten-Pipelines

### Team-Name Canonicalization (2026-04-27 architectural fix)

**Critical invariant:** every write to `team_xg_history` and `team_metadata` MUST canonicalize team-names per league before INSERT. Otherwise multi-source ingestion (footystats short / openligadb long / shots-model variant) creates aliases that fragment the data:
- "Bayern München" + "FC Bayern München" + "Bayern Munich" as 3 separate rows
- 41 Bundesliga "teams" instead of 18 → Standings + EWMA-xG-history + Engine-predictions silent verzerrt

**Two-layer architecture:**

1. **Ingest-Layer** (Node.js scripts):
   ```
   scripts/_lib/canonical-team.mjs::canonicalize(team, league)
   ```
   Single source of truth = `src/lib/team-resolver.ts::TEAM_REGISTRY` (354 entries) parsed at runtime + `EXTRA_ALIASES` (22 lower-tier overrides for BL2/Liga3/La Liga 2/Serie B/Greek SL/Primeira/Ligue 1+2/Jupiler Pro). Handles ue/ae/oe → u/a/o normalization for German-alt-spellings.

   **All 5 active backfill scripts patched (2026-04-27):**
   - `scripts/import-footystats-csv.mjs` — FootyStats CSV import (manual, weekly)
   - `scripts/backfill-liga3-openligadb.mjs` — OpenLigaDB BL1+BL2+Liga3 (daily cron)
   - `scripts/backfill-shots-xg.mjs` — football-data.co.uk shots-model
   - `scripts/backfill-footystats.mjs` — FootyStats API (daily cron Liga 3)
   - `scripts/fetch-api-sports-stats.mjs` — api-sports (defensive, Key 2 suspended)

   16 weitere scripts schreiben team_xg_history NICHT (read-only audits, exports, monitors) oder sind inaktiv (legacy odds-api proxy, manual Understat seed).

2. **Read-Layer** (TS in MatchdayContext):
   ```
   src/lib/team-resolver.ts::canonicalizeTeamName(name, league)
   ```
   TS-mirror of canonical-team.mjs (TEAM_REGISTRY + EXTRA_LEAGUE_ALIASES inline). Called in `MatchdayContext.loadCached` BEFORE `resolveXGBucket`. Handles inkonsistent matchdays JSONB (z.B. ligue_1 verwendet teils "Brest" teils "Stade Brest"). Tier-2 fuzzy fallback in `xg-history-resolver.ts` als safety net.

   **Sync rule:** EXTRA_ALIASES in scripts/_lib/canonical-team.mjs (JS) und EXTRA_LEAGUE_ALIASES in src/lib/team-resolver.ts (TS) MUSS in sync bleiben. Bei neuem Alias beide Files patchen.

**Cleanup history:**
- Initial dedupe (commit `6ce7162`): 35,180 rows merged in team_xg_history
- Second pass with EXTRA_ALIASES (commit `bcc2e08`): +1524 rows merged → ALL 22 leagues at exact correct count, drift=0
- team_metadata dedupe (commit `7457fdc`): 119 mutations (92 renames + 27 deletes)

**Maintenance:** `scripts/dedupe-team-names.mjs` und `scripts/dedupe-team-metadata.mjs` sind idempotent re-runnable. Bei neuen Aliasen die im Cron auftauchen: erst EXTRA_ALIASES erweitern, dann re-run.

### xG-Coverage

| Layer | Ligen | Status |
|---|---|---|
| Understat (echte xG, 2017–25) | 6 Top-Ligen | ~28.718 Einträge |
| Shots-Modell (CSV, per-Liga-Koeffizienten) | 12 Nebenligen + Top-5 2025/26 | ~8.000 Einträge · `source=shots-model-<liga>` oder `shots-model-pooled` |
| **api-sports v3** (echtes xG + Stats) | Current Season, alle 19 Ligen (soweit verfügbar) | `source=api-sports` · via `scripts/fetch-api-sports-stats.mjs` |
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

### CLV-Tracking + Forward-Cache (2026-04-26)

`bets.closing_odds` + `bets.clv` Columns. Der `snapshot-closing-odds.mjs` Cron läuft alle 4h (last-write-wins, nicht first-write-wins) und schreibt jetzt **doppelt**:

1. **Per-Bet (legacy):** snapshoted sharp-Quoten für pending bets innerhalb 2h vor Kickoff → `bets.closing_odds` + `bets.clv`
2. **Forward-Cache (neu):** persistiert ALLE in-window Match-Closes nach `odds_closing_history` mit `source='live-odds-snapshot'` (idempotent via match_key UNIQUE) — egal ob User-Bet existiert oder nicht. Bets, die retroaktiv platziert werden (nach Kickoff aber vor Settlement), können CLV-recovered werden via `fetch-results.mjs::lookupClosingFromHistory`.

`CLV = log(odds_placed / closing_odds) × 100`. `fetch-results.mjs` recomputed CLV beim Settlement als Defense-in-Depth. `computeClvStats` in `bet-metrics.ts` aggregiert (null statt 0 für fehlende Werte — kein False-Positive). `/performance` LiveCalibration zeigt live CLV-Chart.

**⚠ Upstream-Outage seit 2026-01-14:** football-data.co.uk hat aufgehört Pinnacle-Closing-Spalten (PSCH/PSCD/PSCA) für aktuelle Saisons zu publizieren. Die 24.681 historischen Rows bleiben als Backtest-Korpus, aber going forward ist `live-odds-snapshot` die alleinige Closing-Quelle. Die `backfill-football-data-co-uk.mjs` PostgREST upsert-Logik wurde 2026-04-26 mit `?on_conflict=match_key` repariert (Header `Prefer: resolution=merge-duplicates` ist ohne diesen Query-Param ein silent no-op).

---

## Konventionen

### Styling
- Inline Styles mit Token-Referenzen (`color.gold`, `fontSize.sm`, `space[5]`)
- Kein Tailwind, kein CSS-in-JS — alles über `src/styles/tokens.ts` + `components.ts`
- Farben: Leather (#1a0f0a) + Gold (#d4b86a) Theme
- Cards: `card()` Factory aus `components.ts`
- Buttons: `button("gold" | "outline" | "ghost")`
- Badges: `badge("value" | "warn" | "gold" | "neutral" | "info")`

**Value-Token-Familie (seit `d7c395e`):** Eine Base-Hue mit expliziten Alpha-Tints. Earlier `valueBg` nutzte einen ANDEREN Base-Hue (`#5a8c4a15` vs `#6aad55`) → driftete sichtbar. Jetzt:
- `color.value` (`#6aad55`) — kanonisches Grün
- `color.valueDark` (`#4a8c3a`) — Probability-Bar Gradient-Stop
- `color.valueMid` (`#5a9e45`) — Hover / stronger tint
- `color.valueBg` (`#6aad5510`) — Card-bg
- `color.valueGhost` (`#6aad5508`) — faintest fill
- `color.valueBorder` (`#6aad5530`) — 1px Borders auf value cards

Niemals neue grüne Hex-Werte inline einführen — Token nutzen oder hinzufügen.

### State
- **AppContext**: User, Liga, Profil, Bankroll, Engine-Auswahl — global
- **MatchdayContext**: Matchday-Daten, Odds, calcs — überlebt Navigation
- **Lokaler State**: UI-State (selectedMatch, showTips, tab)

### Commit / Deploy
- **Vercel Hobby Plan** blockiert Commits mit `Co-Authored-By` Trailer. NIEMALS dran hängen.
- Vercel auto-deployed bei push auf `main`.
- Service-Worker `public/sw.js` nutzt Network-First Strategy (Cache-Version bumpen bei jedem Deploy).

---

## Tests (565 total, 37 files)

```bash
npm run test              # alle Tests
npm run test:watch        # Watch-Mode
npx vitest run tests/bet-metrics.test.ts  # einzelne Datei
```

Coverage-Hotspots:
- `dixon-coles.test.ts` — λ-Berechnung, Vig-Removal, Kelly, Home-Factor, 24 Ligen-Count
- `kelly.test.ts` — K/M/A Risk-Profile mit caps (2.5% / 4% / 6%)
- `c-kelly.test.ts` — Variance-Haircut via Bootstrap-CI
- `bet-metrics.test.ts` — betProfit, computeBetStats, computeCalibration, computeClvStats (8 CLV cases)
- `backtest.test.ts` — Brier/Log-Loss (scoreMatch), aggregate, aggregateWithCI bootstrap (seed-reproducible)
- `shots-calibration.test.ts` — per-liga xG-per-shot mit MIN_SAMPLE + clamp [0.07, 0.15]
- `format.test.ts` — fmtEuro, safeDate (garbage-Input-Schutz), percent, matchKey
- `market-labels.test.ts` — canonicalMarket (DE + EN + legacy Aliase)
- `absence-parser.test.ts` — Position-Hints, returning-Player-Skip, Klammern-Nesting
- `elo-seeding.test.ts` — Liga-Tier-Defaults, Promotion-Penalty, Cache
- `team-resolver.test.ts` — fuzzyTeamMatch (kritisch, 3 Call-Sites)
- `goldilocks-engine.test.ts` — computeEngineProbs, classifyEdgeSource (11 cases)
- `league-liquidity.test.ts` — alle 22 Ligen Tier-Mapping + Default-Fallback
- `clv-feedback.test.ts` — Volumen-basierte CLV-Feedback Window-Logik
- `lgbm-runtime.test.ts` + `poisson-regression.test.ts` — Model-Runtime
- `dirichlet-calibration.test.ts` — Phase 2.1 ODIR 3-Cluster
- `conformal-gate.test.ts` — Phase 2.5 Set-Size + Coverage
- `footbayes-engine.test.ts` — Hierarchical Bayes Posteriors
- `setpiece-xg.test.ts` — Phase 2.4 Set-Piece vs Open-Play
- `game-state-xg.test.ts` — xG bei Lead/Trail/Level
- `european-fatigue.test.ts` — Sandwich-Match Detection
- `xg-history-resolver.test.ts` — Multi-Source Fallback-Chain
- `overdispersion-loader.test.ts` — Phase 2.5 fitted-α Loader (8 cases)
- `pipeline-integration.test.ts` — End-to-End Smoke
- `schemas.test.ts` — Zod Matchday-JSON Validation
- `anna-request-validation.test.ts` — Streaming SSE Input Guards

**NICHT getestet**: React-Contexts (MatchdayContext, AppContext), Components (MatchDetail, BetHistoryShare, etc.), API-Routes, Hooks, Pages, Scripts.

---

## Areas to Watch (Stand 2026-04-29)

| Area | Status | Notes |
|---|---|---|
| Engine math | ✅ clean | isotonic + Benter empirisch best (current-season Brier 0.6120 vs 0.6146 raw vs 0.6158 dirichlet) |
| `team_xg_history` canonicalization | ✅ clean | All 22 leagues drift=0; ingest-layer canonicalize-on-write across 14 active scripts |
| TS↔JS canonicalize alignment | ✅ clean | Regression tests in `tests/canonicalize-team-name.test.ts` (15 cases lock down EXTRA_LEAGUE_ALIASES sync) |
| `match_outcomes` schema | ✅ clean | UNIQUE (match_key, match_date) — supports double-round-robin (austria_bl etc.) |
| `team_metadata` cross-league sync | 🟢 best-effort | EPL closed (Tottenham + Leeds + West Ham gefüllt 2026-04-29). Cross-league gap reduziert von 111 → 54. Verbleibende 54 sind TheSportsDB-Coverage-Limits (Reserve-Teams + austria_bl/swiss_sl/greek_sl regional clubs nicht in TheSportsDB Free-Tier indexiert). |
| `fill-thesportsdb-missing.mjs` | ✅ clean | 2026-04-29 hardened: idLeague-deterministic match (Tier-1) + substring fallback (Tier-3) + canonicalize-on-write. Plus `collectTeamNames()` Bug-Fix: matchdays-column war `match_date` nicht `date`, team_xg_history brauchte current-season-filter + pagination (vorher: nur 5 EPL-Teams gefunden statt 20). |
| Conformal Gate drift | 🟡 audited (2026-04-29) | **Validated empirisch:** 13/18 ok, 2 drift, **3 catastrophic (epl/la_liga2/primeira_liga)**. EPL α=0.10 under-covers by 8.5pp. **Flip zu enforce-mode BLOCKED** bis Re-fit. Artifact: `tools/backtest/conformal-drift-report.json`. Tool: `tools/backtest/validate_conformal_drift.py`. Mode bleibt `warn` (zero production-risk). |
| Inactive scripts | ✅ tracked | 14 active write-scripts now patched with canonicalize() (5 originally + 9 added 2026-04-29). 4 truly dormant moved to `scripts/_archive/` with README. 1 deprecated in-place (`import-wfr-csvs.mjs` — npm script ref). |
| **JS↔TS dedupe-team-names alignment** | 🟡 known issue | `dedupe-team-names.mjs::buildAliasMap` baut alias-map nur aus TEAM_REGISTRY ohne EXTRA_ALIASES. Bei Konflikt-Cases (z.B. bundesliga2 "DSC Arminia Bielefeld" canonical per EXTRA vs "Arminia Bielefeld" per registry) flaggt false-positives. DB-state ist konsistent mit production canonicalize(). Fix: dedupe-team-names.mjs muss `sharedCanonicalize` als single source-of-truth verwenden, ohne TEAM_REGISTRY-fallback. **Out-of-scope** weil cron-only-callable. |

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
                     goals_for, goals_against, shots_for/against, corners_for/against, source)
                     Sources: "understat" | "shots-model-<liga>" | "shots-model-pooled" |
                              "goals-proxy" | "footystats" | "api-sports"
                     UNIQUE constraint: (team, league, match_date, venue)
upcoming_fixtures  — Fixture-Spielplan (aus fetch-odds.mjs piggybacked)
team_metadata      — TheSportsDB-sourced: logos, colors, stadium, founded_year,
                     PLUS cross-source IDs (thesportsdb_id, api_sports_id).
                     Unique: (fodze_league, team_name). Mehrere Aliase pro
                     thesportsdb_id sind erlaubt (z.B. "RB Leipzig" + "RasenBallsport Leipzig").
player_injuries    — api-sports-sourced current-season injuries.
                     ⚠ EMPTY (0 rows) — TM injuries werden direkt im matchday JSON
                     embedded statt normalisiert. Schema bleibt für künftigen
                     api-sports-Backfill (Key 2 ist suspendiert).
odds_closing_history — Pinnacle closing odds. ~25k rows. Mehrere sources:
                     "football-data.co.uk" — historisch + STALE seit 2026-01-14
                       (Source publiziert PSCH/PSCD/PSCA nicht mehr)
                     "live-odds-snapshot" — NEU 2026-04-26: snapshot-closing-odds.mjs
                       Cron persistiert hier zusätzlich für Forward-CLV-Recovery
                     UNIQUE (match_key). Cols: psch/pscd/psca/psc_over25/psc_under25/
                       pscahh/pscaha/ah_line/ft_result/ft_goals_h/ft_goals_a
pipeline_shadow_log — Per-Matchday Engine A/B/C/D predictions: ensemble + poisson-ml
                     + poisson-ml-v2 + poisson-ml-v3 + footbayes-hierarchical
                     (alle 4-5 engines geloggt seit a264419). Cols: match_key,
                     league, engine_variant, prob_h/d/a/o25, feature_version,
                     predicted_at. Nutzt monitor-live-brier.mjs für post-hoc
                     Brier-Vergleich gegen team_xg_history.goals_for/_against.
                     UNIQUE (match_key, engine_variant, predicted_date).
match_predictions  — Pre-match snapshot per engine (richer than shadow_log:
                     lambdas, sharp odds, BTTS). Migration applied 2026-04-26
                     (post_match_backtest_layer). UNIQUE (match_key, engine).
                     Captured on /matchday page-load via savePredictionsBulk.
match_outcomes     — Post-match reality (goals + xG + shots + corners + cards).
                     UNIQUE (match_key, match_date) — schema migrated 2026-04-27
                     (war match_key alone, brach für double-round-robin Ligen
                     wie austria_bl). 2548 rows last 90 days. Generated cols:
                     total_goals, over25, btts, outcome_1x2.
                     Populated via scripts/populate-match-outcomes.mjs (cron
                     daily) — joined team_xg_history home + away rows per match.
live_brier_snapshots — Time-series per-engine + per-league Brier from
                     monitor-live-brier.mjs (cron). UNIQUE (window_end_date,
                     engine, league). league='__overall' = aggregate row.
                     /health Section 5 zeigt latest snapshot.
referees           — ⚠ STUB DATA (354 rows). fouls_per_game alle NULL,
                     yellows_per_game nur 13 distinct values, home_yellow_bias
                     1 distinct value (alle "1"). NICHT als Feature verwerten.
stadiums           — Lat/Lng/capacity per Heim-Stadion (278 rows, 30% join coverage,
                     altitude_m 0% populiert). Marginal value, nicht als Feature gewired.
player_xg_history  — Per-Player xG-per-90/xa/npxg/key_passes (2500 rows, Top-5 only).
                     Wird für xGChain-Hydration in MatchdayContext.tsx bei TM-Injuries
                     genutzt (Phase 2.3 wired).
live_wp_snapshots  — ⚠ EMPTY (0 rows). Phase 3.3 dormant — braucht Betfair-API-Key.
corners_odds_history — ⚠ EMPTY (0 rows). Phase 3.1 dormant — braucht UI-Tab.
player_props_posteriors — ⚠ EMPTY (0 rows). Phase 3.2 dormant — braucht R-service.
```

Standings werden client-side aus `team_xg_history` berechnet (`computeStandings()` in `supabase.ts`) ODER pipeline-side in `matchday-enrich.mjs::computeStandingsFromXG`. RLS aktiv — User lesen alles, schreiben nur eigene Rows (`bets`, `profiles`). `migration-rls-tighten.sql` hat das 2024 gepatched.

**Live-State-View aller Tabellen:** `/health` Page zeigt rows + latest + status (ok/warn/stub/empty) für 14 tracked tables in einer Ansicht.

---

## Prediction Engines — Details

### Standard (ensemble-v1)
4-Modell Blend aus `public/ensemble-model.json`: Dixon-Coles (6%) + Elo (22%) + Logistic (51%) + Market (20%). 1X2-Wahrscheinlichkeiten aus Ensemble, O25 aus Dixon-Coles Matrix. `eloPrediction` + `ensemblePrediction` nehmen jetzt optionalen `leagueHint` für korrekte Fallback-Seeds bei unbekannten Teams.

### @annafrick13 v1 (poisson-ml)
Poisson GLM (9 Features) → Dixon-Coles 15×15 Matrix → alle Märkte konsistent. Refuses to predict ohne per-Match xG-Historie (kein GIGO).

### @annafrick13 v2 (poisson-ml-v2)
LightGBM Tweedie, **21 Features** (npxG diff/momentum/volatility, Elo, home factor, rest days, SoS, h2h, PPDA, deep completions, setpiece/late-game/losing-state xG shares), Monotonic Constraints auf 10/14 physisch-eindeutige Features, Optuna-tuned ρ=-0.094, Dual-Track Calibration (display roh vs. Kelly isotonisch).

**OOS Brier (n=6691, gemessen):**
- Raw v2: 0.6102 (BSS +0.062, ECE 0.0146)
- v2 + Dirichlet (PRODUCTION): **0.6083** (BSS +0.065, ECE **0.0049** = 3× besser)

Guardrails:
- Lambda Clamping [0.3, 4.5]
- Goldilocks Edge Guard per-Liga 3-Tier (Sharp/Moderate/Soft)
- Dual-Track Divergenz-Warnung
- Feature-Dimension Guard
- Kein LLM-Daten Fallback (ohne History → null)

Retraining: `tools/retrain_v2.py` → `public/lgbm-model-v2.json` (~742 KB).

### @annafrick13 v3 (poisson-ml-v3) — Lean 20-Feature Architecture
LightGBM Tweedie, **20 dense Features** (kein Dead Weight, alle mit Importance > 0):
- **Core xG (5):** xg_diff_ewma, xga_diff_ewma, xg_momentum, xg_volatility, total_xg
- **Elo + Context (5):** elo_diff, sos_strength, is_derby, h2h_xg_diff, rest_days_diff
- **League constants (2):** home_factor, league_avg
- **Physis (5):** shots_total/sot/accuracy/corners/possession diff_ewma
- **Discipline (3):** fouls/yellow/red cards diff_ewma

Optuna 50-trial tuning + 90-day recency-decay. Trainiert auf 76.611 FootyStats rows. Holdout n=6498 (chrono cutoff 2025-08-01).

**Brier 0.6318** (drift home +1.2% / away -1.8% — time-drift fully contained), beats prior 0.6536 by -0.022.

**Status: Preview-only.** Engine-Registry `preview: true`, routes intern zu v2 bis Schema-equivalent zu v2 erreicht. Gap zu v2_dirichlet (0.024) ist strukturell — v2 hat Understat-trained npxg/ppda/deep features die v3 wegen 0%-Coverage in current schema droppen musste. Hyperparameter-Tuning kann den Schema-Gap nicht überbrücken.

Retraining: `DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v3.py --n-trials 50 --weight-half-life-days 90` → `public/lgbm-model-v3.json` (~11.7 MB).

### Phase 2.x Calibration Layer (Stand 2026-04-27 nach Dirichlet-Revert)

| Layer | Status | Source-File | Effekt |
|---|---|---|---|
| **Calibration Method** | **isotonic** (war kurz "dirichlet" am 2026-04-26 morgen, REVERTED Abend) | `public/calibration_curves.json` (legacy) + `public/dirichlet-calibration.json` (dormant aber loaded) | isotonic = pre-Dirichlet stable baseline |
| **Benter Blend (Phase 1.3)** | **on** | `public/benter-weights.json` | Per-Liga β₁/β₂ aus n=5586 OOT — empirisch best in current-season backtest n=8306 (Brier 0.6120) |
| **Conformal Gate (Phase 2.5)** | **warn** (observation only, no Kelly-Skaling) — **DRIFT VERIFIED 2026-04-29 → flip-to-enforce BLOCKED** | `public/conformal-quantiles.json` (trained 2026-04-21 on 2023-24 OOT) | Empirische Coverage 13/18 ok, 2 drift (greek_sl, serie_b), **3 catastrophic (epl, la_liga2, primeira_liga)**. EPL α=0.10 under-covers by 8.5pp. Re-fit recommended before any enforce-mode flip. Audit: `tools/backtest/conformal-drift-report.json` |
| **Per-Liga Overdispersion (Phase 2.5)** | **on** | `public/overdispersion.json` | Fitted α-Werte tighter als DEFAULT (serie_a -52%, la_liga -31%) → bessere O25/U25 PMF-Tails |

**⚠ Dirichlet-Revert (2026-04-27, datengetrieben):**
- 2026-04-26 morgens: Dirichlet aktiviert basierend auf frozen-OOT-Numbers (n=6691, 2023-08 → 2024-06): Brier 0.6083 vs raw 0.6102
- 2026-04-26 abends: nach `tools/backtest/score_current_season.py` Run auf n=8306 current-season matches (2025-08 → 2026-04-26):
  ```
  v2_benter      Brier 0.6120  ← BEST in current season
  v2_raw         Brier 0.6146
  v2_dirichlet   Brier 0.6158  ← drift +0.0075 vs old OOT, NET NEGATIVE
  ```
- Per-Liga: Dirichlet hilft in 9/18 Ligen, schadet in 9/18. bundesliga2 drift +0.0181 (catastrophic).
- Reverted to isotonic. Memory note in `~/.claude/projects/.../memory/project_dirichlet_revert_2026-04-26.md`.
- Lehre: training-time OOT ≠ current-season reality. score_current_season.py is now standard-tool VOR jeder neuen Calibration-Layer-Aktivierung.

Aktiviert via Environment-Variables (in `.env.local` + Vercel production):
```bash
NEXT_PUBLIC_CALIBRATION_METHOD=isotonic     # was kurz "dirichlet" — reverted
NEXT_PUBLIC_BENTER_BLEND=on                 # bleibt — empirisch best
NEXT_PUBLIC_CONFORMAL_GATE=warn             # observation only
# overdispersion.json wird unconditional geladen, kein env-flag
```

Failure-safe: corrupte/fehlende JSONs throwen vom Loader → werden in `modelErrors` geflagged → Engine fällt auf `DEFAULT_OVERDISPERSION` / `isotonic` / `mode=off` zurück. Zero production-risk.

**Live System-State auf `/health`** Dashboard zeigt für jede Layer den Loaded-Status, env-Wert, und gemessenen Brier-Impact in Echtzeit.

### Backtest Tooling (für jede neue Calibration-Decision)

Vor jeder Aktivierung eines neuen Calibration-Layers MUSS der current-season Backtest laufen:

```bash
tools/venv/bin/python3 tools/backtest/score_current_season.py
# Output: tools/backtest/cross-engine-current-metrics.json
```

Joined `v2-oot-predictions.parquet` (8979 leakage-safe predictions, 2025-08 → 2026-05) mit `team_xg_history` results + `odds_closing_history` closing odds. Pro variant + per-Liga Brier/LogLoss. Pflicht-Check vor jedem env-flip.

### Live Brier Monitor (kontinuierlich)

`scripts/monitor-live-brier.mjs` (Cron-ready):
- Joined `pipeline_shadow_log` × `team_xg_history.goals_for/_against` für settled matches
- Per-engine + per-league Brier
- Persistierbar in `live_brier_snapshots` Tabelle (--persist flag)
- `/health` Section 5 rendert latest snapshot

Bei n ≥ 100 pro Engine (~3 Wochen) erste robuste Live-Engine-Vergleich möglich.

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

**Nach v2-Retrain (`retrain_v2.py`):** Die downstream Model-Artifacts (`public/dirichlet-calibration.json`, `public/conformal-quantiles.json`, `public/benter-weights.json`, `public/backtest-summary.json`) werden NICHT von `refresh:full` aktualisiert. Sie sind statische Fit-Outputs die den v2-OOT-Parquet konsumieren. Nach jedem v2-Retrain:

```bash
bash tools/backtest/refit-all.sh         # reihenfolge-kritisch:
                                          # Dirichlet → Conformal → v1-OOT → Summary
# --skip-benter wenn odds-close-oot.parquet fehlt
git diff public/*.json                    # Review
git commit -am 'chore(models): refit artifacts'
```

Skipping a step leaves downstream quantiles/calibrations scored on a DIFFERENT probability distribution than the runtime pipeline produces — exactly the bug fixed in `f9c6ce7` where conformal coverage under-covered by 5 pp after the Dirichlet default-flip. Der Orchestrator [`tools/backtest/refit-all.sh`](tools/backtest/refit-all.sh) erzwingt die richtige Reihenfolge.

---

## AI-Integration

Priority: `GROQ_API_KEY` (free) → `CLAUDE_API_KEY` (paid) → Offline (Templates)

- **Groq Llama 3.3 70B**: Ask Anna streaming SSE
- **Groq Llama 3.1 8b-instant**: Transfermarkt HTML→JSON normalisation (500K tokens/day free)
- **Claude Sonnet 4**: Ask Anna alternative (paid), `/api/matchday` AI-enrichment mit web_search
- **Offline**: `generateOfflineAnalysis()` in `anna/page.tsx` — rein aus berechneten Daten

---

## Zusätzliche Docs

- `docs/ALPHA-ATLAS-IMPLEMENTATION.md` — **Master-Runbook der 13 Research-Phasen** (Referee / Benter / Dirichlet / footBayes / Conformal / Corners / Player-Props / Live-WP). Enthält Bootstrap-Reihenfolge, per-Phase Ops-Anweisungen, Feature-Flags, File-Inventory und Known Gaps. **Einstiegspunkt für alle Post-Baseline-Features.**
- `docs/ARCHITECTURE.md` — tiefer Architektur-Überblick
- `docs/DEBUGGING.md` — Operationaler Runbook (Symptom → Diagnose → Fix)
- `docs/ENGINE.md` — Engine-Internals, Training, Backtest-Methodik
- `docs/HANDBUCH.md` — End-User Handbuch (auch als `/handbuch` In-App)
- `docs/LINEUP-INTEGRATION.md` — Design für Lineup-aware Predictions (nicht implementiert)
- `docs/DESIGN-HANDOFF.md` — Design-System-Spec
- `docs/BRAND-VOICE.md` — Brand-Voice Guide: 5 Attribute, Tone-Spektrum nach Kontext, Terminologie (Edge/Modell/Spieltag/Sharp), Before/After-Beispiele. Ankern für UI-Copy, Release-Notes, Anna-Prompts, Marketing-Assets.

## Alpha-Atlas Status (Post-Baseline-Features)

Die 13 Phasen aus dem Alpha-Atlas-Plan sind **code-complete** (`docs/ALPHA-ATLAS-IMPLEMENTATION.md`). Alle Runtime-Module sind wired aber **default-off** — pre-upgrade Output bleibt bit-identisch bis Feature-Flags geflippt werden. Outstanding Ops: 9 Migrations applyen, 6 Backfill-Scraper laufen lassen, 3 Python-Fits (Benter/Dirichlet/Conformal) trainieren, 2 R-Services deployen, UI-Tabs für Corners + Player-Props. **449 Tests passing, 0 neue TS-Errors.**

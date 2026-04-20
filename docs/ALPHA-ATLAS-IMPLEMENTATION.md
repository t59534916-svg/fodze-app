# FODZE Alpha-Atlas Implementation Runbook

**Scope:** 13 Phasen aus `~/.claude/plans/plane-die-komplette-implementierung-synthetic-torvalds.md` — alle code-complete. Dieses Dokument ist der operative Fahrplan: was wurde gebaut, was muss getan werden, in welcher Reihenfolge, und wie verifiziert man dass es läuft.

---

## Status-Dashboard

| Phase | Titel | Code | Migration | Scraper-Run | Python-Fit | UI |
|---|---|---|---|---|---|---|
| 1.1 | Referee-Features | ✅ | ⏳ | ⏳ | — | — |
| 1.2 | Game-State-adjusted xG | ✅ | ⏳ | ⏳ (overnight) | — | — |
| 1.3 | Benter-Logit-Blending | ✅ | — | — | ⏳ | ✅ (dormant, flag off) |
| 1.4 | European-Fatigue-Infrastruktur | ✅ | ⏳ | ⏳ | — | ✅ (dormant, UEFA-src fehlt) |
| 1.5 | football-data.co.uk PSCH | ✅ | ⏳ | ⏳ | — | — |
| 2.1 | Dirichlet-Calibration | ✅ | — | — | ⏳ | ✅ (dormant, flag off) |
| 2.2 | footBayes Hierarchical | ✅ | — | — | ⏳ (R-Service) | ✅ (engine-selector, dormant) |
| 2.3 | xG-weighted Absence | ✅ | ⏳ | ⏳ | — | ✅ (auto-hydrate, empty = identity) |
| 2.4 | Set-Piece vs Open-Play xG | ✅ | ⏳ | ⏳ (piggy-back auf 1.2) | — | — |
| 2.5 | Mondrian Conformal Gate | ✅ | — | — | ⏳ | ✅ (dormant, flag off) |
| 3.1 | Corners Compound-Poisson | ✅ | ⏳ | ⏳ (piggy-back auf shots-xg) | — | ⏳ (Goldilocks-tab) |
| 3.2 | Hierarchical Player-Props | ✅ | ⏳ | ⏳ | ⏳ (R-Service) | ⏳ (Props-tab) |
| 3.3 | Live-WP / Betfair Stream | ✅ | ⏳ | ⏳ (Betfair-Key) | — | ⏳ (/live page) |

**Legend:** ✅ fertig · ⏳ outstanding operation · — nicht anwendbar

**Tests:** 449 passing (186 baseline + 263 neu). Keine neuen TypeScript-Fehler eingebracht. Die zwei pre-existing Errors in `tests/dixon-coles.test.ts` bleiben unberührt (in CLAUDE.md dokumentiert).

---

## Critical Path — Bootstrap-Reihenfolge

Die Reihenfolge ist **nicht zufällig**. Jeder Schritt baut auf vorigen auf (Daten-Dependencies). Ausführung auf einer frischen Installation:

### Schritt 1 — Apply all migrations (5 Minuten, einmalig)

Alle Migrationsdateien sind idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). Anwenden im Supabase Dashboard → SQL Editor, in dieser Reihenfolge (Reihenfolge irrelevant, aber so gruppiert):

```
# Feature-Tabellen
scripts/migration-referees.sql
scripts/migration-stadiums.sql
scripts/migration-player-xg.sql
scripts/migration-odds-closing-history.sql

# team_xg_history Erweiterungen
scripts/migration-xg-by-state.sql
scripts/migration-setpiece-xg.sql
scripts/migration-corners.sql

# Phase-3 Markets
scripts/migration-player-props.sql
scripts/migration-live-match.sql
```

**Verifikation:** `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';` zeigt jetzt u.a. `referees`, `stadiums`, `player_xg_history`, `odds_closing_history`, `player_props_posteriors`, `player_props_odds_history`, `corners_odds_history`, `live_match_events`, `live_wp_snapshots`.

### Schritt 2 — Backfills (parallel, ~1-2h Wall-Time)

Diese können parallel laufen. Alle lesen öffentliche Quellen (football-data.co.uk, FBref, Wikidata, worldfootballR-data GitHub) — keine API-Keys nötig außer Supabase.

```bash
# Historische Pinnacle-Closing (~10 Saisons × 16 Ligen)
node scripts/backfill-football-data-co-uk.mjs --all --seasons 2021,2223,2324,2425,2526

# Liga-Shots → xG-model (nutzt existierendes Muster, JETZT auch corners)
node scripts/backfill-shots-xg.mjs --all

# Stadium-Koordinaten (SPARQL Wikidata — 1 req/sec, ca. 10 min)
node scripts/scrape-stadiums.mjs --all

# Referees pro Liga (FBref Schedule-Pages, ~6s/Liga × 19 = 2 min)
for lg in bundesliga bundesliga2 liga3 epl championship la_liga la_liga2 serie_a serie_b ligue_1 ligue_2 eredivisie jupiler_pro primeira_liga super_lig greek_sl scottish_prem; do
  node scripts/scrape-referees.mjs --league $lg
done

# Player-xG Season-Aggregate (worldfootballR pre-scraped repo)
node scripts/backfill-player-xg.mjs --all --season 2526

# Audit: welche CSV-Team-Namen ohne FODZE-Mapping
node scripts/audit-closing-odds-teams.mjs
```

### Schritt 3 — Understat Shot-Timeline Re-Scrape (overnight batch)

Phase 1.2 Game-State-xG und 2.4 Set-Piece-Share brauchen beide einen Re-Scrape der Understat-Match-Pages (das bestehende Understat-Dataset hat nur per-Match-Aggregate, keine Shot-Timeline). Der Scraper ist ein **single-pass** — er schreibt State + Situation Columns gleichzeitig.

```bash
# Input: JSON-Liste von Understat match-ids (aus League-Pages scrapebar)
# → Ein Match ≈ 2s; 28k Understat-Matches = ~15h batch
node scripts/backfill-xg-by-state.mjs --file match-ids-bundesliga.json --league bundesliga
```

**Match-ID-Liste beziehen:** Understat League-Page (`/league/{name}/{year}`) hat Match-Links in einer `datesData`-JSON-Variable. Extraktion via ein-Seite-Scraper (nicht hier implementiert — siehe "Known Gaps" §4.1).

### Schritt 4 — Python Training Fits (wenn OOT-Daten da sind)

Prereqs für alle drei: `tools/oot_predictions_{engine}.parquet` (eine Erweiterung von `tools/retrain_v2.py` — markiert in Plan §1.3.7, noch offen).

```bash
source tools/venv/bin/activate

# Benter per-Liga β-Gewichte
python3 tools/fit_benter_blend.py --engine v2

# Dirichlet per-Cluster Matrizen
python3 tools/calibrate_dirichlet.py --engine v2

# Mondrian Conformal Quantile
python3 tools/fit_conformal.py --engine v2 --alpha 0.10
```

Bei fehlenden Prereqs loggen alle drei Scripts eine Hint-Meldung und exiten mit Code 0 — sie brechen keine Cron-Pipeline.

### Schritt 5 — R-Services (Fly.io oder VPS)

Die zwei Bayesian-Jobs laufen nachts in einem separaten R-Container. Entweder via Docker-Deploy oder GitHub-Actions-Scheduled-Job.

```bash
# Einmalig: Docker-Image bauen (rocker/tidyverse:4.3 + cmdstanr + footBayes)
docker build -t fodze-bayes services/footbayes/

# Nachts via Cron / Fly.io Machine:
docker run --env-file .env fodze-bayes Rscript fit_daily.R
docker run --env-file .env fodze-bayes Rscript fit_player_props.R
```

Output-Files werden via Supabase-REST oder GitHub-PR zurück in `public/footbayes-posteriors.json` + `public/player-props-posteriors.json` committed. Details siehe `services/footbayes/README.md`.

### Schritt 6 — Feature-Flags flippen

Alle neuen Runtime-Module sind **default OFF**. Nach erfolgreichem Fit + Validation:

```env
# .env.local
NEXT_PUBLIC_BENTER_BLEND=shadow        # später "on"
NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet  # oder bleiben "platt"
NEXT_PUBLIC_CONFORMAL_GATE=warn        # später "dampen" oder "enforce"
```

### Schritt 7 — Betfair Stream (optional, Phase 3.3)

```bash
# Delayed App Key bei Betfair beantragen (1 Woche SLA)
# Session-Token per login-interactive endpoint
fly launch --dockerfile services/betfair-stream/Dockerfile
fly secrets set BETFAIR_APP_KEY=... BETFAIR_SESSION_TOKEN=... BETFAIR_MARKET_ID=...

# Poller auf Haupt-Host (Cron alle 60s)
*/1 * * * * node scripts/poll-live-wp.mjs --all
```

---

## Per-Phase Runbook

### Phase 1.1 — Referee-Features

**Gebaut:**
- Table `referees` + `referee_slug` + per-Liga/Season-Stats
- Helpers: `slugifyReferee`, `resolveRefereeName`, `loadRefereesForLeague`, `deriveRefereeFeatures`
- `predictYellowCards` erweitert um `homeBias` (Dohmen 2008)
- `refresh-all.mjs --referees` Flag + Phase 3.5 im Cron

**Files:**
- [migration-referees.sql](../scripts/migration-referees.sql) · [scrape-referees.mjs](../scripts/scrape-referees.mjs)
- [_lib/referee-aliases.mjs](../scripts/_lib/referee-aliases.mjs) · [_lib/matchday-enrich.mjs §9](../scripts/_lib/matchday-enrich.mjs)
- [dixon-coles.ts:predictYellowCards](../src/lib/dixon-coles.ts) · [tests/referee-features.test.ts](../tests/referee-features.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-referees.sql in Supabase anwenden
# 2. Initial-Scrape:
for lg in bundesliga bundesliga2 liga3 epl championship la_liga la_liga2 \
          serie_a serie_b ligue_1 ligue_2 eredivisie jupiler_pro primeira_liga \
          super_lig greek_sl scottish_prem; do
  node scripts/scrape-referees.mjs --league $lg
done
# 3. Cron aktivieren (im nächsten refresh:full):
npm run refresh:full -- --referees
```

**Verifikation:**
```sql
SELECT league, COUNT(*) FROM referees GROUP BY league ORDER BY 2 DESC;
```
Soll für jede unterstützte Liga ~15-25 Zeilen zeigen.

**Known Limitation:** Pre-Match-Referee-Assignment-Source fehlt — der Hook in generate-matchday ist da, wird aber erst aktiv wenn `f.referee_name` aus einer zusätzlichen Quelle (kicker.de / weltfussball) befüllt wird.

---

### Phase 1.2 — Game-State-adjusted xG

**Gebaut:**
- 9 neue Spalten auf `team_xg_history` (xg_while_level/leading/trailing + xga_* + minutes_*)
- Pure helpers: `inferGameState`, `computeMinutesPerState`, `aggregateXgByState`, `STATE_RATIO_PRIOR`
- Understat-Match-Page-Scraper mit shot-timeline parser
- Browser-side `fillStateXGWithPrior` für fallback

**Files:**
- [migration-xg-by-state.sql](../scripts/migration-xg-by-state.sql) · [_lib/game-state-xg.mjs](../scripts/_lib/game-state-xg.mjs)
- [backfill-xg-by-state.mjs](../scripts/backfill-xg-by-state.mjs) · [tests/game-state-xg.test.ts](../tests/game-state-xg.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration anwenden: scripts/migration-xg-by-state.sql
# 2. Match-ID-Liste pro Liga beschaffen (manuell oder via neuer scraper)
#    Beispiel: match-ids-bundesliga.json = [19493, 19494, ...]
# 3. Single-match Smoke:
node scripts/backfill-xg-by-state.mjs --match-id 19493 --league bundesliga --dry
# 4. Batch (overnight):
node scripts/backfill-xg-by-state.mjs --file match-ids-bundesliga.json --league bundesliga
# → ~2s/match; 28k matches = 15h CPU
```

**Verifikation:**
```sql
SELECT league, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE xg_while_level IS NOT NULL) AS with_state
FROM team_xg_history GROUP BY league;
```
After full backfill: 6 Understat-Ligen sollten ~100% state-coverage haben, andere Ligen 0%.

**Known Limitation:** Liga 3 / League One/Two / Greek SL haben keine Understat-Quelle → nutzen `STATE_RATIO_PRIOR` (58/19/23 level/leading/trailing) als Runtime-Fallback.

---

### Phase 1.3 — Benter-Logit-Blending

**Gebaut:**
- Neues Module `benter-blend.ts` mit 3 Gates (no_pinnacle / pinn_degenerate / outlier)
- Choke-Point-Refactor: Benter **vor** Calibration, Anchor auf **raw mk** (nicht blended)
- v1/v2/ensemble Engine-Path fix: alle propagieren jetzt `pinnacleOdds` + `league` + `engine`
- Python Grid-Search-Fit `tools/fit_benter_blend.py`

**Files:**
- [benter-blend.ts](../src/lib/benter-blend.ts) · [benter-weights.json placeholder](../public/benter-weights.json)
- [dixon-coles.ts choke-point](../src/lib/dixon-coles.ts) · [fit_benter_blend.py](../tools/fit_benter_blend.py)
- [tests/benter-blend.test.ts](../tests/benter-blend.test.ts) · [tests/pipeline-integration.test.ts](../tests/pipeline-integration.test.ts)

**Ops-Anweisungen:**
```bash
# 1. OOT-predictions extraction in retrain_v2.py (Plan-Item 1.3.7, OFFEN)
#    — muss vor Fit-Step passieren; erzeugt tools/oot_predictions_v2.parquet
#
# 2. Benter fitten:
source tools/venv/bin/activate
python3 tools/fit_benter_blend.py --engine v2

# 3. Check Output:
cat public/benter-weights.json | jq '.engines.v2.leagues'

# 4. Shadow-Mode aktivieren (bit-identisches Verhalten zu off, aber dual-compute
#    in Logs — nach Einbau des pipeline_shadow_log (Plan-Item Shared Infra)):
echo "NEXT_PUBLIC_BENTER_BLEND=shadow" >> .env.local

# 5. Nach 200+ Matches + Gate-Check (Plan §Rollout-Strategie):
echo "NEXT_PUBLIC_BENTER_BLEND=on" >> .env.local
```

**Verifikation:**
```bash
./node_modules/.bin/vitest run tests/benter-blend.test.ts tests/pipeline-integration.test.ts
```
16 + 5 = 21 Cases green. Die `v1-equivalence`-Tests bestätigen: Mode off ≡ Pre-Upgrade-Output bit-identisch.

**Known Limitation:** Kein OOT-export aus `retrain_v2.py` → ohne diese Erweiterung liefert `fit_benter_blend.py` die placeholder-Werte (β=1, β=0) → Blend läuft als no-op Pass-Through.

---

### Phase 1.4 — European-Fatigue-Infrastruktur

**Gebaut:**
- Neue Table `stadiums` mit Wikidata-Koordinaten
- Pure helpers: `haversineKm`, `totalTravelKm`
- `deriveTravelCongestion` (matches_last_14d, travel_km_last_7d, consecutive_away_count)
- `flagShortRestEuropean` — ready for UEFA-fixtures-Source
- `EURO-FATIGUE` tag in `TAG_MAP` (dormant)

**Files:**
- [migration-stadiums.sql](../scripts/migration-stadiums.sql) · [_lib/geo.mjs](../scripts/_lib/geo.mjs)
- [scrape-stadiums.mjs](../scripts/scrape-stadiums.mjs) · [tests/european-fatigue.test.ts](../tests/european-fatigue.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-stadiums.sql
# 2. Scrape Wikidata (einmalig pro Saison, 1.2s/team × ~400 teams = 8 min):
node scripts/scrape-stadiums.mjs --all --dry     # Preview
node scripts/scrape-stadiums.mjs --all           # Live

# 3. Verifikation:
```
```sql
SELECT COUNT(*), COUNT(lat) FROM stadiums;
```
Für 19 FODZE-Ligen ~350-380 teams.

**Known Limitation:** Der `EURO-FATIGUE`-Tag wird nie getriggert, bis eine UEFA-Fixtures-Source (UEFA.com scraper / API-Football CL/EL) `euroAwayHome/Away` auf true setzt. Der Hook in `generate-matchday.mjs:359` hat dafür einen explicit-marked Placeholder.

---

### Phase 1.5 — football-data.co.uk PSCH-Pipeline

**Gebaut:**
- Table `odds_closing_history` (PSCH/D/A, PSC>2.5/<2.5, PSCAHH/A, FT-Result)
- Parser-Helpers in `_lib/football-data-parse.mjs`
- Backfill-Script mit 13/16 Liga-Coverage (League One/Two/Liga 3 fehlen in Buchdahl)
- Audit-Helper für Team-Name-Check
- CLV-Fallback in `fetch-results.mjs` (`bets.closing_odds` ← Buchdahl wenn Live-Snapshot fehlte)

**Files:**
- [migration-odds-closing-history.sql](../scripts/migration-odds-closing-history.sql) · [_lib/football-data-parse.mjs](../scripts/_lib/football-data-parse.mjs)
- [backfill-football-data-co-uk.mjs](../scripts/backfill-football-data-co-uk.mjs) · [audit-closing-odds-teams.mjs](../scripts/audit-closing-odds-teams.mjs)
- [fetch-results.mjs:lookupClosingFromHistory](../scripts/fetch-results.mjs) · [tests/football-data-parse.test.ts](../tests/football-data-parse.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-odds-closing-history.sql
# 2. Historische Ingestion:
node scripts/backfill-football-data-co-uk.mjs --all --seasons 2021,2223,2324,2425,2526
# 3. Audit: welche CSV-Teams haben kein FODZE-Mapping?
node scripts/audit-closing-odds-teams.mjs
```

**Verifikation:**
```sql
SELECT league, COUNT(*) FROM odds_closing_history GROUP BY league;
```
~3400 Zeilen pro Liga × 5 Saisons × 16 Ligen = ~270k Zeilen total.

---

### Phase 2.1 — Dirichlet-Calibration

**Gebaut:**
- 3-Class ODIR-regularized calibration in `calibration.ts` (Dispatch in `calibrate1X2`)
- 3 Cluster: top5 / mid_european / lower, mit global-fallback
- Python ODIR-Fit `tools/calibrate_dirichlet.py` (scipy L-BFGS-B)
- H/A 0.95-Cap mit excess-redistribute (D-clamp skipped im Dirichlet-Pfad)
- Env-Flag `NEXT_PUBLIC_CALIBRATION_METHOD=platt|dirichlet|isotonic`

**Files:**
- [calibration.ts § Dirichlet](../src/lib/calibration.ts) · [dirichlet-calibration.json placeholder](../public/dirichlet-calibration.json)
- [calibrate_dirichlet.py](../tools/calibrate_dirichlet.py) · [tests/dirichlet-calibration.test.ts](../tests/dirichlet-calibration.test.ts)

**Ops-Anweisungen:**
```bash
# 1. OOT-predictions extraction (blocked by Phase 1.3 precursor)
# 2. Fit:
source tools/venv/bin/activate
python3 tools/calibrate_dirichlet.py --engine v2 --lam 0.01

# 3. Aktivieren:
echo "NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet" >> .env.local
```

**Verifikation:**
```bash
./node_modules/.bin/vitest run tests/dirichlet-calibration.test.ts
```
15 Cases. Default Mode bleibt Platt — Dirichlet tritt nur an, wenn Env-Flag flippt UND Daten geladen sind (sonst fallback auf Platt-Path).

---

### Phase 2.2 — footBayes Hierarchical Engine

**Gebaut:**
- Neue Engine #4 im EngineRegistry: `"footbayes-hierarchical"` + Selector-Eintrag "Bayes Hierarchical"
- TS-Runtime `footbayes-engine.ts` (log-linear additive form: intercept + home_advantage + attack - defense)
- MatchdayContext wrapping: buildMatrix + deriveAllMarkets via bayes-Lambdas, reuses enh CI bounds
- R-Service-Skelett: Dockerfile + plumber.R + fit_daily.R
- λ clamp [0.1, 5.0] wie bei v2

**Files:**
- [footbayes-engine.ts](../src/lib/footbayes-engine.ts) · [footbayes-posteriors.json placeholder](../public/footbayes-posteriors.json)
- [engine-registry.ts](../src/lib/engine-registry.ts) · [MatchdayContext bayesCalc branch](../src/contexts/MatchdayContext.tsx)
- [services/footbayes/](../services/footbayes/) · [tests/footbayes-engine.test.ts](../tests/footbayes-engine.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Docker image bauen (einmalig):
docker build -t fodze-bayes services/footbayes/

# 2. Nightly fit (via Fly.io Machine oder GH Actions scheduled):
docker run --env-file .env.prod fodze-bayes Rscript fit_daily.R
# → schreibt public/footbayes-posteriors.json

# 3. App-Rebuild oder (besser) Serve-Time-Refetch für die neuen Posteriors
```

**Verifikation:**
In UI: Engine-Dropdown zeigt "Bayes Hierarchical". Bei leeren posteriors → Engine returns null per Match → MatchdayContext fallbackt auf Ensemble.

**Known Limitation:** `extract_team_means` + `extract_league_effects` in fit_daily.R sind Placeholders — brauchen footBayes v2.1 API-Inspection beim echten Deployment.

---

### Phase 2.3 — xG-weighted Key-Player-Absence

**Gebaut:**
- Table `player_xg_history` — season-level xG_per_90 + minutes_played pro Spieler
- Scraper via `JaseZiv/worldfootballR_data` GitHub CSVs (pre-scraped FBref)
- Extension in `player-impact.ts`: `enrichPlayerFromXG`, `hydrateAbsencesWithXG`, `buildPlayerXgIndex`
- Replacement-Faktor: 40% für FWD/MID, 50% für GK/DEF (Szczepański-Anchor)
- MatchdayContext-Integration: playerXgIndex per useEffect, hydratisiert absences vor Engine-call

**Files:**
- [migration-player-xg.sql](../scripts/migration-player-xg.sql) · [backfill-player-xg.mjs](../scripts/backfill-player-xg.mjs)
- [player-impact.ts new functions](../src/lib/player-impact.ts) · [supabase.ts:loadPlayerXGForLeague](../src/lib/supabase.ts)
- [MatchdayContext hydration](../src/contexts/MatchdayContext.tsx) · [tests/player-xg-weighted.test.ts](../tests/player-xg-weighted.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-player-xg.sql
# 2. Backfill (current season):
node scripts/backfill-player-xg.mjs --all --season 2526
# → ~16 Ligen × 400-500 Spieler = ~8000 Zeilen

# 3. Kein Feature-Flag — bei empty Index = identity fallback.
#    UI picks up automatically via MatchdayContext useEffect.
```

**Verifikation:**
```sql
SELECT league, COUNT(*) FROM player_xg_history WHERE season = '2526' GROUP BY league;
```
Mind. 200 Zeilen pro Liga erwartet.

---

### Phase 2.4 — Set-Piece vs Open-Play xG-Share

**Gebaut:**
- 4 neue Spalten auf `team_xg_history` (xg_openplay/setpiece + xga_*)
- `classifySituation` + `aggregateXgBySituation` in game-state-xg.mjs
- `SITUATION_RATIO_PRIOR` (73/27) + `fillSituationShareWithPrior` für Fallback
- Piggy-back im Phase-1.2 Backfill-Scraper: ein Pass schreibt State + Situation
- Doc-Block in `retrain_v2.py` mit v2.2-Roadmap

**Files:**
- [migration-setpiece-xg.sql](../scripts/migration-setpiece-xg.sql)
- [_lib/game-state-xg.mjs situation section](../scripts/_lib/game-state-xg.mjs)
- [supabase.ts situation fields + fillSituationShareWithPrior](../src/lib/supabase.ts)
- [tests/setpiece-xg.test.ts](../tests/setpiece-xg.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-setpiece-xg.sql
# 2. SELBER Scrape wie Phase 1.2 — schreibt beide Spalten-Gruppen gleichzeitig:
node scripts/backfill-xg-by-state.mjs --file match-ids-bundesliga.json --league bundesliga
```

**Known Limitation:** v2-Engine konsumiert die neuen Felder **noch nicht** — wartet auf nächsten Retrain mit erweiterter FEATURE_NAMES (dokumentiert im Header von `retrain_v2.py`).

---

### Phase 2.5 — Mondrian Conformal Staking-Gate

**Gebaut:**
- Runtime-Modul `conformal-gate.ts` mit 4 Modes: off / warn / enforce / dampen
- Defensive recourse: bei zu tighter Quantile bleibt arg-max als Singleton
- Python Mondrian-Fit `fit_conformal.py` (MAPIE optional, in-house fallback)
- Choke-Point-Integration: `conformalKellyFactor` multipliziert in Kelly-Stake

**Files:**
- [conformal-gate.ts](../src/lib/conformal-gate.ts) · [conformal-quantiles.json placeholder](../public/conformal-quantiles.json)
- [fit_conformal.py](../tools/fit_conformal.py) · [dixon-coles.ts Kelly integration](../src/lib/dixon-coles.ts)
- [tests/conformal-gate.test.ts](../tests/conformal-gate.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Fit (prereqs = OOT predictions):
source tools/venv/bin/activate
python3 tools/fit_conformal.py --engine v2 --alpha 0.10

# 2. Shadow aktivieren:
echo "NEXT_PUBLIC_CONFORMAL_GATE=warn" >> .env.local
# 3. Nach Validation dampen or enforce:
echo "NEXT_PUBLIC_CONFORMAL_GATE=dampen" >> .env.local
```

**Verifikation:**
- `warn` mode: runtime computation aber `conformalKellyFactor` returns 1.0 always
- `dampen`: Kelly wird um 0.6 (setSize=2) / 0.3 (setSize=3) gescaled
- `enforce`: 0.0 Kelly bei non-singleton (Bet komplett abgelehnt)

---

### Phase 3.1 — Corners Compound-Poisson

**Gebaut:**
- `team_xg_history.corners_for/against` + neue `corners_odds_history`-Tabelle
- Engine `corners-engine.ts` mit Compound Poisson (Geometric batches)
- 6 neue MarketKeys: `corners_o85/u85/o95/u95/o105/u105`
- HC/AC Ingestion in bestehendem `backfill-shots-xg.mjs`

**Files:**
- [migration-corners.sql](../scripts/migration-corners.sql) · [corners-engine.ts](../src/lib/corners-engine.ts)
- [market-labels.ts corner keys](../src/lib/market-labels.ts)
- [backfill-shots-xg.mjs HC/AC extension](../scripts/backfill-shots-xg.mjs)
- [tests/corners-engine.test.ts](../tests/corners-engine.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-corners.sql
# 2. Re-run shots-xg backfill (now writes corners_for/against):
node scripts/backfill-shots-xg.mjs --all

# 3. Engine funktioniert, aber UI-Tab fehlt (siehe Known Gaps §4.2)
```

---

### Phase 3.2 — Hierarchical Player-Props

**Gebaut:**
- Tables: `player_props_posteriors` + `player_props_odds_history`
- Engine `player-props-engine.ts` mit Anytime-Scorer / Shots-Over / Yellow-Card
- 6 neue MarketKeys: anytime_scorer / first_scorer / shots_o15/o25/o35 / player_yellow
- R-Service Extension `fit_player_props.R` (rstanarm hierarchical Poisson)

**Files:**
- [migration-player-props.sql](../scripts/migration-player-props.sql)
- [player-props-engine.ts](../src/lib/player-props-engine.ts) · [player-props-posteriors.json placeholder](../public/player-props-posteriors.json)
- [market-labels.ts player-props keys](../src/lib/market-labels.ts)
- [services/footbayes/fit_player_props.R](../services/footbayes/fit_player_props.R)
- [tests/player-props-engine.test.ts](../tests/player-props-engine.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-player-props.sql
# 2. Prereq: player_xg_history bereits populated (Phase 2.3)
# 3. Nightly R-fit:
docker run --env-file .env.prod fodze-bayes Rscript fit_player_props.R
```

---

### Phase 3.3 — Live-WP / Betfair Stream

**Gebaut:**
- Tables: `live_match_events` (event log) + `live_wp_snapshots` (time-series)
- Runtime `live-wp.ts` mit Remaining-Time Poisson (decay 0.84, state-mults, red-card impact)
- Betfair-Stream-Service-Skelett (Node.js WebSocket client)
- Poll-orchestrator `scripts/poll-live-wp.mjs` (pull-based alternative zur Edge-Function)

**Files:**
- [migration-live-match.sql](../scripts/migration-live-match.sql) · [live-wp.ts](../src/lib/live-wp.ts)
- [services/betfair-stream/](../services/betfair-stream/) · [poll-live-wp.mjs](../scripts/poll-live-wp.mjs)
- [tests/live-wp.test.ts](../tests/live-wp.test.ts)

**Ops-Anweisungen:**
```bash
# 1. Migration: scripts/migration-live-match.sql
# 2. Betfair Delayed App Key beantragen (1 Woche SLA)
# 3. Stream Consumer deployen:
fly launch --dockerfile services/betfair-stream/Dockerfile
fly secrets set BETFAIR_APP_KEY=... BETFAIR_SESSION_TOKEN=... BETFAIR_MARKET_ID=...

# 4. Poller via cron (60s):
*/1 * * * * node /path/to/poll-live-wp.mjs --all
```

---

## Feature-Flags — Zentral-Overview

Alle im `.env.local`:

```env
# Phase 1.3 — Benter Blending
# Values: off | shadow | on
# Default: off (bit-identisch zu pre-upgrade)
NEXT_PUBLIC_BENTER_BLEND=off

# Phase 2.1 — Calibration Method
# Values: platt | dirichlet | isotonic
# Default: platt (calibration_curves.json still controls exact params)
NEXT_PUBLIC_CALIBRATION_METHOD=platt

# Phase 2.5 — Conformal Staking Gate
# Values: off | warn | dampen | enforce
# Default: off
NEXT_PUBLIC_CONFORMAL_GATE=off
```

### Rollout-Empfehlung (für jede Feature unabhängig)

1. **off** — Data first: Migration + Backfill + Fit. Feature ist im Code wired aber inaktiv.
2. **shadow / warn** — Computation runs parallel, aber UI-Output unverändert. Vergleich gegen baseline in Logs/Metrics.
3. **dampen / on** — Effect wirkt: Benter-Blend aktiv, Conformal-Dampen reduziert Kelly, Dirichlet calibrates.
4. **enforce** — (nur Conformal) — non-singleton sets blockieren Bets.

---

## File-Inventory

### Migrations (11)
```
scripts/migration-referees.sql
scripts/migration-stadiums.sql
scripts/migration-player-xg.sql
scripts/migration-odds-closing-history.sql
scripts/migration-xg-by-state.sql
scripts/migration-setpiece-xg.sql
scripts/migration-corners.sql
scripts/migration-player-props.sql
scripts/migration-live-match.sql
```
(Plus die 2 pre-existing migrations aus pre-Phase-1 Zeit bleiben unberührt.)

### Scraper / Backfill Scripts (neu oder extended)
```
NEU:
  scripts/scrape-referees.mjs
  scripts/scrape-stadiums.mjs
  scripts/backfill-football-data-co-uk.mjs
  scripts/backfill-xg-by-state.mjs
  scripts/backfill-player-xg.mjs
  scripts/audit-closing-odds-teams.mjs
  scripts/poll-live-wp.mjs

EXTENDED:
  scripts/backfill-shots-xg.mjs        (added corners_for/against)
  scripts/generate-matchday.mjs        (referee hydrate + stadium + fatigue)
  scripts/refresh-all.mjs              (--referees flag + Phase 3.5)
  scripts/fetch-results.mjs            (CLV fallback via odds_closing_history)
```

### _lib/ Helpers (neu)
```
scripts/_lib/referee-aliases.mjs
scripts/_lib/football-data-parse.mjs
scripts/_lib/game-state-xg.mjs
scripts/_lib/geo.mjs

EXTENDED:
  scripts/_lib/matchday-enrich.mjs     (referee + stadium + travel sections)
```

### TS Runtime (neu)
```
src/lib/benter-blend.ts
src/lib/footbayes-engine.ts
src/lib/conformal-gate.ts
src/lib/corners-engine.ts
src/lib/player-props-engine.ts
src/lib/live-wp.ts

EXTENDED:
  src/lib/pinnacle-anchor.ts           (pinnacleImpliedProbs exported)
  src/lib/calibration.ts               (Dirichlet dispatch + module state)
  src/lib/dixon-coles.ts               (choke-point refactor, EURO-FATIGUE tag, predictYellowCards homeBias)
  src/lib/engine-registry.ts           (footbayes-hierarchical entry)
  src/lib/market-labels.ts             (6 corner + 6 player-prop keys)
  src/lib/player-impact.ts             (enrichPlayerFromXG + hydrateAbsencesWithXG + buildPlayerXgIndex)
  src/lib/supabase.ts                  (PlayerXgHistoryRow, loadPlayerXGForLeague, STATE/SITUATION priors)
  src/lib/poisson-ml-engine.ts         (pinnacleOdds + league + engine="v1" propagation)
  src/lib/poisson-ml-engine-v2.ts      (pinnacleOdds + league + engine="v2" propagation)
```

### Config / Data (placeholder, all dormant)
```
public/benter-weights.json
public/dirichlet-calibration.json
public/conformal-quantiles.json
public/footbayes-posteriors.json
public/player-props-posteriors.json
```

### Python Tools
```
tools/fit_benter_blend.py
tools/calibrate_dirichlet.py
tools/fit_conformal.py

EXTENDED (nur Doc-Block):
  tools/retrain_v2.py                  (v2.2-Roadmap header comment)
```

### R-Services (scaffolding only)
```
services/footbayes/README.md
services/footbayes/Dockerfile
services/footbayes/fit_daily.R
services/footbayes/fit_player_props.R
services/footbayes/plumber.R

services/betfair-stream/README.md
services/betfair-stream/Dockerfile
services/betfair-stream/index.mjs
```

### Tests (15 neue Files, 263 neue Cases)
```
tests/referee-features.test.ts       (23 cases — Phase 1.1)
tests/football-data-parse.test.ts    (26 cases — Phase 1.5)
tests/game-state-xg.test.ts          (19 cases — Phase 1.2)
tests/benter-blend.test.ts           (16 cases — Phase 1.3)
tests/pipeline-integration.test.ts   (5 cases — Phase 1.3)
tests/european-fatigue.test.ts       (17 cases — Phase 1.4)
tests/dirichlet-calibration.test.ts  (15 cases — Phase 2.1)
tests/footbayes-engine.test.ts       (11 cases — Phase 2.2)
tests/player-xg-weighted.test.ts     (16 cases — Phase 2.3)
tests/setpiece-xg.test.ts            (13 cases — Phase 2.4)
tests/conformal-gate.test.ts         (15 cases — Phase 2.5)
tests/corners-engine.test.ts         (21 cases — Phase 3.1)
tests/player-props-engine.test.ts    (19 cases — Phase 3.2)
tests/live-wp.test.ts                (20 cases — Phase 3.3)
```

---

## Known Gaps

### 4.1 Match-ID Discovery (Understat)

Für Phase 1.2 + 2.4 braucht `backfill-xg-by-state.mjs` eine JSON-Liste von Understat-Match-IDs. Ein League-Page-Scraper der diese Liste produziert fehlt — aktuell muss man die IDs aus der `datesData`-JSON-Variable manuell oder via one-off-script extrahieren.

**Workaround:**
```javascript
// Im Browser auf https://understat.com/league/Bundesliga/2025 DevTools console:
JSON.stringify(datesData.map(d => d.id))
// → als match-ids-bundesliga.json abspeichern
```

**TODO:** `scripts/scrape-understat-match-ids.mjs` — scraper gegen die League-Page.

### 4.2 UI-Integration für Phase 3.1 + 3.2

Engines sind gebaut, aber keine UI-Tabs — Goldilocks-Corner-Tab und Player-Props-Tab fehlen. MarketKeys sind bereits registriert, aber die Rendering-Layer (BettingSummary, Goldilocks page) muss ergänzt werden.

**TODO:**
- Corner-tab in `src/components/match/BettingSummary.tsx` oder neue `CornerMarketsTab.tsx`
- `src/app/player-props/page.tsx` oder Tab in MatchDetail
- Goldilocks-Filter erweitern um neue MarketKeys

### 4.3 UEFA-Fixtures-Source (Phase 1.4)

Der `EURO-FATIGUE` Tag bleibt dormant bis UEFA CL/EL/UECL Fixtures in einer Supabase-Tabelle landen. Optionen:
- API-Football Pro hat CL/EL endpoints ($19/mo)
- UEFA.com scraper (brittle aber free)
- worldfootballR pre-scraped europäische Comps

### 4.4 OOT-Predictions Export in retrain_v2.py

Prereq für alle drei Python-Fits (1.3 Benter, 2.1 Dirichlet, 2.5 Conformal). Der Export-Step in `retrain_v2.py` fehlt — ohne ihn produzieren die Fit-Scripts keine echten Gewichte sondern nur Placeholder.

**TODO:** `tools/retrain_v2.py` erweitern:
```python
# Am Ende von train/test split:
oot_predictions.to_parquet("tools/oot_predictions_v2.parquet")
# columns: match_id, league, match_date, model_prob_h/d/a, y_true_class
```

### 4.5 R-Service Production-Grade Accessors

`services/footbayes/fit_daily.R` und `fit_player_props.R` haben Placeholder-Accessor-Funktionen (`extract_team_means`, `extract_league_effects`, etc.). Bei erstem Real-Deployment braucht jeder Accessor einen Live-Test gegen footBayes v2.1 / rstanarm API.

### 4.6 Goldilocks-Engine für neue Engines

Die bestehende Goldilocks-Page nutzt Pinnacle sharp + FODZE ensemble probs (`computeEngineProbs` in `goldilocks-engine.ts`). Dort könnte man v2 oder footbayes als zweite engine-source einbauen — kommt mit Phase-2.2 Shadow-Rollout.

### 4.7 Pipeline Shadow-Log

Der `pipeline_shadow_log` Table aus dem ursprünglichen Plan (§Shared Infra) ist noch nicht gebaut. Ohne ihn läuft `NEXT_PUBLIC_BENTER_BLEND=shadow` effektiv wie `off` — die duale Berechnung findet statt, aber es wird nichts persistiert zum Vergleich.

**TODO (wenn Shadow-Rollout nötig):**
- Migration `scripts/migration-pipeline-shadow-log.sql`
- Dual-compute-Hook in `calculateBetsEnhanced`
- Admin-Dashboard-Page `src/app/admin/shadow-metrics/page.tsx`

---

## Verifikation / Commands

### Test-Suite komplett
```bash
npm run test                      # 449 pass, 0 fail (erwartet)
./node_modules/.bin/tsc --noEmit  # nur 2 pre-existing errors in tests/dixon-coles.test.ts
npm run build                     # Production build erfolgreich
```

### Health-Check nach Bootstrap
```bash
npm run health                    # Supabase + odds-api + openligadb + TM + Groq
npm run audit                     # xG / form / tags / injuries coverage per Liga
```

### Per-Phase Test-Run
```bash
# Phase 1.1
./node_modules/.bin/vitest run tests/referee-features.test.ts
# Phase 1.2
./node_modules/.bin/vitest run tests/game-state-xg.test.ts
# Phase 1.3
./node_modules/.bin/vitest run tests/benter-blend.test.ts tests/pipeline-integration.test.ts
# Phase 1.4
./node_modules/.bin/vitest run tests/european-fatigue.test.ts
# Phase 1.5
./node_modules/.bin/vitest run tests/football-data-parse.test.ts
# Phase 2.1
./node_modules/.bin/vitest run tests/dirichlet-calibration.test.ts
# Phase 2.2
./node_modules/.bin/vitest run tests/footbayes-engine.test.ts
# Phase 2.3
./node_modules/.bin/vitest run tests/player-xg-weighted.test.ts
# Phase 2.4
./node_modules/.bin/vitest run tests/setpiece-xg.test.ts
# Phase 2.5
./node_modules/.bin/vitest run tests/conformal-gate.test.ts
# Phase 3.1
./node_modules/.bin/vitest run tests/corners-engine.test.ts
# Phase 3.2
./node_modules/.bin/vitest run tests/player-props-engine.test.ts
# Phase 3.3
./node_modules/.bin/vitest run tests/live-wp.test.ts
```

### Coverage-Check per Liga nach Ingestion
```sql
-- Referees
SELECT league, COUNT(*) FROM referees GROUP BY league;

-- Stadiums
SELECT COUNT(*), COUNT(lat) FROM stadiums;

-- odds_closing_history
SELECT league, COUNT(*) FROM odds_closing_history GROUP BY league;

-- team_xg_history extension coverage
SELECT league,
       COUNT(*) AS total,
       COUNT(xg_while_level) AS with_state,
       COUNT(xg_openplay) AS with_situation,
       COUNT(corners_for) AS with_corners
FROM team_xg_history GROUP BY league ORDER BY 1;

-- player_xg_history
SELECT league, COUNT(*) FROM player_xg_history WHERE season = '2526' GROUP BY league;

-- Phase 3 Märkte
SELECT COUNT(*) FROM player_props_posteriors;
SELECT COUNT(*) FROM player_props_odds_history WHERE fetched_at > now() - interval '7 days';
SELECT COUNT(*) FROM corners_odds_history;
SELECT COUNT(*) FROM live_match_events WHERE created_at > now() - interval '24 hours';
SELECT COUNT(*) FROM live_wp_snapshots WHERE created_at > now() - interval '24 hours';
```

---

## Priorisierte Ops-Roadmap

Wenn man JETZT losgehen müsste, Reihenfolge nach maximalem Alpha/Aufwand-Verhältnis:

### Woche 1 — Deploy All Migrations + Cheap Backfills
1. Alle 9 Migrations im Dashboard applien (15 min)
2. `npm run health` → alle Env-Variablen bestätigen
3. Parallel in Terminal 1-3:
   - `node scripts/scrape-stadiums.mjs --all` (8 min, trivial)
   - `node scripts/scrape-referees.mjs --league bundesliga` … alle Ligen (5 min)
   - `node scripts/backfill-football-data-co-uk.mjs --all --seasons 2425,2526` (~20 min)
4. `node scripts/backfill-shots-xg.mjs --all` (~30 min, jetzt mit corners_for/against)
5. `node scripts/backfill-player-xg.mjs --all --season 2526` (~15 min)
6. Audit: `node scripts/audit-closing-odds-teams.mjs` — Team-Name-Reconciliation

**Nach Woche 1:** Alle Runtime-Features haben Daten. Ohne Python-Fits bleiben Benter + Dirichlet + Conformal dormant (default OFF) — kein Rollout-Risiko.

### Woche 2 — Understat Shot-Timeline Re-Scrape (overnight)
1. Match-ID-Listen für die 6 Understat-Ligen beschaffen (DevTools trick, bis scraper da ist)
2. Overnight batch: `backfill-xg-by-state.mjs --file ... --league ...` pro Liga parallel
3. Coverage-Check: `SELECT league, COUNT(xg_while_level) FROM team_xg_history ...`

### Woche 3 — OOT-Predictions + Python-Fits
1. `retrain_v2.py` erweitern um `.to_parquet` export
2. `python3 tools/fit_benter_blend.py --engine v2`
3. `python3 tools/calibrate_dirichlet.py --engine v2`
4. `python3 tools/fit_conformal.py --engine v2`
5. Validate outputs: echte Weights statt placeholders in public/*.json
6. Env-Flags auf `shadow` / `warn` flippen

### Woche 4+ — R-Services + UI
- footBayes R-fit auf Fly.io deployen (nightly cron)
- UI-Tabs für Corners + Player-Props in Goldilocks
- `/live` Page nach Betfair-Key-Eingang

---

## Troubleshooting

**"Test X fails after migration"** — Tests decken das Runtime-Verhalten der Helpers ab, nicht die DB-Tabellen. Migration-Fails sind via `SELECT` direkt in Dashboard zu verifizieren.

**"benter-blend.test.ts: pinn_not_normalised"** — fixture-Daten müssen 1.0 summieren. Der Check existiert aus Safety-Gründen (außersicht-PinnImplied-Sums sind ein Symptom von brokenen Devig-Outputs).

**"AppContext loader fail: /dirichlet-calibration.json 404"** — Nur wenn `NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet` UND Datei fehlt. Lösung: Entweder placeholder-Datei shippen (ist bereits da) oder env-var auf `platt` lassen.

**"Engine dropdown: Bayes Hierarchical liefert keine Output"** — Erwartetes Verhalten bei leeren posteriors. MatchdayContext fallbackt auf Ensemble. Fit-Job laufen lassen.

**"Conformal gate: setSize=3 für alles"** — Default-Quantile 0.5 macht alle Outcomes in-Set bei außergewöhnlich engen Model-Wahrscheinlichkeiten. Echte Fits produzieren deutlich präzisere quantiles.

---

## Referenzen

- [Original Verbesserungsplan](../../../.claude/plans/plane-die-komplette-implementierung-synthetic-torvalds.md)
- [CLAUDE.md](../CLAUDE.md) — Projekt-Grundlage und Konventionen
- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) — Architektur-Überblick
- [docs/ENGINE.md](./ENGINE.md) — Pre-Phase-1 Engine-Internals

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App für **22 Ligen** (+ 2 European cups). Vier Prediction-Engines: Standard Ensemble, @annafrick13 v1 (Poisson-ML), v2 (LightGBM Tweedie, production), v3 (Lean 20-Feature LightGBM Tweedie, preview-only — internally delegates to v2). **Phase 2.x Calibration Layer LIVE** (mit Korrektur 2026-04-26 Abend): isotonic curves + per-Liga Benter Market×Modell-Blend + Conformal Staking-Gate (warn-mode) + per-Liga Negative-Binomial Overdispersion. Dirichlet wurde aktiviert + nach n=8306 current-season backtest gleichen Tag wieder REVERTED (drift +0.0075 Brier vs raw — frozen 2023-24 cluster overfittet). Per-Liga Goldilocks 3-Tier (Sharp 1.5-5% / Moderate 2.5-7.5% / Soft 3.5-8.5%). Kelly-Staking mit K/M/A Risk-Profilen + Variance-Haircut + Per-Liga CLV-Feedback-Dampening, automatisches Bet-Settlement + CLV-Forward-Cache.

**Daten-Bestand (Stand 2026-05-27)**: 91.237 team-match rows in `team_xg_history` (mit 18 sofascore-extras feature-cols seit 2026-05-07 bridge), ALLE 22 Ligen current season bei exakt-korrekter Team-Anzahl (drift=0 seit canonicalize-cleanup + 25-row cross-source dedup 2026-05-22). 24.798 Closing-Odds rows in `odds_closing_history`. **Sofascore Universe komplett**: 6856 ended games × 22 Ligen × Saison 25/26 mit 100% v1+v2 extras coverage (39.666 match_statistics + 211.240 avg_positions + 139.793 incidents + 75.252 team_streaks + 13.703 managers + 13.228 pregame_form + 174.902 shotmap rows; player_match_stats lokal-only 279.832 rows in SQLite mirror). 3.090 match_outcomes (predictions×reality bridge), 4.193 pipeline_shadow_log (4-5 engines), 195 live_brier_snapshots. **FootyStats CSV-Importe (NEU 2026-05-25)**: 38.696 rows in `match_prematch_signals` (Pre-Match xG/PPG/BTTS%/O25%/35%/45% + attendance + stadium · 22 Ligen × 5 Saisons 21/22-25/26 · zweites Pre-Match xG-Signal neben Sofa+Understat) + 34.216 player-season rows in `player_season_stats` (Lower-Tier-Coverage für 16 Ligen × 5 Saisons · npxg/xa/defensive-stats/market-value · schließt Engine-Feature-Gap wo Understat nur Top-5 deckt). **Live System-State auf `/health`** Dashboard. **Vollständiges Datapoint-Inventar mit Engine-Mapping in `docs/DATAPOINTS-OVERVIEW.md`** (color-coded: 🟢 Standard / 🟣 v1 / 🔵 v2 / 🟦 v3 / 🟧 Calibration / 🟥 Backtest / 🟨 UI / ⚪ Metadata).

**Sofascore Shot-Event Pipeline (NEU 2026-04-29, alle 22 FODZE-Ligen klassifiziert seit 2026-05-05)**: ~170k per-shot events in `sofascore_shotmap` × ~6.7k matches in `sofascore_match` (17 von 22 Ligen × Saison 25/26 voll erfasst inkl. Playoff/Splitt-Runden). Datenquelle: [`datafc`](https://pypi.org/project/datafc/) (curl_cffi mit Chrome 124 TLS-Fingerprint, kein Browser nötig). Pro Shot: xG, xGOT, body_part, situation (assisted/corner/fast-break/penalty/...), shooter coords, outcome. Drei Views: `sofascore_team_chance_quality` (per-game chance-quality), `sofascore_team_rolling_8` (last-8-games per team — engine-input shape), `sofascore_standings` (live league table). `sofascore_data_quality_tier(league)` SQL-Funktion klassifiziert in `premium` (16 Ligen mit voll xG + assisted/fast-break tags: bundesliga, bundesliga2, championship, epl, eredivisie, greek_sl, la_liga, ligue_1, primeira_liga, serie_a, serie_b, austria_bl, swiss_sl, scottish_prem, jupiler_pro, super_lig) / `partial` (liga3 — voll xG aber ohne assisted/fast-break tags) / `volume` (5 Ligen ohne xG: eerste_divisie, la_liga2, league_one, league_two, ligue_2). Tier-Klassifikation aktualisiert via `scripts/migration-sofascore-tier-update.sql` (2026-05-03, 11 premium) und `scripts/migration-sofascore-tier-extend-2026-05-05.sql` (16 premium nach Cloudflare-unblock-retry für die 5 vorher fehlenden Tier-B Ligen). Sync läuft als Phase 4 in `refresh-all.mjs` via `scripts/sync-sofascore-shotmap.mjs`. **Bridge** `scripts/bridge-sofascore-to-team-xg.mjs` (NEU 2026-05-05) propagiert per-team-per-game xG/shots/goals aus `sofascore_team_chance_quality` (premium+partial Tier) idempotent in `team_xg_history` mit `source='sofascore'` — schließt damit die manuelle FootyStats-CSV-Lücke für Engine-Reads (xg_h8, form, standings).

**Sofascore Post-Match Extras Pipeline (v1+v2 100% Coverage seit 2026-05-10)**:
**v1** (4 endpoints): `sofascore_match_statistics` (39.666 rows, ~40 team stats × period=ALL/1ST/2ND), `sofascore_player_match_stats` (lokal-only 279.832 rows in SQLite — Supabase skipped via --skip-player-stats), `sofascore_incidents` (139.793 goal/card/sub timeline rows), `sofascore_average_positions` (211.240 tactical avg-pitch coords). Plus `sofascore_extras_state` sync-tracker (forever-cache nach status='Ended', exakt 6856 rows = 100% Coverage).
**v2 HIGH-SIGNAL** (3 endpoints): `sofascore_match_managers` (13.703 rows, manager_id stable für coaching-change detection — ersetzt manual NEUER-TRAINER tag in `/api/matchday`), `sofascore_pregame_form` (13.228 rows, Sofa's pre-match form summary: avgRating + position + last-5), `sofascore_team_streaks` (75.252 rows, ~11/game general + head2head). Migration `scripts/migration-sofascore-event-extras-v2.sql` + view `sofascore_team_manager_history`. **NEUER-TRAINER auto-detection** via `scripts/_lib/matchday-enrich.mjs::deriveCoachingChangeTag` (16 vitest cases). **18 Feature-Columns** auf `team_xg_history` befüllt via `scripts/bridge-sofascore-extras-to-team-xg.mjs` (big_chances/possession/tackles/cards/goals_prevented). Pipeline: `tools/sofascore/{fetch_match_extras,load_extras_to_supabase}.py` orchestriert via `scripts/sync-sofascore-extras.mjs` als Phase 6 in refresh-all.

**Cloudflare-Bypass Breakthrough (2026-05-10)**: CF blockt `curl_cffi` chrome124 fingerprint vollständig auf api.sofascore.com (alle 30 Webshare-IPs + Tor 0% success rate am 2026-05-10 morning). **Lösung:** `tls_requests` (bogdanfinn/tls-client wrapper) mit anderem TLS-Fingerprint geht durch ohne Proxy. Empirisch verified: 1568 missing games in ~1.5h fetched, 0 errors. Aktivierung: `--use-tls-requests` flag (in fetch + sync + backfill wrappers). Ist jetzt die **default-empfohlene** Methode. Webshare-Pool (20 residential + 10 free DC) bleibt als optional-rotation für bandwidth-distribution falls user-IP rate-limit hits.

**Local SQLite Mirror (NEU 2026-05-10)**: `tools/sofascore/data/local_extras.db` (340 MB SQLite, WAL mode + retry-on-busy) spiegelt ALLE 7 Sofa-extras Tabellen + sofascore_match + `team_xg_history` (87.330 rows, primary engine input). Wired automatisch in `load_extras_to_supabase.py` (default-on, disable via `--no-local-mirror`) + manuell via `tools/sofascore/mirror_team_xg_history.py` (full reset oder `--incremental` für delta). Speichert auch player_match_stats die Supabase skipped. Plus `--no-supabase` mode + Circuit-Breaker (5 consecutive Supabase-fails → abort statt 2h-cascade) für resilience gegen Free-tier IO-budget exhaustion. **Alle engine-critical Daten lokal-mirrored** = Backup gegen Supabase-Outages.

**Team-Name Canonicalization (Architectural Invariant seit 2026-04-27, härter seit 2026-04-29)**:
Multi-source ingestion (FootyStats CSV / OpenLigaDB / shots-model / api-sports / Understat / TheSportsDB) hatte zuvor verschiedene Schreibweisen für dasselbe Team in dieselbe Liga geschrieben — "Bayern München" / "FC Bayern München" / "Bayern Munich" als 3 separate rows. UNIQUE-constraint griff nicht weil `team` string-different. Standings + EWMA + Engine-Predictions silent verzerrt. **Fix in 2 Lagen:**
1. **Ingest-Layer:** `scripts/_lib/canonical-team.mjs::canonicalize(team, league)` — **alle 14 active write-scripts** (5 Top-Tier backfills + 4 MEDIUM-RISK syncs + 3 metadata writers + 2 follow-up importers) mappen team-names zu canonical via TEAM_REGISTRY (354 entries) + EXTRA_ALIASES (27 lower-tier overrides, JS↔TS synced 2026-05-29). 2026-04-29 erweitert: `backfill-xg.mjs` (HIGH), `seed-understat-2526.mjs` (HIGH), `backfill-liga3-goals.mjs` (HIGH disabled-but-callable), `sync-xg-to-supabase.mjs`, `sync-npxg-to-supabase.mjs`, `fetch-fbref-stats.mjs`, `backfill-xg-by-state.mjs`, `sync-thesportsdb-metadata.mjs`, `fill-thesportsdb-missing.mjs`. 4 dormant scripts archived to `scripts/_archive/`.
2. **Read-Layer:** `src/lib/team-resolver.ts::canonicalizeTeamName(name, league)` (TS-mirror) wird in `MatchdayContext.loadCached` BEFORE `resolveXGBucket` aufgerufen — matchdays JSON darf inkonsistent sein, MatchdayContext löst über canonical auf. Fallback: `xg-history-resolver.ts` tier-2 substring.

**~~Known JS↔TS canonical inconsistency (2026-04-29)~~ — RESOLVED (verifiziert 2026-05-29):** Der alte `dedupe-team-names.mjs::buildAliasMap`-Bug existiert nicht mehr — das Script nutzt jetzt `sharedCanonicalize` (aus canonical-team.mjs) als single source of truth, `findCanonical` nur als matchday-derived Fallback. Zusätzlich wurde 2026-05-29 die zuvor diagnostizierte EXTRA_ALIASES JS↔TS-Desync gefixt: beide Files (`canonical-team.mjs` JS + `team-resolver.ts` TS) tragen jetzt **27 identische Einträge** (zuvor JS 27 / TS 22 — 5 fehlten TS-seitig: MK Dons, OFI Kreta, Sporting CP, Stade Rennes, Wattens → Read-Side under-canonicalisierte diese Teams). Sync-Rule-Kommentar in beiden Files aktiv.

---

## Commands

### Development
```bash
npm install
npm run dev         # http://localhost:3000
npm run test        # 893 Tests / 51 Dateien (vitest) — Stand 2026-05-29
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

# Lokale SQLite-Mirrors (engine-critical resilience)
tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py --incremental   # ~1s delta sync
tools/venv/bin/python3 tools/sofascore/load_extras_to_supabase.py --all          # default-on local mirror
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
| `scripts/refresh-all.mjs` | Full-Pipeline Orchestrator (13 Phasen: fetch-odds → settle-bets → liga3-backfill → sync-sofascore → rolling-8 → bridge-sofascore → sync-extras → bridge-extras → matchdays×19 → dev03-cache → retro-enrich → audit; nur fetch-odds ist abortOnFail) | `npm run refresh[:full]` |
| `scripts/fetch-odds.mjs` | Live-Quoten + Fixtures von The-Odds-API (alle 19 Ligen) | GitHub Actions Cron 2× täglich (06:17 + 18:17 UTC) Sun/Wed/Fri/Sat — reduziert 2026-05-21 von 4h auf 12h wegen Budget |
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
| `scripts/burn-in-shadow-signals.mjs [--json] [--min-n 200]` | v1.1 M2 burn-in: aggregiert SHADOW_LOG_ONLY trails × match_outcomes → graduation-recommendations (GRADUATE / KEEP_SHADOW / INVERT_SIGNAL / INSUFFICIENT_N). Deduped by (trap_kind, match_key) gegen Re-emissions. | Wöchentlich, nach match_outcomes-populate |
| `scripts/clv-trap-decay.mjs [--dry] [--json]` | v1.1 M8 CLV-decay-watcher: joined unresolved trails (`clv_resolved_at IS NULL` + `match_kickoff` in Vergangenheit) mit `odds_closing_history`, patched closing_odds + moved_against_us + clv_resolved_at, aggregiert per-trap convergence-rate (MARKET_CONVERGED → DEPRECATE / TRAP_ALIVE / CONVERGING / BURN_IN). | Täglich, nach snapshot-closing-odds |
| `scripts/backfill-football-data-co-uk.mjs --all --season YYYY` (out of `_archive/` 2026-05-21) | Lädt football-data.co.uk CSVs (16 Ligen × Saison) und upserted closing odds (PSCH/D/A) plus PRE-MATCH opening odds (PSH/D/A — 2026-05-21 extension für drift-features) in `odds_closing_history`. Idempotent via `?on_conflict=match_key` + `Prefer: resolution=merge-duplicates`. | Saison-Backfill; rerun nach Update der CSV-Quelle (fd.co.uk publiziert wöchentlich) |
| `scripts/dump-canonical-team-map.mjs` | Dumps (league, raw_name) → canonical Map aller Teams aus `odds_closing_history` + `team_xg_history` nach `tools/v4/diagnostics/canonical-team-map.json`. Nutzt `_lib/canonical-team.mjs::canonicalize` als source-of-truth. Python-side via `tools/v4/modules/m3_xg/canonical_team_map.py::canonical_team`. | Bei TEAM_REGISTRY / EXTRA_ALIASES Änderung |
| `tools/v4/export_dev03_to_json.py` | Dumps `m3_xg-{home,away}-dev-03.pkl` (5 bagged LightGBM Tweedie boosters) + `m6_benter-dev-03.pkl` (per-league β-weights) + golden-test fixtures → `public/dev03-model.json` (7.5 MB). Browser-runnable artifact für `dev03-runtime.ts`. | Nach jedem dev-03 retrain (zusammen mit `export_feature_cache.py`) |
| `tools/v4/export_feature_cache.py` | Snapshot of `EloCalculator` (post-fit `_history[-1]` per team-league) + `TeamMomentumCalculator` (rolling-5 lineup_quality + weighted-3 form_streak) + per-league `compute_league_constants` über volle 87k team_xg_history → `public/dev03-feature-cache.json` (~105 KB). Cache-Snapshot ist `history_through + 30 days` für Alignment mit Python's `get_rating(before_date=future)` Semantik. | Wöchentlich via `refresh:full` (Phase `dev03-cache`) + nach jedem dev-03 retrain |
| `tools/v4/refit-dev03-artifacts.sh` | Post-retrain Orchestrator: rerun `export_dev03_to_json.py` + `export_feature_cache.py` + `generate_dev03_features_golden.py` + vitest dev03 parity-suite, in der reihenfolge-kritischen Reihenfolge. Exit 3 bei Parity-Fail (artifacts geschrieben, Review nötig). `--skip-golden` Flag verfügbar. | Nach dev-03 retrain (analog `refit-all.sh` für v2) |

Alle Scripts nehmen `--dry` für Preview-ohne-Schreiben und `--league X` (wo applicable). `.env.local` wird auto-geladen.

### Shared Libraries in scripts/_lib/

| File | Zweck |
|---|---|
| `matchday-enrich.mjs` | `deriveForm`, `deriveTags`, `deriveStandingsTags`, `deriveH2H`, `computeStandingsFromXG`, `findStanding`, `loadOpenLigaDBSeason`, `inferMatchdayLabel`, Normalisierungshelfer |
| `transfermarkt-ids.mjs` | GENERIERTE 406-Team-ID-Map (22 Ligen incl. austria_bl/swiss_sl/eerste_divisie seit 2026-05-01) + 5-Tier fuzzy resolver. **Bridge zu `transfermarkt-aliases.mjs` ist jetzt aktiv** (war bis 2026-05-01 dead-code → Aliases hatten keinen Effekt) |
| `transfermarkt-aliases.mjs` | 153 manual aliases (Odds-API name → TM name). DE↔EN↔Local Varianten |
| `transfermarkt-scrape.mjs` | fetchTeamInjuries mit rate-limit + Groq HTML→JSON normalisation + quota detection. `USER_AGENT` exportiert (Chrome/120 für TM-friendly access — `Mozilla/5.0` löst sonst Bot-Detection aus) |
| `api-sports.mjs` | api-sports v3 Client mit daily+per-minute Rate-Limit-Guards; League-ID-Map; parseFixtureStatistics Helper |
| `thesportsdb.mjs` | TheSportsDB v1 Client + Liga-ID/Name-Map (19 Ligen) + parseTeamRecord Helper (liefert `api_sports_id` als Cross-Source-Bridge) |
| `odds-api.mjs` | The-Odds-API client mit Multi-Key Rotation. Liest `ODDS_API_KEY` + optional `ODDS_API_KEY_2..._10`; rotiert bei 401/429 oder remaining < minRemaining. Effektives Monatsbudget = N Keys × 500. Genutzt von fetch-odds, fetch-results, backfill-liga3-goals, health-check (seit 2026-04-29) |
| `canonical-team.mjs` | `canonicalize(team, league)` — single source of truth für ingest-side. TEAM_REGISTRY (354 entries from team-resolver.ts) + EXTRA_ALIASES (27 lower-tier overrides). Mirror in `src/lib/team-resolver.ts::canonicalizeTeamName` für read-side (JS↔TS synced 2026-05-29) |
| `trail-aggregations.mjs` | v1.1 Asymmetric Negation pure-functions: `dedupeTrails(raw)` (by trap_kind+match_key), `aggregateBurnIn(trails, outcomeMap, opts)` (graduation recommendations), `aggregateClvDecay(trails, closingByKey, opts)` (CLV convergence stats), `computeClosingHwRate(closing)` (vig-removed implied prob), `clvDecayStatus(rate, n)` (status pill). 26 vitest cases in `tests/trail-aggregations.test.ts`. Konsumiert von `burn-in-shadow-signals.mjs` + `clv-trap-decay.mjs`. |
| `postgrest.mjs` | `inEscape(value)` + `buildInFilter(column, values)` — PostgREST-quote-escape THEN URL-encode in correct order. Naked `encodeURIComponent` lässt `"` und `\` durchrutschen → silent in-list-Truncation. Genutzt von burn-in + clv-decay crons (Quote-Escape-Fix 2026-05-20). |

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

### Sofa Phase 2 Extras Tooling (NEU 2026-05-25, lokal-only)
```bash
# FREE incidents fetcher — NO proxy, NO CF block (web-page SSR path)
# Extracts incidents from www.sofascore.com/event/<id> __NEXT_DATA__ JSON
# Sustained 1.4-2.5 games/sec, covers 1/7 endpoints (incidents only)
python3 tools/sofascore/fetch_incidents_webpage.py --season 22/23 --pace 0.5
python3 tools/sofascore/fetch_incidents_webpage.py --season 24/25 --max 1000  # batch

# Full 7-endpoint fetcher (needs Webshare proxy rotation for CF-bypass)
# Use --skip-cached to skip games with all 7 endpoints already present
# (fixed 2026-05-25: was naive file-exists, now requires all 7 endpoints
# in JSON — see fetch_match_extras.py::already_cached)
python3 tools/sofascore/fetch_match_extras.py \
  --season 22/23 --all-tiers --use-webshare --skip-cached --pace 1.5

# Load JSONs to LOCAL SQLite mirror only (skip Supabase entirely)
python3 tools/sofascore/load_extras_to_supabase.py --all --no-supabase
```

**Webshare proxy rotation pattern (empirical 2026-05-25):**
- 20-IP residential pool burns ~1,500 games per ~30-60min before CF blocks pool
- After block: TCP-level dead (ProxyError) — need new IPs OR 6-12h cooldown
- Math: ~120 fresh IPs needed for full 8,336 remaining all-7-endpoints games
- OR Webshare Rotating-Residential plan ($25/mo, unlimited rotation, ~2-4h total)

`tools/statsbomb/aggregates.csv` liefert für Model-Training Event-level aggregates:
shots (total/SoT/in-box/out-box/under-pressure/head/foot), xG (StatsBomb's kalibriertes Model), goals,
avg_shot_x/y, xg_per_shot, pct_shots_in_box, passes (total/completed/%), carries, pressures, fouls, offsides.
Use-Case: Richer shots-to-xG regression (>R²=0.57 Baseline) + validation-corpus für v3.

---

## Architektur-Big-Picture

```
Supabase (DB + Auth + RLS)
  ↕
Next.js 16 App Router (React 19, alle pages "use client")
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
  │        fetch-odds.yml (12h on matchdays): odds + closing-snapshot + value-alerts
  │        settle-bets.yml (täglich): fetch-results + liga3-openligadb + footystats
  │        ci.yml (push/PR): lint → typecheck → test → build
  │      Local supplement: scripts/launchd/ (macOS LaunchAgents)
  │        com.fodze.refresh        — täglich 07:30, refresh-all.mjs --skip-odds
  │                                   (matchday-regen ohne odds-burn; odds-refresh
  │                                    owned exclusively by GitHub Actions seit 2026-05-21)
  │        com.fodze.refresh.full   — Di + Fr 19:00, refresh-all.mjs --injuries --skip-odds
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

## Tests

- **vitest (TS):** 893 tests / 51 files (verifiziert 2026-05-29: `npx vitest run` → 893 passed, `tsc --noEmit` → 0 Fehler)
- **v4 pytest (Python):** 244 `def test_` in `tools/v4/tests/` (17 Dateien; m1–m10 modules)

```bash
npm run test              # alle TS-Tests
npm run test:watch        # Watch-Mode
npx vitest run tests/bet-metrics.test.ts  # einzelne Datei

# Python (v4) tests
cd tools/v4 && ../venv/bin/python3 -m pytest tests/ -v
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
- `asymmetric-negation.test.ts` — v1.1 `evaluateLatentTopology` (M2/M4/M5/M7), 25 cases incl. persistence-contract (canonical matchKey + seconds-kickoff + ms-detectedAt)
- `trail-aggregations.test.ts` — v1.1 Cron-Analytics (dedupeTrails, aggregateBurnIn 4-recommendations, computeClosingHwRate vig-removal, clvDecayStatus pill, aggregateClvDecay updates-vs-aggregation-dedupe), 26 cases

**v4 pytest suite** (244 `def test_` functions, `tools/v4/tests/`):
- `test_m1_score.py` — DC math identities + ρ-MLE + coarse-graining
- `test_m2_lambda.py` — EWMA estimator
- `test_m3_xg.py` — dev-03 lean feature_builder + ensemble + DC integration
- `test_m4_setpiece.py` — set-piece adjustment
- `test_m5_stubs.py` — regime + intensity filter contracts
- `test_m6_market.py` — Benter blend + Shin vig-removal
- `test_m7_kelly.py` — Robust Bayesian Kelly + Goldilocks + CLV dampening
- `test_eval_metrics.py` — Brier/LogLoss/ECE + bootstrap CI
- `test_coverage_router.py` — dev-06 Option C router decisions (19 cases)
- `test_feature_builder_premium.py` — Sofa-extras orchestrator (10 cases incl. real-data smoke)
- `test_blended_predictor.py` — m3_lean + m3_premium blend math (8 cases)

**NICHT getestet**: React-Contexts (MatchdayContext, AppContext), Components (MatchDetail, BetHistoryShare, etc.), API-Routes, Hooks, Pages, Scripts.

---

## Areas to Watch (Stand 2026-05-28)

Historical entries (dev-04/05/06/07/08 archives, one-time backfill events, Sofa-bypass discoveries, dev-03 sprint-by-sprint deltas) sind in [`docs/archive/areas-to-watch-2026-05.md`](docs/archive/areas-to-watch-2026-05.md). Hier nur was OPS-RELEVANT für laufenden Betrieb ist.

### Production state

| Area | Status | Notes |
|---|---|---|
| **Engine math (v2 + dev-03)** | live | v2 = isotonic + Benter blend (Brier 0.6120 current-season). dev-03 = LightGBM Bayesian-Ensemble + per-league m6_benter (cross-season-validated Money-Edge in 3 Ligen — see Money-Eval row below). |
| **Forecast-quality framework + Blend** | analyzed (2026-05-28), NOT wired | Objective-Schwenk: Prognose-Güte (xG-RMSE + 1X2-Brier gekoppelt), ROI nur sekundärer Tiebreaker. `v4.eval.metrics` xG-forecast-Primitive (xg_rmse/mae/bias, 6 tests) + 19 Diagnostics in `tools/v4/diagnostics/`. **50/50 λ-Blend (dev-03⊕dev-09) dominiert beide Reinmodelle auf BEIDEN Achsen, BEIDEN Holdouts** (25/26: 0.7016/0.6111 · 24/25: 0.6873/0.6093 = xG-RMSE/Brier) — validiert-bester Forecaster, aber **NICHT wired** (dev-09 braucht Live-Lineup-Pipeline; dev-03 bleibt Production-Default). Scorecard 25/26 OOT: 1X2 48.9%, O/U 55.2%, xG-MAE 0.53 Tore, BSS +5.9%. **Confidence-Badge auf ECHTEM Production-Pfad validiert** (`validate_confidence_production_path.py`, 2026-05-29): das Badge zeigt dev-03 **Benter-geblendet** Richtung Pinnacle (NICHT Isotonic — das ist Track-B/Kelly-only); Blend verbessert Brier 0.619→0.604 → HOCH ≥65% trifft 78.7% (25/26) / 73.5% (24/25 OOT), die „~73%"-Claim ist konservative Untergrenze. Single-source `src/lib/confidence-tier.ts` (12 Tests). **xG-Skill-Score** vs Liga-Mittel-Klimatologie (RMSE 0.733, `xg_skill_baseline.py`): +4.2% dev-03 / +8.4% Blend → echtes aber bescheidenes Skill, 0.70 RMSE ist größtenteils irreduzibles per-Spiel-Rauschen. **REJECTED (5-Gate/Persistenz):** dominance-conversion (redundant mit dev-03-λ, Residual r=0.024, Brier-Δ 1.1σ, G5 negativ) · draw-value (25/26 +5.9% CI⊃0, 24/25 OOT −8.16% CI<0 = Rauschen) · training-focus-on-high-conf (falsifiziert über k-Sweep {0,0.5,1,2,4} `eval_conf_weight_sweep.py`: KEIN monotoner High-Conf-Gewinn — einziger Dip bei k=0.5 −0.0093 ist nicht-monoton = Rauschen, Overall-Brier monoton schlechter mit k, High-Conf-Acc fällt 72.6→71.6%; High-Conf ist nur ~7% des Brier-Verlusts + Upset-gedeckelt → richtiger Hebel = selektive Vorhersage). Neue Fähigkeit: `BayesianEnsemble.fit(sample_weight=)` + `train_m3_xg --conf-weight-k` (additiv, default-aus, getestet). Vollbericht: `docs/FORECAST-QUALITY-ANALYSIS.md`. |
| **dev-03 TS-runtime end-to-end** | shipped (2026-05-21) | 4 Sprints in einem Sitzen: `dev03-runtime.ts` (5-bagged LightGBM browser-runnable, 43 tests) + `dev03-features.ts` (m2_lambda+Elo+Momentum TS port via precomputed cache, 40 tests) + `dev03-engine.ts` (MatchCalc wrapper) + AppContext bootstrap + MatchdayContext routing. Artifacts: `public/dev03-model.json` (7.5 MB) + `public/dev03-feature-cache.json` (~106 KB). Engine erscheint als "v4 dev-03" in Settings + /matchday. Money-Eval-validated für serie_a/scottish_prem/epl. **Cache-refresh cron**: `dev03-cache` Phase in refresh-all.mjs. **Post-retrain workflow**: `tools/v4/refit-dev03-artifacts.sh` (analog refit-all.sh for v2). Defense-in-depth: hard early-return guard in `benterBlend()` für `engine === "dev-03"` verhindert silent double-blend selbst wenn `benter-weights.json` versehentlich einen `dev-03` Key bekommt. Per-sprint deltas: archive. **Schema-drift invariant (2026-05-27):** `train_m3_xg.py` evolved to 20 numeric features (dev-04/05 sprints), but production locked at 16 via `FEATURES_LOCKED` in `export_dev03_to_json.py` + dev03-features.ts. Retraining for production MUST use `train_m3_xg.py --features-locked` flag (added 2026-05-27, `DEV_03_LOCKED_FEATURES` mirrors `FEATURES_LOCKED`). Running without `--features-locked` produces 21-feature pickle that fails `refit-dev03-artifacts.sh` schema gate. Multi-season retrain attempt 2026-05-27: dev-03-fresh Brier 0.6133 vs production 0.6141 = Δ -0.0008. Under the **NEW** empirical 1σ inter-seed std of 0.000456 (measured same day, n=5 bootstrap) this is **1.75σ on the same-corpus scale — borderline, NOT clean sub-noise** as initially framed. But the comparison conflates seeds (same: [42-46]) and corpus (different: +1,238 rows), so cross-corpus signal isn't cleanly testable. Conservative decision: production unchanged, fresh archived. See `docs/archive/areas-to-watch-2026-05.md::dev-03 multi-season retrain attempted (2026-05-27)`. |
| **v1.1 Asymmetric Negation Protocol** | live (2026-05-20) | 8-Mandate-Refactor (M1-M8). `evaluateLatentTopology` in `goldilocks-engine.ts` (Possession-Trap mit M5 Heckman gate + Manager-Bounce M4 piecewise-step + TACTICAL_WIDTH SHADOW_LOG_ONLY). UI: Veto-Badges + Kelly-Multiplier + "Veto-frei" Filter in `/goldilocks`. `epistemic_trails` Tabelle live. Beide Crons (burn-in M2 + clv-decay M8) shipped + dedupe-protected. **Persistence-contract**: matchKey canonical FODZE-format, matchKickoff Unix SECONDS, detected_at Unix MS. **Future M4**: `matchSinceManagerChange` + `tacticalWidth` weiter null durchgängig — Sofa-`match_managers`-Join sprint pending. |
| **v1.2 Filter-Shield (CSD veto)** | live (2026-05-22) | 3-stage empirical workflow: (1) `tools/v4/diagnostics/csd_veto_threshold_calibration.py` testete 16 Veto-Configs gegen v2-OOT Brier-lift → **persistent_reversal regime on goal_diff signal (loose thresholds) qualified**: n=355, Brier lift +0.0427 (CI [+0.017, +0.069]). (2) `csd_veto_money_eval.py` Kelly-PnL: small joined-sample (109 bets, 6 shield-affected) → direction-positive (+0.0017) but CI crosses 0. (3) Persistent_reversal ships ACTIVE (multiplier 0.50), catastrophic SHADOW until 200-firing burn-in. **Production-wiring live**: AppContext loads `/filter-shield-config.json` → MatchdayContext.loadCached attaches per-team last-10 goal_diff series via new `byTeamGoalDiff` index → MatchdayContext.calcMatch builds `shieldVetoes` once via `buildCsdVetoes()` → forwarded through `mlInputs.shieldVetoes` to v1/v2/dev-03 wrappers + directly to ensemble + footBayes `calculateBetsEnhanced` → min-pool multiplier applied to Kelly post-CLV-dampening pre-final-clamp. `EnhancedBetCalc` gains `shieldMult/shieldActive/shieldShadow` diagnostics for UI surfacing. Modules: `tools/v4/modules/m9_filter_shield/{csd_veto,shield_orchestrator,config}.py` (28 pytest) + `src/lib/filter-shield.ts` (30 vitest, Python parity at rho_1=-0.98995 to 4 dp). Single-source-config: `public/filter-shield-config.json`. **Full test sweep 1979/1979 + 0 src TS errors + clean prod build.** **Rejected layers (DO NOT re-implement without new evidence):** TRAVEL_FATIGUE (62% stadium-MNAR confounds signal — detected-fatigue subset has +0.063 NEGATIVE Brier lift), PER_LEAGUE_ISOTONIC (walk-forward CV: all 3 target leagues fail acceptance gate; deferred to backlog after 22/23+23/24 v2-OOT backfill). |
| **Money-Eval Hybrid-Per-League Map** | UPDATED (2026-05-25 self-eval CORRECTION) — directional only, NOT statistically significant | **NEW dev-03 (multi-season corpus 2022-07→2025-08):** Stage 5 on 25/26 holdout — €100→€149.14 (+49.1% compound), ROI +5.4%/bet. **WALK-FORWARD validation** (train 22/23+23/24, holdout 24/25): ROI +3.36%, max-DD 24.22%. Per-Liga ROI rankings HIGHLY UNSTABLE between holdouts. **First audit (commit 21a13c1)** applied assumed-SE Holm-Bonferroni → claimed 4 "validated" leagues (la_liga/scottish_prem/bundesliga/primeira_liga). **Self-eval re-audit (`tools/v4/diagnostics/bet_edge_policy_empirical_audit.{py,json}`)** found assumption was wrong: empirical per-bet std = **148%** (not 80%). Under correct SE: **ZERO Liga survive Holm-Bonferroni** at α=0.05. Even AGGREGATE dev-03 ROI is NOT statistically significant (p_raw=0.227). Policy NOT removed because the 4 leagues ARE the only ones with Kelly-weighted positive ROI in BOTH holdouts (directional consistency). **Reframed as "directional only"** in commit-after-self-eval — header docs + reason fields explicitly state NOT statistically validated. `holm_p_adj` column flagged @deprecated (was optimistic). Schema: roi_walkfwd_24_25 + roi_holdout_25_26 + sampleSize_* unchanged. Public API unchanged → Goldilocks page works (but UI tooltip should disclose "directional not statistically validated"). **PRODUCTION CONSEQUENCE**: `hasValidatedEdge(league)` returning true means "directional filter passed", NOT "validated edge". `expectedROIperStake()` is HISTORICAL mean, NOT forecast. Re-audit annually via empirical script. Audit chain: pre-audit (assumed-SE, do NOT trust): `bet_edge_policy_audit.{py,json}` · empirical (correct SE): `bet_edge_policy_empirical_audit.{py,json}`. |
| `team_xg_history` canonicalization | clean | All 22 leagues drift=0; canonicalize-on-write across 14 ingest-scripts. Read-side via `MatchdayContext.loadCached → canonicalizeTeamName`. TS↔JS aligned via `tests/canonicalize-team-name.test.ts` (15 cases). |
| `match_outcomes` schema | clean | UNIQUE (match_key, match_date) — supports double-round-robin (austria_bl etc.). |
| **Sofascore standings (DB view)** | live (2026-05-01) | `sofascore_standings` View ersetzt `computeStandingsFromXG` für 10 leagues — bypass PostgREST 1000-row default page-limit (vorher 1-3 Teams aus EPL/BL/Ligue 1 verloren). |
| **TM injuries 22 Ligen** | live (2026-05-01) | `build-tm-team-ids.mjs` jetzt 22 Ligen. `TRANSFERMARKT_ALIASES`-bridge wired. html_decode in scraper verhindert `&amp;`-key-bugs. |
| **Cloudflare-Bypass via tls_requests** | default (2026-05-10) | `tls_requests` (bogdanfinn/tls-client wrapper) — anderer TLS-Fingerprint als curl_cffi, geht durch ohne Proxy. Activation: `--use-tls-requests` flag. **Default-empfohlene Methode**. |
| **Local SQLite Mirror** | live (2026-05-10) | `tools/sofascore/data/local_extras.db` (340 MB) spiegelt 7 Sofa-extras + sofascore_match + team_xg_history (90k rows). **Engine-critical data alle lokal** — Supabase-Outage resilient. |
| **Sofascore→team_xg_history Bridge** | live (2026-05-05) | `scripts/bridge-sofascore-to-team-xg.mjs` propagiert per-team-per-game idempotent in `team_xg_history` mit `source='sofascore'`. Phase 5 in `refresh-all.mjs`. Canonical names via `canonicalize()`. |
| **GitHub Actions cron** | healthy + budget-tuned (2026-05-21) | `fetch-odds.yml` repariert (war 41 Tage YAML-broken). Multi-Key support `ODDS_API_KEY_2..._10`. **Schedule reduziert 4h → 12h on matchdays** (Sun/Wed/Fri/Sat 06:17+18:17 UTC) — siehe "Odds-API budget posture" row. |
| **Odds-API budget posture** | tuned (2026-05-21) | Discovery via `npm run health`: K1+K2 hard-exhausted (500/500 used both), only K3 (`6c7dc9…`) hatte credits. **3-layer fix**: (1) added `ODDS_API_KEY_3` to .env.local + multi-key rotation greift, (2) GitHub Actions `fetch-odds.yml` cron 4h → 12h = -870/month credits, (3) beide launchd plists (`com.fodze.refresh{,.full}.plist`) gepatched mit `--skip-odds` — GitHub Actions besitzt jetzt allein die live_odds-refresh-responsibility, launchd nur matchday-regen + injuries. **Total burn**: 3060/month → 1050/month (-66%) bei gleicher Production-Coverage. Sustainable auf 3 keys × 500 = 1500/month max budget. Reset-Datum für K1/K2 nicht im Response-Header — Account-Dashboard check empfohlen. Budget-Math + Doku in `fetch-odds.yml` header. |
| **Audit season-awareness** | shipped (2026-05-21) | `scripts/audit-data-quality.mjs` flagged früher 19 P1 false-positives ("live_odds 142h alt — Cron läuft nicht?") obwohl der wahre Grund Saisonende war (8 Liga: bundesliga/liga3/ligue_2/eerste_divisie/primeira_liga/super_lig/greek_sl/swiss_sl haben 0 upcoming fixtures). **Fix**: neue `auditUpcomingFixtures()` Funktion + `seasonActiveByLeague` Lookup; P1 stale-warnings skippen jetzt off-season-Liga. Plus positive ℹ output listet off-season Liga explizit damit user weiß es ist erwartet. **Output Δ**: 19 P1 → 0 critical + 1 ℹ informational. **Known limitation**: classifies "0 upcoming fixtures = off-season". Edge case: if fetch-odds cron broken DURING active season for >14 days, upcoming_fixtures stale-decays to empty → audit falsely classifies as off-season → P1-cron-warning gets silently skipped. Mitigation: combine with `team_xg_history`-recent-match-date check for ground-truth season-state. Not implemented — calendar (Jun-Jul = off-season) would be the cleanest fallback. |
| **Source-data sort_values determinism** | enforced (2026-05-21) | `pandas.sort_values` default `kind='quicksort'` ist UNSTABLE. **Fix**: alle 5 sort_values in `tools/v4/modules/` (Elo + TeamMomentum + m2_lambda × 2 + player_lineup) verwenden `kind="mergesort"` + canonical secondary key. Cache + Python pipeline match 800/800 mit max diff 0. **Audit-Methode**: `grep -rn "sort_values" tools/v4/modules/ \| grep -v "kind="`. 3 Regression-Tests in `tools/v4/tests/test_elo_momentum_determinism.py`. Tolerances tightened auf 1e-6 (was 5e-2 wegen falsch-diagnostiziertem duplicate-row-trap). Numerical-anchor `Bayern_Elo ± 1e-6 → ± 0.01` für Tweak-tolerance ohne den Determinismus-Catch zu opfern. |
| **team_xg_history dedup** | applied (2026-05-22) | Initial diagnostic claimed "35.8% inflation" — **MISLEADING.** Actual scope nach proximity-aware check: only 25 echte cross-source duplicates (sofa+understat 1-2d apart for same fixture, 0.03% of 90,872 rows). Other ~6,000 "extra" rows vs Sofa truth are **legitim** unterschiedliche matches (cup tagged as league, friendlies, pre-Sofa coverage seasons, Sofa data gaps) — NOT duplicates. Diagnostic error: original audit joined `team_xg_history.team` (canonical) to `sofascore_match.home_team` (Sofa raw) without canonicalization, causing false-positive "missing in Sofa" classifications for accent/prefix variants ("Atletico Madrid" vs "Atlético Madrid", "Barcelona" vs "FC Barcelona"). `scripts/dedup-team-xg-history.mjs` implements the correct cross-source dedup with ±14-day proximity guard (prevents false-positive dedup of Belgian playoff / Scottish split / legit-rescheduled matches). 25 dupes deleted from Supabase + local mirror reset. **No retrain needed** — 25 rows below noise threshold (single-seed inter-seed variance ~0.002 Brier units). |

### Active tech-debt / gaps

| Area | Status | Notes |
|---|---|---|
| **Conformal Gate drift** | **REFIT 2026-05-28 — drift FIXED 🟢** | Re-fit on 25/26 OOT (n=6,525, 2025-08 → 2026-05) via `tools/backtest/refit-all.sh`. Root cause was stale hardcoded date window in `tools/calibrate_dirichlet.py:170` + `tools/fit_conformal.py:196` (was `2023-08-01...2024-07-01` since dev-02 era; advanced to `2025-08-01...2026-07-01`). **Per-league empirical coverage on Dirichlet-CALIBRATED probs (apples-to-apples with old audit): ALL 18 leagues \|drift\| ≤ 0.73pp.** EPL: **+0.24%** (was -8.50% catastrophic on Dirichlet path). Worst: scottish_prem +0.73%. Aggregate at α=0.05 = +0.19% (near-perfect). Brier 0.6267 → 0.6227. **NEXT_PUBLIC_CONFORMAL_GATE flip-to-enforce now UNBLOCKED.** Previous drift audit `tools/backtest/conformal-drift-report.json` (2026-04-29) superseded. Walk-forward isotonic-per-league attempt 2026-05-22 still archived in `tools/v4/modules/m10_per_league_calibration/` (it failed, but kept for multi-season validation reference). |
| **v1.2 Filter-Shield UI + persistence** | live (2026-05-22) | Goldilocks-page computes CSD vetoes alongside v1.1 topology (uses identical hHist/aHist data from `histByKey`), batches into existing `trailBatches` array, POSTs to `/api/persist-trails`. `shieldVetoToTrail()` helper in `src/lib/filter-shield.ts` converts ShieldVeto → EpistemicTrail (trap_kind = first two `:` segments of veto.name, raw_signals numeric-only, kickoff in Unix SECONDS, detected_at in MILLISECONDS per migration contract). UI: per-bet `csdVetoes` + `csdMult` filtered to market-relevant team-side (1→home, X→draw, 2→away, Ü2.5→over, U2.5→under); active vetoes render orange "🛡 CSD pers-rev" badges with regime tooltip + "Kelly × N" multiplier pill; shadow vetoes render italic gray line. "Veto-frei" filter extended to also gate on active CSD vetoes. `/health` Section "FILTER-SHIELD (CSD VETO)" aggregates last 7d firings: total active/shadow split, mean active multiplier, per-regime breakdown, per-Liga top-12 firing counts, catastrophic burn-in counter (X/200) toward shadow→active graduation. Failure-safe: empty-state hint when no trails yet. **Full test sweep 1979/1979 + 0 src TS errors + clean prod build.** |
| **launchd cron health** | fragile 🟡 (less critical seit 2026-05-21) | macOS sleep/wake DNS-readiness race. Symptom: `live_odds 38h alt`, "getaddrinfo ENOTFOUND". Workaround in `refresh-all.mjs` aktiv (6×10s DNS retry). **Reduced criticality**: seit beide plists `--skip-odds` flag haben, ist launchd kein Odds-Refresh-Owner mehr — failure-Recovery für odds liegt bei GitHub Actions (separates env, kein DNS-race). Launchd nur noch für matchday-regen + injuries (off-season eh inaktiv). |
| **`sofascore_team_rolling_8` view** | tech-debt 🟡 (2026-05-09) | ~1.7s service-key, ~3s anon (timeout). Full-scan + window-aggregation inherent slow. Production-consumer ist nur `tools/sofascore/engine_features.py`. Bei Retraining ~11min/rolling-8-load. Fix-Optionen: materialized view + nightly REFRESH OR cron-populated cache-table. |
| **Sofascore-features in Engine** | evaluated no-enable 🟡 (2026-05-03) | 3 Integration-Strategien getestet. Beste single-config: Replace feature 19 durch mean_shot_xg = -0.0031 Brier global aber EPL +0.0235 schlechter (Brentford-Effekt). Run-Variance ±0.005 frisst Sofa-Signal. EPL-Blacklist via `SOFA_F19_BLACKLIST`. |
| **dev-03 Auto-Routing UX** | manual only 🟡 | Validation-Badge in Goldilocks zeigt "🎯 Dev-03" als RECOMMENDATION, aber User muss Engine **manuell** in Settings switchen. Hybrid-Engine-Story aus `bet-edge-policy.ts` bleibt empfehlend, nicht durchgesetzt. |
| **dev-03 cache-staleness surface** | not monitored 🟡 | `dev03-feature-cache.json.data_window.history_through` existiert, aber UI surface fehlt. Bei Cron-Tod arbeitet User mit N-Wochen-altem Cache ohne Warnung. Future: `/health` Section. |
| **22/23 + 23/24 + 24/25 Phase 1 Sofa backfill** | DONE (2026-05-25 extended) | Full shotmap+match metadata via fetch_shots.py season-list endpoints (Mac-IP CF-frei for season-list, no proxy needed). **22/23**: 22 leagues = 6,822 ended matches. **23/24**: 22 leagues = 6,949 matches. **24/25** (extended 2026-05-25): added 11 missing leagues (eredivisie, primeira_liga, eerste_divisie, greek_sl, jupiler_pro, super_lig, scottish_prem, austria_bl, swiss_sl, league_one, league_two) = +3,072 new matches → total 7,015. **25/26**: 6,856 (ongoing). Bridge to team_xg_history: 42k+17k upserts via scripts/bridge-sofascore-to-team-xg.mjs (Sofa-quality xG now active for all Tier-A+B-premium 22/23-24/25, ~3,500+ net new rows). la_liga2/eerste_divisie/league_one/league_two/ligue_2 = volume tier (no Sofa-xG, bridge skips). Phase 1 multi-season corpus ready for dev-03 retrain. |
| **Phase 2 Sofa extras (multi-season)** | NEAR-COMPLETE (2026-05-27) — 95-97% slim-3 across all 4 seasons | **Final state after 26h sprint (2026-05-26 → 2026-05-27)**: per-season slim-3 (statistics+lineups+average_positions) coverage **22/23 97.0%** (was 45.4%), **23/24 95.6%** (was 92.5%), **24/25 96.6%**, **25/26 99.9%**. **Sprint achievement: +5,404 enriched cache JSONs** (Phase-2 slim-3) across 3 chain runs spanning 2 days. **🔓 CF block partially lifted briefly 2026-05-26 morning** but Mac-IP-direct (curl_cffi chrome124) only works for **initial bursts ~600 games** then CF flags the IP → HTTP 403 sustained. **Empirical Webshare-pool capacity (30-IP residential)**: chain v2 (afternoon 2026-05-26) sustained ~2,500 games before burnout · chain v3 (next-day 2026-05-27 after 17h cool-down) only ~500 games before pool dead again — **capacity DIMINISHES per cycle on same pool**, recovery needs days not hours. Remaining ~660 games to reach 100% — accept "good enough" OR upgrade Webshare Rotating-Residential ($25/mo) OR week-long cooldown retry. **fetch_upcoming_lineups.py** still defaults to Mac-IP-direct with auto-fallback to Webshare after 3 consecutive BlockedErrors — appropriate for the upcoming-lineup use case where N=10-50 games/hour easily fits within burst budget. **For backfills (N=1000+ games)**: chain script `tools/sofascore/run_sofa_backfill_chain.sh` (force-add to git for re-use) handles 3-stage sequential 22/23/24 with 90s cool-downs. Per-event endpoints (statistics, lineups, incidents, average-positions, managers, pregame-form, team-streaks) protected by Sofa Varnish/CF at IP-reputation level. **All-7-endpoints coverage (pre-2026-05-26 backfill)**: 22/23 27.5%, 23/24 81.7%, 24/25 73.3%, 25/26 96.4%. **Slim-3 coverage (engine-critical statistics+lineups+average_positions only)**: 22/23 **45.4%** (post slim-3 run · +17.9pp), 23/24 84.7%, 24/25 76.4%, 25/26 99.9% — **6.449 games TODO for slim-3 completion · now organically tractable via Mac-IP**. **Incidents-only (1/7)**: ~100% all 4 seasons via FREE SSR path. **Slim-mode addition (commit ada7f19)**: `fetch_match_extras.py --endpoints statistics,lineups,average_positions` cuts ~50% of api.sofascore.com calls per game → ~2x games per CF burst. **Bypass methods empirical-tested 2026-05-25**: (1) Direct API curl_cffi: HTTP 403, (2) Tor exits: 403, (3) GitHub Actions Azure IPs: 403 (12/12), (4) Playwright Chromium: 403, (5) sofascore-wrapper/ScraperFC/sofascrape/datafc/cloudscraper: all 403, (6) Alt subdomains: 404, (7) `www.sofascore.com/event/X` SSR: **WORKS** for incidents only (52KB embedded in __NEXT_DATA__) — `tools/sofascore/fetch_incidents_webpage.py` (free, no proxy, 1.4-2.5/s), (8) Webshare residential 20-IP pool: **WORKS** ~1.000-2.500 games per burst (slim-3 doubles vs all-7) before CF burnout, then silent timeouts (not 403 → no auto-rotation). **tls_requests bug discovered 2026-05-25**: `tls_requests` (bogdanfinn) library tries QUIC/HTTP3-Upgrade after seeing Sofa's Alt-Svc header → `listen udp :0: bind: resource temporarily unavailable`. Works for github/google/httpbin, breaks specifically for api.sofascore.com + www.sofascore.com. Library-level bug, not trivially fixable. **Empirical model (slim-3)**: 7 fresh proxies × ~150 games = ~1,000 games per burst. Remaining 6,449 missing-slim-3 games would need ~6 fresh proxy batches OR Webshare Rotating-Residential plan ($25/mo) OR Hetzner VM. **Webshare proxy rotations**: 7 fresh replacements integrated commit ada7f19 (FW-02/06/07/09/10/13/20 swapped — egress-IP match to filename column 5). |
| **FS Pre-Match Signals + Players** | **DROPPED 2026-05-28** (both tables) — historical record of falsification | Two new tables ingested from existing FS CSV stock (no fresh downloads needed for prematch_signals; +80 FS-credits for players). Falsification pipeline rejected BOTH at appropriate gates: (1) `match_prematch_signals` 1X2 features rejected via signed-residual test (r_resid=0.02 — market eats it). (2) `player_season_stats` team-aggregated xa_diff INITIALLY showed r_resid=+0.07 across 5 ligas, BUT 3-gate causal validation (`fs_player_causal_gates.py`) revealed **94% of signal was backward-leakage** — season-aggregate features included matches AFTER focal kickoff. Proper season-lag test (use season N-1 to predict season N) shows aggregate r_resid=+0.004 (essentially zero). Only super_lig preserves signal under lag (r_lag=+0.106 n=515) — could be Turkish-market-inefficiency edge OR 1-in-8 multiple-comparison false positive, not worth pursuing as single-league. (1) `match_prematch_signals` — 38.696 rows, 22 ligas × 5 saisons (110 Match CSVs). Pre-Match xG/PPG/BTTS%/O15/25/35/45% + avg corners/cards + attendance + stadium. Importer: `scripts/import-footystats-valueadds.mjs` (commit 0e8e76c). Migration: `scripts/migration-match-prematch-signals.sql`. **Does NOT touch team_xg_history** — separate table, zero Sofa-overwrite risk. **Closing odds intentionally NOT captured** (FS not Pinnacle-sourced — would corrupt Benter blend). Data caveat: Spielwoche 1 jeder Saison hat zeros für pre-match fields (FS hat noch keinen prior, dieser Eintrag ist "no data" nicht "0%"). avg_home_xg drift: alle Ligen 21/22→24/25 systematisch fallend (bundesliga 1.65→1.36, epl 1.62→1.33) — wenn als Feature: per-Liga × Saison normalisieren. **Falsification test (2026-05-25, `tools/v4/diagnostics/fs_prematch_signal_test.{py,json}`):** signed-residual correlation on n=12.579 joined matches (mps × Pinnacle closing × ft_goals, bridge via canonical_team()): `fs_xg_diff → home_win residual r=+0.020 p=0.044` and `fs_ppg_diff → home_win residual r=+0.015 p=0.088` — **NOISE for 1X2 markets** (raw r=+0.26/+0.23 collapses to ~0 after subtracting market baseline). Pinnacle has them priced in. super_lig is the only per-league STRONG signal (r=+0.101 n=735) — expected by chance given 18-league comparison. **Goals/BTTS tests UNTESTABLE** (fd.co.uk closing has Pinnacle 1X2 but Over/Under only 37/19191 rows, no BTTS at all). **Strategic verdict**: match_prematch_signals is **backtest-corpus only** for 1X2, NOT engine-improvement source. Do not spend dev-03 retrain. Goals/BTTS testing blocked on Pinnacle Over25 backfill. Same trap pattern as REJECTED Phase A starter features (#64). (2) `player_season_stats` — 34.216 player-season rows, 16 lower-tier ligas × 5 saisons (80 Players CSVs · Top-5 ausgelassen weil Understat besser ist). 45 high-value cols aus FS's 271-col Players CSV: identity/volume/xG-xA-npxg/shooting/defensive/GK/discipline/value-meta. Importer: `scripts/import-footystats-players.mjs`. Migration: `scripts/migration-player-season-stats.sql`. **Engine-Use:** schließt lineup_quality + market_value-proxy Gap für 17 lower-tier leagues — **player-level falsification test NOT yet run** (team-aggregated features benötigen lineup assumptions). **Honest caveats**: (a) liga3 xG erst ab 24/25 sinnvoll populiert (10% pre-24/25 → 70% in 25/26), (b) `xg_faced_total` für GK ist N/A in ALLEN 16 ligas (FS computed nur für Top-5 — `goals_prevented`-feature für lower-tier NICHT möglich aus FS), (c) eerste_divisie players gestrichen (war ursprünglich geplant, user-decision). FS-Premium 100→13 credits verbleiben. |

### Reference

| Area | Status | Notes |
|---|---|---|
| **Datapoints Inventory** | live (2026-05-10) | [`docs/DATAPOINTS-OVERVIEW.md`](docs/DATAPOINTS-OVERVIEW.md) — color-coded matrix aller Datenpunkte × Engine-Nutzung + per-Liga coverage. **Lese ZUERST bei Engine-Feature-Fragen.** |
| **Data Inventory** | live (2026-05-10) | [`docs/DATA-INVENTORY.md`](docs/DATA-INVENTORY.md) — Source-Catalog × Saison × 22 Ligen mit row counts + date ranges. |
| **v4 backtesting protocol** | live (2026-05-12) | [`docs/V4-BACKTESTING-PROTOCOL.md`](docs/V4-BACKTESTING-PROTOCOL.md) — Stage 0/1/5 + ship-gates G1 (Brier ≤ v2-0.003) + G2 (Stage 5 ROI bootstrap CI > 0). |
| **24/25 + 23/24 endpoint coverage** | verified (2026-05-14) | Sofa-backfill für historische Saisons ~95% data-integrity vs current. pregame-form fehlt Week 1-2 (prior-season-form data fehlt). Tool: `tools/sofascore/verify_{24-25,23-24}_endpoints.py`. |
| **Understat bridges** | live (2026-05-14) | Team-level 24/25 (1827 matches Top-5) + Player-level 8 Saisons (424k rows × 21k players). Idempotent dedup. Tools: `tools/sofascore/bridge_understat_{24-25,players_24-25}.py`. |
| **Supabase advisor cleanup** | done (2026-05-09) | 15 ERRORs cleared (RLS auf 10 Sofa-Tables, 5 Views auf SECURITY INVOKER, 2 Functions explicit search_path). 21 verbleibende WARNs intentional. |
| `team_metadata` cross-league sync | best-effort 🟢 | 54 cross-league gaps (Reserve-Teams + austria_bl/swiss_sl/greek_sl regional clubs nicht in TheSportsDB Free-Tier) — nicht critical. |
| **FODZE-Optimal Blueprint** | reference (codified 2026-05-27) | [`docs/FODZE-OPTIMAL-BLUEPRINT.md`](docs/FODZE-OPTIMAL-BLUEPRINT.md) — strategic snapshot · 6-perspective architecture · 10-feature engineering spec · 5-Gate protocol checklist · production roadmap · quantitative appendix. **Two flagged inaccuracies** (`pinnacle_drift` + `expected_goals_prevented` listed as passed Core Model features — both empirically rejected per dev-07 archive + Phase A+B ablation; see editorial note at file head). Future revisions should retire these items. |
| **Forecast-Quality-Analyse (2026-05-28)** | reference | [`docs/FORECAST-QUALITY-ANALYSIS.md`](docs/FORECAST-QUALITY-ANALYSIS.md) — Ziel-Schwenk zu Prognose-Güte (xG-RMSE + Brier, ROI sekundär), xG-forecast-Scoring, Multi-Engine-Leaderboard + Blend-Dominanz, System-Scorecard (1X2 48.9% / xG-MAE 0.53 / BSS +5.9%), Confidence-Kalibrierung + selektive Vorhersage (≥65%→~73% cross-season), abgelehnte Ideen mit Gate-Resultaten, Diagnostics-Inventar, Dossier/Dashboard-Deliverables. **Kern: System ist guter kalibrierter Forecaster, schlägt aber Pinnacle nicht — Wert ist Prognose-Qualität, nicht Wett-Edge.** |
| **dev-09 D4 audit post-mortem (2026-05-28)** | canonical reference | [`docs/archive/dev-09-d4-audit-postmortem-2026-05-28.md`](docs/archive/dev-09-d4-audit-postmortem-2026-05-28.md) — verbatim FODZE Quant-Research / ML-Architektur / Risk Audit Committee assessment after D4 ARCHIVE verdict. Canonicalizes the 4 fatal flaws of the originally-proposed 25-feature `dev-09` build (multikollinearität / Frankenstein-hybrid · mathematically-impossible G5 at n=800+CI hurdle · `bottom_up_chain_diff` 77 % sparsity trap · dev-03 fallback contamination of Layer-3) and the corresponding binding revisions that were actually executed in the sprint. Includes cross-reference table mapping each error → its corrected implementation file → empirical verification point. **Read before proposing any future TABULA-RASA / hybrid-Macro+Micro architecture.** Core thesis: "Wir bauen keine hybriden Frankensteins. Wir respektieren die Gesetze der Varianz. Und wir tolerieren keinen Data-Bias." |
| **Lessons archive** | reference | [`docs/archive/areas-to-watch-2026-05.md`](docs/archive/areas-to-watch-2026-05.md) — dev-04/05/06/07/08 + line-movement + shrinkage archived experiments + per-sprint dev-03 deltas + one-time-infra builds. **Common patterns**: sparsity >80% = feature-dead-on-arrival; single-seed Brier-improvement < 1σ inter-seed variance = run-noise; higher-order-statistics on team-quality data are info-redundant with mean-features. **Empirical 1σ inter-seed Brier std (2026-05-27 measured): 0.000456 point-estimate · 95% CI [0.00027, 0.00131]** via 5-seed bootstrap (`tools/v4/diagnostics/dev03_multi_seed_bootstrap.{py,json}`). Earlier 0.002 heuristic was 1.5×–7.3× too pessimistic (depending on σ-CI bound — n=5 gives wide CI). Today's dev-03-fresh Δ=-0.0008 is **~1.75σ on the SAME-corpus inter-seed scale** — but cross-corpus signal vs prod is NOT cleanly testable with this bootstrap (production trained on 2026-05-22 corpus, fresh on 2026-05-27 corpus = +1,238 rows; bootstrap measures same-corpus seed variance only). Future retrains: use this empirical std-floor as a guide for "is this within noise" but with explicit awareness that cross-corpus comparisons need multi-seed runs on BOTH corpora to be statistically clean. |
| **Empirical signal-test methodology (2026-05-22)** | reference | When testing if a candidate feature adds signal beyond an existing model: (1) USE SIGNED RESIDUAL = `realized - predicted`, NOT squared-error. Squared-error conflates "feature correlates with outcome" with "feature adds signal beyond model" — both will show r>0 even when feature is fully captured by existing proxies. (2) AVOID POST-HOC LEAKAGE: Sofascore's `player_match_stats.rating` is computed AFTER the match (player-of-the-match score). Same-match ratings cannot be predictive features — must use rolling-N PRIOR-match ratings (chronologically before focal kickoff). Both v1 (squared-error) AND v2 (signed-residual + leakage) of Phase A starter-feature test showed r=0.6+ → all artifact. v3 (correct: signed-residual + rolling-prior) shows r~0.08 at aggregate, 0 per validated league → starter-features do NOT add signal beyond existing `lineup_quality_diff` proxy. Pattern now repeated 3× (Travel-Fatigue / Per-League-Iso / Starter-Features): empirical pre-step rejected what intuition suggested. **For FODZE engines, ~80% of "new feature" hypotheses are either redundant-proxy, test-artifact, or net-negative.** Highest-ROI move is multi-season retrain on existing schema, not new features. Diagnostic audit-trail: `tools/v4/diagnostics/starter_feature_signal_v{1,2,3}.json` + `gk_quality_signal.json`. |
| **5-Gate Falsification Protocol (2026-05-25)** | mandatory for new features | `tools/v4/utils/falsification_protocol.py` — reusable framework derived from week of 17 rejected hypotheses. **ANY new engine feature must pass all 5 gates before commit**: (G1) Brier-sign sanity check, code+output show same convention; (G2) Holm-Bonferroni adjustment across ALL hypotheses in same exploration round (not just the lucky one); (G3) Leakage audit (qcut/scaling/CV-fit on combined train+test = invalid); (G4) Power analysis using empirical std of per-match brier-diff — reject if n_observed < n_required for 80% power at corrected α; (G5) Flat-staking value-bet ROI simulation vs Pinnacle closing — require strictly positive ROI after vig. Canonical example: `tools/v4/diagnostics/lineup_aware_hard_audit.py` (week-of-2026-05-25 audit, killed sh_diff claim). **Empirical calibration**: 17 hypotheses tested in week → FWER 58.2%; best single-test result (sh_diff p_raw=0.012) → Holm-adj p=0.204 → NOT significant. Required n for Δ=0.001 at α=0.05/17: ≥ 832 matches. Pinnacle vig 2.5-3.0% → sustained Brier-Δ ≥ 0.005 needed for likely positive ROI. **Rejected hypothesis registry (week 2026-05-25)**: (1) FS Pre-Match xG-diff 1X2, p_resid=0.044 — market-eaten + Holm-killed; (2) FS Pre-Match PPG-diff 1X2, p=0.088 — not even nominally sig; (3) Player season-aggregate xa_diff, 94% backward-leakage at gate 1 lag-test; (4) Player season-aggregate xg_diff, p=1.0; (5) 8 other player-season-aggregate features, all p>0.05; (6) Lineup-aware sh_diff per-match starting-XI, p_raw=0.012 BUT Holm-adj 0.204 + n=380 underpowered + sim ROI -5.92% (worse than vig). **Strategic lesson**: FootyStats season-aggregates are wrong granularity (use per-match Understat instead); per-match lineup features need n>800 with single pre-registered hypothesis (no exploration). **Mandatory protocol from now on**: no new feature commit without passing 5-gate audit. |
| **dev-09 TABULA RASA bottom-up (2026-05-28)** | ARCHIVED — G2 PASS, G5 FAIL | 4-day sprint (Day-1 BottomUpCalculator → Day-4 ARCHIVE). Architecture: pure bottom-up Sofa-only player aggregates (8 features) + per-league Sofa-native Elo + rest_days + league categorical = 11 features. Trained on 22/23+23/24+24/25 → tested on 25/26 (audit-binding Phase 4.2 corpus, n=6,868 paired matches). **Brier outcome (TRUE H2H vs dev-03):** dev-09 0.6140 · dev-03 0.6207 · **Δ=-0.0067** (SHIP-CANDIDATE band, audit-binding). **G2 PASS:** paired t-test t=-3.14, p_raw=0.00167 < α/m=0.05/11=0.00455. **G5 FAIL:** flat-stake bet against Pinnacle 25/26 closing on 1,566 joined matches (canonical match_key bridge via `canonical_team_map`), 1,925 bets fired at edge>0pp, **ROI=-2.08%** vs Pinnacle vig 3.35% (need ROI > 2.5%). Repeated at edge>2pp (-0.91%) and edge>5pp (-1.56%) — all FAIL. **Mechanism: Brier improvement does NOT translate to profitable edge** — Pinnacle is sharper than dev-09 at picking sides in 1X2; dev-09's calibration advantage is concentrated in less-bet outcomes. Per-league ROI spread huge: EPL +16%, scottish_prem +90% (n=36), La Liga +6% (positive), bundesliga -23%, ligue_1 -25%, serie_b -26% (catastrophic). Per audit committee 2026-05-28 binding directive ("Bei Failure: Clean Archive + Lessons Learned"): **no TS port, dev-03 stays production default.** **Empirical inter-seed σ for dev-09 (n=5 bootstrap, Phase 4.2 corpus): 0.0007** — tighter than dev-03's 0.000456 by ratio 1.47×. **Bundesliga regression** (Day-3 concern flagged as "architectural weakness") was REVERSED in Phase 4.2 — BL Brier 0.5661 (best in Top-5!) with 24/25 included in training. Day-3's "regression" was a temporal-generalization artifact. **Key sprint discoveries (preserved for future TABULA-RASA attempts):** (a) `shots_total` column is 0% populated in local SQLite mirror → derive from `shots_on_target + shots_off_target + shots_blocked` at fit time; (b) Sofa emits only 4 position codes (M/D/F/G) — no DC/DMC/etc.; (c) 22/23 has 21.6% Top-5 lineup coverage (vs 99.9% in 23/24+) — orthogonal context (Elo+rest) makes Layer-3 rows usable; (d) per-league Elo isolation is FATAL architecture invariant — Day-3 shipped global Elo, Phase 4.1 fixed it; (e) `is_starter=1` in `sofascore_player_match_stats` returns exactly 11 starters/side reliably. **Files:** `tools/v4/modules/m3_xg/{bottom_up_features,feature_builder_dev09,sofa_context}.py` + `tools/v4/{train_dev09,pipeline/stage_1_dev09}.py` + `tools/v4/diagnostics/{dev09_leakage_audit,dev09_multi_seed_bootstrap,dev09_power_analysis,compare_dev03_vs_dev09,dev09_g5_directional_roi}.{py,json}` + `tools/v4/tests/test_{bottom_up_features,sofa_context}.py` + `tools/v4/artifacts/m3_xg-dev-09-phase42-seed-*.json`. **Pattern**: TABULA-RASA without macro context (Elo from `team_xg_history`, league constants, momentum) underperforms hybrid dev-03 architecture in market-betting context even when Brier improves. The audit committee's Tier-2 prediction ("ship-as-alternative as base case") proved optimistic — the actual outcome was Tier-4 (ARCHIVE) because G5 fails. |
| **StatsBomb open-data corpus (2026-05-26)** | validation-corpus only · not wired | 4.1 GB downloaded at `tools/statsbomb/data/` (1,431 matches, 8 competitions) + `tools/statsbomb/aggregates.csv` parsed (2,862 team-match rows × 34 features). **Coverage:** Top-5 leagues historic (Serie A 760, EPL 760, Bundesliga 680, La Liga 136, Ligue 1 64 team-match rows) + WC/Euro/CL. **NOT in our 22-league universe:** lower-tier (bundesliga2/championship/etc), tier-3 (liga3/league_one/league_two), regional (eredivisie/jupiler_pro/super_lig/etc). **Engine-wiring: 0** — no `src/` or `tools/v4/` reference imports the corpus. **xG-Audit performed 2026-05-26** (`tools/v4/diagnostics/statsbomb_xg_audit.{py,json}`): joined 179 rows across (bundesliga, la_liga, ligue_1) × (sofascore, understat). Findings: (a) consistent SB-vs-ours bias of **−0.090 xG/match** across both sources combined (sofascore-only −0.087, understat-only −0.098) → our public-xG models systematically over-estimate vs SB gold-standard; (b) RMSE 0.231-0.342 per (league, source) cell — directional drift but sample thin (n=48-68/cell); (c) **FS source 0-joined** despite 3,014 overlap rows because FS starts 2021-08 but SB la_liga/bundesliga/ligue_1 end ~2020 (date intersection ~44 days); (d) epl + serie_a not testable (0 SB rows in our overlap window). **Verdict**: validation-corpus only, NO recalibration. Isotonic+Benter blend (Phase 2.x) already absorbs systematic bias — that's its job. SB has 3 legitimate future uses: (1) backtest v3 against SB ground-truth xG for Top-5 historic, (2) augment isotonic-curve training set (+2,400 rows as anchor), (3) falsification-corpus for new xG-derived features (5-Gate compliant). **Do NOT use as direct engine training source** — 17/22 league coverage gap would inject Liga-Bias. Disk-cost ~4 GB is sunk; deletion candidate only after 6 weeks of zero use. |


---

## Bekannte Einschränkungen

- **Kein E2E-Testing** — nur Unit-Tests (React Testing Library nicht installiert)
- **Standalone-Seiten** (`/simulator`, `/sgp`, `/season-sim`) haben Inline-Engines die nicht `dixon-coles.ts` nutzen
- **`fuck-betting/page.tsx` (~1500 LOC)** — eigene Engine-Selection-Logik, nicht über MatchdayContext
- **Champions/Europa League**: Placeholder (wechselnde Teams, keine konsistente Kalibrierung) — deshalb nicht in `refresh-all.mjs` LEAGUE-Liste
- **Lineup-aware Predictions**: Design-doc in `docs/LINEUP-INTEGRATION.md`, nicht implementiert. (Sofascore-shotmap ist seit 2026-04-29 via curl_cffi durchgängig erreichbar — der frühere "blockt 403"-Eintrag ist obsolet. Lineup-Daten via Sofascore wäre ein nächster Backfill-Schritt.)
- **Team-Resolver**: Teams mit Auf-/Abstieg haben den letzten Eintrag als Default-Liga — ok für xG, Elo wird über League-Hint aufgelöst
- **Groq Daily-Quota**: 500K Tokens/day (8b model) — ein `refresh:full` ≈ 350K. Zweimal am Tag bricht mittendrin ab (sticky flag verhindert endlose Retries)
- **Transfermarkt-Scrape**: Empfindlich gegen 5+ parallele Prozesse → Prozess-Kill + sequenzieller Re-run hilft

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
                     "football-data.co.uk" — historisch (war STALE seit 2026-01-14
                       aber CSVs sind seit ~Apr 2026 wieder up-to-date — verified
                       2026-05-21 nach Re-backfill 22/23-25/26)
                     "live-odds-snapshot" — NEU 2026-04-26: snapshot-closing-odds.mjs
                       Cron persistiert hier zusätzlich für Forward-CLV-Recovery
                     UNIQUE (match_key). Cols: psch/pscd/psca/psc_over25/psc_under25/
                       pscahh/pscaha/ah_line/ft_result/ft_goals_h/ft_goals_a
                     Plus psh/psd/psa (NEU 2026-05-21 via add_pinnacle_opening_odds
                       migration): Pinnacle PRE-MATCH (early-week, ~Tuesday) odds für
                       drift-feature engineering. 99%+ coverage über 22/23-25/26 ×
                       16 Ligen via scripts/backfill-football-data-co-uk.mjs. Range-
                       CHECK > 1.0. Drift = vig_removed(close) - vig_removed(open).
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
referees           — ⛔ DROPPED 2026-05-28. Was 354 rows stub-data (fouls_per_game
                     all NULL). Ingest scripts in scripts/_archive/ (scrape-
                     referees.mjs, import-wfr-csvs.mjs, migration-referees.sql).
                     matchday-enrich.mjs has 404-graceful read fallback;
                     refresh-all.mjs `--referees` phase removed.
stadiums           — ⛔ DROPPED 2026-05-28. Was 278 rows (30% join coverage,
                     altitude_m 0% populated). Ingest scripts in scripts/_archive/
                     (scrape-stadiums.mjs, migration-stadiums.sql). matchday-
                     enrich.mjs has 404-graceful read fallback.
player_xg_history  — Per-Player xG-per-90/xa/npxg/key_passes (2500 rows, Top-5 only).
                     Wird für xGChain-Hydration in MatchdayContext.tsx bei TM-Injuries
                     genutzt (Phase 2.3 wired).
player_season_stats — ⛔ DROPPED 2026-05-28. Was 34.216 player-season rows (FS CSV
                     import). Engine-rejected: 94% backward-leakage in season-aggregate
                     features per fs_player_causal_gates.py audit. Ingest +
                     migration in scripts/_archive/. Original schema (for archaeology):
                     34.216 player-season rows,
                     16 lower-tier leagues × 5 seasons (21/22 → 25/26). 45 Spalten:
                     identity (full_name/position/age/nationality/current_club),
                     volume (minutes/appearances/games_started/subs), production
                     (goals/assists/xg_total/xg_per_90/npxg_total/xa_total/key_passes),
                     defensive (tackles_successful/interceptions/blocks/clearances/
                     duels_won), GK (saves/clean_sheets/conceded/save_percentage —
                     xg_faced_total ist N/A in lower-tier, only Top-5), discipline
                     (yellows/reds/fouls/penalties), value (market_value_eur,
                     annual_salary_eur, average_rating, man_of_the_match).
                     UNIQUE (league, season, full_name, current_club). 4 Indexes incl.
                     partial filter WHERE minutes_played >= 90. RLS: anon SELECT,
                     service_role ALL. Importer: `scripts/import-footystats-players.mjs`,
                     migration: `scripts/migration-player-season-stats.sql`.
                     Schließt Engine-Feature-Gap für lineup_quality + market_value-
                     proxy in lower-tier (Understat deckt nur Top-5 ab). liga3 xG nur
                     ab 24/25 sinnvoll populiert (FS started tracking late).
match_prematch_signals — ⛔ DROPPED 2026-05-28. Was 38.696 rows (FS CSV value-adds).
                     Engine-rejected: r_resid=0.02 for 1X2 (market-eaten + Holm-killed)
                     per fs_prematch_signal_test.py audit. Ingest scripts +
                     migration in scripts/_archive/. Original schema (for archaeology):
                     38.696 rows,
                     22 ligas × 5 seasons. Captures: home/away_prematch_ppg +
                     home/away_prematch_xg (FS-Model pre-match xG-Forecast,
                     3rd xG source neben Sofa shotmap + Understat) + prematch_btts/
                     o15/o25/o35/o45_pct (FS pre-match % forecasts) + avg_corners/
                     avg_cards + attendance + stadium. **+ 9 bookmaker_odds_*
                     columns (added 2026-05-25 evening migration `add_bookmaker_
                     odds_to_match_prematch_signals`)**: bookmaker_odds_home/draw/
                     away + over15/25/35/45 + btts_yes/no + bookmaker_source.
                     99.8% populated from FS CSVs (NOT Pinnacle-sharp — use only
                     as PROXY market baseline for Goals/BTTS falsification testing
                     until live-snapshot accumulates Pinnacle psc_over25 going
                     forward). UNIQUE (league, match_date, home_team, away_team) +
                     canonical `match_key` für joins gegen bets/odds_closing_history.
                     Importers: `scripts/import-footystats-valueadds.mjs` (initial
                     value-adds) + `scripts/import-footystats-bookmaker-odds.mjs`
                     (odds backfill). Migration: `scripts/migration-match-prematch-
                     signals.sql`. Caveat: Game Week 1 jeder Saison hat zeros (kein
                     prior — "no data" not 0%). avg_home_xg systematisch fallend
                     21/22→24/25 alle Ligen — wenn als Feature: per-Liga × Saison
                     normalisieren.
sofascore_lineups_cache — NEU 2026-05-25 (lokal-only SQLite, NOT Supabase).
                     Cache für Sofa /lineups endpoint von UPCOMING matches.
                     Schema: game_id PRIMARY KEY · fetched_at · kickoff_unix ·
                     league · home/away_team · home/away_formation ·
                     home/away_starters (JSON array of player names) · confirmed
                     boolean · raw_json. Fetcher: `tools/sofascore/fetch_upcoming_
                     lineups.py` (reuses Webshare proxy infra). Exports
                     `tools/sofascore/data/lineups_upcoming.json` for engine reads.
                     MVP: code functional, runtime pending (a) fresh Sofa schedule
                     data in local sofascore_match table, (b) Webshare proxy pool
                     recovery from current CF-burn. Future-enables lineup-aware
                     engine features (per docs/LINEUP-INTEGRATION.md).
live_wp_snapshots  — ⚠ EMPTY (0 rows). Phase 3.3 dormant — braucht Betfair-API-Key.
corners_odds_history — ⚠ EMPTY (0 rows). Phase 3.1 dormant — braucht UI-Tab.
player_props_posteriors — ⚠ EMPTY (0 rows). Phase 3.2 dormant — braucht R-service.
epistemic_trails   — v1.1 Asymmetric Negation Protocol per-trap firings. Migration
                     `scripts/migration-epistemic-trails.sql` applied 2026-05-20.
                     Cols: id BIGSERIAL, trap_kind, match_key (canonical FODZE format),
                     match_kickoff BIGINT (Unix epoch SECONDS), league, detected_at
                     BIGINT (Unix epoch MILLISECONDS), raw_signals JSONB (numeric-only
                     by design), predicted_hw_rate NUMERIC CHECK [0,1], shadow BOOLEAN.
                     CLV-tracking cols (filled by clv-trap-decay cron): closing_odds
                     NUMERIC CHECK >1.0, moved_against_us BOOLEAN, clv_resolved_at
                     BIGINT (ms). UNIQUE (trap_kind, match_key, detected_at) —
                     sub-second granularity intentional für Re-emission-Audit-History.
                     6 indexes: PK + UNIQUE + 2 simple btree (match_key, kickoff) +
                     1 partial (unresolved WHERE clv_resolved_at IS NULL) + 1 composite
                     (trap_kind, shadow). RLS: anon SELECT, service_role ALL. Schreiber:
                     `/api/persist-trails` route (proxy für `src/lib/epistemic-trails.ts
                     ::persistEpistemicTrails`), aufgerufen von `/goldilocks/page.tsx`
                     beim Page-Load. Reader: burn-in + clv-decay crons.
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
| **Conformal Gate (Phase 2.5)** | **warn (flip-to-enforce now UNBLOCKED after 2026-05-28 refit)** | `public/conformal-quantiles.json` (trained 2026-05-28 on 25/26 OOT n=6,525) | Empirische Coverage 18/18 leagues \|drift\| ≤ 5pp on fresh fit. EPL +1.36% (was -8.50%). Aggregate α=0.05 = +0.19%. Mode kann jetzt produktiv geflipped werden via `NEXT_PUBLIC_CONFORMAL_GATE=enforce`. Refit chain: `tools/backtest/refit-all.sh`. |
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

### v1.1 Asymmetric Negation Protocol (Stand 2026-05-20)

**Filter-as-Shield, kein Booster** — die Cartographie aus dem Epistemic-Audit war v1.0 ein additiver-Edge-Hunter und scheiterte an 4 fatalen Pathologien (akademische Brier-Gain-Jagd, parametrische Halluzinationen, MNAR selection traps, intra-matchday look-ahead bias). v1.1 abandoned die Suche nach additiven Mikro-Edges und nutzt die Cartographie als **Minen-Detektor** für harte Kelly-Haircuts auf toxischen Mispricings. Acht Mandate:

- **M1 Elastic-Net Shrinkage** — `tools/v4/train_pipeline.py` mit explizitem `lambda_l1: 0.5` + `lambda_l2: 1.0` in LightGBM-Tweedie params (kein manual 0.5-sign-flip-Heuristik mehr).
- **M2 SHADOW_LOG_ONLY Quarantine** — `TACTICAL_WIDTH` + `MANAGER_BOUNCE_RAW` Set in `goldilocks-engine.ts`. Trails werden geloggt mit `shadow: true` aber **modifizieren `stakeMultiplier` NICHT**. 200-Match-Burn-in enforced durch `scripts/burn-in-shadow-signals.mjs` weekly cron.
- **M3 Trees+SHAP über linear interactions** — `discover_manifolds(model, X_sample, max_rows=1500)` in train_pipeline.py mit hartem Stratified-Sample-Bound (SHAP interaction values sind O(T·D·L²) — full set würde memory blowup auslösen).
- **M4 Kein parametrischer Gaussian** — `managerBounceMultiplier(matchesSince)` ist eine piecewise-step-Funktion: [0-1] → 0.85 (immediate shake-up noise), [2-3] → 0.92 (honeymoon-fade), >3 → 1.0 (settled). Plus pygam Penalized-B-Splines in train_pipeline.py (`fit_manager_bounce_gam` mit GCV gridsearch).
- **M5 Heckman MNAR Gate** — `POSSESSION_TRAP` feuert nur in `TIER_A_COVERAGE` Ligen (12 Ligen mit >95% Possession-Coverage). Gates: `possessionDiff > 15 AND xgDiffEwma3 < 0 AND xgEwma3 < leagueBaselineXg * 0.85`. Brentford-style toxic-dominance pattern (-19.8pp deviation from engine HW-rate in audit).
- **M6 Strict 4h Timestamping** — `tools/v4/queries/strict_lagging.sql` CTE mit `prev.start_timestamp <= cur.start_timestamp - 14400` (4h cutoff). Verhindert intra-matchday-leakage (15:30 → 18:30 same day). Verified 12.576 rows / minimum 122.5h gap auf local SQLite.
- **M7 Asymmetric Negation** — `stakeMultiplier ∈ [0, 1.0]` hard-clamped am Ende von `evaluateLatentTopology`. Vetoes stacken zur MINIMUM (nicht Sum, nicht Product). Garantiert: kein Boost-Pfad existiert.
- **M8 CLV-Reflexivity Tracking** — `epistemic_trails` Tabelle + `scripts/clv-trap-decay.mjs` daily cron. Bei convergence-rate ≈ 50% (sharp markets haben unsere Edge eingepreist) → DEPRECATE-Recommendation. Bei <30% → trap ist noch alpha.

**Data-Flow:**
```
/goldilocks/page.tsx (client)
  ├─ pro Match: synthetisiere LatentSignals aus team_xg_history
  │   (possession EWMA mit minSamples=3, xG-EWMA(3) span=3)
  ├─ evaluateLatentTopology(matchAug, signals) → LatentTopology
  ├─ Display: Veto-Badges + Kelly × Multiplier + "Veto-frei" filter
  └─ POST /api/persist-trails (batched, idempotent)
        ↓
      epistemic_trails (Supabase, RLS service-only write)
        ↓
  ├─ scripts/burn-in-shadow-signals.mjs (weekly)
  │   └─ joined match_outcomes → GRADUATE/KEEP_SHADOW/INVERT_SIGNAL
  └─ scripts/clv-trap-decay.mjs (daily, nach snapshot-closing-odds)
      └─ joined odds_closing_history → MARKET_CONVERGED/TRAP_ALIVE/CONVERGING
```

**Persistence-Contract (kritisch):**
- `match_key` MUSS `canonicalMatchKey(league, home, away)` aus `src/lib/format.ts` sein. Custom-Format würde den CLV-decay-join × `odds_closing_history.match_key` stumm scheitern lassen.
- `match_kickoff` MUSS Unix epoch SECONDS sein. Cron filtert via `match_kickoff < now/1000` — ms-shaped values würden 1000× in die Zukunft schießen und nie als "past kickoff" qualifizieren.
- `detected_at` MUSS Unix epoch MILLISECONDS sein. Teil von UNIQUE constraint mit sub-second-Granularität für Re-emission-Audit-History.
- DB CHECK constraints enforcement: `predicted_hw_rate ∈ [0, 1]`, `closing_odds > 1.0 OR NULL`.

**Engine-Hierarchy-Position:** v1.1 ist EIN POST-PROCESSING-LAYER auf der bestehenden Engine-Output. Die Engines (Standard, v1, v2, v3) sind UNVERÄNDERT. Topology-Output ist optional und betrifft nur Goldilocks-UI (nicht direkte Engine-Predictions auf `/matchday`).

**Testing:** 47 vitest cases zwischen `tests/asymmetric-negation.test.ts` (25 — incl. persistence-contract: matchKey canonical, kickoff seconds, detectedAt ms) + `tests/trail-aggregations.test.ts` (26 — pure-function-layer für beide Crons mit dedupe semantics, vig-removal edge-cases, alle 4 recommendations, alle 4 status pills).

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

### Live Engine Performance (Stand 2026-05-03, n=104 Spiele)

Erste belastbare cross-league Auswertung seit Live-Tracking startete (2026-04-21):

| Engine | App-Name | 1X2 Hit | Brier | High-Conf (>60%) Hit | O25 Hit |
|---|---|---|---|---|---|
| **poisson-ml** | **@annafrick13 v1** | **49.0%** 🥇 | 0.6745 | 58.3% (n=36) | 55.8% |
| **ensemble** | **Standard** | 42.3% | **0.6293** 🥇 | **61.1%** (n=18) | **63.5%** 🥇 |
| poisson-ml-v2 | @annafrick13 v2 | 42.3% | 0.7012 | 44.4% (n=27) ⚠ | 56.7% |
| poisson-ml-v3 | @annafrick13 v3 | 38.5% (n=13) | 0.6826 | — | 53.8% |

**Pro-Liga Sieger (best-covered Liga = Bundesliga, n=62):**
- @annafrick13 v1 → **50%** Hit-Rate ← klar Sieger
- Standard, v2: je 42%
- v3: 33% (preview-only, kleine sample)

**Konfidenz-Band-Kalibration (entscheidet wann Engine vertrauenswürdig ist):**

| Band | Engine | Hit-Rate vs Claim | Empfehlung |
|---|---|---|---|
| **60-70%** | @anna v1 | **68% Hit** vs 64% claimed | 🟢 **Gold-Zone** — perfekt kalibriert |
| **70%+** | @anna v1 | **47% Hit** vs 80% claimed | 🔴 **Trap-Zone** — Over-Confidence |
| 60-70% | Standard | 61% Hit vs 65% claimed | 🟢 solide |
| **60-70%** | @anna v2 | **42% Hit** vs 65% claimed | 🔴 Trap-Zone — Over-Confidence |
| 50-60% | Standard | 65% Hit vs 56% claimed | 🟢 schlägt eigene Erwartung |

**Implikation für Goldilocks-Filter:**
- Live-data bestätigt: **@annafrick13 v1 in 60-70% Conf-Band ist das robusteste Single-Signal**
- Multi-Engine-Konsens (alle 4 in gleicher Richtung) wäre das stärkste Signal — der Konsens-Filter in `/goldilocks` (commit `bfef197` 2026-05-02 fix) operationalisiert das
- v2 wirkt cross-league über-confident — speziell im 50-70% Band 23-42% Hit gegen 55-65% Claim. Nur in BL (specialist league) ist v2 stark (siehe `ExakterTag/` exact-score Audit: 16.2% exact-score = best)

Sample n=104 ist mager. ±5pp Differenzen statistisch noch nicht hart abgesichert (würde n>300 brauchen). **Trends sind directional aber nicht final.**

---

## Admin Workflow — Weekly Update

**Automatisch (empfohlen):**
```bash
bash scripts/launchd/install.sh   # macOS LaunchAgents einmal installieren
# Ab jetzt:
#   täglich 07:30   → refresh-all.mjs --skip-odds         (matchday-regen)
#   Di + Fr 19:00   → refresh-all.mjs --injuries --skip-odds  (full + TM-injuries)
# Odds-Refresh läuft separat via GitHub Actions fetch-odds.yml
# (Sun/Wed/Fri/Sat 06:17 + 18:17 UTC). Reduced from 4h to 12h on 2026-05-21
# wegen Odds-API Budget — siehe Areas-to-Watch "Odds-API budget posture".
```

**Cron architecture invariant (post-2026-05-21):**
- GitHub Actions `fetch-odds.yml` ist der EINZIGE Odds-Refresh-Owner.
- launchd ist der EINZIGE Matchday-Regen + Injuries-Owner.
- Beide Jobs sind idempotent + skipping-safe (each can fail without breaking the other).

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

**Nach dev-03-Retrain:** Die TS-Runtime-Artifacts (`public/dev03-model.json` + `public/dev03-feature-cache.json` + `tests/fixtures/dev03-features-golden.json`) sind alle Snapshot-Outputs der frischen Pickles in `tools/v4/artifacts/`. Sie MÜSSEN alle drei in der gleichen Sprint-Iteration neu generiert werden, sonst driftet die TS-Inference von Python's Reference:

```bash
# 1. Train m3_xg LightGBM Bayesian ensemble (REQUIRED: --features-locked
#    for production-target retrains — constrains schema to 16 numeric + league
#    = 17 total, matching FEATURES_LOCKED in export_dev03_to_json.py. Without
#    this flag, train script emits 21-feature pickle that fails refit gate.)
tools/venv/bin/python3 -I tools/v4/train_m3_xg.py \
  --features-locked --since 2022-07-01 --cutoff 2025-08-01 --tag dev-03

# 2. Fit per-Liga Benter β weights against fresh m3 predictions
tools/venv/bin/python3 -I tools/v4/fit_benter.py --tag dev-03 --m3-tag dev-03

# 3. Sanity-check on 25/26 holdout (Stage-1 G1 ship-gate: Brier ≤ v2_benter + 0.005)
tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m3_xg.py --tag dev-03

# 4. Refit ALL three TS artifacts + golden tests atomically
bash tools/v4/refit-dev03-artifacts.sh   # reihenfolge-kritisch:
                                          # export_dev03_to_json → export_feature_cache
                                          # → generate_dev03_features_golden → vitest parity
# --skip-golden wenn nur ein deploy braucht aber keine Tests-Verify-Pass

git diff public/dev03-*.json tests/fixtures/dev03-*.json
git commit -am 'chore(dev03): refit artifacts after retrain'
```

Die `refit-dev03-artifacts.sh` exit codes: 0 = alles ok, 1 = pickles fehlen (retrain erst), 3 = parity-tests failed (Artifacts geschrieben aber TS-Port driftet — review nötig). **Wichtig:** `export_feature_cache.py` läuft AUCH wöchentlich via `refresh:full` Phase `dev03-cache` (independent vom Retrain), damit Elo + Momentum-Snapshots sich nicht zu sehr von der Realität entfernen. Der Retrain-Hook regeneriert es zusätzlich um sicherzustellen dass Cache + Model in der gleichen training-cutoff Reality leben.

**Decision-gate für production-swap nach Retrain (UPDATED 2026-05-27 mit empirischer Anker):** Stage-1 Brier-Δ vs current production should be > 2σ_empirical (~0.0009 under today's measured σ=0.000456) for unambiguous ship-worthy signal. Δ < 1σ (~0.0005) = noise → archive. 1σ < Δ < 2σ = **borderline** → require multi-seed bootstrap on BOTH corpora before deciding (the bootstrap-on-fresh-only doesn't cleanly test cross-corpus signal). Today's path (2026-05-27): Δ -0.0008 sat at 1.75σ on same-corpus scale → borderline; bilateral bootstrap not run; conservative archive decision held. Old 0.002 threshold (which was the call-criterion this morning) was based on the CLAUDE.md heuristic that this session showed was 1.5×–7.3× too pessimistic. Future retrains use the empirical anchor.

---

## AI-Integration

Priority: `GROQ_API_KEY` (free) → `CLAUDE_API_KEY` (paid) → Offline (Templates)

- **Groq Llama 3.3 70B**: Ask Anna streaming SSE
- **Groq Llama 3.1 8b-instant**: Transfermarkt HTML→JSON normalisation (500K tokens/day free)
- **Claude Sonnet 4**: Ask Anna alternative (paid), `/api/matchday` AI-enrichment mit web_search
- **Offline**: `generateOfflineAnalysis()` in `anna/page.tsx` — rein aus berechneten Daten

---

## Zusätzliche Docs

- `docs/DATAPOINTS-OVERVIEW.md` — **Vollständige color-coded Engine×Datapoint Matrix** (Stand 2026-05-10). Mapping aller Datenpunkte zu Standard / v1 / v2 / v3 / Calibration / Backtest / UI mit Liga-Coverage. **Lese ZUERST bei Engine-Feature-Fragen** — zeigt sofort welche Daten von welcher Engine konsumiert werden.
- `docs/DATA-INVENTORY.md` — **Detailiertes Inventar aller Datenquellen** (Sofascore, FootyStats, Understat, football-data.co.uk, OpenLigaDB, Transfermarkt, TheSportsDB, api-sports). Per-Liga × Saison Coverage-Matrix für alle 22 Ligen mit row counts, date ranges, source breakdowns. Komplementär zu DATAPOINTS-OVERVIEW (eher Source-Catalog vs Engine-Mapping).
- `docs/ALPHA-ATLAS-IMPLEMENTATION.md` — **Master-Runbook der 13 Research-Phasen** (Referee / Benter / Dirichlet / footBayes / Conformal / Corners / Player-Props / Live-WP). Enthält Bootstrap-Reihenfolge, per-Phase Ops-Anweisungen, Feature-Flags, File-Inventory und Known Gaps. **Einstiegspunkt für alle Post-Baseline-Features.**
- `docs/ARCHITECTURE.md` — tiefer Architektur-Überblick
- `docs/DEBUGGING.md` — Operationaler Runbook (Symptom → Diagnose → Fix)
- `docs/ENGINE.md` — Engine-Internals, Training, Backtest-Methodik
- `docs/HANDBUCH.md` — End-User Handbuch (auch als `/handbuch` In-App)
- `docs/LINEUP-INTEGRATION.md` — Design für Lineup-aware Predictions (nicht implementiert)
- `docs/DESIGN-HANDOFF.md` — Design-System-Spec
- `docs/BRAND-VOICE.md` — Brand-Voice Guide: 5 Attribute, Tone-Spektrum nach Kontext, Terminologie (Edge/Modell/Spieltag/Sharp), Before/After-Beispiele. Ankern für UI-Copy, Release-Notes, Anna-Prompts, Marketing-Assets.

## Alpha-Atlas Status (Post-Baseline-Features)

Die 13 Phasen aus dem Alpha-Atlas-Plan sind **code-complete** (`docs/ALPHA-ATLAS-IMPLEMENTATION.md`). Alle Runtime-Module sind wired aber **default-off** — pre-upgrade Output bleibt bit-identisch bis Feature-Flags geflippt werden. Outstanding Ops: 9 Migrations applyen, 6 Backfill-Scraper laufen lassen, 3 Python-Fits (Benter/Dirichlet/Conformal) trainieren, 2 R-Services deployen, UI-Tabs für Corners + Player-Props. **893 Tests passing, 0 TS-Errors (Stand 2026-05-29).**

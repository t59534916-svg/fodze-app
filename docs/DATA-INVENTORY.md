# DATA-INVENTORY.md

**Stand:** 2026-05-03 (mit Update-Note 2026-05-05 unten) · **Quelle:** Live-query gegen Supabase project `oddsmind` (resdrxgfcpaxosiwnxiu)

Vollständiges Inventar aller Datenquellen, deren Coverage pro Liga × Saison, und Quality-Status. Diese Datei ist von Hand kuratiert basierend auf Live-DB-counts — bei Diskrepanzen mit der Realität ist die DB-Live-Query autoritativ. Zum Refresh: `node scripts/audit-data-quality.mjs` (für Hauptmetriken) bzw. die in dieser Doku unten verlinkten ad-hoc Audit-Scripts.

> **Update 2026-05-05:** Cloudflare hat die 5 vorher geblockten Tier-B-Ligen freigegeben — austria_bl, swiss_sl, scottish_prem, jupiler_pro, super_lig wurden mit `--pace 4.0` sequenziell nachgezogen (181/218/222/315/240 matches respectively, alle 99%+ xG-fill, alle premium-tier). Damit haben jetzt **alle 22 FODZE-Ligen** eine Sofascore-Tier-Klassifikation (16 premium, 1 partial, 5 volume). Plus: neues Skript `scripts/bridge-sofascore-to-team-xg.mjs` propagiert sofascore_team_chance_quality → team_xg_history mit `source='sofascore'` (~10k rows × 17 ligen). Konkrete Auswirkung: per-Liga-Zahlen in Sektion 4 sind nicht mehr aktuell (austria_bl/swiss_sl/scottish_prem/jupiler_pro/super_lig hatten "0 matches" Sofa, jetzt 4-7k shots each); die 5.2 "Bekannte Gaps" Tabelle weiter unten reflektiert den neuen State.

---

## 1. Tabellen-Übersicht

### Aktive Tabellen (mit production-data)

| Tabelle | Rows | Zweck |
|---|---|---|
| `team_xg_history` | 85.510 | Per-Match xG-Historie (mixed sources) — primärer Modell-Input |
| `sofascore_shotmap` | 141.315 | Per-shot events (xG, situation, body_part) seit 2026-04-29 |
| `sofascore_team_chance_quality` (view) | 11.149 | Per-team-per-game chance-quality aggregates |
| `odds_closing_history` | 24.753 | Pinnacle closing odds historisch + forward-cache |
| `pipeline_shadow_log` | 3.441 | Per-engine predictions (4 engines) für post-hoc Brier-Vergleich |
| `match_outcomes` | 2.618 | Predictions×reality bridge (settled matches) |
| `match_predictions` | 1.062 | Pre-match snapshot per engine (mit lambda + sharp odds) |
| `player_xg_history` | 2.500 | Per-player xG/xa/npxg/key_passes — Top-5 Ligen only |
| `sofascore_match` | 5.720 | Match metadata (game_id, teams, scores, kickoff) |
| `team_metadata` | 430 | Team-Logos + thesportsdb_id + api_sports_id |
| `referees` | 354 | ⚠ STUB DATA — fouls_per_game alle NULL |
| `sofascore_team_rolling_8` (view) | 336 | Last-8-games per team — engine-input shape |
| `sofascore_standings` (view) | 336 | Live league table aus Sofascore |
| `stadiums` | 278 | Lat/Lng/capacity (30% join coverage, marginal value) |
| `live_odds` | 202 | Live odds (sharp + best, refreshed alle 4h) |
| `upcoming_fixtures` | 202 | Fixtures mit kickoff (1:1 mit live_odds) |
| `live_brier_snapshots` | 27 | Cron-aggregierte Live-Brier per engine × league |
| `matchdays` | 492 | Spieltag-JSON snapshots (per Liga, JSONB) |
| `bets` | 3 | User-Bets (klein — wenig usage so far) |
| `profiles` | 4 | User-Profile (Bankroll, risk_profile) |
| `odds_snapshots` | 3 | Manual snapshots — kein Auto-Cron |

### Empty Tabellen (dormant — Schema existiert, no data)

| Tabelle | Rows | Status |
|---|---|---|
| `player_injuries` | 0 | api-sports Key 2 suspended; TM-injuries werden direkt in `matchdays.data.matches[].injuries` embedded |
| `live_wp_snapshots` | 0 | Phase 3.3 dormant — braucht Betfair-API-Key |
| `corners_odds_history` | 0 | Phase 3.1 dormant — braucht UI-Tab |
| `player_props_posteriors` | 0 | Phase 3.2 dormant — braucht R-service |

---

## 2. Daten-Quellen (Source-Catalog)

### 2.1 `team_xg_history` — Multi-Source xG-Aggregat

**Source-Mix** (Anteile am 85.510-Row-Korpus):

| Source | Definition | Coverage | Quality |
|---|---|---|---|
| `footystats` | FootyStats API CSV-Import (manueller Weekly-Pull) | ~63.000 rows, 22 Ligen, 2021/22-2025/26 | Real xG, alle Spalten, primäre Quelle |
| `understat` | Browser-script (`scripts/seed-understat-2526.mjs`) | ~13.300 rows, 5 Top-Ligen, 2017/18-2025/26 | Real xG (höchste Qualität), volle Saison-Tiefe |
| `goals-proxy` | OpenLigaDB (`scripts/backfill-liga3-openligadb.mjs`) | ~3.832 rows, BL/BL2/Liga3 | Goals als xG-Proxy (kein echter xG-Wert), idempotent daily cron |
| `shots-model-pooled` | football-data.co.uk shots → liga-spezifisches Modell | ~6.711 rows, 11 Ligen | Modellierte xG aus Shot-Counts, als Fallback wo kein direkter xG |
| `shots-model` | Top-5 specific shots-model (la_liga, ligue_1, eredivisie, super_lig) | 396 rows | Wie pooled, aber per-Liga calibriert |
| `api-sports` | api-sports.io v3 — `scripts/fetch-api-sports-stats.mjs` | 7 rows (defensive — Key 2 suspended) | Real xG für Saisons 2022-2024, no current season (free-tier limit) |

**Date-Range global:** 2017-08-04 (frühestes Understat) → 2026-05-02 (heute morgen)

**Per-Liga Source-Breakdown:** siehe Sektion 4 weiter unten.

**Schema-Spalten:** `team`, `opponent`, `league`, `venue` (home/away), `match_date`, `xg`, `xga`, `goals_for`, `goals_against`, `shots_for`, `shots_against`, `corners_for`, `corners_against`, `source`. UNIQUE constraint: `(team, league, match_date, venue)`.

**Canonicalization-Regel (kritisch, seit 2026-04-27):** alle Schreibwege MÜSSEN `scripts/_lib/canonical-team.mjs::canonicalize(team, league)` aufrufen. 14 active write-scripts patched. Read-side mirror: `src/lib/team-resolver.ts::canonicalizeTeamName`.

---

### 2.2 Sofascore Pipeline (NEU 2026-04-29, Tier-B-erweitert 2026-05-03)

**Datenquelle:** [`datafc`](https://pypi.org/project/datafc/) Python-Paket (curl_cffi mit Chrome 124 TLS-Fingerprint, kein Browser nötig). Sync via `scripts/sync-sofascore-shotmap.mjs` als Phase 4 von `refresh-all.mjs`.

#### 2.2.1 `sofascore_shotmap` (Raw-Tabelle, 141.315 rows)

**Pro Shot:** xG, xGOT, body_part (left-foot/right-foot/head), situation (assisted/corner/fast-break/penalty/regular/free-kick/set-piece/throw-in-set-piece), shot_type (goal/save/miss/block/post), goal_type, goal_mouth_location, shooter coords (x, y), goal_mouth coords (x, y, z), minute, time_seconds.

#### 2.2.2 `sofascore_match` (5.720 rows)

Match-Metadata: game_id, league, season, week, home_team + home_team_id, away_team + away_team_id, home_score, away_score, start_timestamp, status, inserted_at.

#### 2.2.3 `sofascore_team_chance_quality` (View, 11.149 rows)

Per-team-per-game aggregate aus shotmap: `shots`, `goals`, `shots_in_box`, `shots_on_target`, `sum_xg`, `sum_xgot`, `mean_shot_xg`, `mean_shot_xgot_on_target`, `setpiece_xg_share`, `penalty_xg_share`, `openplay_xg`, `big_chance_share` (% shots mit xG > 0.3), `fastbreak_xg`, `header_share`. Plus `data_quality_tier` aus SQL-Funktion.

#### 2.2.4 `sofascore_team_rolling_8` (View, 336 rows = 22 teams × ~15 leagues)

Last-8-games Rolling per team, engine-input shape: `games_in_window`, `avg_shots`, `avg_shots_in_box`, `avg_shots_on_target`, `avg_goals`, `avg_sum_xg`, `avg_sum_xgot`, `avg_mean_shot_xg`, `avg_setpiece_xg_share`, `avg_big_chance_share`, `avg_header_share`, `avg_openplay_xg`, `avg_fastbreak_xg`.

#### 2.2.5 `sofascore_standings` (View, 336 rows)

Live league table: position, played, wins, draws, losses, gf, ga, gd, points.

#### 2.2.6 Tier-Klassifikation (`sofascore_data_quality_tier(league)` SQL function)

Aktuell-applied 2026-05-03:

| Tier | Bedeutung | Ligen |
|---|---|---|
| **premium** (11) | Voll xG (>99% fill) + alle situation tags inkl. assisted/fast-break | bundesliga, bundesliga2, championship, epl, eredivisie, greek_sl, la_liga, ligue_1, primeira_liga, serie_a, serie_b |
| **partial** (1) | Voll xG, ABER ohne assisted/fast-break tags | liga3 |
| **volume** (5) | Shot-events vorhanden, KEIN xG (Sofascore-Upstream-Limit) | eerste_divisie, la_liga2, league_one, league_two, ligue_2 |
| **n/a / no data** (5) | Cloudflare-block 2026-05-03, season-list HTTP 403 | jupiler_pro, super_lig, scottish_prem, austria_bl, swiss_sl |

**Saison-Coverage:** ausschließlich 25/26 (alle 17 covered leagues). Kein Backfill für historische Saisons (Sofascore-API erlaubt nur aktive Season abzufragen).

---

### 2.3 `odds_closing_history` — Pinnacle Closing Odds

**24.753 rows** von 2020-08-01 bis 2026-05-03. Zwei Quellen:

| Source | Rows | Status |
|---|---|---|
| `football-data.co.uk` | ~24.681 | ⚠ STALE seit 2026-01-14 — football-data.co.uk hat aufgehört Pinnacle-closing-Spalten (PSCH/PSCD/PSCA) zu publizieren. Historische Korpus für Backtest bleibt brauchbar. |
| `live-odds-snapshot` | ~70 | NEU 2026-04-26 — `scripts/snapshot-closing-odds.mjs` schreibt forward-cache für ALLE in-window matches (innerhalb 2h vor Kickoff), egal ob User-Bet existiert. Going-forward CLV-Quelle. |

**Spalten:** `match_key`, `match_date`, league, home/away, `psch`/`pscd`/`psca` (Pinnacle 1X2), `psc_over25`/`psc_under25`, `pscahh`/`pscaha` (asian handicap), `ah_line`, `ft_result`, `ft_goals_h`/`ft_goals_a`. UNIQUE: `match_key`. Last-write-wins.

**Per-Liga Coverage:** siehe Sektion 4. Notable gaps: liga3 (6 rows nur seit 2026-05-02), league_one + league_two + eerste_divisie (0 rows — football-data.co.uk hat sie nie geliefert).

---

### 2.4 `live_odds` + `upcoming_fixtures` — Live-Quoten Cache

**The-Odds-API** (free-tier 500 credits/month, multi-key rotation seit `bfef197` — N×500 effective monthly budget). Cron via `scripts/fetch-odds.mjs` alle 4h (Fr-So + Mi).

**202 rows** in `live_odds` = aktuelle in-window matches. 1:1 Mapping zu `upcoming_fixtures` (gleiche 202 rows, beide aus demselben Fetch).

**Schema:** `sharp_h`/`sharp_d`/`sharp_a` (Pinnacle), `best_h`/`best_d`/`best_a` (best across bookmakers), `commence_time`, `home_team`, `away_team`, `league`. Plus O25/U25 sharp odds.

**Per-Liga state** siehe Sektion 4. eerste_divisie hat 0 — The-Odds-API führt die Liga nicht.

---

### 2.5 `matchdays` — Spieltag-JSON Snapshots

**492 rows total**, JSONB column mit komplettem Match-Aufbau. Pro Liga ein neuer row pro `npm run refresh:full` (= snapshot, nicht ein incremental update).

**Per-Liga snapshots** (current period):
- liga3: **195 snapshots** (von 2020-10-02 bis heute — special-case weil OpenLigaDB die einzige Source seit 4 Jahren)
- bundesliga + bundesliga2: 22-23 snapshots seit 2026-04-04
- Andere 22 Ligen: 4-21 snapshots, alle current (April-Mai 2026)
- eerste_divisie: 0 (no Odds-API → kein Auto-Generate)

**Inhalt pro Match:** xg_h8/xga_h8 (Summen über 8 Spiele!), form (W W D L W), standings_pos/_points, injuries (TM-Free-Text), yellow_risk, h2h (last 5), tags (DERBY/MEISTERKAMPF/...), `_openliga_match_id` (DE-Ligen).

---

### 2.6 `match_outcomes` — Reality-Bridge

**2.618 rows total**, alle mit xG (100% fill). UNIQUE: `(match_key, match_date)` — supports double-round-robin Ligen wie austria_bl.

**Auto-Population:** `scripts/populate-match-outcomes.mjs` joined home + away team_xg_history rows pro Match (cron daily).

**Spalten:** goals_h/goals_a, xg_h/xg_a, npxg_h/npxg_a, shots_h/shots_a, shots_on_target_h/_a, corners_h/_a, yellow_cards_h/_a, red_cards_h/_a. Generated cols: `total_goals`, `over25`, `btts`, `outcome_1x2`.

**Per-Liga**: 29 (scottish_prem) bis 226 (league_two) — siehe Sektion 4.

---

### 2.7 Engine-Tracking-Tabellen

#### `pipeline_shadow_log` (3.441 rows, 4 engines)

Per-`/matchday`-page-load via `savePredictionsBulk`. Pro engine + match: prob_h/d/a/o25, predicted_at. UNIQUE: `(match_key, engine_variant, predicted_date)`.

**Per-engine-totals** (alle Ligen):
- ensemble: ~1.020
- poisson-ml: ~1.005
- poisson-ml-v2: ~1.005
- poisson-ml-v3: ~411 (preview-only — weniger weil v3 nur in einigen Sessions geladen wurde)

**Datums-range:** seit 2026-04-21 — Live-Tracking-Start.

#### `match_predictions` (1.062 rows, 4 engines × 267 unique matches)

Pre-match snapshots mit lambda + sharp_odds + expected_corners + expected_yellow_cards. Reicher als shadow_log (hat λ-values). Captured 2026-04-26 → 2026-05-02 (7 Tage Window).

**Per-engine-totals:** ensemble-v1: 267, poisson-ml: 267, poisson-ml-v2: 267, poisson-ml-v3: 261.

Per-Liga tracking siehe Sektion 4 (column "match_predictions per engine").

#### `live_brier_snapshots` (27 rows, 3 engines × 9 windows)

Cron-aggregate von `scripts/monitor-live-brier.mjs`. UNIQUE: `(window_end_date, engine, league)`. league=`__overall` für aggregate row.

Latest snapshot 2026-04-26 (n=13 settled matches):
- ensemble: Brier 0.6744
- poisson-ml-v2: Brier 0.7156
- poisson-ml: Brier 0.7288

(v3 fehlt im snapshot — preview-only delegiert zu v2)

---

### 2.8 `team_metadata` — TheSportsDB-Sourced

**430 rows total**, 22 Ligen. Per-Liga 10-27 teams. Coverage:

- `logo_url`: 100% in allen Ligen
- `primary_color`: **0% (NULL) überall** — TheSportsDB Free-Tier liefert keine colors
- `thesportsdb_id`: 100%
- `api_sports_id`: 100% (Cross-Source-Bridge ID, falls api-sports später aktiviert wird)

**Source:** TheSportsDB `lookup_all_teams.php` (verschiedene Endpoints), gefolgt von `fill-thesportsdb-missing.mjs` für die 11+ Teams jenseits des 10-Team-Limits via `searchteams` + Fallback-Queries.

**Cross-Liga Sync-State:** 54 Reserve-Teams + austria_bl/swiss_sl/greek_sl Regional-Clubs sind nicht in TheSportsDB Free-Tier indexiert — best-effort, nicht critical.

---

### 2.9 `player_xg_history` — Top-5 Player-Level

**2.500 rows**, NUR 5 Top-Ligen:

| Liga | Players |
|---|---|
| serie_a | 558 |
| la_liga | 531 |
| epl | 506 |
| ligue_1 | 464 |
| bundesliga | 441 |
| **alle anderen 17 Ligen** | **0** |

**Source:** Understat browser-scraped. Wird für xGChain-Hydration in `MatchdayContext.tsx` bei TM-Injuries genutzt (Phase 2.3 wired).

---

### 2.10 Stub / Marginal Tabellen

#### `referees` (354 rows, ⚠ STUB)
fouls_per_game alle NULL, yellows_per_game nur 13 distinct values, home_yellow_bias 1 distinct value (alle "1"). **NICHT als Feature verwerten.** Tabelle existiert für künftigen Backfill.

#### `stadiums` (278 rows, marginal)
Lat/Lng/capacity per Heim-Stadion, 30% join coverage, altitude_m 0% populiert. Marginal value, nicht als Feature gewired.

#### `bets` (3 rows) + `profiles` (4 rows)
Kleine Production — wenig User-Aktivität bisher.

#### `odds_snapshots` (3 rows)
Manual snapshots, kein Auto-Cron. `live_odds` ist die operative Tabelle.

---

## 3. Externe Quellen (Pipelines die nicht im DB landen)

### 3.1 Transfermarkt (Injuries) — pro `npm run refresh:full`

`scripts/_lib/transfermarkt-scrape.mjs::fetchTeamInjuries` — pro unique Team in matchdays:
- Rate-limited fetch (1.5s/team)
- 5-tier fuzzy team-name resolver (`scripts/_lib/transfermarkt-ids.mjs`, 406-team-ID-map)
- 153 manual aliases (`scripts/_lib/transfermarkt-aliases.mjs`)
- HTML-Tabelle → Groq Llama 3.1 8b normalisiert zu strukturiertem JSON
- Daily-quota detection: sticky `_groqDailyQuotaExhausted` flag

**Output:** Free-text strings in `matchdays.data.matches[].injuries` und `.yellow_risk`. Format: `"Player (POS, Reason, bis DATE), ..."`. Direct embedded — KEINE separate `player_injuries` Tabelle.

**Coverage:** 22 Ligen wired (seit 2026-05-01 — austria_bl/swiss_sl/eerste_divisie ergänzt).

### 3.2 Groq Llama 3.1 8b (HTML→JSON)

500K tokens/day free-tier. Ein `refresh:full` ≈ 350K Tokens. Sticky-flag verhindert endlose Retries bei quota-exhaustion.

### 3.3 Claude Sonnet 4 (`/api/matchday`)

Optional AI-enrichment via `web_search` — nur wenn `CLAUDE_API_KEY` gesetzt. Liefert Tags die durch Auto-Pipeline NICHT abgedeckt sind: NEUER-TRAINER, SANDWICH (Champions/Europa-League fixture density), und qualitative tags.

### 3.4 OpenLigaDB

`scripts/_lib/matchday-enrich.mjs::loadOpenLigaDBSeason` — Liga 3 + Bundesliga + BL2 echte "30. Spieltag" labels (DE-only). Plus goals-only fallback für Liga 3 xG (`scripts/backfill-liga3-openligadb.mjs`).

### 3.5 football-data.co.uk

CSV-Historie für Closing-Odds + shots → shots-model. ⚠ Pinnacle-closing-Spalten STALE seit 2026-01-14.

### 3.6 The-Odds-API

500 credits/month free × N keys (multi-key rotation seit `bfef197`). Live-odds + fixtures alle 4h.

### 3.7 TheSportsDB

Team-Metadata (logos + IDs). Free-Tier mit 10-Teams-Limit pro Query → fill-skript für Rest.

### 3.8 api-sports.io

Free-tier 100 calls/day. Key 2 suspended → Tabelle bleibt mit 7 rows defensive. `player_injuries` Schema bleibt für künftigen Backfill.

### 3.9 StatsBomb Open Data (lokal in `tools/statsbomb/`)

Event-Level rohstoff für Model-Training (NICHT für Live-Predictions). Aggregates.csv: 34 Features pro team-match (shots, xG, passes, carries, pressures, fouls). 12 Priority-Comps (~1800 matches).

### 3.10 Sofascore (via `datafc`)

Siehe Sektion 2.2.

---

## 4. Per-Liga Coverage-Matrix (alle 22 Ligen)

Spalten:
- **xGH-Rows**: team_xg_history total rows
- **xGH-Range**: earliest..latest match_date
- **xGH-Sources**: top sources (mit row counts)
- **Per-Saison-rows**: team_xg_history breakdown nach FODZE-Saison
- **Sofa-Status**: Sofascore tier + matches/shots
- **Closing-Odds**: count + range + sources
- **Live**: live_odds + upcoming_fixtures
- **match_outcomes**: total
- **TM-meta**: team_metadata count
- **Engine-Tracking**: shadow_log + match_predictions counts per engine

### 4.1 bundesliga (Bundesliga, GER, Tier-1)

- **xGH-Rows:** 2.815 total (100% xg-fill)
- **xGH-Range:** 2017-08-19 → 2026-05-02
- **xGH-Sources:** goals-proxy 1.182, understat 1.157, footystats 476
- **Per-Saison:** 17/18:238, 18/19:238, 19/20:204, 20/21:204, 21/22:306, 22/23:238, 23/24:204, 24/25:613, 25/26:570
- **Sofa:** **premium** · 282 matches, 7.387 shots (99.8% xG-fill), 25/26
- **Closing-Odds:** 1.375 (2020-09-18→2026-05-03) · football-data.co.uk:1.373, live-snap:2
- **Live:** 12 · 12
- **match_outcomes:** 143
- **TM-meta:** 20 (alle mit logo + tsdb_id + api_id, 0 colors)
- **player_xg_history:** 441
- **Shadow_log:** ensemble 167 / poisson-ml 165 / v2 165 / **v3 76**
- **match_predictions:** 28 each engine
- **matchdays:** 22 snapshots, 7 distinct dates (2026-04-04→05-02)

### 4.2 bundesliga2 (2. Bundesliga, GER, Tier-2)

- **xGH-Rows:** 2.836 (100% xg-fill)
- **xGH-Range:** 2021-07-23 → 2026-05-02
- **xGH-Sources:** footystats 1.361, goals-proxy 1.178, shots-model-pooled 297
- **Per-Saison:** 21/22:476, 22/23:408, 23/24:408, 24/25:681, 25/26:863
- **Sofa:** **premium** · 279 matches, 7.513 shots (99.7% xG-fill), 25/26
- **Closing-Odds:** 1.319 (2020-09-18→2026-05-03) · football-data.co.uk:1.314
- **Live:** 9 · 9
- **match_outcomes:** 132
- **TM-meta:** 27
- **player_xg_history:** 0
- **Shadow_log:** ensemble 50 / v1 49 / v2 49 / v3 7
- **match_predictions:** 7 each
- **matchdays:** 23 snapshots

### 4.3 liga3 (3. Liga, GER, Tier-3)

- **xGH-Rows:** 2.931 (100% xg-fill — aber ⚠ Goals-Proxy für Hälfte)
- **xGH-Range:** 2021-07-24 → 2026-05-02
- **xGH-Sources:** goals-proxy 1.472, footystats 1.459
- **Per-Saison:** 21/22:432, 22/23:494, 23/24:456, 24/25:835, 25/26:714
- **Sofa:** **partial** · 330 matches, 8.440 shots (99.7% xG-fill, ABER ohne assisted/fast-break tags), 25/26
- **Closing-Odds:** ⚠ **6** (2026-05-02→05-03 only, live-snap) — football-data.co.uk hat Liga 3 nie geliefert
- **Live:** 12 · 12
- **match_outcomes:** 177
- **TM-meta:** 21
- **Shadow_log:** ensemble 26 / v1 25 / v2 25 / **v3 0**
- **match_predictions:** 0 each
- **matchdays:** **195 snapshots** (special-case — historisch seit 2020 via OpenLigaDB)

### 4.4 epl (Premier League, ENG, Tier-1)

- **xGH-Rows:** 6.062 (100% xg-fill)
- **xGH-Range:** 2017-08-11 → 2026-04-24
- **xGH-Sources:** footystats 3.706, understat 2.356
- **Per-Saison:** 17/18:570, 18/19:570, 19/20:472, 20/21:668, 21/22:798, 22/23:760, 23/24:798, 24/25:760, 25/26:666
- **Sofa:** **premium** · 341 matches, 8.436 shots (99.6% xG-fill), 25/26
- **Closing-Odds:** 1.732 (2020-09-12→2026-05-03) · football-data.co.uk:1.730
- **Live:** 14 · 14
- **match_outcomes:** 103
- **TM-meta:** 21
- **player_xg_history:** 506
- **Shadow_log:** ensemble 88 / v1 87 / v2 87 / v3 54
- **match_predictions:** 24 each
- **matchdays:** 14 snapshots

### 4.5 championship (EFL Championship, ENG, Tier-2)

- **xGH-Rows:** 5.562 (100%)
- **xGH-Range:** 2021-08-06 → 2026-04-24
- **xGH-Sources:** footystats 4.621, shots-model-pooled 934, api-sports 7
- **Per-Saison:** 21/22:1.114, 22/23:1.114, 23/24:1.114, 24/25:1.121, 25/26:1.099
- **Sofa:** **premium** · 471 matches, 11.496 shots (99.6% xG-fill), 25/26
- **Closing-Odds:** 2.489 (2020-09-11→2026-05-02) · football-data.co.uk:2.477
- **Live:** 2 · 2
- **match_outcomes:** 186
- **TM-meta:** 27
- **Shadow_log:** ensemble 21 / v1 21 / v2 21 / v3 0
- **match_predictions:** 0 each
- **matchdays:** 17 snapshots

### 4.6 league_one (EFL League One, ENG, Tier-3)

- **xGH-Rows:** 5.696 (100%)
- **xGH-Range:** 2021-08-07 → 2026-04-22
- **xGH-Sources:** footystats 4.762, shots-model-pooled 934
- **Per-Saison:** 21/22:1.114, 22/23:1.114, 23/24:1.114, 24/25:1.114, 25/26:1.240
- **Sofa:** **volume** · 495 matches, 10.842 shots (**0% xG** — Sofascore-upstream-limit), 25/26
- **Closing-Odds:** ⚠ **0** (football-data.co.uk hat League One nie)
- **Live:** 2 · 2
- **match_outcomes:** 221
- **TM-meta:** 23
- **Shadow_log:** ensemble 9 / v1 9 / v2 9 / v3 0
- **match_predictions:** 0 each
- **matchdays:** 12 snapshots

### 4.7 league_two (EFL League Two, ENG, Tier-4)

- **xGH-Rows:** 5.633 (100%)
- **xGH-Range:** 2021-08-07 → 2026-04-23
- **xGH-Sources:** footystats 4.683, shots-model-pooled 950
- **Per-Saison:** 21/22:1.114, 22/23:1.114, 23/24:1.114, 24/25:1.114, 25/26:1.177
- **Sofa:** **volume** · 485 matches, 11.055 shots (**0% xG**), 25/26
- **Closing-Odds:** ⚠ **0**
- **Live:** 2 · 2
- **match_outcomes:** 226
- **TM-meta:** 24
- **Shadow_log:** ensemble 49 / v1 49 / v2 49 / v3 37
- **match_predictions:** 8 each
- **matchdays:** 14 snapshots

### 4.8 la_liga (La Liga, ESP, Tier-1)

- **xGH-Rows:** 6.470 (100%)
- **xGH-Range:** 2017-08-18 → 2026-04-24
- **xGH-Sources:** understat 3.838, footystats 2.400, shots-model 232
- **Per-Saison:** 17/18:646, 18/19:646, 19/20:483, 20/21:657, 21/22:836, 22/23:836, 23/24:912, 24/25:836, 25/26:618
- **Sofa:** **premium** · 333 matches, 8.252 shots (99.8% xG-fill), 25/26
- **Closing-Odds:** 1.713 (2020-09-12→2026-05-03)
- **Live:** 14 · 14
- **match_outcomes:** 123
- **TM-meta:** 23
- **player_xg_history:** 531
- **Shadow_log:** ensemble 48 / v1 48 / v2 48 / v3 20
- **match_predictions:** 10 each
- **matchdays:** 15 snapshots

### 4.9 la_liga2 (Segunda División, ESP, Tier-2)

- **xGH-Rows:** 4.190 (100%)
- **xGH-Range:** 2021-08-13 → 2026-04-24
- **xGH-Sources:** footystats 3.464, shots-model-pooled 726
- **Per-Saison:** 21/22:808, 22/23:852, 23/24:894, 24/25:758, 25/26:878
- **Sofa:** **volume** · 409 matches, 10.218 shots (**0% xG**), 25/26
- **Closing-Odds:** 2.049 (2020-09-12→2026-05-03)
- **Live:** 12 · 12
- **match_outcomes:** 190
- **TM-meta:** 22
- **Shadow_log:** ensemble 79 / v1 78 / v2 78 / v3 68
- **match_predictions:** 35 each
- **matchdays:** 16 snapshots

### 4.10 serie_a (Serie A, ITA, Tier-1)

- **xGH-Rows:** 6.370 (100%)
- **xGH-Range:** 2017-08-19 → 2026-04-24
- **xGH-Sources:** footystats 3.704, understat 2.666
- **Per-Saison:** 17/18:684, 18/19:684, 19/20:480, 20/21:812, 21/22:760, 22/23:762, 23/24:764, 24/25:762, 25/26:662
- **Sofa:** **premium** · 345 matches, 8.410 shots (99.8% xG-fill), 25/26
- **Closing-Odds:** 1.723 (2020-09-19→2026-05-03)
- **Live:** 15 · 15
- **match_outcomes:** 44
- **TM-meta:** 23
- **player_xg_history:** 558
- **Shadow_log:** ensemble 30 / v1 30 / v2 30 / v3 20
- **match_predictions:** 10 each
- **matchdays:** 15 snapshots

### 4.11 serie_b (Serie B, ITA, Tier-2)

- **xGH-Rows:** 3.821 (100%)
- **xGH-Range:** 2021-08-20 → 2026-04-24
- **xGH-Sources:** footystats 3.183, shots-model-pooled 638
- **Per-Saison:** 21/22:780, 22/23:780, 23/24:780, 24/25:780, 25/26:701
- **Sofa:** **premium** · 362 matches, 9.417 shots (99.4% xG-fill), 25/26
- **Closing-Odds:** ⚠ 1.609 (2020-09-25→**2025-10-26 only — STALE 6 Monate**) · football-data.co.uk only
- **Live:** 10 · 10
- **match_outcomes:** 39
- **TM-meta:** 20
- **Shadow_log:** ensemble 13 / v1 13 / v2 13 / v3 0
- **match_predictions:** 0 each
- **matchdays:** 13 snapshots

### 4.12 ligue_1 (Ligue 1, FRA, Tier-1)

- **xGH-Rows:** 6.157 (100%)
- **xGH-Range:** 2017-08-04 → 2026-04-24
- **xGH-Sources:** understat 3.281, footystats 2.795, shots-model 81
- **Per-Saison:** 17/18:722, 18/19:722, 19/20:530, 20/21:722, 21/22:836, 22/23:799, 23/24:650, 24/25:646, 25/26:530
- **Sofa:** **premium** · 281 matches, 6.840 shots (99.7% xG-fill), 25/26
- **Closing-Odds:** 1.532 (2020-08-21→2026-05-03)
- **Live:** 14 · 14
- **match_outcomes:** 117
- **TM-meta:** 19
- **player_xg_history:** 464
- **Shadow_log:** ensemble 54 / v1 54 / v2 54 / v3 27
- **match_predictions:** 18 each
- **matchdays:** 21 snapshots

### 4.13 ligue_2 (Ligue 2, FRA, Tier-2)

- **xGH-Rows:** 3.376 (100%)
- **xGH-Range:** 2021-07-24 → 2026-04-24
- **xGH-Sources:** footystats 2.874, shots-model-pooled 502
- **Per-Saison:** 21/22:726, 22/23:722, 23/24:726, 24/25:582, 25/26:620
- **Sofa:** **volume** · 303 matches, 6.489 shots (**0% xG**), 25/26
- **Closing-Odds:** ⚠ 1.544 (2020-08-22→**2025-11-25 only — STALE 5 Monate**) · football-data.co.uk only
- **Live:** 9 · 9
- **match_outcomes:** 133
- **TM-meta:** 17
- **Shadow_log:** ensemble 50 / v1 50 / v2 50 / v3 50
- **match_predictions:** 38 each
- **matchdays:** 13 snapshots

### 4.14 eredivisie (Eredivisie, NED, Tier-1)

- **xGH-Rows:** 2.746 (100%)
- **xGH-Range:** 2021-08-13 → 2026-04-23
- **xGH-Sources:** footystats 2.690, shots-model 56
- **Per-Saison:** 21/22:552, 22/23:556, 23/24:550, 24/25:548, 25/26:540
- **Sofa:** **premium** · 292 matches, 8.114 shots (99.8% xG-fill), 25/26
- **Closing-Odds:** 1.370 (2020-09-12→2026-05-03)
- **Live:** 11 · 11
- **match_outcomes:** 108
- **TM-meta:** 18
- **Shadow_log:** ensemble 57 / v1 56 / v2 56 / v3 25
- **match_predictions:** 25 each
- **matchdays:** 9 snapshots

### 4.15 eerste_divisie (Eerste Divisie, NED, Tier-2)

- **xGH-Rows:** 3.800 (100%)
- **xGH-Range:** 2021-08-06 → 2026-04-24
- **xGH-Sources:** footystats 3.800 (sole source)
- **Per-Saison:** 21/22:760, 22/23:760, 23/24:760, 24/25:760, 25/26:760
- **Sofa:** **volume** · 393 matches, 10.861 shots (**0% xG**), 25/26
- **Closing-Odds:** ⚠ **0** (football-data.co.uk hat Eerste Divisie nie)
- **Live:** ⚠ **0 · 0** (Odds-API führt die Liga nicht — backtest-only league)
- **match_outcomes:** 148
- **TM-meta:** 10 (sparse — TheSportsDB Coverage gap)
- **Shadow_log:** ⚠ **0 each engine**
- **match_predictions:** ⚠ **0 each engine**
- **matchdays:** ⚠ **0 snapshots**

### 4.16 primeira_liga (Primeira Liga, POR, Tier-1)

- **xGH-Rows:** 2.635 (100%)
- **xGH-Range:** 2021-08-06 → 2026-04-24
- **xGH-Sources:** footystats 2.153, shots-model-pooled 482
- **Per-Saison:** 21/22:510, 22/23:544, 23/24:544, 24/25:510, 25/26:527
- **Sofa:** **premium** · 290 matches, 6.887 shots (99.7% xG-fill), 25/26
- **Closing-Odds:** 1.380 (2020-09-18→2026-05-03)
- **Live:** 4 · 4
- **match_outcomes:** 51
- **TM-meta:** 16
- **Shadow_log:** ensemble 70 / v1 65 / v2 65 / v3 19
- **match_predictions:** 10 each
- **matchdays:** 18 snapshots

### 4.17 greek_sl (Stoiximan Super League, GRE, Tier-1)

- **xGH-Rows:** 2.342 (100%)
- **xGH-Range:** 2021-09-11 → 2026-04-22
- **xGH-Sources:** footystats 1.978, shots-model-pooled 364
- **Per-Saison:** 21/22:480, 22/23:480, 23/24:480, 24/25:472, 25/26:430
- **Sofa:** **premium** (sparse) · 29 matches, 658 shots (99.7% xG-fill), 25/26
- **Closing-Odds:** 1.010 (2020-09-11→2026-05-03)
- **Live:** 11 · 11
- **match_outcomes:** 89
- **TM-meta:** 10
- **Shadow_log:** ensemble 30 / v1 26 / v2 26 / v3 0
- **match_predictions:** 0 each
- **matchdays:** 17 snapshots

### 4.18 jupiler_pro (Belgian Pro League, BEL, Tier-1)

- **xGH-Rows:** 2.716 (100%)
- **xGH-Range:** 2021-07-23 → 2026-04-24
- **xGH-Sources:** footystats 2.236, shots-model-pooled 480
- **Per-Saison:** 21/22:552, 22/23:552, 23/24:550, 24/25:505, 25/26:557
- **Sofa:** ✅ **premium** · 315 matches, 7.484 shots (99.7% xG-fill), 25/26 — fetched 2026-05-05 nach Cloudflare-unblock; 572 chance_quality view rows; 572 team_xg_history rows mit `source=sofascore` via Bridge
- **Closing-Odds:** 1.335 (2020-08-08→2026-05-03)
- **Live:** 11 · 11
- **match_outcomes:** 105
- **TM-meta:** 15
- **Shadow_log:** ensemble 48 / v1 47 / v2 47 / v3 42
- **match_predictions:** 25 each
- **matchdays:** 16 snapshots

### 4.19 super_lig (Süper Lig, TUR, Tier-1)

- **xGH-Rows:** 3.329 (100%)
- **xGH-Range:** 2021-08-13 → 2026-04-24
- **xGH-Sources:** footystats 2.820, shots-model-pooled 482, shots-model 27
- **Per-Saison:** 21/22:722, 22/23:648, 23/24:722, 24/25:648, 25/26:589
- **Sofa:** ✅ **premium** · 240 matches, 6.033 shots (99.7% xG-fill), 25/26 (range 2025-08-08→2026-03-15 — Cloudflare-blocked rounds 30-38; Bridge added 468 rows mit source=sofascore)
- **Closing-Odds:** 1.597 (2020-09-11→2026-05-03)
- **Live:** 13 · 13
- **match_outcomes:** 93
- **TM-meta:** 18
- **Shadow_log:** ensemble 15 / v1 15 / v2 15 / v3 15
- **match_predictions:** 6 each
- **matchdays:** 19 snapshots

### 4.20 scottish_prem (Scottish Premiership, SCO, Tier-1)

- **xGH-Rows:** 2.097 (100%)
- **xGH-Range:** 2021-07-31 → 2026-04-12
- **xGH-Sources:** footystats 1.725, shots-model-pooled 372
- **Per-Saison:** 21/22:418, 22/23:418, 23/24:418, 24/25:418, 25/26:425
- **Sofa:** ✅ **premium** · 222 matches, 5.384 shots (99.6% xG-fill), 25/26 (incl. Top-6 Splitt-Round-Spiele); Bridge added 420 team_xg_history rows
- **Closing-Odds:** ⚠ 966 (2020-08-01→**2025-10-26 only — STALE 6 Monate**) · football-data.co.uk only
- **Live:** 10 · 10
- **match_outcomes:** 29
- **TM-meta:** 21
- **Shadow_log:** ensemble 24 / v1 23 / v2 23 / v3 14
- **match_predictions:** 8 each
- **matchdays:** 13 snapshots

### 4.21 austria_bl (Bundesliga, AUT, Tier-1)

- **xGH-Rows:** 1.898 (100%)
- **xGH-Range:** 2021-07-23 → 2026-04-24
- **xGH-Sources:** footystats 1.898 (sole source)
- **Per-Saison:** 21/22:390, 22/23:390, 23/24:390, 24/25:390, 25/26:338
- **Sofa:** ✅ **premium** · 181 matches, 4.413 shots (99.2% xG-fill), 25/26 (incl. Meistergruppe + Qualigruppe); Bridge added 358 team_xg_history rows
- **Closing-Odds:** ⚠ **1** (2026-05-03 only, live-snap) — football-data.co.uk hat austria_bl nie
- **Live:** 7 · 7
- **match_outcomes:** 76
- **TM-meta:** 14
- **Shadow_log:** ensemble 31 / v1 27 / v2 27 / v3 0
- **match_predictions:** 0 each
- **matchdays:** 6 snapshots

### 4.22 swiss_sl (Super League, SUI, Tier-1)

- **xGH-Rows:** 2.028 (100%)
- **xGH-Range:** 2021-07-24 → 2026-04-18
- **xGH-Sources:** footystats 2.028 (sole source)
- **Per-Saison:** 21/22:360, 22/23:360, 23/24:456, 24/25:456, 25/26:396
- **Sofa:** ✅ **premium** · 218 matches, 5.990 shots (99.5% xG-fill), 25/26 (incl. Championship Group); Bridge added 420 team_xg_history rows
- **Closing-Odds:** ⚠ **3** (2026-05-02→05-03 only, live-snap) — football-data.co.uk hat swiss_sl nie
- **Live:** 8 · 8
- **match_outcomes:** 85
- **TM-meta:** 21
- **Shadow_log:** ensemble 41 / v1 39 / v2 39 / v3 15
- **match_predictions:** 15/15/15/9
- **matchdays:** 4 snapshots

---

## 5. Coverage-Highlights & Hot-Spots

### 5.1 Was komplett ist
- ✅ **22 Ligen mit current 25/26 xG** in `team_xg_history` (alle 100% xg-fill)
- ✅ **8-9 Saisons Tiefe** für 5 Top-Ligen (BL, EPL, La Liga, Serie A, Ligue 1) — Understat-Backbone seit 2017
- ✅ **5 Saisons Tiefe** für die anderen 17 Ligen (seit 2021/22) — FootyStats-Backbone
- ✅ **Sofascore Tier-A komplett** (11 Ligen, ~3.700 matches × 25/26 mit echten per-shot xG)
- ✅ **`team_metadata` 100% logo + tsdb_id + api_id** für 430 Teams
- ✅ **Closing-Odds Backtest-Korpus** (24.681 rows football-data.co.uk historical)
- ✅ **Forward-CLV-Cache** going-forward (live-odds-snapshot)
- ✅ **Engine-Tracking pipeline** läuft seit 2026-04-21 (n=104 settled cross-engine)

### 5.2 Bekannte Gaps

| Gap | Impact | Mitigation |
|---|---|---|
| ~~**5 Sofascore-Ligen pending**~~ | ✅ **CLOSED 2026-05-05** | Cloudflare-unblock-Retry erfolgreich für alle 5 (jupiler_pro/super_lig/scottish_prem/austria_bl/swiss_sl). Alle jetzt premium-tier mit 99.2-99.7% xG-fill |
| **3 Sofascore-Ligen ohne xG** (league_one/two, eerste_divisie) | Tier=volume — shots-only, kein xG-feature | Sofascore-upstream-limit; nicht behebbar |
| **super_lig Sofa partial-coverage** | Cloudflare blockierte rounds 30-38 → letzte erfasste Saison-data 2026-03-15. Footystats-CSV-Import 2026-05-04 hat aktuelle Daten via team_xg_history 2026-05-03 erfasst | Bei nächstem refresh-all kann super_lig single-league retry probiert werden |
| **football-data.co.uk closing-odds STALE** seit 2026-01-14 | Backtest beyond Jan 2026 fehlt closing-odds-Spalten | live-odds-snapshot füllt forward-cache going-forward |
| **football-data.co.uk closing-odds für 7 Ligen STALE seit Sommer/Herbst 2025** | serie_b (-okt 2025), ligue_2 (-nov), scottish_prem (-okt) — keine recent closing odds | live-snap füllt going-forward, aber backtest-gap bleibt |
| **football-data.co.uk closing-odds für 5 Ligen NIE existent** | liga3, league_one, league_two, eerste_divisie, austria_bl, swiss_sl — football-data.co.uk hat sie nie geliefert | Nur live-snap forward-cache (~6 rows total für diese 5 Ligen) |
| **eerste_divisie ZERO live-odds + ZERO matchdays + ZERO predictions** | Backtest-only league, no Odds-API coverage | Nicht behebbar ohne anderen odds-provider |
| **`player_injuries` empty** | Schema existiert aber api-sports Key 2 suspendiert | TM-injuries werden direkt im matchday JSON embedded (current workaround) |
| **`team_metadata.primary_color` 100% NULL** | UI-Accent-Gradients könnten nicht real-team-colors zeigen | TheSportsDB Free-Tier liefert keine colors; alt source nötig |
| **`referees` STUB** | Kein Referee-feature im Engine wertbar | Backfill-script nicht geschrieben |
| **`stadiums` 30% join + altitude 0%** | Marginal value, nicht als Feature gewired | Best-effort |
| **`live_wp_snapshots` / `corners_odds_history` / `player_props_posteriors` ALL EMPTY** | Phase 3.x dormant | Brauchen Betfair-API-Key / UI-Tab / R-service |
| **`player_xg_history` nur 5 Top-Ligen** | xGChain-Hydration nur für Top-5-Ligen-Matches | Understat scrape-script existiert nicht für andere Ligen |
| **`match_predictions` 7-Tage Window only** | Captured 2026-04-26→05-02; älter = nicht gespeichert | Population-script existiert (savePredictionsBulk in `/matchday`-page-load) — nur nicht backfilled |
| **`live_brier_snapshots` 27 rows total** | Cron startet erst seit Ende April; sample n=13 zu klein | Wird mit täglichen Spieltagen wachsen |

### 5.3 Per-Liga-Risk-Klassifikation

**Vollständige Coverage (Ligen die alle Sources nutzen können):**
- bundesliga, epl, la_liga, serie_a, ligue_1 (Top-5: alle 4 xG-Sources + Sofascore-premium + player-xg + closing-odds bis heute)

**Solide aber ohne player-level data:**
- bundesliga2, championship, serie_b, eredivisie, primeira_liga (Sofascore-premium + footystats + closing-odds bis heute)

**Solide aber mit STALE closing-odds:**
- serie_b (-okt 2025), ligue_2 (-nov), scottish_prem (-okt)

**Reduzierte Engine-Coverage (Sofascore Tier=volume oder n/a):**
- liga3 (partial — kein assisted/fast-break), la_liga2/ligue_2 (volume — kein xG), league_one/two/eerste_divisie (volume — kein xG)

**~~Noch ohne Sofascore~~ → ✅ CLOSED 2026-05-05:**
- ~~jupiler_pro, super_lig, scottish_prem, austria_bl, swiss_sl~~ — alle 5 jetzt premium-tier nach Cloudflare-unblock-retry am 2026-05-05

**Backtest-only (no live):**
- eerste_divisie (no Odds-API)

---

## 6. Refresh-Pfade (was wann läuft)

| Pfad | Frequenz | Was es macht | Was es schreibt |
|---|---|---|---|
| `npm run refresh` | täglich (cron 07:30 lokal) | odds + matchdays ohne Injuries (~3 min) | live_odds, upcoming_fixtures, matchdays (no injuries) |
| `npm run refresh:full` | Di + Fr 19:00 lokal | + Transfermarkt injuries via Groq (~25 min) | + matchdays.data.matches[].injuries |
| `npm run refresh:quick` | manual | nur Odds + Audit (~30s) | live_odds, upcoming_fixtures |
| `scripts/fetch-odds.mjs` (cron alle 4h Fr-So + Mi) | GitHub Actions `fetch-odds.yml` | The-Odds-API multi-key + closing-snapshot + value-alerts | live_odds, upcoming_fixtures, odds_closing_history (live-snap forward-cache) |
| `scripts/fetch-results.mjs` (cron 02:17 + 08:17 UTC) | GitHub Actions `settle-bets.yml` | Bet-Settlement + CLV-Recompute + populate-match-outcomes + liga3-backfill + footystats | bets, match_outcomes, team_xg_history (liga3 OpenLigaDB) |
| `scripts/sync-sofascore-shotmap.mjs --tier A` (cron Phase 4) | im refresh-all | Sofascore Shot-Events Tier-A inkrementell | sofascore_match, sofascore_shotmap |
| `scripts/sync-sofascore-shotmap.mjs --tier B` | NICHT scheduled — manual retry | Tier-B Sofascore | dito |
| `scripts/monitor-live-brier.mjs --persist` | cron-ready (nicht aktiv) | Live-Brier-Aggregation | live_brier_snapshots |
| `scripts/populate-match-outcomes.mjs` | cron daily | Joined home + away team_xg_history → match_outcomes | match_outcomes |
| `scripts/snapshot-closing-odds.mjs` | im fetch-odds-cron | Pinnacle closing-odds für pending bets + forward-cache | bets.closing_odds, bets.clv, odds_closing_history |
| `scripts/seed-understat-2526.mjs` | manual zu Saisonstart | Understat-Browser-JSON → team_xg_history | team_xg_history (source=understat) |
| `scripts/build-tm-team-ids.mjs` | Saisonwechsel (Mai/Aug) | Transfermarkt-Liga-Seiten → 406-team-ID-Map | scripts/_lib/transfermarkt-ids.mjs (file output) |
| `scripts/sync-thesportsdb-metadata.mjs --all` | Saisonwechsel | TheSportsDB Team-Metadata sync | team_metadata |

---

## 7. Audit-Reproducibility

Diese Doku basiert auf Live-Counts vom **2026-05-03**. Zum Refresh:

```bash
# Hauptquelle 1: high-level audit
npm run audit

# Hauptquelle 2: ad-hoc per-table queries
node scripts/health-check.mjs    # 5s status check externe sources

# Detail-queries: siehe inline in dieser Datei (Sektion 4 wurde via
# 3 ad-hoc Audit-Scripts gegen Supabase REST + sofascore views gebaut).
# Re-run via /tmp/data-audit-final.json regeneration.
```

Bei Diskrepanzen: **Live-DB ist authoritative.** Diese Datei drift mit jedem `refresh`-cycle, sollte aber halbwegs im Rahmen bleiben.

# FODZE — Datapoints & Model Usage Overview

**Stand:** 2026-05-10 · **Quelle:** Live-Audit Supabase `oddsmind` + local SQLite mirror
**Coverage:** 22 Ligen × Saison 25/26 (6856 ended games · 100% Sofa-extras)

Vollständiges Inventar aller Datenquellen mit:
1. Pro-Liga Coverage
2. Engine-Nutzung farb-codiert
3. Calibration-Layer Mapping
4. Backtest- vs UI-Use distinction

---

## Color Code (Engine-Mapping)

Jeder Datenpunkt wird mit einem oder mehreren der folgenden Codes markiert:

| Code | Engine / Use | Activation |
|---|---|---|
| 🟢 **E0** | Standard Ensemble (ensemble-v1) | default-on, production |
| 🟣 **E1** | @annafrick13 v1 (poisson-ml) | live, opt-in via UI toggle |
| 🔵 **E2** | @annafrick13 v2 (poisson-ml-v2 LightGBM Tweedie 21f) | production-default since 2026-04 |
| 🟦 **E3** | @annafrick13 v3 (poisson-ml-v3 Lean 20f) | preview-only, internally → v2 |
| 🟧 **C** | Calibration Layer (isotonic / Benter / Conformal / Overdispersion) | live |
| 🟥 **B** | Backtest / Monitoring (post-hoc Brier + CLV-stats) | always-on |
| 🟨 **U** | UI / Display Only (matchday cards, ask-anna context, /health) | live |
| ⚪ **M** | Metadata / Sync-State (no engine read) | infrastructure |
| ⬜ **D** | Dormant / Stub (schema exists, no production use) | future |

---

## 1. Primary Data Sources (= Engine Inputs)

### 1.1 `team_xg_history` — Multi-Source xG-Aggregat 🟢🟣🔵🟦

**Total: 87.330 rows · 22 Ligen · 2017-08-04 → 2026-05-10**

Per-Match xG / xGA / Goals / Shots / Corners / 18 sofascore-extras feature columns. Primary input für ALLE Engines.

| Column | Used by | Note |
|---|---|---|
| `xg` | 🟢🟣🔵🟦 | Foundation für Dixon-Coles Lambda + ML EWMA |
| `xga` | 🟢🟣🔵🟦 | Defensive momentum |
| `goals_for` / `goals_against` | 🟢🟣🔵🟦🟥 | Engine training + post-hoc Brier |
| `shots_for` / `shots_against` | 🔵🟦 | v2 + v3 physical features (shots_total_diff_ewma) |
| `corners_for` / `corners_against` | 🔵🟦 | v2 + v3 physical (corners_diff_ewma) |
| `source` | ⚪🟥 | Quality-tracking (audits + bridges) |
| `npxg` | 🔵 | v2 only (Understat-derived) |
| `ppda` | 🔵 | v2 only (Understat-derived, PPDA-pressure) |
| `deep_completions` | 🔵 | v2 only (Understat-derived) |
| `big_chances`, `possession_pct`, `tackles_*`, `cards_*`, `goals_prevented` | 🔵🟦 | NEU 2026-05-07 — sofascore extras bridge → 18 feature cols |

**Source Mix (87.330 rows):**

| Source | Rows | Coverage | Quality |
|---|---|---|---|
| `footystats` | ~63.000 | 22 Ligen × 5 Saisons (2021-26) | Real xG, primary |
| `understat` | ~13.300 | Top-5 + Eredivisie (2017-25) | Real xG (höchste Qualität) |
| `sofascore` | ~10.000 | 17 Ligen 25/26 (bridge live seit 2026-05-05) | Aggregated from shotmap |
| `shots-model-pooled` | ~6.711 | 11 Ligen | Modellierte xG aus shots |
| `goals-proxy` | ~3.832 | BL/BL2/Liga3 | OpenLigaDB goals (kein echter xG) |
| `shots-model` | ~396 | Top-5 specific | Per-Liga calibrated |
| `api-sports` | ~7 | defensive | Real xG, current-season suspended |

### 1.2 `sofascore_shotmap` — Per-Shot Events 🔵🟦

**Total: 174.902 rows · ~25 shots/match · 22 Ligen 25/26**

Per-shot: `xg`, `xgot`, `body_part`, `situation`, `shot_type`, `shooter_x/y`, `goal_mouth_x/y/z`, `minute`. Direkt von Sofascore-API via tls-client.

| Use | Detail |
|---|---|
| 🔵 v2 features (indirect via bridge) | `mean_shot_xg`, `setpiece_share`, `late_game_share` |
| 🟦 v3 features (planned) | shot-quality differentials |
| 🟥 Backtest | Calibration of shots→xG model accuracy |

### 1.3 `live_odds` + `upcoming_fixtures` 🟢🔵🟦🟧🟨

**Total: 215 rows each · refreshed every 4h via The-Odds-API**

Pinnacle (sharp) + best-available (lay-side) odds für H/D/A + O25/U25 für upcoming matches.

| Column | Used by | Note |
|---|---|---|
| `sharp_h`, `sharp_d`, `sharp_a` | 🟢🔵🟦🟧 | Vig-removed → Market-prob für Ensemble + Benter blend |
| `sharp_o25`, `sharp_u25` | 🟢🔵🟦 | O25 Market consensus |
| `best_h`, `best_d`, `best_a` | 🟨 | Display in MatchCard, EV calc |
| `commence_time` | 🟢🟣🔵🟦🟨 | Match scheduling, rest-days calc |

### 1.4 `odds_closing_history` 🟧🟥

**Total: 24.798 rows · Pinnacle closing odds**

CLV calculation foundation. Sources: `football-data.co.uk` (24.7k, ⚠ stale seit 2026-01-14) + `live-odds-snapshot` (forward-cache, growing).

| Column | Used by | Note |
|---|---|---|
| `psch`, `pscd`, `psca` | 🟧🟥 | Closing 1X2 → CLV per bet, post-hoc Brier |
| `psc_over25`, `psc_under25` | 🟧🟥 | O25 closing → CLV |
| `pscahh`, `pscaha` | 🟥 | Asian Handicap closing |

---

## 2. Sofascore Extras (V1 + V2 Pipeline) — 100% Coverage seit 2026-05-10

**Universe: 6856 ended games × Saison 25/26 · alle 22 Ligen**

Pipeline: `tools/sofascore/{fetch_match_extras,load_extras_to_supabase}.py`. Backfill am 2026-05-10 vollständig durchgezogen via tls_requests-Fingerprint (CF-bypass).

### 2.1 `sofascore_match` — Game Roster 🟨⚪

**7.099 rows · 22 Ligen · alle status (Ended/upcoming/postponed)**

| Column | Used by |
|---|---|
| `game_id`, `home_team`, `away_team`, `home_team_id`, `away_team_id` | 🟨⚪ Match identification |
| `home_score`, `away_score` | 🟥 Backtest baseline |
| `start_timestamp`, `status`, `week` | 🟨⚪ |

### 2.2 `sofascore_match_statistics` — Team-Level 🔵🟦

**39.666 rows = 6856 games × ~5.8 rows/game (3 periods × 2 sides)**

40 stats pro Side × 3 Perioden (ALL/1ST/2ND): possession, expected_goals, big_chances, total_shots, shots_inside_box, corners, fouls, yellow_cards, tackles_total, ground_duels_won, etc.

| Column | Used by | Note |
|---|---|---|
| `expected_goals` | 🟦 (planned) | Period-level xG split |
| `big_chances`, `big_chances_missed` | 🔵🟦 | Bridge → team_xg_history.big_chances feature |
| `ball_possession_pct`, `passes_total`, `passes_accurate` | 🔵🟦 | Bridge → possession features |
| `tackles_total`, `tackles_won` | 🔵🟦 | Bridge → defensive |
| `yellow_cards`, `red_cards`, `fouls` | 🔵🟦 | Bridge → discipline features |
| `goals_prevented` | 🔵🟦 | Bridge → goalkeeper-quality |

### 2.3 `sofascore_player_match_stats` — Player-Level ⬜

**279.832 rows lokal SQLite ONLY** (Supabase skipped via `--skip-player-stats`, free-tier storage saver)

Per-Player: rating, goals, assists, expected_goals, expected_assists, shots, passes, key_passes, touches, dribbles, tackles, duels, fouls, etc.

| Column | Used by | Note |
|---|---|---|
| `rating`, `expected_goals`, `key_passes` | ⬜ | NICHT in production-engine — future v4 feature material |
| `touches_in_box`, `goals_prevented` | ⬜ | Heatmap-derived, future xG-quality features |

**Storage:** Lokal in `tools/sofascore/data/local_extras.db` (253 MB SQLite). Re-ingestable in Supabase nach Pro-Plan upgrade via `load_extras_to_supabase.py --all` (ohne `--skip-player-stats`).

### 2.4 `sofascore_incidents` — Goal/Card/Sub Timeline 🟨🟥

**139.793 rows = 6856 games × ~20 events**

Per-event: `incident_type` (goal/card/substitution/period/var), `minute`, `player_id`, `goal_type`, `card_color`, `card_reason`, `scoring_team_score`, `conceding_team_score`.

| Use | Detail |
|---|---|
| 🟨 UI MatchDetail | Timeline display |
| 🟥 Backtest | Late-goal share, red-card impact analysis |
| ⬜ Future | Per-state xG (lead/trail/level) |

### 2.5 `sofascore_average_positions` — Tactical 🟨

**211.240 rows = 6856 games × ~31 players**

Per-Player: `avg_x`, `avg_y` auf Pitch [0-100]. Tactical analysis raw material.

| Use | Detail |
|---|---|
| 🟨 UI MatchDetail (planned) | Pitch heatmap visualization |
| ⬜ Future | Press-style features (high-line vs low-block diff) |

### 2.6 `sofascore_match_managers` 🟨

**13.703 rows = 6856 games × 2 managers**

Per-Game: home + away `manager_id`, `manager_name`, `manager_short_name`, `manager_slug`.

| Use | Detail |
|---|---|
| 🟨 NEUER-TRAINER tag | `scripts/_lib/matchday-enrich.mjs::deriveCoachingChangeTag` (16 vitest cases) |
| ⬜ Future | Manager-rating regressor |

### 2.7 `sofascore_pregame_form` ⬜

**13.228 rows · sometimes 404 from Sofa for older games**

Sofa's pre-match summary: `avg_rating`, `league_position`, `league_value` (points), `form` (last-5 string "WWDLW").

| Use | Detail |
|---|---|
| ⬜ Future | Form-momentum feature |

### 2.8 `sofascore_team_streaks` ⬜

**75.252 rows = 6856 games × ~11 streaks**

Per-Game: ~8 general streaks + ~3 head2head streaks. Schema: `name`, `value_text`, `value_numerator`, `value_denominator`, `team`, `continued`.

| Use | Detail |
|---|---|
| ⬜ Future | H2H momentum, scoring-streak features |

---

## 3. Engine Outputs (Backtest + Monitoring) 🟥

### 3.1 `pipeline_shadow_log` — Per-Engine Predictions 🟥

**4.193 rows · 4-5 engines per match · UNIQUE (match_key, engine_variant, predicted_date)**

Pre-match snapshot: `prob_h`, `prob_d`, `prob_a`, `prob_o25` per engine. Used für post-hoc Brier-Vergleich gegen `team_xg_history.goals_for/_against`.

### 3.2 `match_predictions` — Pre-Match Snapshot 🟥

**1.506 rows · richer than shadow_log** (lambdas + sharp odds + BTTS).

Captured on `/matchday` page-load via `savePredictionsBulk`. UNIQUE (match_key, engine).

### 3.3 `match_outcomes` — Predictions × Reality 🟥

**3.090 rows · Joined home + away rows from team_xg_history**

Generated cols: `total_goals`, `over25`, `btts`, `outcome_1x2`. Populated via `scripts/populate-match-outcomes.mjs` (cron daily). UNIQUE (match_key, match_date).

### 3.4 `live_brier_snapshots` — Time-Series Engine Performance 🟥

**195 rows · per engine × per league (incl `__overall`)**

`scripts/monitor-live-brier.mjs` cron. Joined `pipeline_shadow_log × team_xg_history`. `/health` Section 5 zeigt latest snapshot.

### 3.5 `bets` — User-Bets + CLV 🟧🟥🟨

**3 rows (small usage)**

Cols: `match_key`, `market`, `odds_placed`, `stake`, `model_prob`, `edge`, `result`, `closing_odds`, `clv`, `placed_at`, `settled_at`.

| Column | Used by |
|---|---|
| `clv = log(odds_placed / closing_odds) × 100` | 🟧 Per-Liga CLV feedback dampening |
| `model_prob`, `edge` | 🟥 Post-hoc engine accuracy |
| `result`, `stake` | 🟨 Bet-tracker UI |

### 3.6 `sofascore_extras_state` — Sync Tracker ⚪

**6.856 rows = exact ended-games count post-2026-05-10 backfill**

7 has_X flags per game. Used by `fetch_match_extras.py` for pending-detection.

---

## 4. UI / Display Tables 🟨

### 4.1 `matchdays` — Spieltag JSONB 🟢🟣🔵🟦🟨

**627 rows · 1 per Liga × refresh-cycle**

JSONB-blob `data.matches[*]` mit:
- xG history (xg_h8, xga_h8 — sums über letzte 8 games)
- form ("W W D L W")
- standings_pos, standings_points, standings_gd
- injuries (TM-scrape format), yellow_risk
- h2h (last 5 head-to-head meetings)
- tags (DERBY, MEISTERKAMPF, ABSTIEGSKAMPF, ROTATION, NEUER-TRAINER, SANDWICH)
- _openliga_match_id (DE leagues)

**Engines lesen aus matchdays.data, nicht direkt aus team_xg_history** (matchday is the prepared/canonicalized engine input).

### 4.2 `team_metadata` 🟨

**430 rows · TheSportsDB-sourced**

Logos, colors, stadium, founded_year, cross-source IDs (thesportsdb_id, api_sports_id). Cross-Liga sync best-effort (54 gaps für Reserve-Teams + austria_bl/swiss_sl/greek_sl regional clubs nicht in TheSportsDB Free-Tier).

### 4.3 `referees` ⬜

**354 rows · STUB DATA**

`fouls_per_game` alle NULL, `yellows_per_game` nur 13 distinct values, `home_yellow_bias` 1 distinct value. NICHT als Feature wired.

### 4.4 `stadiums` 🟨⬜

**278 rows · 30% join coverage**

Lat/Lng/capacity. `altitude_m` 0% populiert. Marginal value. Used UI-only when join hits.

---

## 5. Dormant Tables ⬜

| Tabelle | Rows | Status |
|---|---|---|
| `player_injuries` | 0 | api-sports Key 2 suspended; TM-injuries embedded in matchdays.data |
| `live_wp_snapshots` | 0 | Phase 3.3 — braucht Betfair-API-Key |
| `corners_odds_history` | 0 | Phase 3.1 — braucht UI-Tab |
| `player_props_posteriors` | 0 | Phase 3.2 — braucht R-service |
| `player_profiles` | 0 | future per-player aggregation |
| `live_match_events` | 0 | future live-WP feed |
| `player_props_odds_history` | 0 | Phase 3.2 partial |

---

## 6. Per-Liga Coverage Matrix

### 6.1 Sofa Extras (V1+V2 100%)

| Liga | Ended Games | xG History rows | Sofa-Tier |
|---|---|---|---|
| 🇪🇸 la_liga | 344 | 6.542 | premium |
| 🇮🇹 serie_a | 354 | 6.416 | premium |
| 🇫🇷 ligue_1 | 287 | 6.230 | premium |
| 🏴󠁧󠁢󠁥󠁮󠁧󠁿 epl | 353 | 6.104 | premium |
| 🏴󠁧󠁢󠁥󠁮󠁧󠁿 league_one | 456 | 5.799 | volume |
| 🏴󠁧󠁢󠁥󠁮󠁧󠁿 league_two | 456 | 5.679 | volume |
| 🏴󠁧󠁢󠁥󠁮󠁧󠁿 championship | 456 | 5.564 | premium |
| 🇪🇸 la_liga2 | 418 | 4.319 | volume |
| 🇮🇹 serie_b | 380 | 3.916 | premium |
| 🇳🇱 eerste_divisie | 380 | 3.800 | volume |
| 🇫🇷 ligue_2 | 305 | 3.412 | volume |
| 🇹🇷 super_lig | 234 | 3.397 | premium |
| 🇩🇪 liga3 | 367 | 3.061 | partial |
| 🇩🇪 bundesliga2 | 288 | 2.954 | premium |
| 🇩🇪 bundesliga | 294 | 2.833 | premium |
| 🇳🇱 eredivisie | 286 | 2.812 | premium |
| 🇧🇪 jupiler_pro | 286 | 2.761 | premium |
| 🇵🇹 primeira_liga | 284 | 2.739 | premium |
| 🇬🇷 greek_sl | 28 | 2.386 | premium |
| 🇨🇭 swiss_sl | 210 | 2.217 | premium |
| 🇦🇹 austria_bl | 180 | 2.200 | premium |
| 🏴󠁧󠁢󠁳󠁣󠁴󠁿 scottish_prem | 210 | 2.189 | premium |
| **TOTAL** | **6.856** | **87.330** | 16 premium / 1 partial / 5 volume |

### 6.2 Engine Tracking Coverage

| Engine | Coverage | Notes |
|---|---|---|
| 🟢 E0 Standard | All 22 Ligen | Ensemble läuft auch ohne xG-history (Elo + Logistic + Market suffice) |
| 🟣 E1 v1 Poisson-ML | All 22 (where xG-history exists) | Refuses to predict ohne per-Match xG-Historie |
| 🔵 E2 v2 LightGBM | All 22 (production) | Top-5 mit höchster Feature-Tiefe (npxg/ppda/deep), Rest mit reduzierten Features |
| 🟦 E3 v3 Lean | All 22 (preview-only, internally → v2) | Schema-equivalent zu v2, lean 20-feature variant |

### 6.3 Closing-Odds Coverage

| Source | Rows | Liga-Coverage |
|---|---|---|
| football-data.co.uk PSCH | ~24.700 (⚠ stale seit 2026-01-14) | Top-5 + Championship + 2.Bundesliga seit 2017 |
| live-odds-snapshot | ~98 (growing) | 22 Ligen seit 2026-04-26 |

---

## 7. Calibration Layer (Phase 2.x) 🟧

Wird auf alle Engines angewendet (E0/E1/E2/E3). Aktiviert via `.env` flags.

| Layer | File | Status | Wirkung |
|---|---|---|---|
| **Isotonic** | `public/calibration_curves.json` | live (`NEXT_PUBLIC_CALIBRATION_METHOD=isotonic`) | Pre-Dirichlet stable baseline |
| **Benter Blend** | `public/benter-weights.json` | live (`NEXT_PUBLIC_BENTER_BLEND=on`) | Per-Liga β₁/β₂ aus n=5586 OOT |
| **Conformal Gate** | `public/conformal-quantiles.json` | warn-mode (`NEXT_PUBLIC_CONFORMAL_GATE=warn`) | observation only, EPL drift verified |
| **Per-Liga Overdispersion** | `public/overdispersion.json` | unconditional load | Negative-Binomial α-fits per Liga |
| **Dirichlet** (DORMANT) | `public/dirichlet-calibration.json` | reverted 2026-04-27 | Drift +0.0075 Brier vs raw on n=8306 |

---

## 8. Data Flow Summary

```
                                ┌─── 🟢 ENSEMBLE (Dixon-Coles + Elo + Logistic + Market)
                                │
team_xg_history ────────────────┼─── 🟣 v1 Poisson-ML (9 features GLM)
(87k rows, 22 Ligen)            │
                                ├─── 🔵 v2 LightGBM Tweedie (21 features, production)
sofascore_shotmap ──────────────┤
(174k shots) ─── bridge ────────┼─── 🟦 v3 Lean LightGBM (20 features, preview)
                                │
sofascore_match_statistics ─────┘    
(40k rows, 18 features bridged)      → 🟧 CALIBRATION (isotonic + Benter + Conformal + Overdispersion)
                                                   │
live_odds (sharp) ────────────── Market-Vec ──────┘
                                                                  │
                                                                  ▼
matchdays (JSONB enriched: form/tags/h2h/standings/injuries) ──── User-facing Predictions
                                                                  │
                                                                  ▼
                            bets + match_predictions + pipeline_shadow_log ── 🟥 BACKTEST + CLV
```

---

## 9. Local-Only Datapoints (SQLite Mirror)

`tools/sofascore/data/local_extras.db` (340 MB SQLite, WAL mode) + raw JSONs in `tools/sofascore/data/extras/`.

**Engine-critical resilience:** Bei Supabase-Outage kann MatchdayContext (in einem hypothetischen `--local-mode` flag) auf local fallback. Aktuell wird das nicht genutzt aber das Backup ist da.

**Local SQLite Schema** spiegelt Supabase 1:1:

| Tabelle | Rows lokal | Note |
|---|---|---|
| `team_xg_history` | **87.330** | 🟢🟣🔵🟦 Primary engine input — gemirrort via `mirror_team_xg_history.py` |
| `sofascore_match` | 7.099 | 🟨⚪ |
| `sofascore_match_statistics` | 39.664 | 🔵🟦 |
| `sofascore_player_match_stats` | **279.832** | ⬜ ← Supabase skipped (Free-tier saver), lokal-only |
| `sofascore_incidents` | 139.854 | 🟨🟥 |
| `sofascore_average_positions` | 211.240 | 🟨 |
| `sofascore_match_managers` | 13.703 | 🟨 |
| `sofascore_pregame_form` | 13.228 | ⬜ |
| `sofascore_team_streaks` | 75.252 | ⬜ |

**Mirror Scripts:**
```bash
# Sofa-extras (default-on in load_extras_to_supabase.py via --local-mirror)
tools/venv/bin/python3 tools/sofascore/load_extras_to_supabase.py --all

# team_xg_history (full sync first time, incremental afterward)
tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py --reset       # full
tools/venv/bin/python3 tools/sofascore/mirror_team_xg_history.py --incremental # delta
```

Plus raw JSONs at `tools/sofascore/data/{league}_25-26.json` (per-league shotmap exports).

---

## 10. Pipeline Health (Live)

| Source | Last Update | Status |
|---|---|---|
| Supabase Sofa-extras | 2026-05-10 16:00 (backfill complete) | ✅ 100% (6856/6856) |
| Local SQLite mirror | 2026-05-10 14:00 | ✅ 99.84% (6845/6856) |
| Webshare residential | (idle) | ⚠ CF-tightening from 2026-05-09 morning still active for chrome124 |
| **tls_requests fingerprint** | 2026-05-10 13:00 verified | ✅ NEW: bypass for CF chrome124 blocks |
| odds_closing_history (live-odds-snapshot) | continuous | ✅ active |
| odds_closing_history (football-data.co.uk) | 2026-01-14 | ⚠ STALE (upstream-outage) |

---

## 11. Quick-Reference: Where is X used?

| Datapoint | Read by | Path |
|---|---|---|
| xg / xga | E0/E1/E2/E3 + UI | `MatchdayContext.loadCached` → engine-input |
| sharp odds | E0/E1/E2/E3/Calibration | `MatchdayContext` → vig-removal → Benter blend |
| matchdays.data.matches[*] | All engines | UI + pre-computed engine inputs |
| sofascore_match_managers | UI tag-derivation | `matchday-enrich.mjs::deriveCoachingChangeTag` |
| sofascore_match_statistics | E2/E3 (via bridge) | `bridge-sofascore-extras-to-team-xg.mjs` |
| sofascore_shotmap | E2 (via bridge) | `bridge-sofascore-to-team-xg.mjs` |
| pipeline_shadow_log | Backtest + /health | `monitor-live-brier.mjs` |
| bets.clv | CLV-Feedback Kelly-dampening | `clv-feedback.ts` |

---

## Appendix: Re-Ingestion of player_match_stats

Wenn später Supabase auf Pro-Plan upgegradet wird ODER engine v4 player-features braucht:

```bash
# Ohne --skip-player-stats → all 279k player rows ingested
tools/venv/bin/python3 tools/sofascore/load_extras_to_supabase.py --all
# Cost: ~250 MB DB + ~30 min single-thread
```

Storage-Schwelle: 250 MB additional → 355 MB current + 250 MB = ~605 MB → würde Free-tier sprengen, daher Pro-Plan ($25/mo) Voraussetzung.

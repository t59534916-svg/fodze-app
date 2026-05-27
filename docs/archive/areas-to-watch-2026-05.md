# Areas to Watch — Archive (2026-04 to 2026-05-21)

Historical record of completed / archived experiments + one-time infrastructure
builds that were tracked in CLAUDE.md's Areas-to-Watch table during the v4 dev
arc. Moved here on 2026-05-21 to keep the live table scannable.

Three categories:
- **One-time infrastructure builds** (Sofa backfill chain, proxy infra, mirrors)
- **Archived model experiments** (dev-04/05/06/07/08 + line-movement + shrinkage)
- **Resolved-but-noteworthy ops events** (CF bypass discoveries, advisor cleanups)

Refer back here when re-considering similar work — most of these archives
contain the "why this didn't ship" lesson in the row itself.

---

## One-time infrastructure (2026-05)

### Sofa parallel-backfill infrastructure ✅ built (2026-05-14)
Multi-process orchestrator `tools/sofascore/fetch_match_extras_parallel.py` (10 workers × pinned Webshare IPs, per-game JSON checkpoint, Circuit-Breaker 5×403→10min sleep, session-recycle every 500 fetches for tls_requests memory creep defense). Hetzner VM bootstrap `tools/sofascore/hetzner_bootstrap.sh` (5 Cent for 3-4h backfill, fresh DE IP). 2-Phase runner scripts `run_backfill_{24-25,23-24}.sh`. **Reality 2026-05-14:** Phase 3 für 24/25 Tier-A hit massive CF cascade — alle 30 Webshare IPs banned + Mac IP banned. 234/6500 games done before block. State preserved in `tools/sofascore/data/parallel_state.json` for resume. **Lessons:** CF banns scale to concurrent direct-IP fetches if same fingerprint pattern seen across pool. Future Phase 3 → Hetzner VM only. **Update 2026-05-19:** parallel_state.json `done: 8068` — backfill silently resumed and completed 11 Tier-A Ligen × 24/25.

### 24/25 + 23/24 Tier-A local backfill ✅ done (2026-05-20)
`tools/sofascore/build_local_match_table.py` erweitert mit `--season` (24-25, 23-24, all) und `--with-shots` flags. Loaded aus existing `data/*_{24-25,23-24}.json` checkpoints — null Sofa-API-Calls nötig. Result: 3-Saison-Coverage lokal komplett (alle 11 Tier-A-Ligen × 23/24 + 24/25 + 25/26): **15.237 matches, 373.804 shots, 14.751 shotmap-games, 14.689 positions-games (Heatmaps!), 14.858 player_match_stats-games, 14.848 match_statistics-games**. Tier-B 24/25 + 23/24 (11 Ligen) still pending complete Phase 1+2+3 backfill (Hetzner-VM-Sprint required, ~16h).

### Webshare residential proxy bypass ✅ live (2026-05-09)
Cloudflare blockte direkten + Tor-API-zugriff auf Sofa-v2-endpoints. Webshare Static Residential ($6/Mo, 20 IPs, 250GB) umgeht das — alle 20 IPs HTTP 200 verified, 2.2s/game. `--use-webshare` flag in fetch_match_extras.py + sync + backfill scripts. Auto-fallback rotiert proxy bei 403 statt 30min backoff cascade. Plan: Backfill in Monat 1 ($6) komplett durchziehen, dann auf free-tier downgraden für daily incremental.

### Sofascore extras v1+v2 backfill ✅ 100% complete (2026-05-10)
**6856/6856 ended games** mit allen 7 endpoints in Supabase + lokal SQLite. Total 493k Supabase rows + 279k lokal-only player_match_stats. Bypass via tls_requests fingerprint.

### Sofascore extras v1 (post-match stats) ✅ shipped (2026-05-07)
4 endpoints (`/event/{id}/{statistics,lineups,incidents,average-positions}`) → 4 tables. 736 games gepulled, 4256 match-stat rows + 29.5k player-match-stats incl. xA/key-passes/touches_in_box. Bridge propagiert 18 neue feature-columns auf `team_xg_history`.

### Tier-B Sofascore backfill ✅ complete (2026-05-05)
Alle 11 Tier-B-Ligen jetzt in `sofascore_match`. Cloudflare-unblock nach 24h-cooldown — am 2026-05-05 sequenziell mit `--pace 4.0` erfolgreich nachgezogen: austria_bl (181 m × 4413 shots), swiss_sl (218 m × 5990 shots), scottish_prem (222 m × 5384 shots), jupiler_pro (315 m × 7484 shots), super_lig (240 m × 6033 shots). Alle 99.2-99.7% xG-fill + assisted/fast-break tags → tier=premium. Inkl. Playoff/Splitt-Rounds.

### Supabase advisor cleanup ✅ all 15 ERRORs cleared (2026-05-09)
RLS aktiviert auf 10 Sofa-Tables + allow-anon-read policy; 5 Sofa-Views auf SECURITY INVOKER (außer rolling_8); 2 Functions explicit search_path. Self-review verifiziert: alle algorithm + AI calculation paths intakt, trigger feuert, service-key writes funktionieren. 21 verbleibende WARNs sind alle intentional pattern (service-write `WITH CHECK (true)`, infrastructure SECURITY DEFINER funcs).

---

## Archived model experiments

### v4 dev-04 archived — Regression (2026-05-14)
β8 sprint added `market_disagreement_flag` (mean(\|p_proxy_skellam − p_market_shin\|/p_market)) + binary `_high` (>0.08 threshold) = **18 features**. **Catastrophic regression**: Brier 0.6453 (+0.0252 worse), Stage 5 ROI -3.04% (Δ -6.39pp vs dev-03 +3.35%). Root cause: (1) Coverage-Sparsity (only 7.1% of training matches had Pinnacle odds — team-name canonicalization missing for cross-source join), (2) Skellam-proxy systematically underestimates P(D) vs Dixon-Coles → 90% of holdout matches trip threshold = not selective, (3) Binary `_high` feature is dead weight (\|SHAP\|=0.0011). Artifacts: `tools/v4/artifacts/m3_xg-{home,away}-dev-04.pkl`.

### v4 dev-05 archived — Same Sparsity-Trap (2026-05-14)
β9 sprint added `lineup_quality_player_diff` + `_available` via `PlayerLineupCalculator` (Understat 24/25, top-11-by-minutes starters) = **20 features**. **Repeated dev-04 trap**: training-coverage 9.3% (Top-5 only) vs OOS-coverage 32% (24/25 includes Lower-17 with 0). Trees learned "ignore feature in 90% case" → at inference player-signal added noise. Brier +0.0293 worse on 24/25 OOS vs dev-03. HC ROI **LOST statistical significance**. **Lesson**: sparsity >80% in training corpus = feature-dead-on-arrival trap. Solutions for future: (a) train Top-5-only model, (b) Sofa-backfill 24/25+23/24 ALL leagues first to raise training coverage, (c) post-hoc calibration layer instead of m3-feature. Tool: `tools/v4/modules/m3_xg/player_lineup.py` (kept for future Top-5-specific model).

### v4 dev-06 Option C "Specialist+Generalist Ensemble" ❌ archived (2026-05-21, post Sprint 3)
Architektur: m3_lean unverändert dev-03 (16 features, alle Ligen) + m3_premium specialist auf 7 always-premium Ligen × 3 Saisons (~7400 matches, 9 Sofa-extras-Features) + Coverage-aware Router. **Sprint 1 (2026-05-20)**: foundation gebaut (`coverage_router.py` 19 tests + `premium_features/` 1 impl + 8 stubs + `feature_builder_premium.py` 10 tests). **Sprint 2 (2026-05-21)**: 8 stubs implementiert, 4116 training matches × 29 features trained, 5 bagged LightGBM per home/away. **Sprint 3 (2026-05-21) — Brier-Gate failed**: lean (dev-03) Brier 0.6089, blended (lean+premium 0.7 weight) Brier 0.6131 = **Δ +0.0042 schlechter**. Weight-sweep [0.0..0.7] zeigt monotone Verschlechterung. **Premium specialist trägt null Signal**. Archive: `tools/v4/artifacts/_archived/m3_xg-{home,away}-dev-06-premium.pkl`.

### v4 dev-06 Feature-Ablation Study ✅ definitive verdict (2026-05-21)
Post-Sprint-3 rigorose Frage: sind die 9 Premium-Features individuell signal-tragend oder structural-redundant? **Phase A (gain-importance)**: Premium-features take 39.3% gain-share, lean 59.7%, league-cat 1.0%. Model HAT premium features genutzt (nicht ignored), aber wahrscheinlich für noise-fit. **Phase B (per-feature retrain)**: 9 separate ensembles trainiert (lean_20 + JE 1 premium). Beste Verbesserung `attack_position_y_diff` Δ **+0.0002** (= keine Verbesserung). Alle anderen +0.0008 bis +0.0024. **ZERO of 9 features improve lean on holdout.** All-9-combined: Δ +0.0023. **Verdict**: Sofa-extras-features are NOT independent signals — Information ist VOLLSTÄNDIG in lean's xG-history-derived features gefangen. **Recommendation**: stop investing in m3_premium-style architectures; sofa-extras are productively used as INPUTS to existing lean features (via team_xg_history bridge for 16 cols since 2026-05-07) but NOT as additional model features. Future v4-gains will come from m4/m5 (set-piece + filter modules), better Calibration, oder fundamentally-new data-sources (lineup-confirmed-22-players, in-play live-WP, Betfair odds-deltas). Tools: `tools/v4/diagnostics/{dev06_feature_importance,dev06_phase_b_ablation}.py`.

### dev-07 Pinnacle line-movement signal study ❌ archived (2026-05-21)
Migration `add_pinnacle_opening_odds_to_odds_closing_history`: psh/psd/psa columns + CHECK >1.0. Backfill `scripts/backfill-football-data-co-uk.mjs` (out of `_archive/`) für 22/23-25/26 × 16 Ligen = **18.937 matches × 99%+ PSH-coverage**. **Drift ist REAL signal aber zu schwach für ship.** Validation chain: (1) ablation single-run Δ=-0.0046. (2) 6-test follow-up: Bootstrap CI straddles 0 (P=0.79), 5-seed mean Δ=-0.0039 ±0.0022 all-negative-direction, permutation test (real vs shuffled gap +0.0045 = real info), OOD 22/23 holdout Δ=-0.0019 replicates. Per-league split: drift hilft 8/13, schadet 5/13. (3) dev-07 production test: v1 fuzzy bridge (13% coverage) Δ -0.0013 vs dev-03. (4) Bridge-fix via canonical_team_map.py (43% coverage): Δ **-0.0008** vs dev-03. **Improvement halbierte sich als bridge 3× besser wurde** — zusätzliche bridged matches sind dominiert von leagues wo drift verschlechtert. **Final verdict**: drift signal real aber kleiner als run-to-run-noise (std 0.0022) wenn applied uniform across leagues. Could be salvaged via per-league drift weighting OR drift-as-calibration-correction (post-hoc). Reusable tools: `scripts/{backfill-football-data-co-uk,dump-canonical-team-map}.mjs`, `tools/v4/modules/m3_xg/canonical_team_map.py`, `tools/v4/diagnostics/line_movement_{ablation,validation}.py`.

### dev-08 Energy/Freq/CSD ❌ archived pre-training (2026-05-21)
Hypothesis-driven exploration der "Energie · Frequenz · Schwingung · Noise · Critical Slowing Down" First-Principles aus user-supplied PDF. 5 features operationalized als pure-functions auf `team_xg_history`: `schwingung_amplitude` (range goal_diff last-8), `frequenz_total_goals` (mean gf+ga last-10), `energie_match_intensity` (mean xg × mean xg+xga last-5), `noise_xg_discrepancy` (|xg-goals|/xg last-8), `csd_autocorr_lag1` (lag-1 autocorr last-10). **Phase A Step 1** single-seed Brier-Gate: 2 winners (frequenz Δ=-0.0012, energie Δ=-0.0019). **Phase A Step 2 Bootstrap** (5 seed-sets × 5 ensembles): mean Δ +energie -0.0010 ± 0.0013, +top2 -0.0016 ± 0.0013 (1.2σ MARGINAL), +all5 -0.0008 ± 0.0012 (noise). Inter-seed std 0.0019-0.0024 LARGER than effect size. Per-league: hilft la_liga -0.0039, ligue_1 -0.0066; **HURTS serie_a +0.0023** (validated-edge league!). **Bootstrap correctly rejected dev-08 BEVOR Training startete** (saved ~4h sprint, 5th confirmation of "higher-order-statistics on xG-history are redundant"). **Alternative idea (not pursued)**: CSD autocorr concept fits naturally with v1.1 Asymmetric Negation Protocol as a Goldilocks-VETO signal ("rising autocorr in last-10 = approaching regime shift = skip bet"). Reports: `tools/v4/diagnostics/{energy_freq_signal_discovery,energy_freq_bootstrap_tier_a}.json`.

### Post-Processing Shrinkage 🟡 evaluated, not deployed (2026-05-14)
α-sweep [0.0, 0.6] on dev-03's blended probs: pull toward market when `disag_flag > 0.08`. **α=0.20 optimal for Stage 5**: ROI +3.35% → +6.10% [-4.77, +16.95] n=708. **But:** trade-off — HC ROI +10.77% → +0.31% (lost significant subset), [0.68, 0.72) gap +6.35pp → +22.15pp (overcorrection). Multiple-testing selection-bias adds ~1.5pp inflation → realistic +4.5%. **NOT auto-deployed** — dev-03 baseline already +3.51% OOS-confirmed. Tool: `tools/v4/diagnostics/dev03_shrinkage_tuning.py`.

---

## dev-03 TS-runtime sprints (consolidated history)

Three sprints + ops shipped on 2026-05-21, now consolidated to a single live row in CLAUDE.md. Full per-sprint deltas:

### Sprint 1 — runtime foundation ✅ (2026-05-21)
LightGBM Bayesian-Ensemble inference + m6_benter blend browser-runnable. `tools/v4/export_dev03_to_json.py` dumped 5+5 bagged Tweedie boosters + pandas_categorical mapping + m6_benter per-league weights nach `public/dev03-model.json` (7.48 MB, slim-tree pruning). `src/lib/dev03-runtime.ts` mirrors `lgbm-runtime.ts` mit: 5-model bagging (mean + population-variance ddof=0), categorical-split handling via `pandas_categorical[0]` alphabetical lookup, `dev03BenterBlend` log-pool softmax mit per-league fallback chain. 43 vitest cases.

### Sprint 2 — feature builder + cache ✅ (2026-05-21)
TS-Port von m2_lambda + Elo + Momentum-Lookup über precomputed cache. `tools/v4/export_feature_cache.py` → `public/dev03-feature-cache.json` (105.6 KB: 22 league-constants + 800 Elo + 796 momentum + 22 norms). `src/lib/dev03-features.ts` (~400 LOC): EWMA primitives, compute_team_strength, lookup helpers, orchestrator `buildDev03Features()`. 40 vitest cases.

### Sprint 3 — MatchdayContext routing ✅ (2026-05-21)
dev-03 als 5. PredictionEngine vollständig wired. `src/lib/dev03-engine.ts` MatchCalc wrapper, engine-registry update mit "v4 dev-03", AppContext bootstrap loaders, MatchdayContext `computeAllEngines` jetzt 5 Engines parallel cached, `processed` selector routes correctly. Engine-Selektor UI erscheint automatisch via ENGINES array iteration. `npx next build` clean.

### Ops — cache cron + retrain orchestrator ✅ (2026-05-21)
(1) Weekly cache refresh: neue Phase `dev03-cache` in `scripts/refresh-all.mjs`, `abortOnFail: false`. (2) Post-retrain orchestrator `tools/v4/refit-dev03-artifacts.sh`: export_dev03_to_json → export_feature_cache → generate_dev03_features_golden → vitest parity. Exit 3 bei parity-fail. `--skip-golden` flag verfügbar.

---

## Lessons Index

Common patterns from the archived experiments:

1. **dev-04/05/06**: feature-coverage-sparsity in training corpus < 80% → feature-dead-on-arrival
2. **dev-07**: aggregate Brier-gain that halves when bridge-coverage triples → per-league heterogeneity hidden in average
3. **dev-08**: single-seed Brier-improvement < ~1σ of inter-seed variance (0.002) → run-noise, not signal
4. **All five**: tree-feature additions of derived statistics on team-quality data are info-redundant with lean's mean-feature set

The Bootstrap-Validation-Before-Training methodology (dev-08 Phase A Step 2) is the operational lesson — never ship a model based on single-seed Brier-improvement again.

### Sofa Phase-2 multi-season backfill sprint — ops empirical findings (2026-05-26 → 2026-05-27)

**Outcome**: per-season slim-3 (statistics + lineups + average_positions) endpoint
coverage brought from baseline (22/23 45%, 23/24 92%, 24/25 97%, 25/26 100%) to
**near-complete (95-97% across all 4 seasons)**. +5,404 enriched cache JSONs added
in 26 hours of compute via three sequential chain runs.

**Run sequence + empirical capacity**:

| Run | Start | Mode | Games attempted | Successful | Duration |
|---|---|---|---|---|---|
| **chain v1** (Mac-IP direct) | 2026-05-26 12:27 | curl_cffi chrome124, no proxy | 3,710 | **598** | ~25 min before CF block |
| **chain v2** (Webshare 30-IP) | 2026-05-26 12:59 | proxy rotation | 4,178 | **~3,110** | 4.5h, killed at pool burnout |
| **chain v3** (Webshare after 17h cool-down) | 2026-05-27 11:00 | proxy rotation | 597 of 706 | **~499** | killed at game 597 |

**Key empirical findings**:

1. **Mac-IP-direct works in bursts but does NOT sustain.** ~600 games max before
   CF flags the user-IP. Appropriate for lineup-fetcher use (N=10-50 games/hour);
   useless for backfills (N=1000+).

2. **Webshare 30-IP pool capacity DIMINISHES per cycle.** First fresh-burst
   sustained ~2,500-3,000 games; after 17h cool-down only ~500 before dead.
   Each cycle on the same pool reduces effective capacity — Sofa CF appears to
   memorize IP fingerprints across days.

3. **17h cool-down is insufficient.** Pool needs **days** to fully recover, not
   hours. The 6-12h heuristic in earlier docs was over-optimistic.

4. **No false-rotation behavior.** Script's proxy rotation triggers on 407 errors
   but timeouts (curl 28) don't fire rotation. Pool can be "dead" while script
   thinks it's still working — silent throughput death. Manual kill required when
   `last 30 games = 0% success`.

5. **Forward path for last 1-3% coverage gap** — only viable paths:
   - **$25/mo Webshare Rotating-Residential plan** — unlimited fresh IPs, ~1-2h
     to reach 100%
   - **Hetzner VM with fresh IP** — one-shot solution, ~$5
   - **Week-long retry** with free 30-IP pool — risky, may still hit diminishing
     capacity
   - **Accept 95-97% as "good enough"** — gaps uniformly distributed, no Liga-bias,
     <3% of corpus; engine training already well-served

**Verdict**: 96-97% multi-season Phase-2 coverage is **the achievable ceiling on
free-tier proxy resources**. Last few percentage points cost more than they're
worth for engine training (per Phase-A+B ablation 2026-05-21 which found
sofa-extras-features are not independent signals beyond xG-history-derived
lean features).

**Reusable artifacts**:
- `tools/sofascore/run_sofa_backfill_chain.sh` — 3-stage sequential chain
  orchestrator with 90s cool-downs
- `tools/sofascore/logs/chain-webshare-*.log` — per-run metadata (start, stage
  transitions, kill timestamps)
- `tools/sofascore/logs/sofa-{2223,2324,2425}-slim3-webshare-*.log` — per-stage
  game-by-game output with success/failure markers

**Tasks**: D-4 (chain v1), D-5 (chain v2), D-6 (chain v3) — all marked completed
with PARTIAL status in task list.

### dev-03 multi-season retrain attempted (2026-05-27)

**Trigger:** User requested fresh dev-03 retrain on expanded multi-season corpus
(2022-07-01 → 2025-08-01, n=48,630 team-rows, +1,238 vs 2026-05-22 production).

**First attempt (failed):**
- `train_m3_xg.py --since 2022-07-01 --cutoff 2025-08-01 --tag dev-03` produced
  21-feature pickle (market_disagreement_flag, market_disagreement_high,
  lineup_quality_player_diff, lineup_quality_player_available added by dev-04/05
  sprints to NUMERIC_FEATURES but never made it into FEATURES_LOCKED)
- `refit-dev03-artifacts.sh` caught schema mismatch via
  `export_dev03_to_json.py::FEATURES_LOCKED` gate → ValueError
- Restored 2026-05-22 production artifacts; reverted public/dev03-*.json

**Second attempt (proper, with --features-locked):**
- Added `--features-locked` CLI flag + `DEV_03_LOCKED_FEATURES` constant to
  `train_m3_xg.py` (mirrors `FEATURES_LOCKED` in export script)
- Retrained as `dev-03-fresh` with locked 17-feature schema
- `fit_benter.py --tag dev-03-fresh --m3-tag dev-03-fresh` produced compatible
  per-Liga β weights

**Stage-1 holdout comparison (25/26):**

| Tag | Brier | Δ vs v2_benter | G1 ship-gate |
|---|---|---|---|
| dev-03 (production, 2026-05-22) | 0.6141 | -0.0053 | ✓ cleared |
| dev-03-fresh (2026-05-27) | 0.6133 | -0.0061 | ✓ cleared |
| **Δ fresh − production** | **-0.0008** | — | sub-noise (< 0.002 threshold) |

Per-Liga: 10 leagues improved, 6 worsened (mixed direction = consistent with
random variance, not systematic improvement).

**Decision: KEEP PRODUCTION, ARCHIVE FRESH.**

Reasoning:
1. Δ -0.0008 is below the 0.002 single-seed-noise threshold per CLAUDE.md
2. Mixed per-Liga direction shows no systematic signal
3. Both pass G1 ship-gate so neither model is broken
4. 1.4% data growth (1,238 / 91,237 rows) wasn't expected to move Brier
   above noise floor anyway

**Action taken:**
- `dev-03-fresh` artifacts moved to `tools/v4/artifacts/_archived/` for
  forensic record
- Production `dev-03` artifacts unchanged
- `public/dev03-*.json` unchanged
- `train_m3_xg.py --features-locked` patch committed (single value-add of
  the sprint: future-proofs against schema-drift recurrence)

**Reusable lesson:** When `train_m3_xg.py` evolves to add new features to
`NUMERIC_FEATURES`, the matching `FEATURES_LOCKED` in `export_dev03_to_json.py`
+ `dev03-features.ts` must move together OR a `--features-locked` flag must
be used to retrain with the older schema. The two-list synchronization is
the architectural invariant; running production-target retrains without
`--features-locked` is now flagged as user-error (or use a higher-versioned
tag like dev-04 to ship the new schema through 5-Gate first).

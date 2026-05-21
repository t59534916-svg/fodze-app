# V4 Hybrid — Backtesting Protocol (V2)

**Stand:** 2026-05-12 (V2 — fixes critical gaps from self-eval) · **Scope:** Active modules 1+2+4+6+7 (pre-match). Stub modules 3+5 (live regime/intensity) have interface tests only.

**V2 Changes:**
- Fix 1: Modul 7 Bayesian Kelly mathematisch spezifiziert
- Fix 2: Stage 3 walk-forward an Data-Heterogeneity adaptiert (tiered)
- Fix 3: G7 wording korrigiert (logischer Widerspruch behoben)
- Fix 4: G2 ECE threshold straffer (≤ 0.01)
- Fix 5: Per-Liga n-minimum für G3
- Fix 6: Module 4 training data spezifiziert
- Fix 7: Conformal re-fitting in Stage 4
- Fix 8: Saison-Kalender-aware shadow timing
- Fix 9: v3 als zweiter Benchmark
- Fix 10: Rollback-Pfad nach Shadow-Failure
- Fix 11: Per-Liga vs Global Model decision frozen
- Fix 12: Realistische Timeline mit Sommerpause

## Architektur-Decision (Fix 11)

**v4 nutzt EIN globales LightGBM model** mit Liga als categorical feature (One-Hot ODER ordinal liga-tier encoding). NICHT per-Liga sub-models.

Begründung:
- Sample-efficiency: 87k team-match rows verteilt auf 22 Ligen → bei sub-models nur 4k pro Liga (Tier-B würde noise overfitten)
- Cross-Liga learning: Promoted teams (e.g. Bundesliga2 → Bundesliga) brauchen Wissen-Transfer
- Maintenance: ein Model deploy vs 22 — entwicklungsökonomisch besser
- Per-Liga Heads sind Phase 2 optimization wenn global model > 0.65 in einer Liga (G3 trigger)

## m3 Bayesian Ensemble Definition (Fix 13 — moved from m6 in V3 revision)

"Bayesian Ensemble" lebt in **m3_xg** (model-side, nicht market-side): 5 LightGBM-Modelle mit verschiedenen seeds + bagged sample (80% rows, sampled-with-replacement). Predictions als ensemble-mean, variance aus inter-model-disagreement. Approximiert posterior ohne MCMC (computational tractability).

```python
# tools/v4/modules/m3_xg/bayesian_ensemble.py
def bayesian_ensemble_predict(models, X):
    preds = [m.predict(X) for m in models]
    mean = np.mean(preds, axis=0)
    var = np.var(preds, axis=0)
    return mean, var  # → consumed by m6_market (blend) → m7_kelly (variance-shrinkage)
```

`σ²_hat` aus diesem Ensemble feeds m7's variance-shrinkage. m6 nimmt nur `p_hat` für Benter-blend (market layer kennt keine model-uncertainty).

## Modul-7 Robust Bayesian Kelly Algorithmus (Fix 1)

**Vollständig spezifiziert** für Implementation:

```
Input:
  p_hat   = Posterior mean       (from m6 market-blended, originally from m3 Bayesian Ensemble)
  σ²_hat  = Posterior variance   (DIRECT from m3 Bayesian Ensemble — m6 doesn't propagate σ²)
  o       = decimal odds (vig-removed from Pinnacle sharp)
  profile = K (conservative) / M (moderate) / A (aggressive)
  α       = variance-shrinkage parameter (default 1.0, tuned empirically)

Step 1: Vanilla Kelly (point estimate)
  edge = p_hat × o - 1
  f_vanilla = edge / (o - 1)             if edge > 0
            = 0                          otherwise

Step 2: Bayesian Variance Shrinkage
  # Tighter posterior (low σ²) → trust more → Kelly closer to vanilla
  # Wider posterior (high σ²) → shrink → smaller bet
  shrinkage = 1 / (1 + α × σ²_hat / p_hat²)
  f_bayesian = f_vanilla × shrinkage

Step 3: Robust Cap per Profile
  f_cap = {K: 0.025, M: 0.040, A: 0.060}[profile]
  f_robust = min(f_bayesian, f_cap)

Step 4: Edge-Gate (Goldilocks)
  # Skip if edge outside per-Liga Goldilocks band
  goldilocks_min, goldilocks_max = LIGA_GOLDILOCKS[league][profile]
  if not (goldilocks_min ≤ edge ≤ goldilocks_max):
    return 0  # don't bet

Step 5: CLV-Feedback Dampening (preserved from current)
  # Same as current: per-Liga last-40-bets z-score < -1 → halve f
  if current_clv_zscore(league) < -1:
    f_robust *= 0.5

Output:
  stake_fraction = f_robust   (∈ [0, f_cap])
  expected_value = stake × edge × bankroll
```

**Tuning Protocol für α:**
- Grid-search over α ∈ {0.5, 1.0, 1.5, 2.0, 3.0}
- Objective: maximize log-bankroll-growth-rate over 25/26 simulated betting (Stage 5)
- Cross-validate on 23/24 + 24/25 (no current-season leakage)

**Why variance-shrinkage vs Half-Kelly?**
- Half-Kelly applies uniform 50% reduction
- Variance-shrinkage applies CONTEXT-DEPENDENT reduction: tighter posteriors get less shrinkage
- Better for differentiating high-confidence vs low-confidence bets

---

## Architektur-Recap (Hybrid Mode)

> **V3 architecture revision (2026-05-12):** Skeleton splits old "Module 1 monolith" (was: LightGBM produces λ + score-grid + calibration) into three decoupled layers. Bayesian-Ensemble moved m6→m3 (model-side concern). m6 is now purely market-blending. Module numbering matches `tools/v4/modules/` directory.

| Modul | Aktiv | Output | Backtest-Methode |
|---|---|---|---|
| **m1_score** (helper) | ✅ | Score-grid M[h,a] aus (λ_H, λ_A, ρ) via Dixon-Coles / NegBin + coarse-graining (1X2, O/U, BTTS, AH) | Math-Identitäten (DC↔Poisson@ρ=0, AH(0)=1X2, ρ-MLE recovery) — siehe `pipeline/stage_1_m1_score.py` |
| **m2_lambda** | ✅ | (λ_h, λ_a) aus xG-EWMA + rest/form/fatigue proxy | Feature-lab gates + monotonic-constraint validation + ablation |
| **m3_xg** | ✅ | LightGBM Tweedie head + isotonic + **5-seed Bayesian Ensemble** → (p_hat, σ²_hat) per market | Brier + LogLoss + ECE vs v2_benter; ensemble σ² sanity |
| **m4_set_pieces** | ✅ | P(goal\|set-piece-shot) → expected_setpiece_goals per match (feature in m3) | Per-set-piece outcome accuracy, ECE binned by predicted-prob |
| **m5_filters** | ⏸ stub | Pre-match: regime_id=1 + λ(t)=λ_total/90. Live (future): PDMP regime detector + Neural Hawkes | Interface-test only (returns constants) |
| **m6_market** | ✅ | Vig-removed sharp probs (Shin) + Benter blend (β₁/β₂ per Liga) → final posterior fed to m7 | Per-Liga blend-weight grid-search vs market-only baseline |
| **m7_kelly** | ✅ | f* (stake fraction), EV, bankroll trajectory | Bankroll-simulation auf 25/26 + 1000-bootstrap CLV CI |

---

## Ship-Gates (alle müssen passieren)

| Gate | Threshold | Source |
|---|---|---|
| **G1: Brier 1X2 vs v2_benter (production baseline)** | ≤ -0.003 (v4 better) | `score_current_season.py` |
| **G1b: Brier 1X2 vs v3 lean (second benchmark)** | ≤ v3 (v4 must at least match v3) | `score_current_season.py` |
| **G2: ECE per market (Fix 4)** | ≤ 0.01 (vs current v2_dirichlet 0.0049 baseline). Specifically: ≤ 0.005 for 1X2, ≤ 0.010 for O25/BTTS | new `compute_ece.py` |
| **G3: Per-Liga max-Brier (Fix 5)** | For Ligen with n ≥ 100 in OOT: max Brier ≤ 0.65. For Ligen with 28 ≤ n < 100: max Brier ≤ 0.68 (sample-noise tolerant). For Ligen with n < 28: excluded from gate | per-Liga audit |
| **G4: Cross-season MODEL-OUTPUT drift** | Brier σ across walk-forward folds < 0.020 (was incorrectly worded as "0.10 corr-shift" in V1 — that was feature-level, not model-level) | walk-forward |
| **G5: Conformal coverage post-refit** | Re-fit conformal on v4 OOT first, then validate coverage 1-α ± 0.02. Conformal artifact `public/conformal-quantiles-v4.json` (not v2's). | `validate_conformal_drift.py` (extended) |
| **G6: CLV simulated bootstrap-CI** | Median CLV across 1000 bootstrap-resampled bet-sequences > +0.5% per bet. ROI 95%-CI lower bound > 0 (positive EV statistically) | new `simulate_m7_kelly_clv.py` |
| **G7: Shadow-mode Brier (Fix 3)** | v4 shadow Brier ≤ v2 production Brier × 1.005 (confirms expected improvement; small tolerance for sample-noise but directionally CORRECT, not "within"). I.e. v4 ≤ ~0.628 if v2 ≈ 0.625 | `pipeline_shadow_log` cron |

---

## 6-Stage Backtesting Gauntlet

### Stage 0: Pre-Train Sanity Checks

**Pflicht VOR jedem Training-Run.** Verhindert leakage + schema drift.

```bash
# 0a. Data leakage test (poison-row method)
pytest tools/feature_lab/test_leakage.py -v

# 0b. Schema validation — alle erwarteten Sofa-tables in local SQLite?
tools/venv/bin/python3 -I tools/v4/validate_schema.py

# 0c. Coverage check per Liga
tools/venv/bin/python3 -I tools/v4/coverage_audit.py
```

Pass: 100% tests green, alle required tables present, per-Liga coverage > 80%.

---

### Stage 1: Per-Module Isolation

Jedes Modul wird einzeln getestet gegen einen known baseline.

#### m1_score (Dixon-Coles math layer)
- **Test:** math identities (Poisson mass capture, DC↔Poisson at ρ=0, AH(0)=1X2, ρ-MLE recovery on synthetic data)
- **Metrik:** numerical precision (1e-9 tol on identities, ±0.025 on MLE recovery)
- **Pass:** all 13 sanity tests green
- **Status:** ✅ done 2026-05-12 (13/13 pass)

```bash
tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m1_score.py
```

#### m2_lambda (Lambda Estimator with Fatigue/Form proxy)
- **Test:** ablation — remove rest_days_diff + npxg_momentum from m3 LightGBM input
- **Metrik:** Brier-delta
- **Pass:** m2_lambda features collectively must add ≥ 0.001 Brier improvement

#### m3_xg (LightGBM Baseline + Bayesian Ensemble)
- **Train:** team_xg_history (lokal SQLite, alle 22 Ligen, pre-25/26 cutoff)
- **Test:** 25/26 holdout
- **Baseline:** v2 production (same data window)
- **Metrik:** Brier 1X2 + LogLoss + ensemble σ² sanity (no σ²=0 except for fully-degenerate matches)
- **Pass:** Brier ≤ v2 + 0.005 (must at least match — improvement comes from later modules)

```bash
tools/venv/bin/python3 -I tools/v4/train_m3_xg.py --validate-only
```

#### m3_xg Post-Calibration (Isotonic + ECE validation)
- **Test:** Apply isotonic to LightGBM ensemble-mean outputs; verify σ² distribution non-degenerate
- **Metrik:** ECE pre vs post-calibration; σ² spread (no σ²≈0 except for known-degenerate matches)
- **Pass:** ECE drops by ≥ 50% relative (e.g. 0.015 → ≤ 0.0075)

```bash
tools/venv/bin/python3 -I tools/v4/test_m3_calibration.py
```

#### m4_set_pieces (XGBoost) — Fix 6: detailed spec

**Training Data Pipeline:**
```python
# Source: sofascore_shotmap (local SQLite mirror)
# Filter to set-piece-context shots:
WHERE situation IN ('corner', 'free-kick', 'set-piece', 'penalty')

# Expected sample size (24/25 + 25/26 season):
#   Penalty: ~600/season × 2 = 1.2k samples (conversion ~75%, high target-base-rate)
#   Corner-related: ~12k/season × 2 = 24k samples (conversion ~3%)
#   Free-kick: ~3k/season × 2 = 6k samples (conversion ~7%)
#   Total: ~31k set-piece shots (vs 174k all shots)
```

**Features (5 per shot):**
1. `situation` (one-hot: corner / free-kick / set-piece / penalty)
2. `body_part` (one-hot: left_foot / right_foot / head / other)
3. `shooter_x_normalized` (distance from goal, 0-1)
4. `shooter_y_normalized` (angle/lateral position, 0-1)
5. `minute_bucket` (0-15, 15-30, 30-45, 45-60, 60-75, 75-90 — captures late-game effects)

**Target:** `goal_outcome ∈ {0, 1}` from sofascore_shotmap.goal_type IS NOT NULL

**Train/Test Split:**
- Train: 2024/25 + 25/26 first 75% by date
- Test: 25/26 last 25%
- ~24k train, ~7k test (sufficient sample for XGBoost)

**Architecture:**
- XGBoost binary classification
- max_depth=4, n_estimators=200, learning_rate=0.05
- early_stopping_rounds=30
- Optional: monotonic constraint on shooter_x (closer = higher P(goal))

**Pass criteria:**
- Log-loss < league-avg-conversion baseline by ≥ 5% relative
- ECE < 0.03 (binned by predicted-prob deciles)
- Per-situation calibration: penalties ~0.75 actual vs predicted, corners ~0.03, FKs ~0.07

**Output for m3 integration:**
- Per-match: aggregate `expected_setpiece_goals = sum(P(goal|shot) × n_shots_of_type)` per team
- This becomes a feature in m3_xg's LightGBM (replaces hand-crafted `setpiece_xg_share` from v2)

```bash
tools/venv/bin/python3 -I tools/v4/train_m4_setpiece.py --train-window 2024-08-01:2026-02-01 --test-window 2026-02-01:2026-05-12
```

#### m5_filters (Stubs — regime + intensity)
- **Test:** Interface contract only — pipeline läuft mit stubs ohne errors
- **Stub behavior:** `detect_regime()` returns `regime_id="pre_kickoff"`; `get_intensity()` returns λ(t)=λ_total/90 (constant)
- **Pass:** Pipeline `run_v4_pipeline.py` exits 0 mit stubs

#### m6_market (Shin Vig-Removal + Benter Blend)
- **Test:** Apply Shin (vig-removal) + Benter blend (per-Liga β₁/β₂) to m3 outputs
- **Metrik:** Brier delta vs unblended m3 + vs market-only baseline; blend-weight grid-search per Liga
- **Pass:** Combined m3+m6 Brier ≤ raw m3 Brier (blend must not hurt) AND ≤ market-only Brier - 0.005

```bash
tools/venv/bin/python3 -I tools/v4/test_m6_market.py
```

#### m7_kelly (Robust Bayesian Kelly)
- **Test:** Simulate bankroll evolution on 25/26 settled bets
- **Inputs:** m6-blended p_hat (mean) + m3-direct σ²_hat (variance), closing odds
- **Baseline:** Current K/M/A profile with bootstrap-CI haircut
- **Pass:** Bayesian Kelly bankroll-growth-rate ≥ baseline by ≥ 10% relative

```bash
tools/venv/bin/python3 -I tools/v4/simulate_m7_kelly_clv.py
```

---

### Stage 2: Diagnostic Gates (feature_lab-style)

Every new v4-feature must pass the 5-gate diagnostic from feature_lab/select.py:

| Gate | Threshold |
|---|---|
| partial_r² vs v2-baseline | > 0.005 |
| max_corr_baseline | < 0.70 |
| per_league_corr_std | < 0.30 |
| cross_season_drift | < 0.10 |
| iterative VIF | < 5.0 |

```bash
# Run on every batch of new v4 features
tools/venv/bin/python3 -I tools/feature_lab/build_features.py --v4-mode
tools/venv/bin/python3 -I tools/feature_lab/diagnose.py
tools/venv/bin/python3 -I tools/feature_lab/select.py
# Check tools/feature_lab/reports/accepted_features.json
```

Pass: each gated feature passes all 5 gates. Reject features that don't.

---

### Stage 3: Walk-Forward Brier (Temporal CV) — Tiered (Fix 2)

**Data-Heterogeneity-aware walk-forward.** Drei tier basierend auf verfügbarer Saisons-Tiefe:

**Tier-A (data-rich, 5-fold walk-forward):**
- Ligen: epl, la_liga, serie_a, ligue_1, bundesliga, eredivisie, championship
- Daten: Understat + FootyStats von 2017/18 verfügbar
- Walk-forward:
  ```
  Fold 1: train 2017/18-2020/21  → test 2021/22
  Fold 2: train 2017/18-2021/22  → test 2022/23
  Fold 3: train 2017/18-2022/23  → test 2023/24
  Fold 4: train 2017/18-2023/24  → test 2024/25
  Fold 5: train 2017/18-2024/25  → test 2025/26
  ```

**Tier-B (FootyStats-era, 3-fold walk-forward):**
- Ligen: bundesliga2, liga3, la_liga2, serie_b, ligue_2, primeira_liga, super_lig, eerste_divisie, league_one, league_two, jupiler_pro, scottish_prem
- Daten: FootyStats von 2021/22, möglich erst 3 Saison-tests
- Walk-forward:
  ```
  Fold 1: train 2021/22         → test 2022/23
  Fold 2: train 2021/22-2022/23 → test 2023/24
  Fold 3: train 2021/22-2023/24 → test 2024/25
  ```
  (Saison 25/26 reserved für Stage 4 final OOT, nicht in Stage 3 walk-forward)

**Tier-C (sparse, 2-fold walk-forward):**
- Ligen: austria_bl, swiss_sl, greek_sl
- Daten: weniger als 4 Saisons mit useful coverage
- Walk-forward:
  ```
  Fold 1: train 2022/23-2023/24 → test 2024/25
  Fold 2: train 2022/23-2024/25 → test 2025/26
  ```
- **Cave:** Tier-C results sind noisy due to low sample-size — primary use ist drift-detection nicht absolute Brier

**Global Walk-Forward Aggregation:**
- Mean Brier across all folds weighted by per-fold n
- Per-Tier mean Brier (Tier-A primary, Tier-B confirmatory, Tier-C optional)
- Per-Liga Brier trajectory (visualize 5/3/2 points per Liga)

**Pass Criteria (Fix 4 refined):**
- **Tier-A mean Brier across 5 folds < v2 production Tier-A mean by ≥ 0.003**
- Tier-B mean Brier across 3 folds < v2 Tier-B mean by ≥ 0.002 (less strict due to fewer folds)
- Brier-trajectory in Tier-A monotonically improves OR plateaus (no degradation in last 2 folds)
- **Std-dev across folds (Tier-A) < 0.020 ← This is the corrected G4 metric**
- Tier-C: no catastrophic drift (per-fold Brier < 0.70)

**Output Artifact:**
```json
{
  "tier_a": {
    "folds": [
      {"fold": 1, "test_season": "2021/22", "n": 2200, "brier": 0.618, "ece": 0.015},
      ...
    ],
    "mean_brier": 0.612,
    "v2_baseline_mean": 0.6248,
    "improvement": -0.0128,
    "fold_brier_std": 0.014
  },
  "tier_b": { "folds": [...], "mean_brier": 0.628, "improvement": -0.0042 },
  "tier_c": { "folds": [...], "max_brier": 0.661, "drift_flag": false },
  "global_weighted_mean_brier": 0.618
}
```

---

### Stage 4: Current-Season Hold-out (Final OOT) — with Conformal Re-Fit (Fix 7)

The actual production validation. **Multi-step** with conformal re-fitting:

```bash
# Step 1: Train v4 on all data pre-2025-08-01
tools/venv/bin/python3 -I tools/v4/train_v4.py --cutoff 2025-08-01

# Step 2: Generate v4 OOT predictions parquet (current season)
# → tools/backtest/v4-oot-predictions.parquet

# Step 3 (NEW): Re-fit calibration artifacts on v4 OOT predictions
#   - Conformal quantiles re-fit (since v2's are trained on v2 distribution)
#   - Per-Liga overdispersion re-fit
tools/venv/bin/python3 -I tools/v4/refit_calibration.py
# → public/conformal-quantiles-v4.json
# → public/overdispersion-v4.json
# → public/calibration_curves-v4.json (isotonic)

# Step 4: Score current-season with v4-calibrated predictions
tools/venv/bin/python3 -I tools/backtest/score_current_season.py --engine v4 \
  --conformal public/conformal-quantiles-v4.json

# Step 5 (Fix 9): Also score v3 as second benchmark
tools/venv/bin/python3 -I tools/backtest/score_current_season.py --engine v3
```

**Metrics (per market):**
- 1X2 Brier (global + per-Liga)
- O25 Brier
- BTTS Brier (if MarketModule added)
- ECE per market (Fix 4 thresholds applied)
- LogLoss
- Brier Skill Score (vs base-rate)

**Benchmark comparison (Fix 9):**

| Engine | Brier 1X2 (target) | Source |
|---|---|---|
| Base-rate | ~0.66 | Outcome class priors |
| v2_raw | 0.625 | Current production raw |
| v2_benter | 0.620 | Current production with Benter | 
| **v3_lean** | ~0.632 (per CLAUDE.md) | **G1b: v4 must ≤ v3** |
| **v4 (target)** | **≤ 0.617** | **G1: v4 must ≤ v2_benter - 0.003** |

**Per-Liga audit (G3 refined per Fix 5):**
- Each Liga sorted by Brier ascending
- Flag categories:
  - n ≥ 100 + Brier > 0.65: 🔴 catastrophic — investigate
  - 28 ≤ n < 100 + Brier > 0.68: 🟠 sample-warning
  - n < 28: ⚪ excluded from gate (insufficient sample)
- Compare per-Liga to v2 production via delta-Brier
- Identify regression candidates (Ligen wo v4 > v2)

**Calibration plots (Fix 12 detail):**
- Reliability diagram per market: 10 equal-mass bins (equal-mass besser als equal-width für ECE-accurate visualization weil bei equal-width hat das obere bin oft <10 samples)
- Output format: PNG (matplotlib) + interactive HTML via plotly
- Saved zu: `tools/v4/reports/reliability_<market>.{png,html}`
- ECE numeric value with bootstrap 95% CI

**Conformal coverage validation (post-refit):**
- Reuse `tools/backtest/validate_conformal_drift.py`
- Read v4 predictions + new v4-fitted conformal quantiles
- Pass: empirical coverage within 1-α ± 0.02 for ≥ 14 of 18 leagues

**Output:** `tools/v4/reports/current_season_v4.json` + `.html`

---

### Stage 5: CLV Simulation

Beyond Brier — test if v4 actually makes money via Kelly betting.

**Method:**
1. For each match in 25/26 with closing-odds available:
   - Get v4 predicted prob via m3 (LightGBM + Bayesian Ensemble) + m6 (Shin + Benter)
   - Get Pinnacle sharp odds (vig-removed)
   - Compute edge: `v4_prob × odd > 1.0`
   - If edge ≥ Goldilocks threshold (per-Liga 1.5-8.5%):
     - Apply Bayesian Kelly (m7_kelly) → stake fraction f*
     - Simulate bet: outcome from match_outcomes
     - Track bankroll evolution

2. Compute:
   - Total bets placed
   - Win rate
   - ROI (return on investment)
   - CLV (vs closing odds)
   - Bankroll growth rate (geometric)
   - Maximum drawdown
   - Sharpe-equivalent (bankroll-growth / drawdown)

**Pass criteria (Fix: bootstrap):**
- **Bootstrap setup:** 1000 resampled bet-sequences (sample bets WITH replacement, preserve temporal ordering)
- **Median CLV across resamples > 0.5%**
- **ROI 95% CI lower bound > 0** (positive expected value statistically)
- **Max drawdown 95% percentile < 30%** (drawdown-tail not catastrophic)
- **Starting bankroll: 3 variants** (€100, €1000, €10000) — log-bankroll-growth-rate should be scale-invariant

**Stake-size unit:** % of current bankroll (compound Kelly). Not fixed €.

**Reference baseline:** Same simulation with v2_benter + current Kelly profile M. v4 must improve at least 2 of {CLV-median, ROI-CI-lower, max-drawdown-95p} significantly.

```bash
tools/venv/bin/python3 -I tools/v4/simulate_m7_kelly_clv.py \
  --engine v4 --window 2025-08-01:2026-05-12 \
  --kelly bayesian-robust --profile M
```

---

### Stage 6: Production Shadow — Saison-Calendar Aware (Fix 8)

**Critical constraint (Fix 8):** Live shadow requires ACTIVE matches. Football season calendar:

| Period | Live Matches | Shadow Feasible? |
|---|---|---|
| Aug-Dec 26 (26/27 saison start) | Yes (~150/week) | ✅ |
| **Jan-May 26 (current 25/26 saison)** | Yes (~150/week) | ✅ window ~2 weeks before mid-May |
| **Mid-May to Aug 2026** | **NO** (summer break alle 22 Ligen) | ❌ blocked |

**Timing-Optionen:**

**Option α: Pre-Sommerpause Shadow (jetzt-tight)**
- Sofort nach Stage 4-pass deploy v4 in shadow
- ~10-14 days verfügbar bis Saisonende (Sa 16. Mai für meiste Ligen, Sa 23. Mai Cup-Finals)
- Risk: insufficient samples (estimated 800-1500 matches vs ideal 2000+)
- Mitigation: extend shadow window by holding off ship-decision bis Aug 26 für confirmation-period

**Option β: Post-Sommerpause Shadow (delayed)**
- Stage 0-5 jetzt fertig
- Wait 3 Monate für 26/27 Saisonstart
- Deploy shadow August 2026
- 2-week shadow mit ~3000 matches volle confidence
- Total ship-date: September/Oktober 2026

**Empfehlung:** **Option α mit β-confirmation**
- Aktiver Shadow ab Stage-4-pass bis 16. Mai
- Track ~1000 matches initial
- Provisorisches Ship-go IF prelim. shadow results good
- BUT: hold off final ship-commit bis August 26 saisonstart + 2 weeks more shadow
- Total: ~3 months bevor production-flip irreversibel

**Shadow Implementation:**
```sql
-- pipeline_shadow_log row format
INSERT INTO pipeline_shadow_log (
  match_key, league, engine_variant, predicted_at,
  prob_h, prob_d, prob_a, prob_o25, feature_version
) VALUES (
  '...', 'epl', 'poisson-ml-v4-shadow', NOW(),
  0.42, 0.27, 0.31, 0.55, 'v4.0-XYZ'
);
```

**Pass criteria (Fix 3 refined):**
- v4 shadow Brier ≤ v2 production Brier × 1.005 (v4 NOT WORSE THAN v2 + small tolerance)
- Per-Liga drift: max-Liga v4 Brier - max-Liga v2 Brier < 0.02
- ECE on shadow predictions ≤ 0.01 (G2)

**Ship-Decision Matrix:**

| Pre-Pause Shadow (n≈1000) | Post-Pause Confirmation (n≈3000) | Ship? |
|---|---|---|
| ✅ pass | ✅ pass | ✅ flip v4 to default |
| ✅ pass | ❌ fail | ❌ rollback, investigate distribution shift |
| ❌ fail | n/a | ❌ block ship, iterate v4 |

---

### Stage 7 (NEW per Fix 10): Rollback Procedure

**Trigger:** Shadow-Stage 6 fails OR (worse) v4 deployed → live degradation detected.

**Rollback Steps:**
1. **Immediate flip** in MatchdayContext: `engine = 'poisson-ml-v2'` (revert default)
2. **Keep v4 model artifacts** in `public/lgbm-model-v4.json.archive_<date>` (don't delete — needed for forensic analysis)
3. **Tag pipeline_shadow_log** with `rollback_reason` for affected predictions
4. **Document failure mode** in `docs/v4-rollback-<date>.md`:
   - Symptom (Brier degradation, calibration drift, etc.)
   - Hypothesis (which module misbehaved)
   - Investigation plan
5. **Audit downstream consequences:**
   - Any bets placed on v4-edge during shadow → mark in bets table
   - CLV-feedback z-score recompute (don't poison the per-Liga dampening signal)

**Recovery Path:**
- If issue is module-isolatable (e.g. m4_set_pieces prediction off): re-train just that module, re-run Stage 1.m4 + Stage 4-7
- If issue is global (e.g. distribution shift): full re-train + re-run Stage 3-7
- If catastrophic (e.g. data corruption): rebuild from local SQLite mirror + re-run all 7 stages

---

## Implementation Map

### File Layout (skeleton in place 2026-05-12)

```
tools/v4/
├── __init__.py                                  # ✅ v0.1.0-dev marker
├── train_v4.py                                  # ⏳ Main orchestrator (Stage 4 entry)
├── train_m3_xg.py                               # ⏳ LightGBM Tweedie + 5-seed Bayesian ensemble
├── train_m4_setpiece.py                         # ⏳ XGBoost set-piece P(goal|shot)
├── test_m3_calibration.py                       # ⏳ ECE + reliability + σ² sanity
├── test_m6_market.py                            # ⏳ Shin vig-removal + Benter blend
├── simulate_m7_kelly_clv.py                     # ⏳ Bayesian Kelly + CLV bootstrap
├── walk_forward.py                              # ⏳ Stage 3 tiered walk-forward
├── validate_schema.py                           # ⏳ Stage 0 schema check
├── coverage_audit.py                            # ⏳ Stage 0 per-Liga coverage
├── data/
│   ├── __init__.py
│   ├── loaders.py                               # ⏳ Local SQLite readers (team_xg_history, shotmap)
│   └── walk_forward.py                          # ⏳ Tier-A/B/C fold generators
├── eval/
│   ├── __init__.py
│   └── metrics.py                               # ⏳ Brier, LogLoss, ECE, bootstrap-CI
├── modules/
│   ├── m1_score/                                # ✅ Dixon-Coles math (3 files, 600 LOC)
│   │   ├── distributions.py                     # ✅ Poisson, DC, NegBin, overdispersion detector
│   │   ├── coarse_graining.py                   # ✅ 1X2, O/U, BTTS, AH
│   │   └── optimizer.py                         # ✅ ρ MLE via L-BFGS-B
│   ├── m2_lambda/                               # ⏳ xG-EWMA + form/fatigue
│   ├── m3_xg/                                   # ⏳ LightGBM + isotonic + Bayesian Ensemble
│   ├── m4_set_pieces/                           # ⏳ XGBoost set-piece head
│   ├── m5_filters/                              # ⏳ Stubs (regime + intensity)
│   │   ├── regime_detector_stub.py              # ⏳ Returns regime_id="pre_kickoff"
│   │   └── live_intensity_stub.py               # ⏳ Returns λ(t)=λ_total/90
│   ├── m6_market/                               # ⏳ Shin + Benter
│   └── m7_kelly/                                # ⏳ Robust Bayesian Kelly
├── pipeline/
│   ├── stage_0_data_sanity.py                   # ⏳ leakage + schema + coverage gate
│   └── stage_1_m1_score.py                      # ✅ 13/13 math identity tests pass
└── reports/                                     # ⏳ created on first run
    ├── current_season_v4.json
    ├── walk_forward.json
    └── module_isolation.json
```

Legend: ✅ = implemented + tested · ⏳ = stub or planned

### Existing Infrastructure to Reuse

| Existing | Reuse for |
|---|---|
| `tools/feature_lab/{build_features,diagnose,select}.py` | Stage 2 (every new feature) |
| `tools/backtest/score_current_season.py` | Stage 4 (just add --engine v4 flag) |
| `tools/backtest/cross-engine-current-metrics.json` | Output format |
| `tools/backtest/validate_conformal_drift.py` | G5 Conformal coverage |
| `scripts/monitor-live-brier.mjs` | Stage 6 shadow |
| `pipeline_shadow_log` table | Stage 6 logging |
| `bets` + `bets.clv` + `match_outcomes` | Stage 5 CLV sim |
| `tools/sofascore/data/local_extras.db` | All data source |

---

## Pass/Fail Matrix

Final go/no-go decision matrix:

| Stage | If FAIL | Action |
|---|---|---|
| 0 Sanity | leakage detected | Block. Fix data pipeline. |
| 1 Module Isolation | m3_xg worse than v2 | Block. Re-train with feature_lab gating. |
| 1 Module Isolation | m4/m6/m7 fails | Block specific module. Iterate. |
| 2 Diagnostic | Features fail gates | Drop those features, re-train. |
| 3 Walk-Forward | mean Brier worse than v2 | Block. Hyperparameter sweep. |
| 3 Walk-Forward | per-fold trajectory degrading | Investigate regime drift. |
| 4 Current-Season | Brier ≥ v2 | Block. Don't ship. |
| 4 Current-Season | ECE > 0.02 | Re-calibrate. Re-run Stage 4. |
| 4 Current-Season | Per-Liga catastrophe | Investigate Liga. Per-Liga sub-model? |
| 5 CLV Sim | ROI < 0 | Block. Edge-detection or Kelly issue. |
| 5 CLV Sim | Max drawdown > 30% | Reduce risk profile or variance-haircut. |
| 6 Shadow Pre-Pause | Live Brier > v2 × 1.005 | Pause ship-decision, wait for post-pause confirmation. |
| 6 Shadow Post-Pause | Live Brier > v2 × 1.005 | Block ship. Investigate distribution shift. Stage 7 if already shipped. |
| 7 Rollback Triggered | Post-deploy degradation | Immediate revert to v2 in MatchdayContext. Forensic doc + recovery path. |

**Ship criteria:** All 7 gates pass + pre-pause shadow stable + post-pause confirmation stable (≥ 2 weeks each).

**Rollback always-available:** v4 deploy is reversible. v2 artifacts preserved in `public/lgbm-model-v2.json.frozen-2026-05-12.json` ab Stage-4-pass.

---

## Schedule + Compute Budget

| Stage | Compute Time | When |
|---|---|---|
| Stage 0 | < 1 min | Pre-every-run |
| Stage 1 (per module) | 5-15 min each | Per-module iteration |
| Stage 2 (feature_lab) | 5-10 min | After every feature batch |
| Stage 3 (walk-forward) | 60-90 min (5 folds × ~15 min) | Before major version |
| Stage 4 (current-season) | 15-20 min | Before ship |
| Stage 5 (Kelly CLV sim + 1000-bootstrap) | 30-45 min | Before ship |
| Stage 6 (shadow pre-pause) | up to 2 weeks live | Mai 26-Mai-Saisonende |
| Stage 6 (shadow post-pause) | 2 weeks live | Aug 15-29 (26/27 start) |
| Stage 7 (rollback if needed) | minutes | Any time post-deploy |

**Total dev-test cycle (single iteration):** ~3-4 hours pure compute + walk-forward train-runs. ~4 weeks total shadow window across both pre/post-pause.

---

## Bonus: Stub Modules — Interface Contract

For Modules 3 + 5 (live components), define interface NOW so live-upgrade later is plug-in:

### m5_filters → regime_detector_stub.py
```python
# tools/v4/modules/m5_filters/regime_detector_stub.py
def detect_regime(match_state: dict) -> dict:
    """Pre-match: always returns the 'pre_kickoff' regime.
    Live (future): would return current regime + shift-time."""
    return {
        "regime_id": "pre_kickoff",
        "regime_strength": 1.0,
        "last_shift_minute": None,
        "shift_probability_next_5min": 0.0,
    }
```

### m5_filters → live_intensity_stub.py
```python
# tools/v4/modules/m5_filters/live_intensity_stub.py
def get_intensity(match_state: dict, lambda_pregame: tuple) -> dict:
    """Pre-match: returns constant intensity = total/90.
    Live (future): PDMP + Neural Hawkes would return λ(t) per minute."""
    lambda_h, lambda_a = lambda_pregame
    return {
        "lambda_h_per_min": lambda_h / 90,
        "lambda_a_per_min": lambda_a / 90,
        "uncertainty": 0.0,  # No live observation
    }
```

These contracts ensure: `if live_feed_implemented: replace_stub_with_real_module` works without changing downstream code.

---

## Next Concrete Step

After this protocol is reviewed and accepted:

1. ✅ **Build `tools/v4/` skeleton** with stubs + interfaces (done 2026-05-12)
2. ✅ **Implement m1_score** (Dixon-Coles helpers, 13/13 sanity tests pass 2026-05-12)
3. ⏳ **Implement `train_m3_xg.py`** = LightGBM Tweedie + Bayesian Ensemble reading lokal SQLite (~2-3 days)
4. ⏳ **Run Stage 0 (data-sanity) + Stage 1.m3** to validate v4 architecture works (~half-day)
5. ⏳ **Iterate features through feature_lab** until m3_xg beats v2 baseline (~1 week)
6. ⏳ **Add m4_set_pieces (XGBoost)** + Stage 1.m4 validation (~2-3 days)
7. ⏳ **Implement m6_market (Shin + Benter) + m7_kelly (Bayesian Kelly)** (~3-4 days)
8. ⏳ **Run Stage 3 walk-forward + Stage 4 current-season** (~half-day)
9. ⏳ **If pass: Stage 5 CLV sim + Stage 6 shadow** (2 weeks shadow)
10. ⏳ **Ship if all gates pass**

## Realistic Timeline mit Saison-Kalender (Fix 12)

**V1 estimate war 3-5 Wochen — übersehen: Sommerpause + iteration cycles + interrupts. Realistic:**

| Phase | Duration | Calendar |
|---|---|---|
| Skeleton + m1_score (Dixon-Coles math) | 1 day dev | ✅ Mai 12 |
| m2_lambda + m3_xg (LightGBM Tweedie + Bayesian Ensemble) | 5-7 days dev | Mai 13-20 |
| m3 → Stage 1+2 iteration | 5-7 days | Mai 20-27 |
| m4_set_pieces (XGBoost set-piece) | 3-4 days | Mai 27-31 |
| m6_market (Shin vig + Benter blend) + m3 calibration (isotonic) | 4-5 days | Juni 1-5 |
| m7_kelly (Robust Bayesian Kelly) | 3-4 days | Juni 5-9 |
| Stage 3 walk-forward (incl. iteration) | 5-7 days | Juni 9-16 |
| Stage 4 current-season hold-out | 2-3 days | Juni 16-18 |
| Stage 5 CLV simulation | 2-3 days | Juni 18-20 |
| **🟡 BUFFER: typical interrupts + iteration** | 2-3 weeks | Juni 20 - Juli 10 |
| **🔴 SOMMERPAUSE: no shadow possible** | ~6 weeks | Juli 10 - Aug 15 |
| Stage 6 shadow (pre-pause window misses) | n/a | n/a |
| Saisonstart 26/27 + Shadow Stage 6 | 2 weeks live | Aug 15 - Aug 29 |
| Post-shadow Ship-decision | 1 day | Aug 30 |
| **Production flip v4 = default** | 2026-09-01 | |

**Total realistisch:** ~3.5 Monate (Mai 12 → September 1, 2026)

**Alternative aggressive path** (pre-pause shadow):
- Skip buffer, parallelize, accept higher risk
- Stage 6 starts ~Mai 30 with ~2 weeks remaining
- Provisorisches-Ship ~Mai 30-Juni 5 mit n≈1000 shadow samples
- Risk: insufficient data, edge case un-caught
- **NOT recommended** für production-critical engine flip

**Compute Budget über gesamte Timeline:**
- Total dev-machine compute: ~40-60 hours LightGBM + XGBoost training cycles
- Memory: 16 GB sufficient (87k matches × 100 features × 8 bytes = 70 MB max)
- Storage: ~500 MB additional (v4 model artifacts + parquets + reports)

---

**Total estimated effort:** ~3.5 Monate elapsed time (mit Sommerpause), ~5-6 Wochen actual dev work + ~6 Wochen wait für Saison.

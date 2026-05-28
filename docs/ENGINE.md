# FODZE Prediction Engine — Technische Dokumentation

> 4-Modell Ensemble: Dixon-Coles + Elo + Logistic EWMA + Market
> Bayesian Bootstrap Confidence · Unified Entity Resolution
> Version 4 · 40.131 Trainingsspiele · OOT Cutoff 2023-08-01 · Ensemble Brier 0.5876

---

## Pipeline-Übersicht

```
xG-Daten (Summen letzter 8 H/A Spiele)
  │
  ▼
Phase 0: EWMA Time-Decay (ξ=0.025, Halbwertzeit ~28 Wochen)
  │
  ▼
Phase 1: Strength-of-Schedule (iteratives Elo-Rating, 5-8 Iterationen)
  │
  ▼
Phase 2: Bayesian Shrinkage (James-Stein, PRIOR_K=6)
  │
  ▼
Phase 3: Lambda-Berechnung
  ├── Multiplikatives Scoring-Modell: λ = avg × (atk/avg) × (def_opp/avg) × HF
  ├── Tag-Korrekturen: DERBY(+5%), SANDWICH(-10%), ROTATION(-18%)
  └── Spieler-Abwesenheit: xG-Share basiert, positionsgewichtet
  │
  ▼
Phase 3A: Dynamisches Rho (Logistic Regression, 6 Features)
  │
  ▼
Phase 3B: Negative Binomial (Overdispersion α=0.032-0.095 je Liga)
  │
  ▼
15×15 Score-Matrix aufbauen (buildMatrix)
  │
  ▼
23 Märkte ableiten (H/D/A, Ü/U 1.5-5.5, BTTS, DC, CS, Asian HC, HT/FT)
  │
  ▼
Phase 4A: Kalibrierung DEAKTIVIERT (Identity — raw DC ist besser als Platt/Isotonic)
  │
  ▼
Phase 4B: XGBoost Residual-Korrekturen (200 Bäume, 15 Features, 46.807 Spiele)
  │
  ▼
Phase 4C: Pinnacle-Anchoring (KL-Divergenz Blending + Kelly-Dampening)
  │
  ▼
Phase 5: ENSEMBLE (4 Modelle, Brier 0.5876)
  ├── Dixon-Coles ──── 4.9%
  ├── Elo Rating ──── 11.5%  (212 Teams, K=32)
  ├── Logistic ────── 63.7%  (6 EWMA Features, α=0.15)
  └── Market ──────── 20.0%  (Pinnacle wenn vorhanden)
  │
  ▼
Phase 6: Bayesian Bootstrap (500 Resamples → 90% CI)
  │
  ▼
Output: pModel, pMarket, Edge, EV, Kelly%, Konfidenz, CI [low-high]
```

---

## 1. Grundmodell: Dixon-Coles (1997)

### Warum Dixon-Coles?

Das Dixon-Coles Modell erweitert den Standard-Poisson-Ansatz um einen Korrelationsparameter ρ, der die empirisch beobachtete Überrepräsentation von 0:0 und 1:1 Ergebnissen korrekt abbildet. Es ist seit 1997 der akademische Goldstandard für Fußball-Vorhersagen und wird von den meisten quantitativen Wettmodellen als Basis verwendet.

### Mathematik

```
P(i,j | λ_H, λ_A, ρ) = Poisson(i; λ_H) × Poisson(j; λ_A) × τ(i,j,ρ)
```

Wobei die Korrelations-Anpassung τ nur die niedrigen Scores betrifft:

```
τ(0,0) = 1 - λ_H × λ_A × ρ      → 0:0 häufiger wenn ρ < 0
τ(1,0) = 1 + λ_A × ρ              → 1:0 leicht angepasst
τ(0,1) = 1 + λ_H × ρ              → 0:1 leicht angepasst
τ(1,1) = 1 - ρ                    → 1:1 häufiger wenn ρ < 0
τ(i,j) = 1  für alle anderen       → keine Anpassung
```

### Warum nicht Bivariate Poisson direkt?

Die bivariate Poisson-Verteilung (Karlis & Ntzoufras, 2003) modelliert die Korrelation über einen gemeinsamen Poisson-Parameter λ₃. Dixon-Coles ist einfacher, numerisch stabiler, und hat bei 15×15 Matrizen identische Vorhersagequalität bei weniger Rechenaufwand.

### Konstanten

| Parameter | Wert | Begründung |
|-----------|------|-----------|
| MAX_GOALS | 15 | Deckt 99.97% aller Ergebnisse ab |
| RHO (statisch) | -0.05 | Empirischer Durchschnitt über 46.807 Spiele |
| HT_FACTOR | 0.44 | 1. Halbzeit = 44% der Spielintensität (15.696 Spiele) |

---

## 2. Negative Binomial (Overdispersion)

### Warum nicht reines Poisson?

Poisson nimmt Varianz = Mittelwert an. Echte Fußballdaten zeigen **Varianz > Mittelwert** (Fat Tails):
- 4+ Tor-Spiele kommen 15-20% häufiger vor als Poisson vorhersagt
- 0:0 Ergebnisse sind ebenfalls überrepräsentiert
- Niedrigere Ligen haben höhere Varianz als Top-Ligen

### Mathematik

```
NB(k; μ, α) = Γ(k + 1/α) / [Γ(1/α) × k!] × (1/(1+αμ))^(1/α) × (αμ/(1+αμ))^k

Momente:
  E[X] = μ                    (gleich wie Poisson)
  Var[X] = μ + α × μ²         (Poisson hat α=0)
  V/M Ratio = 1 + α × μ       (>1 = overdispersed)
```

### Alpha-Werte je Liga

Gefittet via Maximum-Likelihood-Schätzung auf Tor-Verteilungen 2017-2025:

| Liga | α | V/M bei μ=2.0 | Charakter |
|------|---|---------------|-----------|
| Serie A | 0.032 | 1.128 | Defensiv, taktisch |
| La Liga | 0.035 | 1.140 | Defensiv |
| EPL | 0.038 | 1.152 | Ausgewogen |
| Champions League | 0.040 | 1.160 | Taktisch |
| Ligue 1 | 0.042 | 1.168 | Ausgewogen |
| Bundesliga | 0.045 | 1.180 | Offensiver |
| Championship | 0.050 | 1.200 | Physisch |
| 2. Bundesliga | 0.055 | 1.220 | Variabel |
| DFB-Pokal | 0.060 | 1.240 | Pokal-Effekt |
| 3. Liga | 0.065 | 1.260 | Hohe Varianz |
| Eredivisie | 0.072 | 1.288 | Höchste Varianz |

### Gamma-Approximation

Die Negative Binomial PMF benötigt Gamma-Funktionen. Wir nutzen die Lanczos-Approximation (g=7, 9 Koeffizienten) mit 15 signifikanten Stellen Genauigkeit:

```
Γ(z) ≈ √(2π) × (z + g - 0.5)^(z-0.5) × e^(-(z+g-0.5)) × Σ(cᵢ / (z+i))
```

---

## 3. Lambda-Berechnung

### EWMA Time-Decay

Jüngere Spiele gewichten stärker:

```
weight_i = exp(-ξ × weeks_ago)     ξ = 0.025

xG_per_game = Σ(weight_i × xG_i) / Σ(weight_i)
```

**Warum ξ=0.025?** Halbwertszeit ≈ 28 Wochen. Ein 2 Monate altes Spiel hat ~30% Gewicht eines aktuellen. Basiert auf Dixon-Coles (1997) exponentieller Gewichtung.

### Bayesian Shrinkage (James-Stein)

```
shrinkage = n / (n + 6)

λ_adjusted = league_avg + shrinkage × (λ_observed - league_avg)
```

| Spiele | Shrinkage | Interpretation |
|--------|-----------|---------------|
| 1 | 14.3% | Fast nur Liga-Durchschnitt |
| 4 | 40.0% | Noch stark geglättet |
| 6 | 50.0% | Balance |
| 8 | 57.1% | Hauptsächlich beobachtet |
| 20 | 76.9% | Vertraut Beobachtung |

**Warum PRIOR_K=6?** James-Stein Schätzer minimiert MSE für normalverteilte Parameter. K=6 ist konservativ — ausreichend für 8-Spiele-Fenster.

### Multiplikatives Scoring-Modell

```
λ_H = league_avg × (attack_H / league_avg) × (defense_A / league_avg) × home_factor
λ_A = league_avg × (attack_A / league_avg) × (defense_H / league_avg)
```

Jeder Faktor ist ein Ratio zum Liga-Durchschnitt. Ein Team mit doppelt so guter Offensive hat attack/avg = 2.0.

### Heimfaktoren

Liga-spezifisch (empirisch, 5+ Saisons):

| Liga | HF | Erklärung |
|------|-----|-----------|
| Ligue 1 | 1.32 | Stärkster Heimvorteil in Top-5 |
| La Liga | 1.30 | Starke Heimbilanz |
| Bundesliga | 1.28 | Stehplätze, Atmosphäre |
| EPL | 1.22 | Geringerer Vorteil (TV-Verteilung) |
| Champions League | 1.15 | Neutrale Atmosphäre |

Team-spezifische Overrides für 3. Liga (1.859 Spiele 2020-2025):
- Waldhof Mannheim: 1.65 (Carl-Benz-Stadion Atmosphäre)
- Energie Cottbus: 1.44 (Stadion der Freundschaft)
- BVB II: 0.84 (keine eigene Fanbase)

---

## 4. Dynamisches Rho

### Warum nicht nur statisch?

Statisches ρ = -0.05 ignoriert Kontextunterschiede:
- Defensives Derby: ρ ≈ -0.15 (beide blockieren, 0:0 wahrscheinlicher)
- Offenes Schlagspiel: ρ ≈ 0.0 (Goals unabhängig)

### Logistic Regression

```
z = 0.031 - 0.0004×total_λ + 0.0002×|Δλ| - 0.059×HF - 0.003×derby - 0.0001×rest + 0.036×avg
ρ = sigmoid(z) × (-0.20 - 0.05) + (-0.20)

Trainiert auf 46.807 Spielen, R² = 0.0015
```

### Ehrliche Bewertung

R² = 0.0015 bedeutet: das Modell erklärt nur 0.15% der Rho-Varianz. Die Richtung ist korrekt (mehr Tore → weniger Korrelation), aber der Effekt ist minimal. Beibehalten da kein messbarer Schaden, aber kein signifikanter Vorteil über statisch -0.05.

---

## 5. Isotonische Kalibrierung

### Warum Isotonic statt Platt Scaling?

- **Platt Scaling** (logistische Regression) erzwingt eine Sigmoid-Form → schlecht für multi-modale Verteilungen
- **Isotonische Regression** ist nicht-parametrisch, monoton, und kann beliebige Formen lernen
- Bei Fußball-Probabilities ist die Beziehung raw→calibrated **nicht sigmoid** sondern hat Knicke

### Trainingsdaten

- 14.359 Spiele (2017-2025): Bundesliga, EPL, La Liga, Serie A, Ligue 1
- 4 separate Kurven: H, D, A, O25 (je 101 Punkte)
- OOS-Validierung: 1.274 Spiele (2025/26)

### Ergebnisse

| Metrik | Backtest | Out-of-Sample |
|--------|----------|---------------|
| Brier Score | 0.6013 | — |
| Calibration Error | 0.0047 | 0.0188 |

### Draw-Kurve Sonderbehandlung

Draws übersteigen selten 35-40% Wahrscheinlichkeit. Die isotonische Regression hatte zu wenig Trainingsdaten im Bereich >33% → pathologischer Sprung von 0.377 auf 0.999. Fix: Sanfte Sigmoid-Transition und Cap bei 0.40.

---

## 6. XGBoost Residual-Korrekturen

### Warum nicht alles über XGBoost?

Reines ML verliert die interpretierbare Poisson-Struktur (Score-Matrix, Exact Scores, HT/FT). Stattdessen: Dixon-Coles als Basis, XGBoost korrigiert systematische Fehler.

### Modell-Spezifikation

- 200 Entscheidungsbäume pro Outcome (H, D, A, O25 = 4 Modelle)
- Maximale Tiefe: 4
- 18.674 Trainingsspiele
- ~500KB JSON, <1ms Inferenz

### Feature-Set (14 Features)

| Feature | Typ | Zweck |
|---------|-----|-------|
| is_derby | 0/1 | Emotionale Intensität |
| rest_diff | Tage | Ermüdungsvorteil |
| is_midweek | 0/1 | Unter der Woche = Rotation |
| league_position_diff | Zahl | Tabellenabstand |
| is_relegation_battle | 0/1 | Abstiegskampf-Effekt |
| is_title_race | 0/1 | Meisterschaftseffekt |
| model_prob_H/D/A | 0-1 | Baseline-Wahrscheinlichkeiten |
| total_lambda | Zahl | Erwartet Tore gesamt |
| lambda_diff | Zahl | Balance des Spiels |
| home/away_xg_form | Zahl | Jüngste xG-Tendenz |

### Anwendung

```
delta = XGBoost_predict(features)
P_corrected = clamp(P_raw + delta, 0.01, 0.98)
renormalize(H + D + A = 1.0)
```

---

## 7. Pinnacle-Anchoring

### Warum Pinnacle?

Pinnacle ist der "schärfste" Buchmacher — niedrigste Marge, höchste Limits, informierte Kunden. Ihre Quoten reflektieren den Markt-Konsensus. Wenn unser Modell stark von Pinnacle abweicht, haben wir entweder einen Edge oder einen Fehler.

### KL-Divergenz

```
KL(Model || Pinnacle) = Σ(p_model × log(p_model / p_pinnacle))
```

| KL | Interpretation | Aktion |
|----|---------------|--------|
| < 0.02 | Pinnacle-aligned | Vertraue Modell (90%) |
| 0.02-0.06 | Moderate Abweichung | Blend 50/50 |
| > 0.06 | Starke Abweichung | Vertraue Pinnacle (80%), Kelly dampened |
| > 0.10 | Alarm | Pinnacle 96%, Kelly auf 20% gekürzt |

### Kelly-Dampening

```
kelly_multiplier = max(0.20, exp(-5.0 × KL_divergence))
```

Verhindert Über-Wetten gegen den Markt-Konsensus.

---

## 8. Kelly-Criterion Staking

### Warum Kelly?

Das Kelly-Criterion maximiert den logarithmischen Bankroll-Wachstum. Es ist mathematisch optimal für langfristige Gewinnmaximierung, aber zu aggressiv für reale Bedingungen.

### Fractional Kelly

```
Full Kelly = (p × q - 1) / (q - 1)
Applied = Full Kelly × Fraction × Kelly_Dampening
Capped = min(Applied, 0.05)           [max 5% pro Wette]
```

| Risikoprofil | Fraction | Kelly-Anteil |
|-------------|----------|-------------|
| Konservativ (K) | 0.25 | Viertel-Kelly |
| Moderat (M) | 0.33 | Drittel-Kelly |
| Aggressiv (A) | 0.50 | Halb-Kelly |

### Konfidenz-Rating

```
edge_low  = pModel_low - pMarket     [untere CI-Grenze]
edge_high = pModel_high - pMarket    [obere CI-Grenze]

signifikant = edge_low > 0           [gesamtes CI ist positiv]

HIGH:   signifikant AND edge > 5%
MEDIUM: signifikant AND edge > 0%
LOW:    edge > 0% aber nicht signifikant
NONE:   edge ≤ 0%
```

---

## 9. Markt-Ableitung (23 Märkte)

Aus der 15×15 Matrix werden alle Märkte per Summation berechnet:

| Markt | Formel | Methode |
|-------|--------|---------|
| H/D/A | P(h>a), P(h=a), P(h<a) | Matrix-Summation |
| Ü/U 1.5-5.5 | P(h+a > X) | Diagonale Summation |
| BTTS Ja/Nein | P(h≥1 ∧ a≥1) | Komplement von Rand-Null |
| Double Chance | H+D, D+A, H+A | Addition |
| Clean Sheet | P(a=0), P(h=0) | Rand-Summation |
| Asian Handicap | P(h-a > line) + 0.5×P(push) | Matrix-Query mit Half-Lines |
| Exakte Ergebnisse | P(i:j) direkt | Matrix-Lookup |
| HT/FT | Zwei 15×15 Matrizen (44%/56% Split) | Kreuzprodukt |
| Siegmarge | P(h-a = ±1), P(h-a = ±2), P(h-a ≥ ±3) | Diagonale Query |
| Gelbe Karten | Poisson(k; referee_avg) | Separate Berechnung |

---

## 10. Vig-Removal (Shin's Method)

### Warum nicht einfache Normalisierung?

Einfache Normalisierung (1/odds / sum) verzerrt die Probabilities bei schiefen Quoten. Bei 1.10 / 8.00 / 25.00 wird der Favorit überbewertet.

### Shin's Power Method

```
Suche z ∈ [0, 0.5] sodass:
  Σ[(√(z² + 4(1-z)(r²/S)) - z) / (2(1-z))] = 1.0

Wobei r = 1/quote, S = Σ(1/quotes)
```

Konvergiert in ~50 Iterationen via Binary Search. Korrekte implizite Wahrscheinlichkeiten auch bei asymmetrischen Märkten.

---

## 11. Prognose-Güte & Confidence-Kalibrierung (Stand 2026-05-28)

Ziel-Schwenk weg von „Markt schlagen" (Wett-ROI) hin zu **Prognose-Güte**:
xG-RMSE + 1X2-Brier gekoppelt als Primär-Achse, ROI nur sekundärer Tiebreaker.
Vollbericht: [`docs/FORECAST-QUALITY-ANALYSIS.md`](FORECAST-QUALITY-ANALYSIS.md).

### xG-Forecast-Scoring + Skill-Baseline

`tools/v4/eval/metrics.py` liefert xG-Forecast-Primitive (`xg_rmse`/`mae`/`bias`).
Multi-Engine-Leaderboard via `score_xg_forecast.py` (tiered Name-Bridge-Join,
98% Coverage). **Ist 0.70 RMSE gut?** — beantwortet durch
`xg_skill_baseline.py`: gegen die Klimatologie-Baseline „sage für jedes Spiel
das Liga-Mittel-xG" (leakage-frei aus History vor der Saison, RMSE **0.733**)
ist der **xG-Skill-Score** `1 − MSE/MSE_clim` = **+4.2%** (dev-03) / **+8.4%**
(Blend). Echtes, aber bescheidenes Skill — per-Spiel-xG ist größtenteils
irreduzibles Rauschen (Abschluss/Torwart/Abfälscher). 15/21 Ligen positiv
(best bundesliga +15.2%); la_liga2 negativ (Volume-Tier ohne echte Sofa-xG).

**System-Scorecard (25/26 OOT, Blend):** 1X2-Favorit 48.9% · Brier-Skill-Score
+5.9% · Ü/U2.5 55.2% · xG-RMSE 0.702 / MAE 0.532. **Kernfazit: guter
kalibrierter Forecaster, schlägt aber Pinnacle nicht** — der Wert ist
Prognose-Qualität, nicht Wett-Edge.

### Confidence-Badge — Kalibrierung & Production-Pfad

Jede Vorhersage liefert P(H)/P(D)/P(A); **die höchste IST die Confidence des
Tipps**. Das Frontend-Badge (MatchDetail + MatchCard) ordnet sie in 4 Tiers ein.
Single-source-of-truth der Boundaries + Claims: [`src/lib/confidence-tier.ts`](../src/lib/confidence-tier.ts)
(unit-tested, `tests/confidence-tier.test.ts`).

**Validiert auf dem ECHTEN Production-Pfad** (`validate_confidence_production_path.py`):
das Badge zeigt den Default-Engine **dev-03**, λ→DC, **dann Benter-Blend
Richtung Pinnacle** sobald Quoten da sind (= was `calc.mk` trägt) — **NICHT
Isotonic** (das ist Track-B/Kelly-only). Der Blend **verbessert** Brier
(0.619→0.604) → die angezeigte Wkt ist *besser* kalibriert, nicht schlechter.

| Tier | Schwelle | Treffer (Prod-Pfad, 25/26 · 24/25 OOT) | Badge-Claim |
|---|---|---|---|
| **HOCH** | ≥65% | 78.7% · 73.5% | ~73% (konservative Untergrenze) |
| MITTEL | 55–65% | 53.3% · 58.3% | ~53% |
| NIEDRIG | 45–55% | 44.9% · 49.7% | ~48% |
| TOSS-UP | <45% | 38.3% · 40.2% | ~40% |

**Kernaussage: nur HOCH (≥65%) ist klar überdurchschnittlich; darunter nur
knapp über 50%.** Die Claims sind konservative Untergrenzen, die auf beiden
Saisons halten.

---

## Bekannte Limitierungen

| Bereich | Limitation | Workaround |
|---------|-----------|-----------|
| Rho | R²=0.0015, kaum prädiktive Power | Fällt auf statisch -0.05 zurück |
| Draw-Kalibrierung | Zu wenig High-P Training Samples | Cap bei 0.40, Sigmoid-Glättung |
| XGBoost | Flache Bäume (depth=4), kein Temporal Decay | Ausreichend für Kontextfeatures |
| Player Impact | Heuristisch, nicht validiert | xG-Share basiert, konservative Bounds |
| Overdispersion α | Konstant pro Liga (nicht per Match) | Liga-Fit ist hinreichend genau |
| Form | DEAKTIVIERT — widerspricht xG-Philosophie | xG-Trend Decay statt W/D/L |

---

## Live Tracking & Hit-Rate (Stand 2026-05-03)

Seit 2026-04-21 läuft Cross-Engine-Tracking via `pipeline_shadow_log` × `match_outcomes`.
Erste belastbare Auswertung mit n=104 Spielen:

### Cross-League 1X2 Hit-Rate

| Engine | App-Name | Sample | Hit-Rate | Brier | O25 Hit |
|---|---|---|---|---|---|
| **poisson-ml** | **@annafrick13 v1** | 104 | **49.0%** 🥇 | 0.6745 | 55.8% |
| **ensemble** | **Standard** | 104 | 42.3% | **0.6293** 🥇 | **63.5%** 🥇 |
| poisson-ml-v2 | @annafrick13 v2 | 104 | 42.3% | 0.7012 | 56.7% |
| poisson-ml-v3 | @annafrick13 v3 | 13 | 38.5% | 0.6826 | 53.8% |

### Konfidenz-Band-Kalibration

Wann ist eine Engine bei welchem Confidence-Level verlässlich? "Claimed" = Engine's
Top-Wahrscheinlichkeit, "Hit" = tatsächliche Trefferquote.

| Engine | Band | n | Claimed | Hit | Verdict |
|---|---|---|---|---|---|
| @annafrick13 v1 | **60-70%** | 19 | 64% | **68%** | 🟢 **Gold-Zone** — perfekt kalibriert |
| @annafrick13 v1 | **70%+** | 17 | 80% | **47%** | 🔴 **Trap-Zone** — Over-Confidence |
| @annafrick13 v1 | 50-60% | 23 | 55% | 30% | ⚠ unter-performt |
| Standard | 60-70% | 18 | 65% | 61% | 🟢 solide |
| Standard | 50-60% | 17 | 56% | **65%** | 🟢 schlägt eigene Erwartung |
| Standard | 40-50% | 54 | 45% | 33% | ⚠ untertrifft |
| @annafrick13 v2 | **60-70%** | 26 | 65% | **42%** | 🔴 **Trap-Zone** — Over-Confidence |
| @annafrick13 v2 | 50-60% | 30 | 55% | 23% | 🔴 sehr schlecht |

**Praktische Implikation:**
- **@annafrick13 v1 in 60-70% Conf-Band = robustestes Single-Signal** über alle Engines hinweg.
- v1 >70% Claimed Confidence → vorsichtig (47% Hit, 53% Trap-Rate).
- v2 cross-league im 50-70% Band über-confident. **Aber** in Bundesliga-only (specialist domain)
  v2 stark — Exact-Score-Audit `ExakterTag/`: 16.2% Exact-Score-Hit (n=376), klar best.
- Multi-Engine-Konsens (alle 4 stimmen überein) = stärkstes operationalisierbares Signal,
  realisiert im Goldilocks-Konsens-Filter (`src/app/goldilocks/page.tsx`).

### Per-Liga Hit-Rate (n≥10)

| Liga | n | Standard | @anna v1 | @anna v2 |
|---|---|---|---|---|
| **bundesliga** | 62 | 42% | **50%** 🥇 | 42% |
| bundesliga2 | 10 | 60% | 60% | 60% |
| austria_bl | 12 | 33% | 33% | 33% |

### Tracking-Pipeline (automatisch)

- `pipeline_shadow_log` write per `/matchday` page-load via `savePredictionsBulk`
- `match_outcomes` populated daily via `scripts/populate-match-outcomes.mjs` (settle-bets cron)
- `live_brier_snapshots` aggregated by `scripts/monitor-live-brier.mjs` (cron-ready, --persist)
- `/health` Section 5 zeigt latest snapshot per engine + league

n=104 ist mager (±5pp Differenzen statistisch noch nicht hart abgesichert — würde n>300 brauchen).
Jeder Spieltag fügt ~20-30 settled matches hinzu — nach weiteren 4 Wochen (geschätzt n≈250)
sind Trends robust evaluierbar.

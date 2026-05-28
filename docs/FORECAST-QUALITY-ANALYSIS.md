# FODZE — Forecast-Qualität (Stand 2026-05-28)

Vollständiger Bericht der Forecast-Qualitäts-Sitzung. **Ziel-Schwenk:** weg von
„Markt schlagen" (Wett-ROI), hin zu **Prognose-Güte** — wie genau sagen die
Engines den **Ausgang** *und* die **erwarteten xG** voraus. ROI bleibt nur
**sekundärer Tiebreaker**, kein Veto.

> **TL;DR.** Der **50/50-λ-Blend (dev-03 ⊕ dev-09)** ist der validierte-beste
> Forecaster — dominiert beide Reinmodelle auf **beiden** Achsen (xG-RMSE +
> Brier), in **beiden** Holdouts (25/26 + 24/25). Die Wahrscheinlichkeiten sind
> **kalibriert** (jeder Tipp hat eine ehrliche Confidence). **Kein Markt schlägt
> Pinnacle** (1X2 noch Remis). Mehrere plausible Edge-Ideen wurden rigoros
> getestet und **abgelehnt** (Dominanz-Conversion redundant · Remis-Value
> 25/26-Rauschen · Training-Fokus-auf-High-Conf falsifiziert). Der Mehrwert liegt
> in der **App-Prognose-Qualität + Confidence**, nicht in einem Wett-Edge.

---

## 1 · Das neue Ziel (gekoppelt)

- **Primär:** xG-Treffsicherheit (RMSE/MAE/Bias des vorhergesagten λ vs.
  realisierte xG) **und** der daraus via Dixon-Coles abgeleitete **1X2-Brier**.
  Ein Modell, zwei Auswertungspunkte.
- **Sekundär (Tiebreaker, kein Veto):** Pinnacle-ROI als Leitplanke.

Direkte Folge: die Linse, unter der dev-09 zuvor archiviert wurde (es scheiterte
nur am G5-ROI-Gate), kehrt sich um — unter Prognose-Güte war dev-09 ein Erfolg.

---

## 2 · Mess-Framework

- **Neue Scoring-Primitive** in `tools/v4/eval/metrics.py`: `xg_rmse`, `xg_mae`,
  `xg_bias`, `xg_forecast_report` (vorhergesagtes λ vs. realisierte xG). Pure
  numpy, 6 pytest-Fälle (test_eval_metrics.py → 21 pass).
- **Ground-Truth realisierte xG:** `team_xg_history` (Understat + Sofa-Shotmap)
  via `load_match_pairs`. Alle Engines auf **rohen** Wahrscheinlichkeiten
  verglichen (keine Isotonic) → Modell-Qualität, nicht Pipeline.
- **Coverage-Fix (kritisch):** die anfänglich 77% Join-Rate waren **keine**
  Datums-, sondern **Namens-Divergenz** (Sofa-Kanonik vs. team_xg_history, z.B.
  „SSC Napoli"↔„Napoli", „Wolverhampton"↔„Wolverhampton Wanderers"). Gestufter
  Resolver (exakt → normalisiert → Substring/Token, je Liga + nächstes Datum
  ±7T) → **98%+**. Der Fix **kippte das erste, verzerrte Ergebnis** (dev-03 sah
  zuerst besser aus; nach Fix Gleichstand auf xG-RMSE).

---

## 3 · Multi-Engine-Leaderboard (25/26 OOT)

Common-intersection (alle 5 Engines auf identischen Spielen, RAW-Probs), nach
xG-RMSE:

| Rang | Engine | xG-RMSE ↓ | Brier ↓ | xG-Bias |
|---|---|---|---|---|
| 🥇 | dev-09 | 0.7006 | 0.6135 | −0.065 |
| 🥈 | dev-03 | 0.7016 | 0.6193 | −0.053 |
| 🥉 | v2 | 0.7200 | 0.6232 | −0.075 |
| 4 | Standard | 0.7541 | 0.6703 | **+0.120** ⚠ |
| 5 | v1 | 0.8057 | 0.6483 | −0.034 |

**dev-09 vs dev-03 (gepaart, n=6.750):** xG-RMSE Δ −0.0015 (CI [−0.0066,+0.0038]
= **Tie**); Brier Δ −0.0076 (CI<0 = **dev-09 besser**, robust über 5 Seeds +
Kalibrierung + 2. Holdout). dev-09 = Ausgangs-Stärke, dev-03 = xG-Niveau-Stärke.

**Der Blend gewinnt beides** (fester α=0.5, kein Tuning → leakage-frei):

| Holdout | dev-03 | dev-09 | **Blend** |
|---|---|---|---|
| 25/26 | 0.7176 / 0.6205 | 0.7162 / 0.6128 | **0.7016 / 0.6111** |
| 24/25 | 0.7008 / 0.6195 | 0.7136 / 0.6136 | **0.6873 / 0.6093** |

(Format: xG-RMSE / Brier.) Klassischer Ensemble-Effekt (Fehler korrelieren
0.82–0.84 → ~16–18% unabhängig). Output-Blend → **kein** Multikollinearitäts-Trap,
**kein** Retraining.

**Tiefenanalyse:** xG-RMSE belohnt λ-**Magnitude** (Gesamttore, dev-03 stärker),
Brier λ-**Ratio** (Heim/Auswärts-Split, dev-09 stärker). Die „high-xG
unter-konvertiert"-Kompression (Within-Team-Slope 0.77) ist ein **Within-Game**-
Effekt (Regression zur Mitte), kein Team-Stil-Effekt — zwischen Teams ist der
Slope >1 (dominante Teams über-konvertieren).

---

## 4 · System-Scorecard (25/26 OOT, Blend, n=6.868)

| Was | Wert | Einordnung |
|---|---|---|
| 1X2-Trefferquote (Favorit) | **48.9%** | vs 43% Basisrate, 33% Zufall |
| Brier-Skill-Score | **+5.9%** | Mehrwert über Raten der Basisraten |
| Über/Unter 2.5 | **55.2%** | Tor-Tendenz |
| xG/Team RMSE · MAE | **0.702 · 0.532 Tore** | Bias −0.071 · Korrelation 0.40 |

xG→Tore-Conversion (penalty-bereinigt, 17 Ligen, 27.973 Team-Spiele): **0.958
Tore/npxG** gesamt; pro Liga bundesliga 1.02 (best) → jupiler_pro 0.882. Decke
P(Remis) ~0.35 → Remis nie das Einzel-Maximum.

---

## 5 · Confidence pro Tipp — JA, und kalibriert

Jede Vorhersage liefert P(H)/P(D)/P(A) (+ P(Ü2.5)); **diese Wkt IST die
Confidence**, und sie ist validiert kalibriert (Reliability auf der Diagonale).
Tiers (Treffer ≈ Anspruch in beiden Saisons):

| Tier | Anteil | Treffer 25/26 | Treffer 24/25 OOT |
|---|---|---|---|
| <45% (Toss-up) | 46% | 40% | 41% |
| 45–55% | 30% | 50% | 49% |
| 55–65% | 14% | 56% | 58% |
| **≥65% (Hoch)** | **10%** | **74.5%** | **70.7%** |

**Selektive Vorhersage:** Top-10% Confidence behalten → ~73%; Top-5% → ~78%
(cross-season; 25/26-Spitze bis 80.6%, 24/25 OOT bis ~77%).
Zusätzlich liefert dev-03 eine **λ-Varianz** pro Vorhersage + der **Conformal-
Layer** (Coverage-Gate, warn-Modus) ist OOT-kalibriert.

---

## 6 · Rigoros getestete & ABGELEHNTE Ideen (5-Gate / Persistenz)

| Idee | Befund | Verdikt |
|---|---|---|
| **dev-09 Resurrection** | gewinnt Brier robust, aber xG-Niveau stil-/datenabhängig (Tie auf 25/26, dev-03 auf 24/25). Kein Markt-ROI. | Blend ist die Antwort, nicht dev-09 solo |
| **Dominanz-Conversion** als Feature | dominante Teams über-konvertieren (r=+0.26, persistent 0.70), ABER dev-03-λ erfasst es bereits (λ↔dom r=0.36); Residual r=0.024; Brier-Δ −0.0005 (1.1σ noise-floor); G5 ROI negativ | **redundant** — nicht einbauen |
| **Remis-Value** (Modell-P > Pinnacle) | 25/26 +5.9% (Bootstrap-CI umschließt 0!), 24/25 OOT **−8.16% (CI<0, signifikant negativ)** | **abgelehnt** — 25/26 war Rauschen |
| **Training-Fokus auf High-Conf** | conf-gewichtetes Training (Gewicht ∝ \|elo_diff\|, bis 14×): High-Conf-Brier +0.0034 **schlechter**, overall flat | **falsifiziert** — falscher Hebel; High-Conf hat kaum Headroom (7% des Brier-Verlusts, kalibriert, Upset-gedeckelt). Richtiger Hebel: **selektive Vorhersage** |

Konsistentes Muster: ~jede „neue Edge"-Idee stirbt an Pinnacles Effizienz oder
ist mit der xG-Historie redundant. Der Wert liegt in der **Prognose-Güte**.

---

## 7 · Neue Fähigkeit (additiv, default-aus, getestet)

- `BayesianEnsemble.fit(..., sample_weight=None)` — optionale Per-Zeilen-Gewichte
  (pro Bootstrap-Draw subgesetzt). Default None = unverändert. +2 pytest.
- `train_m3_xg.py --conf-weight-k K` — Gewicht `1 + K·|elo_diff|/std`. K=0 default
  = identisch. Für Experimente / falls je eine headroom-reiche Region gewichtet
  werden soll.

---

## 8 · Diagnostics-Inventar (`tools/v4/diagnostics/`)

| Script | Zweck |
|---|---|
| `score_xg_forecast.py` | Multi-Engine xG-RMSE+Brier-Leaderboard (tiered Name-Bridge-Join) |
| `score_roi_leaderboard.py` | Einheitliches Flat-Stake-ROI aller Engines vs Pinnacle |
| `compare_dev03_vs_dev09.py` | gepaarter Brier-H2H (Phase 4.2) |
| `dev09_derisk.py` | Multi-Seed + kalibriert (CV-Isotonic) + per-Liga |
| `dev09_2h_gate.py` | 2. Holdout (train ≤23/24 → test 24/25, temporal) |
| `dev09_vs_dev03_detail.py` | Magnitude/Ratio-Decomposition + α-Blend-Sweep |
| `falsify_dominance_conversion.py` | 5-Gate: Dominanz beyond dev-03-λ |
| `decision_thresholds.py` | Sieg-/Remis-Schwellen + Value-by-Edge |
| `falsify_draw_value.py` | Multi-Saison-Validierung der Remis-Value (rejected) |
| `system_performance.py` | interpretierbare Scorecard (Ergebnis + xG + Confidence) |
| `validate_high_confidence.py` | High-Conf cross-season + Headroom |
| `eval_conf_weight.py` | A/B: conf-gewichtet vs uniform |
| `xg_to_goals.py` | xG→Tore-Kalibrierung penalty-bereinigt + Dataset |
| `xg_conversion_context.py` | Finishing/Defense-Persistenz + Shrinkage |
| `xg_style_conversion.py` | Dominanz↔Conversion (Bayern-These) |
| `viz_predictions.py` / `build_dossier.py` / `build_dashboard.py` | PNG / PDF-Dossier / interaktives HTML-Dashboard |

---

## 9 · Deliverables

- **`FODZE-Forecast-Dossier.pdf`** (6 Seiten, datengetrieben, committet).
- **`FODZE-Forecast-Dashboard.html`** (interaktiv, self-contained, plotly inline +
  Feature-Importance + Spiel-Explorer; ~7.4 MB, lokal — regenerierbar via
  `build_dashboard.py`).
- **`viz_predictions.png`**, **`xg_to_goals_{overview,per_league}.png`**,
  diverse `*.json`-Ergebnisse.

---

## 10 · Bottom Line & nächste Schritte

- Das System ist ein **guter, ehrlich kalibrierter Forecaster** (Blend dominiert
  beide Achsen; Confidence ist vertrauenswürdig). Es schlägt **Pinnacle nicht** —
  der Wert ist die Prognose-Qualität für die App, nicht ein Wett-Edge.
- **Production:** dev-03 bleibt Default (live, kalibriert, gewired). Der Blend ist
  validiert-besser, aber für Live braucht dev-09 eine Pre-Match-Lineup-Pipeline
  (pending) → Blend ist heute ein Backtest/Research-Gewinn.
- **Umsetzbarer Hebel:** **selektive Vorhersage / Confidence-Badges** im Frontend
  (nur Hoch-Confidence-Tipps hervorheben). Der einzige bestätigte nutzbare Hebel.
- **Methodik-Lehre:** signed-residual + Bootstrap-CI + OOT-Replikation + Headroom
  vor jedem Feature/Retrain — hat in dieser Sitzung 3 plausible Ideen vor teuren
  Sackgassen bewahrt.

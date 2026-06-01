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
| **xG-Skill-Score** (vs Liga-Mittel) | **+8.4%** Blend · +4.2% dev-03 | s.u. — Anker für die RMSE |

**Ist 0.70 RMSE gut?** (Self-Eval-Lücke b, beantwortet via `xg_skill_baseline.py`.)
Gegen die **Klimatologie-Baseline** „sage für jedes Spiel das Liga-Mittel-xG vorher"
(leakage-frei aus 29.893 Spielen *vor* der Saison; Baseline-RMSE **0.733**):
xG-Skill-Score `xGSS = 1 − MSE_Modell/MSE_Klimatologie` = **+8.4%** (Blend) /
**+4.2%** (dev-03). (Baseline, dev-03 und Blend hier alle auf demselben vollen
dev-03-joinbaren Set, n≈6.750 = Leaderboard-„best-effort": dev-03-RMSE 0.7176,
Blend 0.7016 — daher etwas höher als die §3-Tabelle, die auf der kleineren
Common-Intersection n=4.642 rechnet. Die xGSS sind intern konsistent, weil alle
drei auf dem identischen n=6.750 gemessen sind.) **Double-Check der Baseline-Wahl:**
gegen eine zweite, prior-season-only Klimatologie (24/25-Mittel, RMSE 0.739) ist
der xGSS sogar HÖHER (+5.7% dev-03 / +9.8% Blend) — die all-history-Baseline
(0.733) ist also die HÄRTERE (per-Liga-Mittel sind quasi-stationär, das längere
Fenster senkt Sampling-Rauschen stärker als der xG-Drift schadet). **+4.2% ist
damit die konservative Untergrenze, robust positiv gegen BEIDE Baselines.** Also: das team-spezifische Modell schlägt die blinde
Liga-Durchschnitts-Prognose, aber nur um einstellige %-Punkte der Varianz — denn
per-Spiel-xG ist intrinsisch verrauscht (Abschluss/Torwart/Abfälscher), die 0.70
sind **größtenteils irreduzible per-Spiel-Varianz, nicht Modellfehler**. Pro Liga:
15/21 positiv (best bundesliga +15.2%, scottish_prem +14.5%, primeira_liga +12.5%);
negativ v.a. la_liga2 (−28.9%, Volume-Tier ohne echte Sofa-xG) + jupiler_pro/ligue_1.
Damit ist der zuvor unbenchmarkte 0.70-Wert eingeordnet: **echtes, aber bescheidenes
Prognose-Skill** — konsistent mit Brier-BSS +5.9%.

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

> **UI-Badge-Hinweis (Self-Eval 2026-05-28 → Production-Pfad-Validierung):**
> Obige Tabelle ist der **Blend** (research-only). Das Frontend-Badge zeigt den
> *aktiven* Engine (Default **dev-03**) — und zwar dessen ECHTEN Anzeige-Pfad:
> λ→Dixon-Coles, **dann Benter-Blend Richtung Pinnacle** sobald Quoten da sind
> (= was `calc.mk` trägt). **Isotonic ist NICHT auf dem Anzeige-Pfad** (das ist
> Track-B/Kelly-only) — die frühere Sorge ist damit ausgeräumt. Gemessen auf dem
> Production-Pfad (`validate_confidence_production_path.py`, m6_benter-dev-03 =
> exakt was `public/dev03-model.json` einbäckt):
>
> | Tier | RAW (validierte Spur) | **BLENDED = Badge (Prod)** | Badge-Claim |
> |---|---|---|---|
> | ≥65% (HOCH) | 73.7% (25/26) · 68.9% (24/25) | **78.7% · 73.5%** | ~73% ✓ Untergrenze |
> | 55-65% (MITTEL) | 52.7% · 54.1% | **53.3% · 58.3%** | ~53% ✓ |
> | 45-55% (NIEDRIG) | ~46–48% | **44.9% · 49.7%** | ~48% ✓ |
> | <45% (TOSS-UP) | ~39–40% | **38.3% · 40.2%** | ~40% ✓ |
>
> **Der Benter-Blend VERBESSERT Brier** (0.619→0.604 auf 25/26; 0.614→0.597 auf
> 24/25) — das Ziehen Richtung sharp-Markt macht die angezeigte Wkt *besser*
> kalibriert, nicht schlechter. Die Badge-Claims sind damit **konservative
> Untergrenzen**, die auf dem Production-Pfad auf BEIDEN Saisons halten (der
> HOCH-Tier liegt real bei ~76% Mittel). Odds-Coverage bestimmt den Anteil
> geblendeter Matches; ohne Quoten fällt das Badge auf die rohen Matrix-Probs
> zurück (≈ RAW-Spalte). **Praktisch: nur der ≥65%-Tier ist klar
> handlungsrelevant; darunter nur knapp über 50%.** Single-source-of-truth der
> Boundaries+Claims: `src/lib/confidence-tier.ts` (unit-tested).
>
> **Fidelitäts-Caveats (Double-Check 2026-05-29):** die Benter-β sind byte-exakt
> (gegen `public/dev03-model.json` verifiziert), aber die Rekonstruktion ist nicht
> in jedem Schritt produktions-identisch: (1) sie nutzt λ→DC **ohne** die per-Liga
> Overdispersion-α, die der Production-`matrixMk` enthält (α fettet v.a. die
> O/U-Tails, 1X2-Effekt klein); (2) validiert gegen Pinnacle-**Closing**, live
> blendet das Badge gegen die pre-close sharp-Quote (minimal weniger scharf);
> (3) der geblendete HOCH-Tier ist n=324 (25/26, 33% Odds-Coverage in diesem
> Backfill-Korpus) → CI ~±4.5pp, daher ist „~76% Mittel" indikativ, „~73%
> Untergrenze" robust. Die Schlussfolgerung (Blend verbessert Brier; HOCH hält
> die Claim) ist gegen diese kleinen Abweichungen robust, weil der Blend stark
> Richtung Markt zieht und die Claim ohnehin als Untergrenze gesetzt ist.

---

## 5c · Confidence-Validierung der λ-Blends (2026-05-31)

Die §5-Tabelle (research-Blend dev-03⊕dev-09) wurde via
`tools/v4/diagnostics/blend_confidence_calibration.py` aus einem **unabhängigen**
Code-Pfad nachgerechnet und **exakt reproduziert** (dev-03 raw-HOCH 73.7%/68.9% ·
Blend 74.5%/70.7% · Blend-Brier 0.6118/0.6093 — landet auf den publizierten
§3/§5-Werten). Zusätzlich **erstmals** validiert: der *tatsächlich gewirte*
Blend-Engine **dev-03⊕v2** (`engine-registry.ts`, commit 7e628d6) — dessen
Badge-mk ist der **rohe λ-Blend** (Benter berührt nur die Wetten, nicht die
Anzeige — `blendCalc`-Zweig in `MatchdayContext`). Auf 25/26 OOT hält **jeder**
der 4 Tiers seine dev-03-kalibrierte Claim, HOCH + MITTEL mit Marge:

| Tier | Claim | dev-03 | dev-03⊕dev-09 | **dev-03⊕v2 (gewirt)** |
|---|---|---|---|---|
| <45% | 40% | 39.4% | 40.2% | 41.0% |
| 45–55% | 48% | 48.1% | 49.9% | 48.7% |
| 55–65% | 53% | 52.7% | 56.4% | **61.9%** |
| ≥65% (HOCH) | 73% | 73.7% | 74.5% | **76.4%** (n=386) |

(25/26 OOT, RAW λ-Blend = Badge-Pfad.) Damit ist die offene Doku-Lücke
geschlossen: die dev-03-kalibrierten Badge-Claims sind für die Blends eine
**sichere, eher konservative** Näherung. Die Claim-Werte bleiben dev-03-verankert
(das Badge liest `calc.mk` für JEDE Engine, also nicht per-Engine nachtunen).
Einzige milde Weichheit: HOCH im 24/25-Cross-Season (Blend 70.7%, dev-03 selbst
68.9%) — der Blend ist überall **mindestens so gut** kalibriert wie dev-03.
Single-source der Boundaries+Claims: `src/lib/confidence-tier.ts`.

---

## 5b · Markt-Head-to-Head — schlagen wir Pinnacle? (2026-05-29)

Der härteste Test, direkt gegen Pinnacle-Closing (`analyze_pick_quality.py` für
1X2, `analyze_ou_vs_market.py` für Ü/U). Production-Pfad = dev-03 Benter-blended.

| | uns | Markt | Disagreement (wo wir ≠ Markt) |
|---|---|---|---|
| **1X2** (25/26, n=2202) | 48.4% Treffer · Brier 0.6033 | 50.0% · **0.5949** | uns **26.6%** vs Markt 44.3% |
| **Ü/U 2.5** (25/26, n=2209) | 55.7% · Brier 0.2478 | 57.3% · **0.2437** | uns **46.7%** vs Markt 53.3% |

**Auf BEIDEN pickbaren Märkten verlieren wir gegen den Markt** — Treffer, Brier
und v.a. den Disagreement-Test (wo wir eine eigene Meinung haben, trifft der
Markt deutlich häufiger → unser Eigensignal ist Anti-Signal). Ü/U-**Flat-Stake-ROI
gegen die Closing-Line ist negativ** auf allen Edge-Schwellen (−0.3%→−2.1% in
25/26, −3.7%→−7.1% in 24/25) und wird *schlechter* je größer der behauptete Edge.

**Per-Liga-Ausreißer sind Rauschen, kein Edge:** Ü/U-ROI-„Gewinner" persistieren
nicht cross-season (serie_a +18.7% 25/26, aber nicht 24/25; scottish_prem +18.6%
→ −9.6% Vorzeichen-Flip). Die frühere Behauptung „ligue_1/la_liga/serie_a haben
echten O/U-Edge" ist damit **falsifiziert** — klassisches Multiple-Comparison-Artefakt.

**Methodik-Falle (Double-Check 2026-05-29):** Die erste O/U-Analyse hatte „Markt-
Vergleich unmöglich, ~1% Coverage" behauptet — gemessen am **stale Backtest-Parquet**.
Die kanonische `odds_closing_history` hat **80% O/U-Coverage (24.617 Zeilen)**.
Lektion: Markt-Ü/U-Analysen über `odds_closing_history`, NICHT über die Parquets
(1X2-vollständig, aber Ü/U-arm). Der Irrtum war doppelt bestätigt (stale Doc +
stale Parquet) — nur die Live-Abfrage der Quelle deckte ihn auf.

**Konsequenz für die Kombi-Strategie:** +EV-Kombis brauchen markt-schlagende
Beine. Da weder 1X2 noch Ü/U den Buch schlagen, ist die Kombi-These als
Marginal-Stapel **tot**. Einziger nicht-falsifizierter Rest: reiner
Korrelations-Mispricing-Edge (Joint ≠ Produkt) — unmessbar ohne SGP-Quoten,
und moderne Bücher bepreisen Korrelation. Long shot, nicht verfolgt.

---

## 6 · Rigoros getestete & ABGELEHNTE Ideen (5-Gate / Persistenz)

| Idee | Befund | Verdikt |
|---|---|---|
| **dev-09 Resurrection** | gewinnt Brier robust, aber xG-Niveau stil-/datenabhängig (Tie auf 25/26, dev-03 auf 24/25). Kein Markt-ROI. | Blend ist die Antwort, nicht dev-09 solo |
| **Dominanz-Conversion** als Feature | dominante Teams über-konvertieren (r=+0.26, persistent 0.70), ABER dev-03-λ erfasst es bereits (λ↔dom r=0.36); Residual r=0.024; Brier-Δ −0.0005 (1.1σ noise-floor); G5 ROI negativ | **redundant** — nicht einbauen |
| **Remis-Value** (Modell-P > Pinnacle) | 25/26 +5.9% (Bootstrap-CI umschließt 0!), 24/25 OOT **−8.16% (CI<0, signifikant negativ)** | **abgelehnt** — 25/26 war Rauschen |
| **Training-Fokus auf High-Conf** | conf-gewichtetes Training **k-Sweep {0, 0.5, 1, 2, 4}** (Gewicht ∝ 1+k·\|elo_diff\|): KEIN monotoner High-Conf-Gewinn — einziger Dip bei k=0.5 (−0.0093) ist **nicht-monoton = Rauschen**; Overall-Brier monoton schlechter mit k (−0.0003→+0.0003), High-Conf-Acc fällt 72.6→71.6% | **falsifiziert über die ganze Sweep** — falscher Hebel bei JEDER Stärke; High-Conf hat kaum Headroom (7% des Brier-Verlusts, kalibriert, Upset-gedeckelt). Richtiger Hebel: **selektive Vorhersage** |

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
| `analyze_pick_quality.py` | 1X2-Markt-Head-to-Head + Disagreement-Test (§5b) |
| `analyze_ou_vs_market.py` | **Ü/U-vs-Pinnacle** Brier/Disagreement/Flat-Stake-ROI — liest `odds_closing_history` (§5b) |
| `validate_high_confidence.py` | High-Conf cross-season + Headroom |
| `validate_confidence_production_path.py` | Badge-Tiers auf Production-Pfad (Benter-blend, nicht raw/isotonic) — Self-Eval c |
| `xg_skill_baseline.py` | xG-Skill-Score vs Liga-Mittel-Klimatologie — Self-Eval b |
| `eval_conf_weight.py` | A/B: conf-gewichtet vs uniform (k=2) |
| `eval_conf_weight_sweep.py` | conf-weight k-Sweep {0,0.5,1,2,4} — Self-Eval f |
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

---

## 11 · Architektur-Decke — „kriegen wir mit besserer Architektur / Features / Denoising mehr raus?" (2026-06-01)

**Kurzantwort: Nein — aber die Begründung ist subtiler als „nein".** Die Engine ist
**informations-limitiert, nicht kapazitäts-limitiert.** Das ist keine Meinung; es
folgt aus drei unabhängigen Messungen dieser Sitzung. WICHTIG für die Ehrlichkeit:
das ist KEIN Theorem („kein Modell könnte je besser sein"), sondern eine
quantifizierte Aussage über *abnehmende Erträge auf den Daten + dem Ziel, die wir
haben*. Die Grenze, die wir gemessen haben, ist eine **Daten-/Informations-Grenze**,
keine Modell-Grenze.

### 11.1 · dev-03 ist KEIN „Solo-xG"-Modell — und das ist Teil der Antwort
Gain-basierte Feature-Importance aus den 5-bagged LightGBM-Boostern (Heim+Auswärts
kombiniert, `m3_xg-{home,away}-dev-03.pkl`):

| Kategorie | Gain-Anteil | Inhalt |
|---|---|---|
| **xG-abgeleitet** | **44.4%** | Attack/Defense-Ratios, naive λ, ESS — aus xG-Historie |
| **CONTEXT** | **33.5%** | `elo_diff` (**23.5% — größtes Einzel-Feature**), lineup_quality 5.0%, form_streak 5.0% |
| **LEAGUE** | **22.1%** | Liga-Konstanten + Heimvorteil |

Die Frage „taugt Solo-xG" ist damit schon beantwortet: Solo-xG läuft *nicht* — das
Team hat früh erkannt, dass xG allein nicht reicht, und einen xG-verankerten Hybrid
gebaut. Das stärkste Einzel-Feature ist Elo, nicht xG.

### 11.2 · Mehr Struktur draufsatteln half NICHT (Elo-Ablation, reproduziert seed=42)
`rigorous_elo_diagnostic.py`, pure-xG (dev-01) vs xG+Elo (dev-02-elo), identischer
Holdout n=2.274 Spiele (6.822 Decisions, **per-Decision binary Brier** — NICHT die
0.62-Multiclass-Skala aus §3):

| | pure-xG (dev-01) | xG+Elo (dev-02) | Δ |
|---|---|---|---|
| Brier | **0.2007** | 0.2132 | +0.0125 (schlechter) |
| ECE | **0.0195** | 0.0338 | +0.0144 (schlechter) |
| Korr. mit Markt | 0.95 | 0.68 | −0.28 |

Elo *oben drauf* machte das Modell auf diesem Holdout schlechter kalibriert +
überkonfident in der umkämpften Zone (n=471: vorhergesagt 45.5%, real 36.5%,
binom p<0.0001). (dev-03 integriert Elo über Multi-Season-Tuning erfolgreicher — der
Punkt ist nicht „Elo ist schlecht", sondern: **jedes Bolt-on trifft auf
abnehmende/negative Erträge.**) Gleiches Muster wie die 17 abgelehnten Hypothesen
(§6 + Areas-to-Watch): ~80% sterben an Redundanz mit xG oder an Rauschen.

### 11.3 · Das xG-Niveau ist am irreduziblen Boden
Gegen die Klimatologie-Baseline „sag das Liga-Mittel-xG" (`xg_skill_baseline.json`,
leakage-frei aus 29.893 Pre-Saison-Spielen, Baseline-RMSE 0.733):

| Modell | xG-RMSE | xG-Skill-Score |
|---|---|---|
| Klimatologie | 0.733 | 0% |
| **dev-03** | **0.718** | **+4.2%** |
| Blend | 0.702 | +8.4% |

Per-Spiel-Tor-RMSE liegt bei **~0.98× des theoretischen Poisson-Rausch-Bodens**
(√λ; gemessen `headroom_eval.py`, n=6.525): die ~0.70 sind **größtenteils
irreduzible per-Spiel-Varianz** (Abschluss/Torwart/Abfälscher — 1 Spiel = 1
verrauschter Poisson-Zug), nicht Modellfehler. **Keine Architektur senkt
Outcome-Varianz, die dem Sport intrinsisch ist.**

### 11.4 · Die direkte Antwort, Hebel für Hebel
| Hebel | Verdikt | Warum |
|---|---|---|
| **Andere Architektur** (NN / GNN / Transformer) | ❌ hilft nicht | Engpass ist Informations-*gehalt*, nicht Modell-*kapazität*. LightGBM fittet das vorhandene Signal bereits; ein größerer Hammer erzeugt kein Signal, das nicht in den Daten ist. |
| **Feature Engineering** auf vorhandenen Daten | ❌ ~erschöpft | 17 Hypothesen getestet → 80% tot (redundant mit xG / Rauschen / Leakage / net-negativ). Elo-Bolt-on schadete sogar. |
| **Data Cleaning / Denoising** | ◐ marginal | Das dominante Rauschen ist **Outcome-Rauschen** (irreduzibel, §11.3), NICHT Feature-/Messrauschen (reduzierbar). Denoising hilft nur gegen Letzteres — und das relevante Cleaning macht FODZE schon (Canonicalization drift=0, cross-source-Dedup, source-priority `sofa>understat>api-sports>...`). Restpotenzial: einstellige Promille. |
| **NEUE Daten, die wir NICHT haben** | ✅ einziger echter Hebel | Pre-Match-Confirmed-Lineups (→ dev-09-Blend, +0.009 Brier, braucht Live-Pipeline) · Tracking/Positionsdaten · Echtzeit-Verletzung/Motivation. Das ist **Daten-Akquise, kein** Architektur-/FE-/Denoising-Problem. |

### 11.5 · Warum der Markt vorne bleibt (und neue Daten ihn evtl. trotzdem nicht schlagen)
Im Disagreement-Test (§5b) trifft Pinnacle 44% vs. unsere 27% genau dort, wo wir
abweichen. Das ist **kein Modellierungs-Defizit** — es ist eine
**Informations-Asymmetrie**: der Markt aggregiert Sharp-Money-Flow,
Closing-Line-Preisfindung und ggf. Insider-Signal, das in *keinem* öffentlichen
Datensatz steht. Diese Lücke schließt man nicht mit Cleverness auf *unseren* Daten,
sondern nur mit Daten, die der Markt nutzt — und selbst dann ist Pinnacle effizient
genug, dass „neue Daten → Markt geschlagen" **nicht** garantiert ist.

### 11.6 · Fazit (die ehrliche, nicht-überzogene Version)
> **Auf den Daten und dem Ziel, die wir haben, sind wir nahe an der erreichbaren
> Decke.** Das xG-Niveau ist am Poisson-Boden; xG trägt 44% des Gewichts und schlägt
> Null-Wissen, aber nur einstellig; Bolt-on-Features + Architektur-Tausch haben
> bewiesen-abnehmende Erträge; Denoising trifft das falsche Rauschen. Die verbleibende
> Lücke zum Markt liegt **nicht hinter einem besseren Modell — sondern hinter Daten,
> die wir nicht haben.** Und das ist eine Akquise-Frage, keine ML-Frage. Solange das
> Ziel „ehrliche kalibrierte Prognose für einen Menschen" ist, ist das System fertig
> und gut; solange das Ziel „Markt schlagen" ist, ist es per Markteffizienz +
> Informations-Asymmetrie nicht erreichbar — unabhängig von Architektur, Features
> oder Denoising.

**Evidenz:** `rigorous_elo_diagnostic.py` (Ablation) · `xg_skill_baseline.json`
(Skill-Anker) · `headroom_eval.py` (Poisson-Boden + Markt-Decke) · Feature-Gain aus
`m3_xg-{home,away}-dev-03.pkl` · §6 + `docs/archive/areas-to-watch-2026-05.md`
(17-Hypothesen-Friedhof).

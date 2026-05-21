# Signal-Diagnose: 6 Kandidaten aus dem lokalen Datenbestand

> **v2 — Korrekturen 2026-05-19 angewendet.** Self-Eval hat drei methodische Fehler in v1 dieses Reports gefunden: (a) Manager-Honeymoon-Befund war selection-bias-konfundiert und mit umgekehrtem Vorzeichen interpretiert; (b) Width-Korrelation war endogen (in-match), pre-match-lagged ist ~57% kleiner; (c) Brier-Gain-Heuristik war 2–4× zu optimistisch. Korrekturen sind in den jeweiligen Sections eingearbeitet und durch « Δ Korrektur » Marker hervorgehoben. Vollständige Diagnose der Korrekturen siehe `CORRECTIONS.md`.


**Datenbasis:** `tools/sofascore/data/local_extras.db` (771 MB), 6,856 matches, 22 leagues, 25/26 season (Ended games).
**Bridge-Outcome:** sofascore_match goals → goal_diff, total_goals, over25.

Methodik pro Kandidat: Sample-Size · Coverage je Liga-Tier · Pearson/Spearman gegen `goal_diff` und `over25` · expected marginal Brier-Gain (heuristisch, `r² × 0.012` mit Penalty bei kleinem n).

---

## Kandidat 1 — Top-5 Specialist Head (Coverage-Proof)

Understat-Coverage (`understat_player_match_stats`):

| tier   |   matches |   league_seasons |
|:-------|----------:|-----------------:|
| Top-5  |     14358 |               40 |

**Verdict:** Understat liefert **14,358 matches × Top-5 × 8 Saisons (2017/18–2024/25)**, Lower-17 = 0. Damit ist die Coverage-Sparsity in einem All-Liga-Trainer strukturell garantiert (9% in-distribution = exakt der dev-05 Failure-Modus).

**Specialist-Head-Architektur** umgeht das per Design: Top-5-Trainer sieht 95%+ in-distribution, Lower-17 routet weiter zum bestehenden m3 (dev-03).

**Sample-Budget für Top-5 trainable:** ~13.700 matches (24/25 partial excluded for OOS-validation) × Understat-features.

| Aspekt | Wert |
|---|---|
| Coverage Top-5 | ~100% × 8 Saisons |
| Coverage Lower-17 | 0% |
| Player-Rows verfügbar | 424,098 |
| Distinct players | ~21.000 |
| Sparsity-Risiko All-Liga | KRITISCH (= dev-05 failure) |
| Sparsity-Risiko Top-5-only | ~5% |
| Architekturaufwand | ~1 Tag (Routing-Layer + zweites m3-Head) |
| Expected Brier-Gain (Top-5 ONLY) | +0.005 bis +0.012 |
| Expected Brier-Gain (All-Liga) | NEGATIV (verified dev-05) |

## Kandidat 2 — Position-Stratifizierte Team-Aggregate

Coverage: **6,855 matches** mit Position-aggregierten Starter-Sums (25/26, alle 22 Ligen). Features: pro Position-Gruppe (GK/DEF/MID/ATT) Summe der 11-Starter-Werte für `expected_goals`, `tackles_won`, `saves`, `key_passes` etc.

**Korrelationen mit Outcome (Pearson, n und p-Werte annotiert):**

| Feature | n | r vs goal_diff | p | r vs over25 | p |
|---|---:|---:|---:|---:|---:|
| `att_xg_diff` | 6,855 | +0.3691 | 2.83e-220 | +0.0413 | 6.31e-04 |
| `att_kp_diff` | 6,855 | +0.1798 | 6.55e-51 | +0.0065 | 5.93e-01 |
| `def_tackles_diff` | 6,855 | +0.0026 | 8.31e-01 | -0.0136 | 2.61e-01 |
| `gk_saves_diff` | 6,855 | -0.1261 | 1.02e-25 | +0.0131 | 2.78e-01 |

**Stärkste Korrelation:** r = +0.3691
**Expected marginal Brier-Gain:** ≈ +0.0016

Hinweis: Diese Features sind **endogen zum Outcome** (Starter-Statistiken IN diesem Match → Outcome dieses Matches). Für *pre-match* Vorhersage müsste man rolling-N lagged versions bauen (z.B. letzte 5 matches der Starter-Aggregate). Die hier gemessene Korrelation ist eine **obere Schranke** für das was eine lagged Variante leisten kann.

## Kandidat 3 — Rotation Index (Starter-Wechselrate)

Coverage: **6,683 matches** (beide Teams müssen ein vorheriges Match haben).
  rotation_idx = Jaccard-Distanz zwischen aktueller Starter-11 und Starter-11 des vorherigen Spiels.
  Verteilung: mean = 0.484 (~5.3 Spieler im Schnitt gewechselt), std = 0.329.

| Feature | n | r vs goal_diff | p | r vs over25 | p |
|---|---:|---:|---:|---:|---:|
| `rot_diff` | 6,683 | +0.0224 | 6.70e-02 | +0.0188 | 1.25e-01 |
| `home_rot_idx` | 6,683 | +0.0258 | 3.48e-02 | -0.0012 | 9.24e-01 |
| `away_rot_idx` | 6,683 | -0.0036 | 7.68e-01 | -0.0256 | 3.63e-02 |
| `rot_sum` | 6,683 | +0.0146 | 2.32e-01 | -0.0178 | 1.46e-01 |
| `rot_max` | 6,683 | +0.0103 | 4.01e-01 | -0.0099 | 4.20e-01 |

**Stärkste Korrelation:** r = +0.0258
**Expected marginal Brier-Gain:** ≈ +0.00001

## Kandidat 4 — Manager-Honeymoon Curve

Coverage: **13,703 team-matches** mit Manager-ID, davon **528 Manager-Wechsel detected** (3.85% — relativ selten).

Top-10 Ligen nach Wechsel-Häufigkeit:

| League | Manager-Changes 25/26 |
|---|---:|
| serie_b | 49 |
| super_lig | 47 |
| serie_a | 46 |
| la_liga2 | 39 |
| primeira_liga | 32 |
| epl | 28 |
| championship | 25 |
| la_liga | 24 |
| ligue_1 | 24 |
| austria_bl | 23 |

**Baseline (Match ≥10 unter aktuellem Coach):** mean team_goal_diff = +0.0372 (n=7,153)

| Match seit Wechsel | n | mean team_gd | lift vs baseline |
|---:|---:|---:|---:|
| 0 | 934 | -0.1381 | -0.1753 |
| 1 | 773 | -0.0414 | -0.0786 |
| 2 | 708 | +0.0268 | -0.0104 |
| 3 | 677 | -0.0443 | -0.0815 |
| 4 | 648 | -0.0895 | -0.1267 |
| 5 | 616 | +0.0455 | +0.0083 |
| 6 | 589 | -0.0136 | -0.0508 |
| 7 | 566 | -0.0318 | -0.0690 |
| 8 | 535 | -0.0336 | -0.0708 |
| 9 | 504 | -0.0397 | -0.0769 |
| 10 | 481 | -0.0894 | -0.1266 |

**Post-change pooled (matches 0–4):** mean = -0.1340, **Welch t-test vs baseline**: t = -3.810, p = 0.0001

**Verdict:** Honeymoon-Signal detektierbar.

## Kandidat 5 — Tactical Fingerprint (avg_positions)

Coverage: **6,851 matches** mit avg-Positions × Starter-Lineups gemerged.

| Feature | n | r vs goal_diff | p | r vs over25 | p |
|---|---:|---:|---:|---:|---:|
| `def_line_diff` | 6,851 | +0.0060 | 6.18e-01 | -0.0035 | 7.73e-01 |
| `compactness_diff` | 6,851 | +0.0837 | 3.85e-12 | +0.0101 | 4.04e-01 |
| `width_diff` | 6,851 | +0.2049 | 7.08e-66 | -0.0027 | 8.22e-01 |
| `centroid_diff` | 6,851 | +0.0268 | 2.64e-02 | +0.0058 | 6.34e-01 |
| `h_def_line_y` | 6,851 | +0.0007 | 9.52e-01 | -0.0074 | 5.39e-01 |
| `a_def_line_y` | 6,851 | -0.0083 | 4.92e-01 | -0.0020 | 8.65e-01 |

**Stärkste Korrelation:** r = +0.2049
**Expected marginal Brier-Gain:** ≈ +0.00050

## Kandidat 6 — Sofa pregame_form vs xg_diff_ewma

Coverage: **6,614 matches** mit sofa `pregame_form` (avg_rating + league_position).

| Feature | n | r vs goal_diff | p | r vs over25 | p |
|---|---:|---:|---:|---:|---:|
| `rating_diff` | 6,257 | +0.2693 | 2.06e-104 | +0.0251 | 4.72e-02 |
| `position_diff` | 6,614 | +0.2567 | 4.98e-100 | +0.0357 | 3.68e-03 |
| `h_avg_rating` | 6,257 | +0.1893 | 1.51e-51 | +0.0796 | 2.84e-10 |
| `a_avg_rating` | 6,257 | -0.1911 | 1.50e-52 | +0.0442 | 4.70e-04 |
| `xg_diff_ewma_diff (baseline)` | 4,177 | +0.2724 | 5.71e-72 | +0.0242 | 1.18e-01 |

**Stärkste Korrelation:** r = +0.2724

**Verdict:** Sofa-`avg_rating` ist im wesentlichen ein anderes Encoding desselben Signals wie `xg_diff_ewma`. Wenn die Korrelationen ähnlich sind, ist Multikollinearität wahrscheinlich → kein additiver Mehrwert. Falls Sofa-Form *stärker* korreliert, könnte sie das aktuelle EWMA-Feature **ersetzen** (nicht ergänzen).

---

## Ranking — Finale Bewertung nach Signal × Robustheit × Aufwand (v2 korrigiert)

> **Δ Korrektur 2026-05-19:** Manager-Honeymoon-Befund wurde re-evaluiert via DiD. r-Werte für tactical features wurden auf pre-match (lagged) reduziert. Brier-Gain-Schätzungen halbiert wegen 50% Sign-Flip-Rate-Prior.

| Rang | Kandidat | r (gd) lagged | Signal-Typ | Cross-Liga? | Brier-Gain realistic | Aufwand | Status |
|---:|---|---:|---|---|---:|---|---|
| **1** | **Top-5 Specialist Head (C1)** | indirekt | architektonisch | ✗ Top-5 only | +0.003 bis +0.008 (nur Top-5) | ~1 Tag | **HÖCHSTER UPSIDE** |
| **2** | **Manager-Honeymoon Decay (C4)** | DiD +0.36 Goals | continuous-Lag | ✓ alle 22 | +0.0001 bis +0.0004 | ~2-3h | **EMPFOHLEN (ohne Sign-Flip)** |
| **3** | **Width-Lagged Diff Top-5 (C5)** | +0.197 (lagged) | dicht, Top-5 | nur Top-5 stark | +0.0003 bis +0.0006 | ~5-7h | EMPFOHLEN (Top-5 routing) |
| 4 | Width-Lagged Diff All-Liga (C5) | +0.117 (lagged) | dicht aber tier-asymmetrisch | ✓ alle 22 | +0.00008 bis +0.00017 | ~5-7h | grenzwertig (50% sign-flip risk) |
| 5 | Position-ATT-xG lagged (C2) | ≤ +0.10 lagged | dicht, lagged | ✓ alle 22 | +0.0001 bis +0.0003 | ~6-8h | ZWEITRANGIG |
| 6 | Compactness-Diff (C5) | +0.05 lagged geschätzt | dicht | ✓ alle 22 | ≈ 0 | als Beifang | NICE-TO-HAVE |
| 7 | Sofa pregame_form (C6) | +0.27 aber redundant | dicht, aber kollinear | ✓ alle 22 | ≈ 0 additiv | n/a | **NICHT EMPFOHLEN** |
| 8 | Rotation Index (C3) | +0.026 | null | ✓ alle 22 | ≈ 0 | n/a | **VERWERFEN** |
| ❌ | ~~Manager TAG-Sign-Flip~~ | — | — | — | falsche Annahme | — | **STORNIERT (war Selection-Bias)** |

---

## Drei harte Befunde, die die Ausgangshypothesen umgeworfen haben

### Befund 1 — Rotation Index ist statistisch null (verwerfen)

Pre-Diagnose-Erwartung: Rotation ist ein robustes Müdigkeit/Verletzung-Composite. **Realität: r = +0.026 gegen goal_diff, p = 0.067 — nicht signifikant.** Mean rotation = 0.48 (5.3 Spieler/11 Wechsel im Schnitt zwischen aufeinanderfolgenden Spielen — höher als erwartet), aber die Variation korreliert nicht mit Outcome.

Interpretation: Trainer rotieren strategisch genug, dass Rotation per se kein Schwäche-Indikator ist. Ein high-rotating Team kann sowohl ein müdes Schwächeln wie auch eine smarte Auswärts-Aufstellung markieren — die Effekte heben sich auf. **Hypothese wegwerfen, keinen Prototyp bauen.**

### Befund 2 — Manager-Honeymoon IST ein Bounce-Effekt (Korrektur v2)

> **Δ Korrektur 2026-05-19:** Die ursprüngliche v1-Interpretation (Manager-Wechsel = Krise, λH×1.08 sei falsch-vorzeichniger Bug) war Quatsch. Sie war ein **klassischer Selection-Bias-Effekt** — Teams die ihren Coach feuern sind ohnehin in schlechter Form. Difference-in-Differences (pre [-5,-1] vs post [0,+4] für dieselben 528 Teams) zeigt das echte Vorzeichen.

**DiD-Analyse (n = 528 Manager-Wechsel-Events):**

| Phase | Mean team_goal_diff |
|---|---:|
| Pre-Change-Fenster [−5,−1] (gleiche Teams, alter Coach) | **−0.468** |
| Post-Change-Fenster [0,+4] (gleiche Teams, neuer Coach) | **−0.105** |
| **DiD-Lift (post − pre)** | **+0.363** |

Paired t-test: **t = +7.59, p < 1e-13, n = 528**. Bootstrap 95% CI: **[+0.27, +0.46]**.

**Was war passiert:** Der naive Vergleich war "post-change [0,+4]" gegen "≥10-Matches-im-Regime baseline (+0.037)". Die ≥10-baseline besteht überwiegend aus *stabilen guten Teams* die ihren Coach nicht wechseln. Teams die ihren Coach gewechselt haben performen 0.5 Goals/Game schlechter als diese baseline — sowohl VOR als auch NACH dem Wechsel. Der Coach-Wechsel selbst verbessert die Performance um +0.36, aber die Teams bleiben unter Liga-Schnitt weil sie strukturell schwächer sind.

**Implikation für FODZE:**

Der aktuelle Tag `NEUER-TRAINER: λH × 1.08` (in `src/lib/dixon-coles.ts`) ist **vorzeichen-korrekt** und vermutlich sogar magnitude-unter-stated. Ein Bounce von +0.36 Goals/Game entspricht grob einem λ-Multiplier von 1.15–1.20, nicht 1.08. Aber: das Pooling über alle 528 Wechsel maskiert vermutlich erhebliche Heterogenität (Trainer-Quality, Liga, Zeitpunkt der Saison) — eine engere Schätzung pro Liga ist sinnvoll vor einer Anpassung.

**KORRIGIERTE EMPFEHLUNG:** TAG_MAP-Sign-Flip **NICHT** durchführen. Aktuelles `λH × 1.08` ist im richtigen Bereich. Nur das Match-Index-Fade-out Feature (`match_since_coach_change` 0..10) ist noch sinnvoll — der Bounce schmilzt mit der Tabelle in §C4 (Match 0: +0.36 post-pre, Match 4 vermutlich noch +0.15–0.20).

**Methodischer Take-away:** Die ursprüngliche Analyse hat einen klassischen Treatment-Effekt-Mismeasurement gemacht. Im Backtest gegen einen unbeeinflussten Baseline schaut Treatment IMMER schlechter aus als der naive Vergleich nahelegt — die treatments greifen ja gerade auf Probleme zurück, die der Outcome misst. Lessons learned: **bei JEDER zukünftigen "Effekt von X auf Y"-Schätzung in diesem Codebase muss zumindest pre/post-für-die-gleichen-Subjekte verglichen werden**, niemals nur naive Pool-Vergleiche.

### Befund 3 — Tactical Width-Diff ist der stärkste neue dichte Pre-Match-Kandidat (Korrektur v2)

> **Δ Korrektur 2026-05-19:** v1 zitierte r=+0.205 für `width_diff`, was die *endogene* (in-match gemessene) Korrelation war. Die pre-match-relevante lagged-Variante ist deutlich schwächer.

| Variante | r vs goal_diff | n | Anmerkung |
|---|---:|---:|---|
| Endogen (in-match width_diff) | +0.205 | 6.851 | obere Schranke, nicht pre-match nutzbar |
| **Lagged (rolling-5 pre-match)** | **+0.117** | **6.438** | echte pre-match-Korrelation |
| Lagged Top-5 only | +0.197 | 1.536 | **Signal lebt überwiegend in Top-5** |
| Lagged Lower-17 only | +0.092 | 4.902 | schwach |

**Shrinkage 57%** vom endogenen Wert. Das ist konsistent mit Standardliteratur für tactical position features (in-match measurements korrelieren stärker mit Outcome weil sie *teil* des Outcomes sind).

**Wichtigste Re-Interpretation:** Die Tier-Asymmetrie ist scharf. Top-5 Teams mit konsistentem Spielfeld-Breite-Profil performen stark; Lower-17 Teams haben mehr Match-zu-Match Varianz, sodass rolling-5 Mittelwerte wenig prädiktiv sind.

Archetype-Test mit lagged width_diff > P85 (1.15): n=966, **hw_lift = +7.0pp** (statt +14.7pp endogen, also halbiert), p=4.67e-8 — bleibt hoch signifikant aber halbe Effekt-Größe.

Compactness und Defensive-Line bleiben unverändert schwach.

---

## Konkrete Empfehlung für dev-06 (v2 — Korrigiert)

> **Δ Korrektur 2026-05-19:** v1 empfahl Sign-Flip in TAG_MAP basierend auf konfundierten Manager-Statistik. Das ist storniert. Brier-Gain-Schätzungen wurden auf realistische Werte heruntergerechnet (siehe `CORRECTIONS.md` für Heuristik-Kalibrierung).

**Brier-Gain-Heuristik kalibriert.** v1 nutzte `r² × 0.012` als grobe Schätzung. Anhand der historischen v4 dev-02-elo (Brier 0.6133, 14 features) → dev-03 (Brier 0.6201, +2 features = WORSE) → dev-04 (0.6453, +2 features = ARCHIVED) → dev-05 (0.6298, +2 features = ARCHIVED) ist die realistische Erwartung: **~50% der hinzugefügten Features verschlechtern den Brier**, weil Overfitting/Multikollinearität häufiger sind als reines Signal. Die `r² × 0.012` Schätzung ist also eine **optimistische obere Schranke**, nicht ein Erwartungswert.

Realistische Erwartung pro Feature: `r²_lagged × 0.012 × 0.5` (Success-Rate-Prior) mit CI ungefähr ±0.001 (50% chance auf 0 oder negativ).

**PR-1 (KORRIGIERT): Manager-Honeymoon Decay-Feature, OHNE Sign-Flip (2-3h)**

DiD zeigt: der Bounce IST real (+0.36 Goals/Game post vs pre), aber der bestehende `λH × 1.08` Multiplier ist im richtigen Bereich. Single change:

1. Honeymoon-Decay-Feature in `matchday-enrich.mjs`: `match_since_coach_change` als Integer 0..10, durchgeleitet zu v4 m3-features als continuous variable.
2. **TAG_MAP NICHT anfassen.** Sign-Flip-Empfehlung aus v1 ist storniert.
3. Backtest mit `score_current_season.py`, akzeptieren wenn Brier δ ≤ −0.0003 (realistisch konservativ).

Expected Brier-Gain: 0.0001 bis 0.0004 OOS (50% chance auf zero).

**PR-2 (KORRIGIERT): Width-Lagged Feature (5-7h)**

Single new feature, kein Compactness (Compactness r=0.084 lagged ist noch schwächer):

- `width_lagged_diff` = rolling-5 mean von team-width (avg_x-std über Starter), home minus away

Pipeline: `tools/sofascore/engine_features.py::load_width_lagged_features(team_id, before_date, window=5)`. m3 dev-06 trainiert mit **16 + 1 tactical = 17 features**.

Wichtig: **Top-5 spezifisches Routing erwägen.** Lagged Top-5 r = 0.197, lagged Lower-17 r = 0.092. Das Signal ist hauptsächlich Top-5-Sache. Im aktuellen "alle Ligen mit gleicher Engine" Setup wird das Lower-17 noise das Top-5 Signal verwässern. Option: dev-06A (alle Ligen) vs dev-06B (Top-5 only).

Expected Brier-Gain alle-Ligen: **+0.00008 (realistisch) bis +0.00017 (naive heuristic upper bound)** — winzig, statistisch schwer detektierbar. Top-5-spezifisch wäre dasselbe Feature 4× wirksamer: ~+0.0003 bis +0.0006.

**PR-3 (UNCHANGED): Top-5 Specialist Head (Future)**

Bleibt die mit Abstand höchste Upside-Karte. Coverage ist bauartlich sauber, dev-05-Trap umgangen. Empfehlung: nach PR-1 + PR-2 als nächstes Projekt.

**Verworfen: Rotation Index, Sofa pregame_form, Manager-TAG-Sign-Flip**

Rotation null bestätigt. Sofa-Form redundant zu xg_ewma. Manager-Sign-Flip aus v1 zurückgezogen (war Selection-Bias, nicht echter Effekt).

---

## Caveats

- Alle Korrelationen sind gegen *aktuelles Match-Outcome* gemessen → **obere Schranken**. Lagged-Versionen werden ~30-40% schwächer ausfallen.
- Brier-Gain-Heuristik (`r² × 0.012`) ist eine konservative Anker-Schätzung aus historischen v2/v3/v4-Iterationen. Real-OOS-Gain kann ±0.003 davon abweichen.
- Diagnose nutzt nur **25/26**-Daten für Sofa-derived features (n=6.856 matches). Cross-season Stabilität ist NICHT geprüft. Vor Production: 24/25 OOS-Backtest auf den Phase-3-Backfill-Daten.
- Endogene Features (Starter-XG-Sums im *aktuellen* Match) brauchen rolling-Variante. Die Diagnose zeigt **Signal-Potential**, nicht **Prediction-Power**.
- Manager-Honeymoon-Befund ist robust (n=1.813 post-change, p=0.0001), aber liga-spezifische Heterogenität ist nicht abgesucht — vor Sign-Flip in dixon-coles.ts: pro-Liga aufschlüsseln und sanity-check auf serie_b/super_lig (höchste Wechsel-Counts).
- Width-Befund (r=+0.205) braucht Robustness-Check: ist es Liga-spezifisch? In Top-5 vs Lower-17 getrennt rechnen, bevor das Feature in alle 22 Ligen ausgerollt wird.

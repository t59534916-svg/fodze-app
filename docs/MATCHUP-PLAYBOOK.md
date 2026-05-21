# FODZE Matchup-Playbook — Tiefe Interaktions-Analyse

> **v2 — Korrekturen 2026-05-19.** Manager-Archetypen wurden via Difference-in-Differences re-evaluiert (siehe `CORRECTIONS.md`). Possession-Trap und xg_ewma-Effekte wurden gegen 24/25 OOS-Daten validiert (n=7.834 unabhängige matchpairs). Manager-Honeymoon-Befund hat sich um 180° gedreht. Die ursprünglichen Effekt-Größen sind erhalten geblieben aber neu interpretiert.

Komplementär zu `SIGNAL-DIAGNOSE.md`. Diese Analyse geht von marginalen Single-Feature-Korrelationen zur **Interaktions-Ebene** über: welche Feature-Paare und Matchup-Archetypen verschieben das Outcome stärker als die Summe ihrer Einzeleffekte?

**Datenbasis:** `tools/sofascore/data/local_extras.db`, 6.856 matches × 22 Ligen × 25/26-Saison + 7.834 matchpairs aus 24/25 für OOS-Sanity-Check.

**Multiple-Testing-Schutz:** 15 kuratierte Interaktions-Hypothesen, Holm-Bonferroni-korrigiert über alle Tests (k = 15). Survival-Threshold: holm-adjusted p < 0.05.

---

## Master Feature Table — Coverage

| Feature | Beschreibung | n (verfügbar) | Coverage |
|---|---|---:|---:|
| `width_diff` | Tactical width-of-play diff (home − away) | 6,851 | 99.9% |
| `compactness_diff` | Vertical compactness diff | 6,851 | 99.9% |
| `def_y_diff` | Defensive-line height diff | 6,851 | 99.9% |
| `centroid_diff` | Team-centroid Y diff | 6,851 | 99.9% |
| `rating_diff` | Sofa pregame avg_rating diff | 6,257 | 91.3% |
| `position_diff` | League position diff (away − home, positive = home better) | 6,614 | 96.5% |
| `poss_diff` | Possession % diff | 2,993 | 43.7% |
| `xg_ewma_diff` | Rolling-5 lagged xG-difference, pre-match | 4,177 | 60.9% |
| `rest_diff` | Rest days diff (home − away) | 6,647 | 97.0% |
| `honeymoon_diff` | Manager-honeymoon indicator (-1/0/+1) | 6,856 | 100.0% |

---

## Interaktions-Tests — alle 15 Hypothesen mit Holm-Bonferroni

| ID | Hypothese | n | Koef. | SE | p-roh | p-Holm-adj | Verdict |
|---|---|---:|---:|---:|---:|---:|---|
| B1 | Rating-diff × Position-close (form matters more in close sta | 6,257 | -0.9038 | 0.3990 | 2.3547e-02 | 0.3532 | grenzwertig |
| A1 | Width × Compactness (home width attacks away vertical-compac | 6,851 | -0.0064 | 0.0038 | 9.0027e-02 | 1.0000 | null |
| B3 | Position-diff × Rating-diff (standing-strength interaction) | 6,257 | +0.0226 | 0.0150 | 1.3215e-01 | 1.0000 | null |
| D2 | Rest-short × Rating-diff (does fatigue compress form gap?) | 6,257 | +0.5693 | 0.4183 | 1.7354e-01 | 1.0000 | null |
| C1 | Honeymoon × Position-diff (does crisis hit underdogs harder? | 6,614 | -0.0064 | 0.0052 | 2.1953e-01 | 1.0000 | null |
| A4 | Centroid × Press (deep block vs press = via centroid × xg_ew | 4,175 | +0.0080 | 0.0067 | 2.3408e-01 | 1.0000 | null |
| A3 | Possession × Width (possession team that also stretches the  | 2,993 | +0.0007 | 0.0006 | 2.6105e-01 | 1.0000 | null |
| A2 | Def-line × Attack-EWMA (high-line vs strong attack mismatch) | 4,175 | +0.0054 | 0.0051 | 2.9159e-01 | 1.0000 | null |
| A6 | Total field stretch × match quality (high-quality, high-stre | 6,256 | +0.0210 | 0.0210 | 3.1851e-01 | 1.0000 | null |
| B2 | XG-EWMA × Home-Adv (does form scale with home advantage?) | 4,177 | +0.0272 | 0.0308 | 3.7767e-01 | 1.0000 | null |
| C2 | Honeymoon × Rating-diff (form-blind crisis?) | 6,257 | -0.2594 | 0.3189 | 4.1601e-01 | 1.0000 | null |
| A5 | Width × xG-EWMA (stretching effective when team in form?) | 4,175 | -0.0070 | 0.0127 | 5.8235e-01 | 1.0000 | null |
| B4 | Rating-sum × Position-diff (close-strong vs close-weak) | 6,257 | -0.0024 | 0.0060 | 6.9367e-01 | 1.0000 | null |
| C3 | Honeymoon × XG-EWMA (does form mediate honeymoon?) | 4,177 | -0.0193 | 0.0546 | 7.2317e-01 | 1.0000 | null |
| D1 | Rest-diff × Position-diff (fresh underdog vs tired favorite) | 6,614 | -0.0003 | 0.0012 | 8.1422e-01 | 0.8142 | null |

**Holm-Bonferroni-Survivors: 0 von 15 Hypothesen** (adj-p < 0.05).

---

## Matchup-Archetypen — empirische Outcomes vs Baseline

Baseline (alle 22 Ligen):

- Total matches: **6,856**
- Mean goal_diff (home − away): **+0.275**
- Mean total_goals: **2.765**
- Home-Win Rate: **43.3%**
- Over 2.5 Rate: **53.4%**

Pro Archetyp: empirische Frequenz, Differenz zum Baseline, Signifikanz (z-test gegen baseline mean_gd).

| Archetyp | n | mean_gd | gd_lift | hw_lift (pp) | o25_lift (pp) | total_lift | p |
|---|---:|---:|---:|---:|---:|---:|---:|
| Heim-Top vs Auswärts-Tabellenkeller (position_diff > 10) *** | 651 | +1.026 | +0.752 | +18.9 | +5.9 | +0.18 | 0.00e+00 |
| Heim-Tabellenkeller vs Auswärts-Top (position_diff < -10) *** | 696 | -0.405 | -0.680 | -16.9 | -0.8 | +0.00 | 0.00e+00 |
| Away-Coach-Wechsel × Home-EWMA-strong (xg_ewma_diff > 0.5) *** | 178 | +0.882 | +0.608 | +16.8 | +2.8 | +0.15 | 2.02e-06 |
| Heim ausgeruht (≥7T) × Auswärts müde (≤4T) × Heim Underdog * | 48 | -0.292 | -0.566 | -14.2 | -9.6 | -0.51 | 2.15e-02 |
| Heim spielt deutlich breiter (width_diff > P85 = 2.66) *** | 1,028 | +0.840 | +0.566 | +14.7 | +1.1 | -0.01 | 0.00e+00 |
| Heim Possession-dominant (>15%) × Heim EWMA-underdog *** | 324 | -0.262 | -0.537 | -19.6 | -5.9 | -0.27 | 1.47e-08 |
| Home-Coach-Wechsel × Away-EWMA-strong (xg_ewma_diff < -0.5) *** | 234 | -0.171 | -0.445 | -10.4 | +4.3 | +0.03 | 6.48e-05 |
| Tabellennachbarn × Rating-Differenz > 0.15  | 185 | +0.054 | -0.220 | -4.9 | -1.0 | +0.00 | 7.88e-02 |
| BEIDE Teams in Coach-Honeymoon  | 170 | +0.318 | +0.043 | +1.4 | -3.4 | -0.22 | 7.42e-01 |
| Beide Teams hohe Width (width_sum > P85 = 33.49) — gestreckt  | 1,028 | +0.232 | -0.042 | -1.6 | +5.8 | +0.17 | 4.30e-01 |
| Beide Teams niedrige Width (width_sum < P15 = 29.62) — kompakt  | 1,028 | +0.309 | +0.035 | +0.8 | -2.9 | -0.12 | 5.13e-01 |
| Mindestens 1 Team in Coach-Honeymoon (Match 0-4)  | 1,643 | +0.249 | -0.026 | -0.2 | +0.6 | +0.01 | 5.43e-01 |
| Beide Teams Low-Rating (h < 6.7 & a < 6.7)  | 107 | +0.252 | -0.022 | +1.5 | -5.7 | -0.29 | 8.93e-01 |
| Heim müde (≤4T) × Auswärts ausgeruht (≥7T) × Heim Underdog  | 42 | +0.286 | +0.011 | +1.9 | -5.8 | -0.24 | 9.66e-01 |

*** p<0.001, ** p<0.01, * p<0.05 (uncorrected z-test vs ALL baseline)

---

## Cross-Tier Validierung der Top-5 Archetypen (Top-5 vs Lower-17)

Sind die Archetyp-Effekte ein Pooling-Artefakt oder tier-robust? Hier dieselben Archetypen getrennt ausgewertet:

| Archetyp | Tier | n | gd_lift | hw_lift (pp) | p |
|---|---|---:|---:|---:|---:|
| **Heim-Top vs Auswärts-Tabellenkeller** (pos_diff > 10) | ALL | 651 | +0.752 | +18.9 | <1e-15 |
|   | Top-5 | 155 | **+1.046** | **+25.5** | 6.9e-14 |
|   | Lower-17 | 496 | +0.660 | +16.8 | <1e-15 |
| **Away-Coach × Home-EWMA-strong** | ALL | 178 | +0.608 | +16.8 | 2.0e-6 |
|   | Top-5 | 40 | +0.559 | +8.3 | 4.2e-2 |
|   | Lower-17 | 138 | **+0.622** | **+19.3** | 1.6e-5 |
| **Heim Possession-Trap** (poss_diff>15 × ewma<0) | ALL | 324 | -0.537 | -19.6 | 1.5e-8 |
|   | Top-5 | 48 | -0.191 | -10.8 | **0.45 (n.s.)** |
|   | Lower-17 | 276 | **-0.591** | **-20.9** | 6.8e-9 |
| **Heim spielt breiter** (width_diff > P85) | ALL | 1,028 | +0.566 | +14.7 | <1e-15 |
|   | Top-5 | 245 | +0.533 | +14.2 | 1.6e-6 |
|   | Lower-17 | 783 | +0.570 | +14.8 | <1e-15 |
| **Home-Coach × Away-EWMA-strong** | ALL | 234 | -0.445 | -10.4 | 6.5e-5 |
|   | Top-5 | 53 | **-0.580** | **-17.8** | 1.5e-2 |
|   | Lower-17 | 181 | -0.405 | -8.2 | 1.3e-3 |

### Tier-Asymmetrie ist das wichtigste Finding

Drei Pattern verhalten sich in Top-5 vs Lower-17 **dramatisch unterschiedlich** — was empirisch erklärt warum die FODZE per-Liga Goldilocks-Tier-Architektur (Sharp 1.5-5% / Moderate 2.5-7.5% / Soft 3.5-8.5% Edge-Zonen) überhaupt notwendig ist:

1. **Heim Possession-Trap ist ein LOWER-17 Phänomen.** In Top-5 ist der Effekt klein und **nicht signifikant** (p = 0.45). In Lower-17 ist er katastrophal (−21pp Heim-Win-Rate). Sharp Top-5-Märkte preisen das offenbar korrekt; Lower-17-Märkte nicht. Heißt: ein Trap-Filter macht nur in den Lower-17 Sinn.

2. **Standings-Differenz wirkt STÄRKER in Top-5.** +25.5pp Home-Win bei pos_diff>10 in Top-5 vs +16.8pp in Lower-17. Vermutlich weil Top-5-Tabellen-Spitzen-Teams konsistenter performen.

3. **Coach-Krise × Form-Mismatch ist umgekehrt asymmetrisch:** Auswärts-Coach-Wechsel × starkes Heim-Team wirkt in Lower-17 stärker (+19.3pp). Heim-Coach-Wechsel × starkes Auswärts-Team wirkt in Top-5 stärker (−17.8pp). Möglicher Mechanismus: in Top-5 sind Spielerkader tiefer → Heim-Krise schmerzt mehr weil teurere Stars von Crisis-Coach-Wahl unter Druck stehen.

### "High-Confidence Home" × Possession-Trap = Engine-Override Kandidat

Direkter Test einer Goldilocks-Filter-Idee:

| Subset | n | Home-Win-Rate |
|---|---:|---:|
| All HC-Home (rating_diff > 0.15) | 774 | 62.7% |
| HC-Home OHNE Possession-Trap | 757 | **63.1%** |
| HC-Home MIT Possession-Trap | 17 | **41.2%** |

Wenn die Engine eine Heim-Wahrscheinlichkeit > 0.65 errechnet UND der Match im Possession-Trap-Archetyp liegt, fällt die empirische Hit-Rate von 63% auf 41% — ein **−22pp Override**. Das ist exakt die Art von [0.68, 0.72) Trap-Zone die in CLAUDE.md unter dev-03 Diagnostics dokumentiert ist. Mit n=17 ist die Schätzung noch wackelig, aber das Pattern ist konsistent mit der Lower-17 Trap-Verteilung.

---

## Synthese — was wirklich verwertbar ist

**Befund 1 — Keine Interaktion überlebt Holm-Bonferroni.** Alle 15 Interaktions-Hypothesen testen multiplikative Effekte zwischen Feature-Paaren. Keine ist nach Multiple-Testing-Korrektur signifikant. Das bedeutet konkret: die individuell wirksamen Features (Width, Manager-Honeymoon, Form-EWMA, Standings) wirken **additiv linear**, nicht multiplikativ.

Implikation für dev-06: **Engine-Architektur braucht keine expliziten Interaktions-Features.** Tree-basierte Modelle (LightGBM in v2/v4) lernen Interaktionen ohnehin nicht-parametrisch; aber selbst dort würden explizite `A:B` Features kein zusätzliches Signal liefern. **Spare dir den Aufwand, Interaktions-Spalten in m3-Features zu basteln.**

**Befund 2 — Archetypen sind die richtige Abstraktion, nicht Engine-Features.** Bestimmte Konjunktionen von Feature-Werten landen in extremen Regionen des Outcome-Space (10-20pp Lift gegen Baseline), aber das sind **diskrete Regionen, keine kontinuierlichen Gradients**. Engines modellieren Gradients; Archetypen filtern Regionen. Diese Trennung ist architektonisch wichtig — Archetypen gehören in die **Bet-Filter-Schicht** (Goldilocks), nicht in die **Engine-Schicht** (m3).

**Befund 3 — Tier-Asymmetrie ist nicht-trivial und empirisch belegt.** Sharp Top-5-Märkte preisen Possession-Trap und Coach-Krise-Heim teilweise korrekt; Lower-17-Märkte nicht. Das rechtfertigt die per-Liga Tier-Bauweise der bestehenden Goldilocks-Engine empirisch. Per-Archetype Tier-Konditionierung wäre der nächste logische Schritt.

---

## Konkrete Implementierungs-Empfehlungen

**FILTER-1: Lower-17 Possession-Trap Override (4-5h, hoher EV)**

Neuer Goldilocks-Filter in `src/app/goldilocks/page.tsx` + `goldilocks-engine.ts`:

```
Wenn Liga ∈ Lower-17 UND poss_diff > 15 UND xg_ewma_diff < 0
  → Override: home_win_max_edge bid_threshold +25%
  → Effekt: nur high-edge Heim-Bets in diesem Archetyp durchlassen
```

Begründung: empirisch n=276 Lower-17 matches mit −20.9pp HW-Lift, p=6.8e-9. Markt-Mispricing ist hier persistent. Auf Top-5 NICHT anwenden (p=0.45, n.s.).

**FILTER-2: Coach-Honeymoon × Gegner-Form Override (3-4h, mittlerer EV) — KORRIGIERT v2**

> **Δ Korrektur 2026-05-19:** v1 interpretierte Coach-Wechsel als KRISE. DiD-Re-Analyse zeigt: Coach-Wechsel ist tatsächlich ein BOUNCE (+0.36 Goals/Game DiD-Lift). Die Archetyp-Effekte aus den 25/26 Daten waren primär Selection-Bias der Teams die ihren Coach wechseln (im Schnitt 0.5 Goals/Game schwächer als baseline), nicht Effekte des Wechsels selbst.

Filter-Logik **invertiert**:

```
Wenn h_honeymoon=1 (Heim-Coach gerade gewechselt)
  → home_win_min_edge boost +15% (pro-Heim bet — Bounce-Effekt erwartet)
Wenn a_honeymoon=1 (Auswärts-Coach gerade gewechselt)
  → home_win_max_edge boost +15% (anti-Heim bet)
```

Aber **Vorsicht beim Magnitude.** Die Archetyp-Lifts (+16.8pp Away-Coach × Home-strong) sind in der ursprünglichen 25/26-Auswertung gemischt aus Coach-Bounce-Effekt UND der Tatsache dass das Gegner-Team (mit weniger problematischer Vorgeschichte) systematisch besser ist. Der reine Coach-Effekt ist ~+0.36 Goals, was in λ-Multiplier-Terms ungefähr 1.15-1.20 entspricht — der bestehende FODZE-Tag `λH × 1.08` ist konservativer als Daten nahelegen.

Empfehlung: Filter implementieren mit den korrigierten Vorzeichen, aber Backtest auf 24/25 vor Production. Coach-Daten sind in `sofascore_match_managers` (29.685 rows) verfügbar, müssen aber per-team mit Datum sortiert werden um den match_since_change zu berechnen.

**FEATURE-1: Width-Lagged (in PR-2 von SIGNAL-DIAGNOSE bereits empfohlen)**

Width-Diff als rolling-5-lagged Engine-Feature bleibt bestätigt — der Effekt ist robust in beiden Tiers (+14.7pp HW-Lift), n=1.028, und keine Interaktion erforderlich. Pure additive Feature in m3.

**NICHT umsetzen: Standings-Differenz als neues Feature.** Der +25.5pp Top-5 Lift bei pos_diff>10 sieht groß aus, aber Standings ist bereits in jeder Engine via xg_ewma + Elo + ratings encodiert. Empirisch große Effekte hier sind ein **Test des Modells, nicht eine Lücke**: wenn die Engine bei pos_diff>10 nicht 65-70% Heim-Wahrscheinlichkeit ausgibt, ist sie kaputt.

---

## OOS-Validierung auf 24/25 (v2)

**Bridge-Methode:** 24/25-Daten existieren in `team_xg_history` für alle 22 Ligen, aus footystats (9.446), sofascore (5.158), understat (1.762), goals-proxy (850), api-sports (7) = 17.223 team-match rows. Joined zu matchpairs auf (league, date, home_team↔away_opp) = **7.834 unabhängige matchpairs** in 24/25.

Replizierbar in 24/25: alle Archetypen die nur `team_xg_history` brauchen (Possession-Trap, xg_ewma_diff). **Nicht replizierbar:** Manager-Archetypen, Width-Archetypen, Standings-Archetypen — diese brauchen Sofa-side Daten die für 24/25 als "Orphan game_ids" ohne matched score existieren.

| Archetyp | 25/26 (in-sample) | 24/25 (OOS) | Status |
|---|---|---|---|
| **Possession-Trap Lower-17** (poss_diff>15 × ewma<0) | n=276, **hw_lift −20.9pp**, p=6.8e-9 | n=534, **hw_lift −19.8pp**, p=1.3e-14 | ✓ **REPLIZIERT** |
| **Possession-Trap Top-5** | n=48, hw_lift −10.8pp, **p=0.45 (n.s.)** | n=90, hw_lift **−16.6pp**, **p=0.04 (sig.)** | **Kontradiktion** — in 24/25 doch signifikant |
| **Possession-Trap ALL** | n=324, hw_lift −19.6pp, p=1.5e-8 | n=624, hw_lift **−19.0pp**, p=3.9e-14 | ✓ **REPLIZIERT** |
| **High EWMA (>+0.7) Home** | n/a in v1 | n=1.249, **hw_lift +18.3pp**, p<1e-15 | ✓ neuer OOS-Befund |
| **xg_ewma_diff continuous corr** | r=+0.27 | **r=+0.30** (ALL), +0.36 (Top-5), +0.26 (Lower-17) | ✓ **REPLIZIERT** |

**Schluss:** Possession-Trap ist über zwei Saisons stabil und in **beiden Tiers** signifikant (das 25/26-Top-5 p=0.45 war Stichproben-Null, kein echter Tier-Effekt). xg_ewma als continuous Predictor ist überraschend stark — r=0.30 ALL ist nah am v2_benter Brier-Skill-Score territorium. Das Filter-1-Konzept aus v1 ist solid.

> **Konsequenz für Filter-1:** Possession-Trap-Override **NICHT** auf Lower-17 beschränken. Beide Tiers anwenden — die Tier-Asymmetrie in 25/26 war ein Power-Artefakt der kleinen Top-5 Stichprobe (n=48).

---

## Caveats

- **Multiple-Testing-Korrektur** ist konservativ. Pre-registered Hypothesen ohne dieselbe Stärke hätten ohne Holm-Bonferroni schwächere Survivors gehabt. Bei p_uncorr < 0.05 aber p_holm ≥ 0.05 ist die Interaktion **plausibel aber nicht beweissicher** — Replikation auf 24/25 wäre Pflicht.
- **Endogene Features** (`width`, `compactness`, `def_y` aus In-Match avg_positions) müssen für pre-match-Vorhersage durch ihre lagged-Versionen ersetzt werden. Die hier gezeigten Effekt-Größen sind obere Schranken.
- **Archetyp-Tests** sind uncorrected z-tests gegen Baseline. 15 Archetypen × p=0.05 schwellt die Familywise-Error-Rate auf ~54%. Survivors mit p < 0.01 sind robust, p ∈ [0.01, 0.05] sind tentativ.
- **Saisonbeschränkung:** v1 nur 25/26-Daten. v2 fügt 24/25 OOS hinzu (siehe Section oben) für die replizierbaren Archetypen. Sofa-Side Archetypen (Manager, Width, Standings) bleiben in-sample-only weil 24/25 keine matched sofa_match-Einträge hat.
- **Tier-Heterogenität:** viele Pattern werden in Top-5 anders sein als in Lower-17 — aber 25/26 Top-5 n war oft zu klein für reliable Inferenz. Die OOS-Validation hat einige scheinbar Tier-spezifische Effekte als universell entlarvt.

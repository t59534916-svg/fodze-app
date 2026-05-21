# Korrekturen-Pass — Self-Eval Findings (2026-05-19)

Dieser Report dokumentiert vier methodische Korrekturen an v1 von `SIGNAL-DIAGNOSE.md` und `MATCHUP-PLAYBOOK.md`, die aus einer Self-Evaluation hervorgegangen sind. Beide Originalreports wurden inline aktualisiert mit « Δ Korrektur 2026-05-19 » Markern.

**Zusammenfassung der Korrekturen:**

| # | Korrektur | Schweregrad | Auswirkung auf Empfehlungen |
|---:|---|---|---|
| 1 | Manager-Honeymoon Vorzeichen | KRITISCH | Sign-Flip-Empfehlung storniert |
| 2 | Width-Diff endogen vs lagged | MITTELSCHWER | Brier-Gain Schätzung halbiert |
| 3 | Brier-Gain Heuristik kalibriert | MITTELSCHWER | Alle Estimates × 0.5 + ±0.001 CI |
| 4 | OOS 24/25 Validierung | POSITIV | Possession-Trap repliziert; Tier-Restriktion gestrichen |

---

## Korrektur 1 — Manager-Honeymoon: Vorzeichen war falsch (KRITISCH)

**v1-Behauptung:** Manager-Wechsel sei ein KRISE-Effekt mit −0.17 Goals/Game Lift. Der bestehende `NEUER-TRAINER: λH × 1.08` Multiplier sei vorzeichen-falsch und gehöre auf × 0.92 geflipt.

**Methoden-Fehler:** Naive Vergleich "post-change [0,+4]" gegen "≥10-baseline" enthielt einen massiven Selection-Bias. Teams die ihren Coach feuern sind strukturell schwächer als die `≥10-baseline` Cohort (stabile gute Teams die nicht wechseln müssen).

**Difference-in-Differences Korrektur:**

Pre/post-Vergleich für DIESELBEN 528 Teams die einen Wechsel hatten:

| Phase | Mean team_goal_diff |
|---|---:|
| Pre-Change [−5,−1] | **−0.468** |
| Post-Change [0,+4] | **−0.105** |
| **DiD-Lift** | **+0.363** |

Paired t-test: t=+7.59, p<1e-13, n=528. Bootstrap 95% CI: [+0.27, +0.46].

**Korrigierte Interpretation:**

| Komponente | Magnitude |
|---|---:|
| Naive Lift (was v1 berichtet hat) | −0.17 |
| Selection-Bias (Pre-Change-Niveau vs ≥10-baseline) | −0.50 |
| **Echter Causal-Bounce (DiD)** | **+0.36** |

Der Manager-Bounce IST real. Die `λH × 1.08` Multiplikation in `src/lib/dixon-coles.ts` ist im **richtigen** Vorzeichen-Bereich. Die Magnitude (+8%) ist sogar konservativ — DiD legt eher +15-20% nahe.

**Was wurde storniert:**

- PR-1 Sign-Flip-Empfehlung aus `SIGNAL-DIAGNOSE.md` v1
- Filter-2 anti-Heim-Coach-Wechsel Logik aus `MATCHUP-PLAYBOOK.md` v1 (Vorzeichen invertiert)
- Befund-2 Interpretation "INVERS / Krise" in beiden Reports

**Lessons learned:** Bei JEDER zukünftigen "Effekt von X auf Y"-Schätzung in diesem Codebase muss zumindest ein pre/post-für-dieselben-Subjekte oder ein matched-control Vergleich gemacht werden. Naive Pool-Vergleiche zwischen "behandelter" und "unbehandelter" Cohort sind in den meisten Causal-Setups irreführend.

---

## Korrektur 2 — Width-Diff: Endogene Korrelation vs Pre-Match

**v1-Behauptung:** Width-Diff hat r = +0.205 gegen goal_diff. Empfohlen als dichtes pre-match Feature mit Brier-Gain +0.0005-0.0010.

**Methoden-Fehler:** Die r=0.205 war die Korrelation zwischen *in-match* width_diff (avg_x-std der Starter, gemessen während des Spiels) und goal_diff. Das ist endogen — Teams die im Spiel breit stehen tun das oft als Reaktion auf die Match-Situation. Pre-match-relevant ist nur eine lagged-Variante.

**Korrigierte Korrelation:**

`width_lagged_diff` = rolling-5 mean der team-width über die vorherigen 5 Spiele (exklusiv des aktuellen):

| Variante | r vs goal_diff | n |
|---|---:|---:|
| Endogen (in-match) | +0.205 | 6.851 |
| **Lagged (pre-match)** | **+0.117** | **6.438** |
| Lagged Top-5 only | +0.197 | 1.536 |
| Lagged Lower-17 only | +0.092 | 4.902 |

**Shrinkage 57%.** Plus eine entdeckte Tier-Asymmetrie: das Signal überlebt überwiegend in den Top-5. Lower-17 Teams haben mehr Match-zu-Match Varianz, sodass rolling-5 Mittelwerte wenig prädiktiv sind.

**Archetype mit lagged Werten:** `width_lagged_diff > P85 (1.15)` → n=966, **hw_lift = +7.0pp** (vs +14.7pp endogen — auch halbiert), p=4.67e-8.

**Was wurde aktualisiert:** Ranking-Tabelle in `SIGNAL-DIAGNOSE.md`. Top-5-Routing als Option explizit gemacht. Brier-Gain-Schätzung halbiert.

---

## Korrektur 3 — Brier-Gain Heuristik: Optimistische obere Schranke

**v1-Heuristik:** `expected_brier_gain ≈ r² × 0.012`. Verkauft als "empirisch verankert in v2/v3/v4 iterations".

**Methoden-Fehler:** Die Konstante 0.012 war erfunden. Plus die Heuristik annimmt, dass jedes Feature mit Brier-Gain ≥ 0 ankommt — was nicht stimmt.

**Historische Anker aus dem Repo:**

| Transition | Δ Features | Δ Brier |
|---|---:|---:|
| v4 dev-02-elo → dev-03 | +2 features | **+0.0068** (WORSE) |
| v4 dev-03 → dev-04 | +2 features | **+0.0252** (WORSE — archived) |
| v4 dev-03 → dev-05 | +2 features | **+0.0097** (WORSE — archived) |
| v4 v2_benter → dev-02-elo | +14 features | **−0.0061** (BETTER) |

In drei der letzten vier v4-Iterationen haben hinzugefügte Features den Brier verschlechtert. Sign-Flip-Rate ungefähr **50%**.

**Kalibrierte Heuristik:**

```
expected_brier_gain(r) = max(0, r² × 0.012 × 0.5) ± 0.001 (Konfidenz)
```

- Faktor 0.5 = Success-Rate-Prior (50% Chance dass Feature schlechter ist als Mehrwert bringt)
- ±0.001 = Realistische Konfidenz-Bandbreite

**Konkretes Beispiel:** Für lagged `width_diff` (r=0.117):
- v1-Schätzung: `r² × 0.012 = +0.00017` (zu optimistisch)
- v2-Schätzung: `+0.00008` realistic, CI [−0.001, +0.001]
- **50% Wahrscheinlichkeit auf zero/negativen Effekt**

**Was wurde aktualisiert:** Alle Brier-Gain-Spalten in der Ranking-Tabelle in `SIGNAL-DIAGNOSE.md`. PR-1 und PR-2 Erwartungen reduziert.

---

## Korrektur 4 — OOS-Validation auf 24/25

**v1-Schwäche:** Alle Effekte waren in-sample 25/26. Keine Replikations-Validierung.

**24/25 Bridge:** `team_xg_history` für 24/25 enthält 17.223 team-match rows (footystats 9.446, sofascore 5.158, understat 1.762, goals-proxy 850, api-sports 7). Joined zu matchpairs = **7.834 unabhängige Spiele**.

**Replizierbar:** Possession-Trap und xg_ewma_diff (brauchen nur team_xg_history). **Nicht replizierbar:** Manager + Width + Standings (brauchen Sofa-side Daten, fehlen für 24/25).

**Replikations-Ergebnisse:**

| Archetyp | 25/26 Befund | 24/25 OOS | Konsistent? |
|---|---|---|---|
| Possession-Trap Lower-17 | n=276, −20.9pp, p=6.8e-9 | n=534, **−19.8pp**, p=1.3e-14 | ✓ stark |
| Possession-Trap Top-5 | n=48, p=0.45 (n.s.) | n=90, **−16.6pp**, p=0.04 | **Kontradiktion!** |
| Possession-Trap ALL | n=324, −19.6pp | n=624, **−19.0pp** | ✓ stark |
| xg_ewma_diff Korrelation | r=+0.27 | **r=+0.30 (ALL), +0.36 (Top-5)** | ✓ stark |
| High EWMA (>+0.7) Home | n/a in v1 | n=1.249, **+18.3pp** | neuer OOS-Befund |

**Interpretation der Top-5-Kontradiktion:** In 25/26 hatte die Top-5-Possession-Trap-Stichprobe n=48 (zu wenig Power, p=0.45). In 24/25 hat sie n=90 und ist signifikant (p=0.04). Das suggeriert dass die "Top-5-Immunität" in v1 ein **Power-Artefakt** war, nicht ein echter Tier-Effekt. Der korrigierte Schluss: **Possession-Trap wirkt in beiden Tiers, nur ist die Effekt-Größe in Top-5 kleiner (−16.6pp vs −19.8pp Lower-17).**

**Was wurde aktualisiert:** Filter-1 in `MATCHUP-PLAYBOOK.md` jetzt für beide Tiers empfohlen, nicht Lower-17-only.

---

## Konsolidierte korrigierte Empfehlungen

Aus beiden Reports nach Korrektur:

**PR-1 (KORRIGIERT) — Manager-Honeymoon-Decay-Feature, OHNE Sign-Flip (2-3h)**

- `match_since_coach_change` als Integer 0..10 in matchday-enrich.mjs
- TAG_MAP UNVERÄNDERT lassen — `λH × 1.08` ist im richtigen Bereich
- Backtest-Akzeptanzkriterium: Brier δ ≤ −0.0003

**PR-2 (KORRIGIERT) — Width-Lagged Feature (5-7h)**

- `width_lagged_diff` als single new feature
- Top-5-spezifisches Routing erwägen (Signal lebt überwiegend Top-5)
- Expected Brier-Gain alle Ligen: +0.00008 realistisch, 50% chance auf null

**FILTER-1 (KORRIGIERT) — Possession-Trap Override, BEIDE TIERS (4-5h)**

- Wenn `poss_diff > 15` UND `xg_ewma_diff < 0`, Edge-Threshold für Heim-Bets +25%
- Anwenden auf alle 22 Ligen, nicht Lower-17-only wie in v1 empfohlen
- Replikation in 24/25 bestätigt: −19.8pp Lower-17, −16.6pp Top-5 (beide signifikant)

**FILTER-2 (KORRIGIERT) — Coach-Honeymoon Override (3-4h)**

- Vorzeichen invertiert vs v1: Coach-Wechsel ist Bounce, nicht Krise
- Wenn h_honeymoon=1: pro-Heim-Edge boost +15%
- Wenn a_honeymoon=1: anti-Heim-Edge boost +15%
- Backtest auf 24/25 nicht möglich (kein Coach-Daten-Bridge) — Production-Deploy braucht n=200+ live-bets sample

**STORNIERT vs v1:**

- ~~TAG_MAP Sign-Flip~~ (war Selection-Bias)
- ~~Possession-Trap Lower-17-only~~ (war Power-Artefakt)
- ~~Brier-Gain +0.0005-0.0030~~ (war 2-4× zu optimistisch)

---

## Methodische Lessons für künftige Analysen in diesem Codebase

1. **Treatment-Effekt-Schätzungen brauchen pre/post-für-dieselben-Subjekte oder matched-control.** Naive Pool-Vergleiche sind fast immer Selection-Bias-konfundiert.
2. **In-match-Features sind nicht pre-match.** Jede Korrelation mit `goal_diff` aus in-game-gemessenen Daten ist eine obere Schranke und muss zur lagged-Variante reduziert werden bevor sie als pre-match Signal beansprucht wird.
3. **Brier-Gain-Erwartungen brauchen Sign-Flip-Prior.** Aus der dokumentierten v4-Iterationsgeschichte ist die Erwartung +0 ≈ Erwartung +0.001. Single-feature-Erwartungen über +0.002 sind verdächtig.
4. **OOS-Validation ist nicht optional.** Mindestens eine Saison Replikation muss vor Production-Filter-Deploy.
5. **Tier-Restriktionen aus power-limited subsets sind verdächtig.** Wenn ein Pattern in einer kleinen Top-5-Stichprobe nicht signifikant ist und in einer Lower-17-Stichprobe stark signifikant, dann ist das oft eine Power-Funktion, nicht ein echter Tier-Effekt.

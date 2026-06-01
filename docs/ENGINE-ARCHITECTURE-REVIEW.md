# FODZE — Engine-Architektur-Review + SWOT (Snapshot 2026-06-02)

Vollständige Code- und Architektur-Review der **Prognose-Engine** (die vier
Runtime-Engines + Kalibrierungs-Layer + Hot-Path-Orchestrierung + die v4-Python-
Trainings-Pipeline), mit SWOT pro Teil.

> **Anker-Konvention:** Symbol-verankert (`funktion()` / `Datei`), **nicht** zeilen-
> verankert — die zwei größten Dateien (~1180 + ~1000 LOC) sind aktiv in Bewegung,
> Zeilennummern rotten nach dem ersten Commit. LOC sind **approximativ** („große
> Datei"-Indikator, nicht exakt). Dies ist ein **Snapshot** — bei Architektur-
> Änderungen neu erheben, nicht blind vertrauen. Stack: Next.js 16 App Router,
> React 19, Supabase.

---

## Architektur-Überblick

```
OFFLINE (Python, tools/v4)                 ONLINE (TS, src/lib)
─────────────────────────                  ────────────────────
train_m3_xg.py (5-seed LGBM Tweedie)       MatchdayContext.tsx (Orchestrierung, ~1035 LOC)
  → m3_xg-*.pkl                              ├─ computeAllEngines → 4 Engines parallel
export_dev03_to_json.py                      │   ├─ ensemble  (dixon-coles.ts + ensemble.ts)
  → public/dev03-model.json (~7.5 MB)        │   ├─ v1        (poisson-ml-engine.ts)
export_feature_cache.py                      │   ├─ v2        (poisson-ml-engine-v2.ts)
  → public/dev03-feature-cache.json          │   └─ dev-03    (dev03-engine.ts, async Worker)
  ⇅ GOLDEN FIXTURES (Py↔TS-Parität)          ├─ pickPrimaryCalc (engine-pick.ts)
                                             ├─ mergeDev03Overlay (dev03-overlay-merge.ts)
                                             └─ calibration.ts / benter-blend.ts / conformal-gate.ts
```

**Zentrale Struktur-Tatsache:** Alle vier Engines teilen sich **einen** Wahrscheinlich-
keits-Kern — `dixon-coles.ts` (`buildMatrix`, `calculateBetsEnhanced`,
`deriveAllMarkets`). Jede Engine ist nur ein eigenes **Feature→λ-Frontend**; die
λ→15×15-Matrix→Märkte-Strecke ist geteilt. Das prägt jede SWOT unten.

**Exakter Produktionsstand (verifiziert 2026-06-02):** Calibration `isotonic` ·
Conformal-Gate `warn` (→ Faktor 1.0, inert) · Benter `on` (aber für v2 `β=(1,0)` =
no-op) · Bypass-Engines der Shared-Isotonic = `{v1, v2, dev-03}` · Default-Engine =
`poisson-ml-dev03`.

**Typsicherheit gemessen:** `0` `any`-Verwendungen über alle vier Engine-Dateien
+ `dixon-coles.ts`. Die einzigen `any` der Engine-Schicht (5 Stück) liegen alle in
`MatchdayContext.tsx`.

---

## Teil 1 — Gemeinsamer Kern: `dixon-coles.ts` (~1180 LOC)

Die λ→15×15-Matrix→1X2/O25/BTTS-Maschine. `calculateBetsEnhanced()` ist die zentrale
Funktion: Edge, Kelly, Goldilocks, Conformal-Hook, Shield-Veto, Pinnacle-Anchor in
einem Block. Plus `buildMatrix()`, `deriveAllMarkets()`, `eloPrediction()`/
`ensemblePrediction()` (in `ensemble.ts`), `validateXGData()` (Refuse-Guard).

**SWOT**
- **Strengths:** Eine einzige, getestete Wahrscheinlichkeits-Engine → alle vier
  Engines erben dieselbe konsistente Markt-Ableitung (keine 4 divergierenden Matrix-
  Implementierungen). `0` `any`. Dichte Begründungs-Kommentare. Per-Liga-Goldilocks +
  Value-Cap als explizite Konstanten. Refuse-to-predict via `validateXGData()`.
- **Weaknesses:** ~1180 LOC in einer Datei; `calculateBetsEnhanced()` verschränkt
  Edge/Kelly/Calibration/Conformal/Shield/Anchor in einem sehr langen Block → hohe
  kognitive Last, eine Änderung riskiert viele Märkte. Magic Numbers (Value-Cap
  0.10/0.075, λ-Clamp) verstreut.
- **Opportunities:** `calculateBetsEnhanced()` in benannte Stufen zerlegen
  (edge → kelly → gates) — exakt das Muster, das mit `engine-pick`/`overlay-merge`/
  `matchday-cache` schon erfolgreich vorgemacht wurde.
- **Threats:** Single-Point-of-Failure für **alle** Engines — jeder Bug hier ist ein
  4-Engine-Bug. `tests/dixon-coles.test.ts` hat 2 bekannte vorbestehende TS-Fehler
  (CLAUDE.md) → die Test-Datei des kritischsten Moduls ist nicht typsauber.

---

## Teil 2 — Die vier Runtime-Engines

| Engine | Datei (~LOC) | λ-Quelle | Refuse-Guard | Default |
|---|---|---|---|---|
| Standard ensemble | `ensemble.ts` (~360) + Kern | DC 6% + Elo 22% + Logistic 51% + Market 20% | via Kern | nein |
| v1 (`poisson-ml`) | `poisson-ml-engine.ts` (~440) | Poisson-GLM, 9 Features | `calcMatchPoissonML` → null bei fehlender History | nein |
| v2 (`poisson-ml-v2`) | `poisson-ml-engine-v2.ts` (~546) + `lgbm-runtime.ts` (~212) | LightGBM Tweedie, 21 Features | `calcMatchPoissonMLv2` → null (no GIGO) | nein |
| **dev-03** | `dev03-engine.ts` (~352) + `dev03-runtime.ts` (~543) + `dev03-features.ts` (~485) | 5-bagged LightGBM, 16 Features | `calcMatchDev03Async` → null + ensemble-Fallback | **ja** |

Registry: `engine-registry.ts` → `DEFAULT_ENGINE = "poisson-ml-dev03"`. v3
(`poisson-ml-v3`) ist `preview: true` und routet intern zu v2. Plus zwei Schatten-
Einträge: `poisson-ml-blend` (dev-03⊕v2 50/50 λ-Mittel) + `footbayes-hierarchical`.

**SWOT (Suite gesamt)**
- **Strengths:** `0` `any` über alle vier Engine-Dateien — bemerkenswert typsauber.
  Einheitliche Refuse-to-predict-Disziplin: alle returnen `null` bei fehlender xG-
  Historie statt zu raten. dev-03 liefert als Einzige echte epistemische Unsicherheit
  (Ensemble-Varianz, `expected_*_lambda_var`). Engine-Toggle = Microsekunden (alle vier
  parallel vorberechnet + 2-Layer-gecacht).
- **Weaknesses:** **v3 ist toter Ballast** (`preview:true`, routet zu v2 — nur ein
  Registry-Eintrag + alte Brier-Schuld). Vier produktive + zwei Schatten-Engines =
  viel Oberfläche für eine Solo-App. λ-Frontends duplizieren teils Feature-Logik
  (EWMA, SoS, Elo) untereinander.
- **Opportunities:** v1/v3 als wählbare Engines deprecaten; Suite auf dev-03 (Default)
  + ensemble (Fallback) + v2 (Spezialist) verschlanken.
- **Threats:** dev-03 ist Default, aber sein eigener Registry-Eintrag + `bet-edge-
  policy.ts`-Header sagen **„NICHT statistisch validiert"** (Holm-Bonferroni: 0 Ligen
  überleben bei empirischer Per-Bet-Std 148%). Die Engine-Auswahl suggeriert dem Nutzer
  Edge, den die Doku selbst als Rauschen kennzeichnet — ehrliche, aber unbequeme
  Produkt-Spannung. (Vgl. `docs/FORECAST-QUALITY-ANALYSIS.md` §11/§13: Wert ist Prognose-
  Qualität, nicht Wett-Edge.)

**dev-03 im Detail (Default):** sauber dreigeteilt — `dev03-runtime.ts` parst die
~7.5 MB-Booster-JSON + Forward-Pass; `dev03-features.ts` baut 16 Features aus dem Cache;
`dev03-engine.ts` wrappt zu `MatchCalc`. Golden-Fixture-paritätsgetestet. Einzige echte
Latenz: der einmalige ~7.5 MB-JSON-Parse (~75ms) — den der Worker **nicht** entfernt
(beide Threads parsen; vgl. `bench-dev03-predict.mjs`).

---

## Teil 3 — Kalibrierungs-/Markt-Layer

`calibration.ts` (~436) + `conformal-gate.ts` (~274) + `benter-blend.ts` (~208) +
Overdispersion (`neg-binomial.ts` / `public/overdispersion.json`) + Bootstrap in
`AppContext.tsx`. Drei gestapelte Post-Processing-Schichten: **Benter → Calibration →
Conformal-Gate**.

Schlüssel-Symbole: `calibrate1X2()`, `dualTrackCalibrate()` (Display roh vs Kelly
kalibriert), `bypassSharedCalibration()` + `BYPASS_SHARED_CALIBRATION_ENGINES`
(= `{v1,v2,dev-03}` skippen die ensemble-era Shared-Isotonic auf der Kelly-Spur),
hardcoded `CAL_H/D/A`; `conformalKellyFactor()` (modes off/warn/enforce/dampen);
`benterBlend()` (dev-03 Early-Return-Guard, v2 `β=(1,0)` no-op).

**SWOT**
- **Strengths:** **Durchgängig failure-safe** — jede Schicht degradiert bei
  fehlendem/korruptem JSON zu Passthrough/No-op, kein Crash (Loader → `modelErrors`).
  Dual-Track sauber getrennt. dev-03-Doppelblend-Schutz **zweilagig** (Schema-
  Reservierung + Early-Return-Guard in `benterBlend()`). Gute Testabdeckung:
  `calibration-engine-bypass.test.ts`, `conformal-gate.test.ts`, `benter-blend.test.ts`
  (alle mit Edge-Cases).
- **Weaknesses:** **Fünf module-level mutable Singletons** (`CALIBRATION_METHOD`,
  `QUANTILES`, `MODE`×2, `WEIGHTS`) ohne Locking. AppContext-Bootstrap muss in
  Reihenfolge laufen; wirft ein Loader, sieht Downstream **partiell-initialisierten
  State** ohne Error-Boundary. **Silent Degradation:** fehlendes Conformal-JSON →
  `FALLBACK_QUANTILE = 0.50` *ohne Log-Warnung* → Gate evtl. falsch angewandt ohne Spur.
- **Opportunities:** `applied:false`-Flag wenn der Conformal-Fallback greift +
  Surfacing in `/health`. Kein Integrationstest deckt den vollen Bootstrap→Benter→
  Calibrate→Conformal-Pfad gleichzeitig ab (End-to-End-Smoke-Lücke).
- **Threats:** env-var-gesteuerte Defaults sind ein Footgun (diese Session schon einmal
  gehärtet: Default dirichlet→isotonic). env-Drop + fehlendes JSON kann still Schichten
  deaktivieren. Singleton-Architektur macht Tests reihenfolgenabhängig (daher die
  `reset*()`-Helfer). Conformal-Quantile haben (anders als Benter mit `market_dominated`)
  **keinen** Sanity-Guard gegen degenerierte Fits.

---

## Teil 4 — Hot-Path-Orchestrierung: `MatchdayContext.tsx` (~1035 LOC)

Lädt Matchday (`loadCached`), kanonisiert Teamnamen **vor** dem xG-Bucketing
(`canonicalizeTeamName`), berechnet alle 4 Engines parallel (`computeAllEngines`),
wählt Primary (`pickPrimaryCalc`), foldet den async dev-03-Worker ein
(`mergeDev03Overlay`).

**SWOT**
- **Strengths:** Die bug-anfälligsten Teile wurden **in reine, getestete Module
  extrahiert** — `engine-pick.ts` (~55), `dev03-overlay-merge.ts` (~79),
  `matchday-cache.ts` (~86), alle mit Tests inkl. **Regression-Test für stale cross-
  matchday-Pairing** + **byte-identische Cache-Key-Äquivalenz**. Canonicalize-vor-
  Bucketing ist die korrekte Reihenfolge (verhindert Team-Fragmentierung).
- **Weaknesses:** Trotz Extraktion bleiben ~1035 LOC inline + großteils **ungetestet**
  (React-Contexts sind laut CLAUDE.md explizit nicht getestet). Die **5 `any` der
  gesamten Engine-Schicht stecken alle hier**. `computeAllEngines` ist sehr breit
  (xG-Resolve + Shield-Vetoes + Absences + mlInputs + async-Worker-Setup verschränkt).
- **Opportunities:** Die 5 `any` typisieren. `computeAllEngines` weiter extrahieren —
  dasselbe Muster, das overlay-merge/engine-pick schon bekamen.
- **Threats:** Der **async dev-03-Worker-Fold** ist die fragilste Stelle — eine stale-
  pairing-Race (Worker-Ergebnis von Matchday A trifft Matchday B), abgesichert durch
  einen Tag-Guard in `mergeDev03Overlay`, aber in einem ~1000-LOC-Context schwer zu
  sehen. `useMemo`-Dep-Arrays über viele Inputs sind dep-drift-anfällig.

---

## Teil 5 — v4 Python-Trainings-Pipeline + train↔serve-Split

10 Module (`tools/v4/modules/m1_score … m10`), `train_m3_xg.py` (`DEV_03_LOCKED_FEATURES`
= 16-Feature-Locked-Schema, Tweedie, 5-Seed `BayesianEnsemble`), Export→JSON→TS-Runtime
mit Golden-Fixture-Parität (`export_dev03_to_json.py`, `export_feature_cache.py`,
`generate_dev03_features_golden.py`), orchestriert via `refit-dev03-artifacts.sh`.

**SWOT**
- **Strengths:** Saubere Modul-Isolation (m1→m10). Feature-Schema **gelockt**
  (`--features-locked` / `FEATURES_LOCKED`) gegen Drift. Determinismus-Guards
  (`sort_values(kind="mergesort")`, ~9 Stellen + ESS-Checks). Golden-Fixtures
  validieren die TS-Portierung. ~19 pytest-Dateien. `refit-dev03-artifacts.sh` erzwingt
  reihenfolge-kritische Regenerierung (Exit-Code 3 bei Paritäts-Fail).
- **Weaknesses:** **Die größte Architektur-Schwäche der Engine:** dieselbe Mathematik
  (Dixon-Coles, Elo, EWMA, Benter) existiert **doppelt** — Python (Training) *und* TS
  (Runtime), ~9 duplizierte Math-Sites. Parität nur durch **5 Golden-Fixtures** +
  manuell getunte Toleranzen (~0.001). Eine Konstantenänderung (z.B. Elo K) erfordert
  manuellen Port + Retrain + Toleranz-Nachtuning.
- **Opportunities:** Golden-Fixture-Zahl erhöhen (5 ist dünn für 9 Duplikations-Sites).
  Cache-Staleness (`dev03-feature-cache.json` `data_window.history_through`) im `/health`
  surfacen — bei Cron-Tod arbeitet der Runtime still mit altem Elo/Momentum.
- **Threats:** **Silent train↔serve-Drift** ist das Kernrisiko — weicht die TS-
  Portierung um >Toleranz von Python ab, fangen es nur 5 Fixtures. Cache-Staleness
  degradiert Predictions ohne Warnung. Der Bash-Orchestrator ist Single-Point: ein
  Glitch bei Schritt 2 lässt Model + Fixtures fehl-aligned mit Exit 0.

---

## Querschnitt-Synthese

**Gesamtbild:** Eine **überraschend disziplinierte** ML-Engine für eine Solo-App —
`0` `any` in den Engines, durchgängig failure-safe, refuse-to-predict statt GIGO,
extrahierte+getestete Pure-Module an den Bug-Hotspots, Determinismus-Guards, Golden-
Parität. Deutlich über dem Niveau, das man bei einem Ein-Personen-Projekt erwartet.

### Die drei realen Architektur-Risiken (priorisiert)

1. **Python↔TS-Math-Duplikation (höchstes Risiko).** ~9 Sites, 5 Fixtures, manuelle
   Toleranzen → wahrscheinlichster Ort für einen stillen Korrektheits-Bug.
   *Mitigation:* mehr Golden-Fixtures; automatischer Toleranz-Vorschlag; Drift-Alarm.
2. **Singleton-State + Silent-Degradation im Calibration-Layer.** Kein Integrationstest
   des vollen Bootstrap-Pfads; kein `applied`-Flag bei Fallbacks.
   *Mitigation:* End-to-End-Smoke + Fallback-Logging + `/health`-Surface.
3. **~1000-LOC-Context + ~1180-LOC-Core.** Die zwei größten Dateien tragen die meiste
   ungetestete/verschränkte Logik. *Mitigation:* weiter extrahieren nach dem bewährten
   Muster (engine-pick / overlay-merge / matchday-cache).

### Die ehrlichste Spannung (kein reiner Code-Punkt)

dev-03 ist Default und „nicht statistisch validiert" (eigener Registry-Eintrag). Die
Architektur ist exzellent gebaut für ein Ziel — den Markt schlagen — das
`docs/FORECAST-QUALITY-ANALYSIS.md` §11/§13 als unerreichbar belegt haben (informations-
limitiert, nicht modell-limitiert). Der **technische** Wert ist hoch; der **ökonomische**
ist Prognose-Qualität für einen Menschen, nicht Wett-Edge. Das ist keine Code-Schwäche,
aber der Kontext, in dem jede künftige „Engine-Verbesserung" bewertet werden muss:
mehr Genauigkeit kommt nur aus **neuen Daten** (Live-Lineups), nicht aus Modell/Features/
Re-Framing.

---

*Methodik: gegroundet in direkter Code-Lektüre + read-only Explore-Agenten am
2026-06-02. Symbol-verankert für Drift-Resistenz. Snapshot — bei nächster größerer
Engine-Änderung neu erheben.*

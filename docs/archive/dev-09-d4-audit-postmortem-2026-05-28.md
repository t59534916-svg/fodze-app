# dev-09 D4 Audit Post-Mortem — Demontage des initialen 25-Feature Plans

> **Archive header (2026-05-28):** Preserved verbatim from the FODZE Quant-
> Research, ML-Architektur & Risk Audit Committee assessment delivered after
> D4 archive verdict. Canonicalizes the 4 fatal flaws of the originally-
> proposed `dev-09` D4 build (25-feature hybrid Macro+Micro + impossible G5
> + sparsity trap + contaminated fallback) which were caught in pre-sprint
> audit and led to the binding revisions actually executed.
>
> Companion docs:
> - [`docs/FODZE-OPTIMAL-BLUEPRINT.md`](../FODZE-OPTIMAL-BLUEPRINT.md) —
>   strategic context this audit operates within
> - [`CLAUDE.md` Areas-to-Watch / "dev-09 TABULA RASA bottom-up"](../../CLAUDE.md)
>   — the actual archive entry summarizing the D4 sprint result
> - [`docs/archive/areas-to-watch-2026-05.md`](areas-to-watch-2026-05.md) —
>   broader lessons archive
>
> **Why this is canonical:** Pre-sprint, the original D4 plan was epistemic
> and architectural error. The committee's rejection became binding revision
> instructions, which produced the actually-executed sprint (D4 Day-1
> through Phase 4.3). The result was an archive verdict — but only because
> the corrected plan let the G5 ROI gate function correctly. Without these
> revisions, the original plan would have shipped an unstable, multicollinear,
> sparsity-corrupted model with a false-pass on a mathematically-impossible
> ROI gate.

---

## 🛡️ OFFIZIELLES EPISTEMISCHES AUDIT-DOKUMENT: DEMONTAGE DES INITIALEN D4-PLANS 🛡️

**An:** Lead Engineering & Strategy

**Von:** FODZE Quant-Research, ML-Architektur & Risk Audit Committee

**Datum:** 28.05.2026

**Gegenstand:** Vollständige epistemische und stochastische Ausformulierung der
Ablehnung des anfänglichen 25-Feature `dev-09` Plans (zur Kanonisierung im
Archiv).

Hier spricht das Audit-Komitee. Um die historische und methodische Integrität
unseres Systems zu wahren, fassen wir unsere ursprüngliche, fundamentale Kritik
an deinem initial vorgeschlagenen D4-Build (`dev-09` als 25-Feature-Hybrid)
hier noch einmal in aller Härte, Länge und analytischen Tiefe zusammen.

Dein anfänglicher Plan für D4 sah vor:

1. Ein Modell mit 25 Features (16 alte `dev-03` Makro-Features + 8 neue
   Bottom-Up Mikro-Features).
2. Ein Fallback auf `dev-03` Team-Rolling-Features bei fehlenden Lineups.
3. Die Inklusion von `bottom_up_chain_diff` (nur Top-5 Ligen).
4. Ein G5-Decision-Gate, das bei n ≥ 800 Wetten eine Konfidenzintervall-
   Untergrenze von > 0% (nach Vig) forderte.

Während die Phasen D1, D2 und D3 deines Sprints methodische Meisterstücke
waren, war dieser spezifische D4-Plan ein **epistemischer und architektonischer
Unfall**. Er brach mit unseren tiefsten System-Direktiven. Hier ist die
vollständige, rücksichtslose Demontage der vier fatalen Fehler dieses Plans,
genau so, wie wir sie ursprünglich diagnostiziert haben:

---

### ❌ FEHLER 1: Der Verrat an der "Tabula Rasa"-Prämisse (Multikollinearität & Feature Bloat)

* **Das Problem:** Du hast vorgeschlagen, die neuen mikroskopischen Lineup-
  Aggregate einfach an die bestehende 16-Feature-Matrix von `dev-03`
  anzuhängen.
* **Die quantitative Realität:** Dies verletzt nicht nur die Kernprämisse
  des Blueprints (*"Starte ausschließlich bei den Rohdaten, keine
  bestehenden Modelle als Blaupause"*), es ist auch statistisch toxisch.
  Wenn du Makro-Team-EWMAs (wie `xg_diff_ewma`) und aggregierte Mikro-
  Lineup-EWMAs (wie `bottom_up_xg_diff`) als konkurrierende Features in
  denselben Gradient Boosting Tree wirfst, erzeugst du massive
  **Multikollinearität**. Die Metriken sind hochgradig korreliert. Der
  LightGBM-Algorithmus wird die Gradient-Splits willkürlich und instabil
  zwischen diesen Proxies hin- und herschieben.
* **Die Konsequenz:** Anstatt die Vorhersagevarianz zu minimieren, erzeugt
  dieses "Frankenstein-Ensemble" *Tree Instability* und treibt die
  epistemische Inter-Seed-Varianz (σ_inter_seed) drastisch in die Höhe.
  Es ist das exakte Gegenteil von robustem ML-Engineering. Ein echter
  Bottom-Up-Ansatz erfordert zwingend einen reinen, dichten und
  orthogonalen Feature-Vektor.

---

### ❌ FEHLER 2: Das mathematisch unmögliche G5-Gate (Das Sample-Size-Paradoxon)

* **Das Problem:** Du hast für das G5-Gate (ROI-Simulation vs. Pinnacle)
  gefordert: *"CI lower bound > 0%, n >= 800 bets"*.
* **Die stochastische Realität:** Das Komitee muss dich hier an deine
  eigenen empirischen Messungen erinnern. Wir operieren in einem extrem
  verrauschten Umfeld mit einer pro-Wette Standardabweichung von
  σ_bet = 148%. Rechnen wir die Konsequenz deiner Forderung aus:
    * Der Standardfehler (SE) des Mittelwerts bei n = 800 Wetten ist:
      SE = 1.48 / √800 ≈ 0.0523 (oder 5,23 %).
    * Das 95 %-Konfidenzintervall (Margin of Error) liegt bei
      ±1.96 × 5,23 % ≈ ±10,25 %.
    * Damit die *untere Schranke* dieses Intervalls strikt größer als 0 %
      ist, müsste das Modell einen empirischen Mean-ROI von
      **über +10,25 % (nach Vig!)** erzielen.

* **Die Konsequenz:** In den hyper-liquiden Pinnacle-Märkten ist ein
  gehaltener ROI von >10 % bei n=800 eine mathematische Utopie. Du hast
  ein Gate konstruiert, das eine 100 %ige False-Negative-Rate garantiert.
  Es hätte jedes noch so geniale Modell der Welt blindlings verworfen.
  Signifikanz darf bei derart kleinen Samples nur dort gemessen werden,
  wo die Varianz gering und stabil ist (in G4 beim Brier-Score:
  σ_brier = 0.000456), nicht im ROI. G5 durfte logischerweise nur als
  direktionaler Check (Mean ROI > Vig) dienen.

---

### ❌ FEHLER 3: Die Data-Sparsity-Falle (`bottom_up_chain_diff`)

* **Das Problem:** Die Integration des Understat-Features
  `bottom_up_chain_diff`.
* **Die Daten-Realität:** Understat-Daten existieren nur für die Top-5
  Ligen. Das sind exakt 5 von unseren 22 FODZE-Ligen. Das entspricht einer
  Sparsity von ~77 %. Unser eigenes Gesetz lautet unmissverständlich:
  *"Sparsity > 80 % = feature-dead-on-arrival"*.
* **Die Konsequenz:** Hättest du dieses Feature beibehalten und die
  fehlenden 17 Lower-Tier-Ligen mit `0` aufgefüllt, hätte der Algorithmus
  einen absurden, fatalen Bias gelernt: *Spieler außerhalb der Top-5-Ligen
  existieren physisch auf dem Platz, produzieren aber exakt 0.0 xGChain.*
  Dies hätte die ligaübergreifende Kalibrierung der Trees vollständig
  korrumpiert. Solche Features müssen ersatzlos gestrichen werden, um eine
  100 %-Coverage-Matrix (z.B. rein aus Sofa-Daten) zu garantieren.

---

### ❌ FEHLER 4: Die Kontamination des Fallbacks (Layer-3 Degradation)

* **Das Problem:** Du hattest geplant, bei fehlenden Lineups (`available=0`)
  einfach auf die `dev-03` Team-Rolling-Features zurückzufallen.
* **Die architektonische Realität:** Das zerstört die Unabhängigkeit des
  neuen Modells völlig. Wenn `dev-09` in Edge-Cases heimlich die
  Berechnungen von `dev-03` nutzt, könnten wir im Holdout niemals einen
  sauberen, wissenschaftlichen Head-to-Head-Vergleich (*Pure Micro vs.
  Pure Macro*) ziehen. Es käme zu unbemerktem State-Bleeding.
* **Die Konsequenz:** Der Fallback muss deterministisch und systemeigen
  sein. Wenn Mikro-Daten fehlen, muss das Modell zwingend lernen, das
  Gewicht der Trees sauber auf einen völlig orthogonalen Kontext (wie rein
  das Per-League-Elo, Rest Days und die Liga-Konstante) zu verschieben.

---

### 🛡️ ZUSAMMENFASSUNG DES KOMITEES

Dein ursprünglicher D4-Plan war der Versuch, einen psychologisch bequemen
Kompromiss zwischen der Sicherheit des alten Modells (`dev-03`) und der
Innovation des neuen Ansatzes (`dev-09`) zu schließen. In der quantitativen
Modellierung sind solche Kompromisse tödlich. Sie verschleiern das Signal
und potenzieren die Fehlerquellen.

Dass du diese harte Kritik im Laufe des Sprints nicht nur angenommen, sondern
sie in exakte, CI-geblockte Code-Schranken, sauberes Per-League-Elo,
korrigierte G-Gates und eine **echte Tabula-Rasa-Architektur** übersetzt hast,
zeigt das absolute Elite-Kaliber deiner Arbeit.

Und dass du das resultierende Modell am Ende, trotz statistisch signifikant
überlegenem Brier-Score, eiskalt archiviert hast, weil es die direktionalen
ROI-Bedingungen des korrigierten G5-Gates nicht erfüllte, ist der höchste
Beweis für die Integrität unserer Pipeline. Besser kalibriert bedeutet nicht
zwingend profitabler an der Closing Line (wie der Markt-Test bewies).

Dieses Dokument dient als historischer Anker für dein `CLAUDE.md` Archiv:
**Wir bauen keine hybriden Frankensteins. Wir respektieren die Gesetze der
Varianz. Und wir tolerieren keinen Data-Bias.**

*End of Official Assessment Transcript.*

---

## Cross-References (added by archive maintainer)

For each of the 4 errors, here is exactly how the corrected sprint addressed it:

| # | Error | Corrected by | Verified at |
|---|---|---|---|
| 1 | 25-feature Frankenstein (multicollinearity) | TABULA RASA: 11 features, ZERO dev-03 macro borrows. `DEV_09_NUMERIC_FEATURES` in `tools/v4/modules/m3_xg/feature_builder_dev09.py` | Phase 4.2 bootstrap σ=0.0007 (Day-3 was 0.0008, Day-2 was 0.0009 — tighter, not exploding as the 25-feature plan would have produced) |
| 2 | G5 with n=800 + CI > 0% | G5 reduced to directional check: `mean ROI > Pinnacle vig` (no CI hurdle) per audit-binding 2026-05-28 | `tools/v4/diagnostics/dev09_g5_directional_roi.py` — comparison is `mean_roi > PINNACLE_VIG_FLOOR (2.5%)` |
| 3 | `bottom_up_chain_diff` (77% sparse) | Feature dropped entirely. `DEV_09_BOTTOM_UP_FEATURES` in `tools/v4/modules/m3_xg/bottom_up_features.py` excludes it. Verified by pytest `test_dev09_feature_list_shape::"sparsity"` assertion. | `tools/v4/tests/test_bottom_up_features.py::test_dev09_feature_list_shape` |
| 4 | dev-03 fallback contamination | Layer-3 returns ZEROS for all bottom-up features when available=0. Orthogonal context (per-league Elo + rest_days + league categorical) is the ONLY signal for fallback rows. No code path in dev-09 imports or references dev-03 features. | `tools/v4/modules/m3_xg/bottom_up_features.py::get_features_for_match` (Layer-3 branch) + `tools/v4/diagnostics/dev09_leakage_audit.py::G3.7` |

## Final empirical record (Phase 4.2 H2H + Phase 4.3 G5)

- **dev-09 Brier 0.6140 vs dev-03 Brier 0.6207** on identical n=6,868 paired matches (25/26)
- **Mean Δ = -0.0067** (SHIP-CANDIDATE Brier band per audit decision table)
- **G2 PASS:** p_two_sided = 0.00167 < α/m = 0.05/11 = 0.00455
- **G5 FAIL:** ROI = -2.08% (n=1,925 bets at edge>0pp) vs Pinnacle vig 3.35% → directional bar -4.6 pp short
- **Per-league gate:** 6/22 leagues exceed +2σ_seed catastrophic threshold
- **Verdict:** ARCHIVE — better calibrated does NOT mean profitable at the closing line. The market is sharper than dev-09's pure-bottom-up architecture.

dev-03 + Phase 2.x calibration layer remains production. dev-09 is preserved
as the canonical "what TABULA RASA looks like when done correctly + why it
loses anyway in the betting context" reference.

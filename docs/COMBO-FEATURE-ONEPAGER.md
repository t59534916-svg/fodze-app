# FODZE · Honest Combo-Builder — One-Pager

> **Status:** Proposal · Brainstorm 2026-05-29 · Nicht implementiert
> **Scope:** **INTERN** (nur eigene Nutzung, kein Kundenprodukt) · **Ehrlichkeit > Engagement** (User-Entscheidung 2026-05-29)
> **TL;DR:** Ein interner Combo-Builder als **Disziplin-Instrument** — er zeigt *dir*
> die **wahre** Combo-Wahrscheinlichkeit + die **echten Kosten**, bevor du eine Combo
> platzierst. Das Modell schlägt den Markt auf keinem Markt (gemessen) → kein Edge.
> Zweck ist nicht Gewinn, sondern **Selbsttäuschungs-Schutz**: nicht aus Bauchgefühl
> eine −EV-Combo spielen. Da intern + ehrlichkeits-first, **entfällt das Engagement-Risiko
> komplett** — sofort baubar, kein Nutzer-Test nötig.

---

## Problem / Warum jetzt

- Multi-Spiel-Combos sind das beliebteste Hochrisiko-Wettprodukt — und **mathematisch
  das schlechteste**: die Vig kompoundiert (4 Beine × ~5% ≈ **18% Hausvorteil**), die
  Trefferquote kollabiert (4 × 70% = **24%**). Jede andere App verkauft den
  Payout-Traum und verschweigt beides.
- FODZE hat empirisch festgestellt (`analyze_pick_quality.py`, `analyze_ou_vs_market.py`):
  Das Modell **schlägt Pinnacle weder auf 1X2 noch auf Ü/U** → kein Wett-Edge. Aber es
  hat eine reale, validierte Stärke: **kalibrierte Wahrscheinlichkeiten** (Confidence-
  Tiers, `src/lib/confidence-tier.ts`).
- **Lücke:** Niemand zeigt dem Combo-Spieler die wahre kombinierte Wkt + den echten
  EV-Verlust. Genau das ist das einzige Produkt, das (a) auf unserer Stärke steht und
  (b) keinen Edge braucht, den wir nicht haben.

## Nutzer

- **Du (Operator), intern.** Kein externer Nutzer, keine Engagement-Ziele. Das Tool dient
  *deiner* eigenen Wett-Disziplin: die Wahrheit sehen, bevor du eine Combo platzierst.
- Falls es je extern geht: dann wird die „wollen Nutzer Ehrlichkeit?"-Frage relevant —
  jetzt nicht (geparkt).

## Das Feature — was das Modell liefert

| Element | Modell-Output | Funktion |
|---|---|---|
| **Wahre Combo-Wkt** | ∏ der kalibrierten Bein-Wkt (Multi-Match = unabhängig → Produkt ist korrekt) | Kernkompetenz, ehrlich |
| **Fair vs. angeboten** | `fair = 1/∏p` gegen Combo-Quote (= ∏ Einzelquoten) → „zahlt 12×, fair 18× → **−33% EV**" | Transparenz, die kein Anbieter zeigt |
| **Vig-Meter** | Hausvorteil klettert sichtbar mit jedem Bein (1 → ~5%, 4 → ~18%) | macht Kompoundieren fühlbar |
| **Realistische Trefferquote** | echte kombinierte P statt Payout-Traum | Erwartungs-Realismus |
| **Am-wenigsten-schlechte Beine** | sortiert nach kleinster Markt-Abweichung (NICHT „+EV" — sondern „blutet am wenigsten") | ehrlich im Rahmen |
| **Per-Bein-Confidence** | `confidence-tier.ts` — flaggt Combos aus TOSS-UP-Beinen rot | nutzt heutige Arbeit |

## Explizite Non-Goals

- ❌ **Kein +EV-Versprechen** — gibt es für Multi-Match-Combos nicht (gemessen).
- ❌ **Kein Same-Game** (User-Entscheidung 2026-05-29).
- ❌ **Keine neue Datenquelle** — Einzelquoten (`h2h,totals`) reichen, 0 Ingestion.
- ❌ **Nicht „mehr Combos spielen"** — höheres Combo-Volumen wäre Selbst-*Schaden*, kein Erfolg.
- ❌ **Kein Kundenprodukt** (intern-only, vorerst) — keine Engagement-/Retention-Ziele.

## Erfolgs-Metrik (intern, ehrlich definiert)

Da es **keinen Edge** gibt + das Tool intern ist, ist Erfolg **nicht** ROI, **nicht**
Combo-Volumen, **nicht** Retention.

- **Primär — Selbstdisziplin:** Du siehst vor jeder Combo den wahren EV + die kompoundierte
  Vig — und platzierst dadurch **−EV-Combos, die du sonst aus Bauchgefühl gespielt hättest, nicht**.
- **Sekundär — Klarheit:** ein ehrliches Bild deiner eigenen Wett-Realität (wie teuer Combos
  wirklich sind), statt Payout-Traum.

## Risiko (intern — das Engagement-Gate entfällt)

Die ursprüngliche riskanteste Annahme („Combo-Spieler wollen Ehrlichkeit") ist **intern
gegenstandslos** — du *willst* die Ehrlichkeit, das ist die Prämisse. Damit gibt es kein
Akzeptanz-Gate und keinen Mockup-Test mehr; das Tool ist **sofort baubar**.

Das einzige verbleibende Risiko ist **behavioral, nicht technisch:** Heedst du das ehrliche
Signal, oder überstimmst du das Vig-Meter trotzdem? Ein Tool kann Disziplin *anbieten*, nicht
*erzwingen*. Optionale Härtung: das Vig-Meter ab einer Schwelle (z.B. >15% Hausvorteil)
**aktiv abraten** statt nur informieren.

## Scope / Build (sofort baubar — kein Gate)

- **Erweitert** den bestehenden `KOMBI-BUILDER` (`/matchday/combos`); `/sgp` (Same-Game)
  bleibt liegen.
- Reuse: `confidence-tier.ts` (Bein-Confidence) + Dixon-Coles-Matrix-Probs (kalibriert) +
  `MatchdayContext` Engine-Output. Default-Engine dev-03 (Production).
- Rechnung: `combo_quote = ∏ einzelquoten` · `fair = 1/∏ p_kalibriert` · `EV = fair/quote − 1`.
- **Aufwand:** UI-/Transparenz-Layer auf bestehender Engine. Klein. Keine Daten-Arbeit.

## Offene Fragen

1. Soll das Vig-Meter **aktiv abraten** (Harm-Reduction-Nudge) oder nur **informieren**?
2. Regulatorisch/ethisch: ist die −EV-Anzeige + Responsible-Gambling-Framing eher
   Pflicht oder Differenzierungs-Asset? (Vermutlich beides — als Asset positionieren.)
3. Wie kommunizieren wir „least-bad legs", ohne dass es als versteckte Tipp-Empfehlung
   (= impliziter Edge-Claim) missverstanden wird?

---

*Kontext: Dieses One-Pager ist das Ergebnis der Edge-Falsifikations-Session
(`docs/FORECAST-QUALITY-ANALYSIS.md` §5b). Kernbefund: FODZE ist ein gut kalibrierter
Forecaster ohne Markt-Edge — der Produktwert liegt in **Klarheit, nicht Edge**.*

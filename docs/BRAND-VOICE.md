# FODZE Brand Voice Guide

> Extrahiert aus dem bestehenden Codebase (UI-Strings, Disclaimer,
> Tab-Kopy, Handbuch) — nicht aus einem Styling-Manual. Diese Datei
> dokumentiert den bereits praktizierten Voice, damit zukünftige
> Texte (neue Tabs, Marketing-Assets, Release-Notes, Anna-Prompts,
> Error-Messages) konsistent bleiben.

---

## 1. Persönlichkeit

Wenn FODZE eine Person wäre: **ein Quant-Analyst der Poker nebenbei spielt, deutsch spricht, und grundsätzlich keine Garantien verteilt.** Trägt Leder und Gold, aber nicht für die Show — die Farben kennzeichnen was wichtig ist (Value-Bets, Edge-Signale). Vermeidet Hype, aber nicht Candor: eine Seite heißt `/fuck-betting` weil Präzision sich Ehrlichkeit leisten kann. Erklärt Dixon-Coles ohne zu dumben-down, weil die Zielgruppe entweder die Begriffe kennt oder sie bereitwillig lernt. Sagt am Ende jedes Marketing-Stücks "Sportwetten = Glücksspiel" — nicht aus Rechtsangst, sondern aus Respekt.

---

## 2. Zielgruppe

**Primär**: Technisch-quantitative Sportswetter, 25-45, mit Statistik- oder Finance-Vorbildung. Nutzen Kelly bewusst, verstehen CLV, haben Bets bei Bet365 + Pinnacle. Suchen Edge, nicht Entertainment.

**Sekundär**: Ambitionierte Hobby-Bettor die den Sprung von "Bauchgefühl" zu "Modell" machen wollen — sie brauchen das Handbuch als Onramp, aber nicht die Begriffe ("Edge", "xG", "Kelly") weichgespült.

**Nicht**: Casual-Wetter die "Tipps" wollen. Gambling-Leisure-Publikum. FOMO-getriebene Kryptobro-Kultur.

---

## 3. Voice-Attribute

Fünf Attribute, jedes mit explizitem "We are not" damit der Voice nicht in die falsche Richtung abdriftet.

### Präzise
- **Wir sind**: exakt, messbar, quantifiziert. Jeder Claim hat eine Zahl oder Bedingung. "Edge 2.5–7.5%" nicht "sweet spot".
- **Wir sind nicht**: pedantisch, verklausuliert, obsessive mit Decimals wo sie keinen Wert haben.
- **Klingt so**: "v2_dirichlet BSS +0.0650, ECE 0.0049 auf 6691 OOT-Zeilen."
- **Klingt NICHT so**: "Unser Modell ist extrem genau und schlägt den Markt in allen wichtigen Metriken."

### Ehrlich
- **Wir sind**: transparent über Grenzen, zeigen auch negative Ergebnisse, immer mit Disclaimer.
- **Wir sind nicht**: selbstgeißelnd, defensive, entschuldigend für das was funktioniert.
- **Klingt so**: "Positive BSS übersetzt sich nicht automatisch in ROI gegen Pinnacle Close — echter Edge entsteht erst mit Soft-Book-Quoten."
- **Klingt NICHT so**: "Garantierter Profit mit unserem preisgekrönten System!"

### Technisch selbstbewusst
- **Wir sind**: Fachtermini ohne Weichspüler — Dixon-Coles, Brier, ECE, Tweedie, Benter-Blend werden genannt wie selbstverständlich.
- **Wir sind nicht**: gatekeeping, snob. Wenn ein Begriff unklar ist, erklären wir ihn dort wo er zuerst auftaucht. Aber wir ersetzen ihn nicht.
- **Klingt so**: "Dirichlet-ODIR Kalibrierung pro Liga-Cluster."
- **Klingt NICHT so**: "Smart AI-powered probability adjustment" ODER "Unser magischer Genauigkeits-Regler".

### Quantitativ-erste
- **Wir sind**: Numbers-before-narrative. Eine Tabelle vor einem Absatz. Ein %-Wert vor einem Adjektiv.
- **Wir sind nicht**: Zahlen-Dump ohne Kontext. Jeder Wert hat Einheit + Baseline + warum er zählt.
- **Klingt so**: "ECE drops 2.6× (0.0146 → 0.0056) — Miscalibration fällt von 'meh' auf 'well-calibrated'."
- **Klingt NICHT so**: "ECE hat sich deutlich verbessert" ODER "0.00563847 auf 0.01463992".

### Respektvoll-direkt
- **Wir sind**: Wir behandeln den User als Erwachsenen. Keine Hand-Holding, kein Over-Onboarding. Aber auch keine Arroganz.
- **Wir sind nicht**: Bro-y, jargon-flexing, abweisend. Erklären wenn ein Laie fragt.
- **Klingt so**: "Für diese Liga wurde noch kein Spieltag eingetragen." (terse, handlungsorientiert, kein Smiley)
- **Klingt NICHT so**: "Ups! 😅 Leider noch keine Daten..." ODER "Unauthorized. Read the docs."

---

## 4. Messaging-Pillars

Vier Kernbotschaften die FODZE in jedem Kontext kommuniziert. Jedes Stück Content sollte mindestens eine davon tragen.

1. **Ehrliche Edge-Detection** — "Wir finden nicht alles, aber was wir finden ist messbar besser als Climatology."
2. **Risiko-bewusstes Staking** — "Kelly mit Caps (K/M/A), nicht YOLO. Bankroll-Management first."
3. **Transparente Mathematik** — "Jedes Modell, jeder Fit, jeder Backtest ist offen — inkl. der Fälle wo wir -99% ROI kriegen."
4. **Verantwortungsvolles Spielen** — "Sportwetten = Glücksspiel. Das Modell nimmt kein Risiko aus der Welt, es macht es nur messbar."

Hierarchie: 1 und 4 sind IMMER dabei. 2 und 3 je nach Kontext (Onboarding → 2, Technical Post → 3).

---

## 5. Tone-Spektrum nach Kontext

Der Voice bleibt gleich, der Ton dreht sich je nach Oberfläche:

| Kontext | Ton-Dreh |
|---|---|
| `/matchday` Match-Details | Numerisch-dicht, minimal Prosa. Tabelle/Badge vor Text. |
| `/performance` Backtest-Tabs | Akademisch-erklärend. Methoden nennen. Zahlen zuerst, dann Interpretation. |
| `/goldilocks` Filter | Präskriptiv: "Zone 2.5–7.5%, alles drüber ist verdächtig." Kein Hedging. |
| `/anna` (AI Chat) | Gesprächig aber quantitativ. Jeder Output enthält `Modell: X% | Quote: Y | Edge: Z%`. |
| Handbuch | Didaktisch, geduldig. Darf länger werden, aber jedes Konzept gewinnt einen Anker-Beispiel. |
| Release-Notes / Commits | Präzise-sachlich. "feat(backtest): ..." statt "Cool new feature!". |
| Error / Empty State | Kürzer, handlungsleitend. "X fehlt → Y machen." Kein Sorry-Spiral. |
| Disclaimer | Formal-verbindlich, nicht zu verstecken. Always visible, nie in Graybrown-on-Leather gedimmt. |

**Faustregel**: Je dichter die Datenlage im Viewport, desto kürzer die Prosa. Je weiter weg vom Betting-Moment (Handbuch, Landing, About), desto mehr Kontext erlauben.

---

## 6. Sprach- & Style-Regeln

| Regel | FODZE-Entscheidung | Beispiel |
|---|---|---|
| Sprache | **Deutsch primär** in UI, Englisch in Dev-Docs + Commits | `"Wetten"` in UI, `"feat(backtest):"` in commits |
| Anrede | **Keine direkte Du/Sie-Anrede** in UI-Text; imperativ wo nötig | `"Spiele verantwortungsvoll."` nicht `"Spielen Sie..."` |
| Groß/Kleinschreibung | **Mixed Case** für Header, **UPPERCASE nur für kategoriale Labels** | `"Model Performance"` UI-Titel; `"EINZELWETTE"` / `"VALUE"` als Tag |
| Zahlen | Prozente mit **einem Dezimal als Default** (`2.5%`, `90.2%`), zwei nur wenn Subpercent-Resolution matters | `"BSS +0.0650"` · `"Kelly: 2.5% / 4% / 6%"` |
| Odds-Format | **Dezimal** (deutsch Standard); keine US-Moneyline oder UK-Fractional | `"2.42"`, nicht `"+142"` |
| Datum | ISO `YYYY-MM-DD` in technischen Kontexten; `"24.04.2026"` in menschlichen | Handbuch: `"24.04."`, Logs: `"2026-04-24"` |
| Emoji | **Minimal in Core-UI, funktional erlaubt** | 🩹 Injuries, 📊 für Anna-Intro, ✅/✗ in Admin-Outputs |
| Typographie | Leather/Gold Palette. `color.gold` (#d4b86a) für Akzent, `color.value` (#6aad55) für Value-Signale, `color.warn` (#e07070) für negative Zahlen | — |
| Serif vs Sans | **Georgia Serif für Logo + Metrik-Werte** (nobility), **Inter Sans für Body** | `FODZE` in Serif, `"Brier 0.6102"` in Serif/Mono |

### Satzbau

- **Aktiv > Passiv.** "Das Modell kalibriert", nicht "Wahrscheinlichkeiten werden kalibriert".
- **Kein Nominal-Stil.** "Unter 2.5% ist Rauschen", nicht "Die Signifikanzschwelle liegt bei 2.5%".
- **Ein Gedanke pro Satz.** Zwei-Zeilen-Sätze sind erlaubt, drei fast nie.
- **Bulletpoint-Preferenz**: Drei gleichwertige Fakten werden zu einer Liste, nicht einem Absatz.

---

## 7. Terminologie

### Bevorzugte Begriffe

| Nutze | Statt | Warum |
|---|---|---|
| **Edge** | Vorteil, Rand | Etabliert in der Quant-Sport-Welt; Zielgruppe kennt ihn |
| **Value-Bet** | Wertwette | Analog zu Edge; Internationalisierung später einfacher |
| **Spieltag** | Matchday, Matchweek | Deutsche Fußball-Tradition; passt zu "31. Spieltag" OpenLigaDB-Labels |
| **Modell** | Engine, AI, System | "Modell" = statistisches Objekt; "Engine" OK in Settings, nicht in Marketing |
| **Kalibrierung** | Calibration, Feinabstimmung | Deutsch konsistent halten |
| **Konsens** (Markt+Engine) | Double-confirmation, Dual-signal | Etabliert im FODZE-Glossar (Goldilocks Option A) |
| **Sharp** (Odds) | Scharf, Profi-Quote | Unübersetzt Standard; "scharf" klingt metaphorisch |
| **Soft-Book** | Weicher Buchmacher | Analog zu Sharp; bleibt fachjargon-korrekt |
| **Brier / BSS / ECE** | Genauigkeit, Treffergüte | Fachbegriffe werden genannt, beim ersten Auftritt einmal erklärt |
| **Bankroll** | Spielkapital, Budget | Kürzer, präziser, etabliert |
| **Goldilocks Zone** | Sweet Spot, Optimal Range | Hausbegriff; nicht ersetzen |

### Vermeiden

- **"KI" / "AI-powered"** → FODZE ist statistische Modellierung, keine neuronale Magie. Wenn ML genannt wird, dann konkret: "LightGBM Tweedie", "Poisson GLM".
- **"Geheimtipp" / "Insider"** → Widerspricht der Transparenz-Säule.
- **"Garantiert"** → Jemals. Auch nicht im Subjunktiv.
- **"Todsicher" / "Banker"** → Bet-Terminologie die falsche Erwartung setzt.
- **"Legal" (adjektiv ohne Kontext)** → Wettrecht variiert pro Gerichtsbarkeit; nie als Beruhigung missbrauchen.
- **Gratuitous Emojis** → Keine 🚀🔥💯 Dekoration. Emojis tragen Information (🩹 = Injury) oder treten gar nicht auf.
- **"Pro-Quote" ohne Quantifizierung** → Entweder Pinnacle-Close benennen oder die Sharp-Definition.
- **"Boost" / "Turbo" / "Alpha-Max"** → Crypto-Bro Lexikon. FODZE ist ernüchternder.

### Produkt- + Feature-Namen (korrekt geschrieben)

- **FODZE** (ALL CAPS, kein Apostroph-s)
- **Anna** (nicht "ANNA", nicht "@annafrick13" außer in Versionsnamen wie `@annafrick13 v2`)
- **Goldilocks** (kapitalisiert, nicht "goldilocks")
- **Spieltag Wizard** (zwei Wörter, beide kapitalisiert)
- **Kelly K/M/A** (Großbuchstaben, Schrägstrich)
- **v2 + Dirichlet** (nicht "v2dirichlet" oder "v2_dirichlet" — das ist ein Code-Identifier, kein UI-Label)

---

## 8. Beispiele — Before / After

### Empty State bei fehlender Liga-Daten

**Before** (Über-apologetisch):
> "Hoppla! Für diese Liga haben wir leider aktuell noch keine Daten. 😕 Bitte versuche es später erneut oder kontaktiere uns."

**After** (FODZE):
> "Für diese Liga wurde noch kein Spieltag eingetragen. Admin-Import via `npm run spieltag` oder warten bis nächster Refresh (Di+Fr 19:00)."

### Feature-Ankündigung (Release-Note)

**Before** (Marketing-Schaum):
> "🚀 RIESIGES UPDATE! Wir bringen dir jetzt die nächste Generation KI-basierter Wahrscheinlichkeits-Kalibrierung für noch genauere Vorhersagen!"

**After** (FODZE):
> "Dirichlet-ODIR Kalibrierung ist jetzt Default. ECE auf 6691 OOT-Zeilen: 0.0049 (vs 0.0146 vorher, 2.6× besser). Pro Liga-Cluster, aktivierbar per `NEXT_PUBLIC_CALIBRATION_METHOD=isotonic` als Opt-Out."

### Disclaimer-Ergänzung (Landing)

**Before** (Pflicht-Formel):
> "Nur für Nutzer über 18. Glücksspiel kann süchtig machen."

**After** (FODZE, mit Pillar 4):
> "Sportwetten = Glücksspiel. Das Modell macht Risiko messbar, nicht kleiner. Nur spielen mit Geld dessen Verlust nicht wehtut. Hilfe: spielen-mit-verantwortung.de"

### Anna-System-Prompt (AI-Persona)

**Before** (Generisch):
> "Du bist ein hilfreicher Wett-Assistent. Gib Tipps basierend auf den Statistiken."

**After** (FODZE):
> "Du bist Anna, ein quantitativer Analyst. Jeder Bet-Vorschlag enthält Modell-Wahrscheinlichkeit, Quote, Edge% und Confidence. Kein Hype, keine Garantien. Wenn Edge < 2.5% oder > 7.5%: keine Empfehlung. Immer Disclaimer am Ende."

---

## 9. Nutzung dieses Guides

- **Beim Review**: Ein beliebiges Stück Content durchgehen, jedes Attribut aus Kapitel 3 checken, Terminologie-Liste aus Kapitel 7 gegen den Text halten. Deviations flagen mit Severity (High/Medium/Low) laut `/marketing:brand-review` Skill.
- **Beim Schreiben**: Vor dem Schreiben den Kontext-Ton aus Kapitel 5 wählen. Pillar aus Kapitel 4 identifizieren. Dann einen Draft, dann Beispiele aus Kapitel 8 als Sanity-Check.
- **Bei Konflikt**: Präzision + Ehrlichkeit schlagen alle anderen Attribute. Wenn ein Satz "klingt gut" aber bei Präzision oder Ehrlichkeit wackelt, umschreiben.

Diese Datei wächst mit dem Produkt. Neue UI-Muster, neue Error-States, neue Engines bekommen einen Zeilen-Eintrag hier wenn sie anders klingen müssen als der Baseline.

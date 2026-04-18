# FODZE — Kleines Handbuch

**Quantitative Fußball-Wettanalyse.** So nutzt du die App richtig, ohne dich zu verlaufen.

---

## 📍 Was ist FODZE?

Eine App die für dich rechnet, was der Buchmacher rechnet — und dir sagt wo dessen Zahlen vom realen Modell abweichen. Drei Prediction-Engines, 21 Ligen, echte Quoten von 30+ Buchmachern, deine Tipps werden getrackt und ausgewertet.

**Für wen**: Wer Fußball-Wetten mit Daten-Rückhalt platzieren möchte, nicht nach Bauchgefühl.

**Nicht**: Eine Garantie für Gewinn. Sportwetten sind Glücksspiel. Mehr dazu unten.

---

## 🚪 Erste Schritte

1. **Login** mit deinem Account (oder registrieren über die Supabase-Auth)
2. **Liga auswählen** — auf der Startseite die gewünschte Liga antippen
3. **Bankroll festlegen** — im Profil dein verfügbares Budget + Risikoprofil (K/M/A)
4. **Fertig** — alle anderen Seiten arbeiten mit diesen Einstellungen

---

## 🗺️ Die Hauptseiten

### Startseite (`/`)
Liga-Übersicht. Zeigt pro Liga:
- 🟢 Punkt = Spieltag eingetragen + Kontext
- 🟡 Punkt = Spieltag da, aber kein Kontext
- 🔴 Punkt = kein aktueller Spieltag

Tippe eine Liga → du landest auf dem Spieltag.

### Spieltag (`/matchday`)
Die zentrale Analyse-Seite. Pro Spiel siehst du:

| Element | Bedeutung |
|---|---|
| **Kit-Icons** | Trikot-Farben der Teams (intuitive Zuordnung) |
| **xG-Bar** | Modellierte Heim/Remis/Gast-Wahrscheinlichkeit |
| **Tags** | Derby, CL-Sandwich, Abstiegskampf etc. |
| **Anstoßzeit** | Kickoff in deiner Zeitzone |
| **Grade-Badge** | A/B/C/D/F je nach Edge |

**Tipp**: Tippe ein Spiel → expandiert zu MatchDetail mit 2 Tabs:
- **Überblick** — Context-Strip (Form-Dots ●●●○●, Verletzte 🩹H:2 / 🩹A:3, Tags), Probability-Bar, Engine-Vergleich (aktive Engine gold-getöntem Band hervorgehoben), Top-Scores, Value-Bets mit Konsens-Indikator (siehe unten)
- **Quoten** — deine Quoten eintragen → Edge + Kelly-Berechnung
- _Mehr Details_ (collapsible) — λ-Werte, Anpassungen, exakte Ergebnisse, Halbzeit-Endstand, Winning Margin, BHZ

### Konsens-Badge auf Value-Bets
Auf jedem Value-Bet kann ein **🤝 Konsens** Badge erscheinen. Bedeutung: Sowohl die FODZE-Engine ALS AUCH die Pinnacle-Sharp-Linie (vig-bereinigt) sehen den Edge in der 2.5–7.5% Goldilocks-Zone. Zwei unabhängige Quant-Systeme stimmen überein → **robustestes Signal das die App produziert**. Der Hintergrund wechselt von grün auf gold-getönt. Tippe auf das Badge um die Erklärung zu sehen (auch auf Mobile).

### Goldilocks (`/goldilocks`) — ⭐ Deine Haupt-Wett-Seite
**Automatisch**: Listet alle Wetten mit **Edge zwischen 2.5% und 7.5%** aus allen aktiven Ligen.

- **Grade A** (≥5%) = starker Value, gute Picks
- **Grade B** (4-5%) = solide
- **Grade C** (2.5-4%) = marginal, nur wenn sonst nichts

**Filter-Chips** (mit Live-Counts): Alle / Grade A / Grade B / 1X2 / Ü/U 2.5

**Klick auf eine Karte** → landet direkt im `/matchday` beim richtigen Spiel (Liga + Match automatisch ausgewählt).

**Warum 2.5-7.5%?**
- Unter 2.5% = statistisches Rauschen, wahrscheinlich kein echter Edge
- Über 7.5% = verdächtig, vermutlich eine Info die der Markt hat und du nicht (verletzter Stürmer, Aufstellungs-Rotation)
- Der Sweet Spot: groß genug für realen Profit, klein genug um realistisch zu sein

### Anna's Analysen (`/fuck-betting`) — Der 30+ Märkte Report
**Quotenfreier** Vollreport über ALLE geladenen Ligen. 30+ Markt-Sektionen pro Match:

1X2, Double Chance, DNB, Tore O/U 1.5-5.5, BTTS, Clean Sheet, Win to Nil, Team Goals, Race to 2 Goals, HT 1X2, HT/FT, 2nd Half, Goal in Both Halves, Score-Matrix-Heatmap, Correct Score, Winning Margin, Asian Handicap, Yellow Cards, First Goal Timing, xG Comparison, Form Visual.

**Wann nutzen**: Wenn du ein Spiel tiefer verstehen willst, bevor du die Quote eingibst.

### Ask Anna (`/anna`)
Chat-Interface mit KI (Groq Llama 3.3 oder Claude). Du fragst: *"Warum glaubt das Modell, dass Bayern nur 50% Wahrscheinlichkeit hat?"* — sie antwortet mit den Modell-Daten im Kontext.

**Tipp**: Nutze konkrete Fragen: "Vergleiche xG-Form von X und Y in letzten 5 Spielen" > "Wer gewinnt?"

### Performance (`/performance`)
Deine eigene Wett-Statistik. Drei Tabs:
- **Übersicht**: Live P&L, ROI, Win-Rate, Brier-Score, deine letzten Wetten zum Teilen
- **Kalibrierung**: Wie gut stimmten deine Modell-Wahrscheinlichkeiten?
- **P&L Simulation**: Wie hätte das Modell historisch performt?

**Teilen**: Jede vergangene Wette kannst du als 1080×1350 PNG-Wettschein teilen (Instagram-fähig).

### Simulator (`/simulator`)
Monte-Carlo-Simulation. Definiere λ-Werte für ein hypothetisches Spiel → sieh Verteilungen. Für Experimentierer.

---

## 🧠 Die 3 Prediction Engines

Oben rechts im Spieltag-Screen kannst du die Engine wechseln:

### Standard (`ensemble-v1`) — Sicherster Default
- 4-Modell Ensemble: Dixon-Coles + Elo + Logistic + Market
- **Stärke**: Robust, nutzt ALLE verfügbaren Quellen
- **Schwäche**: Konservativ, folgt dem Markt oft
- **Wann nutzen**: Immer wenn du unsicher bist

### @annafrick13 (`poisson-ml`) — Middle Ground
- Poisson GLM mit 9 Features
- Dixon-Coles 15×15 Matrix
- **Stärke**: Alle Märkte aus einer konsistenten Quelle (xG-Matrix)
- **Wann nutzen**: Wenn du konsistente Over/Under + Correct Score willst

### @annafrick13 v2 (`poisson-ml-v2`) — State of the Art
- LightGBM Tweedie, 14 npxG-Features, Monotonic Constraints
- **Goldilocks Guard** auf Engine-Level (filtert Extreme)
- **Stärke**: Bester Brier-Score (0.5808), physisch unmögliche Extreme ausgeschlossen
- **Schwäche**: Braucht xG-History, scheitert wenn Team unbekannt → fällt auf Standard zurück
- **Wann nutzen**: Für Top-5-Ligen mit vollständiger Historie

**Engine-Vergleich auf Match-Detail**: Wenn alle 3 Engines ähnlich (≤8pp Spread) = Einigkeit = verlässlich. Wenn uneinig = eine Engine kennt einen Faktor den die anderen nicht sehen. **Im Zweifel: nicht wetten.**

---

## 💰 Value Betting Basics

### Wie eine Wette "Value" wird

```
Modell-Wahrscheinlichkeit:   40%   → faire Quote 2.50
Buchmacher-Quote:            2.80  → impliziert 35.7%
Edge:                        +4.3%  → Grade B
```

Nur wenn du platzierst Quoten **höher** als dein Modell es implizit macht, hast du Edge.

### Kelly-Kriterium

Die App berechnet automatisch die optimale Einsatzgröße nach Kelly:

```
stake = bankroll × kellyFraction × (edge / (quote - 1))
```

Mit `kellyFraction` aus deinem Risikoprofil:
- **K** (Konservativ) = 0.25 → ¼ Kelly
- **M** (Moderat) = 0.33 → ⅓ Kelly (Default)
- **A** (Aggressiv) = 0.5 → ½ Kelly

**Voll-Kelly (1.0) wäre Harakiri.** Selbst Profis nutzen ⅛-½ Kelly.

### Edge-Grading

| Grade | Edge | Was tun? |
|---|---|---|
| **A** | ≥ 8% | **Starker Value** — wetten! |
| **B** | 5-8% | **Solide** — wetten |
| **C** | 3-5% | **Marginal** — nur wenn sonst nichts |
| **D** | < 3% | **Skip** — zu viel Rauschen |
| **F** | negativ | **Nicht wetten** — kein Value |

---

## 🎯 Workflow-Tipps

### Der ideale Wettprozess

1. **Morgens: Goldilocks anschauen** — welche Spiele haben Value?
2. **Spiel im Detail öffnen** — Engine-Vergleich checken: einig oder uneinig?
3. **Kontext lesen** — Verletzungen, Form, Derby-Status
4. **Quoten doppelt prüfen** — The-Odds-API zeigt Best/Sharp; vergleiche mit deinem Buchmacher
5. **Kelly-Stake beachten** — platziere NICHT mehr als die App vorschlägt
6. **Wette platzieren + eintragen** — damit Performance-Tracking stimmt
7. **Nach Spiel-Ende: automatische Abrechnung** — läuft täglich via GitHub Actions

### Pro-Tipps

- **Nur Top-Ligen, wenn du unsicher bist**: BL, EPL, Serie A, La Liga, Ligue 1 — dort sind alle Daten am vollständigsten
- **Nebenligen sind Pro-Territorium**: 3. Liga, League One/Two = Liga-Durchschnitt als Fallback (weniger verlässlich)
- **Ü/U 2.5 oft besser als 1X2**: Weniger Varianz, Edge oft stabiler
- **Morgenquoten sind schlechter als Abendquoten**: Je näher Kickoff, desto schärfer die Linie
- **Early Friday > Sunday Afternoon**: Freitag frisch eingetragene Quoten haben oft mehr Mispricings
- **Kombi-Wetten sind Varianz-Gift**: Jede Leg multipliziert die Varianz. Singles sind fast immer besser.

### Was die Farben bedeuten

- **🟢 Grün** = Heim / Value / Gewonnen
- **🟡 Gold** = Neutral / Brand-Akzent
- **🔴 Rot** = Auswärts / Verloren / Warnung
- **⚫ Grau** = Ausstehend / Remis

---

## 💸 Bankroll-Management

Das einzige wofür du selbst verantwortlich bist — das Modell kann dich nur informieren.

### Regel 1: Bankroll = was du BEREIT BIST ZU VERLIEREN
Nicht dein Sparkonto. Nicht Miete. Der Betrag mit dem du bei null wärst und es dir egal wäre.

### Regel 2: Einzelwette ≤ 5% der Bankroll
Selbst bei Grade-A-Wetten mit Kelly-Empfehlung von 12% — cappe auf 5%. Varianz ist brutal.

### Regel 3: Tagesbudget einhalten
Im Spieltag-Header oben rechts kannst du ein Tagesbudget setzen (z.B. €50). Die App warnt wenn du drüber bist.

### Regel 4: Tracking ist nicht optional
Jede Wette eintragen → Abrechnung läuft automatisch → Performance-Seite zeigt ob du wirklich besser bist als der Markt.

**Wenn dein ROI nach 200+ Wetten negativ ist: Du hast keinen Edge.** Pause.

### Regel 5: Tilt-Schutz
- Nicht mehr wetten nach 3 Verlusten in Folge
- Nicht sofort "aufholen"
- Kein "all-in" bei Grade-A

---

## 🙅 Häufige Fehler

| Fehler | Besser |
|---|---|
| "Alle Spiele wetten" | Nur Grade-A + B, rest ignorieren |
| Bauchgefühl über Modell | Wenn Engines einig und Edge gut → folgen |
| Bei Niederlage Einsatz verdoppeln | Kelly-Empfehlung einhalten, immer |
| Auf Lieblings-Team wetten | Emotionale Bias ist real. Prüfe gegen Modell. |
| Kombi-Wetten mit 5 Legs | Max 2-3 Legs, nur mit Banker-Strategie |
| Quoten bei 1 Buchmacher platzieren | Nutze 3+ Bookies → immer beste Quote |
| Ergebnis erst Montag prüfen | Auto-Settlement läuft täglich um 2:17 + 8:17 UTC |

---

## ❓ FAQ

**F: Welche Engine soll ich nutzen?**
A: Standard als Default. @annafrick13 v2 für Top-5-Ligen wenn Engines einig sind.

**F: Warum zeigt Liga X "Ohne xG"?**
A: Keine xG-History für diese Liga (z.B. 3. Liga). Das Modell nutzt Liga-Durchschnitt als Fallback — weniger verlässlich, aber trotzdem besser als Bauchgefühl.

**F: Warum hat ein Spiel kein Engine-Vergleich?**
A: Mindestens eine Engine hatte keine xG-Historie. Nur die Engines mit gültigen Daten werden gezeigt.

**F: Meine Quote ist besser als die im System — kann ich wetten?**
A: Ja. Die angezeigten Quoten sind das Best-of-30-Bookies. Wenn du noch bessere findest, großartig — mehr Edge.

**F: Was ist "CLV"?**
A: Closing Line Value = deine platzierte Quote vs. Schluss-Quote. Positiver CLV über Zeit = du hast echten Edge. (Feature in Arbeit.)

**F: Wie wird meine Wette abgerechnet?**
A: Automatisch via GitHub Actions Cron (täglich 02:17 + 08:17 UTC, + Montags 12:17). Du musst nichts tun.

**F: Kann ich die App offline nutzen?**
A: Teilweise. Einmal geladene Spieltage + Quoten sind gecacht. Neue Daten brauchen Internet.

**F: Warum wechselt die Engine auf Standard obwohl ich v2 gewählt habe?**
A: v2 ist eingeschaltet, aber fallbackt auf Standard wenn xG-Historie fehlt. Das ist ein Feature, kein Bug — verhindert dass v2 mit schlechten Daten halluziniert.

---

## ⚠️ Verantwortungsvolles Spielen

**Sportwetten sind Glücksspiel.**

- Die App gibt KEINE Garantie für Gewinne
- Vergangene Performance ≠ zukünftige Ergebnisse
- Selbst +2% ROI über 1000 Wetten kann sich in 50-Wetten-Samples als -15% zeigen (Varianz)
- Wer mehr wettet als er verlieren kann, hat ein Problem

**Hilfe**:
- 🇩🇪 Deutschland: [spielen-mit-verantwortung.de](https://www.spielen-mit-verantwortung.de)
- 🇦🇹 Österreich: [bundesstelle-gluecksspielsucht.at](https://www.bundesstelle-gluecksspielsucht.at)
- 🇨🇭 Schweiz: [careplay.ch](https://www.careplay.ch)

**Telefon-Hotline (DE)**: 0800 137 27 00 (kostenlos, 24/7)

---

## 🔗 Für Entwickler

- **Repo**: [github.com/…/fodze-app](https://github.com)
- **Tech-Stack**: Next.js 14, TypeScript, Supabase, LightGBM
- **Architektur**: `docs/ARCHITECTURE.md`
- **Engine-Internals**: `docs/ENGINE.md`
- **Dev-Guide**: `CLAUDE.md` im Repo-Root

---

*Stand: April 2026 · Version 7 · Made for a specific use-case, not a mass-market product.*

export const PROMPT_TEMPLATE = (league: string) => `Finde ALLE Spiele für den nächsten Spieltag in der ${league}.

Suche auf sofascore.com, fotmob.com, understat.com nach Fixtures und xG-Statistiken.
Suche auf transfermarkt.de nach Verletzungen und Sperren.

WICHTIG – xG-Daten EXAKT so liefern:
- xg_h8 = SUMME der xG die das HEIMTEAM in seinen letzten 8 HEIMSPIELEN ERZIELT hat (NICHT Durchschnitt, NUR Heimspiele)
- xga_h8 = SUMME der xGA die das HEIMTEAM in seinen letzten 8 HEIMSPIELEN KASSIERT hat
- xg_a8 = SUMME der xG die das AUSWÄRTSTEAM in seinen letzten 8 AUSWÄRTSSPIELEN ERZIELT hat
- xga_a8 = SUMME der xGA die das AUSWÄRTSTEAM in seinen letzten 8 AUSWÄRTSSPIELEN KASSIERT hat
- Erwartete Werte: Summen über 8 Spiele (5.0–20.0), NICHT Durchschnitte (0.8–2.5)

Beispiel: Bayern 8 Heimspiele xG: 2.1, 1.8, 3.2, 1.5, 2.4, 1.9, 2.7, 2.0 → xg_h8 = 17.6

SCHIEDSRICHTER: Immer mit Karten-Schnitt als Dezimalzahl (z.B. "Ø 4.2 Karten/Spiel", NICHT "Ø 4")
TOP-TORSCHÜTZEN: Pro Spiel die 3 wahrscheinlichsten Torschützen mit geschätzter Trefferwahrscheinlichkeit (basierend auf Saisonleistung, xG-Anteil, Einsatzminuten). NUR angeben wenn du SICHERE Daten hast — lieber weglassen als raten.

KEINE Wettquoten. Antworte NUR als JSON:
{
  "league": "${league}",
  "matchday": "Spieltag XX",
  "date": "YYYY-MM-DD",
  "matches": [
    {
      "home": {"name": "Team A", "xg_h8": 12.5, "xga_h8": 7.2, "games": 8, "form": "W W D L W", "injuries": "Spieler (Verletzung)", "yellow_risk": "Spieler auf 4 Gelben", "notes": ""},
      "away": {"name": "Team B", "xg_a8": 9.0, "xga_a8": 11.5, "games": 8, "form": "L W W D W", "injuries": "", "yellow_risk": "", "notes": ""},
      "tags": ["DERBY"],
      "context": "Kurzer Kontext",
      "referee": "Daniel Siebert, Ø 4.2 Karten/Spiel",
      "kickoff": "15:30",
      "top_scorers": [
        {"name": "Wirtz", "team": "H", "prob": 0.35},
        {"name": "Schick", "team": "H", "prob": 0.28},
        {"name": "Wind", "team": "A", "prob": 0.22}
      ]
    }
  ],
  "data_confidence": "HIGH/MEDIUM/LOW",
  "sources": ["understat.com", "transfermarkt.de"]
}

NOCHMAL: xg_h8/xga_h8/xg_a8/xga_a8 sind SUMMEN (5.0–20.0), NICHT Durchschnitte.
top_scorers: NUR wenn du sichere Daten hast. Probability = geschätzte Torwahrscheinlichkeit (0.0–0.5). Weglassen wenn unsicher.`;

export const emptyMatch = () => ({
  home: { name: "", xg_h8: "", xga_h8: "", games: "8", form: "", injuries: "", yellow_risk: "", notes: "" },
  away: { name: "", xg_a8: "", xga_a8: "", games: "8", form: "", injuries: "", yellow_risk: "", notes: "" },
  tags: [] as string[], context: "", referee: "", kickoff: "",
});

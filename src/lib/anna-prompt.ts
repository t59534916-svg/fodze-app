import { LEAGUES } from "./dixon-coles";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

interface MatchCalc {
  lambdaH: number; lambdaA: number;
  mk: { H: number; D: number; A: number; O25: number; U25: number; best: string };
  enh?: { ciH?: { low: number; high: number }; ciA?: { low: number; high: number } };
  bets: any[];
  hasValue: boolean;
  hasOdds: boolean;
  topScores: { s: string; p: number }[];
}

interface ProcessedMatch {
  home: any; away: any; kickoff?: string; context?: string; referee?: string; tags?: string[];
  calc: MatchCalc | null;
}

export function buildAnnaSystemPrompt(opts: {
  budget: number;
  riskLevel: string;
  kellyFraction: number;
  bankroll: number;
  leagueData: Record<string, { label: string; matches: ProcessedMatch[] }>;
}): string {
  const { budget, riskLevel, kellyFraction, bankroll, leagueData } = opts;
  const riskLabel = riskLevel === "K" ? "Konservativ" : riskLevel === "A" ? "Aggressiv" : "Moderat";

  let prompt = `Du bist Anna, quantitativer Analyst bei FODZE. Du analysierst Fußball-Spieltage mit der v2 LightGBM Tweedie Engine + Dirichlet-ODIR Kalibrierung und gibst datenbasierte Wettempfehlungen.

VOICE (folge docs/BRAND-VOICE.md):
- Präzise: jeder Claim hat eine Zahl. "Edge +4.2%" nicht "guter Edge".
- Ehrlich: Wenn der CI breit ist oder Datenlage dünn, sag es. Negative Ergebnisse werden genannt, nicht versteckt.
- Technisch selbstbewusst: Dixon-Coles, Brier, ECE, Konfidenzintervall, Kelly werden ungekürzt genannt.
- Quantitativ-erste: Tabelle/Badge vor Prosa. Zahl vor Adjektiv.
- Respektvoll-direkt: Duze den Nutzer, aber kein Hand-Holding. Keine Smileys, keine Ups-Formeln, kein "leider".

NUTZERPROFIL:
- Bankroll: €${bankroll}
- Tagesbudget: €${budget}
- Risikoprofil: ${riskLabel} (Kelly-Fraktion: ${kellyFraction})

REGELN FÜR EMPFEHLUNGEN:
- Gesamteinsatz DARF €${budget} NICHT überschreiten
- Goldilocks-Zone: nur Wetten mit Edge ∈ [2,5%, 7,5%] empfehlen
  · Edge < 2,5% = statistisches Rauschen → keine Empfehlung
  · Edge > 7,5% = verdächtig (Marktinfo wir nicht sehen) → keine Empfehlung
- Kelly-Einsatz = Edge / (Quote − 1) × ${kellyFraction} × €${budget}, immer gegen Bankroll-Cap prüfen
- Immer Konfidenzintervalle angeben: [untere–obere Grenze]
- Bei 3+ Value-Legs: 2aus3 System vorschlagen
- Bei 4+ Value-Legs: verschiedene Systeme vergleichen (2aus4, 3aus4)
- Bei 5+ Value-Legs: 2aus5, 3aus5 etc. mit EV und P(Gewinn) vergleichen

VERBOTENE BEGRIFFE (nie benutzen):
- "Garantiert", "Todsicher", "Banker", "100%ig", "Geheimtipp", "Insider"
- "KI", "AI-powered", "Magie" — FODZE ist statistische Modellierung, kein neuronales Wunder
- "Turbo", "Boost", "Alpha" — Crypto-Bro-Lexikon, passt nicht zum Voice

PFLICHT-DISCLAIMER am Ende jeder Antwort mit konkreten Wettvorschlägen:
"Sportwetten = Glücksspiel. Das Modell macht Risiko messbar, nicht kleiner. Nur spielen mit Geld dessen Verlust nicht wehtut."

VERFÜGBARE SPIELTAGSDATEN:
`;

  for (const [leagueKey, data] of Object.entries(leagueData)) {
    const ld = LEAGUES[leagueKey];
    if (!ld) continue;

    prompt += `\n=== ${ld.name} — ${data.label} ===\n`;

    const valueBets: string[] = [];

    for (const m of data.matches) {
      if (!m.calc) continue;
      const c = m.calc;
      const h = m.home, a = m.away;

      prompt += `\n${h.name} — ${a.name}`;
      if (m.kickoff) prompt += ` (${m.kickoff})`;
      prompt += `\n`;

      if (m.context) prompt += `  Kontext: ${m.context}\n`;
      if (h.injuries) prompt += `  Ausfälle H: ${h.injuries}\n`;
      if (a.injuries) prompt += `  Ausfälle A: ${a.injuries}\n`;

      prompt += `  λH=${c.lambdaH.toFixed(2)} λA=${c.lambdaA.toFixed(2)}\n`;
      prompt += `  Modell: H=${pc(c.mk.H)} X=${pc(c.mk.D)} A=${pc(c.mk.A)} | Ü2.5=${pc(c.mk.O25)}\n`;

      if (c.enh?.ciH && c.enh?.ciA) {
        prompt += `  CI 90%: λH [${c.enh.ciH.low.toFixed(2)}–${c.enh.ciH.high.toFixed(2)}] λA [${c.enh.ciA.low.toFixed(2)}–${c.enh.ciA.high.toFixed(2)}]\n`;
      }

      if (c.topScores.length > 0) {
        prompt += `  Top-Ergebnisse: ${c.topScores.slice(0, 3).map(s => `${s.s} (${pc(s.p)})`).join(", ")}\n`;
      }

      if (c.hasOdds && c.bets.length > 0) {
        const vBets = c.bets.filter((b: any) => b.isValue);
        if (vBets.length > 0) {
          for (const b of vBets) {
            prompt += `  ★ VALUE: ${b.label} — Modell ${pc(b.pModel)} vs Markt ${pc(b.pMarket)} → Edge ${pe(b.edge)} | Konfidenz: ${b.confidence}\n`;
            prompt += `    Kelly: €${(b.kelly * budget).toFixed(0)} (${pc(b.kelly)} vom Budget)\n`;
            valueBets.push(`${b.label} ${h.name}–${a.name} @${b.quote.toFixed(2)} Edge ${pe(b.edge)} [${b.confidence}]`);
          }
        }
        const nonValue = c.bets.filter((b: any) => !b.isValue && b.edge > -0.05);
        if (nonValue.length > 0) {
          prompt += `  Andere Märkte: ${nonValue.map((b: any) => `${b.label} Edge ${pe(b.edge)}`).join(", ")}\n`;
        }
      } else {
        prompt += `  ⚠ Keine Quoten verfügbar\n`;
      }
    }

    if (valueBets.length > 0) {
      prompt += `\nVALUE-BETS ${ld.name} (${valueBets.length}):\n`;
      valueBets.forEach((v, i) => { prompt += `  ${i + 1}. ${v}\n`; });
    }
  }

  prompt += `
ANTWORTFORMAT:
1. Überblick: Kurze Zusammenfassung der Spieltage und Datenlage (1–2 Sätze, keine Prosa-Verpackung)
2. Pro Liga: Die besten Value-Bets mit Begründung. Jede Begründung nennt konkrete Zahlen (Form W-W-D-L-W, xG-Trend, fehlende Schlüsselspieler mit Position).
3. Frage den Nutzer ob er einverstanden ist oder Anpassungen will
4. Nach Zustimmung: Konkrete Wettvorschläge:
   a) EINZELWETTEN mit Kelly-Einsätzen
   b) KOMBIWETTEN (2er, 3er aus verschiedenen Spielen)
   c) SYSTEMWETTEN (2aus3, 3aus4 etc.) mit EV und Gewinnwahrscheinlichkeit
   d) Gesamtübersicht: Einsatz / Budget / erwarteter Gewinn
5. Disclaimer anhängen (wortgetreu, nicht umformulieren):
   "Sportwetten = Glücksspiel. Das Modell macht Risiko messbar, nicht kleiner. Nur spielen mit Geld dessen Verlust nicht wehtut."
`;

  return prompt;
}

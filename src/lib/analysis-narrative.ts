// ═══════════════════════════════════════════════════════════════════════
// FODZE Analysis Narrative
//
// Turns a MatchReport (fully-computed per-match stats + predictions) into
// a human-readable German analysis string. Extracted from
// /fuck-betting/page.tsx so the same narrative can be reused elsewhere
// (e.g. by /anna offline mode) without dragging 1600 lines of page code.
//
// Side-effect free, no React, no Supabase. Takes everything it needs via
// the MatchReport argument so each new caller owns the data assembly.
// ═══════════════════════════════════════════════════════════════════════

import { getTeamSeasonFeatures } from "@/lib/lgbm-runtime";
import type { SecondHalfMarkets } from "@/lib/dixon-coles";
import type { RawMatch } from "@/types/match";

// ─── Inputs ──────────────────────────────────────────────────────────

export interface MatchReport {
  home: string;
  away: string;
  league: string;
  leagueName: string;
  kickoff: string;
  lambdaH: number;
  lambdaA: number;
  matrix: number[][];
  // Full Time
  ft1X2: { H: number; D: number; A: number };
  dc: { "1X": number; "X2": number; "12": number };
  goalsOU: { O15: number; O25: number; O35: number; O45: number; O55: number };
  btts: { yes: number; no: number };
  correctScores: { score: string; p: number }[];
  winningMargin: Record<string, number>;
  asianHandicap: Record<string, { P_Win: number; P_Push: number; P_Loss: number; Fair_Odds: number }>;
  // Half Time
  ht1X2: { H: number; D: number; A: number };
  htCorrectScores: { score: string; p: number }[];
  htft: Record<string, number>;
  goalBothHalves: { yes: number; no: number };
  // Goals per team
  homeGoals: { O05: number; O15: number; O25: number };
  awayGoals: { O05: number; O15: number; O25: number };
  // Yellow Cards
  yellowCards: { expected: number; over25: number; over35: number; over45: number; over55: number };
  // Timing
  firstGoalBefore30: number;
  firstGoalBefore60: number;
  // Clean Sheet & Win to Nil
  cleanSheetH: number;
  cleanSheetA: number;
  winToNilH: number;
  winToNilA: number;
  // Draw No Bet
  drawNoBetH: number;
  drawNoBetA: number;
  // HT Goals Over/Under
  htGoalsOU: { O05: number; O15: number; O25: number };
  // 2nd Half Markets (0-0 HT state)
  secondHalf: SecondHalfMarkets;
  // Exact Team Goals
  homeExact: number[]; // [P(0), P(1), P(2), P(3+)]
  awayExact: number[];
  // Odd/Even total goals
  oddGoals: number;
  evenGoals: number;
  // Race to 2 goals
  raceTo2H: number;
  raceTo2A: number;
  raceTo2Neither: number;
  // Score Matrix (7x7)
  heatmap: number[][];
  // Form visual
  formH: string;
  formA: string;
  // Data quality & engine
  dataQuality: "HIGH" | "LOW";
  engine: "annafrick13-v2" | "standard";
  // Raw match data for analysis
  rawMatch: RawMatch;
  xgPerGameH: number;  // xg_h8 / games
  xgaPerGameH: number; // xga_h8 / games
  xgPerGameA: number;  // xg_a8 / games
  xgaPerGameA: number; // xga_a8 / games
  // Table position
  homePos: number | null;
  awayPos: number | null;
  homePoints: number | null;
  awayPoints: number | null;
  // Live odds (from Supabase live_odds)
  bestOdds?: { h: number; d: number; a: number; o25?: number; u25?: number };
  sharpOdds?: { h: number; d: number; a: number };
  numBookmakers?: number;
  // Confidence score 0-100
  confidence: number;
  // Brief analysis (filled by generateAnalysis itself when the caller
  // populates the rest of the report and passes it back in — the field
  // is optional on input).
  analysis?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const pc = (v: number) => (v * 100).toFixed(1) + "%";

/**
 * Parse a "W W D L W" form string into totals + trailing streak. Accepts
 * any whitespace-separated sequence of W/D/L letters; silently drops
 * anything else. Returned `streak` is a "count+letter" shorthand like
 * "3W" or "2L" (length-1 when no streak), which the narrative code
 * interprets via `parseInt(streak)` + `streak.endsWith(...)`.
 */
export function parseForm(form: string | undefined): { w: number; d: number; l: number; streak: string; len: number } {
  if (!form) return { w: 0, d: 0, l: 0, streak: "", len: 0 };
  const results = form.trim().split(/\s+/).filter(r => ["W", "D", "L"].includes(r));
  const w = results.filter(r => r === "W").length;
  const d = results.filter(r => r === "D").length;
  const l = results.filter(r => r === "L").length;
  // Current streak
  let streak = "";
  if (results.length > 0) {
    const last = results[results.length - 1];
    let count = 0;
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] === last) count++;
      else break;
    }
    streak = `${count}${last}`;
  }
  return { w, d, l, streak, len: results.length };
}

// ─── Main: generate narrative ────────────────────────────────────────

export function generateAnalysis(r: MatchReport): string {
  const { ft1X2, goalsOU, lambdaH, lambdaA, btts, ht1X2, correctScores, rawMatch: m } = r;
  const lines: string[] = [];
  const totalXG = lambdaH + lambdaA;
  const h = m.home;
  const a = m.away;
  const formH = parseForm(h.form);
  const formA = parseForm(a.form);
  const tags = m.tags || [];

  // Engine + table position info
  const posInfo = (pos: number | null, pts: number | null, name: string) => {
    if (!pos || !pts) return name;
    return `${name} (${pos}., ${pts}P)`;
  };
  const hInfo = posInfo(r.homePos, r.homePoints, r.home);
  const aInfo = posInfo(r.awayPos, r.awayPoints, r.away);

  if (r.engine === "annafrick13-v2") {
    lines.push(`Analyse via @annafrick13 v2 (LightGBM Tweedie, 14 Features). ${hInfo} empfängt ${aInfo}. Erwartete Tore: ${r.lambdaH.toFixed(2)} — ${r.lambdaA.toFixed(2)}.`);
  } else {
    lines.push(`Analyse via Standard-Engine (Dixon-Coles). ${hInfo} empfängt ${aInfo}. Erwartete Tore: ${r.lambdaH.toFixed(2)} — ${r.lambdaA.toFixed(2)}.`);
  }

  // Data quality warning
  if (r.dataQuality === "LOW") {
    lines.push(`⚠ Für diese Partie liegen keine individuellen xG-Daten vor. Die Analyse basiert auf dem Liga-Durchschnitt und dem Heimvorteil. Die Wahrscheinlichkeiten sind deutlich weniger aussagekräftig — Vorsicht bei der Interpretation.`);
  }

  // ── 1. Main verdict with reasoning ──
  const buildReasons = (favHome: boolean) => {
    const reasons: string[] = [];
    if (favHome) {
      if (r.xgPerGameH > 1.5) reasons.push(`stark offensiv zuhause (${r.xgPerGameH.toFixed(2)} xGoals/Spiel${r.engine === "annafrick13-v2" ? " EWMA" : ""})`);
      if (r.xgaPerGameA > 1.5) reasons.push(`${r.away} defensiv anfällig auswärts (${r.xgaPerGameA.toFixed(2)} xGoals-Against/Spiel kassiert)`);
      if (r.xgaPerGameH < 1.1) reasons.push(`${r.home} defensiv solide zuhause (nur ${r.xgaPerGameH.toFixed(2)} xGoals-Against/Spiel)`);
      if (formH.w >= 3 && formH.len >= 4) reasons.push(`${formH.w} von ${formH.len} Heimspielen gewonnen`);
      if (formA.l >= 2) reasons.push(`${r.away} zuletzt ${formA.l} Niederlage${formA.l > 1 ? "n" : ""} in ${formA.len} Auswärtsspielen`);
    } else {
      if (r.xgPerGameA > 1.3) reasons.push(`offensiv stark auswärts (${r.xgPerGameA.toFixed(2)} xGoals/Spiel)`);
      if (r.xgaPerGameH > 1.5) reasons.push(`${r.home} defensive Schwächen zuhause (${r.xgaPerGameH.toFixed(2)} xGoals-Against/Spiel kassiert)`);
      if (r.xgaPerGameA < 1.0) reasons.push(`${r.away} defensiv kompakt auswärts (${r.xgaPerGameA.toFixed(2)} xGoals-Against/Spiel)`);
      if (formA.w >= 3) reasons.push(`${formA.w} Siege in den letzten ${formA.len} Auswärtsspielen`);
      if (formH.l >= 2) reasons.push(`${r.home} zuletzt ${formH.l} Heimniederlage${formH.l > 1 ? "n" : ""}`);
    }
    return reasons;
  };

  if (ft1X2.H > 0.5) {
    const reasons = buildReasons(true);
    if (reasons.length === 0) reasons.push(`das xGoals-Profil spricht klar für die Heimmannschaft`);
    lines.push(`${r.home} geht als klarer Favorit ins Spiel (${pc(ft1X2.H)}), weil ${reasons.join(", ")}.`);
  } else if (ft1X2.A > 0.5) {
    const reasons = buildReasons(false);
    if (reasons.length === 0) reasons.push(`die xG-Daten deuten auf eine auswärtsstarke Mannschaft`);
    lines.push(`${r.away} ist trotz Auswärtsspiel Favorit (${pc(ft1X2.A)}), denn ${reasons.join(", ")}.`);
  } else if (ft1X2.H > ft1X2.A + 0.08) {
    lines.push(`${r.home} mit leichtem Heimvorteil (${pc(ft1X2.H)} vs. ${pc(ft1X2.A)}). Der Unterschied ist gering — ${r.away} kann hier durchaus punkten.`);
    lines.push(`${r.home} erzielt zuhause ${r.xgPerGameH.toFixed(2)} xGoals/Spiel, ${r.away} kommt auswärts auf ${r.xgPerGameA.toFixed(2)}. Defensiv: ${r.home} kassiert ${r.xgaPerGameH.toFixed(2)}, ${r.away} kassiert ${r.xgaPerGameA.toFixed(2)} xGoals-Against/Spiel.`);
  } else if (ft1X2.A > ft1X2.H + 0.08) {
    lines.push(`${r.away} leicht favorisiert (${pc(ft1X2.A)}), obwohl sie auswärts spielen. ${r.home} kommt zuhause nur auf ${r.xgPerGameH.toFixed(2)} xGoals/Spiel.`);
  } else {
    lines.push(`Ein sehr ausgeglichenes Spiel — ${r.home} (${pc(ft1X2.H)}) und ${r.away} (${pc(ft1X2.A)}) nahezu gleichstark. Das Unentschieden hat mit ${pc(ft1X2.D)} eine realistische Chance.`);
    lines.push(`Offensiv liefern sich beide ein Duell auf Augenhöhe: ${r.home} ${r.xgPerGameH.toFixed(2)} vs. ${r.away} ${r.xgPerGameA.toFixed(2)} xGoals/Spiel.`);
  }

  // ── 2. xG deep-dive (always show) ──
  lines.push(`xGoals-Profil: ${r.home} erzielt ${r.xgPerGameH.toFixed(2)} und kassiert ${r.xgaPerGameH.toFixed(2)} xGoals/Spiel zuhause. ${r.away} erzielt ${r.xgPerGameA.toFixed(2)} und kassiert ${r.xgaPerGameA.toFixed(2)} auswärts.`);

  // ── 3. Form analysis ──
  if (formH.len > 0 || formA.len > 0) {
    const formParts: string[] = [];
    if (formH.len > 0) formParts.push(`${r.home} Heimform: ${formH.w}S ${formH.d}U ${formH.l}N (${formH.len} Sp.)`);
    if (formA.len > 0) formParts.push(`${r.away} Auswärtsform: ${formA.w}S ${formA.d}U ${formA.l}N (${formA.len} Sp.)`);
    if (formH.streak.length > 1) {
      const n = parseInt(formH.streak);
      const type = formH.streak.endsWith("W") ? "Siege" : formH.streak.endsWith("L") ? "Niederlagen" : "Unentschieden";
      if (n >= 2) formParts.push(`${r.home} ${n} ${type} in Serie`);
    }
    if (formA.streak.length > 1) {
      const n = parseInt(formA.streak);
      const type = formA.streak.endsWith("W") ? "Siege" : formA.streak.endsWith("L") ? "Niederlagen" : "Unentschieden";
      if (n >= 2) formParts.push(`${r.away} ${n} ${type} in Serie`);
    }
    if (formParts.length > 0) lines.push(formParts.join(". ") + ".");
  }

  // ── 4. Goal expectation ──
  if (totalXG > 3.2) {
    lines.push(`Torreiches Spiel erwartet (${totalXG.toFixed(1)} erw. Tore). ${r.home} generiert ${r.xgPerGameH.toFixed(2)} xGoals/Spiel zuhause, ${r.away} kassiert auswärts ${r.xgaPerGameA.toFixed(2)}. Über 2.5 Tore: ${pc(goalsOU.O25)}, Über 3.5: ${pc(goalsOU.O35)}.`);
  } else if (totalXG < 2.2) {
    const lowReasons: string[] = [];
    if (r.xgPerGameH < 1.2) lowReasons.push(`${r.home} offensiv limitiert (${r.xgPerGameH.toFixed(2)} xGoals/Spiel)`);
    if (r.xgPerGameA < 1.0) lowReasons.push(`${r.away} tut sich auswärts schwer (${r.xgPerGameA.toFixed(2)} xGoals/Spiel)`);
    if (r.xgaPerGameH < 1.1) lowReasons.push(`${r.home} defensiv stabil (${r.xgaPerGameH.toFixed(2)} xGoals-Against/Spiel)`);
    if (r.xgaPerGameA < 1.1) lowReasons.push(`${r.away} kompakt auswärts (${r.xgaPerGameA.toFixed(2)} xGoals-Against/Spiel)`);
    lines.push(`Torarmes Spiel wahrscheinlich (${totalXG.toFixed(1)} erw. Tore)${lowReasons.length > 0 ? ": " + lowReasons.join(", ") : ""}. Unter 2.5: ${pc(1 - goalsOU.O25)}.`);
  } else {
    lines.push(`Mit ${totalXG.toFixed(1)} erwarteten Toren ein durchschnittliches Spiel. Über 2.5: ${pc(goalsOU.O25)}, Unter 2.5: ${pc(1 - goalsOU.O25)}.`);
  }

  // ── 5. BTTS analysis ──
  if (btts.yes > 0.6) {
    lines.push(`Beide Teams dürften treffen (BTTS Ja: ${pc(btts.yes)}). ${r.home} trifft zuhause mit ${pc(r.homeGoals.O05)} Wahrscheinlichkeit, ${r.away} auswärts mit ${pc(r.awayGoals.O05)}.`);
  } else if (btts.yes < 0.4) {
    if (r.homeGoals.O05 > r.awayGoals.O05) {
      lines.push(`${r.away} dürfte Probleme haben auswärts zu treffen — BTTS Nein: ${pc(btts.no)}. Clean Sheet ${r.home}: ${pc(r.cleanSheetH)}.`);
    } else {
      lines.push(`${r.home} könnte torlos bleiben — BTTS Nein: ${pc(btts.no)}. Clean Sheet ${r.away}: ${pc(r.cleanSheetA)}.`);
    }
  } else {
    lines.push(`BTTS Ja bei ${pc(btts.yes)} — beide Teams haben realistische Torchancen.`);
  }

  // ── 6. HT analysis ──
  if (ht1X2.D > 0.42) {
    lines.push(`Erste Halbzeit voraussichtlich torarm: HT-Unentschieden bei ${pc(ht1X2.D)}. Das 0:0 zur Pause ist der wahrscheinlichste HT-Stand (${pc(r.htCorrectScores[0]?.p || 0)}).`);
  } else if (ft1X2.H > 0.5 && ht1X2.H > 0.3) {
    lines.push(`${r.home} könnte schon zur Halbzeit führen (HT-Sieg: ${pc(ht1X2.H)}).`);
  } else if (ft1X2.A > 0.5 && ht1X2.A > 0.25) {
    lines.push(`${r.away} könnte schon zur Pause vorne liegen (HT-Sieg: ${pc(ht1X2.A)}).`);
  }

  // ── 7. Correct Score insight ──
  if (correctScores.length >= 3) {
    const top3 = correctScores.slice(0, 3).map(cs => `${cs.score} (${pc(cs.p)})`).join(", ");
    lines.push(`Wahrscheinlichste Endstände: ${top3}.`);
  }

  // ── 8. Tags (derby, etc.) ──
  if (tags.includes("DERBY")) {
    lines.push(`Derby-Begegnung — typisch unberechenbar, erhöhte Intensität. Die xG-basierte Analyse kann die emotionale Komponente nur begrenzt abbilden.`);
  }
  if (tags.includes("TOP_MATCH")) {
    lines.push(`Spitzenspiel der Liga — beide auf hohem Niveau, enge Partie erwartet.`);
  }

  // ── 9. Injuries / Context from AI ──
  const injuryParts: string[] = [];
  if (h.injuries) injuryParts.push(`${r.home}: ${h.injuries}`);
  if (a.injuries) injuryParts.push(`${r.away}: ${a.injuries}`);
  if (injuryParts.length > 0) {
    lines.push(`Ausfälle: ${injuryParts.join(" | ")}`);
  }

  if (m.context) {
    lines.push(m.context);
  }

  if (m.referee) {
    lines.push(`Schiedsrichter: ${m.referee}.`);
  }

  // ── 10. Key market summary ──
  const keyMarkets: string[] = [];
  if (goalsOU.O15 > 0.8) keyMarkets.push(`Ü1.5 sehr sicher (${pc(goalsOU.O15)})`);
  if (goalsOU.O35 > 0.5) keyMarkets.push(`Ü3.5 wahrscheinlich (${pc(goalsOU.O35)})`);
  if (r.asianHandicap["-1"]?.P_Win > 0.55 && ft1X2.H > 0.45) keyMarkets.push(`HC -1 Heim: ${pc(r.asianHandicap["-1"].P_Win)}`);
  if (r.asianHandicap["+1"]?.P_Win > 0.55 && ft1X2.A > 0.35) keyMarkets.push(`HC +1 Gast: ${pc(r.asianHandicap["+1"].P_Win)}`);
  if (r.goalBothHalves.yes > 0.5) keyMarkets.push(`Tor in beiden Halbzeiten: ${pc(r.goalBothHalves.yes)}`);
  if (r.winToNilH > 0.25) keyMarkets.push(`${r.home} Win to Nil: ${pc(r.winToNilH)}`);
  if (r.winToNilA > 0.2) keyMarkets.push(`${r.away} Win to Nil: ${pc(r.winToNilA)}`);
  if (r.drawNoBetH > 0.65) keyMarkets.push(`DNB ${r.home}: ${pc(r.drawNoBetH)}`);
  if (keyMarkets.length > 0) {
    lines.push(`Auffällige Märkte: ${keyMarkets.join(" · ")}.`);
  }

  // ── 11. Quotenanalyse + Value Detection ──
  const bo = r.bestOdds;
  const so = r.sharpOdds;
  if (bo && bo.h > 0) {
    const valueBets: string[] = [];
    const edgeCalc = (modelP: number, quote: number) => {
      const marketP = 1 / quote;
      const edge = modelP - marketP;
      const kelly = edge > 0.03 ? Math.max(0, (modelP * quote - 1) / (quote - 1) * 0.33) : 0;
      const grade = edge >= 0.08 ? "A" : edge >= 0.05 ? "B" : edge >= 0.03 ? "C" : "";
      return { edge, kelly, grade };
    };

    // 1X2 value
    const markets: { label: string; modelP: number; quote: number }[] = [
      { label: "Heim (1)", modelP: ft1X2.H, quote: bo.h },
      { label: "Unentschieden (X)", modelP: ft1X2.D, quote: bo.d },
      { label: "Auswärts (2)", modelP: ft1X2.A, quote: bo.a },
    ];
    if (bo.o25) markets.push({ label: "Ü2.5 Tore", modelP: goalsOU.O25, quote: bo.o25 });
    if (bo.u25) markets.push({ label: "U2.5 Tore", modelP: 1 - goalsOU.O25, quote: bo.u25 });
    // DC, DNB, BTTS from model probs (no separate odds, use implied)
    markets.push({ label: "BTTS Ja", modelP: r.btts.yes, quote: 1 / Math.max(r.btts.yes, 0.01) * 1.08 }); // estimated

    for (const mk2 of markets) {
      if (mk2.quote <= 1) continue;
      const { edge, kelly, grade } = edgeCalc(mk2.modelP, mk2.quote);
      if (grade) {
        valueBets.push(`${mk2.label} @ ${mk2.quote.toFixed(2)} — Modell: ${pc(mk2.modelP)} — Edge ${(edge * 100).toFixed(1)}% (${grade}) — Kelly ${(kelly * 100).toFixed(1)}%`);
      }
    }

    // Sharp vs Model comparison
    if (so && so.h > 0) {
      const sharpH = (1 / so.h), sharpD = (1 / so.d), sharpA = (1 / so.a);
      const sharpTotal = sharpH + sharpD + sharpA;
      const pinnH = sharpH / sharpTotal, pinnD = sharpD / sharpTotal, pinnA = sharpA / sharpTotal;
      const biggestDiff = Math.max(
        Math.abs(ft1X2.H - pinnH), Math.abs(ft1X2.D - pinnD), Math.abs(ft1X2.A - pinnA)
      );
      if (biggestDiff > 0.05) {
        const who = ft1X2.H - pinnH > 0.05 ? `Modell sieht ${r.home} stärker als Pinnacle` :
                    ft1X2.A - pinnA > 0.05 ? `Modell sieht ${r.away} stärker als Pinnacle` :
                    pinnH - ft1X2.H > 0.05 ? `Pinnacle bewertet ${r.home} deutlich höher — Vorsicht` :
                    `Modell und Markt divergieren`;
        lines.push(`Quotenvergleich (${r.numBookmakers || "?"} Bookmaker): ${who}. Pinnacle: ${so.h.toFixed(2)}/${so.d.toFixed(2)}/${so.a.toFixed(2)} | Best: ${bo.h.toFixed(2)}/${bo.d.toFixed(2)}/${bo.a.toFixed(2)}.`);
      } else {
        lines.push(`Quotenvergleich: Modell und Markt weitgehend einig. Pinnacle: ${so.h.toFixed(2)}/${so.d.toFixed(2)}/${so.a.toFixed(2)}.`);
      }
    }

    if (valueBets.length > 0) {
      lines.push(`VALUE BETS: ${valueBets.join(" | ")}`);
    } else {
      lines.push(`Keine klaren Value Bets bei aktuellen Quoten (Edge < 3% in allen Märkten).`);
    }
  }

  // ── 12. Asian Handicap ──
  const ahLines: string[] = [];
  for (const line of ["-2", "-1.5", "-1", "-0.5", "0", "+0.5", "+1", "+1.5"]) {
    const ah = r.asianHandicap[line];
    if (ah && ah.P_Win > 0.55) {
      ahLines.push(`HC ${line}: ${pc(ah.P_Win)} (Fair ${ah.Fair_Odds.toFixed(2)})`);
    }
  }
  if (ahLines.length > 0) {
    lines.push(`Handicap: ${ahLines.slice(0, 3).join(" · ")}.`);
  }

  // ── 13. Spezial-Märkte ──
  const specials: string[] = [];
  if (r.cleanSheetH > 0.20) specials.push(`CS ${r.home}: ${pc(r.cleanSheetH)}`);
  if (r.cleanSheetA > 0.18) specials.push(`CS ${r.away}: ${pc(r.cleanSheetA)}`);
  if (r.winToNilH > 0.15) specials.push(`WtN ${r.home}: ${pc(r.winToNilH)}`);
  if (r.winToNilA > 0.12) specials.push(`WtN ${r.away}: ${pc(r.winToNilA)}`);
  if (r.oddGoals > 0.53) specials.push(`Ungerade Tore: ${pc(r.oddGoals)}`);
  else if (r.evenGoals > 0.53) specials.push(`Gerade Tore: ${pc(r.evenGoals)}`);
  if (r.firstGoalBefore30 > 0.55) specials.push(`Tor vor Min 30: ${pc(r.firstGoalBefore30)}`);
  if (r.raceTo2H > 0.30) specials.push(`Race to 2 ${r.home}: ${pc(r.raceTo2H)}`);
  if (r.raceTo2Neither > 0.35) specials.push(`Race to 2 keiner: ${pc(r.raceTo2Neither)}`);
  if (r.yellowCards.expected > 4.5) specials.push(`Karten: ${r.yellowCards.expected.toFixed(1)} erw., Ü4.5: ${pc(r.yellowCards.over45)}`);
  if (specials.length > 0) {
    lines.push(`Spezial: ${specials.join(" · ")}.`);
  }

  // ── 14. Kombi-Empfehlung ──
  const combos: { legs: string[]; prob: number; desc: string }[] = [];
  // Ü2.5 + BTTS (stark korreliert)
  if (goalsOU.O25 > 0.50 && r.btts.yes > 0.52) {
    // P(O25 AND BTTS) direkt aus Matrix berechnen
    let pBoth = 0;
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) if (i + j > 2 && r.matrix[i]?.[j]) pBoth += r.matrix[i][j];
    combos.push({ legs: ["Ü2.5", "BTTS Ja"], prob: pBoth, desc: "Torreiches offenes Spiel" });
  }
  // Favorit + Ü1.5 (wenn klarer Favorit)
  if (ft1X2.H > 0.45) {
    let pHAndO15 = 0;
    for (let i = 1; i < 10; i++) for (let j = 0; j < 10; j++) if (i > j && i + j > 1 && r.matrix[i]?.[j]) pHAndO15 += r.matrix[i][j];
    combos.push({ legs: ["Heim", "Ü1.5"], prob: pHAndO15, desc: "Heimsieg mit Toren" });
  } else if (ft1X2.A > 0.40) {
    let pAAndO15 = 0;
    for (let i = 0; i < 10; i++) for (let j = 1; j < 10; j++) if (j > i && i + j > 1 && r.matrix[i]?.[j]) pAAndO15 += r.matrix[i][j];
    combos.push({ legs: ["Auswärts", "Ü1.5"], prob: pAAndO15, desc: "Auswärtssieg mit Toren" });
  }
  // DC + BTTS (sicherer)
  if (r.dc["1X"] > 0.65 && r.btts.yes > 0.50) {
    let pDC1XBTTS = 0;
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) if (i >= j && r.matrix[i]?.[j]) pDC1XBTTS += r.matrix[i][j];
    combos.push({ legs: ["DC 1X", "BTTS Ja"], prob: pDC1XBTTS, desc: "Heim nicht verlieren + beide treffen" });
  } else if (r.dc["X2"] > 0.65 && r.btts.yes > 0.50) {
    let pDCX2BTTS = 0;
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) if (j >= i && r.matrix[i]?.[j]) pDCX2BTTS += r.matrix[i][j];
    combos.push({ legs: ["DC X2", "BTTS Ja"], prob: pDCX2BTTS, desc: "Gast nicht verlieren + beide treffen" });
  }

  if (combos.length > 0) {
    combos.sort((a, b) => b.prob - a.prob);
    const comboLines = combos.slice(0, 3).map((c, i) => {
      const estQuote = c.prob > 0 ? (1 / c.prob * 0.92).toFixed(2) : "?"; // 8% margin estimate
      return `${i + 1}. ${c.legs.join(" + ")} — ${pc(c.prob)} (ca. ${estQuote}) — ${c.desc}`;
    });
    lines.push(`KOMBI-EMPFEHLUNG: ${comboLines.join(" | ")}`);
  }

  // ── 15. Taktik-Profil (nur wenn Daten vorhanden + einfließen) ──
  const hSF = getTeamSeasonFeatures(r.league, "2024/25", r.rawMatch.home?.name || "");
  const aSF = getTeamSeasonFeatures(r.league, "2024/25", r.rawMatch.away?.name || "");
  if (hSF || aSF) {
    const profParts: string[] = [];
    if (hSF) {
      const parts: string[] = [];
      if (hSF.setpiece_xg_share) parts.push(`${(hSF.setpiece_xg_share * 100).toFixed(0)}% Set-Piece xGoals`);
      if (hSF.late_game_xg_share) parts.push(`${(hSF.late_game_xg_share * 100).toFixed(0)}% Late-Game (76+)`);
      if (hSF.shot_quality_avg) parts.push(`Schussqualität ${hSF.shot_quality_avg.toFixed(3)} xGoals/Schuss`);
      if (hSF.high_value_shot_share) parts.push(`${(hSF.high_value_shot_share * 100).toFixed(0)}% Großchancen`);
      if (hSF.top3_xgchain_share) parts.push(`Top-3 erw. Torbeteiligung: ${(hSF.top3_xgchain_share * 100).toFixed(0)}%`);
      if (hSF.losing_state_xg_diff) parts.push(`Rückstand-Bilanz: ${hSF.losing_state_xg_diff > 0 ? "+" : ""}${hSF.losing_state_xg_diff.toFixed(2)}`);
      if (parts.length > 0) profParts.push(`${r.home}: ${parts.join(", ")}`);
    }
    if (aSF) {
      const parts: string[] = [];
      if (aSF.setpiece_xg_share) parts.push(`${(aSF.setpiece_xg_share * 100).toFixed(0)}% Set-Piece xGoals`);
      if (aSF.late_game_xg_share) parts.push(`${(aSF.late_game_xg_share * 100).toFixed(0)}% Late-Game`);
      if (aSF.shot_quality_avg) parts.push(`Schussqualität ${aSF.shot_quality_avg.toFixed(3)} xGoals/Schuss`);
      if (aSF.high_value_shot_share) parts.push(`${(aSF.high_value_shot_share * 100).toFixed(0)}% Großchancen`);
      if (aSF.top3_xgchain_share) parts.push(`Top-3 erw. Torbeteiligung: ${(aSF.top3_xgchain_share * 100).toFixed(0)}%`);
      if (parts.length > 0) profParts.push(`${r.away}: ${parts.join(", ")}`);
    }
    if (profParts.length > 0) {
      lines.push(`TAKTIK-PROFIL (fließt in Vorhersage ein): ${profParts.join(" | ")}`);
    }
  }

  // ── 16. Confidence assessment ──
  const conf = r.confidence;
  const confLabel = conf >= 85 ? "Sehr hoch" : conf >= 70 ? "Hoch" : conf >= 50 ? "Mittel" : conf >= 35 ? "Niedrig" : "Sehr niedrig";
  const confReasons: string[] = [];
  if (r.engine === "annafrick13-v2") confReasons.push("LightGBM v2.1 Engine (19 Features)");
  else confReasons.push("Standard-Engine");
  if (r.dataQuality === "HIGH") confReasons.push("vollständige xG-Daten");
  else confReasons.push("eingeschränkte Datenlage");
  const hHist = r.rawMatch.home?.xg_h_history?.length || 0;
  const aHist2 = r.rawMatch.away?.xg_a_history?.length || 0;
  if (Math.min(hHist, aHist2) >= 8) confReasons.push("8+ Spiele History");
  else if (Math.min(hHist, aHist2) >= 5) confReasons.push(`nur ${Math.min(hHist, aHist2)} Spiele History`);
  else confReasons.push("wenig historische Daten");
  if (bo && bo.h > 0) confReasons.push("Live-Quoten verfügbar");
  lines.push(`Konfidenz: ${conf}% (${confLabel}) — ${confReasons.join(", ")}.`);

  return lines.join("\n\n");
}

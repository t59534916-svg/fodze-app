"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import Kit from "@/components/shared/Kit";
import { TEAM_COLORS } from "@/lib/team-colors";
import {
  LEAGUES, getHomeFactor, buildMatrix, deriveAllMarkets, queryMatrix,
  getCorrectScores, getAsianHandicap, getHtFt, getGoalBothHalves,
  predictYellowCards, getHT1X2, getHTCorrectScores, getSecondHalfMarkets,
  getFirstGoalTime, getWinningMargin, calcLambdas,
  type SecondHalfMarkets,
} from "@/lib/dixon-coles";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
import { isLGBMModelLoaded, getLGBMRho, getTeamSeasonFeatures } from "@/lib/lgbm-runtime";
import { TEAM_SCRAPER_MAP } from "@/lib/scrapers/team-map";
import { resolveTeam } from "@/lib/team-resolver";
import { computeSoSRatings, type SoSRatings } from "@/lib/sos";
import type { StandingsRow, LiveOdds } from "@/lib/supabase";
import type { MatchdayData, RawMatch } from "@/types/match";

// ─── Types ─────────────────────────────────────────────────────────

interface MatchReport {
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
  // Brief analysis
  analysis: string;
}

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const toOdds = (p: number) => p > 0.01 ? (1 / p).toFixed(2) : "—";

function posColor(pos: number, leagueSize: number = 18): string {
  if (pos <= 4) return "#6aad55";           // CL grün
  if (pos <= 6) return "#5a9ec4";           // EL blau
  if (pos === 7) return "#d4b86a";          // Conference gold
  if (pos > leagueSize - 3) return "#e07070"; // Abstieg rot
  return "#a89070";                          // Mittelfeld
}

function formatKickoff(ko: string): string {
  if (!ko) return "";
  // "2026-04-04 15:30" → "Fr. 4.4. 15:30"
  const match = ko.match(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})?/);
  if (!match) return ko;
  try {
    const d = new Date(match[1] + "T12:00:00");
    const days = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    const dayStr = `${days[d.getDay()]}. ${d.getDate()}.${d.getMonth() + 1}.`;
    return match[2] ? `${dayStr} ${match[2]}` : dayStr;
  } catch { return ko; }
}

// ─── Generate analysis text ───────────────────────────────────────

function parseForm(form: string | undefined): { w: number; d: number; l: number; streak: string; len: number } {
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

function computeConfidence(r: MatchReport): number {
  let score = 0;

  // 1. Engine quality (0-30)
  if (r.engine === "annafrick13-v2") score += 30;
  else score += 15;

  // 2. Data quality (0-25)
  if (r.dataQuality === "HIGH") score += 25;
  else score += 5;

  // 3. xG history depth — more history = more reliable (0-15)
  const hHist = r.rawMatch.home?.xg_h_history?.length || 0;
  const aHist = r.rawMatch.away?.xg_a_history?.length || 0;
  const histDepth = Math.min(hHist, aHist);
  score += Math.min(histDepth / 8 * 15, 15);

  // 4. Form data available (0-10)
  if (r.formH && r.formH.trim().length > 0) score += 5;
  if (r.formA && r.formA.trim().length > 0) score += 5;

  // 5. Lambda plausibility — extreme values lower confidence (0-10)
  const totalLambda = r.lambdaH + r.lambdaA;
  if (totalLambda >= 1.5 && totalLambda <= 5.0) score += 10;
  else if (totalLambda >= 1.0 && totalLambda <= 6.0) score += 5;

  // 6. Prediction clarity — strong favorite = more confident (0-10)
  const maxProb = Math.max(r.ft1X2.H, r.ft1X2.D, r.ft1X2.A);
  if (maxProb > 0.6) score += 10;
  else if (maxProb > 0.45) score += 6;
  else score += 3; // Very balanced = harder to predict

  return Math.min(Math.round(score), 100);
}

function generateAnalysis(r: MatchReport): string {
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
    let pHO15 = 0;
    for (let i = 2; i < 10; i++) for (let j = 0; j < 10; j++) if (r.matrix[i]?.[j]) pHO15 += r.matrix[i][j]; // H wins with 2+ goals
    // Actually: H wins AND total > 1.5
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

// ─── Styles ────────────────────────────────────────────────────────

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26518", borderRadius: 10, padding: 12, marginBottom: 8 } as React.CSSProperties,
  sectionLabel: { fontSize: 9, fontWeight: 700, color: "#a89070", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 6 } as React.CSSProperties,
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", fontSize: 12 } as React.CSSProperties,
  label: { color: "#a89070", fontSize: 11 } as React.CSSProperties,
  val: { color: "#ede4d4", fontWeight: 600, fontSize: 12, fontFamily: "monospace" } as React.CSSProperties,
  valHigh: { color: "#6aad55", fontWeight: 700, fontSize: 12, fontFamily: "monospace" } as React.CSSProperties,
  bar: (w: number, color: string) => ({ width: `${Math.max(w * 100, 2)}%`, height: 5, borderRadius: 3, background: color, transition: "width 0.3s" }) as React.CSSProperties,
  tag: (c: string) => ({ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: c + "15", color: c, fontWeight: 600 }) as React.CSSProperties,
};

// ─── Prob Row ──────────────────────────────────────────────────────

function PRow({ label, p, highlight }: { label: string; p: number; highlight?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 50, height: 5, borderRadius: 3, background: "#c4a26510", overflow: "hidden" }}>
          <div style={S.bar(p, highlight ? "#6aad55" : "#d4b86a")} />
        </div>
        <span style={highlight ? S.valHigh : S.val}>{pc(p)}</span>
        <span style={{ fontSize: 9, color: "#c4a26540" }}>{toOdds(p)}</span>
      </div>
    </div>
  );
}

// ─── Match Report Card ─────────────────────────────────────────────

function MatchReportCard({ report }: { report: MatchReport }) {
  const [expanded, setExpanded] = useState(false);
  const r = report;

  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)} style={{
        width: "100%", padding: "12px 14px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left" as const,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, flexWrap: "wrap" }}>
            <Kit team={r.home} size={16} />
            {r.homePos && <span style={{ fontSize: 9, fontWeight: 700, color: posColor(r.homePos), background: posColor(r.homePos) + "15", padding: "1px 4px", borderRadius: 3, minWidth: 16, textAlign: "center" }}>{r.homePos}.</span>}
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.home}</span>
            <span style={{ fontSize: 10, color: "#c4a26540" }}>vs</span>
            {r.awayPos && <span style={{ fontSize: 9, fontWeight: 700, color: posColor(r.awayPos), background: posColor(r.awayPos) + "15", padding: "1px 4px", borderRadius: 3, minWidth: 16, textAlign: "center" }}>{r.awayPos}.</span>}
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.away}</span>
            <Kit team={r.away} size={16} />
          </div>
          <span style={{ color: "#c4a26535", fontSize: 14 }}>{expanded ? "▾" : "▸"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={S.tag("#d4b86a")}>{r.leagueName}</span>
          {r.engine === "annafrick13-v2" && (
            <span style={S.tag("#6aad55")}>@annafrick13</span>
          )}
          {r.dataQuality === "LOW" && (
            <span style={S.tag("#e07070")}>Ohne xG</span>
          )}
          <span style={S.tag(r.confidence >= 75 ? "#6aad55" : r.confidence >= 50 ? "#d4b86a" : "#e07070")}>
            {r.confidence}% Konfidenz
          </span>
          {r.kickoff && <span style={{ fontSize: 9, color: "#c4a26550" }}>{formatKickoff(r.kickoff)}</span>}
          <span style={{ fontSize: 9, color: "#a89070", marginLeft: "auto" }}>
            {r.lambdaH.toFixed(2)} : {r.lambdaA.toFixed(2)} xG
          </span>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 14px 14px" }}>
          {/* Data quality warning */}
          {r.dataQuality === "LOW" && (
            <div style={{
              background: "#e0707010", border: "1px solid #e0707025", borderRadius: 8,
              padding: "8px 10px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize: 14 }}>&#9888;</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#e07070" }}>Verminderte Datenqualität</div>
                <div style={{ fontSize: 9, color: "#a89070", marginTop: 1 }}>
                  Keine xG-Daten verfügbar. Analyse basiert auf Liga-Durchschnittswerten und Heimvorteil.
                  Wahrscheinlichkeiten sind weniger präzise.
                </div>
              </div>
            </div>
          )}

          {/* Analysis */}
          <div style={{ background: "#c4a26508", borderRadius: 8, padding: 10, marginBottom: 10, border: "1px solid #c4a26510" }}>
            <div style={{ fontSize: 11, color: "#ede4d4", lineHeight: 1.6 }}>
              {r.analysis.split("\n\n").map((paragraph, pi) => (
                <p key={pi} style={{ margin: pi === 0 ? 0 : "6px 0 0" }}>{paragraph}</p>
              ))}
            </div>
          </div>

          {/* ── xG Comparison Bars (Team Colors) ── */}
          {(() => {
            const [hPrimary] = TEAM_COLORS[r.home] || ["#d4b86a", "#fff"];
            const [aPrimary] = TEAM_COLORS[r.away] || ["#a89070", "#fff"];
            const maxXG = Math.max(r.xgPerGameH, r.xgPerGameA, r.xgaPerGameH, r.xgaPerGameA, 0.5);
            return (<>
              <div style={S.sectionLabel}>xGoals-Vergleich (pro Spiel)</div>
              {/* xG Offensive */}
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3, letterSpacing: "0.05em" }}>OFFENSIV (xGoals erzielt)</div>
              {[
                { name: r.home, val: r.xgPerGameH, color: hPrimary },
                { name: r.away, val: r.xgPerGameA, color: aPrimary },
              ].map(({ name, val, color }) => (
                <div key={name + "xg"} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: "#a89070", width: 70, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name.split(" ").pop()}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#c4a26510", overflow: "hidden" }}>
                    <div style={{ width: `${(val / maxXG) * 100}%`, height: "100%", borderRadius: 4, background: color, opacity: 0.85, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#ede4d4", fontWeight: 600, fontFamily: "monospace", width: 36, textAlign: "right" }}>{val.toFixed(2)}</span>
                </div>
              ))}
              {/* xGA Defensive */}
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3, marginTop: 6, letterSpacing: "0.05em" }}>DEFENSIV (xGoals-Against kassiert)</div>
              {[
                { name: r.home, val: r.xgaPerGameH, color: hPrimary },
                { name: r.away, val: r.xgaPerGameA, color: aPrimary },
              ].map(({ name, val, color }) => (
                <div key={name + "xga"} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: "#a89070", width: 70, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name.split(" ").pop()}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#c4a26510", overflow: "hidden" }}>
                    <div style={{ width: `${(val / maxXG) * 100}%`, height: "100%", borderRadius: 4, background: color, opacity: 0.45, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#c4a26570", fontFamily: "monospace", width: 36, textAlign: "right" }}>{val.toFixed(2)}</span>
                </div>
              ))}
              <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />
            </>);
          })()}

          {/* ── Form Visual ── */}
          {(r.formH || r.formA) && (<>
            <div style={S.sectionLabel}>Form (letzte 5)</div>
            {[{ name: r.home, form: r.formH }, { name: r.away, form: r.formA }].map(({ name, form }) => form ? (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#a89070", width: 80, textAlign: "right" }}>{name.split(" ").pop()}</span>
                <div style={{ display: "flex", gap: 3 }}>
                  {form.trim().split(/\s+/).map((r2, i) => (
                    <span key={i} style={{
                      width: 18, height: 18, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 9, fontWeight: 700,
                      background: r2 === "W" ? "#6aad5520" : r2 === "D" ? "#d4b86a15" : "#e0707015",
                      color: r2 === "W" ? "#6aad55" : r2 === "D" ? "#d4b86a" : "#e07070",
                      border: `1px solid ${r2 === "W" ? "#6aad5530" : r2 === "D" ? "#d4b86a25" : "#e0707025"}`,
                    }}>{r2}</span>
                  ))}
                </div>
              </div>
            ) : null)}
            <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />
          </>)}

          {/* ── 1X2 Full Time ── */}
          <div style={S.sectionLabel}>Ergebnis (Vollzeit)</div>
          <PRow label="Heim" p={r.ft1X2.H} highlight={r.ft1X2.H > 0.45} />
          <PRow label="Unentschieden" p={r.ft1X2.D} />
          <PRow label="Auswärts" p={r.ft1X2.A} highlight={r.ft1X2.A > 0.45} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Double Chance & Draw No Bet ── */}
          <div style={S.sectionLabel}>Doppelte Chance / Draw No Bet</div>
          <PRow label="1X (Heim o. Unent.)" p={r.dc["1X"]} />
          <PRow label="X2 (Unent. o. Ausw.)" p={r.dc["X2"]} />
          <PRow label="12 (Heim o. Ausw.)" p={r.dc["12"]} />
          <PRow label="DNB Heim" p={r.drawNoBetH} highlight={r.drawNoBetH > 0.6} />
          <PRow label="DNB Auswärts" p={r.drawNoBetA} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goals Over/Under Full Time ── */}
          <div style={S.sectionLabel}>Tore Über/Unter (Vollzeit)</div>
          <PRow label="Über 1.5" p={r.goalsOU.O15} highlight={r.goalsOU.O15 > 0.7} />
          <PRow label="Über 2.5" p={r.goalsOU.O25} highlight={r.goalsOU.O25 > 0.55} />
          <PRow label="Über 3.5" p={r.goalsOU.O35} />
          <PRow label="Über 4.5" p={r.goalsOU.O45} />
          <PRow label="Über 5.5" p={r.goalsOU.O55} />
          <PRow label="Gerade Tore" p={r.evenGoals} />
          <PRow label="Ungerade Tore" p={r.oddGoals} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── BTTS ── */}
          <div style={S.sectionLabel}>Beide Teams treffen</div>
          <PRow label="Ja" p={r.btts.yes} highlight={r.btts.yes > 0.55} />
          <PRow label="Nein" p={r.btts.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Clean Sheet & Win to Nil ── */}
          <div style={S.sectionLabel}>Clean Sheet / Win to Nil</div>
          <PRow label={`${r.home} Clean Sheet`} p={r.cleanSheetH} highlight={r.cleanSheetH > 0.35} />
          <PRow label={`${r.away} Clean Sheet`} p={r.cleanSheetA} />
          <PRow label={`${r.home} Win to Nil`} p={r.winToNilH} />
          <PRow label={`${r.away} Win to Nil`} p={r.winToNilA} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Team Goals ── */}
          <div style={S.sectionLabel}>Tore pro Team</div>
          <PRow label={`${r.home} Ü0.5`} p={r.homeGoals.O05} />
          <PRow label={`${r.home} Ü1.5`} p={r.homeGoals.O15} />
          <PRow label={`${r.home} Ü2.5`} p={r.homeGoals.O25} />
          <PRow label={`${r.away} Ü0.5`} p={r.awayGoals.O05} />
          <PRow label={`${r.away} Ü1.5`} p={r.awayGoals.O15} />
          <PRow label={`${r.away} Ü2.5`} p={r.awayGoals.O25} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Exact Team Goals ── */}
          <div style={S.sectionLabel}>Exakte Tore pro Team</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3 }}>{r.home}</div>
              {["0 Tore", "1 Tor", "2 Tore", "3+ Tore"].map((label, i) => (
                <PRow key={`h${i}`} label={label} p={r.homeExact[i]} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3 }}>{r.away}</div>
              {["0 Tore", "1 Tor", "2 Tore", "3+ Tore"].map((label, i) => (
                <PRow key={`a${i}`} label={label} p={r.awayExact[i]} />
              ))}
            </div>
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Race to 2 Goals ── */}
          <div style={S.sectionLabel}>Race to 2 Goals</div>
          <PRow label={r.home} p={r.raceTo2H} highlight={r.raceTo2H > 0.45} />
          <PRow label={r.away} p={r.raceTo2A} />
          <PRow label="Keiner erreicht 2" p={r.raceTo2Neither} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT 1X2 ── */}
          <div style={S.sectionLabel}>Halbzeit-Ergebnis</div>
          <PRow label="Heim" p={r.ht1X2.H} />
          <PRow label="Unentschieden" p={r.ht1X2.D} highlight={r.ht1X2.D > 0.4} />
          <PRow label="Auswärts" p={r.ht1X2.A} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT Goals Over/Under ── */}
          <div style={S.sectionLabel}>Halbzeit Tore Über/Unter</div>
          <PRow label="HT Über 0.5" p={r.htGoalsOU.O05} highlight={r.htGoalsOU.O05 > 0.65} />
          <PRow label="HT Über 1.5" p={r.htGoalsOU.O15} />
          <PRow label="HT Über 2.5" p={r.htGoalsOU.O25} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT Correct Scores ── */}
          <div style={S.sectionLabel}>Halbzeit Genauer Spielstand</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
            {r.htCorrectScores.slice(0, 8).map(cs => (
              <div key={cs.score} style={{
                background: "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#d4b86a" }}>{cs.score}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(cs.p)}</div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT/FT ── */}
          <div style={S.sectionLabel}>Halbzeit / Endstand</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            {Object.entries(r.htft).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([key, p]) => (
              <div key={key} style={{
                background: p > 0.15 ? "#6aad5510" : "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: p > 0.15 ? "1px solid #6aad5520" : "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: p > 0.15 ? "#6aad55" : "#ede4d4" }}>{key}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(p)}</div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── 2nd Half Markets ── */}
          <div style={S.sectionLabel}>2. Halbzeit (ab 0:0 HT)</div>
          <PRow label="Heim" p={r.secondHalf.H} />
          <PRow label="Unentschieden" p={r.secondHalf.D} />
          <PRow label="Auswärts" p={r.secondHalf.A} />
          <PRow label="2H Über 0.5" p={r.secondHalf.O05} />
          <PRow label="2H Über 1.5" p={r.secondHalf.O15} />
          <PRow label="2H Über 2.5" p={r.secondHalf.O25} />
          <PRow label="2H BTTS Ja" p={r.secondHalf.BY} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goal In Both Halves ── */}
          <div style={S.sectionLabel}>Tor in beiden Halbzeiten</div>
          <PRow label="Ja" p={r.goalBothHalves.yes} />
          <PRow label="Nein" p={r.goalBothHalves.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Score Matrix Heatmap ── */}
          <div style={S.sectionLabel}>Score-Matrix (Wahrscheinlichkeit)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 9 }}>
              <thead>
                <tr>
                  <th style={{ padding: 2, color: "#a89070", fontSize: 8 }}></th>
                  {[0,1,2,3,4,5,6].map(j => <th key={j} style={{ padding: 2, color: "#a89070", fontSize: 8, textAlign: "center" }}>{r.away.split(" ").pop()} {j}</th>)}
                </tr>
              </thead>
              <tbody>
                {r.heatmap.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: 2, color: "#a89070", fontSize: 8, fontWeight: 600 }}>{r.home.split(" ").pop()} {i}</td>
                    {row.map((p, j) => {
                      const intensity = Math.min(p / 0.12, 1);
                      const bg = i === j ? `rgba(212,184,106,${intensity * 0.5})` // Draw = gold
                        : i > j ? `rgba(106,173,85,${intensity * 0.5})` // Home win = green
                        : `rgba(224,112,112,${intensity * 0.5})`; // Away win = red
                      return (
                        <td key={j} style={{
                          padding: "3px 2px", textAlign: "center", borderRadius: 2,
                          background: bg, color: p > 0.04 ? "#ede4d4" : "#c4a26550",
                          fontWeight: p > 0.07 ? 700 : 400, fontFamily: "monospace",
                        }}>
                          {(p * 100).toFixed(1)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 4, fontSize: 8, color: "#a89070" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(106,173,85,0.4)", marginRight: 3 }} />Heim</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(212,184,106,0.4)", marginRight: 3 }} />Unent.</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(224,112,112,0.4)", marginRight: 3 }} />Ausw.</span>
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Correct Score FT ── */}
          <div style={S.sectionLabel}>Genauer Spielstand (Vollzeit)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
            {r.correctScores.slice(0, 12).map(cs => (
              <div key={cs.score} style={{
                background: cs.p > 0.08 ? "#d4b86a10" : "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: cs.p > 0.08 ? "1px solid #d4b86a25" : "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: cs.p > 0.08 ? "#d4b86a" : "#ede4d4" }}>{cs.score}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(cs.p)} <span style={{ color: "#c4a26530" }}>{toOdds(cs.p)}</span></div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Winning Margin ── */}
          <div style={S.sectionLabel}>Siegtordifferenz</div>
          {Object.entries(r.winningMargin).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([margin, p]) => (
            <PRow key={margin} label={margin} p={p} />
          ))}
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Asian Handicap ── */}
          <div style={S.sectionLabel}>Handicap (Heim)</div>
          {["-2.5", "-2", "-1.5", "-1", "-0.5", "0", "+0.5", "+1", "+1.5"].map(line => {
            const ah = r.asianHandicap[line];
            if (!ah) return null;
            return <PRow key={line} label={`HC ${line}`} p={ah.P_Win} highlight={ah.P_Win > 0.55} />;
          })}
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Yellow Cards ── */}
          <div style={S.sectionLabel}>Gelbe Karten</div>
          <div style={S.row}>
            <span style={S.label}>Erwartete Karten</span>
            <span style={S.val}>{r.yellowCards.expected.toFixed(1)}</span>
          </div>
          <PRow label="Über 2.5" p={r.yellowCards.over25} />
          <PRow label="Über 3.5" p={r.yellowCards.over35} />
          <PRow label="Über 4.5" p={r.yellowCards.over45} />
          <PRow label="Über 5.5" p={r.yellowCards.over55} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── First Goal Timing ── */}
          <div style={S.sectionLabel}>Erstes Tor</div>
          <PRow label="Vor Minute 30" p={r.firstGoalBefore30} />
          <PRow label="Vor Minute 60" p={r.firstGoalBefore60} />
        </div>
      )}
    </div>
  );
}

// ─── Standings Table ──────────────────────────────────────────────

function StandingsTable({ rows, leagueName }: { rows: StandingsRow[]; leagueName: string }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  const leagueSize = rows.length;
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden", marginBottom: 8 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", padding: "8px 12px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left" as const, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#d4b86a", letterSpacing: "0.05em" }}>
          Tabelle {leagueName}
        </span>
        <span style={{ color: "#c4a26535", fontSize: 12 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 8px 8px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #c4a26520" }}>
                {["#", "", "Team", "Sp", "S", "U", "N", "T", "GT", "TD", "Pkt"].map(h => (
                  <th key={h} style={{ padding: "3px 4px", color: "#a89070", fontWeight: 600, textAlign: h === "Team" || h === "" ? "left" : "center", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pc2 = posColor(r.pos, leagueSize);
                const isZone = r.pos <= 4 || r.pos > leagueSize - 3;
                return (
                  <tr key={r.team} style={{ borderBottom: "1px solid #c4a26508", background: isZone ? pc2 + "08" : "transparent" }}>
                    <td style={{ padding: "3px 4px", fontWeight: 700, color: pc2, textAlign: "center" }}>{r.pos}</td>
                    <td style={{ padding: "3px 2px" }}><Kit team={r.fodzeName} size={12} /></td>
                    <td style={{ padding: "3px 4px", color: "#ede4d4", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{r.fodzeName}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.played}</td>
                    <td style={{ padding: "3px 4px", color: "#6aad55", textAlign: "center" }}>{r.won}</td>
                    <td style={{ padding: "3px 4px", color: "#d4b86a", textAlign: "center" }}>{r.drawn}</td>
                    <td style={{ padding: "3px 4px", color: "#e07070", textAlign: "center" }}>{r.lost}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.gf}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.ga}</td>
                    <td style={{ padding: "3px 4px", color: r.gd > 0 ? "#6aad55" : r.gd < 0 ? "#e07070" : "#a89070", textAlign: "center", fontWeight: 600 }}>{r.gd > 0 ? "+" : ""}{r.gd}</td>
                    <td style={{ padding: "3px 4px", color: "#ede4d4", fontWeight: 700, textAlign: "center" }}>{r.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 8, color: "#a89070" }}>
            <span><span style={{ color: "#6aad55" }}>●</span> CL</span>
            <span><span style={{ color: "#5a9ec4" }}>●</span> EL</span>
            <span><span style={{ color: "#e07070" }}>●</span> Abstieg</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────

export default function FuckBettingPage() {
  const router = useRouter();
  const { supabase, leagueStatus } = useApp();
  const [allData, setAllData] = useState<{ league: string; data: MatchdayData }[]>([]);
  const [standings, setStandings] = useState<Map<string, StandingsRow[]>>(new Map());
  const [sosMap, setSosMap] = useState<Map<string, SoSRatings>>(new Map());
  const [oddsMap, setOddsMap] = useState<Map<string, LiveOdds>>(new Map());
  const [loading, setLoading] = useState(true);

  // Load all leagues with data + enrich with xG history for @annafrick13 v2
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { loadLatestMatchday, loadTeamXGHistory, toXGHistoryEntries, loadLeagueStandings, loadLiveOdds } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);
      const results = await Promise.all(leagueKeys.map(async (key) => {
        const md = await loadLatestMatchday(supabase, key);
        if (!md) return null;
        const data = md.data as MatchdayData;

        // Enrich each match with per-match xG history from Supabase (needed for v2 EWMA)
        if (data.matches) {
          await Promise.all(data.matches.map(async (match) => {
            const resolveTeam = (name: string) => {
              const mapped = TEAM_SCRAPER_MAP[name];
              return mapped?.understat || name;
            };
            if (match.home?.name && !match.home.xg_h_history?.length) {
              const understatName = resolveTeam(match.home.name);
              const hist = await loadTeamXGHistory(supabase, understatName, key, "home", 8);
              if (hist.length > 0) match.home.xg_h_history = toXGHistoryEntries(hist);
            }
            if (match.away?.name && !match.away.xg_a_history?.length) {
              const understatName = resolveTeam(match.away.name);
              const hist = await loadTeamXGHistory(supabase, understatName, key, "away", 8);
              if (hist.length > 0) match.away.xg_a_history = toXGHistoryEntries(hist);
            }
          }));
        }

        return { league: key, data };
      }));
      const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null);
      setAllData(validResults);

      // Load standings + SoS for each league in parallel
      const standingsMap = new Map<string, StandingsRow[]>();
      const sosResults = new Map<string, SoSRatings>();
      const { loadLeagueXGHistory } = await import("@/lib/supabase");
      await Promise.all(validResults.map(async ({ league }) => {
        if (!standingsMap.has(league)) {
          const rows = await loadLeagueStandings(supabase, league);
          standingsMap.set(league, rows);
        }
        // SoS: load all league matches, compute opponent-quality ratings
        if (!sosResults.has(league)) {
          try {
            const leagueXG = await loadLeagueXGHistory(supabase, league);
            if (leagueXG.length > 0) {
              const ld = LEAGUES[league] || LEAGUES.bundesliga;
              const sosMatches = leagueXG.map(m => ({ team: m.team, opponent: m.opponent, xg: m.xg, xga: m.xga }));
              sosResults.set(league, computeSoSRatings(sosMatches, ld.avg));
            }
          } catch { /* SoS optional */ }
        }
      }));
      setStandings(standingsMap);
      setSosMap(sosResults);

      // Load live odds for each league and build a fuzzy-match map
      const allOdds = new Map<string, LiveOdds>();
      await Promise.all(validResults.map(async ({ league }) => {
        try {
          const odds = await loadLiveOdds(supabase, league);
          for (const o of odds) {
            // Key: normalize team names for fuzzy matching
            const key = `${o.home_team.toLowerCase()}|${o.away_team.toLowerCase()}`;
            allOdds.set(key, o);
          }
        } catch { /* odds optional */ }
      }));
      setOddsMap(allOdds);
      setLoading(false);
    })();
  }, [supabase, leagueStatus]);

  // Helper: find live odds for a match (fuzzy team name matching)
  const findOdds = (homeName: string, awayName: string): LiveOdds | null => {
    // Try exact lowercase match
    const key = `${homeName.toLowerCase()}|${awayName.toLowerCase()}`;
    if (oddsMap.has(key)) return oddsMap.get(key)!;
    // Try resolving via team-resolver
    const hRes = resolveTeam(homeName);
    const aRes = resolveTeam(awayName);
    for (const [k, v] of oddsMap.entries()) {
      const [oh, oa] = k.split("|");
      // Check if resolved names match odds-api names
      if (hRes?.oddsApi?.toLowerCase() === oh && aRes?.oddsApi?.toLowerCase() === oa) return v;
      if (hRes?.csv?.toLowerCase() === oh && aRes?.csv?.toLowerCase() === oa) return v;
      // Substring match
      if (oh.includes(homeName.toLowerCase().split(" ").pop()!) && oa.includes(awayName.toLowerCase().split(" ").pop()!)) return v;
    }
    return null;
  };

  // Helper: find team position in standings (try FODZE name, then Understat name)
  const findPos = (teamName: string, leagueStandings: StandingsRow[] | undefined): StandingsRow | null => {
    if (!leagueStandings) return null;
    // Try FODZE name match
    let row = leagueStandings.find(s => s.fodzeName === teamName);
    if (row) return row;
    // Try Understat name match
    const resolved = resolveTeam(teamName);
    if (resolved) {
      row = leagueStandings.find(s => s.team === resolved.csv || s.team === (resolved.understat || ""));
      if (row) return row;
    }
    // Substring fallback
    const lower = teamName.toLowerCase();
    row = leagueStandings.find(s => s.team.toLowerCase().includes(lower) || lower.includes(s.team.toLowerCase()));
    return row || null;
  };

  // Build reports for all matches
  const reports = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const result: MatchReport[] = [];

    for (const { league, data } of allData) {
      if (!data?.matches) continue;
      const ld = LEAGUES[league];
      if (!ld) continue;

      // Matchday-level date as fallback
      const matchdayDate = data.date || "";

      for (const match of data.matches) {
        const h = match.home;
        const a = match.away;
        if (!h?.name || !a?.name) continue;

        // Determine data quality: HIGH if real xG data, LOW if using league-average fallback
        const hasXG = !!(h.xg_h8 && h.xg_h8 > 0 && a.xg_a8 && a.xg_a8 > 0);
        const dataQuality: "HIGH" | "LOW" = hasXG ? "HIGH" : "LOW";

        // Fallback xG: use league average * 8 games (both teams = league average)
        const fallbackXG = ld.avg * 8;
        const xgH8 = hasXG ? h.xg_h8! : fallbackXG;
        const xgaH8 = hasXG ? (h.xga_h8 || fallbackXG) : fallbackXG;
        const xgA8 = hasXG ? a.xg_a8! : fallbackXG;
        const xgaA8 = hasXG ? (a.xga_a8 || fallbackXG) : fallbackXG;
        const hGames = h.games || 8;
        const aGames = a.games || 8;

        // Resolve kickoff: full datetime > time-only + matchday date > matchday date
        let kickoff = match.kickoff || "";
        if (kickoff && !/^\d{4}-/.test(kickoff) && matchdayDate) {
          kickoff = `${matchdayDate} ${kickoff}`;
        } else if (!kickoff && matchdayDate) {
          kickoff = matchdayDate;
        }

        // Compute lambdas — try @annafrick13 v2 first, fallback to standard
        const hf = getHomeFactor(h.name, ld.hf);
        let lambdaH: number;
        let lambdaA: number;
        let engine: "annafrick13-v2" | "standard" = "standard";
        let effectiveRho = -0.05;

        // Try v2: needs LightGBM model + per-match xG history
        const hHist = h.xg_h_history;
        const aHist = a.xg_a_history;
        if (isLGBMModelLoaded() && hHist?.length && aHist?.length) {
          const leagueSos = sosMap.get(league);
          const v2Result = calcMatchPoissonMLv2({
            xgHS: xgH8, xgaHC: xgaH8, hGames,
            xgAS: xgA8, xgaAC: xgaA8, aGames,
            leagueAvg: ld.avg, homeFactor: hf, league,
            tags: match.tags || [],
            hHistory: hHist, aHistory: aHist,
            homeTeam: h.name, awayTeam: a.name,
            fraction: 0.25,
            sosRatings: leagueSos,
          });
          if (v2Result) {
            lambdaH = v2Result.lambdaH;
            lambdaA = v2Result.lambdaA;
            engine = "annafrick13-v2";
            effectiveRho = getLGBMRho();
          } else {
            // v2 refused (missing data) → standard fallback
            const std = calcLambdas(xgH8, xgaH8, xgA8, xgaA8, hGames, aGames, ld.avg, hf);
            lambdaH = std.lambdaH;
            lambdaA = std.lambdaA;
          }
        } else {
          // No model or no history → standard engine
          const std = calcLambdas(xgH8, xgaH8, xgA8, xgaA8, hGames, aGames, ld.avg, hf);
          lambdaH = std.lambdaH;
          lambdaA = std.lambdaA;
        }

        // For v2: compute EWMA-based xG per game from history (more accurate than raw sums)
        let xgPgH = xgH8 / hGames;
        let xgaPgH = xgaH8 / hGames;
        let xgPgA = xgA8 / aGames;
        let xgaPgA = xgaA8 / aGames;
        if (engine === "annafrick13-v2" && hHist?.length && aHist?.length) {
          // EWMA from per-match history — same alpha as v2 engine
          const ewma = (hist: typeof hHist, key: "xg" | "xga") => {
            const alpha = 0.85;
            let wSum = 0, wVal = 0;
            for (let i = 0; i < hist.length; i++) {
              const w = Math.pow(alpha, hist.length - 1 - i);
              wSum += w;
              const entry = hist[i];
              wVal += w * ((key === "xg" ? (entry.npxg ?? entry.xg) : (entry.npxga ?? entry.xga)));
            }
            return wSum > 0 ? wVal / wSum : xgH8 / hGames;
          };
          xgPgH = ewma(hHist, "xg");
          xgaPgH = ewma(hHist, "xga");
          xgPgA = ewma(aHist, "xg");
          xgaPgA = ewma(aHist, "xga");
        }

        // Build matrix (use optimized rho for v2, default for standard)
        const mx = buildMatrix(lambdaH, lambdaA, effectiveRho);
        const mk = deriveAllMarkets(mx);
        const cs = getCorrectScores(mx, 12);
        const ah = getAsianHandicap(mx, "H");
        const htft = getHtFt(lambdaH, lambdaA);
        const gbh = getGoalBothHalves(lambdaH, lambdaA);
        const yc = predictYellowCards(undefined, league);
        const ht1x2 = getHT1X2(lambdaH, lambdaA);
        const htCS = getHTCorrectScores(lambdaH, lambdaA);
        const wm = getWinningMargin(mx);
        const sh = getSecondHalfMarkets(lambdaH, lambdaA, 0, 0); // Pre-match: 0-0 HT state

        // HT Goals O/U from HT matrix
        const HT_FACTOR = 0.44;
        const htMx = buildMatrix(lambdaH * HT_FACTOR, lambdaA * HT_FACTOR);
        const htO05 = 1 - htMx[0][0];
        const htO15 = queryMatrix(htMx, [{ type: "total_goals", op: ">", value: 1.5 }]);
        const htO25 = queryMatrix(htMx, [{ type: "total_goals", op: ">", value: 2.5 }]);

        // Exact team goals: P(home=0), P(home=1), P(home=2), P(home=3+)
        const homeExact = [0, 0, 0, 0];
        const awayExact = [0, 0, 0, 0];
        for (let i = 0; i < mx.length; i++) {
          for (let j = 0; j < mx[0].length; j++) {
            const idx = Math.min(i, 3);
            homeExact[idx] += mx[i][j];
            const jdx = Math.min(j, 3);
            awayExact[jdx] += mx[i][j];
          }
        }

        // Odd/Even total goals
        let oddGoals = 0;
        for (let i = 0; i < mx.length; i++)
          for (let j = 0; j < mx[0].length; j++)
            if ((i + j) % 2 === 1) oddGoals += mx[i][j];

        // Race to 2 goals (P that home reaches 2 first, away reaches 2 first, or neither reaches 2)
        // Approximate via matrix: P(home>=2 & away<=1) + P(home>=2 & away>=2 & home scored 2nd faster)
        // Simplified: use conditional probabilities from exact scores
        let raceTo2H = 0, raceTo2A = 0;
        for (let i = 0; i < mx.length; i++) {
          for (let j = 0; j < mx[0].length; j++) {
            if (i >= 2 && j < 2) raceTo2H += mx[i][j]; // Home has 2+, away has 0-1
            else if (j >= 2 && i < 2) raceTo2A += mx[i][j]; // Away has 2+, home has 0-1
            else if (i >= 2 && j >= 2) {
              // Both reach 2+: split proportionally by lambda (who scores faster)
              const hShare = lambdaH / (lambdaH + lambdaA);
              raceTo2H += mx[i][j] * hShare;
              raceTo2A += mx[i][j] * (1 - hShare);
            }
          }
        }
        const raceTo2Neither = 1 - raceTo2H - raceTo2A;

        // Clean sheet & Win to nil
        const csH = mk.CS_H; // P(away=0)
        const csA = mk.CS_A; // P(home=0)
        const wtnH = queryMatrix(mx, [{ type: "goal_diff", op: ">", value: 0 }, { type: "away_goals", op: "==", value: 0 }]);
        const wtnA = queryMatrix(mx, [{ type: "goal_diff", op: "<", value: 0 }, { type: "home_goals", op: "==", value: 0 }]);

        // Draw No Bet
        const dnbH = mk.H / (mk.H + mk.A);
        const dnbA = mk.A / (mk.H + mk.A);

        // Heatmap: 7x7 slice of matrix
        const heatmap = mx.slice(0, 7).map(row => row.slice(0, 7));

        const report: MatchReport = {
          home: h.name,
          away: a.name,
          league,
          leagueName: ld.name,
          kickoff,
          lambdaH,
          lambdaA,
          matrix: mx,
          ft1X2: { H: mk.H, D: mk.D, A: mk.A },
          dc: { "1X": mk.DC_1X, "X2": mk.DC_X2, "12": mk.DC_12 },
          goalsOU: { O15: mk.O15, O25: mk.O25, O35: mk.O35, O45: mk.O45, O55: mk.O55 },
          btts: { yes: mk.BY, no: mk.BN },
          correctScores: cs,
          winningMargin: wm,
          asianHandicap: ah,
          ht1X2: ht1x2,
          htCorrectScores: htCS,
          htft,
          goalBothHalves: gbh,
          homeGoals: { O05: mk.HO05, O15: mk.HO15, O25: mk.HO25 },
          awayGoals: { O05: mk.AO05, O15: mk.AO15, O25: mk.AO25 },
          yellowCards: yc,
          firstGoalBefore30: getFirstGoalTime(lambdaH, lambdaA, 30),
          firstGoalBefore60: getFirstGoalTime(lambdaH, lambdaA, 60),
          cleanSheetH: csH,
          cleanSheetA: csA,
          winToNilH: wtnH,
          winToNilA: wtnA,
          drawNoBetH: dnbH,
          drawNoBetA: dnbA,
          htGoalsOU: { O05: htO05, O15: htO15, O25: htO25 },
          secondHalf: sh,
          homeExact,
          awayExact,
          oddGoals,
          evenGoals: 1 - oddGoals,
          raceTo2H,
          raceTo2A,
          raceTo2Neither,
          heatmap,
          formH: h.form || "",
          formA: a.form || "",
          dataQuality,
          engine,
          rawMatch: match,
          xgPerGameH: xgPgH,
          xgaPerGameH: xgaPgH,
          xgPerGameA: xgPgA,
          xgaPerGameA: xgaPgA,
          homePos: null,
          awayPos: null,
          homePoints: null,
          awayPoints: null,
          confidence: 0,
          analysis: "",
        };

        // Lookup live odds
        const matchOdds = findOdds(h.name, a.name);
        if (matchOdds) {
          report.bestOdds = {
            h: matchOdds.best_h || 0, d: matchOdds.best_d || 0, a: matchOdds.best_a || 0,
            o25: matchOdds.best_over25 || 0, u25: matchOdds.best_under25 || 0,
          };
          if (matchOdds.sharp_h) {
            report.sharpOdds = { h: matchOdds.sharp_h, d: matchOdds.sharp_d || 0, a: matchOdds.sharp_a || 0 };
          }
          report.numBookmakers = matchOdds.num_bookmakers;
        }

        // Lookup table positions
        const leagueStandings = standings.get(league);
        const hRow = findPos(h.name, leagueStandings);
        const aRow = findPos(a.name, leagueStandings);
        if (hRow) { report.homePos = hRow.pos; report.homePoints = hRow.points; }
        if (aRow) { report.awayPos = aRow.pos; report.awayPoints = aRow.points; }

        report.confidence = computeConfidence(report);
        report.analysis = generateAnalysis(report);

        result.push(report);
      }
    }

    // Sort: nearest future date first, then past
    result.sort((a, b) => {
      const da = a.kickoff || "9999";
      const db = b.kickoff || "9999";
      const aFuture = da >= today;
      const bFuture = db >= today;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      if (aFuture && bFuture) return da.localeCompare(db);
      return db.localeCompare(da);
    });

    return result;
  }, [allData, standings, sosMap, oddsMap]);

  // Group by league, then by date within each league
  const groupedByLeague = useMemo(() => {
    const leagueMap = new Map<string, MatchReport[]>();
    for (const r of reports) {
      if (!leagueMap.has(r.league)) leagueMap.set(r.league, []);
      leagueMap.get(r.league)!.push(r);
    }
    return Array.from(leagueMap.entries());
  }, [reports]);

  function formatDateLabel(iso: string): string {
    if (iso === "Unbekannt") return iso;
    try {
      const d = new Date(iso + "T12:00:00");
      const days = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
      return `${days[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    } catch { return iso; }
  }

  return (
    <AppShell>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => router.push("/")} style={{
          background: "transparent", border: "none", color: "#a89070", fontSize: 12,
          cursor: "pointer", padding: "4px 0", marginBottom: 8,
        }}>
          ← Zurück
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/anna-avatar-1.jpg" alt="" width={44} height={44} style={{ borderRadius: "50%", objectFit: "cover", border: "2px solid #d4b86a40" }} />
          <div>
            <h1 style={{
              fontSize: 20, fontWeight: 700, color: "#d4b86a", margin: 0, letterSpacing: 0.5,
              fontFamily: "Georgia, serif",
            }}>
              Anna&apos;s Analysen
            </h1>
            <p style={{ fontSize: 11, color: "#a89070", margin: "2px 0 0" }}>
              Vollständige Wahrscheinlichkeitsanalyse. Ohne Wettquoten. Nur Mathematik.
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#a89070" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>Lade Daten aller Ligen...</div>
          <div style={{ fontSize: 10 }}>Dixon-Coles Matrix wird berechnet</div>
        </div>
      ) : reports.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#a89070" }}>
          <div style={{ fontSize: 14 }}>Keine Spieldaten verfügbar</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Erst Ligen auf der Startseite laden</div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: "#a89070", marginBottom: 12 }}>
            {reports.length} Spiele aus {new Set(reports.map(r => r.league)).size} Ligen
          </div>

          {groupedByLeague.map(([league, matches]) => {
            const leagueStandings = standings.get(league);
            const ld = LEAGUES[league];
            // Sub-group by date within league
            const byDate = new Map<string, MatchReport[]>();
            for (const r of matches) {
              const date = r.kickoff?.slice(0, 10) || "Unbekannt";
              if (!byDate.has(date)) byDate.set(date, []);
              byDate.get(date)!.push(r);
            }
            return (
              <div key={league} style={{ marginBottom: 20 }}>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: "#d4b86a", letterSpacing: "0.05em",
                  padding: "8px 0 6px", borderBottom: "2px solid #c4a26530", marginBottom: 8,
                }}>
                  {ld?.name || league}
                </div>

                {/* Standings Table (collapsible) */}
                {leagueStandings && leagueStandings.length > 0 && (
                  <StandingsTable rows={leagueStandings} leagueName={ld?.name || league} />
                )}

                {/* Matches grouped by date */}
                {Array.from(byDate.entries()).map(([date, dateMatches]) => (
                  <div key={date}>
                    <div style={{
                      fontSize: 10, fontWeight: 600, color: "#a89070", letterSpacing: "0.05em",
                      padding: "4px 0", marginBottom: 4, marginTop: 4,
                    }}>
                      {formatDateLabel(date)}
                    </div>
                    {dateMatches.map((r, i) => (
                      <MatchReportCard key={`${r.home}-${r.away}-${i}`} report={r} />
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </AppShell>
  );
}

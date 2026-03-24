// ═══════════════════════════════════════════════════════════════════════
// FODZE ENGINE v2 — TypeScript Port
// 15×15 Dixon-Coles Matrix · query() → All Markets · Shin's Vig
// ═══════════════════════════════════════════════════════════════════════

import { calibrate1X2, calibrateOU25 } from "./calibration";

export const LEAGUES: Record<string, { name: string; hf: number; avg: number }> = {
  bundesliga:    { name: "Bundesliga",        hf: 1.28, avg: 1.38 },
  epl:           { name: "Premier League",    hf: 1.22, avg: 1.35 },
  la_liga:       { name: "La Liga",           hf: 1.30, avg: 1.25 },
  serie_a:       { name: "Serie A",           hf: 1.27, avg: 1.32 },
  ligue_1:       { name: "Ligue 1",           hf: 1.32, avg: 1.30 },
  eredivisie:    { name: "Eredivisie",        hf: 1.25, avg: 1.45 },
  championship:  { name: "Championship",      hf: 1.26, avg: 1.30 },
  bundesliga2:   { name: "2. Bundesliga",     hf: 1.29, avg: 1.35 },
  liga3:         { name: "3. Liga",           hf: 1.22, avg: 1.40 },
  cl:            { name: "Champions League",  hf: 1.15, avg: 1.28 },
  el:            { name: "Europa League",     hf: 1.15, avg: 1.25 },
  pokal:         { name: "DFB-Pokal",         hf: 1.10, avg: 1.30 },
};

// ─── Team-spezifische Heimfaktoren (3. Liga) ──────────────────────
// Basierend auf 1,859 Spielen (2020/21–2024/25). Überschreibt den
// Liga-Durchschnitt (1.22) für Teams mit nachweislich starkem/schwachem
// Fansupport und Heimvorteil.
export const TEAM_HOME_FACTORS: Record<string, number> = {
  // 3. Liga — Starker Fansupport
  "SV Waldhof Mannheim":  1.65,
  "Hallescher FC":        1.56,
  "Rot-Weiss Essen":      1.47,
  "Energie Cottbus":       1.44,
  "SpVgg Unterhaching":   1.37,
  "1. FC Kaiserslautern": 1.36,
  "Hansa Rostock":        1.35,
  "MSV Duisburg":         1.31,
  "TSV 1860 München":     1.30,
  "Dynamo Dresden":       1.28,
  "VfL Osnabrück":        1.27,
  "Erzgebirge Aue":       1.26,
  "1. FC Saarbrücken":    1.25,
  "Alemannia Aachen":     1.24,
  // 3. Liga — Durchschnittlich
  "SV Wehen Wiesbaden":   1.22,
  "Preußen Münster":      1.22,
  "Jahn Regensburg":      1.20,
  "SSV Ulm 1846":         1.19,
  "FC Ingolstadt 04":     1.20,
  "SC Verl":              1.18,
  "FC Viktoria Köln":     1.18,
  // Reserve-/Zweitteams (kaum Fans)
  "Borussia Dortmund II": 0.84,
  "FC Bayern München II": 0.78,
  "TSG Hoffenheim II":    0.80,
  "VfB Stuttgart II":     0.82,
  // 2. Bundesliga — Starker Fansupport
  "FC Schalke 04":        1.34,
  "Fortuna Düsseldorf":   1.26,
  "Hertha BSC":           1.24,
};

/** Liefert den Heimfaktor für ein Team. Team-Override > Liga-Default. */
export function getHomeFactor(homeTeam: string, leagueHf: number): number {
  return TEAM_HOME_FACTORS[homeTeam] ?? leagueHf;
}

// ─── Poisson PMF (log-space for numerical stability) ────────────────

function poissonPMF(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// ═══════════════════════════════════════════════════════════════════════
// CORE ENGINE — 15×15 Matrix + query()
// ═══════════════════════════════════════════════════════════════════════

const MAX_GOALS = 15;
const HT_FACTOR = 0.44; // Empirisch: 0.4424 über 15.696 Spiele (vorher 0.47)
const RHO = -0.05;

export interface QueryCondition {
  type: "home_goals" | "away_goals" | "total_goals" | "goal_diff" | "home_min" | "away_min";
  op: ">" | ">=" | "<" | "<=" | "==" | "!=";
  value: number;
}

export function buildMatrix(lamH: number, lamA: number, rho = RHO): number[][] {
  const n = MAX_GOALS;
  const mx: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      mx[i][j] = poissonPMF(i, lamH) * poissonPMF(j, lamA);
  if (lamH > 0 && lamA > 0) {
    mx[0][0] *= Math.max(0, 1 - lamH * lamA * rho);
    mx[1][0] *= Math.max(0, 1 + lamA * rho);
    mx[0][1] *= Math.max(0, 1 + lamH * rho);
    mx[1][1] *= Math.max(0, 1 - rho);
  }
  let sum = 0;
  for (const row of mx) for (const v of row) sum += v;
  if (sum > 0) for (const row of mx) for (let j = 0; j < n; j++) row[j] /= sum;
  return mx;
}

function evalCond(c: QueryCondition, home: number, away: number): boolean {
  let val: number;
  switch (c.type) {
    case "home_goals": val = home; break;
    case "away_goals": val = away; break;
    case "total_goals": val = home + away; break;
    case "goal_diff": val = home - away; break;
    case "home_min": return home >= c.value;
    case "away_min": return away >= c.value;
    default: return false;
  }
  switch (c.op) {
    case ">": return val > c.value;
    case ">=": return val >= c.value;
    case "<": return val < c.value;
    case "<=": return val <= c.value;
    case "==": return val === c.value;
    case "!=": return val !== c.value;
    default: return false;
  }
}

export function queryMatrix(mx: number[][], conditions: QueryCondition[]): number {
  const n = mx.length;
  let p = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (conditions.every(c => evalCond(c, i, j)))
        p += mx[i][j];
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
// MARKETS (all derived via queryMatrix)
// ═══════════════════════════════════════════════════════════════════════

export interface Markets {
  H: number; D: number; A: number;
  O15: number; O25: number; O35: number; O45: number; O55: number;
  U15: number; U25: number; U35: number; U45: number; U55: number;
  BY: number; BN: number;
  best: string; bestP: number;
  DC_1X: number; DC_X2: number; DC_12: number;
  CS_H: number; CS_A: number;
  HO05: number; HO15: number; HO25: number;
  AO05: number; AO15: number; AO25: number;
}

export function deriveAllMarkets(mx: number[][]): Markets {
  const q = (c: QueryCondition[]) => queryMatrix(mx, c);
  const H = q([{type:"goal_diff",op:">",value:0}]);
  const D = q([{type:"goal_diff",op:"==",value:0}]);
  const A = q([{type:"goal_diff",op:"<",value:0}]);
  const O15 = q([{type:"total_goals",op:">",value:1.5}]);
  const O25 = q([{type:"total_goals",op:">",value:2.5}]);
  const O35 = q([{type:"total_goals",op:">",value:3.5}]);
  const O45 = q([{type:"total_goals",op:">",value:4.5}]);
  const O55 = q([{type:"total_goals",op:">",value:5.5}]);
  const BY = q([{type:"home_min",op:">=",value:1},{type:"away_min",op:">=",value:1}]);
  const CS_H = q([{type:"away_goals",op:"==",value:0}]);
  const CS_A = q([{type:"home_goals",op:"==",value:0}]);
  const HO05 = q([{type:"home_goals",op:">",value:0.5}]);
  const HO15 = q([{type:"home_goals",op:">",value:1.5}]);
  const HO25 = q([{type:"home_goals",op:">",value:2.5}]);
  const AO05 = q([{type:"away_goals",op:">",value:0.5}]);
  const AO15 = q([{type:"away_goals",op:">",value:1.5}]);
  const AO25 = q([{type:"away_goals",op:">",value:2.5}]);
  let bP = 0, bI = 0, bJ = 0;
  for (let i = 0; i < Math.min(7, mx.length); i++)
    for (let j = 0; j < Math.min(7, mx[0].length); j++)
      if (mx[i][j] > bP) { bP = mx[i][j]; bI = i; bJ = j; }
  return {
    H, D, A,
    O15, O25, O35, O45, O55,
    U15: 1-O15, U25: 1-O25, U35: 1-O35, U45: 1-O45, U55: 1-O55,
    BY, BN: 1-BY, best: `${bI}:${bJ}`, bestP: bP,
    DC_1X: H+D, DC_X2: D+A, DC_12: H+A,
    CS_H, CS_A, HO05, HO15, HO25, AO05, AO15, AO25,
  };
}

export function getCorrectScores(mx: number[][], topN = 10): {score:string;p:number}[] {
  const scores: {score:string;p:number}[] = [];
  for (let i = 0; i < Math.min(8, mx.length); i++)
    for (let j = 0; j < Math.min(8, mx[0].length); j++)
      scores.push({score:`${i}:${j}`, p:mx[i][j]});
  scores.sort((a,b) => b.p - a.p);
  return scores.slice(0, topN);
}

export function getWinningMargin(mx: number[][]): Record<string,number> {
  const q = (c: QueryCondition[]) => queryMatrix(mx, c);
  return {
    "H+1":q([{type:"goal_diff",op:"==",value:1}]),
    "H+2":q([{type:"goal_diff",op:"==",value:2}]),
    "H+3+":q([{type:"goal_diff",op:">=",value:3}]),
    "Unent.":q([{type:"goal_diff",op:"==",value:0}]),
    "A+1":q([{type:"goal_diff",op:"==",value:-1}]),
    "A+2":q([{type:"goal_diff",op:"==",value:-2}]),
    "A+3+":q([{type:"goal_diff",op:"<=",value:-3}]),
  };
}

export interface AHLine { P_Win:number; P_Push:number; P_Loss:number; Fair_Odds:number }

export function getAsianHandicap(mx: number[][], team:"H"|"A"="H"): Record<string,AHLine> {
  const result: Record<string,AHLine> = {};
  const sign = team === "H" ? 1 : -1;
  for (let hs = -7; hs <= 7; hs++) {
    const line = hs * 0.5;
    const isWhole = hs % 2 === 0;
    let pWin:number, pPush:number, pLoss:number;
    if (isWhole) {
      const adj = Math.round(line) * sign;
      pWin = queryMatrix(mx,[{type:"goal_diff",op:">",value:-adj}]);
      pPush = queryMatrix(mx,[{type:"goal_diff",op:"==",value:-adj}]);
      pLoss = queryMatrix(mx,[{type:"goal_diff",op:"<",value:-adj}]);
    } else {
      const threshold = -line * sign;
      pWin = queryMatrix(mx,[{type:"goal_diff",op:">",value:threshold}]);
      pPush = 0;
      pLoss = 1 - pWin;
    }
    const fairOdds = pWin > 1e-10 ? (1 - pPush) / pWin : 999;
    const label = `${line > 0 ? "+" : ""}${line}`;
    result[label] = {P_Win:pWin, P_Push:pPush, P_Loss:pLoss, Fair_Odds:Math.round(fairOdds*1000)/1000};
  }
  return result;
}

export function sameGameCombo(mx: number[][], conditions: QueryCondition[]): {P:number; fairOdds:number} {
  const p = queryMatrix(mx, conditions);
  return {P: p, fairOdds: p > 1e-10 ? Math.round(1/p*1000)/1000 : 999};
}

// ─── Tier 2: HT/FT, Both Halves, First Goal ────────────────────────

export function getHtFt(lamH: number, lamA: number, rho = RHO): Record<string,number> {
  const mxHT = buildMatrix(lamH*HT_FACTOR, lamA*HT_FACTOR, rho);
  const mxH2 = buildMatrix(lamH*(1-HT_FACTOR), lamA*(1-HT_FACTOR), rho);
  const n = MAX_GOALS;
  const res: Record<string,number> = {};
  for (const ht of ["H","D","A"]) {
    for (const ft of ["H","D","A"]) {
      let p = 0;
      for (let hi=0;hi<n;hi++) for (let hj=0;hj<n;hj++) {
        if (ht==="H"&&!(hi>hj)) continue;
        if (ht==="D"&&!(hi===hj)) continue;
        if (ht==="A"&&!(hi<hj)) continue;
        if (mxHT[hi][hj]<1e-12) continue;
        for (let h2i=0;h2i<n;h2i++) for (let h2j=0;h2j<n;h2j++) {
          const ftH=hi+h2i, ftA=hj+h2j;
          if (ft==="H"&&!(ftH>ftA)) continue;
          if (ft==="D"&&!(ftH===ftA)) continue;
          if (ft==="A"&&!(ftH<ftA)) continue;
          p += mxHT[hi][hj]*mxH2[h2i][h2j];
        }
      }
      res[`${ht}/${ft}`] = p;
    }
  }
  const total = Object.values(res).reduce((a,b)=>a+b,0);
  if (total > 0) for (const k of Object.keys(res)) res[k] /= total;
  return res;
}

export function getGoalBothHalves(lamH:number,lamA:number,rho=RHO):{yes:number;no:number} {
  const mxHT = buildMatrix(lamH*HT_FACTOR, lamA*HT_FACTOR, rho);
  const mxH2 = buildMatrix(lamH*(1-HT_FACTOR), lamA*(1-HT_FACTOR), rho);
  const yes = (1-mxHT[0][0]) * (1-mxH2[0][0]);
  return {yes, no: 1-yes};
}

export function getFirstGoalTime(lamH:number,lamA:number,minute:number):number {
  return 1 - Math.exp(-(lamH+lamA)/90*minute);
}

// ═══════════════════════════════════════════════════════════════════════
// HT STATE-DEPENDENT 2ND HALF MODEL
// Empirisch: 15.696 Spiele, 5 Ligen, 2017-2026
// λ der 2. HZ hängt vom HT-Stand ab (Aufmachen, Konter, Deadlock)
// ═══════════════════════════════════════════════════════════════════════

// Multiplier auf die Baseline-2H-Lambda pro Team
// mH = Multiplier für Heim-Tore in 2.HZ, mA = für Gast-Tore
const HT_STATE_MULTIPLIERS: Record<string, {mH:number; mA:number; n:number}> = {
  "0-0": { mH: 0.934, mA: 0.948, n: 4526 }, // Deadlock → weniger Tore
  "0-1": { mH: 1.005, mA: 1.036, n: 2541 }, // Heim muss reagieren
  "0-2": { mH: 0.972, mA: 1.269, n: 728  }, // Heim aufmachen, Gast kontert!
  "0-3": { mH: 0.859, mA: 1.264, n: 170  }, // Spiel gelaufen, Gast kontert
  "1-0": { mH: 0.996, mA: 0.997, n: 3160 }, // Baseline
  "1-1": { mH: 0.980, mA: 1.001, n: 1648 }, // Offen
  "1-2": { mH: 0.985, mA: 1.056, n: 479  }, // Heim leicht mehr
  "2-0": { mH: 1.187, mA: 0.911, n: 1093 }, // Heim riecht Blut! Gast bricht ein
  "2-1": { mH: 1.030, mA: 1.026, n: 525  }, // Offen, leicht erhöht
  "2-2": { mH: 1.190, mA: 1.017, n: 162  }, // Offenes Spiel, Heim stark
  "3-0": { mH: 1.319, mA: 0.779, n: 263  }, // Heim dominiert, Gast kollabiert
  "3-1": { mH: 1.275, mA: 0.907, n: 120  }, // Heim weiter dominant
};

// HT/FT conditional probabilities (empirisch, 15.696 Spiele)
const HTFT_CONDITIONALS: Record<string, {ftH:number; ftD:number; ftA:number}> = {
  "H": { ftH: 0.773, ftD: 0.158, ftA: 0.069 },
  "D": { ftH: 0.362, ftD: 0.364, ftA: 0.274 },
  "A": { ftH: 0.111, ftD: 0.200, ftA: 0.689 },
};

export function getHTStateMultiplier(htHome: number, htAway: number): {mH:number; mA:number; n:number; key:string} {
  const key = `${Math.min(htHome,3)}-${Math.min(htAway,3)}`;
  const entry = HT_STATE_MULTIPLIERS[key];
  if (entry) return { ...entry, key };
  // Fallback: extrapolate from goal diff pattern
  const diff = htHome - htAway;
  if (diff >= 3) return { mH: 1.30, mA: 0.80, n: 0, key };
  if (diff <= -3) return { mH: 0.86, mA: 1.26, n: 0, key };
  return { mH: 1.0, mA: 1.0, n: 0, key }; // True fallback
}

// ─── HT 1X2 Market ─────────────────────────────────────────────────

export interface HT1X2 { H: number; D: number; A: number }

export function getHT1X2(lamH: number, lamA: number, rho = RHO): HT1X2 {
  const mx = buildMatrix(lamH * HT_FACTOR, lamA * HT_FACTOR, rho);
  const H = queryMatrix(mx, [{type:"goal_diff",op:">",value:0}]);
  const D = queryMatrix(mx, [{type:"goal_diff",op:"==",value:0}]);
  const A = queryMatrix(mx, [{type:"goal_diff",op:"<",value:0}]);
  return { H, D, A };
}

export function getHTCorrectScores(lamH: number, lamA: number, rho = RHO, topN = 8): {score:string;p:number}[] {
  const mx = buildMatrix(lamH * HT_FACTOR, lamA * HT_FACTOR, rho);
  const scores: {score:string;p:number}[] = [];
  for (let i = 0; i < Math.min(5, mx.length); i++)
    for (let j = 0; j < Math.min(5, mx[0].length); j++)
      scores.push({score:`${i}:${j}`, p:mx[i][j]});
  scores.sort((a,b) => b.p - a.p);
  return scores.slice(0, topN);
}

// ─── 2nd Half Markets (state-dependent) ─────────────────────────────

export interface SecondHalfMarkets {
  // Lambdas
  lam2H: number;        // Adjusted home lambda for 2H
  lam2A: number;        // Adjusted away lambda for 2H
  multiplierH: number;  // Applied multiplier
  multiplierA: number;
  stateKey: string;     // HT score used
  // Markets
  H: number; D: number; A: number;  // 2H result
  O05: number; O15: number; O25: number; O35: number;
  U05: number; U15: number; U25: number; U35: number;
  BY: number; BN: number;  // BTTS in 2H
  HO05: number; AO05: number; // Team goals 2H
  HO15: number; AO15: number;
  // Comparison
  naiveLam2H: number;   // What Poisson would say without adjustment
  naiveLam2A: number;
  edgeVsNaive: Record<string, number>; // Δ between state-adjusted and naive
}

export function getSecondHalfMarkets(
  lamH: number, lamA: number,
  htHome: number, htAway: number,
  rho = RHO
): SecondHalfMarkets {
  // Baseline 2H lambda (naive: just remaining portion)
  const naiveLam2H = lamH * (1 - HT_FACTOR);
  const naiveLam2A = lamA * (1 - HT_FACTOR);

  // State-dependent adjustment
  const state = getHTStateMultiplier(htHome, htAway);
  const lam2H = naiveLam2H * state.mH;
  const lam2A = naiveLam2A * state.mA;

  // Build 2H matrix with adjusted lambdas
  const mx = buildMatrix(lam2H, lam2A, rho);
  const mxNaive = buildMatrix(naiveLam2H, naiveLam2A, rho);

  const q = (c: QueryCondition[]) => queryMatrix(mx, c);
  const qN = (c: QueryCondition[]) => queryMatrix(mxNaive, c);

  const H  = q([{type:"goal_diff",op:">",value:0}]);
  const D  = q([{type:"goal_diff",op:"==",value:0}]);
  const A  = q([{type:"goal_diff",op:"<",value:0}]);
  const O05 = q([{type:"total_goals",op:">",value:0.5}]);
  const O15 = q([{type:"total_goals",op:">",value:1.5}]);
  const O25 = q([{type:"total_goals",op:">",value:2.5}]);
  const O35 = q([{type:"total_goals",op:">",value:3.5}]);
  const BY  = q([{type:"home_min",op:">=",value:1},{type:"away_min",op:">=",value:1}]);
  const HO05 = q([{type:"home_goals",op:">",value:0.5}]);
  const AO05 = q([{type:"away_goals",op:">",value:0.5}]);
  const HO15 = q([{type:"home_goals",op:">",value:1.5}]);
  const AO15 = q([{type:"away_goals",op:">",value:1.5}]);

  // Naive comparison
  const edgeVsNaive: Record<string,number> = {
    "O05": O05 - qN([{type:"total_goals",op:">",value:0.5}]),
    "O15": O15 - qN([{type:"total_goals",op:">",value:1.5}]),
    "O25": O25 - qN([{type:"total_goals",op:">",value:2.5}]),
    "H": H - qN([{type:"goal_diff",op:">",value:0}]),
    "A": A - qN([{type:"goal_diff",op:"<",value:0}]),
    "BY": BY - qN([{type:"home_min",op:">=",value:1},{type:"away_min",op:">=",value:1}]),
  };

  return {
    lam2H, lam2A, multiplierH: state.mH, multiplierA: state.mA, stateKey: state.key,
    H, D, A,
    O05, O15, O25, O35,
    U05: 1-O05, U15: 1-O15, U25: 1-O25, U35: 1-O35,
    BY, BN: 1-BY, HO05, AO05, HO15, AO15,
    naiveLam2H, naiveLam2A, edgeVsNaive,
  };
}

// ─── Enhanced HT/FT with state-dependent 2H ────────────────────────

export function getHtFtEnhanced(
  lamH: number, lamA: number,
  rho = RHO
): { matrix: Record<string,number>; conditionals: Record<string, {ftH:number;ftD:number;ftA:number}>; } {
  // Model-based HT/FT (existing logic)
  const modelMatrix = getHtFt(lamH, lamA, rho);

  // Also return empirical conditionals for comparison
  return {
    matrix: modelMatrix,
    conditionals: HTFT_CONDITIONALS,
  };
}

// ─── Complete HT Analysis (combines everything) ─────────────────────

export interface HTAnalysis {
  // Pre-match HT predictions
  ht1x2: HT1X2;
  htScores: {score:string;p:number}[];
  htft: Record<string,number>;

  // Post-HT (live) analysis — only when htScore is provided
  secondHalf?: SecondHalfMarkets;
  ftGivenHT?: {ftH:number; ftD:number; ftA:number};
}

export function getCompleteHTAnalysis(
  lamH: number, lamA: number,
  htHome?: number, htAway?: number,
  rho = RHO,
): HTAnalysis {
  const ht1x2 = getHT1X2(lamH, lamA, rho);
  const htScores = getHTCorrectScores(lamH, lamA, rho);
  const htft = getHtFt(lamH, lamA, rho);

  const result: HTAnalysis = { ht1x2, htScores, htft };

  // If live HT score is provided, add 2H analysis
  if (htHome !== undefined && htAway !== undefined) {
    result.secondHalf = getSecondHalfMarkets(lamH, lamA, htHome, htAway, rho);

    // Empirical FT|HT conditional
    const htResult = htHome > htAway ? "H" : htHome === htAway ? "D" : "A";
    result.ftGivenHT = HTFT_CONDITIONALS[htResult];
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// xG VALIDATION
// ═══════════════════════════════════════════════════════════════════════

export interface XGWarning { level:"error"|"warning"|"info"; field:string; message:string }

export function validateXGData(
  homeXG:number, homeXGA:number, homeGames:number,
  awayXG:number, awayXGA:number, awayGames:number, leagueAvg:number
): XGWarning[] {
  const w: XGWarning[] = [];
  const hpg = homeXG/homeGames, apg = awayXG/awayGames;
  if (hpg > 3) w.push({level:"error",field:"xg_h8",message:`xG/Spiel Heim (${hpg.toFixed(2)}) unrealistisch. Summe statt Ø?`});
  if (apg > 3) w.push({level:"error",field:"xg_a8",message:`xG/Spiel Ausw. (${apg.toFixed(2)}) unrealistisch. Summe statt Ø?`});
  if (homeXG > 0 && homeXG < 0.5) w.push({level:"warning",field:"xg_h8",message:`xG Heim (${homeXG}) sehr niedrig. Ø statt Summe?`});
  if (awayXG > 0 && awayXG < 0.5) w.push({level:"warning",field:"xg_a8",message:`xG Ausw. (${awayXG}) sehr niedrig. Ø statt Summe?`});
  if (homeXG > 0 && Math.abs(homeXG - Math.round(homeXG)) < 0.01) w.push({level:"info",field:"xg_h8",message:`xG Heim (${homeXG}) verdächtig rund.`});
  if (awayXG > 0 && Math.abs(awayXG - Math.round(awayXG)) < 0.01) w.push({level:"info",field:"xg_a8",message:`xG Ausw. (${awayXG}) verdächtig rund.`});
  return w;
}

// ═══════════════════════════════════════════════════════════════════════
// VIG REMOVAL (Shin's + Proportional)
// ═══════════════════════════════════════════════════════════════════════

export function vigAdjust(quotes:number[]):{probs:number[];overround:number} {
  const raw = quotes.map(q=>1/q);
  const t = raw.reduce((a,b)=>a+b,0);
  return {probs: raw.map(r=>r/t), overround: t-1};
}

export function vigAdjustShin(quotes:number[]):{probs:number[];overround:number;z:number} {
  const raw = quotes.map(q=>1/q);
  const S = raw.reduce((a,b)=>a+b,0);
  if (S < 1.005) return {probs:raw, overround:S-1, z:0};
  let zLo=0, zHi=0.5;
  for (let it=0;it<50;it++) {
    const z=(zLo+zHi)/2, t=2*(1-z);
    let ps=0;
    for (const r of raw) ps += (Math.sqrt(z*z+4*(1-z)*(r*r)/S)-z)/t;
    if (ps>1) zLo=z; else zHi=z;
  }
  const z=(zLo+zHi)/2, t=2*(1-z);
  const probs = raw.map(r=>(Math.sqrt(z*z+4*(1-z)*(r*r)/S)-z)/t);
  return {probs, overround:S-1, z};
}

export function vigAdjustBest(quotes:number[]):{probs:number[];overround:number;method:string} {
  const s = vigAdjustShin(quotes);
  return {probs:s.probs, overround:s.overround, method:"Shin"};
}

export function vigAdjustPower(quotes:number[]):{probs:number[];overround:number;k:number} {
  const raw = quotes.map(q=>1/q);
  const t = raw.reduce((a,b)=>a+b,0);
  if (t < 1.005) return {probs:raw, overround:t-1, k:1};
  let lo=0.5, hi=1.5;
  for (let i=0;i<50;i++) { const m=(lo+hi)/2; const s=raw.reduce((s,r)=>s+Math.pow(r,m),0); if(s>1)lo=m;else hi=m; }
  const k=(lo+hi)/2;
  const p=raw.map(r=>Math.pow(r,k));
  const pT=p.reduce((a,b)=>a+b,0);
  return {probs:p.map(v=>v/pT), overround:t-1, k};
}

// ═══════════════════════════════════════════════════════════════════════
// KELLY + BAYESIAN REGRESSION + FORM + TAGS
// ═══════════════════════════════════════════════════════════════════════

export function kellyFraction(pEigen:number, quote:number, fraction=0.33):number {
  if (quote<=1) return 0;
  const k = (pEigen*quote-1)/(quote-1);
  return Math.max(0, Math.min(k*fraction, 0.05));
}

const PRIOR_K = 6;

// ═══════════════════════════════════════════════════════════════════════
// TIME-DECAY (EWMA) — Dixon & Coles (1997) exponential weighting
// φ(t) = exp(-ξ × t)  where t = weeks since match
// ξ = 0.025 → half-weight after ~28 weeks, recent matches ~3× more weight
// ═══════════════════════════════════════════════════════════════════════
const DECAY_XI = 0.025; // Dixon-Coles decay parameter (per week)

export interface XGHistoryEntry {
  xg: number; xga: number; date?: string; weeks_ago?: number;
}

/**
 * Calculate time-weighted xG per game using EWMA.
 * If no history available, falls back to simple sum/games.
 */
export function ewmaXGPerGame(
  history: XGHistoryEntry[] | undefined,
  fallbackSum: number, fallbackGames: number,
  xi = DECAY_XI
): { xgPg: number; xgaPg: number; effectiveN: number } {
  if (!history || history.length === 0) {
    const xgPg = fallbackGames > 0 ? fallbackSum / fallbackGames : 1.3;
    return { xgPg, xgaPg: xgPg, effectiveN: fallbackGames };
  }
  let wXG = 0, wXGA = 0, wSum = 0;
  const now = Date.now();
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    // weeks_ago can be pre-calculated or derived from date
    let weeksAgo = entry.weeks_ago ?? (
      entry.date ? (now - new Date(entry.date).getTime()) / (7 * 24 * 3600 * 1000) : (history.length - 1 - i) * 2
    );
    const weight = Math.exp(-xi * weeksAgo);
    wXG += entry.xg * weight;
    wXGA += entry.xga * weight;
    wSum += weight;
  }
  return {
    xgPg: wSum > 0 ? wXG / wSum : fallbackSum / fallbackGames,
    xgaPg: wSum > 0 ? wXGA / wSum : 0,
    effectiveN: wSum, // sum of weights (< n for old data, ≈ n for recent)
  };
}

export function bayesianShrinkage(obs:number, avg:number, n:number):{adjusted:number;shrinkage:number} {
  const s = n/(n+PRIOR_K);
  return {adjusted: avg+s*(obs-avg), shrinkage: s};
}

export function formMultiplier(formString:string|undefined):{mult:number;label:string} {
  // ══════════════════════════════════════════════════════════════════
  // DISABLED: W/D/L-based form adjustment contradicts xG philosophy.
  //
  // Gemini DeepMind review (March 2026): Using results-based form
  // (W/D/L) undoes the exact edge that xG finds. A team dominating
  // xG 3.0:0.5 but drawing 3× gets punished by the market AND by
  // this multiplier — destroying the value signal.
  //
  // The xG data already captures true team strength through Bayesian
  // regression. W/D/L form on top is double-counting market noise.
  //
  // TODO: Replace with xG-trend form when per-match xG is available
  // (ratio of last-3-match xG to season-avg xG).
  // ══════════════════════════════════════════════════════════════════
  return { mult: 1.0, label: "—" };
}

export interface TagCorrection {tag:string;lambdaH_mult:number;lambdaA_mult:number;reason:string}

const TAG_MAP:Record<string,{lH:number;lA:number;reason:string}> = {
  "DERBY":{lH:1.05,lA:1.05,reason:"Derby: offeneres Spiel +5%"},
  "ROTATION":{lH:0.82,lA:1.00,reason:"Rotation: −18%"},
  "ROTATION-ERWARTET":{lH:0.82,lA:1.00,reason:"Rotation erwartet: −18%"},
  "SANDWICH":{lH:0.90,lA:1.00,reason:"Sandwich: λH −10%"},
  "NEUER-TRAINER":{lH:1.08,lA:1.00,reason:"Neuer Trainer: +8%"},
  "TRAINER-UNTER-DRUCK":{lH:0.95,lA:1.00,reason:"Trainer unter Druck: −5%"},
  "ABSTIEGSKAMPF":{lH:1.06,lA:1.06,reason:"Abstiegskampf: +6%"},
  "MEISTERKAMPF":{lH:1.03,lA:1.03,reason:"Meisterkampf: +3%"},
  "GEISTERSPIEL":{lH:0.88,lA:1.12,reason:"Geisterspiel: Heimvorteil weg"},
  "POKAL":{lH:1.00,lA:1.05,reason:"Pokal: Underdogs +5%"},
};

export function applyTagCorrections(tags:string[]):{corrections:TagCorrection[];multH:number;multA:number} {
  if (!tags?.length) return {corrections:[],multH:1,multA:1};
  const corrs:TagCorrection[]=[]; let mH=1,mA=1,n=0;
  for (const tag of tags) {
    const c = TAG_MAP[tag.toUpperCase().replace(/\s+/g,"-")] || TAG_MAP[tag];
    if (c && n<3) { corrs.push({tag,lambdaH_mult:c.lH,lambdaA_mult:c.lA,reason:c.reason}); mH*=c.lH; mA*=c.lA; n++; }
  }
  return {corrections:corrs, multH:Math.round(mH*1000)/1000, multA:Math.round(mA*1000)/1000};
}

// ═══════════════════════════════════════════════════════════════════════
// CONFIDENCE INTERVALS
// ═══════════════════════════════════════════════════════════════════════

export interface ConfidenceInterval {low:number;mid:number;high:number;se:number}

function lambdaCI(lambda:number,nGames:number):ConfidenceInterval {
  const se=lambda*0.45/Math.sqrt(nGames), z=1.645;
  return {low:Math.max(0.1,lambda-z*se), mid:lambda, high:lambda+z*se, se};
}

// ═══════════════════════════════════════════════════════════════════════
// ENHANCED MATCH CALCULATION (backward compatible)
// ═══════════════════════════════════════════════════════════════════════

export interface EnhancedResult {
  lambdaH_raw:number; lambdaA_raw:number;
  lambdaH_regressed:number; lambdaA_regressed:number;
  lambdaH_formed:number; lambdaA_formed:number;
  lambdaH:number; lambdaA:number;
  shrinkageH:number; shrinkageA:number;
  formH:{mult:number;label:string}; formA:{mult:number;label:string};
  tagCorrections:TagCorrection[]; tagMultH:number; tagMultA:number;
  ciH:ConfidenceInterval; ciA:ConfidenceInterval;
  matrix:number[][]; mk:Markets; mk_low:Markets; mk_high:Markets;
}

export function calcMatchEnhanced(
  xgHS:number,xgaHC:number,hGames:number,formH:string|undefined,
  xgAS:number,xgaAC:number,aGames:number,formA:string|undefined,
  leagueAvg:number,homeFactor:number,tags:string[],
  hHistory?:XGHistoryEntry[],aHistory?:XGHistoryEntry[]
):EnhancedResult {
  // Guard against division by zero
  if (hGames <= 0 || aGames <= 0) {
    const lambdaH = leagueAvg * homeFactor;
    const lambdaA = leagueAvg;
    const matrix = buildMatrix(lambdaH, lambdaA);
    const mk = deriveAllMarkets(matrix);
    const ciH = lambdaCI(lambdaH, 1), ciA = lambdaCI(lambdaA, 1);
    return {
      lambdaH_raw: lambdaH, lambdaA_raw: lambdaA,
      lambdaH_regressed: lambdaH, lambdaA_regressed: lambdaA,
      lambdaH_formed: lambdaH, lambdaA_formed: lambdaA,
      lambdaH, lambdaA,
      shrinkageH: 0, shrinkageA: 0,
      formH: { mult: 1, label: "—" }, formA: { mult: 1, label: "—" },
      tagCorrections: [], tagMultH: 1, tagMultA: 1,
      ciH, ciA, matrix, mk, mk_low: mk, mk_high: mk,
    };
  }

  // Use EWMA time-decay when per-match history is available (Dixon-Coles 1997)
  // Guard: empty arrays are truthy in JS — must check .length
  const hHasHistory = hHistory && hHistory.length > 0;
  const aHasHistory = aHistory && aHistory.length > 0;
  const hEwma = ewmaXGPerGame(hHistory, xgHS, hGames);
  const aEwma = ewmaXGPerGame(aHistory, xgAS, aGames);
  const hXGpg = hHasHistory ? hEwma.xgPg : xgHS/hGames;
  const hXGApg = hHasHistory ? hEwma.xgaPg : xgaHC/hGames;
  const aXGpg = aHasHistory ? aEwma.xgPg : xgAS/aGames;
  const aXGApg = aHasHistory ? aEwma.xgaPg : xgaAC/aGames;
  const atkH_sh=bayesianShrinkage(hXGpg,leagueAvg,hGames);
  const defH_sh=bayesianShrinkage(hXGApg,leagueAvg,hGames);
  const atkA_sh=bayesianShrinkage(aXGpg,leagueAvg,aGames);
  const defA_sh=bayesianShrinkage(aXGApg,leagueAvg,aGames);
  const lambdaH_raw = leagueAvg*(hXGpg/leagueAvg)*(aXGApg/leagueAvg)*homeFactor;
  const lambdaA_raw = leagueAvg*(aXGpg/leagueAvg)*(hXGApg/leagueAvg);
  const lambdaH_reg = leagueAvg*(atkH_sh.adjusted/leagueAvg)*(defA_sh.adjusted/leagueAvg)*homeFactor;
  const lambdaA_reg = leagueAvg*(atkA_sh.adjusted/leagueAvg)*(defH_sh.adjusted/leagueAvg);
  const fH=formMultiplier(formH), fA=formMultiplier(formA);
  const lambdaH_form=lambdaH_reg*fH.mult, lambdaA_form=lambdaA_reg*fA.mult;
  const tagR=applyTagCorrections(tags||[]);
  const lambdaH=lambdaH_form*tagR.multH, lambdaA=lambdaA_form*tagR.multA;
  const matrix=buildMatrix(lambdaH,lambdaA);
  const mk=deriveAllMarkets(matrix);
  const ciH=lambdaCI(lambdaH,hGames), ciA=lambdaCI(lambdaA,aGames);
  const mk_low=deriveAllMarkets(buildMatrix(ciH.low,ciA.high));
  const mk_high=deriveAllMarkets(buildMatrix(ciH.high,ciA.low));
  return {
    lambdaH_raw,lambdaA_raw,lambdaH_regressed:lambdaH_reg,lambdaA_regressed:lambdaA_reg,
    lambdaH_formed:lambdaH_form,lambdaA_formed:lambdaA_form,lambdaH,lambdaA,
    shrinkageH:atkH_sh.shrinkage,shrinkageA:atkA_sh.shrinkage,formH:fH,formA:fA,
    tagCorrections:tagR.corrections,tagMultH:tagR.multH,tagMultA:tagR.multA,
    ciH,ciA,matrix,mk,mk_low,mk_high,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// BET CALCULATION (backward compatible)
// ═══════════════════════════════════════════════════════════════════════

export interface BetCalc {
  label:string;pModel:number;pMarket:number;quote:number;
  edge:number;ev:number;kelly:number;isValue:boolean;
}

export interface EnhancedBetCalc extends BetCalc {
  pModel_low:number;pModel_high:number;edge_low:number;edge_high:number;
  edgeSignificant:boolean;confidence:"HIGH"|"MEDIUM"|"LOW"|"NONE";
}

export function calculateBetsEnhanced(
  mk:Markets,mk_low:Markets,mk_high:Markets,
  odds:Record<string,number>,fraction:number
):EnhancedBetCalc[] {
  const has1X2=odds.h>0&&odds.d>0&&odds.a>0;
  const vig=has1X2?vigAdjustBest([odds.h,odds.d,odds.a]):null;

  // ── Isotonic Calibration (if curves are loaded) ──
  // Calibrate H/D/A independently, then renormalize to sum=1.0
  // This prevents false edges from overconfidence (Gemini review, March 2026)
  const cal = calibrate1X2(mk.H, mk.D, mk.A);
  const calO25 = calibrateOU25(mk.O25);

  // Also calibrate CI bounds for consistent confidence assessment
  const calLow = calibrate1X2(mk_low.H, mk_low.D, mk_low.A);
  const calHigh = calibrate1X2(mk_high.H, mk_high.D, mk_high.A);

  // Map: raw model values for display, calibrated for edge/kelly
  const calMap: Record<string, number> = {
    H: cal.H, D: cal.D, A: cal.A,
    O25: calO25.O25, U25: calO25.U25,
    BY: mk.BY, // No calibration curve yet for BTTS
  };

  const map:{key:keyof Markets;label:string;oddsKey:string;vigIdx:number|null}[] = [
    {key:"H",label:"Heim",oddsKey:"h",vigIdx:0},{key:"D",label:"Unent.",oddsKey:"d",vigIdx:1},
    {key:"A",label:"Ausw.",oddsKey:"a",vigIdx:2},{key:"O25",label:"Ü2.5",oddsKey:"o25",vigIdx:null},
    {key:"U25",label:"U2.5",oddsKey:"u25",vigIdx:null},{key:"BY",label:"BTTS",oddsKey:"btts",vigIdx:null},
  ];
  return map.filter(m=>odds[m.oddsKey]>0).map(m=>{
    const q=odds[m.oddsKey];
    const pModel = calMap[m.key] ?? (mk[m.key] as number); // Calibrated P for edge/kelly
    const pMarket=(vig&&m.vigIdx!==null)?vig.probs[m.vigIdx]:1/q;
    const edge=pModel-pMarket, ev=pModel*q-1, k=kellyFraction(pModel,q,fraction);
    let pLow:number,pHigh:number;
    if(m.key==="H"){pLow=calLow.H;pHigh=calHigh.H;}
    else if(m.key==="D"){pLow=Math.min(calLow.D,calHigh.D);pHigh=Math.max(calLow.D,calHigh.D);}
    else if(m.key==="A"){pLow=calHigh.A;pHigh=calLow.A;}
    else{pLow=Math.min(mk_low[m.key] as number,mk_high[m.key] as number);pHigh=Math.max(mk_low[m.key] as number,mk_high[m.key] as number);}
    const eLow=pLow-pMarket, eHigh=pHigh-pMarket, sig=eLow>0;
    let conf:"HIGH"|"MEDIUM"|"LOW"|"NONE";
    if(sig&&edge>0.05)conf="HIGH";else if(sig)conf="MEDIUM";else if(edge>0)conf="LOW";else conf="NONE";
    return {label:m.label,pModel,pMarket,quote:q,edge,ev,kelly:k,isValue:edge>=0.03&&ev>0,pModel_low:pLow,pModel_high:pHigh,edge_low:eLow,edge_high:eHigh,edgeSignificant:sig,confidence:conf};
  }).sort((a,b)=>b.edge-a.edge);
}

// ═══════════════════════════════════════════════════════════════════════
// LINE MOVEMENT + BACKWARD-COMPATIBLE WRAPPERS
// ═══════════════════════════════════════════════════════════════════════

export function analyzeLineMovement(history:any[]):Record<string,any>|null {
  if (!history||history.length<2) return null;
  const first=history[0].odds, last=history[history.length-1].odds;
  const keys:Record<string,string>={h:"Heim",d:"Unent.",a:"Ausw.",o25:"Ü2.5",u25:"U2.5",btts:"BTTS"};
  const moves:Record<string,any>={};
  for (const [k,label] of Object.entries(keys)) {
    const f=parseFloat(first[k]),l=parseFloat(last[k]);
    if (f>0&&l>0&&Math.abs(f-l)>=0.03) moves[k]={label,from:f,to:l,dir:l<f?"↓":"↑",pct:(((l-f)/f)*100).toFixed(1),smart:l<f?"Geld drauf":"Geld weg"};
  }
  return Object.keys(moves).length>0?moves:null;
}

export function dixonColesMatrix(lH:number,lA:number,rho=RHO):number[][] { return buildMatrix(lH,lA,rho); }
export function deriveMarkets(mx:number[][]):Markets { return deriveAllMarkets(mx); }

export function calcLambdas(
  xgHS:number,xgaHC:number,xgAS:number,xgaAC:number,
  hG:number,aG:number,avg:number,hf:number
):{lambdaH:number;lambdaA:number} {
  return {
    lambdaH: avg*(xgHS/hG/avg)*(xgaAC/aG/avg)*hf,
    lambdaA: avg*(xgAS/aG/avg)*(xgaHC/hG/avg),
  };
}

export function calculateBets(mk:Markets,odds:Record<string,number>,frac:number):BetCalc[] {
  const has1X2=odds.h>0&&odds.d>0&&odds.a>0;
  const vig=has1X2?vigAdjustBest([odds.h,odds.d,odds.a]):null;
  const map=[
    {key:"H" as keyof Markets,label:"Heim",oddsKey:"h",vigIdx:0 as number|null},
    {key:"D" as keyof Markets,label:"Unent.",oddsKey:"d",vigIdx:1 as number|null},
    {key:"A" as keyof Markets,label:"Ausw.",oddsKey:"a",vigIdx:2 as number|null},
    {key:"O25" as keyof Markets,label:"Ü2.5",oddsKey:"o25",vigIdx:null as number|null},
    {key:"U25" as keyof Markets,label:"U2.5",oddsKey:"u25",vigIdx:null as number|null},
    {key:"BY" as keyof Markets,label:"BTTS",oddsKey:"btts",vigIdx:null as number|null},
  ];
  return map.filter(m=>odds[m.oddsKey]>0).map(m=>{
    const q=odds[m.oddsKey],pM=mk[m.key] as number;
    const pMkt=(vig&&m.vigIdx!==null)?vig.probs[m.vigIdx]:1/q;
    const edge=pM-pMkt,ev=pM*q-1,k=kellyFraction(pM,q,frac);
    return {label:m.label,pModel:pM,pMarket:pMkt,quote:q,edge,ev,kelly:k,isValue:edge>=0.03&&ev>0};
  }).sort((a,b)=>b.edge-a.edge);
}

// Re-export calibration controls for the app
export { loadCalibrationCurves, isCalibrationActive } from "./calibration";

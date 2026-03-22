// ═══════════════════════════════════════════════════════════════════════
// FODZE Bet Evaluator — Unified Rating System
// Bewertet Einzel- und Kombiwetten mit einem konsistenten System.
// Verbindet queryMatrix (exakte Joint-P) mit dem Kombi-Builder.
// Ermöglicht "Force Bet" mit transparenter Risiko-Anzeige.
// ═══════════════════════════════════════════════════════════════════════

import { queryMatrix, type QueryCondition, buildMatrix, sameGameCombo } from "./dixon-coles";
import { calibrate1X2, calibrateOU25, calibrateProb } from "./calibration";

// ─── Types ──────────────────────────────────────────────────────────

export type BetGrade = "A" | "B" | "C" | "D" | "F";

export interface BetEvaluation {
  // Core metrics
  pModel: number;         // Calibrated probability
  pModelRaw: number;      // Raw (uncalibrated) probability
  pMarket: number;        // Implied market probability (1/quote)
  quote: number;          // Bookmaker decimal odds
  edge: number;           // pModel - pMarket
  ev: number;             // pModel × quote - 1
  kelly: number;          // Recommended stake (fraction of bankroll)

  // Rating
  grade: BetGrade;        // A/B/C/D/F
  score: number;          // 0-100 numeric score
  label: string;          // Human readable: "Starker Value" / "Kein Value"
  color: string;          // UI color code

  // Transparency
  expectedProfit: number; // Per €1 staked
  expectedLoss: number;   // Per €1 staked (positive number if -EV)
  breakEvenQuote: number; // Minimum quote needed for EV=0
  marginPaid: number;     // How much margin you're paying (%)

  // Force-Bet info (always calculated, shown when forcing)
  forceWarning: string;   // Warning text if bet is forced
  costPer100: number;     // Expected cost per €100 staked
}

export interface ComboEvaluation extends BetEvaluation {
  legs: ComboLegEval[];
  comboType: "same-game" | "cross-match" | "mixed";
  correlationEffect: number; // Exact P - naive P
  naiveP: number;            // Product of individual Ps
  exactP: number | null;     // From queryMatrix (same-game only)
}

export interface ComboLegEval {
  label: string;
  pModel: number;
  quote: number;
  evMultiplier: number;   // pModel × quote (>1 = adds value)
  impact: "BOOST" | "FAIR" | "DAMAGE" | "DESTROY";
}

// ─── Single Bet Evaluator ───────────────────────────────────────────

export function evaluateBet(
  pModelCalibrated: number,
  pModelRaw: number,
  quote: number,
  kellyFrac: number = 0.25,
): BetEvaluation {
  const pMarket = 1 / quote;
  const edge = pModelCalibrated - pMarket;
  const ev = pModelCalibrated * quote - 1;
  const breakEvenQuote = pModelCalibrated > 0 ? 1 / pModelCalibrated : 999;
  const marginPaid = pMarket > pModelCalibrated ? (pMarket - pModelCalibrated) / pMarket : 0;

  // Kelly (capped at 5%)
  let kelly = 0;
  if (ev > 0 && quote > 1) {
    kelly = Math.max(0, Math.min((pModelCalibrated * quote - 1) / (quote - 1) * kellyFrac, 0.05));
  }

  // Score (0-100)
  let score: number;
  if (edge >= 0.08) score = 90 + Math.min(edge * 100, 10);
  else if (edge >= 0.05) score = 75 + (edge - 0.05) * 500;
  else if (edge >= 0.03) score = 60 + (edge - 0.03) * 750;
  else if (edge >= 0.01) score = 40 + (edge - 0.01) * 1000;
  else if (edge >= 0) score = 20 + edge * 2000;
  else if (edge >= -0.03) score = 10 + (edge + 0.03) * 333;
  else score = Math.max(0, 10 + edge * 100);

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Grade
  let grade: BetGrade;
  if (score >= 75) grade = "A";
  else if (score >= 55) grade = "B";
  else if (score >= 35) grade = "C";
  else if (score >= 15) grade = "D";
  else grade = "F";

  // Label + Color
  const labels: Record<BetGrade, { label: string; color: string }> = {
    A: { label: "Starker Value", color: "#22a355" },
    B: { label: "Value", color: "#6aad55" },
    C: { label: "Marginal", color: "#d4b86a" },
    D: { label: "Kein Value", color: "#c47070" },
    F: { label: "Negativ EV", color: "#dc3545" },
  };

  const expectedProfit = ev;
  const expectedLoss = ev < 0 ? -ev : 0;
  const costPer100 = ev < 0 ? -ev * 100 : 0;

  let forceWarning = "";
  if (grade === "D") {
    forceWarning = `Erwarteter Verlust: €${costPer100.toFixed(1)} pro €100 Einsatz. Edge ${(edge*100).toFixed(1)}% ist unter dem 3%-Threshold.`;
  } else if (grade === "F") {
    forceWarning = `WARNUNG: Negativer EV (${(ev*100).toFixed(1)}%). Du verlierst im Schnitt €${costPer100.toFixed(0)} pro €100. Bräuchtest mindestens @${breakEvenQuote.toFixed(2)} für Break-Even.`;
  }

  return {
    pModel: pModelCalibrated, pModelRaw, pMarket, quote, edge, ev, kelly,
    grade, score, label: labels[grade].label, color: labels[grade].color,
    expectedProfit, expectedLoss, breakEvenQuote, marginPaid,
    forceWarning, costPer100,
  };
}

// ─── Same-Game Combo Evaluator (uses exact Matrix P) ────────────────

export interface SGCCondition {
  label: string;           // "BTTS Ja", "Ü2.5", "Heim"
  conditions: QueryCondition[];
  individualP?: number;    // Optional: pre-calculated individual P
  quote?: number;          // Optional: individual quote for this leg
}

export function evaluateSameGameCombo(
  matrix: number[][],
  legs: SGCCondition[],
  comboQuote: number,
  lamH?: number,
  lamA?: number,
): ComboEvaluation {
  // Exact joint P from the matrix (the power of our system)
  const allConditions = legs.flatMap(l => l.conditions);
  const exactP = queryMatrix(matrix, allConditions);

  // Naive P (product of individual Ps)
  const naiveP = legs.reduce((p, leg) => {
    const indivP = leg.individualP ?? queryMatrix(matrix, leg.conditions);
    return p * indivP;
  }, 1);

  // Calibration approximation for the joint P
  // Use ratio method: if calibration reduces H by 20%, reduce joint P by similar factor
  // This is approximate but better than no calibration
  let calibratedP = exactP;
  // TODO: Proper joint calibration when curves for combos are trained
  // For now, apply a conservative overconfidence correction
  // based on the average single-market correction
  if (exactP > 0.05 && exactP < 0.95) {
    // Approximate correction: the same overconfidence factor that affects singles
    // affects combos. Correction is stronger for higher P (more overconfident)
    const overconfidenceFactor = 0.82 + 0.18 * (1 - exactP); // ~0.82 at P=1, ~1.0 at P=0
    calibratedP = exactP * overconfidenceFactor;
  }

  const correlationEffect = exactP - naiveP;

  // Evaluate the combo as a single bet
  const baseEval = evaluateBet(calibratedP, exactP, comboQuote);

  // Per-leg analysis
  const legEvals: ComboLegEval[] = legs.map(leg => {
    const indivP = leg.individualP ?? queryMatrix(matrix, leg.conditions);
    const legQuote = leg.quote ?? (1 / indivP);
    const evMult = indivP * legQuote;
    let impact: ComboLegEval["impact"];
    if (evMult >= 1.05) impact = "BOOST";
    else if (evMult >= 0.98) impact = "FAIR";
    else if (evMult >= 0.93) impact = "DAMAGE";
    else impact = "DESTROY";

    return { label: leg.label, pModel: indivP, quote: legQuote, evMultiplier: evMult, impact };
  });

  return {
    ...baseEval,
    pModel: calibratedP,
    pModelRaw: exactP,
    legs: legEvals,
    comboType: "same-game",
    correlationEffect,
    naiveP,
    exactP,
  };
}

// ─── Cross-Match Combo Evaluator ────────────────────────────────────

export interface CrossMatchLeg {
  label: string;
  match: string;
  pModel: number;        // Calibrated single-bet P
  quote: number;
}

export function evaluateCrossMatchCombo(
  legs: CrossMatchLeg[],
  comboQuote?: number,    // If provided, use this. Otherwise calculate from legs.
): ComboEvaluation {
  const naiveP = legs.reduce((p, l) => p * l.pModel, 1);
  const naiveQuote = legs.reduce((q, l) => q * l.quote, 1);
  const actualQuote = comboQuote ?? naiveQuote;

  const baseEval = evaluateBet(naiveP, naiveP, actualQuote);

  const legEvals: ComboLegEval[] = legs.map(l => {
    const evMult = l.pModel * l.quote;
    let impact: ComboLegEval["impact"];
    if (evMult >= 1.05) impact = "BOOST";
    else if (evMult >= 0.98) impact = "FAIR";
    else if (evMult >= 0.93) impact = "DAMAGE";
    else impact = "DESTROY";
    return { label: `${l.label} (${l.match})`, pModel: l.pModel, quote: l.quote, evMultiplier: evMult, impact };
  });

  return {
    ...baseEval,
    legs: legEvals,
    comboType: "cross-match",
    correlationEffect: 0,
    naiveP,
    exactP: null,
  };
}

// ─── Predefined Same-Game Conditions ────────────────────────────────
// Makes it easy for the UI to offer common combos

export const SGC_PRESETS: Record<string, (team?: "H" | "A") => QueryCondition[]> = {
  "home_win": () => [{ type: "goal_diff", op: ">", value: 0 }],
  "draw": () => [{ type: "goal_diff", op: "==", value: 0 }],
  "away_win": () => [{ type: "goal_diff", op: "<", value: 0 }],
  "over_1.5": () => [{ type: "total_goals", op: ">", value: 1.5 }],
  "over_2.5": () => [{ type: "total_goals", op: ">", value: 2.5 }],
  "over_3.5": () => [{ type: "total_goals", op: ">", value: 3.5 }],
  "under_2.5": () => [{ type: "total_goals", op: "<", value: 2.5 }],
  "under_3.5": () => [{ type: "total_goals", op: "<", value: 3.5 }],
  "btts_yes": () => [{ type: "home_min", op: ">=", value: 1 }, { type: "away_min", op: ">=", value: 1 }],
  "btts_no": () => [{ type: "home_goals", op: "==", value: 0 }], // Simplified: at least one team scores 0
  "home_over_0.5": () => [{ type: "home_goals", op: ">", value: 0.5 }],
  "home_over_1.5": () => [{ type: "home_goals", op: ">", value: 1.5 }],
  "away_over_0.5": () => [{ type: "away_goals", op: ">", value: 0.5 }],
  "away_over_1.5": () => [{ type: "away_goals", op: ">", value: 1.5 }],
  "dc_1x": () => [{ type: "goal_diff", op: ">=", value: 0 }],
  "dc_x2": () => [{ type: "goal_diff", op: "<=", value: 0 }],
};

export const SGC_LABELS: Record<string, string> = {
  "home_win": "Heim", "draw": "Unent.", "away_win": "Auswärts",
  "over_1.5": "Ü1.5", "over_2.5": "Ü2.5", "over_3.5": "Ü3.5",
  "under_2.5": "U2.5", "under_3.5": "U3.5",
  "btts_yes": "BTTS Ja", "btts_no": "BTTS Nein",
  "home_over_0.5": "H Ü0.5", "home_over_1.5": "H Ü1.5",
  "away_over_0.5": "A Ü0.5", "away_over_1.5": "A Ü1.5",
  "dc_1x": "DC 1X", "dc_x2": "DC X2",
};

// ─── Quick Combo Builder ────────────────────────────────────────────
// For the UI: User picks presets, enters quote, gets instant evaluation

export function quickComboEval(
  matrix: number[][],
  presetKeys: string[],
  comboQuote: number,
): ComboEvaluation {
  const legs: SGCCondition[] = presetKeys.map(key => {
    const condFn = SGC_PRESETS[key];
    if (!condFn) throw new Error(`Unknown preset: ${key}`);
    return {
      label: SGC_LABELS[key] || key,
      conditions: condFn(),
    };
  });

  return evaluateSameGameCombo(matrix, legs, comboQuote);
}

// ─── Force Bet Display ──────────────────────────────────────────────
// Shows what happens when you override the system

export function forceBetInfo(evaluation: BetEvaluation, stake: number): {
  expectedReturn: number;
  expectedProfit: number;
  expectedLoss: number;
  winReturn: number;
  winProbability: number;
  lossReturn: number;
  lossProbability: number;
  breakEvenWinRate: number;
  warningLevel: "info" | "caution" | "danger";
  message: string;
} {
  const { pModel, quote, ev, edge, grade } = evaluation;
  const expectedReturn = stake * (1 + ev);
  const expectedProfit = stake * ev;
  const winReturn = stake * quote;
  const lossReturn = 0;
  const breakEvenWinRate = 1 / quote;

  let warningLevel: "info" | "caution" | "danger";
  let message: string;

  if (grade === "A" || grade === "B") {
    warningLevel = "info";
    message = `Value-Bet bestätigt. Erwarteter Gewinn: €${expectedProfit.toFixed(2)} bei €${stake.toFixed(0)} Einsatz.`;
  } else if (grade === "C") {
    warningLevel = "caution";
    message = `Marginaler Edge (${(edge*100).toFixed(1)}%). Langfristig knapp über Break-Even. Erwarteter Gewinn: €${expectedProfit.toFixed(2)}.`;
  } else if (grade === "D") {
    warningLevel = "caution";
    message = `Kein mathematischer Edge. Erwarteter Verlust: €${(-expectedProfit).toFixed(2)} pro €${stake.toFixed(0)} Einsatz. Du zahlst ${(evaluation.marginPaid*100).toFixed(1)}% Marge an den Buchmacher.`;
  } else {
    warningLevel = "danger";
    message = `Negativer EV (${(ev*100).toFixed(1)}%). Bei 100 solchen Wetten à €${stake.toFixed(0)} verlierst du ca. €${(-expectedProfit*100).toFixed(0)}. Bräuchtest @${evaluation.breakEvenQuote.toFixed(2)} statt @${quote.toFixed(2)}.`;
  }

  return {
    expectedReturn, expectedProfit,
    expectedLoss: ev < 0 ? -expectedProfit : 0,
    winReturn, winProbability: pModel,
    lossReturn, lossProbability: 1 - pModel,
    breakEvenWinRate, warningLevel, message,
  };
}

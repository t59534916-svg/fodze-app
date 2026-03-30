// ─── FODZE System & Kombiwetten-Rechner ──────────────────────────
// Agnostisch: Jeder Leg erlaubt. Zeigt Auswirkung auf EV brutal ehrlich.

export interface ComboLeg {
  id: string;
  label: string;           // z.B. "Atletico Sieg"
  match: string;           // z.B. "Tottenham — Atletico"
  pModel: number;          // Modell-Wahrscheinlichkeit (0-1)
  quote: number;           // Buchmacher-Quote
  isBanker: boolean;       // Banker = muss gewinnen
  // Berechnete Felder
  ev: number;              // pModel * quote - 1
  edge: number;            // pModel - (1/quote)
  evMultiplier: number;    // Was passiert wenn dieser Leg zur Kombi kommt
}

export interface SystemResult {
  type: string;            // z.B. "2/4", "3/4+Banker", "4er-Kombi"
  label: string;           // Anzeigename
  numSlips: number;        // Anzahl Wettscheine
  stakePerSlip: number;
  totalStake: number;
  expectedPayout: number;
  expectedProfit: number;
  roi: number;
  pProfit: number;         // P(mindestens 1 Schein gewinnt)
  maxPayout: number;
  scenarios: SystemScenario[];
}

export interface SystemScenario {
  nCorrect: number;
  probability: number;
  avgPayout: number;
  avgProfit: number;
  label: string;
}

export interface LegImpact {
  leg: ComboLeg;
  evBefore: number;        // Kombi-EV ohne diesen Leg
  evAfter: number;         // Kombi-EV mit diesem Leg
  evDelta: number;         // Differenz
  pBefore: number;         // Gewinn-P ohne
  pAfter: number;          // Gewinn-P mit
  verdict: "BOOST" | "NEUTRAL" | "DAMAGE" | "DESTROY";
  reason: string;
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

// ─── Leg erstellen ──────────────────────────────────────────────────

export function createLeg(
  id: string, label: string, match: string,
  pModel: number, quote: number, isBanker = false
): ComboLeg {
  const ev = pModel * quote - 1;
  const edge = pModel - (1 / quote);
  // Multiplikator-Effekt: Wie verändert dieser Leg den EV einer Kombi?
  // evMultiplier = pModel * quote = 1 + ev
  // > 1.0 = Leg ERHÖHT EV, < 1.0 = Leg SENKT EV, = 1.0 = neutral
  const evMultiplier = pModel * quote;
  return { id, label, match, pModel, quote, isBanker, ev, edge, evMultiplier };
}

// ─── Einfache Kombi-Berechnung ──────────────────────────────────────

export function calcCombo(legs: ComboLeg[]): {
  pModel: number; quote: number; ev: number; edge: number; kelly: number;
} {
  const pModel = legs.reduce((p, l) => p * l.pModel, 1);
  const quote = legs.reduce((q, l) => q * l.quote, 1);
  const ev = pModel * quote - 1;
  const edge = pModel - (1 / quote);
  const kelly = quote > 1 ? Math.max(0, Math.min((pModel * quote - 1) / (quote - 1) * 0.20, 0.03)) : 0;
  return { pModel, quote, ev, edge, kelly };
}

// ─── Impact-Analyse: Was passiert wenn ein Leg hinzugefügt wird? ────

export function analyzeLegImpact(
  existingLegs: ComboLeg[],
  newLeg: ComboLeg
): LegImpact {
  const before = existingLegs.length > 0
    ? calcCombo(existingLegs)
    : { pModel: 1, quote: 1, ev: 0, edge: 0, kelly: 0 };

  const after = calcCombo([...existingLegs, newLeg]);

  const evDelta = after.ev - before.ev;
  const evMultiplier = newLeg.evMultiplier;

  let verdict: LegImpact["verdict"];
  let reason: string;

  if (evMultiplier >= 1.05) {
    verdict = "BOOST";
    reason = `Leg hat +${((evMultiplier - 1) * 100).toFixed(0)}% EV. Erhöht Kombi-Value.`;
  } else if (evMultiplier >= 0.98) {
    verdict = "NEUTRAL";
    reason = `Leg ist nahezu fair (${((evMultiplier - 1) * 100).toFixed(1)}%). Kaum Auswirkung auf EV.`;
  } else if (evMultiplier >= 0.90) {
    verdict = "DAMAGE";
    reason = `Leg kostet ${((1 - evMultiplier) * 100).toFixed(1)}% EV durch Buchmacher-Marge. Kombi wird schlechter.`;
  } else {
    verdict = "DESTROY";
    reason = `Leg hat ${((evMultiplier - 1) * 100).toFixed(0)}% EV — zerstört den Value der Kombi.`;
  }

  // Spezialfall: Leg macht gesamte Kombi -EV
  if (before.ev > 0 && after.ev <= 0) {
    verdict = "DESTROY";
    reason = `ACHTUNG: Dieser Leg macht die Kombi von +EV zu -EV! Kombi-EV sinkt von ${(before.ev * 100).toFixed(1)}% auf ${(after.ev * 100).toFixed(1)}%.`;
  }

  return {
    leg: newLeg,
    evBefore: before.ev,
    evAfter: after.ev,
    evDelta,
    pBefore: before.pModel,
    pAfter: after.pModel,
    verdict,
    reason,
  };
}

// ─── Systemwetten-Rechner ───────────────────────────────────────────

export function calcSystemBet(
  legs: ComboLeg[],
  comboSize: number,        // z.B. 2 für "2 aus N"
  stakePerSlip: number,
): SystemResult {
  const bankers = legs.filter(l => l.isBanker);
  const nonBankers = legs.filter(l => !l.isBanker);

  // Banker müssen in jeder Kombi drin sein
  // Restliche Legs werden kombiniert
  const neededFromNonBankers = comboSize - bankers.length;

  if (neededFromNonBankers < 0 || neededFromNonBankers > nonBankers.length) {
    return {
      type: `${comboSize}/${legs.length}`, label: "Ungültig",
      numSlips: 0, stakePerSlip, totalStake: 0,
      expectedPayout: 0, expectedProfit: 0, roi: 0, pProfit: 0, maxPayout: 0,
      scenarios: [],
    };
  }

  // Alle Kombi-Scheine generieren
  const nonBankerCombos = combinations(nonBankers, neededFromNonBankers);
  const slips = nonBankerCombos.map(combo => [...bankers, ...combo]);
  const numSlips = slips.length;
  const totalStake = numSlips * stakePerSlip;

  // Alle möglichen Ausgänge (2^N) durchrechnen
  const allLegs = legs;
  const n = allLegs.length;
  const scenarios: Map<number, { totalP: number; totalPayout: number; count: number }> = new Map();

  for (let mask = 0; mask < (1 << n); mask++) {
    // Welche Legs treffen?
    const hits = new Set<string>();
    let pOutcome = 1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        hits.add(allLegs[i].id);
        pOutcome *= allLegs[i].pModel;
      } else {
        pOutcome *= (1 - allLegs[i].pModel);
      }
    }

    // Prüfe: Sind alle Banker getroffen?
    const bankersHit = bankers.every(b => hits.has(b.id));

    // Berechne Auszahlung
    let payout = 0;
    if (bankersHit) {
      for (const slip of slips) {
        if (slip.every(leg => hits.has(leg.id))) {
          payout += slip.reduce((q, l) => q * l.quote, 1) * stakePerSlip;
        }
      }
    }

    const nCorrect = hits.size;
    const entry = scenarios.get(nCorrect) || { totalP: 0, totalPayout: 0, count: 0 };
    entry.totalP += pOutcome;
    entry.totalPayout += pOutcome * payout;
    entry.count++;
    scenarios.set(nCorrect, entry);
  }

  // Szenarien aufbereiten
  const scenarioList: SystemScenario[] = [];
  let expectedPayout = 0;
  let pProfit = 0;

  for (let nCorrect = 0; nCorrect <= n; nCorrect++) {
    const entry = scenarios.get(nCorrect);
    if (!entry || entry.totalP === 0) continue;

    const avgPayout = entry.totalPayout / entry.totalP;
    const avgProfit = avgPayout - totalStake;

    scenarioList.push({
      nCorrect,
      probability: entry.totalP,
      avgPayout,
      avgProfit,
      label: `${nCorrect}/${n}${bankers.length > 0 ? ` (+${bankers.length}B)` : ""}`,
    });

    expectedPayout += entry.totalPayout;
    if (avgPayout > totalStake) pProfit += entry.totalP;
  }

  const expectedProfit = expectedPayout - totalStake;
  const maxPayout = slips.reduce((sum, slip) =>
    sum + slip.reduce((q, l) => q * l.quote, 1) * stakePerSlip, 0);

  const bankerLabel = bankers.length > 0
    ? ` + ${bankers.map(b => b.label).join(",")}`
    : "";

  return {
    type: `${comboSize}/${legs.length}`,
    label: `System ${comboSize}/${legs.length}${bankerLabel}`,
    numSlips,
    stakePerSlip,
    totalStake,
    expectedPayout,
    expectedProfit,
    roi: totalStake > 0 ? expectedProfit / totalStake : 0,
    pProfit,
    maxPayout,
    scenarios: scenarioList,
  };
}

// ─── Alle sinnvollen Systeme für N Legs berechnen ───────────────────

export function calcAllSystems(
  legs: ComboLeg[],
  stakePerSlip: number,
): SystemResult[] {
  const results: SystemResult[] = [];
  const n = legs.length;

  if (n < 2) return results;

  // Einzelwetten
  const singlesProfit = legs.reduce((sum, l) => sum + (l.pModel * l.quote - 1) * stakePerSlip, 0);
  const singlesPProfit = 1 - legs.reduce((p, l) => p * (1 - l.pModel), 1);
  results.push({
    type: `${n}× Einzel`,
    label: `${n}× Einzelwetten`,
    numSlips: n,
    stakePerSlip,
    totalStake: n * stakePerSlip,
    expectedPayout: legs.reduce((sum, l) => sum + l.pModel * l.quote * stakePerSlip, 0),
    expectedProfit: singlesProfit,
    roi: singlesProfit / (n * stakePerSlip),
    pProfit: singlesPProfit,
    maxPayout: Math.max(...legs.map(l => l.quote)) * stakePerSlip,
    scenarios: [],
  });

  // System 2/N bis (N-1)/N
  for (let k = 2; k < n; k++) {
    results.push(calcSystemBet(legs, k, stakePerSlip));
  }

  // N-er Kombi (Akkumulator)
  results.push(calcSystemBet(legs, n, stakePerSlip));

  return results;
}

// ─── Banker-Empfehlung ──────────────────────────────────────────────

export interface BankerRecommendation {
  bankerId: string;
  bankerLabel: string;
  reason: string;
  score: number;           // 0-100, höher = besserer Banker
  systemWithBanker: SystemResult;
  systemWithout: SystemResult;
  improvement: number;     // ROI-Verbesserung
}

export function recommendBankers(
  legs: ComboLeg[],
  comboSize: number,
  stakePerSlip: number,
): BankerRecommendation[] {
  if (legs.length < 3) return [];

  const baseSystem = calcSystemBet(legs, comboSize, stakePerSlip);
  const recommendations: BankerRecommendation[] = [];

  for (const candidate of legs) {
    // Setze diesen Leg als Banker
    const legsWithBanker = legs.map(l => ({
      ...l,
      isBanker: l.id === candidate.id,
    }));

    const bankerSystem = calcSystemBet(legsWithBanker, comboSize, stakePerSlip);

    // Score berechnen
    // Guter Banker = hohe Wahrscheinlichkeit + positiver EV
    const pScore = candidate.pModel * 100;     // 0-100 basierend auf P
    const evScore = Math.max(0, candidate.ev * 50); // Bonus für +EV
    const score = pScore * 0.7 + evScore * 0.3;

    let reason: string;
    if (candidate.pModel >= 0.6 && candidate.ev > 0) {
      reason = `Starker Banker: ${(candidate.pModel * 100).toFixed(0)}% Wahrscheinlichkeit + Value (${(candidate.ev * 100).toFixed(0)}% EV).`;
    } else if (candidate.pModel >= 0.6) {
      reason = `Hohe Wahrscheinlichkeit (${(candidate.pModel * 100).toFixed(0)}%), aber kein Value — Banker-Qualität trotzdem gut.`;
    } else if (candidate.ev > 0.3) {
      reason = `Starker Value (${(candidate.ev * 100).toFixed(0)}% EV), aber riskant als Banker (${(candidate.pModel * 100).toFixed(0)}%).`;
    } else {
      reason = `Schwacher Banker: ${(candidate.pModel * 100).toFixed(0)}% Wahrscheinlichkeit, ${(candidate.ev * 100).toFixed(0)}% EV.`;
    }

    recommendations.push({
      bankerId: candidate.id,
      bankerLabel: candidate.label,
      reason,
      score,
      systemWithBanker: bankerSystem,
      systemWithout: baseSystem,
      improvement: bankerSystem.roi - baseSystem.roi,
    });
  }

  return recommendations.sort((a, b) => b.score - a.score);
}

// ═════════════════════════════════════════════════════════════════════
// P2: CORRELATION IN KOMBIWETTEN
// ═════════════════════════════════════════════════════════════════════
// Cross-match correlation exists: CL matches on same night, same league
// matchday, weather patterns, referee tendencies.
// We model this as pairwise correlation between binary outcomes.

export interface CorrelationInfo {
  rho: number;              // estimated pairwise correlation (-0.1 to +0.2)
  source: string;           // why this correlation
  pCombo_independent: number;  // P under independence
  pCombo_correlated: number;   // P adjusted for correlation
  evShift: number;          // how much EV changes
  warning: string | null;
}

// P(A and B) with correlation:
// P(A∩B) = P(A)*P(B) + ρ * sqrt(P(A)(1-P(A)) * P(B)(1-P(B)))
function pJointCorr(pA: number, pB: number, rho: number): number {
  const independent = pA * pB;
  const maxCorr = Math.sqrt(pA * (1 - pA) * pB * (1 - pB));
  return Math.max(0, Math.min(1, independent + rho * maxCorr));
}

// For N legs with common correlation ρ, approximate joint P
// Using the recursion: P(A1∩A2∩...∩An) ≈ product adjusted by correlation
function pJointMultiCorr(probs: number[], rho: number): number {
  if (probs.length <= 1) return probs[0] || 1;
  if (Math.abs(rho) < 0.001) return probs.reduce((a, b) => a * b, 1);

  // For small correlations, use first-order correction:
  // P_corr ≈ P_indep * (1 + rho * correction_factor)
  // correction_factor depends on how many legs and their individual probs
  const pIndep = probs.reduce((a, b) => a * b, 1);

  // Sum of pairwise correlation contributions
  let corrSum = 0;
  for (let i = 0; i < probs.length; i++) {
    for (let j = i + 1; j < probs.length; j++) {
      const pi = probs[i], pj = probs[j];
      // Relative increase in joint P per pair
      corrSum += rho * Math.sqrt((1 - pi) * (1 - pj) / (pi * pj));
    }
  }

  return Math.max(0, pIndep * (1 + corrSum));
}

// Estimate correlation based on match metadata
export function estimateCorrelation(legs: ComboLeg[]): {
  rho: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let rho = 0;

  // Check if all legs are from same competition day
  const matches = new Set(legs.map(l => l.match));

  // Same-match legs (e.g., Home win + Over 2.5 from same match)
  if (matches.size < legs.length) {
    // Some legs share a match → strong positive correlation
    rho += 0.15;
    reasons.push("Legs aus gleichem Spiel: ρ +0.15 (starke Korrelation)");
  }

  // Multiple underdog bets in same competition round
  const longshots = legs.filter(l => l.pModel < 0.3);
  if (longshots.length >= 2) {
    // "Upset night" effect: underdogs tend to cluster
    rho += 0.05;
    reasons.push(`${longshots.length} Longshots: ρ +0.05 (Underdog-Clustering-Effekt)`);
  }

  // Multiple heavy favourites
  const favs = legs.filter(l => l.pModel > 0.65);
  if (favs.length >= 2) {
    // Favourites in same competition also cluster
    rho += 0.03;
    reasons.push(`${favs.length} Favoriten: ρ +0.03 (leichte positive Korrelation)`);
  }

  // All legs from different matches → lower correlation
  if (matches.size === legs.length && legs.length >= 3) {
    reasons.push("Alle Legs aus verschiedenen Spielen: Basis-Korrelation niedrig");
  }

  // Cap at reasonable range
  rho = Math.max(-0.10, Math.min(0.20, rho));

  if (reasons.length === 0) {
    reasons.push("Keine besondere Korrelation erkannt (ρ ≈ 0)");
  }

  return { rho, reasons };
}

// Calculate correlation impact on a combo
export function calcCorrelationImpact(legs: ComboLeg[], comboQuote: number): CorrelationInfo {
  const { rho, reasons } = estimateCorrelation(legs);
  const probs = legs.map(l => l.pModel);
  const pIndep = probs.reduce((a, b) => a * b, 1);
  const pCorr = pJointMultiCorr(probs, rho);

  const evIndep = pIndep * comboQuote - 1;
  const evCorr = pCorr * comboQuote - 1;
  const evShift = evCorr - evIndep;

  let warning: string | null = null;
  if (Math.abs(evShift) > 0.05) {
    if (evShift > 0) {
      warning = `Korrelation ERHÖHT den EV um ${(evShift * 100).toFixed(1)}% — die Kombi ist besser als unter Unabhängigkeit.`;
    } else {
      warning = `Korrelation SENKT den EV um ${(Math.abs(evShift) * 100).toFixed(1)}% — Vorsicht.`;
    }
  }

  return {
    rho,
    source: reasons.join(" · "),
    pCombo_independent: pIndep,
    pCombo_correlated: pCorr,
    evShift,
    warning,
  };
}

// ═════════════════════════════════════════════════════════════════════
// P3: SAME-GAME MULTI (SGM / BETBUILDER) — EXAKTE MATRIX-WAHRSCHEINLICHKEITEN
// ═════════════════════════════════════════════════════════════════════
// Die 15×15 Dixon-Coles Matrix ist die EINZIGE korrekte Quelle für SGM-Preise.
// Bookmaker berechnen SGM-Quoten mit versteckter Korrelations-Marge (~12-20%).
// Wir summieren exakt die Zellen die ALLE Bedingungen gleichzeitig erfüllen.
// Keine Korrelations-Schätzung nötig — die Matrix HAT die Korrelation.

export type SGMCondition =
  | { type: "home_win" }
  | { type: "away_win" }
  | { type: "draw" }
  | { type: "over"; goals: number }     // total goals > X
  | { type: "under"; goals: number }    // total goals ≤ X
  | { type: "btts_yes" }               // both teams score
  | { type: "btts_no" }
  | { type: "home_over"; goals: number } // home goals > X
  | { type: "home_under"; goals: number }
  | { type: "away_over"; goals: number }
  | { type: "away_under"; goals: number }
  | { type: "clean_sheet_home" }        // away = 0
  | { type: "clean_sheet_away" }        // home = 0
  | { type: "exact_score"; home: number; away: number }
  | { type: "home_goals_exact"; goals: number }
  | { type: "away_goals_exact"; goals: number };

function cellMatchesCondition(h: number, a: number, cond: SGMCondition): boolean {
  switch (cond.type) {
    case "home_win": return h > a;
    case "away_win": return a > h;
    case "draw": return h === a;
    case "over": return h + a > cond.goals;
    case "under": return h + a <= cond.goals;
    case "btts_yes": return h >= 1 && a >= 1;
    case "btts_no": return h === 0 || a === 0;
    case "home_over": return h > cond.goals;
    case "home_under": return h <= cond.goals;
    case "away_over": return a > cond.goals;
    case "away_under": return a <= cond.goals;
    case "clean_sheet_home": return a === 0;
    case "clean_sheet_away": return h === 0;
    case "exact_score": return h === cond.home && a === cond.away;
    case "home_goals_exact": return h === cond.goals;
    case "away_goals_exact": return a === cond.goals;
  }
}

/**
 * Berechne die EXAKTE Joint-Wahrscheinlichkeit für beliebige SGM-Kombination.
 * Summiert alle Matrix-Zellen die ALLE Bedingungen gleichzeitig erfüllen.
 *
 * Beispiel: "Heim + Ü2.5 + BTTS"
 *   → Zellen wo h>a UND h+a>2.5 UND h≥1 UND a≥1
 *   → z.B. [2:1], [3:1], [3:2], [2:2] sind NICHT enthalten (2:2 = Draw)
 *   → Exakte Summe = wahre Wahrscheinlichkeit MIT Korrelation
 */
export function calcSGMProbability(
  matrix: number[][],
  conditions: SGMCondition[]
): number {
  let pJoint = 0;
  const size = matrix.length;
  for (let h = 0; h < size; h++) {
    for (let a = 0; a < size; a++) {
      if (conditions.every(c => cellMatchesCondition(h, a, c))) {
        pJoint += matrix[h][a];
      }
    }
  }
  return pJoint;
}

export interface SGMResult {
  pModel: number;          // Exakte Joint-P aus Matrix
  pBookmaker: number;      // Implizite P aus Buchmacher-Quote
  comboQuote: number;      // Buchmacher-SGM-Quote
  fairQuote: number;       // 1 / pModel (faire Quote)
  edge: number;            // pModel - pBookmaker
  ev: number;              // pModel * comboQuote - 1
  kelly: number;           // Fractional Kelly für SGM
  hiddenMargin: number;    // Wie viel der Bookie auf Korrelation aufschlägt
  conditions: SGMCondition[];
}

/**
 * Bewerte eine Same-Game-Multi gegen Buchmacher-Quote.
 * Nutzt die 15×15 Matrix für exakte Joint-P (keine Korrelations-Hacks).
 */
export function calcSGM(
  matrix: number[][],
  conditions: SGMCondition[],
  bookmakerQuote: number,
  fraction: number = 0.15  // Kelly-Fraktion für SGMs (konservativer als Singles)
): SGMResult {
  const pModel = calcSGMProbability(matrix, conditions);
  const pBookmaker = bookmakerQuote > 0 ? 1 / bookmakerQuote : 0;
  const fairQuote = pModel > 0 ? 1 / pModel : Infinity;
  const edge = pModel - pBookmaker;
  const ev = pModel * bookmakerQuote - 1;

  // Fractional Kelly für SGMs — konservativer als Singles weil SGM-Quoten
  // strukturell höhere Varianz haben (weniger liquid, mehr Marge)
  const kelly = bookmakerQuote > 1 && ev > 0
    ? Math.max(0, Math.min((pModel * bookmakerQuote - 1) / (bookmakerQuote - 1) * fraction, 0.02))
    : 0;

  // Hidden margin: Buchmacher setzt die Quote so dass pBookmaker > pModel (wenn er recht hat)
  // aber bei SGMs ist die Marge oft 12-20% ÜBER dem normalen Vig
  const naiveP = conditions.length > 0 ? 1 : 0;  // placeholder
  const hiddenMargin = pModel > 0 ? (pBookmaker - pModel) / pModel : 0;

  return {
    pModel, pBookmaker, comboQuote: bookmakerQuote, fairQuote,
    edge, ev, kelly, hiddenMargin, conditions,
  };
}

/**
 * Generiere alle sinnvollen SGM-Kombis für ein Match und finde Value.
 * Die Matrix sagt uns wo der Bookie falsch liegt.
 */
export function findSGMValue(
  matrix: number[][],
  sgmOdds: Record<string, number>,  // z.B. {"Heim+Ü2.5": 2.40, "Heim+BTTS": 3.10}
  minEdge: number = 0.03
): SGMResult[] {
  const presets: { label: string; conditions: SGMCondition[] }[] = [
    { label: "Heim + Ü2.5", conditions: [{ type: "home_win" }, { type: "over", goals: 2.5 }] },
    { label: "Heim + U2.5", conditions: [{ type: "home_win" }, { type: "under", goals: 2.5 }] },
    { label: "Gast + Ü2.5", conditions: [{ type: "away_win" }, { type: "over", goals: 2.5 }] },
    { label: "Gast + U2.5", conditions: [{ type: "away_win" }, { type: "under", goals: 2.5 }] },
    { label: "Remis + U2.5", conditions: [{ type: "draw" }, { type: "under", goals: 2.5 }] },
    { label: "Heim + BTTS", conditions: [{ type: "home_win" }, { type: "btts_yes" }] },
    { label: "Gast + BTTS", conditions: [{ type: "away_win" }, { type: "btts_yes" }] },
    { label: "Heim + Ü2.5 + BTTS", conditions: [{ type: "home_win" }, { type: "over", goals: 2.5 }, { type: "btts_yes" }] },
    { label: "Gast + Ü2.5 + BTTS", conditions: [{ type: "away_win" }, { type: "over", goals: 2.5 }, { type: "btts_yes" }] },
    { label: "Heim + CS", conditions: [{ type: "home_win" }, { type: "clean_sheet_home" }] },
    { label: "Gast + CS", conditions: [{ type: "away_win" }, { type: "clean_sheet_away" }] },
    { label: "Heim + Ü3.5", conditions: [{ type: "home_win" }, { type: "over", goals: 3.5 }] },
    { label: "Ü2.5 + BTTS", conditions: [{ type: "over", goals: 2.5 }, { type: "btts_yes" }] },
    { label: "U2.5 + BTTS nein", conditions: [{ type: "under", goals: 2.5 }, { type: "btts_no" }] },
  ];

  const results: SGMResult[] = [];
  for (const preset of presets) {
    const quote = sgmOdds[preset.label];
    if (!quote || quote <= 1) continue;

    const sgm = calcSGM(matrix, preset.conditions, quote);
    if (sgm.edge >= minEdge) {
      results.push(sgm);
    }
  }

  return results.sort((a, b) => b.ev - a.ev);
}

// ═════════════════════════════════════════════════════════════════════
// P4: CROSS-GAME AKKUMULATOR MIT DUAL-TRACK CALIBRATION
// ═════════════════════════════════════════════════════════════════════
// Für Cross-Game Kombis (verschiedene Spiele) nutzen wir Track B
// (isotonisch kalibrierte Wahrscheinlichkeiten) für die Edge-Berechnung.
// Track A (Matrix-Roh) bleibt für die Marktableitung.
//
// Warum Track B: Ein lineares Modell das 3% overconfident ist auf einem
// Einzelspiel wird bei einem 4er-Akku 3%^4 ≈ 12% overconfident — genug
// um +EV in -EV zu verwandeln. Track B zwingt die Probs in die
// historische empirische Realität.

export interface AccumulatorLeg {
  matchId: string;
  label: string;
  match: string;
  pTrackA: number;          // Raw matrix probability (for display)
  pTrackB: number;          // Isotonic-calibrated probability (for Kelly/edge)
  quote: number;            // Bookmaker odds
}

export interface AccumulatorResult {
  legs: AccumulatorLeg[];
  // Track A (raw matrix — für Display)
  pModel_trackA: number;
  // Track B (kalibriert — für Sizing)
  pModel_trackB: number;
  comboQuote: number;
  ev_trackA: number;
  ev_trackB: number;        // DAS ist der echte EV
  edge_trackB: number;      // DAS ist die echte Edge
  kelly: number;            // Fractional Kelly basierend auf Track B
  isValue: boolean;
  warning: string | null;
}

/**
 * Berechne einen Cross-Game Akkumulator mit Dual-Track Calibration.
 *
 * Track A: Rohwahrscheinlichkeiten aus der Matrix (für Anzeige, Markt-Kohärenz)
 * Track B: Isotonisch kalibriert (für Kelly-Sizing, Edge-Berechnung)
 *
 * Die Edge wird NUR aus Track B berechnet — historisch geerdet, nicht overconfident.
 * Kelly wird auf Track B appliziert mit einem Multi-Bet Dampener (÷ nLegs).
 */
export function calcAccumulator(
  legs: AccumulatorLeg[],
  kellyBaseFraction: number = 0.25  // Basis-Kelly für Singles
): AccumulatorResult {
  if (legs.length === 0) {
    return {
      legs, pModel_trackA: 0, pModel_trackB: 0, comboQuote: 0,
      ev_trackA: 0, ev_trackB: 0, edge_trackB: 0, kelly: 0,
      isValue: false, warning: null,
    };
  }

  // Kompoundierte Wahrscheinlichkeiten
  const pModel_trackA = legs.reduce((p, l) => p * l.pTrackA, 1);
  const pModel_trackB = legs.reduce((p, l) => p * l.pTrackB, 1);
  const comboQuote = legs.reduce((q, l) => q * l.quote, 1);

  // EV aus beiden Tracks
  const ev_trackA = pModel_trackA * comboQuote - 1;
  const ev_trackB = pModel_trackB * comboQuote - 1;
  const edge_trackB = pModel_trackB - (1 / comboQuote);

  // ═══ FRACTIONAL KELLY DAMPENER FÜR MULTIS ═══
  // Standard Kelly: k = (p*q - 1) / (q - 1)
  // Für Akkus dividieren wir durch die Anzahl der Legs.
  // 2er-Akku: Kelly / 2, 3er: Kelly / 3, etc.
  // Grund: Varianz wächst geometrisch mit jedem Leg.
  // Ein 4er-Akku mit gleicher Kelly-Fraction wie ein Single
  // hat ~16× höhere Varianz → Ruin-Risiko steigt exponentiell.
  const nLegs = legs.length;
  const kellyDivisor = nLegs;  // Konservativ: Kelly / nLegs
  const adjustedFraction = kellyBaseFraction / kellyDivisor;

  const kelly = comboQuote > 1 && ev_trackB > 0
    ? Math.max(0, Math.min(
        (pModel_trackB * comboQuote - 1) / (comboQuote - 1) * adjustedFraction,
        0.03 / nLegs  // Hard cap sinkt auch mit Legs
      ))
    : 0;

  // Warnungen
  let warning: string | null = null;
  if (ev_trackA > 0 && ev_trackB <= 0) {
    warning = `Track A zeigt +EV (${(ev_trackA * 100).toFixed(1)}%), aber Track B (kalibriert) sagt -EV (${(ev_trackB * 100).toFixed(1)}%). Das Modell ist wahrscheinlich overconfident — NICHT wetten.`;
  } else if (nLegs >= 5) {
    warning = `${nLegs}-Leg Akku: Varianz extrem hoch. Selbst mit +EV ist der Erwartungswert der Volatilität dominant. Systemwette erwägen.`;
  }

  const isValue = ev_trackB > 0 && edge_trackB > 0.02;

  return {
    legs, pModel_trackA, pModel_trackB, comboQuote,
    ev_trackA, ev_trackB, edge_trackB, kelly,
    isValue, warning,
  };
}

/**
 * Optimale Kombi-Größe finden: Teste 2er bis Ner Akkus,
 * finde den Sweet Spot wo EV positiv und Kelly sinnvoll ist.
 */
export function findOptimalAccuSize(
  legs: AccumulatorLeg[]
): { size: number; result: AccumulatorResult }[] {
  const results: { size: number; result: AccumulatorResult }[] = [];

  // Sortiere Legs nach Track B Edge (beste zuerst)
  const sorted = [...legs].sort((a, b) =>
    (b.pTrackB * b.quote - 1) - (a.pTrackB * a.quote - 1)
  );

  // Teste aufsteigende Akkumulatorgröße (greedy: nehme immer die besten Legs)
  for (let size = 2; size <= Math.min(sorted.length, 8); size++) {
    const subset = sorted.slice(0, size);
    const result = calcAccumulator(subset);
    results.push({ size, result });
  }

  return results;
}

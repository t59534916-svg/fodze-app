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

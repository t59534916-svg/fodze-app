// ═══════════════════════════════════════════════════════════════════════
// FODZE Engine Registry — Multi-Engine Dispatch
//
// Allows users to select between different prediction engines.
// Each engine produces the same MatchCalc output interface.
// ═══════════════════════════════════════════════════════════════════════

export type PredictionEngine =
  | "ensemble-v1"
  | "poisson-ml"
  | "poisson-ml-v2"
  | "poisson-ml-v3"
  | "poisson-ml-dev03"
  | "poisson-ml-blend"
  | "footbayes-hierarchical";

export interface EngineInfo {
  id: PredictionEngine;
  name: string;
  description: string;
  /** Wenn true: Engine existiert als code, aber braucht Model/Daten die
   *  noch nicht gereift sind. UI zeigt einen "nicht trainiert" Badge
   *  und fällt bei Auswahl auf den fallback zurück. */
  preview?: boolean;
}

export const ENGINES: EngineInfo[] = [
  {
    id: "ensemble-v1",
    name: "Standard",
    description: "4-Modell Ensemble (DC + Elo + Logistic + Market)",
  },
  {
    id: "poisson-ml",
    name: "@annafrick13",
    description: "ML-gesteuerte λ → Dixon-Coles Matrix",
  },
  {
    id: "poisson-ml-v2",
    name: "@annafrick13 v2",
    description: "LightGBM Tweedie → Monotone Constraints → Dixon-Coles Matrix",
  },
  {
    id: "poisson-ml-v3",
    name: "@annafrick13 v3",
    description: "Lean 20-Feature LightGBM (xG-EWMA + Elo + SoS + Physis + Discipline). Trained 2026-04-25 on 78k Supabase rows. Brier 0.6536 (v2 baseline 0.5844 on different test corpus) — preview only, route to v2 internally until per-Liga calibration drift is fixed.",
    preview: true,
  },
  {
    id: "poisson-ml-dev03",
    name: "v4 dev-03",
    description: "v4 LightGBM Tweedie 5-Bagged Bayesian Ensemble (16 features: m2_lambda EWMA + Elo + Momentum) + m6_benter blend with Pinnacle. Directional-only edge in 4 Ligen (la_liga/scottish_prem/bundesliga/primeira_liga — positive Kelly-ROI in BOTH 24/25-walkfwd + 25/26-holdout), aber NICHT statistisch validiert: das 2026-05-25 Self-Re-Audit fand ZERO Ligen, die Holm-Bonferroni überstehen, sobald die Per-Bet-Std empirisch gemessen wird (148%, nicht angenommene 80%) — siehe bet-edge-policy.ts Header. Returns null + falls back to ensemble when model/cache not loaded or no xG-history.",
  },
  {
    id: "poisson-ml-blend",
    name: "Blend (dev-03 ⊕ v2)",
    description: "50/50 λ-Mittel aus dev-03 + v2. Schärfster Forecaster der Suite durch Ensemble-Varianzreduktion zweier starker, dekorrelierter Modelle (Brier −0.0066 vs dev-03 auf 25/26 OOT; Mechanismus cross-season via dev-09 bestätigt, eval_blend_partners.py). Kein Lineup / keine neue Pipeline nötig — beide Beine werden ohnehin pro Match berechnet. Null wenn dev-03 oder v2 fehlt (Fallback: ensemble). Confidence-Badge ist auf dev-03 kalibriert und für den Blend verifiziert (blend_confidence_calibration.py): der Badge-mk IST der rohe λ-Blend (Benter berührt nur die Wetten), und alle 4 Tiers halten auf 25/26 OOT — HOCH 76.4% (Claim 73%, n=386), MITTEL 61.9% (Claim 53%) — also eine sichere, eher konservative Näherung.",
  },
  {
    id: "footbayes-hierarchical",
    name: "Bayes Hierarchical",
    description: "footBayes + Stan, Liga-Hyperprior Partial-Pooling (experimentell)",
  },
];

// dev-03 is the sharpest forecaster a new user can safely get by default: on
// the user-facing (raw model) display path its 1X2 Brier is ~0.62 vs Standard's
// ~0.68 (FORECAST-QUALITY-ANALYSIS.md §3; confirmed on the calibrated path via
// tools/backtest/engine_calibrated_brier.mts), its confidence badge is validated
// (HOCH ≥65% ~73.7%), and Goldilocks/Money-Eval/badge already assume it. Per-match
// it falls back to ensemble when model/cache/xG-history is missing (MatchdayContext
// routing), so this is strictly ≥ the old ensemble-v1 default. Users with a saved
// profile.prediction_engine are unaffected (AppContext overrides on load).
export const DEFAULT_ENGINE: PredictionEngine = "poisson-ml-dev03";

export function isValidEngine(id: string): id is PredictionEngine {
  return ENGINES.some(e => e.id === id);
}

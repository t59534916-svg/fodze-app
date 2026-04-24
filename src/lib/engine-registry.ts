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
    id: "footbayes-hierarchical",
    name: "Bayes Hierarchical",
    description: "footBayes + Stan, Liga-Hyperprior Partial-Pooling (experimentell)",
  },
];

export const DEFAULT_ENGINE: PredictionEngine = "ensemble-v1";

export function isValidEngine(id: string): id is PredictionEngine {
  return ENGINES.some(e => e.id === id);
}

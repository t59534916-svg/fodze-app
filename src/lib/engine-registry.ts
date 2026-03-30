// ═══════════════════════════════════════════════════════════════════════
// FODZE Engine Registry — Multi-Engine Dispatch
//
// Allows users to select between different prediction engines.
// Each engine produces the same MatchCalc output interface.
// ═══════════════════════════════════════════════════════════════════════

export type PredictionEngine = "ensemble-v1" | "poisson-ml" | "poisson-ml-v2";

export interface EngineInfo {
  id: PredictionEngine;
  name: string;
  description: string;
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
];

export const DEFAULT_ENGINE: PredictionEngine = "ensemble-v1";

export function isValidEngine(id: string): id is PredictionEngine {
  return ENGINES.some(e => e.id === id);
}

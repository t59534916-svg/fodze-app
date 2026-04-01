// ═══════════════════════════════════════════════════════════════════════
// FODZE Type Definitions — Strict Types, No `any`
// ═══════════════════════════════════════════════════════════════════════

// ─── xG History ──────────────────────────────────────────────────────

export interface XGHistoryEntry {
  xg: number;
  xga: number;
  npxg?: number;          // Non-penalty xG scored (v2.0)
  npxga?: number;         // Non-penalty xG conceded (v2.0)
  ppda_att?: number;      // Pressing: passes attempted (v2.1)
  ppda_def?: number;      // Pressing: defensive actions (v2.1)
  deep?: number;          // Deep completions (v2.1)
  deep_allowed?: number;  // Deep completions conceded (v2.1)
  date?: string;
  result?: string;
  opponent?: string;
}

// ─── Team Data (Template Literal Types for xG keys) ──────────────────

export interface TeamData {
  name: string;
  // xG metrics: strict keys for home(h) and away(a), window size 8
  xg_h8?: number;     // SUM of xG scored in last 8 HOME games
  xga_h8?: number;    // SUM of xGA conceded in last 8 HOME games
  xg_a8?: number;     // SUM of xG scored in last 8 AWAY games
  xga_a8?: number;    // SUM of xGA conceded in last 8 AWAY games
  games?: number;     // Number of games in window (default 8)
  form?: string;      // "W W D L W"
  injuries?: string;
  yellow_risk?: string;
  notes?: string;
  // Per-match history for EWMA and sparklines
  xg_h_history?: XGHistoryEntry[];
  xg_a_history?: XGHistoryEntry[];
}

// Helper type: extract xG value for a team depending on venue
export type HomeXGKeys = "xg_h8" | "xga_h8";
export type AwayXGKeys = "xg_a8" | "xga_a8";

// ─── Top Scorers (optional, admin-provided) ──────────────────────────

export interface TopScorer {
  name: string;
  team: "H" | "A";
  prob: number;  // scoring probability 0-1
}

// ─── Raw Match Data ──────────────────────────────────────────────────

export interface RawMatch {
  home: TeamData;
  away: TeamData;
  tags?: string[];
  context?: string;
  referee?: string;
  kickoff?: string;
  top_scorers?: TopScorer[];
}

export interface MatchdayData {
  league: string;
  matchday: string;
  date?: string;
  matches: RawMatch[];
  data_confidence?: "HIGH" | "MEDIUM" | "LOW" | "MANUAL";
  sources?: string[];
}

// ─── Engine Output: Market Probabilities ─────────────────────────────
// Mirrors Markets interface from dixon-coles.ts

export interface MarketProbs {
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

// ─── Engine Output: Confidence Intervals ─────────────────────────────

export interface ConfidenceInterval {
  low: number;
  high: number;
}

// ─── Engine Output: Form Analysis ────────────────────────────────────

export interface FormAnalysis {
  mult: number;
  label: string;
}

// ─── Engine Output: Tag Correction ───────────────────────────────────

export interface TagCorrection {
  tag: string;
  reason: string;
}

// ─── Engine Output: Bet Calculation ──────────────────────────────────

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface BetCalc {
  label: string;
  pModel: number;
  pMarket: number;
  quote: number;
  kelly: number;
  ev: number;
  edge: number;
  edge_low?: number;
  edge_high?: number;
  edgeSignificant?: boolean;
  isValue: boolean;
  confidence: ConfidenceLevel;
  // Extended (from EnhancedBetCalc in engine)
  pModel_low?: number;
  pModel_high?: number;
  // Value Cap Guardrail (Poisson-ML engine)
  valueTrap?: boolean;
  valueTrapEdge?: number;
  valueTrapReason?: string;
}

// ─── Engine Output: Top Score ────────────────────────────────────────

export interface TopScore {
  s: string;   // "2:1"
  p: number;   // probability
}

// ─── Engine Output: Complete Calculation Result ──────────────────────
// Interface Segregation: split into logical sub-interfaces

export interface LambdaEstimates {
  lambdaH: number;        // Final expected home goals
  lambdaA: number;        // Final expected away goals
  lambdaH_raw?: number;   // Pre-regression lambda
  lambdaA_raw?: number;   // Pre-regression lambda
}

export interface ModelCalibration {
  shrinkageH: number;     // Bayesian shrinkage applied (0-1)
  shrinkageA: number;
  lambdaH_regressed: number;
  lambdaA_regressed: number;
  dynamicRho?: number;    // Correlation parameter used
  alphaUsed?: number;     // NegBin alpha applied
  sosApplied?: boolean;
  absenceApplied?: boolean;
}

export interface ContextAdjustments {
  formH: FormAnalysis;
  formA: FormAnalysis;
  tagCorrections: TagCorrection[];
  tagMultH: number;
  tagMultA: number;
}

export interface ResidualAdjustment {
  deltaH: number;
  deltaD: number;
  deltaA: number;
}

export interface EngineCalcResult extends LambdaEstimates {
  // Probability distributions
  matrix: number[][];        // 15x15 score matrix
  mk: MarketProbs;           // Calibrated market probabilities
  mk_low: MarketProbs;       // Lower CI bound
  mk_high: MarketProbs;      // Upper CI bound
  // Confidence intervals
  ciH: ConfidenceInterval;
  ciA: ConfidenceInterval;
  // Model adjustments
  calibration: ModelCalibration;
  context: ContextAdjustments;
  residualAdjustment?: ResidualAdjustment;
}

// ─── Match Calculation (what MatchdayContext.calcMatch returns) ───────

// MatchCalc: what calcMatch() in MatchdayContext returns
// `enh` is the full EnhancedResult from the Dixon-Coles engine.
// We import the type directly to maintain structural compatibility.
// Import: `import type { EnhancedResult } from "@/lib/dixon-coles"`
// Since types/match.ts shouldn't import from lib/ (circular), we use
// a structural type that is assignable from EnhancedResult.
export interface MatchCalc extends LambdaEstimates {
  mk: MarketProbs;
  bets: BetCalc[];
  enh: Record<string, any> & {  // Engine output — structurally typed for core fields
    lambdaH: number; lambdaA: number;
    lambdaH_regressed: number;
    shrinkageH: number;
    formH: FormAnalysis; formA: FormAnalysis;
    tagCorrections: TagCorrection[];
    ciH: ConfidenceInterval; ciA: ConfidenceInterval;
    matrix: number[][];
    mk: MarketProbs;
  };
  topScores: TopScore[];
  ov: number | null;
  hasValue: boolean;
  hasOdds: boolean;
  warnings?: { level: "error" | "warning"; message: string }[];
  ensemble?: {
    H: number; D: number; A: number; O25: number;
    models: Record<string, any>;
    confidence: {
      H_ci: [number, number]; D_ci: [number, number];
      A_ci: [number, number]; O25_ci: [number, number];
      uncertainty: number;
    };
    nBootstrap: number;
    dualTrack?: {
      trackA: { H: number; D: number; A: number };
      trackB: { H: number; D: number; A: number };
    };
  };
}

// ─── Processed Match ─────────────────────────────────────────────────

export interface ProcessedMatch extends RawMatch {
  idx: number;
  calc: MatchCalc | null;
}

// ─── Odds ────────────────────────────────────────────────────────────

export interface OddsSharpData {
  h: number | null;
  d: number | null;
  a: number | null;
  book?: string;
}

export interface OddsData {
  h?: string;
  d?: string;
  a?: string;
  o25?: string;
  u25?: string;
  btts?: string;
  _source?: "live" | "manual";
  _sharp?: OddsSharpData;
  _bookmakers?: number;
  _fetched?: string;
  [key: string]: string | OddsSharpData | number | undefined;  // for dynamic odds key access (parseFloat(o[k]))
}

export interface OddsSnapshot {
  snapshot_time: string;
  odds: OddsData;
  profiles?: { display_name?: string };
}

// ─── Bets ────────────────────────────────────────────────────────────

export interface PlacedBet {
  id: string;
  match_key: string;
  home_team: string;
  away_team: string;
  market: string;
  odds_placed: number;
  stake: number;
  model_prob?: number;
  edge?: number;
  result: "pending" | "won" | "lost";
  settled_at?: string;
  placed_at?: string;
  clv?: number;
  created_by: string;
}

// ─── Combo Legs ──────────────────────────────────────────────────────

export interface ComboLeg {
  id: string;
  label: string;
  match: string;
  pModel: number;
  quote: number;
  isBanker: boolean;
  ev: number;
  edge: number;
  evMultiplier: number;
}

// ─── Profile ─────────────────────────────────────────────────────────

export interface ProfileData {
  risk_profile: "K" | "M" | "A";
  bankroll: number;
  display_name: string;
  prediction_engine?: string;
}

// ─── League ──────────────────────────────────────────────────────────

export interface LeagueConfig {
  name: string;
  hf: number;   // Home factor
  avg: number;   // Average goals per game
}

export interface LeagueStatus {
  label: string;
  date: string;
}

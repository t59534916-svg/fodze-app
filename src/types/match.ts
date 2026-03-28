// ═══════════════════════════════════════════════════════════════════════
// FODZE Type Definitions — Replaces `any` across the codebase
// ═══════════════════════════════════════════════════════════════════════

// ─── Raw Match Data (from Claude API / JSON Import) ──────────────────

export interface TeamData {
  [key: string]: any;  // allow dynamic key access (t[xk], t[xak], t[hk])
  name: string;
  xg_h8?: number;
  xga_h8?: number;
  xg_a8?: number;
  xga_a8?: number;
  games?: number;
  form?: string;
  injuries?: string;
  yellow_risk?: string;
  notes?: string;
  xg_h_history?: XGHistoryEntry[];
  xg_a_history?: XGHistoryEntry[];
}

export interface XGHistoryEntry {
  xg: number;
  xga: number;
  date?: string;
}

export interface RawMatch {
  home: TeamData;
  away: TeamData;
  tags?: string[];
  context?: string;
  referee?: string;
  kickoff?: string;
}

export interface MatchdayData {
  league: string;
  matchday: string;
  date?: string;
  matches: RawMatch[];
  data_confidence?: "HIGH" | "MEDIUM" | "LOW" | "MANUAL";
  sources?: string[];
}

// ─── Calculated Match Data ───────────────────────────────────────────

export interface MarketProbs {
  H: number;
  D: number;
  A: number;
  O25: number;
  U25: number;
  BTTS?: number;
  best: string;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface FormAnalysis {
  label: string;
  mult: number;
}

export interface TagCorrection {
  tag: string;
  reason: string;
}

export interface EnhancedCalc {
  lambdaH: number;
  lambdaA: number;
  lambdaH_regressed: number;
  lambdaA_regressed: number;
  shrinkageH: number;
  shrinkageA: number;
  mk: MarketProbs;
  mk_low: MarketProbs;
  mk_high: MarketProbs;
  matrix: number[][];
  formH: FormAnalysis;
  formA: FormAnalysis;
  tagCorrections: TagCorrection[];
  ciH: ConfidenceInterval;
  ciA: ConfidenceInterval;
}

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
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
}

export interface TopScore {
  s: string;  // "2:1"
  p: number;  // probability
}

export interface MatchCalc {
  lambdaH: number;
  lambdaA: number;
  lambdaH_raw?: number;
  lambdaA_raw?: number;
  mk: MarketProbs;
  bets: BetCalc[];
  enh: EnhancedCalc;
  topScores: TopScore[];
  ov: number | null;  // overround
  hasValue: boolean;
  hasOdds: boolean;
  warnings?: { level: "error" | "warning"; message: string }[];
}

export interface ProcessedMatch extends RawMatch {
  idx: number;
  calc: any;  // Dixon-Coles engine returns dynamic calc object
}

// ─── Odds ────────────────────────────────────────────────────────────

export interface OddsData {
  h?: string;
  d?: string;
  a?: string;
  o25?: string;
  u25?: string;
  btts?: string;
  _source?: "live" | "manual";
  _sharp?: { h: number | null; d: number | null; a: number | null; book?: string };
  _bookmakers?: number;
  _fetched?: string;
  [key: string]: any;  // allow extra fields from live odds
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
  isValue: boolean;
}

// ─── Profile ─────────────────────────────────────────────────────────

export interface ProfileData {
  risk_profile: "K" | "M" | "A";
  bankroll: number;
  display_name: string;
}

// ─── League ──────────────────────────────────────────────────────────

export interface LeagueConfig {
  name: string;
  hf: number;
  avg: number;
}

export interface LeagueStatus {
  label: string;
  date: string;
}

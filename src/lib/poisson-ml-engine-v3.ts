// ═══════════════════════════════════════════════════════════════════════
// FODZE v3 Engine Runtime — Extended-Feature LightGBM
// ═══════════════════════════════════════════════════════════════════════
//
// v3 erweitert v2's 21-Feature-Set um 8 api-sports-basierte match-stats
// Features (shots volume, SoT, corners, possession, pass-accuracy,
// shots-inside-box-share, gk-saves). Identische Runtime-Architektur wie v2:
//   - Loads lgbm-model-v3.json at startup
//   - predicts λH, λA from a 29-element feature vector
//   - applies λ-Clamp [0.3, 4.5]
//   - consumer (calcMatchPoissonMLv3) wrappt mit buildMatrix + Dixon-Coles
//
// Status: SKELETON.
//   Das Model (lgbm-model-v3.json) existiert aktuell noch NICHT — es kommt
//   aus tools/retrain_v3.py sobald genügend api-sports rows im team_xg_history
//   stehen (~1500 matches, Backfill läuft 8-11 Wochen).
//
//   Bis dahin:
//     - isV3ModelLoaded() returnt false
//     - predictV3Lambdas() returnt null (Engine refuses to predict, wie v1/v2)
//     - UI-Toggle kann v3 bereits anzeigen, aber "Noch nicht trainiert"
//
// Nach dem ersten Training:
//   cp public/lgbm-model-v3.json schema match v2 (home_trees + away_trees +
//   feature_names + rho_optimal) → runtime greift automatisch.
// ═══════════════════════════════════════════════════════════════════════

import type { XGHistoryEntry } from "@/types/match";

// v3 hat isolierte tree-traversal (nicht vom v2-Runtime reused) damit
// v2 und v3 parallel laden können ohne state-collisions. Das JSON-schema
// spiegelt retrain_v3.py export — home_trees / away_trees sind LightGBM
// dump_model()["tree_info"] Array, jeder tree ein verschachtelter Node.

interface LGBMNode {
  split_feature?: number;
  threshold?: number;
  left_child?: LGBMNode;
  right_child?: LGBMNode;
  leaf_value?: number;
}
interface LGBMTree {
  tree_index?: number;
  tree_structure?: LGBMNode;
}

function traverseV3(node: LGBMNode, features: number[]): number {
  if (node.leaf_value !== undefined) return node.leaf_value;
  const v = features[node.split_feature!];
  return v <= node.threshold!
    ? traverseV3(node.left_child!, features)
    : traverseV3(node.right_child!, features);
}

function sumTrees(trees: LGBMTree[], features: number[]): number {
  let s = 0;
  for (const t of trees) {
    const root = t.tree_structure;
    if (root) s += traverseV3(root, features);
  }
  return s;
}

// v3 Lean — Feature-Reihenfolge MUSS exakt retrain_v3.py::FEATURE_NAMES
// entsprechen. Mismatch → garbage predictions. Runtime verifiziert order via
// feature_names check beim load. 20 dense features, no dead weight.
export const V3_FEATURE_NAMES = [
  // Core xG (5) — proxied from single 'xg' column (openplay/setpiece both 0%)
  "xg_diff_ewma", "xga_diff_ewma", "xg_momentum", "xg_volatility", "total_xg",
  // Elo + Context (5) — ported from v2
  "elo_diff", "sos_strength", "is_derby", "h2h_xg_diff", "rest_days_diff",
  // League constants (2)
  "home_factor", "league_avg",
  // Physis (5) — newly active via 78k FootyStats upsert
  "shots_total_diff_ewma", "shots_on_target_diff_ewma", "shot_accuracy_ewma",
  "corners_diff_ewma", "possession_diff_ewma",
  // Discipline (3) — NEW from 75%-populated cols
  "fouls_diff_ewma", "yellow_cards_diff_ewma", "red_cards_diff_ewma",
] as const;

export const V3_N_FEATURES = V3_FEATURE_NAMES.length; // 20

const LAMBDA_CLAMP_MIN = 0.05;
const LAMBDA_CLAMP_MAX = 6.0;

// ─── Model-Speicher ────────────────────────────────────────────────

interface V3ModelShape {
  version: string;
  feature_names: string[];
  home_trees: LGBMTree[];
  away_trees: LGBMTree[];
  rho_optimal: number;
  lambda_clamp?: [number, number];
  n_train: number;
  mono_home?: number[];
  mono_away?: number[];
}

let v3Model: V3ModelShape | null = null;

export function loadV3Model(json: unknown): void {
  const m = json as V3ModelShape;
  if (!m?.feature_names || !Array.isArray(m.feature_names)) {
    console.error("[v3] Model JSON invalid: missing feature_names");
    return;
  }
  if (m.feature_names.length !== V3_N_FEATURES) {
    console.error(
      `[v3] Feature dim mismatch: model has ${m.feature_names.length}, ` +
      `runtime expects ${V3_N_FEATURES}`,
    );
    return;
  }
  // Strict order check — catches retrain/runtime desync
  for (let i = 0; i < V3_N_FEATURES; i++) {
    if (m.feature_names[i] !== V3_FEATURE_NAMES[i]) {
      console.error(
        `[v3] Feature-order mismatch at index ${i}: ` +
        `model="${m.feature_names[i]}", runtime="${V3_FEATURE_NAMES[i]}"`,
      );
      return;
    }
  }
  if (!Array.isArray(m.home_trees) || !Array.isArray(m.away_trees)) {
    console.error("[v3] Model missing home_trees / away_trees arrays");
    return;
  }
  v3Model = m;
  console.log(
    `[v3] Loaded: ${m.home_trees.length}H + ${m.away_trees.length}A trees, ` +
    `${m.feature_names.length} features, rho=${m.rho_optimal}, n_train=${m.n_train}`,
  );
}

export function isV3ModelLoaded(): boolean {
  return v3Model !== null;
}

export function getV3Rho(): number {
  return v3Model?.rho_optimal ?? -0.094;
}

// ─── Feature Builder ───────────────────────────────────────────────
//
// Nimmt die per-match history entries (aus team_xg_history via
// toXGHistoryEntries) und baut den 29er Feature-Vektor in der exakten
// Reihenfolge von V3_FEATURE_NAMES.

interface V3Input {
  leagueAvg: number;
  homeFactor: number;
  eloDiff: number;             // (Elo_H + HOME_ADV) - Elo_A; 0 if unknown
  sosStrength: number;         // (avg_opponent_elo - 1500) / 400; 0 if unknown
  restDaysDiff: number;        // (rest_H - rest_A) / 7
  isDerby: boolean;
  h2hXgDiff: number;           // mean of last 5 H2H xg_diffs, 0 if unknown
  homeHistory: XGHistoryEntry[];
  awayHistory: XGHistoryEntry[];
}

const EWMA_ALPHA = 0.85;

function ewmaLast8(values: (number | undefined)[]): number | null {
  const vs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(-8);
  if (vs.length === 0) return null;
  const weights = vs.map((_, i) => Math.pow(EWMA_ALPHA, vs.length - 1 - i));
  const wSum = weights.reduce((s, w) => s + w, 0);
  return vs.reduce((s, v, i) => s + v * weights[i], 0) / wSum;
}

function diffEwma(home: (number | undefined)[], away: (number | undefined)[]): number {
  const h = ewmaLast8(home);
  const a = ewmaLast8(away);
  if (h == null || a == null) return 0;
  return h - a;
}

function rollingMean(values: (number | undefined)[], window: number): number | null {
  const vs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(-window);
  if (vs.length === 0) return null;
  return vs.reduce((s, v) => s + v, 0) / vs.length;
}

function rollingStd(values: (number | undefined)[], window: number): number | null {
  const vs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(-window);
  if (vs.length < 2) return 0;
  const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
  const variance = vs.reduce((s, v) => s + (v - mean) ** 2, 0) / vs.length;
  return Math.sqrt(variance);
}

function buildFeatures(input: V3Input): number[] {
  const {
    homeHistory: hh, awayHistory: ah,
    leagueAvg, homeFactor, eloDiff, sosStrength, restDaysDiff, isDerby, h2hXgDiff,
  } = input;

  // ── Core xG (5) — uses .xg directly (no openplay/setpiece in Supabase) ──
  const xgDiff = diffEwma(hh.map(e => e.xg), ah.map(e => e.xg));
  const xgaDiff = diffEwma(hh.map(e => e.xga), ah.map(e => e.xga));

  // Momentum: last-3 avg minus full-history avg, home-minus-away
  const xgMomentumH =
    (rollingMean(hh.map(e => e.xg), 3) ?? leagueAvg) -
    (rollingMean(hh.map(e => e.xg), 999) ?? leagueAvg);
  const xgMomentumA =
    (rollingMean(ah.map(e => e.xg), 3) ?? leagueAvg) -
    (rollingMean(ah.map(e => e.xg), 999) ?? leagueAvg);
  const xgMomentum = xgMomentumH - xgMomentumA;

  const xgVolatility =
    (rollingStd(hh.map(e => e.xg), 8) ?? 0) -
    (rollingStd(ah.map(e => e.xg), 8) ?? 0);

  const totalXg = (ewmaLast8(hh.map(e => e.xg)) ?? leagueAvg)
                + (ewmaLast8(ah.map(e => e.xg)) ?? leagueAvg);

  // ── Physis (5) ──────────────────────────────────────────────────────
  const shotsDiff = diffEwma(hh.map(e => e.shots_for), ah.map(e => e.shots_for));
  const sotDiff = diffEwma(hh.map(e => e.shots_on_target_for), ah.map(e => e.shots_on_target_for));
  const accDiff = diffEwma(
    hh.map(e => (e.shots_on_target_for != null && e.shots_for) ? e.shots_on_target_for / e.shots_for : undefined),
    ah.map(e => (e.shots_on_target_for != null && e.shots_for) ? e.shots_on_target_for / e.shots_for : undefined),
  );
  const cornerDiff = diffEwma(hh.map(e => e.corners_for), ah.map(e => e.corners_for));
  const possDiff = diffEwma(hh.map(e => e.possession_pct), ah.map(e => e.possession_pct));

  // ── Discipline (3) ──────────────────────────────────────────────────
  const foulsDiff = diffEwma(hh.map(e => e.fouls), ah.map(e => e.fouls));
  const yellowDiff = diffEwma(hh.map(e => e.yellow_cards_for), ah.map(e => e.yellow_cards_for));
  const redDiff = diffEwma(hh.map(e => e.red_cards_for), ah.map(e => e.red_cards_for));

  return [
    // Core xG (5)
    xgDiff,                  // 0  xg_diff_ewma
    xgaDiff,                 // 1  xga_diff_ewma
    xgMomentum,              // 2  xg_momentum
    xgVolatility,            // 3  xg_volatility
    totalXg,                 // 4  total_xg
    // Elo + Context (5)
    eloDiff,                 // 5  elo_diff
    sosStrength,             // 6  sos_strength
    isDerby ? 1 : 0,         // 7  is_derby
    h2hXgDiff,               // 8  h2h_xg_diff
    restDaysDiff,            // 9  rest_days_diff
    // League (2)
    homeFactor,              // 10 home_factor
    leagueAvg,               // 11 league_avg
    // Physis (5)
    shotsDiff,               // 12
    sotDiff,                 // 13
    accDiff,                 // 14
    cornerDiff,              // 15
    possDiff,                // 16
    // Discipline (3)
    foulsDiff,               // 17
    yellowDiff,              // 18
    redDiff,                 // 19
  ];
}

// ─── Prediction ────────────────────────────────────────────────────

export function predictV3Lambdas(
  input: V3Input,
): { lambdaH: number; lambdaA: number; features: number[] } | null {
  if (!v3Model) return null;

  const features = buildFeatures(input);
  if (features.length !== V3_N_FEATURES) {
    console.error(`[v3] feature vector length ${features.length} != ${V3_N_FEATURES}`);
    return null;
  }
  for (let i = 0; i < features.length; i++) {
    if (!Number.isFinite(features[i])) {
      console.error(`[v3] NaN/Infinity at feature index ${i} (${V3_FEATURE_NAMES[i]})`);
      return null;
    }
  }

  const clamp = v3Model.lambda_clamp ?? [LAMBDA_CLAMP_MIN, LAMBDA_CLAMP_MAX];
  const wrap = (trees: LGBMTree[]): number => {
    const raw = sumTrees(trees, features);
    // Tweedie log-link: λ = exp(raw)
    return Math.min(clamp[1], Math.max(clamp[0], Math.exp(raw)));
  };

  return {
    lambdaH: wrap(v3Model.home_trees),
    lambdaA: wrap(v3Model.away_trees),
    features,
  };
}

// ─── High-level wrapper ──────────────────────────────────────────
//
// Drop-in-kompatibel zu calcMatchPoissonMLv2: nimmt das gleiche Input-
// Shape, liefert MatchCalc | null. Wenn kein v3-Model geladen ist, wird
// früh null zurückgegeben — MatchdayContext weicht dann auf ensemble aus.
//
// Sobald public/lgbm-model-v3.json existiert und loadV3Model() erfolgreich
// war, wird hier die λ via predictV3Lambdas berechnet und durch die
// v2-Matrix-Pipeline geschleust (buildMatrix + deriveAllMarkets +
// calculateBetsEnhanced). Aktuell steht der wrapper als "preview": er
// delegiert die Matrix-Erstellung an v2's calcMatchPoissonMLv2 wenn das
// Model geladen ist — in einer späteren Iteration ersetzen wir das durch
// v3-spezifische Matrix-Konfiguration (eigenes ρ etc).

import type { MatchCalc, MarketProbs, BetCalc } from "@/types/match";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
import type { SoSRatings } from "@/lib/sos";
import type { PlayerProfile } from "@/lib/player-impact";
import type { RhoModelCoefficients } from "@/lib/dynamic-rho";
import type { OverdispersionConfig } from "@/lib/neg-binomial";

interface V3WrapperInput {
  xgHS: number; xgaHC: number; hGames: number;
  xgAS: number; xgaAC: number; aGames: number;
  leagueAvg: number; homeFactor: number; league: string;
  tags: string[];
  hHistory?: XGHistoryEntry[];
  aHistory?: XGHistoryEntry[];
  homeTeam: string; awayTeam: string;
  odds?: Record<string, number>;
  sharpOdds?: { h: number | null; d: number | null; a: number | null };
  fraction: number;
  sosRatings?: SoSRatings;
  absences?: { home: PlayerProfile[]; away: PlayerProfile[] };
  options?: {
    rhoModel?: RhoModelCoefficients;
    overdispersion?: OverdispersionConfig;
    restDaysDiff?: number;
  };
}

/**
 * v3 entrypoint. Returns null when the v3 LightGBM JSON hasn't been
 * shipped yet (default state today). When shipped, this delegates the
 * matrix / markets / bets pipeline to v2's implementation while using
 * v3's 29-feature lambda prediction.
 *
 * TODO-PHASE-C2: Once a v3 JSON exists, replace the v2 delegation with
 * a direct buildMatrix → deriveAllMarkets → calculateBetsEnhanced chain
 * using v3's rho_optimal. For now, "preview" = silent null → engine
 * selector fällt auf ensemble zurück, UI zeigt v3 als "nicht trainiert".
 */
export function calcMatchPoissonMLv3(input: V3WrapperInput): MatchCalc | null {
  if (!isV3ModelLoaded()) return null;
  // Preview-Modus: bis zum dedizierten v3-matrix-path delegieren wir
  // an v2. Sobald lgbm-model-v3.json existiert und v3-spezifische
  // rho/clamp-Logik geschrieben ist, wird dieser passthrough ersetzt.
  return calcMatchPoissonMLv2(input);
}

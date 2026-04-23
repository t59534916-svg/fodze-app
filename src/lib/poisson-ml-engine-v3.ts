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

// Feature-Reihenfolge MUSS exakt retrain_v3.py::FEATURE_NAMES entsprechen.
// Mismatch → garbage predictions. Runtime verifiziert via feature_names check.
export const V3_FEATURE_NAMES = [
  // v2's 21 features (unverändert)
  "npxg_diff_ewma", "npxga_diff_ewma", "elo_diff", "total_npxg",
  "home_factor", "league_avg", "rest_days_diff", "sos_strength",
  "is_derby", "npxg_momentum", "npxg_volatility", "h2h_npxg_diff",
  "ppda_ratio_diff", "deep_completions_diff",
  "setpiece_xg_share_diff", "late_game_xg_share_diff",
  "losing_state_xg_diff", "top3_xgchain_share_diff",
  "squad_rotation_rate_diff", "shot_quality_diff",
  "high_value_shot_share_diff",
  // v3 NEW (8)
  "shots_total_diff_ewma",
  "shots_on_target_diff_ewma",
  "shot_accuracy_ewma",
  "corners_diff_ewma",
  "possession_diff_ewma",
  "pass_accuracy_diff_ewma",
  "shots_inside_box_share_diff",
  "gk_saves_diff_ewma",
] as const;

export const V3_N_FEATURES = V3_FEATURE_NAMES.length; // 29

const LAMBDA_CLAMP_MIN = 0.3;
const LAMBDA_CLAMP_MAX = 4.5;

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
  eloDiff: number;            // (Elo_H - Elo_A) / 400, 0 if unknown
  restDaysDiff: number;        // (rest_H - rest_A) / 7
  isDerby: boolean;
  h2hNpxgDiff: number;         // last-5 H2H npxG diff, 0 if unknown
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

function buildFeatures(input: V3Input): number[] {
  const { homeHistory: hh, awayHistory: ah, leagueAvg, homeFactor, eloDiff, restDaysDiff, isDerby, h2hNpxgDiff } = input;

  // v2-Features (reused pattern)
  const npxgDiff = diffEwma(hh.map(e => e.npxg ?? e.xg), ah.map(e => e.npxg ?? e.xg));
  const npxgaDiff = diffEwma(hh.map(e => e.npxga ?? e.xga), ah.map(e => e.npxga ?? e.xga));
  const totalNpxg = (ewmaLast8(hh.map(e => e.npxg ?? e.xg)) ?? leagueAvg)
                  + (ewmaLast8(ah.map(e => e.npxg ?? e.xg)) ?? leagueAvg);
  const ppdaDiff = diffEwma(
    hh.map(e => (e.ppda_att && e.ppda_def) ? e.ppda_att / Math.max(1, e.ppda_def) : undefined),
    ah.map(e => (e.ppda_att && e.ppda_def) ? e.ppda_att / Math.max(1, e.ppda_def) : undefined),
  );
  const deepDiff = diffEwma(
    hh.map(e => (e.deep != null && e.deep_allowed != null) ? e.deep - e.deep_allowed : undefined),
    ah.map(e => (e.deep != null && e.deep_allowed != null) ? e.deep - e.deep_allowed : undefined),
  );

  // v3 NEW features
  const shotsDiff = diffEwma(hh.map(e => e.shots_for), ah.map(e => e.shots_for));
  const sotDiff = diffEwma(hh.map(e => e.shots_on_target_for), ah.map(e => e.shots_on_target_for));
  const accDiff = diffEwma(
    hh.map(e => (e.shots_on_target_for != null && e.shots_for) ? e.shots_on_target_for / e.shots_for : undefined),
    ah.map(e => (e.shots_on_target_for != null && e.shots_for) ? e.shots_on_target_for / e.shots_for : undefined),
  );
  const cornerDiff = diffEwma(hh.map(e => e.corners_for), ah.map(e => e.corners_for));
  const possDiff = diffEwma(hh.map(e => e.possession_pct), ah.map(e => e.possession_pct));
  const passDiff = diffEwma(hh.map(e => e.pass_pct), ah.map(e => e.pass_pct));
  const ibsDiff = diffEwma(
    hh.map(e => (e.shots_inside_box != null && e.shots_for) ? e.shots_inside_box / e.shots_for : undefined),
    ah.map(e => (e.shots_inside_box != null && e.shots_for) ? e.shots_inside_box / e.shots_for : undefined),
  );
  const saveDiff = diffEwma(hh.map(e => e.gk_saves), ah.map(e => e.gk_saves));

  return [
    npxgDiff,               // 0
    npxgaDiff,              // 1
    eloDiff,                // 2
    totalNpxg,              // 3
    homeFactor,             // 4
    leagueAvg,              // 5
    restDaysDiff,           // 6
    0,                      // 7 sos_strength — TODO wire from src/lib/sos.ts
    isDerby ? 1 : 0,        // 8
    0,                      // 9 npxg_momentum placeholder
    0,                      // 10 npxg_volatility placeholder
    h2hNpxgDiff,            // 11
    ppdaDiff,               // 12
    deepDiff,               // 13
    0, 0, 0, 0, 0, 0, 0,    // 14-20: season-level v2.1 features placeholder
    // v3 NEW
    shotsDiff, sotDiff, accDiff, cornerDiff,
    possDiff, passDiff, ibsDiff, saveDiff,
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

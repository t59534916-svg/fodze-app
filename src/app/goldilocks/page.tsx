"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import { LEAGUES, vigAdjustBest } from "@/lib/dixon-coles";
import { matchKey as canonicalMatchKey } from "@/lib/format";
import {
  validatedEngineFor,
  hasValidatedEdge,
  leagueEdgeRecord,
  expectedROIperStake,
  type ValidatedEngine,
} from "@/lib/bet-edge-policy";
import {
  computeEngineProbs,
  classifyEdgeSource,
  evaluateLatentTopology,
  type EdgeSource,
  type LatentSignals,
  type LatentTopology,
  type EpistemicTrail,
} from "@/lib/goldilocks-engine";
import {
  buildCsdVetoes,
  shieldVetoToTrail,
  isFilterShieldLoaded,
  type ShieldVeto,
} from "@/lib/filter-shield";
import { fuzzyTeamMatch, resolveTeam, canonicalizeTeamName } from "@/lib/team-resolver";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";
import { card, badge } from "@/styles/components";
import { getLeagueLiquidityTier } from "@/lib/league-liquidity";
import type { MatchdayData, RawMatch } from "@/types/match";

// ─── Constants ──────────────────────────────────────────────────────

// Display-grading thresholds (independent of per-Liga goldilocks zone).
// EDGE_GRADE_A/B classify the SHAPE of an in-zone edge; the in-zone gate
// itself is per-league via league-liquidity tiers.
const EDGE_GRADE_A = 0.05;
const EDGE_GRADE_B = 0.04;

// ─── Types ──────────────────────────────────────────────────────────

interface GoldilocksBet {
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: string;
  bestOdds: number;
  // Market-derived fair prob (Pinnacle sharp, vig-removed) — always set.
  marketFairProb: number;
  pinnacleOdds: number;
  // Engine-derived fair prob (FODZE ensemble) — set only when the stored
  // matchday JSON has enough xG data for the engine to speak.
  engineFairProb?: number;
  impliedProb: number;
  // Edge selected for display + grading (the stronger of the two sources
  // when both agree, or the only one that triggered).
  edge: number;
  marketEdge: number;
  engineEdge?: number;
  grade: "A" | "B" | "C";
  // Which source(s) detected this edge inside the Goldilocks zone.
  source: EdgeSource;
  // v1.1 Asymmetric Negation — match-level topology. Same value across every
  // market row that belongs to the same match (it's a property of the match,
  // not the market). UI surfaces vetoes + a stake-multiplier pill so users
  // see "this in-zone edge is overlaid with a Possession Trap" before sizing.
  topology?: LatentTopology;
  // v1.2 Filter-Shield — CSD regime-shift vetoes per match. Like topology,
  // this is match-level (same across all market rows for the same match).
  // Filtered to vetoes that affect the THIS bet's market (home → home+draw,
  // away → away+draw). Empty array when no veto fires for this market.
  csdVetoes?: ShieldVeto[];
  // Effective Kelly multiplier from CSD shield for this bet's market.
  // 1.0 = no veto. <1.0 = haircut applied. Composes with topology multiplier
  // when both fire (min-pool across all veto-sources).
  csdMult?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * EWMA with span=3 (α=0.5). Input is oldest-first (the shape `loadTeamXGHistory`
 * returns after its `.reverse()`). Weights for [oldest_of_3, mid, most_recent]
 * are [0.25, 0.5, 1.0] = 0.5^(k-1) with k=3,2,1. Returns null if <3 values.
 * Matches the SQL formula in `tools/v4/queries/strict_lagging.sql`.
 */
function ewma3(values: number[]): number | null {
  if (values.length < 3) return null;
  const last3 = values.slice(-3);
  const w = [0.25, 0.5, 1.0];
  let num = 0;
  let den = 0;
  for (let i = 0; i < 3; i++) {
    num += last3[i] * w[i];
    den += w[i];
  }
  return num / den;
}

/**
 * Mean of non-null numbers, requiring at least `minSamples` valid values
 * (default 3) so a single-row possession reading can't fire the M5 Heckman
 * gate on what's effectively noise. Returns null if fewer samples are valid.
 */
function safeMean(values: Array<number | null | undefined>, minSamples = 3): number | null {
  const ok = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (ok.length < minSamples) return null;
  return ok.reduce((s, v) => s + v, 0) / ok.length;
}

// ─── Styles ─────────────────────────────────────────────────────────

const S = {
  header: {
    textAlign: "center" as const, marginBottom: space[5], padding: `${space[4]}px 0`,
  },
  title: {
    fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: color.gold,
    marginTop: 0, marginBottom: space[2],
  },
  subtitle: { fontSize: fontSize.sm, color: color.textMuted },
  chips: {
    display: "flex", gap: space[2], flexWrap: "wrap" as const,
    justifyContent: "center", marginBottom: space[5],
  },
  chip: (active: boolean) => ({
    padding: `${space[2]}px ${space[4]}px`,
    borderRadius: radius.full,
    border: `1px solid ${active ? color.gold : color.border}`,
    background: active ? `${color.gold}20` : "transparent",
    color: active ? color.gold : color.textMuted,
    fontSize: fontSize.xs, fontWeight: fontWeight.medium,
    cursor: "pointer", transition: "all 0.15s",
    minHeight: 44, display: "inline-flex", alignItems: "center",
  }),
  betCard: {
    ...card(), padding: space[4], marginBottom: space[3],
    display: "block", textDecoration: "none", cursor: "pointer",
  },
  cardHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: space[3],
  },
  league: { fontSize: fontSize.xs, color: color.textMuted },
  matchName: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.text,
    marginBottom: space[3],
  },
  betRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    alignItems: "center",
    gap: space[3],
  },
  betLabel: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.text,
  },
  betOdds: {
    fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: color.textMuted,
    fontFamily: "Georgia, serif", textAlign: "center" as const,
    minWidth: 56,
  },
  edgeBox: { textAlign: "right" as const, minWidth: 64 },
  edgeValue: (e: number) => ({
    fontSize: fontSize.xl, fontWeight: fontWeight.bold,
    color: e >= EDGE_GRADE_A ? color.value : e >= EDGE_GRADE_B ? color.gold : color.textMuted,
    lineHeight: 1, fontFamily: "Georgia, serif",
  }),
  probText: { fontSize: fontSize.xs, color: color.textMuted, marginTop: 2 },
  detailRow: {
    display: "flex", justifyContent: "space-between",
    fontSize: fontSize.xs, color: color.textFaint, marginTop: space[2],
    paddingTop: space[2], borderTop: `1px solid ${color.border}`,
  },
  footer: {
    marginTop: space[6], padding: space[4],
    background: color.surface, borderRadius: radius.md,
    border: `1px solid ${color.border}`,
  },
  footerTitle: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.gold,
    marginBottom: space[2],
  },
  footerText: { fontSize: fontSize.xs, color: color.textMuted, lineHeight: 1.5 },
  empty: {
    textAlign: "center" as const, padding: `${space[7]}px ${space[4]}px`,
    color: color.textMuted, fontSize: fontSize.sm,
  },
  loading: {
    textAlign: "center" as const, padding: `${space[7]}px ${space[4]}px`,
    color: color.textFaint, fontSize: fontSize.sm,
  },
  count: {
    fontSize: 40, fontWeight: fontWeight.bold, color: color.goldShine,
    fontFamily: "Georgia, serif", lineHeight: 1,
  },
};

const GRADE_BADGE: Record<string, ReturnType<typeof badge>> = {
  A: badge("value"), B: badge("gold"), C: badge("neutral"),
};

const SOURCE_BADGE: Record<EdgeSource, ReturnType<typeof badge>> = {
  consensus: badge("value"),
  market: badge("info"),
  engine: badge("gold"),
};

const SOURCE_LABEL: Record<EdgeSource, string> = {
  consensus: "Konsens",
  market: "Markt",
  engine: "Engine",
};

const SOURCE_TOOLTIP: Record<EdgeSource, string> = {
  consensus: "Markt & FODZE-Engine stimmen überein — stärkstes Signal",
  market: "Nur Pinnacle-Sharp-Line signalisiert Edge — Engine hat keine Meinung oder widerspricht",
  engine: "Nur FODZE-Engine sieht Edge — Pinnacle preist es nicht so. In Top-Ligen eher Modell-Fehler, in Liga 3 / Greek SL real möglich",
};

// v1.1 Asymmetric Negation Protocol · veto-trap explanations. Manager-bounce
// vetoes carry the matches-since-change in the label (`MANAGER_BOUNCE_REGIME_2`),
// so we strip the suffix before lookup.
const VETO_TOOLTIP: Record<string, string> = {
  POSSESSION_TRAP:
    "Heimteam dominiert Possession (>15 pp) erzeugt aber weniger xG als es kassiert UND liegt unter 85% der Liga-Baseline. Tier-A-Liga only. Empirisch -19.8pp vs Engine-Prognose.",
  MANAGER_BOUNCE_REGIME:
    "Trainerwechsel-Regime aktiv. Erste 0-1 Spiele: 0.85× Kelly (Shake-up-Noise). Spiele 2-3: 0.92× (Honeymoon-Fade). Ab Spiel 4 wieder neutral.",
};

function vetoTooltip(veto: string): string {
  // MANAGER_BOUNCE_REGIME_2 → MANAGER_BOUNCE_REGIME for lookup
  const base = veto.replace(/_\d+$/, "");
  return VETO_TOOLTIP[base] || veto;
}

// v1.2 Filter-Shield · CSD-veto explanations. ShieldVeto.name format:
// "CSD_REGIME_SHIFT:persistent_reversal:home" → display "CSD pers-rev (home)"
const CSD_REGIME_TOOLTIP: Record<string, string> = {
  persistent_reversal:
    "Letzte 10 Spiele oszillierten (rho_1 < -0.30) UND haben Sign-Flip zwischen den letzten 3 vs vorigen 7. Empirisch +0.043 Brier-Hit in OOT-Validation (n=355) — 50 % Kelly-Haircut.",
  catastrophic:
    "Hohe Volatilität (|rho_1| < 0.30) + Sign-Flip + großes |delta_mu| > 0.50. Shadow-Mode bis 200 Production-Firings die Brier-evidence bestätigen. Stake NICHT reduziert.",
};

function csdBadgeLabel(vetoName: string): string {
  // "CSD_REGIME_SHIFT:persistent_reversal:home" → "🛡 CSD pers-rev"
  const parts = vetoName.split(":");
  const regime = parts[1] || "?";
  const short = regime === "persistent_reversal" ? "pers-rev" : regime;
  return `🛡 CSD ${short}`;
}

function csdBadgeTooltip(veto: ShieldVeto): string {
  const parts = veto.name.split(":");
  const regime = parts[1] || "?";
  const teamSide = parts[2] || "?";
  const base = CSD_REGIME_TOOLTIP[regime] || veto.reason;
  return `${base}\n\nTeam-Seite: ${teamSide}. ${veto.reason}`;
}

const MARKET_LABELS: Record<string, string> = {
  "1": "Heim", "X": "Remis", "2": "Gast", "Ü2.5": "Über 2.5", "U2.5": "Unter 2.5",
};

type FilterType = "all" | "A" | "B" | "1X2" | "OU" | "consensus" | "veto-free" | "validated";

// ─── Component ──────────────────────────────────────────────────────

export default function GoldilocksPage() {
  const { supabase, leagueStatus } = useApp();
  const [bets, setBets] = useState<GoldilocksBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [lastFetch, setLastFetch] = useState("");
  // Diagnostic: how many live-odds matches had usable engine data.
  // Surfaced in the header so users can see immediately when xG coverage
  // is blocking the Konsens filter (the root cause of a 0-Konsens result).
  const [engineCoverage, setEngineCoverage] = useState({ withEngine: 0, total: 0 });

  useEffect(() => {
    (async () => {
      setLoading(true);
      const {
        loadLiveOdds, loadLatestMatchday,
        loadTeamXGHistory, toXGHistoryEntries,
      } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);
      const allBets: GoldilocksBet[] = [];
      let totalLiveOddsMatches = 0;
      let totalWithEngine = 0;
      // Trail-batches collected across all leagues — flushed once at the end
      // to a single POST /api/persist-trails (idempotent server-side upsert).
      const trailBatches: Array<{ matchKey: string; league: string | null; trails: EpistemicTrail[] }> = [];

      await Promise.all(leagueKeys.map(async (league) => {
        try {
          // Load live odds + (optional) stored matchday in parallel. The
          // matchday JSON gives us richer context (injuries, tags, form) when
          // available, but we no longer depend on it for engine-edge — we
          // synthesize from team_xg_history directly below.
          const [odds, cached] = await Promise.all([
            loadLiveOdds(supabase, league),
            loadLatestMatchday(supabase, league).catch(() => null),
          ]);
          const ld = LEAGUES[league];
          const matchdayData: MatchdayData | null = cached?.data || null;

          // ── Batch-load xG history per unique team/venue ──────────────
          // Mapping: live_odds uses OddsAPI names; team_xg_history uses
          // Understat names. resolveTeam bridges the gap, loadTeamXGHistory
          // has a fuzzy fallback for the long tail. One fetch per (team,
          // venue) pair, all parallel — usually <1s per league.
          const uniqueHome = new Set<string>();
          const uniqueAway = new Set<string>();
          for (const o of odds) {
            uniqueHome.add(o.home_team);
            uniqueAway.add(o.away_team);
          }
          // Bridge Odds-API spellings ("Bayern Munich") to team_xg_history
          // canonicals ("FC Bayern München") via canonicalizeTeamName, which
          // knows EXTRA_LEAGUE_ALIASES on top of the registry's understat
          // field. Pure-understat lookup misses the post-2026-04 EXTRA
          // canonicals, leaving Top-5 leagues at 20–50% engine-coverage
          // and the Konsens-filter empty as a result.
          const toCanonical = (n: string) => canonicalizeTeamName(n, league);
          const historyEntries = await Promise.all([
            ...Array.from(uniqueHome).map(async (team) => {
              const hist = await loadTeamXGHistory(supabase, toCanonical(team), league, "home", 8);
              return { key: `H:${team}`, hist };
            }),
            ...Array.from(uniqueAway).map(async (team) => {
              const hist = await loadTeamXGHistory(supabase, toCanonical(team), league, "away", 8);
              return { key: `A:${team}`, hist };
            }),
          ]);
          const histByKey = new Map<string, typeof historyEntries[number]["hist"]>();
          for (const e of historyEntries) histByKey.set(e.key, e.hist);

          for (const o of odds) {
            const sh = o.sharp_h, sd = o.sharp_d, sa = o.sharp_a;
            const bh = o.best_h, bd = o.best_d, ba = o.best_a;
            if (!sh || sh <= 1 || !bh || bh <= 1 || !sd || !sa || !bd || !ba) continue;
            totalLiveOddsMatches++;

            // ── Market-edge (Pinnacle sharp, vig-removed) ──────────────
            const sharpVig = vigAdjustBest([sh, sd, sa]);
            const [pinnH, pinnD, pinnA] = sharpVig.probs;

            // ── Engine-edge (FODZE ensemble) ───────────────────────────
            // Primary path: synthesize a RawMatch from team_xg_history. This
            // works even when no stored matchday exists, which is the common
            // reality outside top-5 leagues.
            // Fallback: if a stored matchday has our teams + xg_h8 populated,
            // use its richer context (injuries/tags are only in matchday JSON).
            let enginePr: ReturnType<typeof computeEngineProbs> | null = null;
            if (ld) {
              const hHist = histByKey.get(`H:${o.home_team}`) || [];
              const aHist = histByKey.get(`A:${o.away_team}`) || [];
              const hasHistory = hHist.length > 0 && aHist.length > 0;

              // Synthetic match from xG-history sums (mirrors MatchdayContext
              // fallback). Pure function of history data — no mutation of
              // shared state.
              let synthMatch: RawMatch | null = null;
              if (hasHistory) {
                const sum = (arr: any[], key: "xg" | "xga") =>
                  +arr.reduce((s, m) => s + Number(m[key] || 0), 0).toFixed(2);
                synthMatch = {
                  home: {
                    name: o.home_team,
                    xg_h8: sum(hHist, "xg"),
                    xga_h8: sum(hHist, "xga"),
                    games: hHist.length,
                    xg_h_history: toXGHistoryEntries(hHist),
                  },
                  away: {
                    name: o.away_team,
                    xg_a8: sum(aHist, "xg"),
                    xga_a8: sum(aHist, "xga"),
                    games: aHist.length,
                    xg_a_history: toXGHistoryEntries(aHist),
                  },
                  tags: [],
                  kickoff: o.commence_time || "",
                } as RawMatch;
              }

              // Prefer matchday-JSON version when it has xg_h8 populated
              // (richer: includes injuries, tags, form). Else use synthetic.
              const mdMatch = matchdayData?.matches?.find(
                (m: RawMatch) =>
                  fuzzyTeamMatch(m.home?.name || "", o.home_team) &&
                  fuzzyTeamMatch(m.away?.name || "", o.away_team),
              );
              const matchForEngine =
                mdMatch && mdMatch.home?.xg_h8 && mdMatch.away?.xg_a8
                  ? mdMatch
                  : synthMatch;

              if (matchForEngine) {
                enginePr = computeEngineProbs({
                  match: matchForEngine,
                  league,
                  leagueAvg: ld.avg,
                  leagueHf: ld.hf,
                });
              }
            }

            if (enginePr) totalWithEngine++;

            // ── v1.1 Asymmetric Negation · evaluateLatentTopology ─────────
            // Match-level (not per-market). Cheap pure function; runs even
            // when enginePr is null (returns mult=1.0 because every gated
            // trap requires real signals). Trails are collected for a
            // single batched POST after the Promise.all.
            //
            // Self-review guard: SKIP if commence_time is missing. Otherwise
            // matchKey would float (yyyymmdd derived from Date.now()) and
            // the unique constraint (trap_kind, match_key, detected_at)
            // would never collapse re-emissions across page-reloads.
            let topology: LatentTopology | undefined;
            if (ld && enginePr && o.commence_time) {
              const hHist = histByKey.get(`H:${o.home_team}`) || [];
              const aHist = histByKey.get(`A:${o.away_team}`) || [];

              // Possession EWMA: mean of last 5 venue-specific possession_pct
              // values (which is what `team_xg_history` carries since the
              // 2026-05-07 Sofa-bridge for 16 premium tier leagues). Null in
              // un-covered leagues — the M5 Heckman gate is gated on Tier-A
              // anyway, so a null here just short-circuits the trap-check.
              const homePoss = safeMean(hHist.slice(-5).map((m) => m.possession_pct ?? null));
              const awayPoss = safeMean(aHist.slice(-5).map((m) => m.possession_pct ?? null));
              const possessionDiff =
                homePoss !== null && awayPoss !== null ? homePoss - awayPoss : null;

              // xG EWMA(3) — both raw home xG and (xG − xGA) differential.
              // span=3, weights 0.5^(k-1). Matches the SQL formula in
              // tools/v4/queries/strict_lagging.sql; both backends agree.
              const homeXg = hHist.map((m) => Number(m.xg) || 0);
              const homeXgDiff = hHist.map((m) => (Number(m.xg) || 0) - (Number(m.xga) || 0));
              const xgEwma3 = ewma3(homeXg);
              const xgDiffEwma3 = ewma3(homeXgDiff);

              const signals: LatentSignals = {
                possessionDiff,
                xgDiffEwma3,
                xgEwma3,
                // matchSinceManagerChange + tacticalWidth: not yet wired —
                // sofascore_match_managers join (M4 manager-bounce regime)
                // is a follow-up sprint. Until then the manager-bounce trap
                // is dormant for any match (multiplier stays 1.0 here).
                matchSinceManagerChange: null,
                tacticalWidth: null,
                engineHWRate: enginePr.h,
                leagueBaselineXg: ld.avg,
              };

              // Augment with match-identity for the trail record. matchKey
              // MUST match the codebase canonical format (src/lib/format.ts)
              // — same string the bets table + odds_closing_history rows use.
              // Else the CLV-decay cron's `epistemic_trails × odds_closing_history`
              // join (by match_key) silently returns nothing forever.
              const kickoffMs = new Date(o.commence_time).getTime();
              // Store kickoff in Unix SECONDS to match the migration's
              // `match_kickoff BIGINT  -- Unix epoch (sec)` and the CLV-decay
              // cron's `match_kickoff=lt.${nowUnixSec}` comparison.
              const kickoffSec = Math.floor(kickoffMs / 1000);
              const matchKey = canonicalMatchKey(league, o.home_team, o.away_team);
              // Topology only reads matchKey/kickoff/league; the rest of
              // RawMatch is unused. A minimal literal avoids re-plumbing
              // `synthMatch` (computed in the engine-block above) into this
              // scope, and decouples topology from any specific match shape.
              const matchAug = {
                home: { name: o.home_team },
                away: { name: o.away_team },
                tags: [],
                matchKey,
                kickoff: kickoffSec,
                league,
              } as unknown as RawMatch & { matchKey: string; kickoff: number; league: string };

              topology = evaluateLatentTopology(matchAug, signals);

              if (topology.epistemicTrails.length > 0) {
                trailBatches.push({
                  matchKey,
                  league,
                  trails: topology.epistemicTrails,
                });
              }
            }

            // v1.2 Filter-Shield · per-match CSD vetoes. Same data as v1.1
            // topology (matchKey/kickoff/league) but driven by per-team last-10
            // goal_diff series instead of possession+xG-EWMA. Vetoes can fire
            // even when topology doesn't (no possession data) and vice versa
            // — they're orthogonal signals stacked via MIN-pool at Kelly time.
            let csdVetoes: ShieldVeto[] = [];
            if (isFilterShieldLoaded() && o.commence_time && enginePr) {
              const hHist = histByKey.get(`H:${o.home_team}`) || [];
              const aHist = histByKey.get(`A:${o.away_team}`) || [];
              // Goal-diff series across BOTH venues (different bucketing than
              // possession's venue-specific slice). buildCsdVetoes returns []
              // when series is too short — same passthrough semantics as v1.1.
              const homeSeries = hHist.slice(-10).map((m) =>
                (Number(m.goals_for) || 0) - (Number(m.goals_against) || 0),
              );
              const awaySeries = aHist.slice(-10).map((m) =>
                (Number(m.goals_for) || 0) - (Number(m.goals_against) || 0),
              );
              const matchKeyCsd = canonicalMatchKey(league, o.home_team, o.away_team);
              csdVetoes = buildCsdVetoes(homeSeries, awaySeries, matchKeyCsd);

              if (csdVetoes.length > 0) {
                const kickoffMs = new Date(o.commence_time).getTime();
                const kickoffSec = Math.floor(kickoffMs / 1000);
                const csdTrails: EpistemicTrail[] = csdVetoes.map((v) =>
                  shieldVetoToTrail(v, matchKeyCsd, kickoffSec, enginePr.h),
                );
                trailBatches.push({
                  matchKey: matchKeyCsd,
                  league,
                  trails: csdTrails,
                });
              }
            }

            // Each market: compute BOTH edges, classify, emit row only if
            // at least one source places it in the Goldilocks zone.
            type MarketEntry = {
              key: string;
              marketFair: number;
              engineFair: number | undefined;
              bestOdds: number;
              pinnOdds: number;
            };
            const markets: MarketEntry[] = [
              { key: "1", marketFair: pinnH, engineFair: enginePr?.h, bestOdds: bh, pinnOdds: sh },
              { key: "X", marketFair: pinnD, engineFair: enginePr?.d, bestOdds: bd, pinnOdds: sd },
              { key: "2", marketFair: pinnA, engineFair: enginePr?.a, bestOdds: ba, pinnOdds: sa },
            ];

            const so25 = o.sharp_over25, su25 = o.sharp_under25;
            const bo25 = o.best_over25, bu25 = o.best_under25;
            if (so25 && so25 > 1 && bo25 && bo25 > 1) {
              const ouVig = vigAdjustBest([so25, su25 || 1.01]);
              markets.push({ key: "Ü2.5", marketFair: ouVig.probs[0], engineFair: enginePr?.o25, bestOdds: bo25, pinnOdds: so25 });
              if (bu25 && bu25 > 1) {
                markets.push({ key: "U2.5", marketFair: ouVig.probs[1], engineFair: enginePr?.u25, bestOdds: bu25, pinnOdds: su25 || 0 });
              }
            }

            for (const mkt of markets) {
              const impliedProb = 1 / mkt.bestOdds;
              const marketEdge = mkt.marketFair - impliedProb;
              const engineEdge = mkt.engineFair != null ? mkt.engineFair - impliedProb : undefined;

              const tier = getLeagueLiquidityTier(league);
              const marketInZone = marketEdge >= tier.goldilocksMin && marketEdge <= tier.goldilocksMax;
              const engineInZone = engineEdge != null && engineEdge >= tier.goldilocksMin && engineEdge <= tier.goldilocksMax;
              const source = classifyEdgeSource(marketInZone, engineInZone);
              if (!source) continue;

              // Display-edge: when both agree, use the larger of the two so
              // the grade reflects the strongest signal. When only one
              // source triggered, use that one's edge.
              const displayEdge =
                source === "consensus"
                  ? Math.max(marketEdge, engineEdge as number)
                  : source === "engine"
                  ? (engineEdge as number)
                  : marketEdge;

              const grade: "A" | "B" | "C" =
                displayEdge >= EDGE_GRADE_A ? "A" : displayEdge >= EDGE_GRADE_B ? "B" : "C";

              // v1.2 Filter-Shield: route CSD vetoes to the bet's market side.
              // 1/H/Heim → "home", X → "draw", 2/A → "away", Ü2.5 → "over",
              // U2.5 → "under". Min-pool active multipliers — shadow vetoes
              // surface in the badge but don't reduce csdMult.
              const csdSideMap: Record<string, string[]> = {
                "1": ["home"], "X": ["draw"], "2": ["away"],
                "Ü2.5": ["over"], "U2.5": ["under"],
              };
              const relevantSides = csdSideMap[mkt.key] || [];
              const marketCsdVetoes = csdVetoes.filter((v) =>
                v.appliesTo.some((s: string) => relevantSides.includes(s)),
              );
              const activeMults = marketCsdVetoes
                .filter((v) => !v.shadow)
                .map((v) => v.multiplier);
              const csdMult = activeMults.length > 0 ? Math.min(...activeMults) : 1.0;

              allBets.push({
                league, leagueName: ld?.name || league,
                homeTeam: o.home_team, awayTeam: o.away_team,
                kickoff: o.commence_time || "",
                market: mkt.key, bestOdds: mkt.bestOdds, pinnacleOdds: mkt.pinnOdds,
                marketFairProb: mkt.marketFair,
                engineFairProb: mkt.engineFair,
                impliedProb,
                edge: displayEdge,
                marketEdge,
                engineEdge,
                grade,
                source,
                topology,
                csdVetoes: marketCsdVetoes,
                csdMult,
              });
            }
          }
        } catch (err) {
          console.warn(`[Goldilocks] Failed to load odds for ${league}:`, err);
        }
      }));

      // Sort: consensus first (same edge size), then by edge descending.
      allBets.sort((a, b) => {
        if (a.source !== b.source) {
          const rank = { consensus: 0, market: 1, engine: 2 } as const;
          return rank[a.source] - rank[b.source];
        }
        return b.edge - a.edge;
      });
      setBets(allBets);
      setEngineCoverage({ withEngine: totalWithEngine, total: totalLiveOddsMatches });
      setLastFetch(new Date().toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }));
      setLoading(false);

      // Persist trails (fire-and-forget, idempotent on the server). Failures
      // are observability-only — silently no-op so a Supabase hiccup never
      // blocks the user's matchday view. Trail-batches are de-duped server-
      // side via UNIQUE (trap_kind, match_key, detected_at).
      if (trailBatches.length > 0) {
        fetch("/api/persist-trails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batches: trailBatches }),
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[goldilocks] trail persistence failed (non-fatal):", err);
        });
      }
    })();
  }, [supabase, leagueStatus]);

  const filtered = useMemo(() => {
    return bets.filter(b => {
      if (filter === "A") return b.grade === "A";
      if (filter === "B") return b.grade === "B";
      if (filter === "1X2") return ["1", "X", "2"].includes(b.market);
      if (filter === "OU") return ["Ü2.5", "U2.5"].includes(b.market);
      if (filter === "consensus") return b.source === "consensus";
      // veto-free = no trap fired → topology either absent (no engine signal)
      // or empty vetoes[] AND no active CSD shield vetoes. Both states are
      // "no asymmetric-negation veto" so we accept both. Shadow signals
      // never block — they're observability.
      if (filter === "veto-free") {
        const noTopologyVeto = !b.topology || b.topology.vetoes.length === 0;
        const noCsdVeto = !b.csdVetoes || b.csdVetoes.filter(v => !v.shadow).length === 0;
        return noTopologyVeto && noCsdVeto;
      }
      // validated = league has cross-season + cross-engine validated edge
      // (per 2026-05-21 Money-Eval investigation). 5 leagues qualify:
      // dev-03: serie_a/scottish_prem/epl; v2: la_liga/serie_b. All others
      // showed reversed or net-negative ROI across 23/24 + 25/26.
      if (filter === "validated") return hasValidatedEdge(b.league);
      return true;
    });
  }, [bets, filter]);

  const { gradeA, gradeB, gradeC, count1X2, countOU, avgEdge, countConsensus, countVetoed, countVetoFree, countValidated } = useMemo(() => {
    let a = 0, b = 0, c = 0, c1 = 0, co = 0, sum = 0, cons = 0, vetoed = 0, vetoFree = 0, validated = 0;
    for (const bet of bets) {
      if (bet.grade === "A") a++; else if (bet.grade === "B") b++; else c++;
      if (bet.market === "1" || bet.market === "X" || bet.market === "2") c1++;
      else if (bet.market === "Ü2.5" || bet.market === "U2.5") co++;
      if (bet.source === "consensus") cons++;
      const hasTopologyVeto = bet.topology && bet.topology.vetoes.length > 0;
      const hasCsdVeto = bet.csdVetoes && bet.csdVetoes.filter(v => !v.shadow).length > 0;
      if (hasTopologyVeto || hasCsdVeto) vetoed++;
      else vetoFree++;
      if (hasValidatedEdge(bet.league)) validated++;
      sum += bet.edge;
    }
    return {
      gradeA: a, gradeB: b, gradeC: c,
      count1X2: c1, countOU: co, countConsensus: cons,
      countVetoed: vetoed, countVetoFree: vetoFree, countValidated: validated,
      avgEdge: bets.length ? sum / bets.length : 0,
    };
  }, [bets]);

  if (loading) {
    return (
      <AppShell>
        <div style={S.loading} role="status" aria-live="polite">
          <div style={{ fontSize: 36, marginBottom: space[3] }} aria-hidden="true">🎯</div>
          Lade Goldilocks Bets...
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <header style={S.header}>
        <div style={S.count}>{bets.length}</div>
        <h1 style={S.title}>Goldilocks Bets</h1>
        <div style={S.subtitle}>
          Edge 2.5%–7.5% · {gradeA}× A · {gradeB}× B · {gradeC}× C · Ø {(avgEdge * 100).toFixed(1)}%
          {lastFetch && ` · ${lastFetch}`}
        </div>
        {engineCoverage.total > 0 && (
          <div style={{ ...S.subtitle, marginTop: space[2], color: engineCoverage.withEngine === 0 ? color.warn : color.textFaint }}>
            Engine-Daten: {engineCoverage.withEngine}/{engineCoverage.total} Matches
            {engineCoverage.withEngine === 0 && " — Konsens unmöglich ohne xG-Historie"}
          </div>
        )}
      </header>

      <div style={S.chips} role="tablist" aria-label="Filter">
        {([
          ["all", `Alle (${bets.length})`],
          ["validated", `🎯 Directionally Consistent (${countValidated})`],
          ["consensus", `Konsens (${countConsensus})`],
          ["veto-free", `Veto-frei (${countVetoFree})`],
          ["A", `Grade A (${gradeA})`],
          ["B", `Grade B (${gradeB})`],
          ["1X2", `1X2 (${count1X2})`],
          ["OU", `Ü/U 2.5 (${countOU})`],
        ] as [FilterType, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            style={S.chip(filter === key)}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div aria-live="polite" aria-busy={loading}>
        {filtered.length === 0 ? (
          <div style={S.empty}>
            <div style={{ fontSize: 28, marginBottom: space[3] }} aria-hidden="true">🔍</div>
            Keine Goldilocks-Bets mit diesem Filter gefunden.
          </div>
        ) : (
          filtered.map((bet, i) => (
            <Link
              key={`${bet.league}-${bet.homeTeam}-${bet.market}-${i}`}
              href={`/matchday?league=${encodeURIComponent(bet.league)}&home=${encodeURIComponent(bet.homeTeam)}&away=${encodeURIComponent(bet.awayTeam)}`}
              style={S.betCard}
              aria-label={`${bet.homeTeam} gegen ${bet.awayTeam} — ${MARKET_LABELS[bet.market] || bet.market} @ ${bet.bestOdds.toFixed(2)}, Edge ${(bet.edge * 100).toFixed(1)} Prozent, Grade ${bet.grade}`}
            >
              <div style={S.cardHeader}>
                <div style={S.league}>{bet.leagueName}</div>
                <div style={{ display: "flex", gap: space[2], alignItems: "center" }}>
                  {(() => {
                    // Cross-season-validated-edge badge (2026-05-21 Money-Eval).
                    // Shows ✅ when the bet's league has a stable cross-season +
                    // cross-engine validated edge, ⚠ otherwise.
                    const engine = validatedEngineFor(bet.league);
                    const rec = leagueEdgeRecord(bet.league);
                    const eroi = expectedROIperStake(bet.league);
                    if (engine) {
                      const tooltip = `${rec?.reason ?? ""}\nExpected ROI/stake: ${((eroi ?? 0) * 100).toFixed(1)}% (cross-season avg)\nEngine: ${engine}`;
                      return (
                        <div style={badge("value")} title={tooltip}>
                          🎯 {engine === "dev-03" ? "Dev-03" : "v2"}
                        </div>
                      );
                    }
                    if (rec) {
                      return (
                        <div style={badge("neutral")} title={rec.reason}>
                          ⚠ Nicht-direktional
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <div style={SOURCE_BADGE[bet.source]} title={SOURCE_TOOLTIP[bet.source]}>
                    {SOURCE_LABEL[bet.source]}
                  </div>
                  <div style={GRADE_BADGE[bet.grade]}>{bet.grade}</div>
                </div>
              </div>
              <div style={S.matchName}>{bet.homeTeam} vs {bet.awayTeam}</div>
              {bet.topology && bet.topology.vetoes.length > 0 && (
                <div
                  style={{
                    display: "flex", gap: space[2], flexWrap: "wrap" as const,
                    alignItems: "center", marginBottom: space[3],
                  }}
                  aria-label={`Asymmetric-Negation Veto: Kelly × ${bet.topology.stakeMultiplier.toFixed(2)}`}
                >
                  {bet.topology.vetoes.map((v) => (
                    <span key={v} style={badge("warn")} title={vetoTooltip(v)}>
                      ⚠ {v.replace(/_/g, " ")}
                    </span>
                  ))}
                  <span
                    style={{
                      fontSize: fontSize.xs, color: color.warn,
                      fontFamily: "Georgia, serif", fontWeight: fontWeight.semibold,
                    }}
                    title="Kelly-Multiplier nach v1.1 Asymmetric Negation (≤ 1.0 garantiert — Filter-as-Shield, kein Boost)"
                  >
                    Kelly × {bet.topology.stakeMultiplier.toFixed(2)}
                  </span>
                </div>
              )}
              {bet.topology && bet.topology.shadowSignals.length > 0 && bet.topology.vetoes.length === 0 && (
                <div
                  style={{
                    fontSize: fontSize.xs, color: color.textFaint,
                    marginBottom: space[3], fontStyle: "italic",
                  }}
                  title="Quarantänierter Schatten-Signal (200-Match-Burn-in läuft, beeinflusst Stake nicht)"
                >
                  Shadow: {bet.topology.shadowSignals.join(", ")}
                </div>
              )}
              {/* v1.2 Filter-Shield CSD vetoes — active firings reduce Kelly stake. */}
              {bet.csdVetoes && bet.csdVetoes.filter(v => !v.shadow).length > 0 && (
                <div
                  style={{
                    display: "flex", gap: space[2], flexWrap: "wrap" as const,
                    alignItems: "center", marginBottom: space[3],
                  }}
                  aria-label={`CSD Filter-Shield: Kelly × ${bet.csdMult?.toFixed(2) ?? "1.00"}`}
                >
                  {bet.csdVetoes.filter(v => !v.shadow).map((v) => (
                    <span key={v.name} style={badge("warn")} title={csdBadgeTooltip(v)}>
                      {csdBadgeLabel(v.name)}
                    </span>
                  ))}
                  {bet.csdMult != null && bet.csdMult < 1.0 && (
                    <span
                      style={{
                        fontSize: fontSize.xs, color: color.warn,
                        fontFamily: "Georgia, serif", fontWeight: fontWeight.semibold,
                      }}
                      title="Kelly-Multiplier nach v1.2 Filter-Shield (empirisch kalibrierte CSD regime-shift detection)"
                    >
                      Kelly × {bet.csdMult.toFixed(2)}
                    </span>
                  )}
                </div>
              )}
              {/* Shadow-mode CSD vetoes — surfaced as italic line for transparency. */}
              {bet.csdVetoes && bet.csdVetoes.filter(v => v.shadow).length > 0 && bet.csdVetoes.filter(v => !v.shadow).length === 0 && (
                <div
                  style={{
                    fontSize: fontSize.xs, color: color.textFaint,
                    marginBottom: space[3], fontStyle: "italic",
                  }}
                  title="CSD-Veto im Shadow-Mode (Burn-in läuft, Stake nicht reduziert)"
                >
                  Shadow CSD: {bet.csdVetoes.filter(v => v.shadow).map(v => csdBadgeLabel(v.name)).join(", ")}
                </div>
              )}
              <div style={S.betRow}>
                <div>
                  <div style={S.betLabel}>{MARKET_LABELS[bet.market] || bet.market}</div>
                  <div style={{ fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 }}>
                    {bet.kickoff ? new Date(bet.kickoff).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}
                  </div>
                </div>
                <div style={S.betOdds}>@ {bet.bestOdds.toFixed(2)}</div>
                <div style={S.edgeBox}>
                  <div style={S.edgeValue(bet.edge)}>+{(bet.edge * 100).toFixed(1)}%</div>
                  <div style={S.probText}>
                    {bet.source === "engine" && bet.engineFairProb != null
                      ? `Engine ${(bet.engineFairProb * 100).toFixed(0)}%`
                      : `Fair ${(bet.marketFairProb * 100).toFixed(0)}%`}
                  </div>
                </div>
              </div>
              <div style={S.detailRow}>
                <span>Markt (Pinn.): +{(bet.marketEdge * 100).toFixed(1)}%</span>
                <span>
                  Engine:{" "}
                  {bet.engineEdge != null
                    ? `${bet.engineEdge >= 0 ? "+" : ""}${(bet.engineEdge * 100).toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>

      <div style={S.footer}>
        <div style={S.footerTitle}>Was ist Goldilocks?</div>
        <div style={S.footerText}>
          Der Goldilocks Guard filtert Wetten nach dem Prinzip &quot;nicht zu klein, nicht zu groß&quot;:
          Ein Edge unter 2.5% ist statistisches Rauschen. Über 7.5% deutet auf fehlende Informationen hin.
          Die Zone 2.5%–7.5% ist der Sweet Spot — groß genug für realen Profit, klein genug um realistisch zu sein.
          Grade A (≥5%) sind die stärksten Picks, Grade B (4–5%) sind solide, Grade C (2.5–4%) marginal.
        </div>
        <div style={{ ...S.footerTitle, marginTop: space[4] }}>Zwei unabhängige Edge-Quellen</div>
        <div style={S.footerText}>
          <strong style={{ color: color.gold }}>Markt:</strong> Pinnacle-Sharp-Quote vig-bereinigt (industriestandard, stark in Top-Ligen).
          &nbsp;<strong style={{ color: color.gold }}>Engine:</strong> FODZE-Ensemble aus xG-Poisson + Elo + Logistic (unabhängig vom Markt).
          &nbsp;<strong style={{ color: color.gold }}>Konsens:</strong> beide sehen Edge — statistisch das robusteste Signal und unser Haupt-Filter für Wetten mit echter Confidence.
          Engine-Edges ohne Konsens in Top-Ligen sind vorsichtig zu behandeln (Pinnacle ist dort meist scharf);
          in unteren Ligen (Liga 3, Greek SL, League Two) kann Engine allein aber echte Fehler im Markt aufzeigen.
        </div>
        <div style={{ ...S.footerTitle, marginTop: space[4] }}>🎯 Directionally Consistent (2-Saison)</div>
        <div style={S.footerText}>
          Der <strong style={{ color: color.value }}>🎯 Filter</strong> zeigt 4 Liga mit direktionaler Konsistenz:
          positive Kelly-ROI in BEIDEN Holdouts (24/25 Walk-Forward + 25/26 Holdout).
          {" "}
          <strong style={{ color: color.gold }}>dev-03</strong> für La Liga, Scottish Premiership, Bundesliga, Primeira Liga.
          {" "}
          <strong style={{ color: color.warn }}>WICHTIG:</strong> dies ist KEIN statistisch validierter Edge —
          der empirische 2026-05-25 Audit (`bet_edge_policy_empirical_audit`) zeigt: unter realer
          per-Bet-Varianz (148%) übersteht KEINE Liga Holm-Bonferroni bei α=0.05; selbst
          aggregat-dev-03 ist p=0.227. "Direktional" heißt: beide Holdouts gleiches Vorzeichen
          + n≥40 — historisches Muster, keine Prognose.
          {" "}
          <strong style={{ color: color.warn }}>Andere Liga</strong> zeigten Reversals oder konsistent
          negative Edges — diese sind als "⚠ Nicht-direktional" gekennzeichnet. Re-validation jährlich.
        </div>
        <div style={{ ...S.footerTitle, marginTop: space[4] }}>v1.1 Asymmetric Negation — was tun die Vetos?</div>
        <div style={S.footerText}>
          Die <strong style={{ color: color.warn }}>⚠ Veto-Badges</strong> zeigen Trap-Muster aus dem Latent-Topology-Audit.
          Sie ändern <em>nichts</em> an Edge oder Grade — die Wette bleibt sichtbar — aber sie schlagen einen
          Kelly-Haircut vor (Multiplier ≤ 1.0, niemals darüber: <em>asymmetrisch</em>).
          {" "}
          <strong style={{ color: color.gold }}>Possession-Trap:</strong> nur Tier-A-Ligen, Brentford-Style toxische Dominanz.
          {" "}
          <strong style={{ color: color.gold }}>Manager-Bounce:</strong> diskrete Regime nach Trainerwechsel.
          {" "}
          Der <strong>Veto-frei</strong>-Filter blendet alle Matches mit aktiven Traps aus.
        </div>
      </div>
    </AppShell>
  );
}

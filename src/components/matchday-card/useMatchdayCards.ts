// ═══════════════════════════════════════════════════════════════════════
// src/components/matchday-card/useMatchdayCards.ts
//
// Hook producing MatchData[] for the /matchday-preview route.
//
// STATUS — POC stub returning mock data with a clear seam for real wiring.
//   Production should replace the mock fallback with:
//
//   1. fetch matchday JSON from Supabase `matchdays` table
//      (or the existing MatchdayContext)
//   2. for each match, run engine.predict() → λ_h, λ_a, probH/D/A
//   3. for the recommended bet, derive Engine vs Markt prob + edge%
//   4. compute trust-band via computeTrustBand() using live_brier_snapshots
//   5. derive Kelly multiplier via kellyMultiplier(band)
//   6. run runAllTriggers() with the prepped input shapes
//   7. join team_metadata for logo_url + color_primary
//
// Each step is annotated below with the source. None of the wiring is
// "magic" — it's a sequence of well-defined transforms.
// ═══════════════════════════════════════════════════════════════════════

"use client";

import { useEffect, useState } from "react";
import type { MatchData } from "./types";
import { MOCK_CARDS } from "./mock-data";
// import { runAllTriggers, computeTrustBand, kellyMultiplier } from "@/lib/triggers";

export type UseMatchdayCardsResult = {
  cards: MatchData[];
  loading: boolean;
  error: Error | null;
  source: "mock" | "live";
};

export interface UseMatchdayCardsOptions {
  league?: string;
  date?: string;
  /** Forces mock data even if real-data fetch would otherwise be enabled. */
  forceMock?: boolean;
}

export function useMatchdayCards(opts: UseMatchdayCardsOptions = {}): UseMatchdayCardsResult {
  const [state, setState] = useState<UseMatchdayCardsResult>({
    cards: MOCK_CARDS,
    loading: false,
    error: null,
    source: "mock",
  });

  useEffect(() => {
    if (opts.forceMock) {
      setState({ cards: MOCK_CARDS, loading: false, error: null, source: "mock" });
      return;
    }

    // TODO Production wiring:
    //
    // setState(s => ({ ...s, loading: true }));
    // (async () => {
    //   try {
    //     // 1. Matchday JSON
    //     const matchday = await loadMatchdayJSON(opts.league ?? "bundesliga", opts.date);
    //     // 2. team_metadata join
    //     const meta = await loadTeamMetadata(opts.league ?? "bundesliga");
    //     // 3. live_brier_snapshots for trust band
    //     const snapshots = await loadCalibrationSnapshots(opts.league ?? "bundesliga");
    //     // 4. live_odds for market probabilities
    //     const odds = await loadLiveOdds(matchday.matches.map(m => matchKey(m)));
    //     // 5. sofa_team_streaks + sofa_team_manager_history for triggers
    //     const triggerData = await loadTriggerExtras(matchday.matches);
    //     // 6. compose
    //     const cards = matchday.matches.map(m => composeCard(m, meta, snapshots, odds, triggerData));
    //     setState({ cards, loading: false, error: null, source: "live" });
    //   } catch (err) {
    //     setState({ cards: MOCK_CARDS, loading: false, error: err as Error, source: "mock" });
    //   }
    // })();

    // POC fallback: mock data (matches HTML preview shape)
    setState({ cards: MOCK_CARDS, loading: false, error: null, source: "mock" });
  }, [opts.league, opts.date, opts.forceMock]);

  return state;
}

// ─── Production seams (commented stubs for future wiring) ────────────

// async function loadMatchdayJSON(league: string, date?: string): Promise<RawMatchday> {
//   const { data } = await supabase
//     .from("matchdays")
//     .select("data")
//     .eq("league", league)
//     .order("created_at", { ascending: false })
//     .limit(1)
//     .single();
//   return data.data as RawMatchday;
// }
//
// async function loadTeamMetadata(league: string): Promise<TeamMetaRow[]> {
//   const { data } = await supabase
//     .from("team_metadata")
//     .select("team_name, logo_url, color_primary, color_secondary")
//     .eq("fodze_league", league);
//   return data ?? [];
// }
//
// async function loadCalibrationSnapshots(league: string): Promise<CalibrationSnapshot[]> {
//   const { data } = await supabase
//     .from("live_brier_snapshots")
//     .select("league, confidence_band, hit_rate, n, drift_pp")
//     .eq("engine", "ensemble")
//     .or(`league.eq.${league},league.eq.__overall`)
//     .order("window_end_date", { ascending: false })
//     .limit(20);
//   return (data ?? []).map(r => ({
//     league: r.league,
//     confidenceBand: r.confidence_band,
//     hitRate: r.hit_rate,
//     n: r.n,
//     driftPp: r.drift_pp ?? undefined,
//   }));
// }

// function composeCard(match, meta, snapshots, odds, triggerData): MatchData {
//   const engine = predict(match);                              // → λ_h, λ_a, probH/D/A
//   const market = vigRemove(odds[match.key]?.sharp);          // → marktProb
//   const edgePct = (engine.prob * (1/market.over25) - 1) * 100;
//   const trust = computeTrustBand({
//     league: match.league,
//     confidenceBand: [0.60, 0.70],
//     snapshots,
//   });
//   const triggers = runAllTriggers({
//     xgMarket: { league: match.league, lambdaEngine: engine.totalλ, lambdaMarket: market.totalλ },
//     coachingChange: triggerData.coaching[match.key],
//     streakPattern: triggerData.streaks[match.key],
//   });
//   return {
//     ...mapTeams(match, meta),
//     probH: Math.round(engine.probH * 100),
//     probD: Math.round(engine.probD * 100),
//     probA: Math.round(engine.probA * 100),
//     xgH: engine.λh, xgA: engine.λa, xgSum: engine.λh + engine.λa,
//     marketLabel: "Over 2.5 Goals",
//     edgePct,
//     trustBand: trust.band,
//     trustHit: trust.hitRate ?? 0,
//     trustN: trust.n,
//     trustUnderCov: trust.underCov,
//     engineProb: Math.round(engine.prob * 100),
//     marktProb: Math.round(market.prob * 100),
//     gapPp: Math.round((engine.prob - market.prob) * 100),
//     sigma2: engine.sigma2,
//     confPct: sigma2ToConfPct(engine.sigma2),
//     confLevel: sigma2ToLevel(engine.sigma2),
//     triggers,
//     betEuro: roundedKelly(edgePct, bankroll, kellyMultiplier(trust.band)),
//     kellyMult: kellyMultiplier(trust.band),
//   };
// }

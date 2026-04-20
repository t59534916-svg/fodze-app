"use client";
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { saveMatchday, loadLatestMatchday, loadLiveOdds, loadOddsHistory, loadAllTeamXGHistory, loadPlayerXGForLeague, toXGHistoryEntries, saveOddsSnapshot, deleteOddsHistory, type TeamXGMatch, type PlayerXgHistoryRow } from "@/lib/supabase";
import { matchKey } from "@/lib/format";
import { parseAbsences } from "@/lib/absence-parser";
import { buildPlayerXgIndex, hydrateAbsencesWithXG, type PlayerXgRow } from "@/lib/player-impact";
import { computeSoSRatings, type SoSRatings } from "@/lib/sos";
import { resolveBucket as resolveXGBucket } from "@/lib/xg-history-resolver";
import { ensemblePrediction, type EnsembleResult } from "@/lib/ensemble";
import {
  LEAGUES, getHomeFactor, calculateBetsEnhanced, vigAdjustBest,
  validateXGData, calcMatchEnhanced, isCalibrationActive,
  buildMatrix, deriveAllMarkets,
} from "@/lib/dixon-coles";
import { calcMatchPoissonML } from "@/lib/poisson-ml-engine";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
import { calcMatchFootBayesLambdas } from "@/lib/footbayes-engine";
import { useApp } from "./AppContext";
import { validateMatchdayJSON } from "@/lib/schemas";
import type { MatchdayData, RawMatch, OddsData, OddsSnapshot, MatchCalc, ProcessedMatch, ComboLeg, BetCalc } from "@/types/match";

interface TopTip extends BetCalc {
  home: string;
  away: string;
  matchIdx: number;
  kickoff?: string;
}

interface MatchdayContextValue {
  data: MatchdayData | null;
  loading: boolean;
  loadMsg: string;
  error: string | null;
  oddsData: Record<number, OddsData>;
  oddsHistory: Record<number, OddsSnapshot[]>;
  liveOdds: any[];
  oddsSource: "manual" | "live" | "history";
  saving: number | null;
  setOdds: (idx: number, f: string, v: string) => void;
  loadCached: (overrideLeague?: string) => Promise<boolean>;
  handleImport: (json: string) => Promise<string | null>;
  doAutoFetch: () => Promise<void>;
  handleStartManual: (matches: RawMatch[]) => Promise<void>;
  handleSaveOdds: (idx: number) => Promise<void>;
  handleDelHist: (idx: number) => Promise<void>;
  matches: RawMatch[];
  processed: ProcessedMatch[];
  valueMatches: ProcessedMatch[];
  totalStake: number;
  comboLegs: ComboLeg[];
  topTips: TopTip[];
  setData: (d: MatchdayData | null) => void;
}

const MatchdayContext = createContext<MatchdayContextValue | null>(null);

export function useMatchdayContext() {
  const ctx = useContext(MatchdayContext);
  if (!ctx) throw new Error("useMatchdayContext must be used within MatchdayProvider");
  return ctx;
}

export function MatchdayProvider({ children }: { children: React.ReactNode }) {
  const { supabase, user, league, leagueConfig, kellyFraction, effectiveBudget, calLoaded, engine } = useApp();

  const [data, setData] = useState<MatchdayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [oddsData, setOddsData] = useState<Record<number, OddsData>>({});
  const [oddsHistory, setOddsHistory] = useState<Record<number, OddsSnapshot[]>>({});
  const [liveOdds, setLiveOdds] = useState<any[]>([]);
  const [oddsSource, setOddsSource] = useState<"manual" | "live" | "history">("manual");
  const [saving, setSaving] = useState<number | null>(null);
  const [sosRatings, setSosRatings] = useState<SoSRatings | null>(null);
  // Phase 2.3: per-league player-xg index for weighted absence impact.
  // Empty Map when player_xg_history is unpopulated; hydrateAbsencesWithXG
  // returns the input absences unchanged in that case.
  const [playerXgIndex, setPlayerXgIndex] = useState<Map<string, PlayerXgRow>>(new Map());

  useEffect(() => {
    // Season code mirrors scripts/backfill-player-xg.mjs::currentSeason.
    const now = new Date();
    const yy = now.getFullYear();
    const startYear = now.getMonth() >= 6 ? yy : yy - 1;
    const season = `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
    loadPlayerXGForLeague(supabase, league, season).then((rows: PlayerXgHistoryRow[]) => {
      setPlayerXgIndex(buildPlayerXgIndex(rows));
    });
  }, [supabase, league]);

  const ld = leagueConfig;
  const frac = kellyFraction;
  const br = effectiveBudget;

  const setOdds = useCallback((idx: number, f: string, v: string) => {
    setOddsData(prev => ({ ...prev, [idx]: { ...(prev[idx] || {}), [f]: v } }));
  }, []);

  const loadCached = useCallback(async (overrideLeague?: string) => {
    const lg = overrideLeague || league;
    const cached = await loadLatestMatchday(supabase, lg);
    if (cached) {
      // Runtime validation: catch corrupted/malformed data from Supabase
      const validation = validateMatchdayJSON(cached.data);
      if (!validation.success) {
        console.error("[FODZE] Matchday validation failed:", validation.errors);
      }
      if (validation.warnings?.length) {
        console.warn("[FODZE] Matchday data warnings:", validation.warnings);
      }
      const matchdayData = validation.data ?? cached.data;

      // Enrich matches with per-match xG history from Supabase (for EWMA decay).
      // Also fills xg_h8/xga_h8 summary values from the history when the
      // matchday JSON was generated without them (the `generate-matchday.mjs`
      // script only produces fixtures+odds skeletons with xg_h8=0). Without
      // this fallback the calcMatch guard `if (!h.xg_h8) return null` would
      // bail out and no analysis would render.
      //
      // For teams with NO xG history (e.g. 3. Liga, newly promoted teams
      // without football-data coverage), we synthesize league-average xG
      // summaries so the engine can still run — same pattern as fuck-betting.
      //
      // ONE batch query for the whole league, bucketed in JS. Replaces the
      // prior N × 2 sequential waterfall (home + away per match) which cost
      // ~1.2-1.8s on 10-match days. Same fuzzy-resolver fallback behavior as
      // loadTeamXGHistory, done locally against the pre-loaded map.
      const allLeagueXG = await loadAllTeamXGHistory(supabase, lg);

      if (matchdayData.matches) {
        const lgConfig = LEAGUES[lg] || LEAGUES.bundesliga;
        const fallbackXG = lgConfig.avg * 8 * 0.55; // home scores ~55% of league total
        const fallbackXGA = lgConfig.avg * 8 * 0.45;

        // Bucket all xG rows by (team, venue), then slice each to latest 8
        // in chronological-ascending order (oldest of the 8 first — engine
        // contract). loadAllTeamXGHistory returns desc; sort asc here.
        const byTeamVenue = new Map<string, TeamXGMatch[]>();
        for (const m of allLeagueXG) {
          const key = `${m.team}|${m.venue}`;
          if (!byTeamVenue.has(key)) byTeamVenue.set(key, []);
          byTeamVenue.get(key)!.push(m);
        }
        for (const [key, arr] of byTeamVenue) {
          arr.sort((a, b) => a.match_date.localeCompare(b.match_date));
          byTeamVenue.set(key, arr.slice(-8));
        }

        // Fuzzy resolver lives in src/lib/xg-history-resolver.ts so the
        // matching behavior can be unit-tested without spinning up React +
        // Supabase; it mirrors loadTeamXGHistory (exact Understat-name
        // hit, then longest-distinctive-token substring match).
        for (const match of matchdayData.matches) {
          if (match.home?.name && !match.home.xg_h_history?.length) {
            const hist = resolveXGBucket(byTeamVenue, match.home.name, "home");
            if (hist.length > 0) {
              match.home.xg_h_history = toXGHistoryEntries(hist, `${match.home.name} H`);
              if (!match.home.xg_h8) {
                match.home.xg_h8 = +hist.reduce((s, g) => s + g.xg, 0).toFixed(2);
                match.home.xga_h8 = +hist.reduce((s, g) => s + g.xga, 0).toFixed(2);
                match.home.games = hist.length;
              }
            } else if (!match.home.xg_h8) {
              match.home.xg_h8 = +fallbackXG.toFixed(2);
              match.home.xga_h8 = +fallbackXGA.toFixed(2);
              match.home.games = 8;
            }
          }
          if (match.away?.name && !match.away.xg_a_history?.length) {
            const hist = resolveXGBucket(byTeamVenue, match.away.name, "away");
            if (hist.length > 0) {
              match.away.xg_a_history = toXGHistoryEntries(hist, `${match.away.name} A`);
              if (!match.away.xg_a8) {
                match.away.xg_a8 = +hist.reduce((s, g) => s + g.xg, 0).toFixed(2);
                match.away.xga_a8 = +hist.reduce((s, g) => s + g.xga, 0).toFixed(2);
                match.away.games = hist.length;
              }
            } else if (!match.away.xg_a8) {
              match.away.xg_a8 = +fallbackXGA.toFixed(2);
              match.away.xga_a8 = +fallbackXG.toFixed(2);
              match.away.games = 8;
            }
          }
        }
      }

      // SoS (Strength of Schedule) from the same already-loaded batch.
      // Filter to home-venue rows (one per match) to match loadLeagueXGHistory.
      try {
        const sosRows = allLeagueXG.filter(m => m.venue === "home");
        if (sosRows.length > 0) {
          const lgConfig = LEAGUES[lg] || LEAGUES.bundesliga;
          const sosMatches = sosRows.map(m => ({ team: m.team, opponent: m.opponent, xg: m.xg, xga: m.xga }));
          setSosRatings(computeSoSRatings(sosMatches, lgConfig.avg));
        }
      } catch (e) {
        // SoS is optional — engine works without it. Log anyway so a bug
        // in computeSoSRatings surfaces in devtools instead of silently
        // degrading the lambda adjustments for every user.
        console.warn("[FODZE] SoS computation failed (engine will proceed without):", (e as Error).message);
      }

      setData(matchdayData);
      const live = await loadLiveOdds(supabase, lg);
      setLiveOdds(live);

      // Load odds history for all matches in parallel (was sequential —
      // 10 matches × ~100ms each = 1s. Parallel runs in ~150ms total.)
      const matchKeys = (cached.data.matches || []).map((m: RawMatch) =>
        matchKey(lg, m.home?.name || "", m.away?.name || ""),
      );
      const histories = await Promise.all(
        matchKeys.map((k: string) => loadOddsHistory(supabase, k)),
      );

      const historyUpdates: Record<number, OddsSnapshot[]> = {};
      const oddsUpdates: Record<number, OddsData> = {};
      let anyLiveOdds = false;

      for (let i = 0; i < (cached.data.matches?.length || 0); i++) {
        const match = cached.data.matches[i];
        const hist = histories[i];
        if (hist && hist.length > 0) {
          historyUpdates[i] = hist;
          oddsUpdates[i] = hist[hist.length - 1].odds;
          continue;
        }
        const homeName = (match.home?.name || "").toLowerCase();
        const awayName = (match.away?.name || "").toLowerCase();
        const matched = live.find((lo: any) => {
          const loH = lo.home_team.toLowerCase();
          const loA = lo.away_team.toLowerCase();
          return (loH.includes(homeName) || homeName.includes(loH) ||
                  loH.split(" ").some((w: string) => w.length > 3 && homeName.includes(w))) &&
                 (loA.includes(awayName) || awayName.includes(loA) ||
                  loA.split(" ").some((w: string) => w.length > 3 && awayName.includes(w)));
        });
        if (matched && matched.best_h) {
          oddsUpdates[i] = {
            h: String(matched.best_h), d: String(matched.best_d), a: String(matched.best_a),
            o25: matched.best_over25 ? String(matched.best_over25) : "",
            u25: matched.best_under25 ? String(matched.best_under25) : "",
            _source: "live",
            _sharp: { h: matched.sharp_h, d: matched.sharp_d, a: matched.sharp_a },
            _bookmakers: matched.num_bookmakers,
            _fetched: matched.fetched_at,
          } as OddsData;
          anyLiveOdds = true;
        }
      }

      // Batch all the per-match setState calls into one update each
      if (Object.keys(historyUpdates).length > 0) setOddsHistory(prev => ({ ...prev, ...historyUpdates }));
      if (Object.keys(oddsUpdates).length > 0) setOddsData(prev => ({ ...prev, ...oddsUpdates }));
      if (anyLiveOdds) setOddsSource("live");
      return true;
    }
    return false;
  }, [league, supabase]);

  const handleImport = useCallback(async (jsonInput: string) => {
    try {
      const jsonMatch = jsonInput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Kein JSON gefunden.");
      const raw = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
      // Runtime validation: catch malformed import data
      const validation = validateMatchdayJSON(raw);
      if (!validation.success) throw new Error(`Validierung fehlgeschlagen: ${validation.errors?.join(", ")}`);
      const parsed = validation.data!;
      await saveMatchday(supabase, league, parsed.matchday || "Import", parsed, user.id);
      setData(parsed);
      return null;
    } catch (e: any) { return e.message; }
  }, [league, user.id, supabase]);

  const doAutoFetch = useCallback(async () => {
    setLoading(true); setError(null); setOddsData({}); setOddsHistory({});
    const msgs = ["Suche Spieltag...", `Lade ${ld.name}...`, "Prüfe Verletzungen...", "Analysiere Kontext..."];
    let i = 0; const iv = setInterval(() => setLoadMsg(msgs[Math.min(i++, msgs.length - 1)]), 2500);
    try {
      const resp = await fetch("/api/matchday", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ league: ld.name }) });
      const result = await resp.json();
      if (result.error) throw new Error(result.message || result.error);
      await saveMatchday(supabase, league, result.matchday, result, user.id);
      setData(result);
    } catch (e: any) { setError(e.message); setData(null); }
    finally { clearInterval(iv); setLoading(false); }
  }, [league, ld.name, user.id, supabase]);

  const handleStartManual = useCallback(async (manualMatches: RawMatch[]) => {
    if (!manualMatches.length) return;
    const result: MatchdayData = { league: ld.name, matchday: "Manuell", matches: manualMatches, data_confidence: "MANUAL", sources: ["Manuell"] };
    await saveMatchday(supabase, league, "Manuell", result, user.id);
    setData(result);
  }, [league, ld.name, user.id, supabase]);

  const handleSaveOdds = useCallback(async (idx: number) => {
    const o = oddsData[idx]; if (!o?.h && !o?.d && !o?.a) return;
    setSaving(idx);
    const match = data?.matches?.[idx];
    const key = matchKey(league, match?.home?.name || "", match?.away?.name || "");
    await saveOddsSnapshot(supabase, league, key, match?.home?.name || "", match?.away?.name || "", o, user.id);
    const hist = await loadOddsHistory(supabase, key);
    setOddsHistory(prev => ({ ...prev, [idx]: hist })); setSaving(null);
  }, [oddsData, data, league, user.id, supabase]);

  const handleDelHist = useCallback(async (idx: number) => {
    const match = data?.matches?.[idx];
    const key = matchKey(league, match?.home?.name || "", match?.away?.name || "");
    await deleteOddsHistory(supabase, key);
    setOddsHistory(prev => { const n = { ...prev }; delete n[idx]; return n; });
  }, [data, league, supabase]);

  // Computes all 3 engines per match. Expensive (~15ms per match on a warm
  // LightGBM runtime). Memoized on inputs that actually change the output —
  // deliberately NOT on `engine` so toggling the engine dropdown is instant.
  function computeAllEngines(match: RawMatch, idx: number): {
    ensembleCalc: MatchCalc;
    v1Calc: MatchCalc | null;
    v2Calc: MatchCalc | null;
    bayesCalc: MatchCalc | null;
  } | null {
    const h = match.home, a = match.away;
    if (!h?.xg_h8 || !a?.xg_a8) return null;

    const o = oddsData[idx] || {};
    const no: Record<string, number> = {};
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) { const v = parseFloat(String(o[k] ?? "")); if (v > 0) no[k] = v; }
    const matchHf = getHomeFactor(h.name, ld.hf);
    const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;

    const homeAbsencesRaw = parseAbsences(h.injuries, h.name || "");
    const awayAbsencesRaw = parseAbsences(a.injuries, a.name || "");
    // Phase 2.3: replace position-default xgShares with actual per-player
    // season xG-per-90 when player_xg_history has a match for the player.
    // teamTotalXGpg = team's average xG per match (xg_h8 sums 8 games).
    const hGamesForAbs = h.games || 8;
    const aGamesForAbs = a.games || 8;
    const homeTeamXGpg = hGamesForAbs > 0 ? (h.xg_h8 || 0) / hGamesForAbs : ld.avg;
    const awayTeamXGpg = aGamesForAbs > 0 ? (a.xg_a8 || 0) / aGamesForAbs : ld.avg;
    const homeAbsences = hydrateAbsencesWithXG(homeAbsencesRaw, playerXgIndex, homeTeamXGpg);
    const awayAbsences = hydrateAbsencesWithXG(awayAbsencesRaw, playerXgIndex, awayTeamXGpg);
    const absences =
      homeAbsences.length > 0 || awayAbsences.length > 0
        ? { home: homeAbsences, away: awayAbsences }
        : undefined;

    // sharpOdds: OddsSharpData is structurally assignable to the engine's
    //   { h|null, d|null, a|null } — the extra `book?` field is fine.
    // No options: the ML engines accept { rhoModel, overdispersion,
    //   restDaysDiff }; none are set here, and `league` is already passed
    //   as a top-level field above, so an options object would be dead.
    const mlInputs = {
      xgHS: h.xg_h8, xgaHC: h.xga_h8 || 0, hGames: h.games || 8,
      xgAS: a.xg_a8, xgaAC: a.xga_a8 || 0, aGames: a.games || 8,
      leagueAvg: ld.avg, homeFactor: matchHf, league,
      tags: match.tags || [],
      hHistory: h.xg_h_history, aHistory: a.xg_a_history,
      homeTeam: h.name, awayTeam: a.name,
      odds: no, fraction: frac,
      sharpOdds: o._sharp,
      sosRatings: sosRatings || undefined,
      absences,
    };

    // Per-engine isolation: a broken v2 model file or runtime error should
    // not crash the ensemble + v1 pipeline. Engines already return null for
    // insufficient-data cases; try/catch covers runtime failures on top.
    let v2Calc: MatchCalc | null = null;
    let v1Calc: MatchCalc | null = null;
    let bayesCalc: MatchCalc | null = null;
    try { v2Calc = calcMatchPoissonMLv2(mlInputs); }
    catch (e) { console.warn("[FODZE] poisson-ml-v2 failed:", (e as Error).message); }
    try { v1Calc = calcMatchPoissonML(mlInputs); }
    catch (e) { console.warn("[FODZE] poisson-ml-v1 failed:", (e as Error).message); }
    // footBayes (Phase 2.2) — returns null until posteriors are ingested
    // from services/footbayes/. Handled below after enh is built so we can
    // swap its λ-pair into the standard matrix pipeline.
    const bayesLambdas = (() => {
      try {
        return calcMatchFootBayesLambdas({ homeTeam: h.name, awayTeam: a.name, league });
      } catch (e) {
        console.warn("[FODZE] footbayes failed:", (e as Error).message);
        return null;
      }
    })();

    const warnings = validateXGData(h.xg_h8, h.xga_h8 || 0, h.games || 8, a.xg_a8, a.xga_a8 || 0, a.games || 8, ld.avg);
    const enh = calcMatchEnhanced(
      h.xg_h8, h.xga_h8 || 0, h.games || 8, h.form,
      a.xg_a8, a.xga_a8 || 0, a.games || 8, a.form,
      ld.avg, matchHf, match.tags || [],
      h.xg_h_history, a.xg_a_history,
      sosRatings || undefined, h.name, a.name, absences,
      { league }
    );
    const topScores: { s: string; p: number }[] = [];
    if (enh.matrix) {
      for (let i = 0; i <= 5; i++)
        for (let j = 0; j <= 5; j++)
          if (enh.matrix[i]?.[j] > 0.005) topScores.push({ s: `${i}:${j}`, p: enh.matrix[i][j] });
    }
    topScores.sort((a, b) => b.p - a.p);

    const hGames = h.games || 8, aGames = a.games || 8;
    const xgDiffPerGame = (h.xg_h8 / hGames) - (a.xg_a8 / aGames);
    const xgaDiffPerGame = ((h.xga_h8 || 0) / hGames) - ((a.xga_a8 || 0) / aGames);
    const formToPoints = (f: string | undefined) => {
      if (!f) return 7.5;
      return f.split(/\s+/).reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0);
    };
    const ensemble = ensemblePrediction(
      { H: enh.mk.H, D: enh.mk.D, A: enh.mk.A, O25: enh.mk.O25 },
      h.name, a.name,
      { xgDiffPerGame, xgaDiffPerGame, formDiff: formToPoints(h.form) - formToPoints(a.form), homeFactor: matchHf, totalXG: enh.lambdaH + enh.lambdaA },
      hasOdds ? { h: no.h, d: no.d, a: no.a } : undefined,
      h.xg_h_history, a.xg_a_history, ld.avg,
      league,
    );

    const ensembleMk = { ...enh.mk, H: ensemble.H, D: ensemble.D, A: ensemble.A, O25: ensemble.O25 };
    // Propagate sharpOdds + engine="ensemble" so Benter (Phase 1.3) can
    // blend the ensemble posterior toward Pinnacle with the ensemble-specific
    // trained weights. Convert the _sharp {h,d,a} shape into PinnacleOdds.
    const ensemblePin = o._sharp && o._sharp.h != null && o._sharp.d != null && o._sharp.a != null
      ? { sharp_h: o._sharp.h, sharp_d: o._sharp.d, sharp_a: o._sharp.a }
      : undefined;
    const ensembleBets = calculateBetsEnhanced(ensembleMk, enh.mk_low, enh.mk_high, no, frac, ensemblePin, undefined, league, "ensemble");

    const ensembleCalc: MatchCalc = {
      lambdaH: enh.lambdaH, lambdaA: enh.lambdaA,
      lambdaH_raw: enh.lambdaH_raw, lambdaA_raw: enh.lambdaA_raw,
      mk: ensembleMk, bets: ensembleBets, enh, topScores: topScores.slice(0, 5),
      ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
      hasValue: ensembleBets.some(b => b.isValue), hasOdds, warnings,
      ensemble,
    } as MatchCalc;

    // footBayes engine: wrap bayesLambdas into the standard matrix pipeline
    // so it flows through the same Benter/Calibration/Kelly path. We reuse
    // enh.mk_low/mk_high as CI bounds — the attack/defense posterior SDs
    // would be a more honest bound but the simple per-match matrix is
    // correct for the MVP display (Kelly gets dampened through the shared
    // anchor anyway).
    if (bayesLambdas) {
      const bayesMx = buildMatrix(bayesLambdas.lambdaH, bayesLambdas.lambdaA);
      const bayesMk = deriveAllMarkets(bayesMx);
      const bayesPin = o._sharp && o._sharp.h != null && o._sharp.d != null && o._sharp.a != null
        ? { sharp_h: o._sharp.h, sharp_d: o._sharp.d, sharp_a: o._sharp.a }
        : undefined;
      // Benter "engine" for the Bayes path reuses the ensemble weights so
      // we don't multiply weight-file bloat. A dedicated "bayes" entry can
      // be added to benter-weights.json post-validation if it ships.
      const bayesBets = calculateBetsEnhanced(
        bayesMk, enh.mk_low, enh.mk_high, no, frac, bayesPin, undefined, league, "ensemble",
      );
      bayesCalc = {
        lambdaH: bayesLambdas.lambdaH, lambdaA: bayesLambdas.lambdaA,
        lambdaH_raw: bayesLambdas.lambdaH, lambdaA_raw: bayesLambdas.lambdaA,
        mk: bayesMk, bets: bayesBets, enh, topScores: topScores.slice(0, 5),
        ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
        hasValue: bayesBets.some(b => b.isValue), hasOdds, warnings,
      } as MatchCalc;
    }

    return { ensembleCalc, v1Calc, v2Calc, bayesCalc };
  }

  const matches: RawMatch[] = data?.matches || [];

  // Per-match engine cache. When a user edits odds for ONE match, all OTHER
  // matches' cached engine results (lambdas, 200-iter bootstrap, Elo lookups,
  // calcMatchEnhanced) stay valid — the previous single-memo pattern forced
  // the entire 10-match day to recompute on every oddsData change even
  // though 9 matches' inputs hadn't changed.
  //
  // Cache key includes HOME+AWAY team names, not just matchIdx. A server-side
  // matchday refresh with the same count but different sort order would
  // otherwise serve another match's cached result under the same idx.
  type EngineResult = { ensembleCalc: MatchCalc; v1Calc: MatchCalc | null; v2Calc: MatchCalc | null; bayesCalc: MatchCalc | null } | null;
  const engineCache = useRef<Map<string, EngineResult>>(new Map());
  const lastVersionRef = useRef<string>("");

  const cacheVersionKey = useMemo(() => {
    const matchIds = (data?.matches || [])
      .map(m => `${m.home?.name}:${m.away?.name}`)
      .join(",");
    // Include playerXgIndex size so post-load hydration invalidates the
    // memo cache and absences get re-enriched without a manual refresh.
    return `${league}|${ld.avg}|${ld.hf}|${frac}|${calLoaded}|${sosRatings ? "y" : "n"}|pxg${playerXgIndex.size}|${matchIds}`;
  }, [league, ld.avg, ld.hf, frac, calLoaded, sosRatings, data, playerXgIndex]);

  const allEngineCalcs = useMemo(() => {
    // Clear inline before lookups — useEffect fires AFTER render, which
    // would let one render tick serve stale cache entries on version
    // change (e.g., league switch with new SoS).
    if (lastVersionRef.current !== cacheVersionKey) {
      engineCache.current.clear();
      lastVersionRef.current = cacheVersionKey;
    }
    return matches.map((m: RawMatch, i: number) => {
      const cacheKey = `${m.home?.name}|${m.away?.name}|${JSON.stringify(oddsData[i] || {})}`;
      const cached = engineCache.current.get(cacheKey);
      if (cached !== undefined) return cached;
      const result = computeAllEngines(m, i);
      engineCache.current.set(cacheKey, result);
      return result;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersionKey, oddsData]);

  // ── Shadow-log: fire-and-forget POST after engines finish ──
  // Captures each variant's 1X2/O25 posterior for later OOT evaluation
  // against odds_closing_history.ft_result. Dedup lives at 3 levels:
  //   1. sessionStorage below (same-session re-navigation = noop)
  //   2. /api/shadow-log upsert(ignoreDuplicates: true)
  //   3. DB UNIQUE(match_key, engine_variant, predicted_date)
  // Network failure must NEVER surface in the UI — all errors swallowed.
  useEffect(() => {
    if (!user?.id) return;
    if (!matches.length || !allEngineCalcs.length) return;
    if (typeof window === "undefined" || typeof sessionStorage === "undefined") return;

    const todayUTC = new Date().toISOString().slice(0, 10);
    type Entry = {
      match_key: string; league: string;
      home_team: string; away_team: string;
      kickoff: string | null;
      engine_variant: "ensemble" | "poisson-ml" | "poisson-ml-v2" | "footbayes-hierarchical";
      prob_h: number; prob_d: number; prob_a: number;
      prob_o25: number | null;
      feature_version: string;
    };
    const toLog: Entry[] = [];

    // Best-effort ISO kickoff: match's kickoff is typically "HH:mm" while
    // the matchday-root date holds the full ISO date. If either is missing
    // or malformed we send null — the `kickoff` column is nullable and
    // we'd rather log without kickoff than skip the whole prediction.
    const baseDate = data?.date && /^\d{4}-\d{2}-\d{2}/.test(data.date) ? data.date.slice(0, 10) : null;

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const calcs = allEngineCalcs[i];
      if (!calcs || !m.home?.name || !m.away?.name) continue;

      let kickoffIso: string | null = null;
      if (m.kickoff && /^\d{4}-\d{2}-\d{2}T/.test(m.kickoff)) {
        kickoffIso = m.kickoff;
      } else if (baseDate && m.kickoff && /^\d{1,2}:\d{2}$/.test(m.kickoff)) {
        const [hh, mm] = m.kickoff.split(":");
        kickoffIso = `${baseDate}T${hh.padStart(2, "0")}:${mm}:00.000Z`;
      }

      const mKey = matchKey(league, m.home.name, m.away.name);
      const variants: { v: Entry["engine_variant"]; c: MatchCalc | null | undefined }[] = [
        { v: "ensemble", c: calcs.ensembleCalc },
        { v: "poisson-ml", c: calcs.v1Calc },
        { v: "poisson-ml-v2", c: calcs.v2Calc },
        { v: "footbayes-hierarchical", c: calcs.bayesCalc },
      ];
      for (const { v, c } of variants) {
        if (!c?.mk) continue;
        const { H, D, A, O25 } = c.mk;
        if (!(Number.isFinite(H) && Number.isFinite(D) && Number.isFinite(A))) continue;
        if (Math.abs(H + D + A - 1) >= 0.05) continue;  // drop stale/broken rows before POST

        const dedupKey = `shadow:${mKey}:${v}:${todayUTC}`;
        try { if (sessionStorage.getItem(dedupKey)) continue; } catch { /* private mode */ }
        toLog.push({
          match_key: mKey,
          league,
          home_team: m.home.name,
          away_team: m.away.name,
          kickoff: kickoffIso,
          engine_variant: v,
          prob_h: H, prob_d: D, prob_a: A,
          prob_o25: Number.isFinite(O25) ? O25 : null,
          feature_version: "v1",
        });
        try { sessionStorage.setItem(dedupKey, "1"); } catch { /* noop */ }
      }
    }

    if (toLog.length === 0) return;

    fetch("/api/shadow-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ predictions: toLog }),
      keepalive: true,
    }).catch((e) => {
      console.warn("[FODZE] shadow-log post failed:", (e as Error).message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEngineCalcs, matches, league, user?.id, data?.date]);

  // Outer memo: cheap — picks primary from the precomputed 3 based on
  // currently selected engine. Switching engines is now microseconds
  // instead of re-running LightGBM/GLM/ensemble for every match.
  //
  // `allEnginesMk` is constructed on a SHALLOW COPY of the chosen primary
  // so the cached engine calcs in `allEngineCalcs` stay immutable; an
  // earlier version mutated primary in place, which worked but left the
  // cached ensembleCalc/v1Calc/v2Calc objects drifting between engine
  // toggles (benign in practice, trap for refactors).
  const processed: ProcessedMatch[] = useMemo(() =>
    matches.map((m: RawMatch, i: number) => {
      const all = allEngineCalcs[i];
      if (!all) return { ...m, idx: i, calc: null };
      const chosen =
        engine === "poisson-ml-v2" && all.v2Calc ? all.v2Calc :
        engine === "poisson-ml" && all.v1Calc ? all.v1Calc :
        engine === "footbayes-hierarchical" && all.bayesCalc ? all.bayesCalc :
        all.ensembleCalc;
      const primary: MatchCalc = {
        ...chosen,
        allEnginesMk: {
          "ensemble-v1": all.ensembleCalc.mk,
          "poisson-ml": all.v1Calc?.mk || null,
          "poisson-ml-v2": all.v2Calc?.mk || null,
          "footbayes-hierarchical": all.bayesCalc?.mk || null,
        },
      };
      return { ...m, idx: i, calc: primary };
    }),
    [matches, allEngineCalcs, engine]
  );
  const valueMatches = useMemo(() => processed.filter((m: ProcessedMatch) => m.calc?.hasValue), [processed]);
  const totalStake = useMemo(() => valueMatches.reduce((sum: number, m: ProcessedMatch) =>
    sum + (m.calc?.bets ?? []).filter((b: BetCalc) => b.isValue).reduce((s: number, b: BetCalc) => s + b.kelly * br, 0), 0),
    [valueMatches, br]);

  const comboLegs = useMemo(() => {
    const legs: ComboLeg[] = [];
    for (const m of processed) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (b.quote <= 0) continue;
        const ev = b.pModel * b.quote - 1;
        const edge = b.pModel - (1 / b.quote);
        legs.push({
          id: `${m.idx}-${b.label}`,
          label: `${b.label} ${m.home?.name?.split(" ").pop() || ""}–${m.away?.name?.split(" ").pop() || ""}`,
          match: `${m.home?.name} — ${m.away?.name}`,
          pModel: b.pModel, quote: b.quote,
          isBanker: false,
          ev,
          edge,
          evMultiplier: ev > 0 ? 1 + ev : 0.5,
        });
      }
    }
    return legs;
  }, [processed]);

  const topTips = useMemo(() => {
    // Collect best bet per match (no contradictions like Ü2.5 + U2.5 from same game)
    const bestPerMatch = new Map<number, TopTip>();
    for (const m of processed) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (!b.isValue || b.edge <= 0) continue;
        const existing = bestPerMatch.get(m.idx);
        if (!existing || (b.ev || b.edge) > (existing.ev || existing.edge)) {
          bestPerMatch.set(m.idx, { ...b, home: m.home?.name, away: m.away?.name, matchIdx: m.idx, kickoff: m.kickoff });
        }
      }
    }
    const tips = Array.from(bestPerMatch.values());
    tips.sort((a, b) => (b.ev || b.edge) - (a.ev || a.edge));
    return tips.slice(0, 5);
  }, [processed]);

  const value = useMemo(() => ({
    data, loading, loadMsg, error,
    oddsData, oddsHistory, liveOdds, oddsSource, saving,
    setOdds, loadCached, handleImport, doAutoFetch, handleStartManual,
    handleSaveOdds, handleDelHist,
    matches, processed, valueMatches, totalStake, comboLegs, topTips, setData,
  }), [data, loading, loadMsg, error, oddsData, oddsHistory, liveOdds, oddsSource, saving,
    setOdds, loadCached, handleImport, doAutoFetch, handleStartManual, handleSaveOdds, handleDelHist,
    matches, processed, valueMatches, totalStake, comboLegs, topTips]);

  return <MatchdayContext.Provider value={value}>{children}</MatchdayContext.Provider>;
}

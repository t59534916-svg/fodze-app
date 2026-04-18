"use client";
import { createContext, useContext, useState, useCallback, useMemo, useRef } from "react";
import { saveMatchday, loadLatestMatchday, loadLiveOdds, loadOddsHistory, loadAllTeamXGHistory, toXGHistoryEntries, saveOddsSnapshot, deleteOddsHistory, type TeamXGMatch } from "@/lib/supabase";
import { matchKey } from "@/lib/format";
import { parseAbsences } from "@/lib/absence-parser";
import { computeSoSRatings, type SoSRatings } from "@/lib/sos";
import { TEAM_SCRAPER_MAP } from "@/lib/scrapers/team-map";
import { ensemblePrediction, type EnsembleResult } from "@/lib/ensemble";
import {
  LEAGUES, getHomeFactor, calculateBetsEnhanced, vigAdjustBest,
  validateXGData, calcMatchEnhanced, isCalibrationActive,
} from "@/lib/dixon-coles";
import { calcMatchPoissonML } from "@/lib/poisson-ml-engine";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
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

        // Mirrors loadTeamXGHistory fuzzy logic: exact team first, then
        // longest-distinctive-token substring match against the bucket keys.
        const resolveBucket = (team: string, venue: "home" | "away"): TeamXGMatch[] => {
          const mapped = TEAM_SCRAPER_MAP[team];
          const understat = mapped?.understat || team;
          const exact = byTeamVenue.get(`${understat}|${venue}`);
          if (exact && exact.length > 0) return exact;

          const tokens = team
            .toLowerCase()
            .replace(/[._]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3 && !/^(fc|sc|sv|vfl|vfb|tsg|tsv|rb|afc|the|club)$/.test(w));
          if (tokens.length === 0) return [];
          const probe = tokens.sort((a, b) => b.length - a.length)[0];
          for (const [k, arr] of byTeamVenue) {
            const [t, v] = k.split("|");
            if (v === venue && t.toLowerCase().includes(probe)) return arr;
          }
          return [];
        };

        for (const match of matchdayData.matches) {
          if (match.home?.name && !match.home.xg_h_history?.length) {
            const hist = resolveBucket(match.home.name, "home");
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
            const hist = resolveBucket(match.away.name, "away");
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
      } catch (e) { /* SoS is optional — engine works without it */ }

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
  } | null {
    const h = match.home, a = match.away;
    if (!h?.xg_h8 || !a?.xg_a8) return null;

    const o = oddsData[idx] || {};
    const no: Record<string, number> = {};
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) { const v = parseFloat(String(o[k] ?? "")); if (v > 0) no[k] = v; }
    const matchHf = getHomeFactor(h.name, ld.hf);
    const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;

    const homeAbsences = parseAbsences(h.injuries, h.name || "");
    const awayAbsences = parseAbsences(a.injuries, a.name || "");
    const absences =
      homeAbsences.length > 0 || awayAbsences.length > 0
        ? { home: homeAbsences, away: awayAbsences }
        : undefined;

    const mlInputs = {
      xgHS: h.xg_h8, xgaHC: h.xga_h8 || 0, hGames: h.games || 8,
      xgAS: a.xg_a8, xgaAC: a.xga_a8 || 0, aGames: a.games || 8,
      leagueAvg: ld.avg, homeFactor: matchHf, league,
      tags: match.tags || [],
      hHistory: h.xg_h_history, aHistory: a.xg_a_history,
      homeTeam: h.name, awayTeam: a.name,
      odds: no, fraction: frac,
      sharpOdds: o._sharp as any,
      sosRatings: sosRatings || undefined,
      absences,
      options: { league } as any,
    };

    // Per-engine isolation: a broken v2 model file or runtime error should
    // not crash the ensemble + v1 pipeline. Engines already return null for
    // insufficient-data cases; try/catch covers runtime failures on top.
    let v2Calc: MatchCalc | null = null;
    let v1Calc: MatchCalc | null = null;
    try { v2Calc = calcMatchPoissonMLv2(mlInputs); }
    catch (e) { console.warn("[FODZE] poisson-ml-v2 failed:", (e as Error).message); }
    try { v1Calc = calcMatchPoissonML(mlInputs); }
    catch (e) { console.warn("[FODZE] poisson-ml-v1 failed:", (e as Error).message); }

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
    const ensembleBets = calculateBetsEnhanced(ensembleMk, enh.mk_low, enh.mk_high, no, frac, undefined, undefined, league);

    const ensembleCalc: MatchCalc = {
      lambdaH: enh.lambdaH, lambdaA: enh.lambdaA,
      lambdaH_raw: enh.lambdaH_raw, lambdaA_raw: enh.lambdaA_raw,
      mk: ensembleMk, bets: ensembleBets, enh, topScores: topScores.slice(0, 5),
      ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
      hasValue: ensembleBets.some(b => b.isValue), hasOdds, warnings,
      ensemble,
    } as MatchCalc;

    return { ensembleCalc, v1Calc, v2Calc };
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
  type EngineResult = { ensembleCalc: MatchCalc; v1Calc: MatchCalc | null; v2Calc: MatchCalc | null } | null;
  const engineCache = useRef<Map<string, EngineResult>>(new Map());
  const lastVersionRef = useRef<string>("");

  const cacheVersionKey = useMemo(() => {
    const matchIds = (data?.matches || [])
      .map(m => `${m.home?.name}:${m.away?.name}`)
      .join(",");
    return `${league}|${ld.avg}|${ld.hf}|${frac}|${calLoaded}|${sosRatings ? "y" : "n"}|${matchIds}`;
  }, [league, ld.avg, ld.hf, frac, calLoaded, sosRatings, data]);

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

  // Outer memo: cheap — picks primary from the precomputed 3 based on
  // currently selected engine. Switching engines is now microseconds
  // instead of re-running LightGBM/GLM/ensemble for every match.
  const processed: ProcessedMatch[] = useMemo(() =>
    matches.map((m: RawMatch, i: number) => {
      const all = allEngineCalcs[i];
      if (!all) return { ...m, idx: i, calc: null };
      let primary: MatchCalc;
      if (engine === "poisson-ml-v2" && all.v2Calc) primary = all.v2Calc;
      else if (engine === "poisson-ml" && all.v1Calc) primary = all.v1Calc;
      else primary = all.ensembleCalc;
      (primary as any).allEnginesMk = {
        "ensemble-v1": all.ensembleCalc.mk,
        "poisson-ml": all.v1Calc?.mk || null,
        "poisson-ml-v2": all.v2Calc?.mk || null,
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

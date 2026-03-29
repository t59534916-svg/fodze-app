"use client";
import { createContext, useContext, useState, useCallback, useMemo } from "react";
import { saveMatchday, loadLatestMatchday, loadLiveOdds, loadOddsHistory } from "@/lib/supabase";
import {
  LEAGUES, getHomeFactor, calculateBetsEnhanced, vigAdjustBest,
  validateXGData, calcMatchEnhanced, isCalibrationActive,
} from "@/lib/dixon-coles";
import { useApp } from "./AppContext";
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
  const { supabase, user, league, leagueConfig, kellyFraction, effectiveBudget, calLoaded } = useApp();

  const [data, setData] = useState<MatchdayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [oddsData, setOddsData] = useState<Record<number, OddsData>>({});
  const [oddsHistory, setOddsHistory] = useState<Record<number, OddsSnapshot[]>>({});
  const [liveOdds, setLiveOdds] = useState<any[]>([]);
  const [oddsSource, setOddsSource] = useState<"manual" | "live" | "history">("manual");
  const [saving, setSaving] = useState<number | null>(null);

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
      setData(cached.data);
      const live = await loadLiveOdds(supabase, lg);
      setLiveOdds(live);

      for (let i = 0; i < (cached.data.matches?.length || 0); i++) {
        const match = cached.data.matches[i];
        const key = `${lg}:${match.home?.name}-${match.away?.name}`.toLowerCase().replace(/\s/g, "");
        const hist = await loadOddsHistory(supabase, key);
        if (hist.length > 0) {
          setOddsHistory(prev => ({ ...prev, [i]: hist }));
          setOddsData(prev => ({ ...prev, [i]: hist[hist.length - 1].odds }));
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
          setOddsData(prev => ({ ...prev, [i]: {
            h: String(matched.best_h), d: String(matched.best_d), a: String(matched.best_a),
            o25: matched.best_over25 ? String(matched.best_over25) : "",
            u25: matched.best_under25 ? String(matched.best_under25) : "",
            _source: "live",
            _sharp: { h: matched.sharp_h, d: matched.sharp_d, a: matched.sharp_a },
            _bookmakers: matched.num_bookmakers,
            _fetched: matched.fetched_at,
          }}));
          setOddsSource("live");
        }
      }
      return true;
    }
    return false;
  }, [league, supabase]);

  const handleImport = useCallback(async (jsonInput: string) => {
    try {
      const jsonMatch = jsonInput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Kein JSON gefunden.");
      const parsed = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
      if (!parsed.matches?.length) throw new Error("Keine Spiele im JSON.");
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
    const { saveOddsSnapshot, loadOddsHistory: loadHist } = await import("@/lib/supabase");
    const match = data?.matches?.[idx];
    const key = `${league}:${match?.home?.name}-${match?.away?.name}`.toLowerCase().replace(/\s/g, "");
    await saveOddsSnapshot(supabase, league, key, match?.home?.name || "", match?.away?.name || "", o, user.id);
    const hist = await loadHist(supabase, key);
    setOddsHistory(prev => ({ ...prev, [idx]: hist })); setSaving(null);
  }, [oddsData, data, league, user.id, supabase]);

  const handleDelHist = useCallback(async (idx: number) => {
    const { deleteOddsHistory } = await import("@/lib/supabase");
    const match = data?.matches?.[idx];
    const key = `${league}:${match?.home?.name}-${match?.away?.name}`.toLowerCase().replace(/\s/g, "");
    await deleteOddsHistory(supabase, key);
    setOddsHistory(prev => { const n = { ...prev }; delete n[idx]; return n; });
  }, [data, league, supabase]);

  function calcMatch(match: RawMatch, idx: number) {
    const h = match.home, a = match.away;
    if (!h?.xg_h8 || !a?.xg_a8) return null;
    const warnings = validateXGData(h.xg_h8, h.xga_h8 || 0, h.games || 8, a.xg_a8, a.xga_a8 || 0, a.games || 8, ld.avg);
    const matchHf = getHomeFactor(h.name, ld.hf);
    const enh = calcMatchEnhanced(
      h.xg_h8, h.xga_h8 || 0, h.games || 8, h.form,
      a.xg_a8, a.xga_a8 || 0, a.games || 8, a.form,
      ld.avg, matchHf, match.tags || [],
      h.xg_h_history, a.xg_a_history,
      undefined, undefined, undefined, undefined, // SoS, names, absences
      { league }  // enables NegBin overdispersion + dynamic rho
    );
    const o = oddsData[idx] || {};
    const no: Record<string, number> = {};
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) { const v = parseFloat(String(o[k] ?? "")); if (v > 0) no[k] = v; }
    const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;
    const bets = calculateBetsEnhanced(enh.mk, enh.mk_low, enh.mk_high, no, frac);
    const topScores: { s: string; p: number }[] = [];
    if (enh.matrix) {
      for (let i = 0; i <= 5; i++)
        for (let j = 0; j <= 5; j++)
          if (enh.matrix[i]?.[j] > 0.005) topScores.push({ s: `${i}:${j}`, p: enh.matrix[i][j] });
    }
    topScores.sort((a, b) => b.p - a.p);
    return {
      lambdaH: enh.lambdaH, lambdaA: enh.lambdaA,
      lambdaH_raw: enh.lambdaH_raw, lambdaA_raw: enh.lambdaA_raw,
      mk: enh.mk, bets, enh, topScores: topScores.slice(0, 5),
      ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
      hasValue: bets.some(b => b.isValue), hasOdds, warnings,
    } as MatchCalc;
  }

  const matches: RawMatch[] = data?.matches || [];
  const processed: ProcessedMatch[] = useMemo(() =>
    matches.map((m: RawMatch, i: number) => ({ ...m, idx: i, calc: calcMatch(m, i) })),
    [data, oddsData, frac, ld.avg, ld.hf, league, calLoaded]
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
        legs.push({
          id: `${m.idx}-${b.label}`,
          label: `${b.label} ${m.home?.name?.split(" ").pop() || ""}–${m.away?.name?.split(" ").pop() || ""}`,
          match: `${m.home?.name} — ${m.away?.name}`,
          pModel: b.pModel, quote: b.quote, isValue: b.isValue,
        });
      }
    }
    return legs;
  }, [processed]);

  const topTips = useMemo(() => {
    const tips: TopTip[] = [];
    for (const m of processed) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (!b.isValue || b.edge <= 0) continue;
        tips.push({ ...b, home: m.home?.name, away: m.away?.name, matchIdx: m.idx, kickoff: m.kickoff });
      }
    }
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

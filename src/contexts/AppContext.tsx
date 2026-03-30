"use client";
import { createContext, useContext, useState, useEffect, useMemo, useCallback } from "react";
import { createClient, loadProfile, updateProfile, loadUserBets } from "@/lib/supabase";
import { LEAGUES, loadCalibrationCurves, isCalibrationActive } from "@/lib/dixon-coles";
import { loadEnsembleModel } from "@/lib/ensemble";
import { loadPoissonModel } from "@/lib/poisson-regression";
import { loadLGBMModel, validateGoldenTests } from "@/lib/lgbm-runtime";
import { type PredictionEngine, DEFAULT_ENGINE, isValidEngine, ENGINES } from "@/lib/engine-registry";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileData, PlacedBet, LeagueConfig, LeagueStatus } from "@/types/match";

interface AppContextValue {
  user: any;
  supabase: SupabaseClient;
  league: string;
  setLeague: (lg: string) => void;
  leagueConfig: LeagueConfig;
  profile: ProfileData;
  saveProf: (field: string, value: any) => Promise<void>;
  bankroll: number;
  dayBudget: string;
  setDayBudget: (v: string) => void;
  effectiveBudget: number;
  kellyFraction: number;
  calLoaded: boolean;
  hasApi: boolean | null;
  engine: PredictionEngine;
  setEngine: (e: PredictionEngine) => void;
  userBets: PlacedBet[];
  refreshBets: () => Promise<void>;
  leagueStatus: Record<string, LeagueStatus | null>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export function AppProvider({ user, children }: { user: any; children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [league, setLeague] = useState("bundesliga");
  const [profile, setProfile] = useState<ProfileData>({ risk_profile: "M", bankroll: 0, display_name: "" });
  const [dayBudget, setDayBudget] = useState("");
  const [calLoaded, setCalLoaded] = useState(false);
  const [engine, setEngineState] = useState<PredictionEngine>(DEFAULT_ENGINE);
  const [hasApi, setHasApi] = useState<boolean | null>(null);
  const [userBets, setUserBets] = useState<PlacedBet[]>([]);
  const [leagueStatus, setLeagueStatus] = useState<Record<string, { label: string; date: string } | null>>({});

  const leagueConfig = LEAGUES[league] || LEAGUES.bundesliga;
  const bankroll = parseFloat(String(profile.bankroll)) || 0;
  const parsedBudget = parseFloat(dayBudget) || 0;
  const effectiveBudget = parsedBudget > 0 ? parsedBudget : bankroll;
  const kellyFraction = ({ K: 0.25, M: 0.33, A: 0.5 } as Record<string, number>)[profile.risk_profile] || 0.33;

  // Load calibration curves
  useEffect(() => {
    fetch("/calibration_curves.json")
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(curves => { loadCalibrationCurves(curves); setCalLoaded(true); })
      .catch(() => {});

    // Load ensemble model (Elo ratings, logistic coefficients, weights)
    fetch("/ensemble-model.json")
      .then(res => { if (!res.ok) throw new Error(); return res.json(); })
      .then(model => { loadEnsembleModel(model); loadPoissonModel(model); })
      .catch(() => {});

    // Load LightGBM v2 model
    fetch("/lgbm-model-v2.json")
      .then(res => { if (!res.ok) throw new Error(); return res.json(); })
      .then(model => {
        if (loadLGBMModel(model)) validateGoldenTests();
      })
      .catch(() => {});
  }, []);

  // Load user profile + bets + API check + league status
  useEffect(() => {
    loadProfile(supabase, user.id).then(p => {
      if (p) {
        setProfile(p);
        if (p.prediction_engine && isValidEngine(p.prediction_engine)) {
          setEngineState(p.prediction_engine);
        }
      }
    });
    loadUserBets(supabase, user.id).then(b => setUserBets(b));
    fetch("/api/matchday").then(r => r.json()).then(d => setHasApi(d.hasKey === true)).catch(() => setHasApi(false));

    // Check which leagues have data
    (async () => {
      const { loadLatestMatchday } = await import("@/lib/supabase");
      const keys = Object.keys(LEAGUES);
      const results = await Promise.all(keys.map(key => loadLatestMatchday(supabase, key)));
      const status: Record<string, { label: string; date: string } | null> = {};
      keys.forEach((key, i) => {
        const md = results[i];
        status[key] = md ? { label: md.matchday_label || md.data?.matchday || "—", date: md.match_date || md.data?.date || "" } : null;
      });
      setLeagueStatus(status);
    })();
  }, [user.id, supabase]);

  const saveProf = useCallback(async (f: string, v: any) => {
    setProfile(p => ({ ...p, [f]: v }));
    await updateProfile(supabase, user.id, { [f]: v });
  }, [supabase, user.id]);

  const setEngine = useCallback((e: PredictionEngine) => {
    setEngineState(e);
    saveProf("prediction_engine", e);
  }, [saveProf]);

  const refreshBets = useCallback(async () => {
    const bets = await loadUserBets(supabase, user.id);
    setUserBets(bets);
  }, [supabase, user.id]);

  const value = useMemo(() => ({
    user, supabase, league, setLeague, leagueConfig, profile, saveProf,
    bankroll, dayBudget, setDayBudget, effectiveBudget, kellyFraction,
    calLoaded, hasApi, userBets, refreshBets, leagueStatus,
    engine, setEngine,
  }), [user, supabase, league, leagueConfig, profile, saveProf,
    bankroll, dayBudget, effectiveBudget, kellyFraction,
    calLoaded, hasApi, userBets, refreshBets, leagueStatus,
    engine, setEngine]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

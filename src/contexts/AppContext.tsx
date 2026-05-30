"use client";
import { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createClient, loadProfile, updateProfile, loadUserBets } from "@/lib/supabase";
import { LEAGUES, loadCalibrationCurves, isCalibrationActive } from "@/lib/dixon-coles";
import { loadDirichletCalibration, setCalibrationMethod } from "@/lib/calibration";
import { loadEnsembleModel } from "@/lib/ensemble";
import { loadPoissonModel } from "@/lib/poisson-regression";
import { loadLGBMModel, validateGoldenTests } from "@/lib/lgbm-runtime";
import { loadV3Model, isV3ModelLoaded } from "@/lib/poisson-ml-engine-v3";
import { loadDev03Model, validateDev03GoldenTests } from "@/lib/dev03-runtime";
import { loadFeatureCache } from "@/lib/dev03-features";
import { ensureDev03Worker } from "@/lib/dev03-worker-client";
import { loadBenterWeights, setBenterMode } from "@/lib/benter-blend";
import { loadFootBayesPosteriors } from "@/lib/footbayes-engine";
import { loadConformalQuantiles, setConformalMode } from "@/lib/conformal-gate";
import { loadPlayerPropsPosteriors } from "@/lib/player-props-engine";
import { loadOverdispersionConfig } from "@/lib/neg-binomial";
import { loadFilterShieldConfig } from "@/lib/filter-shield";
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
  /** v1.2 Filter-Shield (CSD veto) config-load complete. MatchdayContext must
   *  include this in its allEngineCalcs memo dependencies so cached engine
   *  results recompute once the config arrives — otherwise vetoes are silently
   *  skipped forever on first-render matches (race-condition fix 2026-05-22). */
  filterShieldLoaded: boolean;
  modelErrors: string[];
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
  const [filterShieldLoaded, setFilterShieldLoaded] = useState(false);
  const [modelErrors, setModelErrors] = useState<string[]>([]);
  const [engine, setEngineState] = useState<PredictionEngine>(DEFAULT_ENGINE);
  const [hasApi, setHasApi] = useState<boolean | null>(null);
  const [userBets, setUserBets] = useState<PlacedBet[]>([]);
  const [leagueStatus, setLeagueStatus] = useState<Record<string, { label: string; date: string } | null>>({});

  const leagueConfig = LEAGUES[league] || LEAGUES.bundesliga;
  const bankroll = parseFloat(String(profile.bankroll)) || 0;
  const parsedBudget = parseFloat(dayBudget) || 0;
  const effectiveBudget = parsedBudget > 0 ? parsedBudget : bankroll;
  const kellyFraction = ({ K: 0.25, M: 0.33, A: 0.5 } as Record<string, number>)[profile.risk_profile] || 0.33;

  // Lazy-load the ~12 MB v3 model only when the v3 engine is actually selected
  // (it's preview-only + delegates to v2). Avoids fetching/parsing 12 MB on
  // every app bootstrap. Idempotent via the attempt ref so re-selecting v3
  // doesn't re-fetch; failures surface in modelErrors like the eager loaders.
  const v3LoadAttempted = useRef(false);
  useEffect(() => {
    if (engine !== "poisson-ml-v3") return;
    if (isV3ModelLoaded() || v3LoadAttempted.current) return;
    v3LoadAttempted.current = true;
    fetch("/lgbm-model-v3.json")
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(model => loadV3Model(model))
      .catch(err => {
        console.error("[FODZE] Failed to load lgbm-v3:", err.message || err);
        setModelErrors(prev => prev.includes("lgbm-v3") ? prev : [...prev, "lgbm-v3"]);
      });
  }, [engine]);

  // Load model artifacts (calibration, ensemble, LGBM) in parallel. Silent
  // `.catch(() => {})` was masking broken deploys — now each failure logs
  // and surfaces via `modelErrors` so the UI can warn instead of serving
  // uncalibrated predictions as if everything's fine.
  useEffect(() => {
    const loadModel = (
      url: string, name: string, apply: (data: any) => void,
    ): Promise<void> =>
      fetch(url)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then(data => apply(data))
        .catch(err => {
          console.error(`[FODZE] Failed to load ${name}:`, err.message || err);
          setModelErrors(prev => prev.includes(name) ? prev : [...prev, name]);
        });

    loadModel("/calibration_curves.json", "calibration", curves => {
      loadCalibrationCurves(curves);
      setCalLoaded(true);
    });
    loadModel("/ensemble-model.json", "ensemble", model => {
      loadEnsembleModel(model);
      loadPoissonModel(model);
    });
    loadModel("/lgbm-model-v2.json", "lgbm", model => {
      if (loadLGBMModel(model)) validateGoldenTests();
    });
    // v3 — preview engine. Its artifact is ~12 MB and v3 currently delegates
    // to v2 internally, so loading it on every app bootstrap is wasted
    // bandwidth+parse. It is now LAZY-loaded by the engine-keyed effect below,
    // only when a user actually selects the v3 engine. Trade-off: v3 shadow-
    // log capture happens only for sessions that select v3 (preview-only).
    // dev-03 (FODZE/v4 cross-season-validated specialist) — optional engine
    // for the 3 leagues with cross-engine cross-season-validated Money-Edge
    // (serie_a, scottish_prem, epl). Two artifacts:
    //   /dev03-model.json         — 5 bagged LightGBM Tweedie home+away + m6_benter
    //   /dev03-feature-cache.json — precomputed Elo + Momentum + League constants
    // Both must load successfully for calcMatchDev03 to produce output.
    loadModel("/dev03-model.json", "dev03-model", model => {
      if (loadDev03Model(model)) {
        const golden = validateDev03GoldenTests(1e-4);
        if (golden.failed > 0) {
          console.warn(`[FODZE] dev-03 golden test failures: ${golden.failed}/${golden.passed + golden.failed}`);
        }
        // Pre-spawn the dev-03 Web Worker + load model into its private
        // module state. Off-main-thread predict path = React stays smooth
        // even when 40 matches compute concurrently. Fires-and-forgets;
        // calcMatchDev03Async falls back to sync `dev03Predict` if the
        // worker isn't ready or unavailable (SSR, tests, CSP).
        ensureDev03Worker().then(ok => {
          if (!ok && typeof window !== "undefined") {
            console.info("[FODZE] dev-03 Worker unavailable — using main-thread predict.");
          }
        }).catch(() => { /* swallowed — fallback is sync */ });
      }
    });
    loadModel("/dev03-feature-cache.json", "dev03-cache", cache => {
      loadFeatureCache(cache);
    });
    // Benter blend weights — optional. Default NEXT_PUBLIC_BENTER_BLEND=off
    // keeps pre-upgrade pipeline behavior. Set to "on" (or "shadow" when
    // the shadow-log infra lands) after fit_benter_blend.py produces a
    // real public/benter-weights.json for at least one league.
    const rawMode = (process.env.NEXT_PUBLIC_BENTER_BLEND || "off").toLowerCase();
    const benterMode = rawMode === "on" || rawMode === "shadow" ? rawMode : "off";
    setBenterMode(benterMode);
    if (benterMode !== "off") {
      loadModel("/benter-weights.json", "benter", weights => {
        try { loadBenterWeights(weights); } catch (e) {
          // Throw from loadBenterWeights = invalid schema; keep mode but loader
          // flags it via modelErrors so UI can warn "benter disabled: bad json".
          setBenterMode("off");
          throw e;
        }
      });
    }

    // Player-props posteriors (Phase 3.2) — optional. Dormant with empty
    // teams/players maps until services/footbayes/fit_player_props.R runs.
    // Engine returns null for every player lookup in that state, so the
    // UI layer hides the market instead of serving unreliable priors.
    loadModel("/player-props-posteriors.json", "player-props", posteriors => {
      loadPlayerPropsPosteriors(posteriors);
    });

    // footBayes hierarchical posteriors (Phase 2.2) — optional.
    // Always attempt to load; the runtime engine returns null when teams
    // are missing so silently-empty placeholders degrade cleanly. Setting
    // NEXT_PUBLIC_SHOW_BAYES_ENGINE=false at build time would hide the
    // engine from the selector entirely (not done here — dormant engine
    // is preferable to a hidden surprise).
    loadModel("/footbayes-posteriors.json", "footbayes", posteriors => {
      // Placeholder file ships with empty teams/leagues maps — loader
      // only throws on bad schema, not on empty maps. Dormant state is OK.
      loadFootBayesPosteriors(posteriors);
    });

    // Dirichlet 3-class calibration (Phase 2.1) — DEFAULT ON as of
    // commit shipping cross-engine-oot-metrics.json findings:
    //   ECE drops 2.6× vs raw (0.0146 → 0.0056), BSS strictly ≥ raw
    //   on every league, never worse. 6691 OOT rows, cutoff 2023-08-01.
    //
    // NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet|isotonic|platt
    //   unset / "dirichlet" — Dirichlet-ODIR per-cluster (default)
    //   "isotonic"          — legacy per-market curves from calibration_curves.json
    //   "platt"             — legacy 2-param logistic
    //
    // Failure modes are silent-safe: a missing or malformed
    // public/dirichlet-calibration.json throws from loadDirichletCalibration,
    // setCalibrationMethod("dirichlet") is never reached, and the module-level
    // default ("isotonic" in src/lib/calibration.ts) stays in force.
    const rawCalMethod = (process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "dirichlet").toLowerCase();
    if (rawCalMethod === "dirichlet") {
      loadModel("/dirichlet-calibration.json", "dirichlet", weights => {
        try {
          loadDirichletCalibration(weights);
          setCalibrationMethod("dirichlet");
        } catch (e) {
          throw e;
        }
      });
    } else if (rawCalMethod === "platt" || rawCalMethod === "isotonic") {
      setCalibrationMethod(rawCalMethod);
    }

    // Conformal staking gate (Phase 2.5) — opt-in.
    // NEXT_PUBLIC_CONFORMAL_GATE=off|warn|enforce|dampen (default: off)
    //   off     — runtime helper returns 1.0 factor, no effect
    //   warn    — compute + expose the gate classification, don't alter stakes
    //   dampen  — Kelly scaled by set-size (1/0.6/0.3)
    //   enforce — binary; non-singleton sets disable the bet entirely
    const rawCfMode = (process.env.NEXT_PUBLIC_CONFORMAL_GATE || "off").toLowerCase();
    const cfMode = ["off", "warn", "enforce", "dampen"].includes(rawCfMode) ? rawCfMode : "off";
    setConformalMode(cfMode as "off" | "warn" | "enforce" | "dampen");
    if (cfMode !== "off") {
      loadModel("/conformal-quantiles.json", "conformal", quantiles => {
        try { loadConformalQuantiles(quantiles); } catch (e) {
          // Bad schema → keep the mode set but nothing will be "applied".
          // conformalGate returns cluster="default" in that case, so UI
          // can still render without crashing.
          throw e;
        }
      });
    }

    // Per-Liga overdispersion alphas — fitted via tools/fit_alpha.py on
    // historical data. Replaces conservative DEFAULT_OVERDISPERSION
    // hardcodes in src/lib/neg-binomial.ts. Fitted values are typically
    // 10-30% lower than defaults (e.g. serie_a 0.032 fitted vs 0.067
    // default = -52%), tightening the goal-PMF tails for better-calibrated
    // O25/U25 probabilities. Failure is silent-safe: a corrupt JSON throws
    // from loadOverdispersionConfig, gets logged in modelErrors, and
    // getAlpha falls back to the conservative defaults.
    loadModel("/overdispersion.json", "overdispersion", config => {
      loadOverdispersionConfig(config);
    });

    // v1.2 Filter-Shield (CSD veto) — empirically calibrated 2026-05-22.
    // Loaded JSON drives both the runtime classification thresholds and the
    // active-vs-shadow regime flags. Failure-safe: when the loader returns
    // false (schema mismatch or fetch failure), computeCsdVeto falls back
    // to passthrough multiplier 1.0 — bets are NOT silently haircutted.
    // See public/filter-shield-config.json for empirical provenance.
    loadModel("/filter-shield-config.json", "filter-shield", cfg => {
      const ok = loadFilterShieldConfig(cfg);
      if (!ok) throw new Error("filter-shield-config.json: schema mismatch");
      setFilterShieldLoaded(true);  // gate MatchdayContext memo invalidation
    });
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
    calLoaded, filterShieldLoaded, modelErrors, hasApi, userBets, refreshBets, leagueStatus,
    engine, setEngine,
  }), [user, supabase, league, leagueConfig, profile, saveProf,
    bankroll, dayBudget, effectiveBudget, kellyFraction,
    calLoaded, filterShieldLoaded, modelErrors, hasApi, userBets, refreshBets, leagueStatus,
    engine, setEngine]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

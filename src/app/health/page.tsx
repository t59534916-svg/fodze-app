// ═══════════════════════════════════════════════════════════════════════
// FODZE Engine Health Dashboard
// ═══════════════════════════════════════════════════════════════════════
//
// Why this exists: most production-state questions in FODZE are *runtime*
// rather than code-shape questions:
//
//   - Which calibration layers actually loaded? (env-vars + JSON files)
//   - Which Supabase tables have real data vs. stub-placeholders?
//   - When did each upstream data source last deliver?
//   - How many bets have CLV-coverage?
//
// Today's session burned ~half its context running ad-hoc SQL probes for
// these questions. This page computes them in one round-trip so any future
// "is X live?" diagnostic is a URL away instead of a SQL session.
//
// All data is read-only public-anon access — no admin gating needed.
// ═══════════════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import { isCalibrationActive, isDirichletLoaded, getCalibrationMethod } from "@/lib/calibration";
import { isBenterActive, getBenterMode } from "@/lib/benter-blend";
import { isConformalLoaded, getConformalMode } from "@/lib/conformal-gate";
import { isOverdispersionLoaded } from "@/lib/neg-binomial";
import { isV3ModelLoaded } from "@/lib/poisson-ml-engine-v3";

type LayerStatus = "on" | "off" | "shadow" | "warn" | "error";

interface LayerRow {
  name: string;
  status: LayerStatus;
  detail: string;
  envVar?: string;
  envVal?: string;
  brierImpact?: string;
}

interface TableRow {
  name: string;
  rows: number | null;
  latest?: string;
  status: "ok" | "warn" | "stub" | "empty";
  note?: string;
}

interface SourceRow {
  source: string;
  rows: number;
  min: string;
  max: string;
  ageDays: number;
  status: "fresh" | "stale" | "dead";
}

interface BrierSnapshot {
  engine: string;
  n: number;
  brier_1x2: number | null;
  brier_o25: number | null;
  window_end_date: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function statusColor(s: LayerStatus | TableRow["status"] | SourceRow["status"]): { bg: string; fg: string; border: string; label: string } {
  switch (s) {
    case "on":
    case "ok":
    case "fresh":
      return { bg: "#6aad5520", fg: "#6aad55", border: "#6aad5550", label: s.toUpperCase() };
    case "shadow":
      return { bg: "#c4a26520", fg: "#d4b86a", border: "#c4a26550", label: "SHADOW" };
    case "warn":
    case "stale":
      return { bg: "#d4b86a30", fg: "#d4b86a", border: "#d4b86a60", label: s === "warn" ? "WARN" : "STALE" };
    case "stub":
      return { bg: "#c4707030", fg: "#d49090", border: "#c4707060", label: "STUB" };
    case "empty":
    case "off":
    case "dead":
      return { bg: "#c4a26515", fg: "#c4a26580", border: "#c4a26530", label: s === "off" ? "OFF" : s.toUpperCase() };
    case "error":
      return { bg: "#c4707040", fg: "#e58080", border: "#c4707080", label: "ERROR" };
  }
}

const labelStyle: React.CSSProperties = {
  fontSize: 9, color: "#c4a26580", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6,
};

function StatusPill({ s }: { s: LayerStatus | TableRow["status"] | SourceRow["status"] }) {
  const c = statusColor(s);
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      fontSize: 9, fontWeight: 700, color: c.fg, background: c.bg,
      border: `1px solid ${c.border}`, letterSpacing: 0.5, fontVariantNumeric: "tabular-nums",
    }}>
      {c.label}
    </span>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "#c4a26505", border: "1px solid #c4a26515", borderRadius: 10,
      padding: 14, marginBottom: 12,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 12, color: "#d4b86a", margin: 0, letterSpacing: 1 }}>
          {title}
        </h2>
        {subtitle && <span style={{ fontSize: 9, color: "#c4a26560" }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────

interface DailyPullRow {
  day: string;
  pulled: number;
}

export default function HealthPage() {
  const { supabase, modelErrors, calLoaded, hasApi } = useApp();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [bets, setBets] = useState<{ total: number; settled: number; withClv: number; pending: number; lastSettled?: string } | null>(null);
  const [brier, setBrier] = useState<BrierSnapshot[] | null>(null);
  // v1.2 Filter-Shield firing-rate (last 7d). Counts ACTIVE vs SHADOW vetoes
  // per regime + per league, plus burn-in progress for catastrophic (which
  // ships in shadow-mode until 200 firings confirm Brier-evidence).
  const [shield, setShield] = useState<{
    total7d: number;
    active7d: number;
    shadow7d: number;
    perRegime: Record<string, { active: number; shadow: number; meanMult: number }>;
    perLeague: Record<string, number>;
    catastrophicBurnIn: { fired: number; target: number };
    meanActiveMult: number;
  } | null>(null);
  const [v2Coverage, setV2Coverage] = useState<{
    total_ended: number;
    fully_done: number;
    pct: number;
    pending: number;
    daily_pulls: DailyPullRow[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // Calibration layer status — synchronous reads from module-level state.
  // These are loaded by AppContext at boot, so by the time this component
  // mounts they're either populated or have failed (visible in modelErrors).
  const layers: LayerRow[] = useMemo(() => [
    {
      name: "Dirichlet 1X2 Calibration",
      status: isDirichletLoaded() && getCalibrationMethod() === "dirichlet" ? "on" : "off",
      detail: isDirichletLoaded() ? `method=${getCalibrationMethod()}, 3-cluster ODIR` : `method=${getCalibrationMethod()}, fallback`,
      envVar: "NEXT_PUBLIC_CALIBRATION_METHOD",
      envVal: process.env.NEXT_PUBLIC_CALIBRATION_METHOD || "dirichlet",
      brierImpact: "-0.0019 (gemessen, ECE 3× besser)",
    },
    {
      name: "Benter Market×Model Blend",
      status: isBenterActive() ? (getBenterMode() as LayerStatus) : "off",
      detail: `mode=${getBenterMode()}, per-Liga β₁/β₂ on n=5586 OOT`,
      envVar: "NEXT_PUBLIC_BENTER_BLEND",
      envVal: process.env.NEXT_PUBLIC_BENTER_BLEND || "off",
      brierImpact: "per-Liga tilt: super_lig β₂=1.31, EPL β₂=1.17",
    },
    {
      name: "Conformal Staking Gate",
      status: getConformalMode() === "off" ? "off" : (getConformalMode() === "warn" ? "warn" : "on"),
      detail: `mode=${getConformalMode()}, ${isConformalLoaded() ? "quantiles loaded" : "no quantiles"}`,
      envVar: "NEXT_PUBLIC_CONFORMAL_GATE",
      envVal: process.env.NEXT_PUBLIC_CONFORMAL_GATE || "off",
      brierImpact: "96.7% empirical coverage @ α=0.05",
    },
    {
      name: "Per-Liga Overdispersion α",
      status: isOverdispersionLoaded() ? "on" : "off",
      detail: isOverdispersionLoaded() ? "fitted alphas, 14 leagues" : "DEFAULT_OVERDISPERSION fallback",
      brierImpact: "tighter O25/U25 PMFs (serie_a -52%, la_liga -31%)",
    },
    {
      name: "v3 LightGBM (preview)",
      status: isV3ModelLoaded() ? "shadow" : "off",
      detail: isV3ModelLoaded() ? "20 features, 200H+200A trees" : "not loaded",
      brierImpact: "Brier 0.6318 — preview only, routes to v2 internally",
    },
    {
      name: "Calibration Curves (legacy isotonic)",
      status: isCalibrationActive() && getCalibrationMethod() !== "dirichlet" ? "on" : "off",
      detail: isCalibrationActive() ? `${getCalibrationMethod()} active` : "superseded by Dirichlet",
      brierImpact: "fallback path when Dirichlet unloaded",
    },
  ], [calLoaded, refreshTick]);

  // Reload Supabase inventory on mount + manual refresh.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      // Catalogued tables — name + per-table query strategy.
      // For each table we fetch (a) count via head:true count:'exact' (fast,
      // no row-data transferred), (b) latest 1 row to surface freshness.
      const TABLES = [
        // ─── Core engine-input tables ──────────────────────────────
        { name: "team_xg_history", dateCol: "match_date", expectMin: 80_000, stubCheck: false },
        { name: "odds_closing_history", dateCol: "match_date", expectMin: 20_000, stubCheck: false },
        { name: "live_odds", dateCol: "commence_time", expectMin: 100, stubCheck: false },
        { name: "matchdays", dateCol: "date", expectMin: 100, stubCheck: false },
        { name: "bets", dateCol: "placed_at", expectMin: 1, stubCheck: false },
        { name: "pipeline_shadow_log", dateCol: "predicted_at", expectMin: 100, stubCheck: false },
        // ─── Metadata / discipline ─────────────────────────────────
        { name: "team_metadata", dateCol: "last_updated", expectMin: 100, stubCheck: false },
        { name: "stadiums", dateCol: "last_updated", expectMin: 100, stubCheck: true,
          stubReason: "altitude_m 0% populated, capacity 30% join coverage" },
        { name: "referees", dateCol: "last_updated", expectMin: 100, stubCheck: true,
          stubReason: "fouls_per_game NULL all rows, 1 distinct home_yellow_bias value" },
        { name: "player_xg_history", dateCol: "last_updated", expectMin: 100, stubCheck: false,
          note: "Top-5 leagues only" },
        // ─── Sofascore pipeline (v1 = shotmap + extras since 2026-04-29) ──
        { name: "sofascore_match", dateCol: undefined, expectMin: 5_000, stubCheck: false,
          note: "per-match meta from datafc lib (curl_cffi chrome124)" },
        { name: "sofascore_shotmap", dateCol: undefined, expectMin: 100_000, stubCheck: false,
          note: "per-shot events with xG/xGOT/situation tags" },
        { name: "sofascore_match_statistics", dateCol: "inserted_at", expectMin: 100, stubCheck: false,
          note: "v1 post-match team stats (~6 rows/game × 3 periods × 2 sides)" },
        { name: "sofascore_player_match_stats", dateCol: "inserted_at", expectMin: 1_000, stubCheck: false,
          note: "v1 per-player stats incl. xA, key passes, touches in box" },
        { name: "sofascore_incidents", dateCol: "inserted_at", expectMin: 1_000, stubCheck: false,
          note: "v1 goal/card/sub timeline" },
        { name: "sofascore_average_positions", dateCol: "inserted_at", expectMin: 1_000, stubCheck: false,
          note: "v1 tactical avg-position per starter" },
        { name: "sofascore_extras_state", dateCol: "last_attempt_at", expectMin: 100, stubCheck: false,
          note: "sync state-tracker (7 has_* flags)" },
        // ─── Sofascore v2 (HIGH-SIGNAL — added 2026-05-08, REQUIRES Tor) ──
        { name: "sofascore_match_managers", dateCol: "inserted_at", expectMin: 1, stubCheck: false,
          note: "v2 home + away coach per game (id stable for change-detection)" },
        { name: "sofascore_pregame_form", dateCol: "inserted_at", expectMin: 1, stubCheck: false,
          note: "v2 Sofa pre-match form (avgRating, position, last-5)" },
        { name: "sofascore_team_streaks", dateCol: "inserted_at", expectMin: 1, stubCheck: false,
          note: "v2 streaks (~13/game across general + head2head categories)" },
        // ─── Tracker tables (mostly empty, dormant) ────────────────
        { name: "player_injuries", dateCol: undefined, expectMin: 0, stubCheck: false,
          note: "TM injuries embedded in matchday JSON instead" },
        { name: "live_wp_snapshots", dateCol: undefined, expectMin: 0, stubCheck: false,
          note: "Phase 3.3 dormant (Betfair key needed)" },
        { name: "corners_odds_history", dateCol: undefined, expectMin: 0, stubCheck: false,
          note: "Phase 3.1 dormant (UI tab needed)" },
        { name: "player_props_posteriors", dateCol: undefined, expectMin: 0, stubCheck: false,
          note: "Phase 3.2 dormant (R-service needed)" },
      ] as const;

      const results: TableRow[] = await Promise.all(TABLES.map(async (t) => {
        try {
          const { count, error: countErr } = await supabase
            .from(t.name).select("*", { head: true, count: "exact" });
          if (countErr) throw countErr;
          const rows = count ?? 0;

          let latest: string | undefined;
          if (t.dateCol && rows > 0) {
            const { data } = await supabase
              .from(t.name).select(t.dateCol)
              .order(t.dateCol, { ascending: false }).limit(1);
            const row = data?.[0] as Record<string, unknown> | undefined;
            latest = row?.[t.dateCol] as string | undefined;
          }

          let status: TableRow["status"] = "ok";
          let note = (t as { note?: string }).note;
          if (rows === 0) status = "empty";
          else if (t.stubCheck) {
            status = "stub";
            note = (t as { stubReason?: string }).stubReason;
          } else if (rows < t.expectMin) {
            status = "warn";
            note = `expected ≥${t.expectMin.toLocaleString()}`;
          }

          return { name: t.name, rows, latest, status, note };
        } catch (e) {
          return { name: t.name, rows: null, status: "warn", note: (e as Error).message };
        }
      }));

      if (cancelled) return;
      setTables(results);

      // Per-source freshness for the two big history tables. Computed
      // client-side via select(source).order(date.desc).limit(1) per source —
      // PostgREST doesn't support GROUP BY directly so we issue 1 query per
      // known source. Cheap (1 row each) and gives us the headline metric
      // we discovered today: football-data.co.uk PSCH source dark since Jan 14.
      const SOURCES: Array<{ source: string; table: "team_xg_history" | "odds_closing_history"; dateCol: string }> = [
        { source: "football-data.co.uk", table: "odds_closing_history", dateCol: "match_date" },
        { source: "live-odds-snapshot", table: "odds_closing_history", dateCol: "match_date" },
        { source: "footystats", table: "team_xg_history", dateCol: "match_date" },
        { source: "understat", table: "team_xg_history", dateCol: "match_date" },
        { source: "shots-model", table: "team_xg_history", dateCol: "match_date" },
        { source: "api-sports", table: "team_xg_history", dateCol: "match_date" },
        { source: "goals-proxy", table: "team_xg_history", dateCol: "match_date" },
      ];

      const sourceResults: SourceRow[] = await Promise.all(SOURCES.map(async (s) => {
        try {
          const { count } = await supabase.from(s.table)
            .select("*", { head: true, count: "exact" }).eq("source", s.source);
          const { data: maxRow } = await supabase.from(s.table)
            .select(s.dateCol).eq("source", s.source)
            .order(s.dateCol, { ascending: false }).limit(1);
          const { data: minRow } = await supabase.from(s.table)
            .select(s.dateCol).eq("source", s.source)
            .order(s.dateCol, { ascending: true }).limit(1);
          const max = (maxRow?.[0] as Record<string, unknown> | undefined)?.[s.dateCol] as string | undefined;
          const min = (minRow?.[0] as Record<string, unknown> | undefined)?.[s.dateCol] as string | undefined;
          const ageDays = max ? Math.floor((Date.now() - new Date(max).getTime()) / 86_400_000) : 9999;
          // "Fresh" = updated in last 7 days; "Stale" = 8-90 days; "Dead" = >90 or no rows.
          let status: SourceRow["status"] = "fresh";
          if (count === 0 || count == null) status = "dead";
          else if (ageDays > 90) status = "dead";
          else if (ageDays > 7) status = "stale";
          return {
            source: s.source, rows: count ?? 0,
            min: min || "—", max: max || "—",
            ageDays, status,
          };
        } catch {
          return { source: s.source, rows: 0, min: "—", max: "—", ageDays: 9999, status: "dead" as const };
        }
      }));

      if (cancelled) return;
      setSources(sourceResults.filter(r => r.rows > 0)); // hide sources with 0 rows

      // Bets coverage — small table, just fetch all
      const { data: betRows } = await supabase
        .from("bets").select("result, clv, settled_at")
        .order("placed_at", { ascending: false });
      if (betRows) {
        const total = betRows.length;
        const settled = betRows.filter(b => b.result !== "pending").length;
        const withClv = betRows.filter(b => b.clv != null).length;
        const pending = total - settled;
        const lastSettled = betRows.find(b => b.settled_at)?.settled_at;
        if (!cancelled) setBets({ total, settled, withClv, pending, lastSettled });
      }

      // v1.2 Filter-Shield firing-rate (last 7d). Reads epistemic_trails for
      // CSD_REGIME_SHIFT:* trap_kinds, aggregates by regime + league. Burn-in
      // counter watches the catastrophic regime which is shadow-only until
      // 200 firings empirically confirm the Brier-lift translates to Kelly-PnL.
      try {
        const sevenDaysAgo = Date.now() - 7 * 86400_000;
        const { data: shieldRows } = await supabase
          .from("epistemic_trails")
          .select("trap_kind, league, shadow, raw_signals, detected_at")
          .like("trap_kind", "CSD_REGIME_SHIFT:%")
          .gte("detected_at", sevenDaysAgo)
          .order("detected_at", { ascending: false })
          .limit(2000);
        if (shieldRows && !cancelled) {
          let active7d = 0, shadow7d = 0;
          const perRegime: Record<string, { active: number; shadow: number; meanMult: number; multSum: number }> = {};
          const perLeague: Record<string, number> = {};
          let activeMultSum = 0, activeMultCount = 0;
          for (const r of shieldRows) {
            const trapKind = String(r.trap_kind);
            // "CSD_REGIME_SHIFT:persistent_reversal" → "persistent_reversal"
            const regime = trapKind.split(":")[1] || "unknown";
            if (r.shadow) shadow7d++; else active7d++;
            if (r.league) perLeague[r.league] = (perLeague[r.league] ?? 0) + 1;
            if (!perRegime[regime]) {
              perRegime[regime] = { active: 0, shadow: 0, meanMult: 0, multSum: 0 };
            }
            if (r.shadow) perRegime[regime].shadow++;
            else perRegime[regime].active++;
            const mult = (r.raw_signals as Record<string, unknown> | null)?.multiplier;
            if (typeof mult === "number") {
              perRegime[regime].multSum += mult;
              if (!r.shadow) {
                activeMultSum += mult;
                activeMultCount++;
              }
            }
          }
          for (const k of Object.keys(perRegime)) {
            const r = perRegime[k];
            const n = r.active + r.shadow;
            r.meanMult = n > 0 ? r.multSum / n : 1.0;
          }
          // Total catastrophic firings (all-time, for burn-in counter). Single
          // additional query — head/count only, no row data.
          const { count: catastrophicAllTime } = await supabase
            .from("epistemic_trails")
            .select("*", { head: true, count: "exact" })
            .eq("trap_kind", "CSD_REGIME_SHIFT:catastrophic");
          setShield({
            total7d: shieldRows.length,
            active7d, shadow7d,
            perRegime: Object.fromEntries(
              Object.entries(perRegime).map(([k, v]) => [
                k, { active: v.active, shadow: v.shadow, meanMult: v.meanMult },
              ]),
            ),
            perLeague,
            catastrophicBurnIn: { fired: catastrophicAllTime ?? 0, target: 200 },
            meanActiveMult: activeMultCount > 0 ? activeMultSum / activeMultCount : 1.0,
          });
        }
      } catch (e) {
        // Schema not yet migrated or no firings yet — silent. The section
        // renders an empty-state hint when shield is null.
        console.warn("[FODZE health] shield aggregation failed:", (e as Error).message);
      }

      // Live Brier monitor — most recent snapshot per engine (overall row).
      // Populated by `node scripts/monitor-live-brier.mjs --persist` on a
      // nightly cron. The '__overall' sentinel league = engine-level
      // aggregate across all leagues in the window.
      const { data: brierRows } = await supabase
        .from("live_brier_snapshots")
        .select("engine, n, brier_1x2, brier_o25, window_end_date")
        .eq("league", "__overall")
        .order("window_end_date", { ascending: false })
        .order("brier_1x2", { ascending: true })
        .limit(20);
      if (brierRows && !cancelled) {
        // Take only the most recent window's snapshots (one per engine).
        const latestDate = brierRows[0]?.window_end_date;
        const latest = brierRows.filter((r) => r.window_end_date === latestDate);
        setBrier(latest as BrierSnapshot[]);
      }

      // ── Sofa v2-extras coverage (Webshare-backed pipeline) ──────
      // Surfaces "are we keeping up?" — daily pulls last 7 days, plus
      // total fully-done vs ended-games. If daily-cron is failing
      // (Cloudflare blocked the proxy pool), the daily-pulls trail
      // toward zero, visible at a glance.
      try {
        const [v2DoneCount, endedCount, dailyRows] = await Promise.all([
          supabase.from("sofascore_extras_state").select("*", { head: true, count: "exact" })
            .eq("has_managers", true).eq("has_pregame_form", true).eq("has_team_streaks", true),
          supabase.from("sofascore_match").select("*", { head: true, count: "exact" })
            .eq("status", "Ended").eq("season", "25/26"),
          // Last 8 days of newly-pulled state rows (daily counts)
          supabase.from("sofascore_extras_state").select("last_success_at")
            .eq("has_managers", true).eq("has_pregame_form", true).eq("has_team_streaks", true)
            .gte("last_success_at", new Date(Date.now() - 8 * 86400_000).toISOString())
            .order("last_success_at", { ascending: false })
            .limit(2000),
        ]);
        const totalEnded = endedCount.count ?? 0;
        const fullyDone = v2DoneCount.count ?? 0;
        // Bucket dailyRows by ISO date (YYYY-MM-DD)
        const buckets = new Map<string, number>();
        for (const r of (dailyRows.data || [])) {
          const d = (r.last_success_at as string)?.slice(0, 10);
          if (d) buckets.set(d, (buckets.get(d) || 0) + 1);
        }
        // Build last-7-days array (most recent first), filling gaps with 0
        const days: DailyPullRow[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
          days.push({ day: d, pulled: buckets.get(d) || 0 });
        }
        if (!cancelled) {
          setV2Coverage({
            total_ended: totalEnded,
            fully_done: fullyDone,
            pct: totalEnded > 0 ? (fullyDone / totalEnded) * 100 : 0,
            pending: Math.max(0, totalEnded - fullyDone),
            daily_pulls: days,
          });
        }
      } catch (e) {
        if (!cancelled) console.warn("v2 coverage fetch failed:", e);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [supabase, refreshTick]);

  return (
    <AppShell>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, color: "#ede4d4", margin: 0, fontWeight: 600, letterSpacing: 1 }}>
          ENGINE HEALTH
        </h1>
        <button
          onClick={() => setRefreshTick(t => t + 1)}
          disabled={loading}
          style={{
            fontSize: 10, padding: "6px 12px", borderRadius: 6, cursor: loading ? "wait" : "pointer",
            border: "1px solid #c4a26540", background: "#c4a26515", color: "#d4b86a",
            opacity: loading ? 0.5 : 1, letterSpacing: 0.5,
          }}
        >
          {loading ? "LOADING..." : "↻ REFRESH"}
        </button>
      </div>

      {/* Section 1: Calibration Layer */}
      <Section title="CALIBRATION LAYER" subtitle="Phase 2.x dormant→live activation history">
        {layers.map(layer => (
          <div key={layer.name} style={{
            display: "grid", gridTemplateColumns: "1fr auto", gap: 10,
            padding: "10px 0", borderBottom: "1px solid #c4a26510",
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, color: "#ede4d4", fontWeight: 500 }}>{layer.name}</span>
                <StatusPill s={layer.status} />
              </div>
              <div style={{ fontSize: 10, color: "#c4a26580" }}>{layer.detail}</div>
              {layer.envVar && (
                <div style={{ fontSize: 9, color: "#c4a26560", marginTop: 2, fontFamily: "monospace" }}>
                  {layer.envVar}={layer.envVal}
                </div>
              )}
              {layer.brierImpact && (
                <div style={{ fontSize: 9, color: "#6aad5580", marginTop: 2 }}>
                  Δ {layer.brierImpact}
                </div>
              )}
            </div>
          </div>
        ))}
        {modelErrors.length > 0 && (
          <div style={{
            marginTop: 10, padding: 8, background: "#c4707020", border: "1px solid #c4707050",
            borderRadius: 6, fontSize: 10, color: "#e58080",
          }}>
            ⚠ Failed model loads: {modelErrors.join(", ")}
          </div>
        )}
      </Section>

      {/* Section 2: Supabase Tables */}
      <Section title="SUPABASE TABLES" subtitle={loading ? "loading..." : `${tables.length} tracked`}>
        <div style={labelStyle}>name · rows · latest · status</div>
        {tables.map(t => (
          <div key={t.name} style={{
            display: "grid", gridTemplateColumns: "1fr auto auto auto",
            gap: 10, padding: "8px 0", borderBottom: "1px solid #c4a26510",
            alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: 12, color: "#ede4d4", fontFamily: "monospace" }}>{t.name}</div>
              {t.note && <div style={{ fontSize: 9, color: "#c4a26580", marginTop: 2 }}>{t.note}</div>}
            </div>
            <span style={{
              fontSize: 11, color: t.rows === 0 ? "#c4a26560" : "#d4b86a",
              fontFamily: "monospace", fontVariantNumeric: "tabular-nums",
            }}>
              {t.rows == null ? "?" : t.rows.toLocaleString()}
            </span>
            <span style={{ fontSize: 10, color: "#c4a26580", minWidth: 55, textAlign: "right" }}>
              {t.latest ? ago(t.latest) : "—"}
            </span>
            <StatusPill s={t.status} />
          </div>
        ))}
      </Section>

      {/* Section 3: Data Source Freshness */}
      <Section title="DATA SOURCE FRESHNESS" subtitle="upstream delivery health">
        <div style={labelStyle}>source · rows · range · last update · status</div>
        {sources.map(s => (
          <div key={s.source} style={{
            display: "grid", gridTemplateColumns: "1fr auto auto auto auto",
            gap: 10, padding: "8px 0", borderBottom: "1px solid #c4a26510",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 12, color: "#ede4d4", fontFamily: "monospace" }}>{s.source}</span>
            <span style={{
              fontSize: 11, color: "#d4b86a", fontFamily: "monospace",
              fontVariantNumeric: "tabular-nums",
            }}>
              {s.rows.toLocaleString()}
            </span>
            <span style={{ fontSize: 9, color: "#c4a26580", fontFamily: "monospace" }}>
              {s.min === s.max ? s.min : `${s.min}→${s.max}`}
            </span>
            <span style={{ fontSize: 10, color: s.status === "dead" ? "#c47070" : "#c4a26580", minWidth: 60, textAlign: "right" }}>
              {s.ageDays >= 9999 ? "no data" : `${s.ageDays}d ago`}
            </span>
            <StatusPill s={s.status} />
          </div>
        ))}
        {sources.length === 0 && !loading && (
          <div style={{ fontSize: 11, color: "#c4a26560", padding: 8 }}>No source rows found.</div>
        )}
      </Section>

      {/* Section 4: Bet Portfolio */}
      <Section title="BET PORTFOLIO" subtitle="CLV-tracking coverage">
        {!bets ? (
          <div style={{ fontSize: 11, color: "#c4a26560" }}>Loading…</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <Stat label="Total" value={bets.total.toString()} />
            <Stat label="Settled" value={`${bets.settled} / ${bets.total}`} />
            <Stat label="With CLV" value={`${bets.withClv} / ${bets.settled}`}
                  warn={bets.settled > 0 && bets.withClv === 0} />
            <Stat label="Pending" value={bets.pending.toString()} />
          </div>
        )}
        {bets && bets.settled > 0 && bets.withClv === 0 && (
          <div style={{
            marginTop: 10, padding: 8, background: "#d4b86a20", border: "1px solid #d4b86a40",
            borderRadius: 6, fontSize: 10, color: "#d4b86a",
          }}>
            ⚠ 0 von {bets.settled} gesettleten Bets hat CLV-Daten. Live-odds-snapshot Cron sammelt
            ab 2026-04-26 für alle in-window Matches in odds_closing_history.
          </div>
        )}
      </Section>

      {/* Section 5: Live Engine Brier — populated by scripts/monitor-live-brier.mjs.
          Joins pipeline_shadow_log × team_xg_history.goals_for/against to compute
          REAL per-engine Brier on settled production matches (not the static
          backtest-summary.json OOT corpus). Empty until first cron run. */}
      <Section title="LIVE ENGINE BRIER" subtitle={brier && brier.length > 0 ? `window ending ${brier[0].window_end_date}` : "no snapshot yet"}>
        {!brier || brier.length === 0 ? (
          <div style={{ fontSize: 11, color: "#c4a26560", padding: 8 }}>
            Keine Snapshots — `node scripts/monitor-live-brier.mjs --persist` einmal laufen lassen,
            dann nightly als Cron einrichten. Ersetzt statisches backtest-summary.json durch
            empirische Production-Brier.
          </div>
        ) : (
          <>
            <div style={labelStyle}>engine · n · Brier 1X2 (lower = better) · Brier O25</div>
            {brier.map(b => (
              <div key={b.engine} style={{
                display: "grid", gridTemplateColumns: "1fr auto auto auto",
                gap: 10, padding: "8px 0", borderBottom: "1px solid #c4a26510",
                alignItems: "center",
              }}>
                <span style={{ fontSize: 12, color: "#ede4d4", fontFamily: "monospace" }}>{b.engine}</span>
                <span style={{
                  fontSize: 11, color: "#c4a26580", fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  n={b.n}
                </span>
                <span style={{
                  fontSize: 12, color: "#d4b86a", fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums", minWidth: 70, textAlign: "right",
                }}>
                  {b.brier_1x2 != null ? Number(b.brier_1x2).toFixed(4) : "—"}
                </span>
                <span style={{
                  fontSize: 11, color: "#c4a26580", fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums", minWidth: 60, textAlign: "right",
                }}>
                  {b.brier_o25 != null ? Number(b.brier_o25).toFixed(4) : "—"}
                </span>
              </div>
            ))}
            <div style={{ marginTop: 8, fontSize: 9, color: "#c4a26560", lineHeight: 1.5 }}>
              Empirische Brier auf Matches die nach Prediction settlten. Static OOT-Baseline (n=6691):
              v2_dirichlet 0.6083, v1 0.6518. Sample &lt; 30 = statistisch zu klein für Engine-Vergleich;
              warten bis n ≥ 100 pro Engine für aussagekräftigen Vote.
            </div>
          </>
        )}
      </Section>

      {/* v1.2 Filter-Shield firing-rate. Live observability for the CSD
          regime-shift veto. persistent_reversal fires ACTIVE (multiplier 0.50),
          catastrophic SHADOW until 200-firing burn-in completes. Empty until
          the Goldilocks page-load batch starts hitting /api/persist-trails. */}
      <Section title="FILTER-SHIELD (CSD VETO)" subtitle={
        shield ? `${shield.total7d} firings · last 7d` : "no trail data yet"
      }>
        {!shield ? (
          <div style={{ fontSize: 11, color: "#c4a26560", padding: 8 }}>
            Keine epistemic_trails Einträge für CSD_REGIME_SHIFT.* in den letzten 7 Tagen.
            Trails werden vom /goldilocks Page-Load via /api/persist-trails geschrieben —
            erscheinen sobald der erste User die Page öffnet (oder ein Cron einen
            synthetischen Run macht).
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <Stat label="Active (7d)" value={shield.active7d.toString()} />
              <Stat label="Shadow (7d)" value={shield.shadow7d.toString()} />
              <Stat label="Mean Active Mult"
                value={shield.meanActiveMult.toFixed(2)}
                warn={shield.meanActiveMult > 0.95} />
              <Stat label="Burn-In (catastrophic)"
                value={`${shield.catastrophicBurnIn.fired} / ${shield.catastrophicBurnIn.target}`}
                warn={shield.catastrophicBurnIn.fired < shield.catastrophicBurnIn.target} />
            </div>
            {Object.keys(shield.perRegime).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>per-regime breakdown · active/shadow · mean multiplier</div>
                {Object.entries(shield.perRegime).map(([regime, r]) => (
                  <div key={regime} style={{
                    display: "grid", gridTemplateColumns: "1fr auto auto auto",
                    gap: 10, padding: "6px 0", borderBottom: "1px solid #c4a26510",
                    alignItems: "center",
                  }}>
                    <span style={{ fontSize: 12, color: "#ede4d4", fontFamily: "monospace" }}>{regime}</span>
                    <span style={{ fontSize: 11, color: "#d4b86a", fontFamily: "monospace" }}>
                      {r.active} active
                    </span>
                    <span style={{ fontSize: 11, color: "#c4a26580", fontFamily: "monospace" }}>
                      {r.shadow} shadow
                    </span>
                    <span style={{ fontSize: 12, color: "#d4b86a", fontFamily: "monospace",
                                   fontVariantNumeric: "tabular-nums", minWidth: 60, textAlign: "right" }}>
                      × {r.meanMult.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {Object.keys(shield.perLeague).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>per-Liga firing counts (last 7d)</div>
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginTop: 6 }}>
                  {Object.entries(shield.perLeague)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 12)
                    .map(([lg, n]) => (
                      <span key={lg} style={{
                        padding: "3px 8px", background: "#1a0f0a", border: "1px solid #c4a26530",
                        borderRadius: 4, fontSize: 11, color: "#ede4d4", fontFamily: "monospace",
                      }}>
                        {lg} <span style={{ color: "#d4b86a" }}>{n}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 9, color: "#c4a26560", lineHeight: 1.5 }}>
              CSD-Veto kalibriert auf v2-OOT 2026-05-21: persistent_reversal n=355 Brier-lift +0.0427
              (CI [+0.017, +0.069]) → 0.5× Kelly active. catastrophic n=2173 Brier-lift +0.0203 →
              shadow bis 200 production-firings die direction-positive Money-Eval bestätigen.
              Diagnostic: tools/v4/diagnostics/csd_veto_calibration.json.
            </div>
          </>
        )}
      </Section>

      {/* Section 6: Sofa v2-extras pipeline coverage. Tracks the
          managers/pregame/streaks endpoints that need Cloudflare-bypass
          (Webshare residential proxies). Surfaces "are we keeping up?"
          via daily-pull bars — if proxies get blocked, today's bar drops
          to 0 visibly, no need to log-dive. */}
      <Section title="SOFA V2-EXTRAS COVERAGE"
        subtitle={v2Coverage ? `${v2Coverage.fully_done}/${v2Coverage.total_ended} games (${v2Coverage.pct.toFixed(1)}%)` : "loading…"}>
        {v2Coverage && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
              <Stat label="Fully Done" value={v2Coverage.fully_done.toLocaleString()} />
              <Stat label="Pending" value={v2Coverage.pending.toLocaleString()}
                warn={v2Coverage.pending > 1000} />
              <Stat label="% Complete" value={`${v2Coverage.pct.toFixed(1)}%`}
                warn={v2Coverage.pct < 25} />
            </div>
            <div style={labelStyle}>last 7 days · pulled per day · expected ~50/day during season</div>
            <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 60, padding: "8px 0" }}>
              {v2Coverage.daily_pulls.slice().reverse().map((d) => {
                // Bar height proportional to pulled count, capped at 100
                const pct = Math.min(100, (d.pulled / 100) * 100);
                const isToday = d.day === new Date().toISOString().slice(0, 10);
                const lowAlert = d.pulled < 10 && !isToday;
                return (
                  <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{
                      width: "100%",
                      height: `${Math.max(2, pct)}%`,
                      background: lowAlert ? "#d4b86a30" : isToday ? "#6aad5560" : "#6aad5530",
                      border: `1px solid ${lowAlert ? "#d4b86a60" : isToday ? "#6aad5580" : "#6aad5550"}`,
                      borderRadius: "2px 2px 0 0",
                      minHeight: 2,
                    }} />
                    <div style={{
                      fontSize: 9, color: lowAlert ? "#d4b86a" : "#c4a26580",
                      fontFamily: "monospace", fontVariantNumeric: "tabular-nums",
                    }}>
                      {d.pulled}
                    </div>
                    <div style={{ fontSize: 8, color: "#c4a26550" }}>
                      {d.day.slice(5)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 8, fontSize: 9, color: "#c4a26560", lineHeight: 1.5 }}>
              Quelle: <code>sofascore_extras_state.last_success_at</code> wo alle 3 v2-flags TRUE.
              Daily-cron pulls ~50 ended games/Tag während Saison. Wenn ein Tag &lt;10 zeigt: Cloudflare hat
              Proxy-Pool blocked → Webshare-Plan re-aktivieren oder Residential-IPs replacen. Heute = grün.
            </div>
          </div>
        )}
      </Section>

      <div style={{ marginTop: 16, fontSize: 9, color: "#c4a26540", textAlign: "center" }}>
        Read-only diagnostic · Querytime ~{tables.length + sources.length + 1} parallel Supabase calls · API: {hasApi ? "✓" : "✗"}
      </div>
    </AppShell>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{
      background: warn ? "#d4b86a15" : "#c4a26510", border: `1px solid ${warn ? "#d4b86a40" : "#c4a26525"}`,
      borderRadius: 6, padding: 10, textAlign: "center",
    }}>
      <div style={{ fontSize: 9, color: "#c4a26580", letterSpacing: 1, marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{
        fontSize: 16, color: warn ? "#d4b86a" : "#ede4d4", fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </div>
    </div>
  );
}

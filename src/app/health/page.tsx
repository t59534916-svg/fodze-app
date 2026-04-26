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

export default function HealthPage() {
  const { supabase, modelErrors, calLoaded, hasApi } = useApp();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [bets, setBets] = useState<{ total: number; settled: number; withClv: number; pending: number; lastSettled?: string } | null>(null);
  const [brier, setBrier] = useState<BrierSnapshot[] | null>(null);
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
        { name: "team_xg_history", dateCol: "match_date", expectMin: 80_000, stubCheck: false },
        { name: "odds_closing_history", dateCol: "match_date", expectMin: 20_000, stubCheck: false },
        { name: "live_odds", dateCol: "commence_time", expectMin: 100, stubCheck: false },
        { name: "matchdays", dateCol: "date", expectMin: 100, stubCheck: false },
        { name: "bets", dateCol: "placed_at", expectMin: 1, stubCheck: false },
        { name: "pipeline_shadow_log", dateCol: "predicted_at", expectMin: 100, stubCheck: false },
        { name: "team_metadata", dateCol: "last_updated", expectMin: 100, stubCheck: false },
        { name: "stadiums", dateCol: "last_updated", expectMin: 100, stubCheck: true,
          stubReason: "altitude_m 0% populated, capacity 30% join coverage" },
        { name: "referees", dateCol: "last_updated", expectMin: 100, stubCheck: true,
          stubReason: "fouls_per_game NULL all rows, 1 distinct home_yellow_bias value" },
        { name: "player_xg_history", dateCol: "last_updated", expectMin: 100, stubCheck: false,
          note: "Top-5 leagues only" },
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

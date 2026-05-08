// ═══════════════════════════════════════════════════════════════════════
// FODZE Line Movement Dashboard
// ═══════════════════════════════════════════════════════════════════════
//
// URL-only diagnostic page (kein Navbar-Tab, mirrors /health pattern).
//
// Reads `odds_snapshots` time-series — appended to by fetch-odds.mjs cron
// every 4h Fri-Sun + Wed (since commit 652f2fa, 2026-05-08). For each
// match with ≥2 snapshots in the window, computes vig-removed sharp
// probability at the EARLIEST snapshot vs the LATEST, surfaces the
// pct-point shifts on H/D/A, and ranks by max-drift.
//
// Why vig-removed sharp prob (not raw odds): comparing 1.50 vs 1.45 is
// noisy because vig changes too. (1/odds) / Σ(1/odds) gives the implied
// probability with vig stripped — apples-to-apples regardless of bookie
// margin movements.
//
// Default window: 7 days. Most line movements that matter happen in the
// last week before kickoff; longer windows dilute the signal.
//
// Empty state: when fetch-odds cron hasn't accumulated enough snapshots
// (< 2 per match), shows an explanatory empty message rather than table
// with all-zero deltas. Initial baseline was 2026-05-08 ~10:07 UTC; first
// real movements visible after the next cron tick (~14:17 UTC).
// ═══════════════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";

interface SnapshotRow {
  match_key: string;
  league: string;
  home_team: string;
  away_team: string;
  odds: {
    h?: string; d?: string; a?: string;
    o25?: string; u25?: string;
    _sharp?: { h?: number; d?: number; a?: number };
    _bookmakers?: number;
    _sharp_book?: string;
    _fetched?: string;
  };
  snapshot_time: string;
}

interface Movement {
  match_key: string;
  league: string;
  home_team: string;
  away_team: string;
  ko?: string;
  earliest_at: string;
  latest_at: string;
  hours_span: number;
  n_snapshots: number;
  open_pH: number; open_pD: number; open_pA: number;
  now_pH: number;  now_pD: number;  now_pA: number;
  dH: number; dD: number; dA: number;
  max_drift: number;
  // raw best odds at the latest snapshot (for actionable display)
  now_h?: number; now_d?: number; now_a?: number;
  sharp_book?: string;
}

// Vig-removed prob from sharp odds. Returns null if any leg missing.
function vigRemoveSharp(sharp?: { h?: number; d?: number; a?: number }) {
  const h = sharp?.h, d = sharp?.d, a = sharp?.a;
  if (!h || !d || !a) return null;
  const sum = 1 / h + 1 / d + 1 / a;
  return { h: 1 / h / sum, d: 1 / d / sum, a: 1 / a / sum };
}

function buildMovements(snaps: SnapshotRow[]): Movement[] {
  const byMatch = new Map<string, SnapshotRow[]>();
  for (const s of snaps) {
    if (!s.match_key) continue;
    const arr = byMatch.get(s.match_key) || [];
    arr.push(s);
    byMatch.set(s.match_key, arr);
  }
  const out: Movement[] = [];
  for (const [key, arr] of byMatch.entries()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => +new Date(a.snapshot_time) - +new Date(b.snapshot_time));
    const earliest = arr[0];
    const latest = arr[arr.length - 1];
    const earlyP = vigRemoveSharp(earliest.odds._sharp);
    const lateP = vigRemoveSharp(latest.odds._sharp);
    if (!earlyP || !lateP) continue;
    const dH = (lateP.h - earlyP.h) * 100;
    const dD = (lateP.d - earlyP.d) * 100;
    const dA = (lateP.a - earlyP.a) * 100;
    const maxAbs = Math.max(Math.abs(dH), Math.abs(dD), Math.abs(dA));
    const hours = (+new Date(latest.snapshot_time) - +new Date(earliest.snapshot_time)) / 3600_000;
    out.push({
      match_key: key,
      league: latest.league,
      home_team: latest.home_team,
      away_team: latest.away_team,
      earliest_at: earliest.snapshot_time,
      latest_at: latest.snapshot_time,
      hours_span: hours,
      n_snapshots: arr.length,
      open_pH: earlyP.h, open_pD: earlyP.d, open_pA: earlyP.a,
      now_pH: lateP.h,   now_pD: lateP.d,   now_pA: lateP.a,
      dH, dD, dA,
      max_drift: maxAbs,
      now_h: latest.odds.h ? Number(latest.odds.h) : undefined,
      now_d: latest.odds.d ? Number(latest.odds.d) : undefined,
      now_a: latest.odds.a ? Number(latest.odds.a) : undefined,
      sharp_book: latest.odds._sharp_book,
    });
  }
  return out.sort((a, b) => b.max_drift - a.max_drift);
}

function fmtDelta(pp: number) {
  if (Math.abs(pp) < 0.05) return "·";
  const sign = pp > 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)}`;
}

function deltaColor(pp: number) {
  if (Math.abs(pp) < 0.5) return "#8a7560";       // muted neutral
  if (pp > 0) return "#6aad55";                    // green up
  return "#c47070";                                // red down
}

function ago(iso: string) {
  const ms = Date.now() - +new Date(iso);
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const WINDOW_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "3d",  hours: 72 },
  { label: "7d",  hours: 168 },
  { label: "30d", hours: 720 },
];

const THRESHOLD_OPTIONS = [
  { label: "all",     pp: 0 },
  { label: "≥2pp",    pp: 2 },
  { label: "≥5pp",    pp: 5 },
  { label: "≥10pp",   pp: 10 },
];

export default function MovementsPage() {
  const { supabase } = useApp();
  const [snaps, setSnaps] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowHours, setWindowHours] = useState(168);   // default 7d
  const [thresholdPp, setThresholdPp] = useState(0);
  const [leagueFilter, setLeagueFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
      const { data, error } = await supabase
        .from("odds_snapshots")
        .select("match_key, league, home_team, away_team, odds, snapshot_time")
        .gte("snapshot_time", since)
        .order("snapshot_time", { ascending: false })
        .limit(5000);
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      setSnaps((data || []) as SnapshotRow[]);
      setError(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, windowHours]);

  const movements = useMemo(() => buildMovements(snaps), [snaps]);
  const leagues = useMemo(
    () => Array.from(new Set(movements.map(m => m.league))).sort(),
    [movements],
  );
  const filtered = useMemo(
    () => movements
      .filter(m => m.max_drift >= thresholdPp)
      .filter(m => leagueFilter === "all" || m.league === leagueFilter)
      .slice(0, 100),
    [movements, thresholdPp, leagueFilter],
  );

  const totalSnaps = snaps.length;
  const matchesWith2plus = movements.length;
  const movers5pp = movements.filter(m => m.max_drift >= 5).length;

  return (
    <AppShell>
      <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>
        <div style={{ marginBottom: "24px" }}>
          <h1 style={{ color: "#d4b86a", fontSize: "24px", margin: 0 }}>
            Line Movements
          </h1>
          <div style={{ color: "#8a7560", fontSize: "13px", marginTop: "4px" }}>
            Sharp (Pinnacle vig-removed) probability shifts between earliest and latest snapshot per match.
            Source: <code style={{ background: "#1a0f0a", padding: "1px 6px", borderRadius: "3px" }}>odds_snapshots</code> appended by fetch-odds cron.
          </div>
        </div>

        {/* Filter bar */}
        <div style={{
          display: "flex", gap: "16px", marginBottom: "20px", flexWrap: "wrap",
          background: "#1a0f0a", padding: "12px 16px", borderRadius: "8px",
          border: "1px solid #2a1f1a",
        }}>
          <div>
            <div style={{ color: "#8a7560", fontSize: "11px", marginBottom: "4px" }}>WINDOW</div>
            <div style={{ display: "flex", gap: "4px" }}>
              {WINDOW_OPTIONS.map((opt) => (
                <button key={opt.label}
                  onClick={() => setWindowHours(opt.hours)}
                  style={{
                    padding: "5px 10px", background: windowHours === opt.hours ? "#d4b86a" : "transparent",
                    color: windowHours === opt.hours ? "#1a0f0a" : "#d4b86a",
                    border: "1px solid #d4b86a50", borderRadius: "4px",
                    fontSize: "12px", cursor: "pointer",
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ color: "#8a7560", fontSize: "11px", marginBottom: "4px" }}>THRESHOLD</div>
            <div style={{ display: "flex", gap: "4px" }}>
              {THRESHOLD_OPTIONS.map((opt) => (
                <button key={opt.label}
                  onClick={() => setThresholdPp(opt.pp)}
                  style={{
                    padding: "5px 10px", background: thresholdPp === opt.pp ? "#d4b86a" : "transparent",
                    color: thresholdPp === opt.pp ? "#1a0f0a" : "#d4b86a",
                    border: "1px solid #d4b86a50", borderRadius: "4px",
                    fontSize: "12px", cursor: "pointer",
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ color: "#8a7560", fontSize: "11px", marginBottom: "4px" }}>LEAGUE</div>
            <select value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)}
              style={{
                padding: "5px 10px", background: "#1a0f0a", color: "#d4b86a",
                border: "1px solid #d4b86a50", borderRadius: "4px", fontSize: "12px",
              }}>
              <option value="all">all</option>
              {leagues.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div style={{ marginLeft: "auto", color: "#8a7560", fontSize: "12px" }}>
            {totalSnaps} snapshots · {matchesWith2plus} matches w/ ≥2 snaps · {movers5pp} ≥5pp movers
          </div>
        </div>

        {loading && <div style={{ color: "#8a7560", padding: "20px" }}>Loading…</div>}
        {error && <div style={{ color: "#c47070", padding: "20px" }}>Error: {error}</div>}

        {!loading && !error && filtered.length === 0 && (
          <div style={{
            padding: "40px", textAlign: "center", color: "#8a7560",
            background: "#1a0f0a", borderRadius: "8px",
          }}>
            <div style={{ fontSize: "16px", color: "#d4b86a", marginBottom: "12px" }}>
              No movements yet
            </div>
            <div>
              {totalSnaps === 0
                ? "No snapshots in this window. Wait for fetch-odds cron (every 4h Fri-Sun + Wed)."
                : matchesWith2plus === 0
                  ? `${totalSnaps} snapshot(s) but no match has ≥2 yet. Wait for next cron tick.`
                  : `${matchesWith2plus} matches have movements but none meet the ≥${thresholdPp}pp threshold. Try lowering it.`}
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ overflowX: "auto", background: "#1a0f0a", borderRadius: "8px", border: "1px solid #2a1f1a" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #2a1f1a", background: "#15090a" }}>
                  <th style={{ textAlign: "left", padding: "10px 12px", color: "#8a7560", fontWeight: 500 }}>Match</th>
                  <th style={{ textAlign: "left", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>League</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Δ H</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Δ D</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Δ A</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Now (best)</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Span</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", color: "#8a7560", fontWeight: 500 }}>Snaps</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, i) => (
                  <tr key={m.match_key + "-" + i} style={{ borderBottom: "1px solid #2a1f1a" }}>
                    <td style={{ padding: "8px 12px", color: "#d4b86a" }}>
                      {m.home_team} <span style={{ color: "#8a7560" }}>vs</span> {m.away_team}
                    </td>
                    <td style={{ padding: "8px", color: "#8a7560", fontSize: "12px" }}>{m.league}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: deltaColor(m.dH), fontVariantNumeric: "tabular-nums" }}>
                      {fmtDelta(m.dH)}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: deltaColor(m.dD), fontVariantNumeric: "tabular-nums" }}>
                      {fmtDelta(m.dD)}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: deltaColor(m.dA), fontVariantNumeric: "tabular-nums" }}>
                      {fmtDelta(m.dA)}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#8a7560", fontVariantNumeric: "tabular-nums", fontSize: "12px" }}>
                      {m.now_h?.toFixed(2)}/{m.now_d?.toFixed(2)}/{m.now_a?.toFixed(2)}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#8a7560", fontSize: "12px" }}>
                      {m.hours_span < 1 ? `${Math.round(m.hours_span * 60)}m` : `${m.hours_span.toFixed(1)}h`}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#8a7560" }}>{m.n_snapshots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: "24px", color: "#8a7560", fontSize: "11px", lineHeight: 1.6 }}>
          <strong>Reading the table:</strong> Δ values are pct-point shifts in vig-removed Pinnacle prob.
          Green = side&apos;s implied prob ROSE since earliest snapshot (sharp money / news favored that side).
          Red = side weakened. <strong>≥5pp shift</strong> typically reflects new information rather than noise;
          ≥10pp is rare and worth investigating.
        </div>
      </div>
    </AppShell>
  );
}

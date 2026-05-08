// ═══════════════════════════════════════════════════════════════════════
// Per-match line movement sparkline
// ═══════════════════════════════════════════════════════════════════════
//
// Reads odds_snapshots for one match_key, renders a compact 3-line SVG
// sparkline showing vig-removed Pinnacle prob H/D/A over time. Embedded
// in MatchDetail's "Quoten" tab — surfaces line movement directly on
// the gamecard so user doesn't have to navigate to /movements.
//
// "When available" gating: silently renders nothing when <2 snapshots
// exist for the match. This is the common case during the data-
// accumulation period after a fresh match enters the schedule (each
// match needs ≥2 cron-ticks = ≥4h to first show movement).
//
// Match key construction mirrors src/lib/format.ts::matchKey:
//   league:slug(home)-slug(away), where slug = lowercase-alphanumeric only.
// Same logic used by fetch-odds.mjs commit 652f2fa when appending
// snapshots, so this lookup is deterministic.
// ═══════════════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useMemo } from "react";
import { useApp } from "@/contexts/AppContext";

interface Snapshot {
  snapshot_time: string;
  odds: { _sharp?: { h?: number; d?: number; a?: number } };
}

interface Props {
  league: string;
  homeTeam: string;
  awayTeam: string;
  /** seconds, default 7 days back */
  windowSeconds?: number;
  /** SVG dimensions, default 320×72 */
  width?: number;
  height?: number;
}

function slug(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function vigRemove(sharp?: { h?: number; d?: number; a?: number }) {
  const h = sharp?.h, d = sharp?.d, a = sharp?.a;
  if (!h || !d || !a) return null;
  const sum = 1 / h + 1 / d + 1 / a;
  return { h: 1 / h / sum, d: 1 / d / sum, a: 1 / a / sum };
}

export default function LineMovementChart({
  league,
  homeTeam,
  awayTeam,
  windowSeconds = 7 * 86400,
  width = 320,
  height = 72,
}: Props) {
  const { supabase } = useApp();
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const matchKey = useMemo(
    () => `${league}:${slug(homeTeam)}-${slug(awayTeam)}`,
    [league, homeTeam, awayTeam],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
      const { data } = await supabase
        .from("odds_snapshots")
        .select("snapshot_time, odds")
        .eq("match_key", matchKey)
        .gte("snapshot_time", since)
        .order("snapshot_time", { ascending: true })
        .limit(200);
      if (cancelled) return;
      setSnaps((data || []) as Snapshot[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, matchKey, windowSeconds]);

  // Compute series + axes
  const series = useMemo(() => {
    const valid = snaps
      .map(s => ({ t: +new Date(s.snapshot_time), p: vigRemove(s.odds._sharp) }))
      .filter((x): x is { t: number; p: { h: number; d: number; a: number } } => x.p !== null);
    if (valid.length < 2) return null;
    const tMin = valid[0].t, tMax = valid[valid.length - 1].t;
    // Y axis: stretch to actual range so subtle moves are visible — but
    // floor a 5pp band so a flat line doesn't render as zigzag noise.
    const allP = valid.flatMap(v => [v.p.h, v.p.d, v.p.a]);
    let yMin = Math.min(...allP), yMax = Math.max(...allP);
    const range = yMax - yMin;
    if (range < 0.05) {
      const center = (yMin + yMax) / 2;
      yMin = Math.max(0, center - 0.05);
      yMax = Math.min(1, center + 0.05);
    } else {
      // small padding (5%) so endpoints don't touch the edges
      yMin = Math.max(0, yMin - range * 0.1);
      yMax = Math.min(1, yMax + range * 0.1);
    }
    const xScale = (t: number) => tMax === tMin ? width / 2 : ((t - tMin) / (tMax - tMin)) * width;
    const yScale = (p: number) => height - ((p - yMin) / (yMax - yMin)) * height;
    return { valid, xScale, yScale, tMin, tMax, yMin, yMax };
  }, [snaps, width, height]);

  if (loading) return null;
  if (!series) return null;

  const path = (key: "h" | "d" | "a") =>
    series.valid.map((v, i) =>
      `${i === 0 ? "M" : "L"} ${series.xScale(v.t).toFixed(1)} ${series.yScale(v.p[key]).toFixed(1)}`
    ).join(" ");

  // Latest values for legend
  const latest = series.valid[series.valid.length - 1].p;
  const earliest = series.valid[0].p;
  const dH = ((latest.h - earliest.h) * 100);
  const dD = ((latest.d - earliest.d) * 100);
  const dA = ((latest.a - earliest.a) * 100);

  const fmtDelta = (pp: number) => {
    if (Math.abs(pp) < 0.05) return "·";
    return `${pp > 0 ? "+" : ""}${pp.toFixed(1)}`;
  };
  const dColor = (pp: number) => Math.abs(pp) < 0.5 ? "#8a7560" : pp > 0 ? "#6aad55" : "#c47070";

  // Hours span (for "X over Y hours" headline)
  const hours = (series.tMax - series.tMin) / 3600_000;
  const spanLabel = hours < 1 ? `${Math.round(hours * 60)}min` : hours < 24 ? `${hours.toFixed(0)}h` : `${(hours / 24).toFixed(1)}d`;

  return (
    <div style={{
      background: "#1a0f0a",
      border: "1px solid #2a1f1a",
      borderRadius: 6,
      padding: "8px 10px",
      marginTop: 8,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 4, fontSize: 10, color: "#8a7560",
      }}>
        <span>SHARP MOVEMENT · last {spanLabel} · {series.valid.length} snaps</span>
        <span style={{ fontSize: 10, fontFamily: "'SF Mono', Consolas, monospace" }}>
          H <span style={{ color: dColor(dH) }}>{fmtDelta(dH)}</span>{" · "}
          D <span style={{ color: dColor(dD) }}>{fmtDelta(dD)}</span>{" · "}
          A <span style={{ color: dColor(dA) }}>{fmtDelta(dA)}</span>
        </span>
      </div>
      <svg width={width} height={height} style={{ display: "block" }}>
        <path d={path("h")} fill="none" stroke="#6aad55" strokeWidth="1.5" opacity="0.9" />
        <path d={path("d")} fill="none" stroke="#8a7560" strokeWidth="1.5" opacity="0.7" />
        <path d={path("a")} fill="none" stroke="#d4b86a" strokeWidth="1.5" opacity="0.9" />
      </svg>
      <div style={{
        display: "flex", gap: 12, fontSize: 9, color: "#8a7560", marginTop: 4,
      }}>
        <span><span style={{ color: "#6aad55" }}>━</span> Heim</span>
        <span><span style={{ color: "#8a7560" }}>━</span> Remis</span>
        <span><span style={{ color: "#d4b86a" }}>━</span> Auswärts</span>
      </div>
    </div>
  );
}

"use client";
import { ENGINES, type PredictionEngine } from "@/lib/engine-registry";
import { color } from "@/styles/tokens";

// ─── Types ───────────────────────────────────────────────────────
// Minimal shape we need from each engine's mk. Keeps this component
// independent of the full MatchCalc interface — so it survives engine
// internals changes.
interface EngineMk {
  H: number;
  D: number;
  A: number;
  O25?: number;
}

interface AllEnginesMk {
  "ensemble-v1": EngineMk | null;
  "poisson-ml": EngineMk | null;
  "poisson-ml-v2": EngineMk | null;
  "footbayes-hierarchical": EngineMk | null;
}

// ─── Divergence detection ────────────────────────────────────────
// Flag when any pair of engines disagree by >= DIVERGENCE_PP percentage
// points on any 1X2 outcome. Meaningful disagreement = worth a second look.
const DIVERGENCE_PP = 0.08; // 8pp threshold

function maxDivergence(all: AllEnginesMk): number {
  const engines: EngineMk[] = [];
  for (const key of ["ensemble-v1", "poisson-ml", "poisson-ml-v2", "footbayes-hierarchical"] as const) {
    if (all[key]) engines.push(all[key]!);
  }
  if (engines.length < 2) return 0;
  let maxPp = 0;
  for (const key of ["H", "D", "A"] as const) {
    let min = Infinity, max = -Infinity;
    for (const e of engines) {
      if (e[key] < min) min = e[key];
      if (e[key] > max) max = e[key];
    }
    maxPp = Math.max(maxPp, max - min);
  }
  return maxPp;
}

// ─── Formatting helpers ──────────────────────────────────────────
const pc = (v: number | undefined) => (v == null ? "—" : (v * 100).toFixed(0) + "%");

// ─── Styles ──────────────────────────────────────────────────────
const S = {
  section: {
    marginTop: 12,
    padding: 10,
    background: `${color.goldMid}08`,
    border: "1px solid #c4a26520",
    borderRadius: 8,
  } as React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  } as React.CSSProperties,
  title: {
    fontSize: 10,
    fontWeight: 700,
    color: color.gold,
    letterSpacing: 0.6,
  } as React.CSSProperties,
  divergeBadge: (divergent: boolean) => ({
    fontSize: 9,
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: 10,
    border: `1px solid ${divergent ? color.warn : color.value}40`,
    background: divergent ? "#c4707020" : "#6aad5520",
    color: divergent ? color.warn : color.value,
    letterSpacing: 0.3,
  }),
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto auto auto",
    gap: "3px 8px",
    alignItems: "center",
    fontSize: 11,
  } as React.CSSProperties,
  // Wraps the active row in a subtle gold-tinted band so the user can
  // see at a glance which engine drives the value-bets below.
  // display: "contents" doesn't allow border, so we re-implement with
  // a thin gold left-border via box-shadow on the cells (works without
  // breaking the grid layout). See activeRowCell.
  activeRowCell: (active: boolean): React.CSSProperties => ({
    background: active ? `${color.gold}12` : "transparent",
    borderTop: active ? "1px solid #d4b86a40" : "1px solid transparent",
    borderBottom: active ? "1px solid #d4b86a40" : "1px solid transparent",
    padding: "4px 6px",
    margin: "-3px 0",   // collapse the grid row-gap so the band looks continuous
  }),
  activeRowFirstCell: (active: boolean): React.CSSProperties => ({
    background: active ? `${color.gold}12` : "transparent",
    borderTop: active ? "1px solid #d4b86a40" : "1px solid transparent",
    borderBottom: active ? "1px solid #d4b86a40" : "1px solid transparent",
    borderLeft: active ? "2px solid #d4b86a" : "2px solid transparent",
    padding: "4px 8px 4px 6px",
    margin: "-3px 0",
  }),
  activeRowLastCell: (active: boolean): React.CSSProperties => ({
    background: active ? `${color.gold}12` : "transparent",
    borderTop: active ? "1px solid #d4b86a40" : "1px solid transparent",
    borderBottom: active ? "1px solid #d4b86a40" : "1px solid transparent",
    borderRight: active ? "1px solid #d4b86a40" : "1px solid transparent",
    padding: "4px 8px 4px 6px",
    margin: "-3px 0",
  }),
  colHead: {
    fontSize: 9,
    color: `${color.goldMid}80`,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
    fontWeight: 600,
  } as React.CSSProperties,
  colHeadFirst: {
    fontSize: 9,
    color: `${color.goldMid}80`,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    fontWeight: 600,
  } as React.CSSProperties,
  engineCell: (active: boolean) => ({
    fontSize: 11,
    fontWeight: active ? 700 : 500,
    color: active ? color.gold : color.text,
  }),
  probCell: (active: boolean, diverges: boolean) => ({
    fontSize: 11,
    fontWeight: active ? 700 : 500,
    fontFamily: "SF Mono, Consolas, monospace",
    color: active ? color.gold : diverges ? color.warn : "#c4a265",
    textAlign: "right" as const,
    fontVariantNumeric: "tabular-nums" as const,
  }),
  empty: {
    fontSize: 10,
    color: `${color.goldMid}60`,
    fontStyle: "italic" as const,
  },
  hint: {
    fontSize: 9,
    color: `${color.goldMid}60`,
    marginTop: 6,
    lineHeight: 1.4,
  } as React.CSSProperties,
};

// ─── Component ───────────────────────────────────────────────────

export default function EngineComparison({
  allEnginesMk,
  activeEngine,
}: {
  allEnginesMk: AllEnginesMk | null | undefined;
  activeEngine: PredictionEngine;
}) {
  if (!allEnginesMk) return null;

  // Find engines with data (skip missing ones silently — matches without
  // xG history can't run the ML engines, no value shaming them)
  const rows = ENGINES.filter((e) => allEnginesMk[e.id] != null);
  if (rows.length === 0) return null;

  const divergence = maxDivergence(allEnginesMk);
  const isDivergent = divergence >= DIVERGENCE_PP;

  return (
    <section style={S.section} aria-label="Engine-Vergleich">
      <div style={S.header}>
        <div style={S.title}>ENGINE-VERGLEICH</div>
        <div style={S.divergeBadge(isDivergent)}>
          {isDivergent
            ? `Δ ${(divergence * 100).toFixed(0)}pp uneinig`
            : `Δ ${(divergence * 100).toFixed(0)}pp einig`}
        </div>
      </div>

      <div style={S.grid}>
        <div style={S.colHeadFirst}>Engine</div>
        <div style={S.colHead}>1</div>
        <div style={S.colHead}>X</div>
        <div style={S.colHead}>2</div>
        <div style={S.colHead}>Ü2.5</div>

        {rows.map((e) => {
          const mk = allEnginesMk[e.id]!;
          const active = e.id === activeEngine;
          // Highlight cells that deviate > 5pp from the other engines
          const isOutlier = (key: "H" | "D" | "A") => {
            const vals = rows
              .map((r) => allEnginesMk[r.id]?.[key])
              .filter((v): v is number => v != null);
            if (vals.length < 2) return false;
            const others = vals.filter((_, i) => rows[i].id !== e.id);
            if (others.length === 0) return false;
            const othersAvg = others.reduce((s, v) => s + v, 0) / others.length;
            return Math.abs(mk[key] - othersAvg) >= 0.05;
          };
          return (
            <div
              key={e.id}
              style={{ display: "contents" }}
              aria-current={active ? "true" : undefined}
            >
              <div style={{ ...S.activeRowFirstCell(active), ...S.engineCell(active) }}>
                {active ? "▸ " : ""}
                {e.name}
              </div>
              <div style={{ ...S.activeRowCell(active), ...S.probCell(active, isOutlier("H")) }}>{pc(mk.H)}</div>
              <div style={{ ...S.activeRowCell(active), ...S.probCell(active, isOutlier("D")) }}>{pc(mk.D)}</div>
              <div style={{ ...S.activeRowCell(active), ...S.probCell(active, isOutlier("A")) }}>{pc(mk.A)}</div>
              <div style={{ ...S.activeRowLastCell(active), ...S.probCell(active, false) }}>{pc(mk.O25)}</div>
            </div>
          );
        })}
      </div>

      {isDivergent && (
        <div style={S.hint}>
          Die Engines weichen stark voneinander ab. Rote Zellen = {">= "}5pp Ausreißer.
          Uneinigkeit bedeutet: ein Modell kennt einen Faktor, den die anderen nicht
          sehen — oder überschätzt ihn. Lohnt sich, das Match genauer zu prüfen.
        </div>
      )}
    </section>
  );
}

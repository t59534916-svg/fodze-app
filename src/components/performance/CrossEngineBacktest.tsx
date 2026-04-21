"use client";

import { useEffect, useState } from "react";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";
import { text } from "@/styles/components";

interface OverallMetrics {
  n: number;
  brier: number;
  brier_skill_score: number;
  log_loss: number;
  rps: number;
  ece_10bucket: number;
  base_rate: { H: number; D: number; A: number };
  bss_ci95: { low: number; high: number } | null;
}

interface LeagueMetrics {
  n: number;
  bss: number;
  log_loss: number;
  ece: number;
}

interface ConformalAlpha {
  nominal_coverage: number;
  empirical_coverage: number;
  avg_set_size: number;
  singleton_rate: number;
}

interface EngineSummary {
  overall: OverallMetrics;
  applied_n: number;
  per_league_bss: Record<string, LeagueMetrics>;
  conformal?: Record<string, ConformalAlpha>;
}

interface KellyEnginePayload {
  n_bets: number;
  hit_rate: number;
  roi: number;
  final_bankroll: number;
  max_drawdown: number;
  sharpe_daily_annualised: number;
  note: string | null;
}

interface KellyBlock {
  profile: string;
  starting_bankroll: number;
  edge_min: number;
  edge_max: number;
  conformal_gate: string;
  conformal_alpha: number | null;
  odds_source?: string;
  per_engine: Record<string, KellyEnginePayload>;
}

interface BacktestSummary {
  generated_at: string;
  n_rows: number;
  n_leagues: number;
  engines: Record<string, EngineSummary>;
  kelly?: KellyBlock;
  kelly_enforce?: KellyBlock;
  kelly_best?: KellyBlock;
  kelly_best_enforce?: KellyBlock;
}

const ENGINE_LABEL: Record<string, string> = {
  v1: "v1 Poisson-GLM",
  v2_raw: "v2 roh",
  v2_dirichlet: "v2 + Dirichlet",
  v2_benter: "v2 + Benter",
};

const S = {
  card: { background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.md, padding: `${space[5]}px`, marginBottom: space[4] } as React.CSSProperties,
  label: { ...text.label, marginBottom: space[2] } as React.CSSProperties,
  small: { ...text.muted } as React.CSSProperties,
  table: { fontSize: fontSize.xs, borderCollapse: "collapse" as const, width: "100%" },
  th: { padding: `${space[1]}px ${space[2]}px`, borderBottom: `1px solid ${color.border}`, textAlign: "right" as const, color: `${color.gold}70`, fontWeight: fontWeight.semibold },
  thLeft: { padding: `${space[1]}px ${space[2]}px`, borderBottom: `1px solid ${color.border}`, textAlign: "left" as const, color: `${color.gold}70`, fontWeight: fontWeight.semibold },
  td: { padding: `${space[1]}px ${space[2]}px`, textAlign: "right" as const, color: `${color.gold}90` },
  tdLeft: { padding: `${space[1]}px ${space[2]}px`, textAlign: "left" as const, color: color.gold, fontWeight: fontWeight.semibold },
};

function sign4(x: number) {
  return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
}

function pct2(x: number) {
  return (x * 100).toFixed(2) + "%";
}

function num4(x: number) {
  return x.toFixed(4);
}

function KellyCard({ block, engines, title }: { block: KellyBlock; engines: string[]; title: string }) {
  const gateLabel = block.conformal_gate !== "off"
    ? `, Gate ${block.conformal_gate} (α=${block.conformal_alpha})`
    : "";
  const isBest = block.odds_source === "best";
  const pricingLabel = isBest ? "bester Soft-Book-Close (football-data Max)" : "Pinnacle Close";
  return (
    <div style={S.card}>
      <div style={{ ...S.label, marginBottom: 6 }}>
        {title} — Profil {block.profile}, Goldilocks {(block.edge_min * 100).toFixed(1)}–{(block.edge_max * 100).toFixed(1)}%
        {gateLabel}
      </div>
      <div style={{ ...S.small, marginBottom: 10 }}>
        Bankroll {block.starting_bankroll.toLocaleString("de-DE")}€, Wetten gegen {pricingLabel}.
        {isBest
          ? " Das ist die Quote die ein realer Bettor durch Quote-Shopping bekommt — die Produktionsnahe ROI-Kurve."
          : " Negative ROI ist erwartet: Pinnacle ≈ true prob, kein Platzierungs-Edge."}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.thLeft}>Engine</th>
              <th style={S.th}>Wetten</th>
              <th style={S.th}>Hit%</th>
              <th style={S.th}>ROI</th>
              <th style={S.th}>Final</th>
              <th style={S.th}>max DD</th>
            </tr>
          </thead>
          <tbody>
            {engines.map((e) => {
              const k = block.per_engine[e];
              if (!k || k.n_bets === 0) {
                return (
                  <tr key={e}>
                    <td style={S.tdLeft}>{ENGINE_LABEL[e] ?? e}</td>
                    <td style={{ ...S.td, color: `${color.gold}40` }} colSpan={5}>{k?.note ?? "—"}</td>
                  </tr>
                );
              }
              return (
                <tr key={e}>
                  <td style={S.tdLeft}>{ENGINE_LABEL[e] ?? e}</td>
                  <td style={S.td}>{k.n_bets.toLocaleString("de-DE")}</td>
                  <td style={S.td}>{pct2(k.hit_rate)}</td>
                  <td style={{ ...S.td, color: k.roi > 0 ? color.value : color.warn, fontWeight: fontWeight.semibold }}>{sign4(k.roi)}</td>
                  <td style={S.td}>{k.final_bankroll.toLocaleString("de-DE", { maximumFractionDigits: 0 })}</td>
                  <td style={S.td}>{pct2(k.max_drawdown)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CrossEngineBacktest() {
  const [data, setData] = useState<BacktestSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/backtest-summary.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={S.card}><div style={S.small}>Backtest-Summary konnte nicht geladen werden: {err}</div></div>;
  if (!data) return <div style={S.card}><div style={S.small}>Lade Cross-Engine Backtest...</div></div>;

  const engines = Object.keys(data.engines);
  const generated = new Date(data.generated_at).toLocaleDateString("de-DE");

  return (
    <>
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: 6 }}>Cross-Engine OOT — {data.n_rows.toLocaleString("de-DE")} Spiele, {data.n_leagues} Ligen</div>
        <div style={{ ...S.small, marginBottom: 10 }}>
          Hold-out ab 2023-08-01. Drei Kalibrierungs-Varianten der v2-Engine
          nebeneinander. Niedriger Brier = besser; höherer BSS = schlägt die
          Climatology (Liga-Durchschnitt). ECE {"<"} 0.05 = gut kalibriert.
          Stand: {generated}.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.thLeft}>Engine</th>
                <th style={S.th}>Brier</th>
                <th style={S.th}>BSS</th>
                <th style={S.th}>LogLoss</th>
                <th style={S.th}>ECE</th>
                <th style={S.th}>applied</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((e) => {
                const ov = data.engines[e].overall;
                const applied = (data.engines[e].applied_n / ov.n) * 100;
                return (
                  <tr key={e}>
                    <td style={S.tdLeft}>{ENGINE_LABEL[e] ?? e}</td>
                    <td style={S.td}>{num4(ov.brier)}</td>
                    <td style={{ ...S.td, color: ov.brier_skill_score > 0 ? color.value : color.warn }}>{sign4(ov.brier_skill_score)}</td>
                    <td style={S.td}>{num4(ov.log_loss)}</td>
                    <td style={{ ...S.td, color: ov.ece_10bucket < 0.02 ? color.value : `${color.gold}90` }}>{num4(ov.ece_10bucket)}</td>
                    <td style={S.td}>{applied.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data.engines[engines[0]].conformal && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: 6 }}>Konforme Abdeckung</div>
          <div style={{ ...S.small, marginBottom: 10 }}>
            Empirische Coverage der Vorhersage-Sets pro Engine und α.
            Nominal = 1−α. Abweichung {">"} 1 pp = Indikator, dass die
            conformal-Quantile nicht zur gelieferten Probabilitäts-Verteilung passen.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.thLeft}>Engine</th>
                  <th style={S.th}>α</th>
                  <th style={S.th}>Nominal</th>
                  <th style={S.th}>Empirisch</th>
                  <th style={S.th}>Δ</th>
                  <th style={S.th}>∅ Set-Size</th>
                  <th style={S.th}>Singleton%</th>
                </tr>
              </thead>
              <tbody>
                {engines.flatMap((e) => {
                  const cf = data.engines[e].conformal;
                  if (!cf) return [];
                  return Object.entries(cf).map(([alpha, d], idx) => {
                    const delta = d.empirical_coverage - d.nominal_coverage;
                    return (
                      <tr key={`${e}-${alpha}`}>
                        <td style={S.tdLeft}>{idx === 0 ? (ENGINE_LABEL[e] ?? e) : ""}</td>
                        <td style={S.td}>{alpha}</td>
                        <td style={S.td}>{pct2(d.nominal_coverage)}</td>
                        <td style={S.td}>{pct2(d.empirical_coverage)}</td>
                        <td style={{ ...S.td, color: Math.abs(delta) < 0.01 ? color.value : color.gold }}>{sign4(delta)}</td>
                        <td style={S.td}>{d.avg_set_size.toFixed(2)}</td>
                        <td style={S.td}>{pct2(d.singleton_rate)}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.kelly && <KellyCard block={data.kelly} engines={engines} title="Kelly — Pinnacle Close (Baseline)" />}
      {data.kelly_enforce && <KellyCard block={data.kelly_enforce} engines={engines} title="Kelly — Pinnacle + Konformal-Gate (enforce)" />}
      {data.kelly_best && <KellyCard block={data.kelly_best} engines={engines} title="Kelly — Quote-Shopping (Max Soft-Book Close)" />}
      {data.kelly_best_enforce && <KellyCard block={data.kelly_best_enforce} engines={engines} title="Kelly — Quote-Shopping + Konformal-Gate (enforce) [produktionsnah]" />}

      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: 6 }}>Per-Liga BSS (v2 + Dirichlet)</div>
        <div style={{ ...S.small, marginBottom: 10 }}>
          Brier Skill Score pro Liga vs. Climatology. BSS {">"} 0 = schlägt den
          Liga-Durchschnitt, BSS {"<"} 0 = verliert gegen den Durchschnitt.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.thLeft}>Liga</th>
                <th style={S.th}>N</th>
                <th style={S.th}>BSS</th>
                <th style={S.th}>LogLoss</th>
                <th style={S.th}>ECE</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.engines.v2_dirichlet?.per_league_bss ?? {})
                .sort((a, b) => b[1].bss - a[1].bss)
                .map(([lg, m]) => (
                  <tr key={lg}>
                    <td style={S.tdLeft}>{lg}</td>
                    <td style={S.td}>{m.n}</td>
                    <td style={{ ...S.td, color: m.bss > 0 ? color.value : color.warn }}>{sign4(m.bss)}</td>
                    <td style={S.td}>{num4(m.log_loss)}</td>
                    <td style={S.td}>{num4(m.ece)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

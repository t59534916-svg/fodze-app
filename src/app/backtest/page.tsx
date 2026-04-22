"use client";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { useApp } from "@/contexts/AppContext";
import {
  loadPredictions,
  loadOutcomes,
  type MatchPrediction,
  type MatchOutcome,
} from "@/lib/supabase";
import { scoreMatch, aggregate, type MatchScore } from "@/lib/backtest";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";
import { page as pageStyle, text } from "@/styles/components";

const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : (v * 100).toFixed(digits) + "%";
const num = (v: number | null | undefined, digits = 3) =>
  v == null ? "—" : v.toFixed(digits);

// Join predictions × outcomes on match_key, score each pair, group
// by engine. Returns per-engine aggregates + raw scored matches.
type EnginePerf = {
  engine: string;
  agg: ReturnType<typeof aggregate>;
  rows: Array<{
    pred: MatchPrediction;
    out: MatchOutcome;
    score: MatchScore;
  }>;
};

function buildPerf(predictions: MatchPrediction[], outcomes: MatchOutcome[]): EnginePerf[] {
  const outByKey = new Map(outcomes.map(o => [o.match_key, o]));
  const byEngine = new Map<string, EnginePerf["rows"]>();
  for (const p of predictions) {
    const o = outByKey.get(p.match_key);
    if (!o || o.outcome_1x2 == null) continue;
    const score = scoreMatch(
      { prob_h: p.prob_h, prob_d: p.prob_d, prob_a: p.prob_a, prob_o25: p.prob_o25 ?? null, prob_btts: p.prob_btts ?? null },
      { outcome_1x2: o.outcome_1x2 as "H" | "D" | "A", over25: !!o.over25, btts: !!o.btts },
    );
    if (!byEngine.has(p.engine)) byEngine.set(p.engine, []);
    byEngine.get(p.engine)!.push({ pred: p, out: o, score });
  }
  return Array.from(byEngine.entries()).map(([engine, rows]) => ({
    engine,
    agg: aggregate(rows.map(r => r.score)),
    rows,
  }));
}

export default function BacktestPage() {
  const { supabase, league } = useApp();
  const [predictions, setPredictions] = useState<MatchPrediction[]>([]);
  const [outcomes, setOutcomes] = useState<MatchOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [leagueFilter, setLeagueFilter] = useState<"all" | string>("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [preds, outs] = await Promise.all([
        loadPredictions(supabase, { limit: 2000 }),
        loadOutcomes(supabase, { limit: 2000 }),
      ]);
      if (!alive) return;
      setPredictions(preds);
      setOutcomes(outs);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [supabase]);

  const leagues = useMemo(() => {
    const s = new Set<string>();
    for (const p of predictions) s.add(p.league);
    return Array.from(s).sort();
  }, [predictions]);

  const perf = useMemo(() => {
    const filtered = leagueFilter === "all"
      ? predictions
      : predictions.filter(p => p.league === leagueFilter);
    return buildPerf(filtered, outcomes);
  }, [predictions, outcomes, leagueFilter]);

  const totalMatches = outcomes.length;
  const scoredMatches = perf.reduce((max, e) => Math.max(max, e.rows.length), 0);

  return (
    <AppShell>
      <div style={{ ...pageStyle, padding: `${space[5]}px` }}>
        <h1 style={{
          ...text.heading, marginBottom: space[2],
          background: `linear-gradient(135deg, ${color.goldDark}, ${color.goldShine}, ${color.gold}, ${color.goldDark})`,
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          Backtest
        </h1>
        <p style={{ ...text.muted, marginBottom: space[5] }}>
          Wie gut waren die Vorhersagen? Pro Engine: Brier-Score + Log-Loss + Favorit-Trefferquote
          auf gescorten Matches (Prediction × Outcome per <code>match_key</code>).
        </p>

        {/* League filter */}
        <div style={{ display: "flex", gap: space[3], alignItems: "center", marginBottom: space[5], flexWrap: "wrap" }}>
          <span style={{ ...text.label }}>Liga:</span>
          <button
            onClick={() => setLeagueFilter("all")}
            style={{
              padding: "4px 10px", borderRadius: radius.sm, fontSize: fontSize.xs,
              background: leagueFilter === "all" ? color.gold : `${color.goldMid}15`,
              color: leagueFilter === "all" ? color.leather : color.goldMid,
              border: `1px solid ${color.gold}40`, cursor: "pointer",
            }}
          >
            Alle ({outcomes.length})
          </button>
          {leagues.map(l => (
            <button key={l}
              onClick={() => setLeagueFilter(l)}
              style={{
                padding: "4px 10px", borderRadius: radius.sm, fontSize: fontSize.xs,
                background: leagueFilter === l ? color.gold : `${color.goldMid}15`,
                color: leagueFilter === l ? color.leather : color.goldMid,
                border: `1px solid ${color.gold}40`, cursor: "pointer",
              }}
            >
              {l}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ ...text.muted, padding: space[6], textAlign: "center" }}>Lade...</div>
        ) : perf.length === 0 ? (
          <div style={{
            padding: space[6], borderRadius: radius.md,
            background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}15`,
            color: color.goldMid, fontSize: fontSize.sm, textAlign: "center",
          }}>
            <strong style={{ color: color.gold }}>Noch keine bewerteten Matches.</strong><br />
            <span style={{ fontSize: fontSize.xs, lineHeight: 1.6 }}>
              Der Auto-Capture schnappt beim nächsten <code>/matchday</code>-Besuch die Engine-Vorhersagen.
              Ergebnisse (Goals, xG, Shots, Corners, Cards) kommen über einen Admin-Script oder manuell
              in die <code>match_outcomes</code> Tabelle. Ein Scoring läuft automatisch sobald beide
              Seiten für denselben <code>match_key</code> existieren.
            </span>
          </div>
        ) : (
          <>
            {/* Summary cards per engine */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: space[3], marginBottom: space[6] }}>
              {perf.map(e => (
                <div key={e.engine} style={{
                  padding: space[4], borderRadius: radius.md,
                  background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}20`,
                }}>
                  <div style={{ ...text.label, color: color.gold, marginBottom: space[2] }}>{e.engine}</div>
                  <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginBottom: space[3] }}>
                    {e.rows.length} Matches gescored
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${space[1]}px ${space[3]}px`, fontSize: fontSize.xs }}>
                    <span style={{ color: color.textMuted }}>Brier 1X2:</span>
                    <span style={{ color: color.text, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>{num(e.agg?.brier_1x2)}</span>
                    <span style={{ color: color.textMuted }}>Brier Ü2.5:</span>
                    <span style={{ color: color.text, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>{num(e.agg?.brier_o25)}</span>
                    <span style={{ color: color.textMuted }}>Brier BTTS:</span>
                    <span style={{ color: color.text, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>{num(e.agg?.brier_btts)}</span>
                    <span style={{ color: color.textMuted }}>Log-Loss 1X2:</span>
                    <span style={{ color: color.text, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>{num(e.agg?.logloss_1x2)}</span>
                    <span style={{ color: color.textMuted }}>Favorit-Hitrate:</span>
                    <span style={{ color: color.value, fontWeight: fontWeight.bold, fontVariantNumeric: "tabular-nums" }}>{pct(e.agg?.favorite_accuracy)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Match-by-match drill-down of best-scoring engine's recent matches */}
            <div style={{ ...text.label, marginBottom: space[3] }}>Letzte {Math.min(20, scoredMatches)} gescorte Matches</div>
            <div style={{ border: `1px solid ${color.goldMid}15`, borderRadius: radius.md, overflow: "hidden" }}>
              {perf[0]?.rows.slice(0, 20).map((row, i) => {
                const { pred, out, score } = row;
                const correct = score.correct_favorite;
                return (
                  <div key={i} style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto auto auto",
                    gap: space[3], alignItems: "center",
                    padding: `${space[3]}px ${space[4]}px`,
                    borderBottom: i < 19 ? `1px solid ${color.goldMid}10` : "none",
                    background: i % 2 === 0 ? `${color.goldMid}04` : "transparent",
                    fontSize: fontSize.xs,
                  }}>
                    <div>
                      <div style={{ color: color.text, fontWeight: fontWeight.semibold }}>
                        {pred.home_team} {out.goals_h} – {out.goals_a} {pred.away_team}
                      </div>
                      <div style={{ color: color.textMuted, fontSize: 10, marginTop: 2 }}>
                        {pred.league} · {out.match_date}
                        {out.xg_h != null && out.xg_a != null && (
                          <> · xG {out.xg_h?.toFixed(1)}–{out.xg_a?.toFixed(1)}</>
                        )}
                      </div>
                    </div>
                    <div style={{ color: color.textMuted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {pct(pred.prob_h, 0)} / {pct(pred.prob_d, 0)} / {pct(pred.prob_a, 0)}
                    </div>
                    <div style={{
                      padding: "2px 6px", borderRadius: radius.sm, fontSize: 10, fontWeight: fontWeight.bold,
                      background: correct ? `${color.value}20` : `${color.warn}20`,
                      color: correct ? color.value : color.warn,
                    }}>
                      {out.outcome_1x2}
                    </div>
                    <div style={{ color: color.textMuted, fontVariantNumeric: "tabular-nums" }}>
                      Brier {score.brier_1x2.toFixed(3)}
                    </div>
                    <div style={{ color: correct ? color.value : color.warn, fontSize: 10 }}>
                      {correct ? "✓" : "✗"}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div style={{ marginTop: space[6], fontSize: fontSize.xs, color: color.textMuted, lineHeight: 1.6 }}>
          <strong style={{ color: color.gold }}>Methodik:</strong> Rank-Brier für 1X2 (Mittel der drei binären Briers),
          binärer Brier für Ü2.5 und BTTS. Log-Loss mit EPS-Clipping bei 1e-6 damit einzelne certainty-Picks
          nicht in Unendlich laufen. Favorit-Hitrate = Anteil der Matches wo die höchste Model-Prob auf das
          tatsächliche Ergebnis fiel. Prediction-Capture ist <em>session-dedupliziert</em> (eine Capture pro
          Matchday-Load, nicht pro Ansicht).
        </div>
      </div>
    </AppShell>
  );
}

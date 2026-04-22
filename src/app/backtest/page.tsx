"use client";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { useApp } from "@/contexts/AppContext";
import {
  loadPredictions,
  loadOutcomes,
  loadAllTeamXGHistory,
  type MatchPrediction,
  type MatchOutcome,
} from "@/lib/supabase";
import { scoreMatch, aggregate, type MatchScore } from "@/lib/backtest";
import { replayLeague, analyzeRefinement, aggregatePhysicalMarkets, type ReplayRow } from "@/lib/historical-replay";
import { LEAGUES } from "@/lib/dixon-coles";
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
  const [tab, setTab] = useState<"live" | "historisch">("live");
  const [predictions, setPredictions] = useState<MatchPrediction[]>([]);
  const [outcomes, setOutcomes] = useState<MatchOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [leagueFilter, setLeagueFilter] = useState<"all" | string>("all");

  // Historical-replay state
  const [replayLeagueKey, setReplayLeagueKey] = useState<string>(league || "bundesliga");
  const [replayRows, setReplayRows] = useState<ReplayRow[] | null>(null);
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayProgress, setReplayProgress] = useState<string>("");

  const runHistoricalReplay = async () => {
    setReplayRunning(true);
    setReplayRows(null);
    setReplayProgress("Lade team_xg_history...");
    const allRows = await loadAllTeamXGHistory(supabase, replayLeagueKey);
    setReplayProgress(`Rekonstruiere ${allRows.length} Matches point-in-time...`);
    // Defer to next tick so the progress message can paint
    await new Promise(r => setTimeout(r, 50));
    const rows = replayLeague({ allRows, league: replayLeagueKey, minPriorGames: 6 });
    setReplayRows(rows);
    setReplayProgress("");
    setReplayRunning(false);
  };

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
        <p style={{ ...text.muted, marginBottom: space[4] }}>
          Wie gut waren die Vorhersagen? Brier-Score + Log-Loss + Favorit-Hitrate pro Engine.
          Keine Odds, keine ROI-Simulation — pure Model-vs-Reality.
        </p>

        {/* Tab switcher */}
        <div style={{ display: "flex", gap: space[2], marginBottom: space[5] }}>
          {(["live", "historisch"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: `${space[2]}px ${space[4]}px`, borderRadius: radius.sm,
              fontSize: fontSize.sm, fontWeight: tab === t ? fontWeight.bold : fontWeight.normal,
              background: tab === t ? color.gold : `${color.goldMid}15`,
              color: tab === t ? color.leather : color.goldMid,
              border: `1px solid ${color.gold}40`, cursor: "pointer",
            }}>
              {t === "live" ? "Live (Post-Match Captures)" : "Historisch (Replay)"}
            </button>
          ))}
        </div>

        {/* ═══ HISTORISCHER REPLAY TAB ═══ */}
        {tab === "historisch" && (
          <HistoricalReplayTab
            rows={replayRows}
            running={replayRunning}
            progress={replayProgress}
            leagueKey={replayLeagueKey}
            setLeagueKey={setReplayLeagueKey}
            run={runHistoricalReplay}
          />
        )}

        {/* ═══ LIVE TAB ═══ */}
        {tab === "live" && <>

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

        </>}{/* end Live tab */}

        <div style={{ marginTop: space[6], fontSize: fontSize.xs, color: color.textMuted, lineHeight: 1.6 }}>
          <strong style={{ color: color.gold }}>Methodik:</strong> Rank-Brier für 1X2 (Mittel der drei binären Briers),
          binärer Brier für Ü2.5 und BTTS. Log-Loss mit EPS-Clipping bei 1e-6 damit einzelne certainty-Picks
          nicht in Unendlich laufen. Favorit-Hitrate = Anteil der Matches wo die höchste Model-Prob auf das
          tatsächliche Ergebnis fiel. Prediction-Capture ist <em>session-dedupliziert</em> (eine Capture pro
          Matchday-Load, nicht pro Ansicht). Der Historisch-Tab rekonstruiert Point-in-Time-Features aus
          team_xg_history (nur Zeilen mit match_date &lt; Target) — hindsight-frei innerhalb der Feature-Ebene,
          mit Training-Leakage-Warnung falls das Target vor dem LGBM-Trainings-Cutoff liegt.
        </div>
      </div>
    </AppShell>
  );
}

// ─── Historical Replay Tab ───────────────────────────────────────

function HistoricalReplayTab({
  rows, running, progress, leagueKey, setLeagueKey, run,
}: {
  rows: ReplayRow[] | null;
  running: boolean;
  progress: string;
  leagueKey: string;
  setLeagueKey: (k: string) => void;
  run: () => void;
}) {
  const refinement = useMemo(() => rows ? analyzeRefinement(rows) : null, [rows]);
  const leagueOptions = Object.keys(LEAGUES);

  return (
    <>
      {/* Controls */}
      <div style={{
        padding: `${space[4]}px`, borderRadius: radius.md,
        background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}20`,
        marginBottom: space[5],
      }}>
        <div style={{ display: "flex", gap: space[3], alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...text.label }}>Liga:</span>
          <select
            value={leagueKey}
            onChange={e => setLeagueKey(e.target.value)}
            disabled={running}
            style={{
              padding: "4px 10px", borderRadius: radius.sm, fontSize: fontSize.sm,
              background: color.leather, color: color.text,
              border: `1px solid ${color.gold}40`,
            }}
          >
            {leagueOptions.map(l => <option key={l} value={l}>{LEAGUES[l].name}</option>)}
          </select>
          <button
            onClick={run}
            disabled={running}
            style={{
              padding: `${space[2]}px ${space[4]}px`, borderRadius: radius.sm,
              background: running ? `${color.goldMid}15` : color.gold,
              color: running ? color.goldMid : color.leather,
              border: "none", fontSize: fontSize.sm, fontWeight: fontWeight.bold,
              cursor: running ? "not-allowed" : "pointer",
            }}
          >
            {running ? "Läuft..." : "Replay starten"}
          </button>
          {progress && <span style={{ ...text.muted, fontSize: fontSize.xs }}>{progress}</span>}
        </div>
        <div style={{ marginTop: space[3], fontSize: fontSize.xs, color: color.textMuted, lineHeight: 1.5 }}>
          Replay rekonstruiert für jedes historische Match die xG-History, Form und Tags wie sie <em>vor</em> dem
          Match aussahen (nur Zeilen mit früherem match_date), ruft die 3 Engines auf (ohne Odds), und scored
          gegen den tatsächlichen Ausgang. Kein Hindsight an der Feature-Ebene. <strong>Warnung:</strong> Wenn
          das Target-Match <em>innerhalb</em> des LGBM-Trainings-Fensters liegt, enthält v2 Training-Leakage —
          die Zahlen sind dann optimistisch.
        </div>
      </div>

      {/* Results */}
      {!rows && !running && (
        <div style={{
          padding: space[6], borderRadius: radius.md,
          background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}15`,
          color: color.goldMid, fontSize: fontSize.sm, textAlign: "center",
        }}>
          Replay noch nicht gestartet — wähle Liga + "Replay starten".
        </div>
      )}

      {rows && refinement && (
        <>
          <div style={{ ...text.label, marginBottom: space[3] }}>
            {rows.length} Matches replayed · Liga {LEAGUES[leagueKey]?.name}
          </div>

          {/* Physical-markets: Shots + Corners expected vs actual */}
          {(() => {
            const pm = aggregatePhysicalMarkets(rows);
            if (!pm.shots && !pm.corners) return null;
            return (
              <div style={{
                padding: space[4], borderRadius: radius.md, marginBottom: space[5],
                background: `${color.gold}08`, border: `1px solid ${color.gold}25`,
              }}>
                <div style={{ ...text.label, color: color.gold, marginBottom: space[3], fontSize: fontSize.sm }}>
                  Physische Märkte · erwartet vs. tatsächlich
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: space[3] }}>
                  {pm.shots && (
                    <PhysicalCard
                      label="Schüsse pro Team"
                      n={pm.shots.n} mae={pm.shots.mae} bias={pm.shots.bias}
                      unit="Schüsse"
                      note="Erwartet = Ensemble-λ / 0.105 (Liga-Ø xG-per-shot)"
                    />
                  )}
                  {pm.corners && (
                    <PhysicalCard
                      label="Ecken pro Team"
                      n={pm.corners.n} mae={pm.corners.mae} bias={pm.corners.bias}
                      unit="Ecken"
                      note="Erwartet = Compound-Poisson (corners-engine)"
                    />
                  )}
                  {!pm.shots && (
                    <div style={{ padding: space[3], color: color.textMuted, fontSize: fontSize.xs }}>
                      <strong style={{ color: color.warn }}>Keine Shot-Daten.</strong><br />
                      Nach scripts/migration-team-xg-shots.sql + node scripts/backfill-shots-xg.mjs --all
                      werden HS/AS-Werte aus football-data.co.uk in team_xg_history geschrieben
                      und hier sichtbar.
                    </div>
                  )}
                  {!pm.corners && (
                    <div style={{ padding: space[3], color: color.textMuted, fontSize: fontSize.xs }}>
                      Keine Corner-Daten für diese Liga. Nach backfill-shots-xg.mjs befüllt.
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Per-engine bias + suggestions */}
          {refinement.map(r => {
            const scoresByEngine = (r.engine === "ensemble" ? rows.map(x => x.score_ensemble)
              : r.engine === "v1" ? rows.map(x => x.score_v1)
              : rows.map(x => x.score_v2)).filter(Boolean) as MatchScore[];
            const agg = aggregate(scoresByEngine);
            return (
              <div key={r.engine} style={{
                padding: space[4], borderRadius: radius.md, marginBottom: space[4],
                background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}20`,
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  marginBottom: space[3],
                }}>
                  <div style={{ ...text.label, color: color.gold, fontSize: fontSize.sm }}>{r.engine}</div>
                  <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>{r.n} gescored</div>
                </div>

                {/* Aggregate metrics */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: space[2], marginBottom: space[3], fontSize: fontSize.xs }}>
                  <Metric label="Brier 1X2" v={num(agg?.brier_1x2)} />
                  <Metric label="Brier Ü2.5" v={num(agg?.brier_o25)} />
                  <Metric label="Brier BTTS" v={num(agg?.brier_btts)} />
                  <Metric label="Log-Loss 1X2" v={num(agg?.logloss_1x2)} />
                  <Metric label="Favorit-Hitrate" v={pct(agg?.favorite_accuracy, 1)} highlight />
                </div>

                {/* Bias per outcome */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: space[2], marginBottom: space[3], fontSize: fontSize.xs }}>
                  <BiasCell label="Home" bias={r.bias_h} />
                  <BiasCell label="Remis" bias={r.bias_d} />
                  <BiasCell label="Ausw." bias={r.bias_a} />
                  <BiasCell label="Ü2.5" bias={r.bias_o25} />
                </div>

                {/* Calibration buckets */}
                <div style={{ marginBottom: space[3] }}>
                  <div style={{ ...text.label, fontSize: 10, marginBottom: space[1] }}>
                    Favorit-Kalibrierung (vorhergesagte vs. realisierte Hitrate)
                  </div>
                  <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 40 }}>
                    {r.calibration_fav.map(b => {
                      const maxVal = Math.max(b.predicted, b.realized);
                      const gap = b.predicted - b.realized;
                      return (
                        <div key={b.bin} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", fontSize: 8 }}>
                          <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 30 }}>
                            <div title={`vorhergesagt ${(b.predicted * 100).toFixed(1)}%`} style={{ width: 8, height: `${b.predicted * 100}%`, background: color.gold, opacity: 0.6 }} />
                            <div title={`realisiert ${(b.realized * 100).toFixed(1)}%`} style={{ width: 8, height: `${b.realized * 100}%`, background: Math.abs(gap) > 0.05 ? color.warn : color.value }} />
                          </div>
                          <div style={{ color: color.textMuted, marginTop: 2 }}>{b.bin}</div>
                          <div style={{ color: color.textFaint, fontSize: 7 }}>{b.n}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Refinement suggestions */}
                <div style={{ padding: `${space[2]}px ${space[3]}px`, background: `${color.gold}08`, borderRadius: radius.sm, border: `1px solid ${color.gold}20` }}>
                  <div style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: color.gold, marginBottom: space[1] }}>
                    Refinement-Hinweise
                  </div>
                  <ul style={{ margin: 0, paddingLeft: space[4], fontSize: fontSize.xs, color: color.text, lineHeight: 1.6 }}>
                    {r.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function Metric({ label, v, highlight }: { label: string; v: string; highlight?: boolean }) {
  return (
    <div>
      <div style={{ color: color.textMuted, fontSize: 9, marginBottom: 2 }}>{label}</div>
      <div style={{
        fontFamily: "monospace", fontVariantNumeric: "tabular-nums",
        color: highlight ? color.value : color.text,
        fontWeight: highlight ? fontWeight.bold : fontWeight.semibold,
      }}>{v}</div>
    </div>
  );
}

function PhysicalCard({
  label, n, mae, bias, unit, note,
}: {
  label: string; n: number; mae: number; bias: number; unit: string; note: string;
}) {
  const biasTint = Math.abs(bias) > 2 ? color.warn : Math.abs(bias) > 1 ? color.gold : color.textMuted;
  return (
    <div style={{
      padding: space[3], borderRadius: radius.sm,
      background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}20`,
    }}>
      <div style={{ ...text.label, marginBottom: space[2], fontSize: 10, color: color.gold }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${space[1]}px ${space[3]}px`, fontSize: fontSize.xs }}>
        <span style={{ color: color.textMuted }}>Sample:</span>
        <span style={{ color: color.text, fontVariantNumeric: "tabular-nums" }}>{n} Team-Matches</span>
        <span style={{ color: color.textMuted }}>MAE:</span>
        <span style={{ color: color.text, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>
          {mae.toFixed(2)} {unit}
        </span>
        <span style={{ color: color.textMuted }}>Bias:</span>
        <span style={{ color: biasTint, fontWeight: fontWeight.semibold, fontVariantNumeric: "tabular-nums" }}>
          {bias >= 0 ? "+" : "−"}{Math.abs(bias).toFixed(2)} {unit}
          <span style={{ fontSize: 9, color: color.textFaint, marginLeft: 4 }}>
            ({bias > 0 ? "überschätzt" : "unterschätzt"})
          </span>
        </span>
      </div>
      <div style={{ marginTop: space[2], fontSize: 9, color: color.textFaint, lineHeight: 1.4 }}>{note}</div>
    </div>
  );
}

function BiasCell({ label, bias }: { label: string; bias: number }) {
  const pct = (bias * 100).toFixed(1);
  const sev = Math.abs(bias);
  const tint = sev > 0.03 ? color.warn : sev > 0.015 ? color.gold : color.textMuted;
  return (
    <div>
      <div style={{ color: color.textMuted, fontSize: 9, marginBottom: 2 }}>{label}-Bias</div>
      <div style={{ color: tint, fontFamily: "monospace", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
        {bias >= 0 ? "+" : "−"}{Math.abs(+pct).toFixed(1)}pp
      </div>
    </div>
  );
}

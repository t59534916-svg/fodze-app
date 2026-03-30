"use client";
import { useState } from "react";
import Kit from "@/components/shared/Kit";
import XGSparkline from "@/components/XGSparkline";
import OddsInput from "./OddsInput";
import BettingSummary from "./BettingSummary";
import { analyzeLineMovement, getCorrectScores, getHtFt, getWinningMargin, getGoalBothHalves } from "@/lib/dixon-coles";
import type { RawMatch, MatchCalc, OddsData, OddsSnapshot, BetCalc } from "@/types/match";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

type Tab = "overview" | "odds" | "details";

// ─── Tab Button ──────────────────────────────────────────────────
function TabBtn({ label, active, onClick, id, controls }: { label: string; active: boolean; onClick: () => void; id: string; controls: string }) {
  return (
    <button onClick={onClick} role="tab" aria-selected={active} id={id} aria-controls={controls}
      style={{
        flex: 1, padding: "8px 4px", fontSize: 11, fontWeight: 600, border: "none",
        cursor: "pointer", letterSpacing: 0.3, transition: "all 0.2s",
        background: active ? "#c4a26512" : "transparent",
        color: active ? "#d4b86a" : "#c4a26570",
        borderBottom: active ? "2px solid #d4b86a" : "2px solid transparent",
      }}>{label}</button>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────
function TabOverview({ match, calc, budget, onPlaceBet, placingBet, league }: {
  match: RawMatch; calc: any; budget: number;
  onPlaceBet: (match: RawMatch, bet: BetCalc) => void; placingBet: string | null;
  league?: string;
}) {
  const br = budget;

  return (
    <div style={{ padding: "12px 0" }}>
      {/* Probability Bar Large */}
      {calc && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11 }}>
            <span style={{ color: "#6aad55", fontWeight: 600 }}>{match.home?.name?.split(" ").pop()} {pc(calc.mk.H)}</span>
            <span style={{ color: "#c4a26560" }}>X {pc(calc.mk.D)}</span>
            <span style={{ color: "#c47070", fontWeight: 600 }}>{match.away?.name?.split(" ").pop()} {pc(calc.mk.A)}</span>
          </div>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 2 }}>
            <div style={{ width: `${calc.mk.H * 100}%`, background: "linear-gradient(90deg, #4a8c3a, #6aad55)", borderRadius: 5 }} />
            <div style={{ width: `${calc.mk.D * 100}%`, background: "#c4a26560", borderRadius: 5 }} />
            <div style={{ width: `${calc.mk.A * 100}%`, background: "linear-gradient(90deg, #c47070, #a04040)", borderRadius: 5 }} />
          </div>
        </div>
      )}

      {/* Top Scores */}
      {calc?.topScores?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "#c4a26570", letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>WAHRSCHEINLICHSTE ERGEBNISSE</div>
          <div style={{ display: "flex", gap: 6 }}>
            {calc.topScores.map((sc: any, si: number) => {
              const [hGoals, aGoals] = sc.s.split(":").map(Number);
              const isHome = hGoals > aGoals, isDraw = hGoals === aGoals;
              return (
                <div key={si} style={{
                  flex: 1, background: si === 0 ? "#c4a26515" : "#0d070540",
                  border: `1px solid ${si === 0 ? "#c4a26530" : "#c4a26512"}`,
                  borderRadius: 8, padding: "8px 4px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: si === 0 ? "#d4b86a" : "#ede4d4", letterSpacing: 2 }}>{sc.s}</div>
                  <div style={{ fontSize: 9, color: si === 0 ? "#d4b86a" : "#c4a26570", marginTop: 2 }}>{pc(sc.p)}</div>
                  <div style={{ fontSize: 8, color: isHome ? "#6aad55" : isDraw ? "#c4a265" : "#c47070", fontWeight: 600 }}>
                    {isHome ? "Heim" : isDraw ? "Remis" : "Ausw."}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Model Assessment */}
      {calc && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: "#c4a2650a", border: "1px solid #c4a26512", marginBottom: 16, fontSize: 12, lineHeight: 1.6, color: "#c4a26580" }}>
          {calc.mk.H > 0.55 ? `${match.home?.name} klarer Favorit.` :
           calc.mk.A > 0.55 ? `${match.away?.name} klarer Favorit.` :
           calc.mk.H > 0.42 ? `${match.home?.name} leichter Favorit, offenes Spiel.` :
           calc.mk.A > 0.42 ? `${match.away?.name} leichter Favorit, offenes Spiel.` :
           "Ausgeglichenes Spiel, kein klarer Favorit."}
          {calc.mk.O25 > 0.6 ? ` Torreich erwartet.` : calc.mk.O25 < 0.4 ? ` Wenig Tore erwartet.` : ""}
        </div>
      )}

      {/* Betting Summary Card */}
      <BettingSummary match={match} calc={calc} league={league} />

      {/* Value Bets (simplified) */}
      {calc?.bets?.filter((b: BetCalc) => b.isValue).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#6aad55", letterSpacing: 0.5, marginBottom: 8, fontWeight: 600 }}>VALUE BETS</div>
          {calc.bets.filter((b: BetCalc) => b.isValue).map((b: BetCalc) => {
            const confColor = b.confidence === "HIGH" ? "#6aad55" : b.confidence === "MEDIUM" ? "#d4b86a" : "#c4a265";
            return (
              <div key={b.label} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 12px", marginBottom: 6, borderRadius: 8,
                background: "#6aad5508", border: "1px solid #6aad5518",
              }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{b.label}</span>
                  <span style={{ fontSize: 11, color: "#6aad55", marginLeft: 8, fontWeight: 600 }}>{pe(b.edge)}</span>
                  <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 600, marginLeft: 6,
                    background: confColor + "18", color: confColor }}>{b.confidence}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {br > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: "#d4b86a" }}>€{(b.kelly * br).toFixed(0)}</span>}
                  {br > 0 && (
                    <button onClick={e => { e.stopPropagation(); onPlaceBet(match, b); }} disabled={placingBet === b.label}
                      style={{
                        fontSize: 10, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                        border: "none", background: "#6aad55", color: "#fff", fontWeight: 700,
                        opacity: placingBet === b.label ? 0.5 : 1,
                      }}>
                      {placingBet === b.label ? "..." : "BET"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {match.context && <div style={{ fontSize: 11, color: "#c4a26560", lineHeight: 1.6 }}>{match.context}</div>}
    </div>
  );
}

// ─── Odds Tab ────────────────────────────────────────────────────
function TabOdds({ match, calc, idx, odds, oddsHistory, saving, onSetOdds, onSaveOdds, onDelHist, budget }: {
  match: RawMatch; calc: any; idx: number; odds: OddsData; oddsHistory: OddsSnapshot[];
  saving: boolean; onSetOdds: (f: string, v: string) => void; onSaveOdds: () => void; onDelHist: () => void; budget: number;
}) {
  const movement = analyzeLineMovement(oddsHistory);
  const br = budget;

  return (
    <div style={{ padding: "12px 0" }}>
      <OddsInput odds={odds} onSetOdds={onSetOdds} onSave={onSaveOdds} saving={saving} idx={idx} />

      {/* All bets table */}
      {calc?.bets?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#c4a26570", letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>ALLE MÄRKTE</div>
          {calc.bets.map((b: BetCalc) => (
            <div key={b.label}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #c4a26508", fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {b.valueTrap && <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#c47070" }} />}
                  {b.isValue && !b.valueTrap && <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#6aad55" }} />}
                  <span style={{ color: b.valueTrap ? "#c47070" : "#ede4d4", fontWeight: 500 }}>{b.label}</span>
                </div>
                <span style={{ fontWeight: 600, color: b.valueTrap ? "#c47070" : b.isValue ? "#6aad55" : b.edge >= 0 ? "#c4a26570" : "#c47070" }}>{pe(b.edge)}</span>
                <span style={{ color: b.isValue ? "#d4b86a" : "#c4a26530" }}>
                  {b.isValue && br > 0 ? `€${(b.kelly * br).toFixed(0)}` : "—"}
                </span>
              </div>
              {b.valueTrap && (
                <div style={{ fontSize: 9, color: "#c47070", padding: "2px 0 4px 9px", lineHeight: 1.3 }}>
                  VALUE TRAP — {b.valueTrapReason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Overround */}
      {calc && calc.ov !== null && (
        <div style={{ fontSize: 10, marginBottom: 8, padding: "4px 8px", borderRadius: 6, display: "inline-block",
          background: (calc.ov || 0) > 0.08 ? "#c4a26510" : "#5a8c4a15", color: (calc.ov || 0) > 0.08 ? "#c4a265" : "#6aad55" }}>
          Marge: {pc(calc.ov || 0)}
        </div>
      )}

      {/* Odds History */}
      {oddsHistory.length > 0 && (
        <div style={{ background: "#c4a26508", border: "1px solid #c4a26515", borderRadius: 10, padding: 10, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 9, color: "#c4a26570", letterSpacing: 0.5 }}>QUOTENVERLAUF ({oddsHistory.length}x)</span>
            <button onClick={onDelHist} style={{ fontSize: 9, padding: "1px 6px", background: "#8c4a4a18", color: "#c47070", border: "none", borderRadius: 4, cursor: "pointer" }}>Löschen</button>
          </div>
          {oddsHistory.map((s: OddsSnapshot, si: number) => (
            <div key={si} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "3px 0", borderBottom: si < oddsHistory.length - 1 ? "1px solid #c4a26508" : "none" }}>
              <span style={{ color: "#c4a26560", minWidth: 42 }}>{new Date(s.snapshot_time).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</span>
              {["h", "d", "a"].map(k => {
                const val = parseFloat(String(s.odds[k] ?? "")), prev = si > 0 ? parseFloat(String(oddsHistory[si - 1].odds[k] ?? "")) : null;
                const mv = prev !== null && val > 0 && Math.abs(val - prev) >= 0.03;
                return <span key={k} style={{ minWidth: 40, textAlign: "right", fontWeight: mv ? 700 : 400,
                  color: mv ? (val < prev! ? "#6aad55" : "#c47070") : "#c4a26570" }}>
                  {val > 0 ? `${val.toFixed(2)}${mv ? (val < prev! ? "↓" : "↑") : ""}` : "—"}
                </span>;
              })}
            </div>
          ))}
          {movement && (
            <div style={{ background: "#c4a26510", borderRadius: 6, padding: "5px 8px", marginTop: 6 }}>
              {Object.values(movement).map((mv: { label: string; from: number; to: number; dir: string }, mi: number) => (
                <div key={mi} style={{ fontSize: 9, color: "#c4a26570" }}>{mv.label}: {mv.from.toFixed(2)}→{mv.to.toFixed(2)} ({mv.dir})</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Details Tab ─────────────────────────────────────────────────
function TabDetails({ match, calc }: { match: RawMatch; calc: any }) {
  return (
    <div style={{ padding: "12px 0" }}>
      {/* Teams */}
      {[
        { t: match.home, r: "H" as const, cl: "#d4b86a", xg: match.home.xg_h8, xga: match.home.xga_h8, hist: match.home.xg_h_history },
        { t: match.away, r: "A" as const, cl: "#c47070", xg: match.away.xg_a8, xga: match.away.xga_a8, hist: match.away.xg_a_history },
      ].map(({ t, r, cl, xg, xga, hist }) => t && (
        <div key={r} style={{ padding: "10px 0", borderBottom: "1px solid #c4a26510", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Kit team={t.name} size={20} />
            <span style={{ fontWeight: 600, color: "#ede4d4", cursor: "pointer", textDecoration: "underline dotted #c4a26530" }}
              onClick={() => window.open("/team/" + encodeURIComponent(t.name), "_blank")}>{t.name}</span>
            <span style={{ fontWeight: 700, color: cl, fontSize: 10 }}>({r})</span>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#c4a26560", marginBottom: 4, paddingLeft: 28 }}>
            {xg && xg > 0 && <span>xG {(xg / (t.games || 8)).toFixed(2)}/Sp</span>}
            {xga && xga > 0 && <span>xGA {(xga / (t.games || 8)).toFixed(2)}/Sp</span>}
            {t.form && <span>{t.form}</span>}
          </div>
          {t.injuries && t.injuries !== "None" && (
            <div style={{ color: "#c47070", fontSize: 10, paddingLeft: 28 }}>Ausfälle: {t.injuries}</div>
          )}
          {t.yellow_risk && <div style={{ color: "#c4a265", fontSize: 10, paddingLeft: 28 }}>Gelb: {t.yellow_risk}</div>}
          {hist && hist.length >= 2 && (
            <div style={{ marginTop: 6, paddingLeft: 28 }}><XGSparkline history={hist} width={180} height={36} /></div>
          )}
        </div>
      ))}

      {/* Lambdas */}
      {calc && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, margin: "12px 0" }}>
          {[["λ H", calc.lambdaH.toFixed(2)], ["λ A", calc.lambdaA.toFixed(2)], ["Ü2.5", pc(calc.mk.O25)], ["TOP", calc.mk.best]].map(([l, v]: any) => (
            <div key={l} style={{ background: "#c4a26510", border: "1px solid #c4a26518", borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
              <div style={{ fontSize: 8, color: "#c4a26560", letterSpacing: 0.5 }}>{l}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: l === "TOP" ? "#d4b86a" : "#ede4d4" }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Adjustments */}
      {calc?.enh && (
        <div style={{ fontSize: 10, marginBottom: 12, padding: "8px 10px", borderRadius: 8, background: "#c4a26508", border: "1px solid #c4a26512" }}>
          <div style={{ color: "#c4a26555", marginBottom: 4, fontWeight: 600, fontSize: 9, letterSpacing: 0.5 }}>ANPASSUNGEN</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ color: "#c4a26570" }}>Regression: λ {calc.lambdaH_raw?.toFixed(2)}→{calc.enh.lambdaH_regressed.toFixed(2)} ({(calc.enh.shrinkageH * 100).toFixed(0)}%)</span>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ color: calc.enh.formH.mult >= 1.02 ? "#6aad55" : calc.enh.formH.mult <= 0.98 ? "#c47070" : "#c4a26570" }}>
              Form H: {calc.enh.formH.label} ({calc.enh.formH.mult.toFixed(3)}×)
            </span>
            <span style={{ color: calc.enh.formA.mult >= 1.02 ? "#6aad55" : calc.enh.formA.mult <= 0.98 ? "#c47070" : "#c4a26570" }}>
              Form A: {calc.enh.formA.label} ({calc.enh.formA.mult.toFixed(3)}×)
            </span>
          </div>
          {calc.enh.tagCorrections.length > 0 && (
            <div>{calc.enh.tagCorrections.map((tc: { reason: string }, ti: number) => <div key={ti} style={{ color: "#d4b86a", fontSize: 9 }}>{tc.reason}</div>)}</div>
          )}
          <div style={{ color: "#c4a26535", fontSize: 9, marginTop: 4 }}>
            90% CI: λH {calc.enh.ciH.low.toFixed(2)}–{calc.enh.ciH.high.toFixed(2)} · λA {calc.enh.ciA.low.toFixed(2)}–{calc.enh.ciA.high.toFixed(2)}
          </div>
        </div>
      )}

      {/* Extended Markets */}
      {calc?.enh?.matrix && (() => {
        const mx = calc.enh.matrix;
        const scores = getCorrectScores(mx, 8);
        const htft = getHtFt(calc.lambdaH, calc.lambdaA);
        const margin = getWinningMargin(mx);
        const gbh = getGoalBothHalves(calc.lambdaH, calc.lambdaA);
        return (
          <div style={{ fontSize: 10 }}>
            <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>EXAKTE ERGEBNISSE</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
              {scores.map((sc: any, si: number) => (
                <div key={si} style={{ background: si < 3 ? "#c4a26512" : "#0d070533", border: "1px solid #c4a26515", borderRadius: 5, padding: "3px 6px", textAlign: "center", minWidth: 38 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: si === 0 ? "#d4b86a" : "#ede4d4" }}>{sc.score}</div>
                  <div style={{ fontSize: 8, color: "#c4a26570" }}>{pc(sc.p)} · {(1 / sc.p).toFixed(1)}</div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>HALBZEIT / ENDSTAND</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 12 }}>
              {Object.entries(htft).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => (
                <div key={k} style={{ background: "#0d070533", border: "1px solid #c4a26515", borderRadius: 4, padding: "3px 4px", textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 500, color: "#ede4d4" }}>{k}</div>
                  <div style={{ fontSize: 8, color: "#c4a26570" }}>{pc(v)}</div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>SIEGMARGE & BEIDE HZ</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 10 }}>
              {Object.entries(margin).slice(0, 5).map(([k, v]) => (
                <span key={k} style={{ color: k.startsWith("H") ? "#6aad55" : k === "Unent." ? "#d4b86a" : "#c47070" }}>{k} {pc(v)}</span>
              ))}
              <span style={{ color: "#c4a26530" }}>·</span>
              <span style={{ color: "#6aad55" }}>BHZ Ja {pc(gbh.yes)}</span>
            </div>
          </div>
        );
      })()}

      {/* Warnings */}
      {calc?.warnings?.filter((w: { level: string; message: string }) => w.level === "error").length > 0 && (
        <div style={{ padding: 8, borderRadius: 8, background: "#8c4a4a18", border: "1px solid #c4707020", marginTop: 12 }}>
          {calc.warnings.filter((w: { level: string; message: string }) => w.level === "error").map((w: { level: string; message: string }, wi: number) => (
            <div key={wi} style={{ fontSize: 10, color: "#c47070", marginBottom: 2 }}>{w.message}</div>))}
        </div>
      )}
    </div>
  );
}

// ─── Main MatchDetail ────────────────────────────────────────────
export default function MatchDetail({ match, calc, idx, odds, oddsHistory, saving, onSetOdds, onSaveOdds, onDelHist, onPlaceBet, placingBet, budget, league }: {
  match: RawMatch; calc: MatchCalc | null; idx: number; odds: OddsData; oddsHistory: OddsSnapshot[]; saving: boolean;
  onSetOdds: (field: string, value: string) => void;
  onSaveOdds: () => void; onDelHist: () => void;
  onPlaceBet: (match: RawMatch, bet: BetCalc) => void; placingBet: string | null; budget: number;
  league?: string;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div style={{ borderTop: "1px solid #c4a26515", marginTop: 4 }}>
      {/* Tab Bar */}
      <div role="tablist" aria-label="Match-Details" style={{ display: "flex", borderBottom: "1px solid #c4a26510" }}>
        <TabBtn label="Überblick" active={tab === "overview"} onClick={() => setTab("overview")} id={`tab-overview-${idx}`} controls={`panel-overview-${idx}`} />
        <TabBtn label="Quoten" active={tab === "odds"} onClick={() => setTab("odds")} id={`tab-odds-${idx}`} controls={`panel-odds-${idx}`} />
        <TabBtn label="Statistik" active={tab === "details"} onClick={() => setTab("details")} id={`tab-details-${idx}`} controls={`panel-details-${idx}`} />
      </div>

      <div key={tab} className="tab-fade-in" role="tabpanel" id={`panel-${tab}-${idx}`} aria-labelledby={`tab-${tab}-${idx}`}>
        {tab === "overview" && <TabOverview match={match} calc={calc} budget={budget} onPlaceBet={onPlaceBet} placingBet={placingBet} league={league} />}
        {tab === "odds" && <TabOdds match={match} calc={calc} idx={idx} odds={odds} oddsHistory={oddsHistory} saving={saving} onSetOdds={onSetOdds} onSaveOdds={onSaveOdds} onDelHist={onDelHist} budget={budget} />}
        {tab === "details" && <TabDetails match={match} calc={calc} />}
      </div>
    </div>
  );
}

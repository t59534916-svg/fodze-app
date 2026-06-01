"use client";
import { useState, useEffect, useRef } from "react";
import Kit from "@/components/shared/Kit";
import XGSparkline from "@/components/XGSparkline";
import OddsInput from "./OddsInput";
import BettingSummary from "./BettingSummary";
import EngineComparison from "./EngineComparison";
import LineMovementChart from "./LineMovementChart";
import XGHistoryBreakdown from "@/components/shared/XGHistoryBreakdown";
import { useApp } from "@/contexts/AppContext";
import { analyzeLineMovement, getCorrectScores, getHtFt, getWinningMargin, getGoalBothHalves, vigAdjustBest } from "@/lib/dixon-coles";
import { color } from "@/styles/tokens";
import { confidenceTier, type ConfTierKey } from "@/lib/confidence-tier";
import { deservedPicture } from "@/lib/deserved-outcome";
import type { RawMatch, MatchCalc, OddsData, OddsSnapshot, BetCalc } from "@/types/match";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

// Confidence-Tier badge colors (design tokens). The tier boundaries + the
// calibrated hit-rate claims live in src/lib/confidence-tier.ts (single source
// of truth, unit-tested, validated against the production Benter-blended path
// on 2026-05-28). THIS maps the tier key → leather/gold/green tokens for the
// full badge — green HOCH (only tier clearly above-average) down to faint
// grey TOSS-UP.
function tierTokens(key: ConfTierKey): { fg: string; bg: string; border: string } {
  switch (key) {
    case "HOCH":    return { fg: color.value, bg: color.valueBg, border: color.valueBorder };
    case "MITTEL":  return { fg: color.gold, bg: `${color.goldMid}14`, border: `${color.goldMid}40` };
    case "NIEDRIG": return { fg: color.goldMid, bg: `${color.goldMid}0c`, border: `${color.goldMid}24` };
    // TOSS-UP fg at 0.75 alpha (bf) clears WCAG-AA on leather; still the faintest tier.
    default:        return { fg: `${color.goldMid}bf`, bg: "transparent", border: `${color.goldMid}20` };
  }
}

// Count comma-separated injury entries — the format the Transfermarkt
// scrape produces is "Name (Pos, Reason), Name (Pos, Reason)". Split on
// ", " between bracket-closes-then-comma so commas inside parens don't
// double-count. Returns 0 for empty/falsy input.
function countInjuries(injStr?: string): number {
  if (!injStr || !injStr.trim()) return 0;
  // Each entry ends with ")" — count those.
  return (injStr.match(/\)/g) || []).length;
}

// Tag → human label (engine TAG_MAP keys are uppercase, this de-shouts
// them for the UI without losing the canonical key shape).
function tagLabel(tag: string): string {
  const map: Record<string, string> = {
    DERBY: "Derby",
    ROTATION: "Rotation",
    "ROTATION-ERWARTET": "Rotation",
    SANDWICH: "Sandwich",
    "NEUER-TRAINER": "Neuer Trainer",
    "TRAINER-UNTER-DRUCK": "Trainer-Druck",
    ABSTIEGSKAMPF: "Abstiegskampf",
    MEISTERKAMPF: "Meisterkampf",
    GEISTERSPIEL: "Geisterspiel",
    POKAL: "Pokal",
  };
  return map[tag.toUpperCase()] || tag;
}

// Form letter (W/D/L) → small colored dot. Returns inline-style + label
// so the dots have a tooltip on hover for screen readers.
function formDotStyle(letter: string): React.CSSProperties {
  const c =
    letter === "W" ? color.value :
    letter === "L" ? color.warn :
    letter === "D" ? `${color.goldMid}80` : `${color.goldMid}30`;
  return {
    width: 6, height: 6, borderRadius: "50%",
    background: c, display: "inline-block",
  };
}

function FormDots({ form }: { form?: string }) {
  if (!form) return null;
  const letters = form.split(/\s+/).filter(Boolean).slice(0, 5);
  if (letters.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}
      title={`Form letzte ${letters.length}: ${letters.join(" ")}`}>
      {letters.map((l, i) => <span key={i} style={formDotStyle(l)} />)}
    </span>
  );
}

// ─── Goldilocks consensus detection ──────────────────────────────────
//
// A bet is "consensus" when BOTH our engine AND Pinnacle's sharp line
// (vig-removed) see the edge inside the Goldilocks zone (2.5–7.5%).
// The engine half is `bet.isValue` — already computed by the engine
// pipeline. The market half we compute here from sharp odds.
//
// Note: sharp data in OddsSharpData currently only covers H/D/A.
// O25/U25/BTTS bets always return false (no signal, not a non-consensus
// answer). When we extend OddsSharpData with sharp_over25/under25 the
// market check below should grow accordingly.
const GOLDILOCKS_MIN = 0.025;
const GOLDILOCKS_MAX = 0.075;

function buildSharpProbs(odds: OddsData | undefined): { H: number; D: number; A: number } | null {
  const sh = odds?._sharp;
  if (!sh || typeof sh !== "object") return null;
  const h = sh.h, d = sh.d, a = sh.a;
  if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) return null;
  const adj = vigAdjustBest([h, d, a]);
  return { H: adj.probs[0], D: adj.probs[1], A: adj.probs[2] };
}

function isConsensus(bet: BetCalc, sharpProbs: { H: number; D: number; A: number } | null): boolean {
  if (!sharpProbs || !bet.isValue) return false;
  // Map BetCalc.label → sharp-prob key. The engine uses German market
  // labels (Heim/Unent./Ausw.), and English aliases survive too.
  const probKey: "H" | "D" | "A" | null =
    bet.label === "Heim" || bet.label === "Home" || bet.label === "1" ? "H" :
    bet.label === "Unent." || bet.label === "Draw" || bet.label === "X" ? "D" :
    bet.label === "Ausw." || bet.label === "Away" || bet.label === "2" ? "A" :
    null;
  if (!probKey) return false;
  const pSharp = sharpProbs[probKey];
  if (!bet.quote || bet.quote <= 1) return false;
  const impliedProb = 1 / bet.quote;
  const marketEdge = pSharp - impliedProb;
  return marketEdge >= GOLDILOCKS_MIN && marketEdge <= GOLDILOCKS_MAX;
}

// usePopover — shared escape/outside-click wiring for ConsensusBadge and
// InjuryPopover. Extracted once so any future inline popover reuses the
// same a11y semantics (Escape closes, outside-click closes, keyboard-
// focusable trigger).
function usePopover<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { ref, open, setOpen };
}

// InjuryPopover — tap-to-expand list of absent players. Previously the
// injury counter rendered as `<span title={fullList}>`, which is
// invisible on touch devices and unreachable via keyboard — mobile
// users saw "H: 3" with no way to see WHO was out. Now a button
// opens a scrollable dialog with one entry per line.
function InjuryPopover({ side, count, injuries }: { side: "H" | "A"; count: number; injuries: string }) {
  const { ref, open, setOpen } = usePopover<HTMLSpanElement>();
  const entries = injuries
    .split(/\),\s*/)
    .map((s, i, arr) => (i < arr.length - 1 ? s + ")" : s))
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <span ref={ref} style={{ display: "inline-flex", alignItems: "center", position: "relative" }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={`${count} Ausfälle ${side === "H" ? "Heim" : "Auswärts"} — Tippen für Liste`}
        aria-expanded={open}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: "transparent", border: "none", padding: 0, cursor: "pointer",
          color: `${color.warn}cc`, fontSize: 11, fontWeight: 600, lineHeight: 1.4,
          borderRadius: 3,
        }}
      >
        <span aria-hidden="true">🩹</span>
        <span>{side}: {count}</span>
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={`Ausfälle ${side === "H" ? "Heim" : "Auswärts"}`}
          style={{
            position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10,
            background: color.leather3, border: `1px solid ${color.warn}40`,
            padding: "8px 10px", borderRadius: 6, fontSize: 10, color: color.text,
            lineHeight: 1.5, width: 260, maxHeight: 220, overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)", fontWeight: 400, letterSpacing: 0,
          }}
        >
          {entries.map((entry, i) => (
            <div key={i} style={{ padding: "2px 0", borderBottom: i < entries.length - 1 ? `1px solid ${color.warn}15` : "none" }}>
              {entry}
            </div>
          ))}
        </span>
      )}
    </span>
  );
}

// ConsensusBadge — click-to-expand explainer. The previous implementation
// relied on `title=` HTML tooltip, which is invisible on touchscreens
// (no hover) and the badge's meaning was effectively hidden from mobile
// users. Now the badge toggles a small inline explainer on tap, which
// works on any device and is keyboard-focusable. Uses goldShine (11.2:1
// on leather) for the text instead of gold (#d4b86a, ~3:1 against the
// gold-tinted background) — WCAG AA compliant.
function ConsensusBadge() {
  const { ref, open, setOpen } = usePopover<HTMLSpanElement>();

  return (
    <span ref={ref} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, position: "relative" }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Konsens-Signal: Engine und Pinnacle-Sharp stimmen überein. Tippen für Erklärung."
        aria-expanded={open}
        style={{
          fontSize: 9, padding: "1px 6px", borderRadius: 3, fontWeight: 700,
          background: `${color.gold}22`, color: color.goldShine, border: `1px solid ${color.gold}55`,
          letterSpacing: 0.3, cursor: "pointer", lineHeight: 1.4,
        }}
      >
        <span aria-hidden="true">🤝 </span>Konsens
      </button>
      {open && (
        <span
          role="dialog"
          style={{
            position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10,
            background: color.leather3, border: `1px solid ${color.gold}40`,
            padding: "8px 10px", borderRadius: 6, fontSize: 10, color: color.text,
            lineHeight: 1.4, width: 240, boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            fontWeight: 400, letterSpacing: 0,
          }}
        >
          Engine UND Pinnacle-Sharp sehen den Edge in der 2.5–7.5% Goldilocks-Zone.
          Zwei unabhängige Quant-Systeme stimmen überein — robustestes Signal das FODZE produziert.
        </span>
      )}
    </span>
  );
}

// Tabs reduced from 3 to 2 — Statistik merged into Überblick as a
// collapsible "Mehr Details" section. The previous pattern had users
// flipping between Überblick and Statistik looking for λ values, winning
// margin, HT/FT — all secondary-but-needed data that didn't warrant its
// own primary tab.
type Tab = "overview" | "odds";

// ─── Tab Button ──────────────────────────────────────────────────
function TabBtn({ label, active, onClick, id, controls }: { label: string; active: boolean; onClick: () => void; id: string; controls: string }) {
  return (
    <button onClick={onClick} role="tab" aria-selected={active} id={id} aria-controls={controls}
      style={{
        flex: 1, padding: "8px 4px", fontSize: 11, fontWeight: 600, border: "none",
        cursor: "pointer", letterSpacing: 0.3, transition: "all 0.2s",
        background: active ? `${color.goldMid}12` : "transparent",
        color: active ? color.gold : `${color.goldMid}70`,
        borderBottom: active ? "2px solid #d4b86a" : "2px solid transparent",
      }}>{label}</button>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────
function TabOverview({ match, calc, budget, onPlaceBet, placingBet, league, odds }: {
  match: RawMatch; calc: any; budget: number;
  onPlaceBet: (match: RawMatch, bet: BetCalc) => void; placingBet: string | null;
  league?: string;
  odds?: OddsData;
}) {
  const br = budget;
  const { engine } = useApp();
  // Pre-compute Pinnacle-sharp probs once per render. Used by isConsensus
  // for the value-bet consensus indicator. Returns null when no sharp
  // data present, in which case all consensus checks short-circuit false.
  const sharpProbs = buildSharpProbs(odds);

  // Pre-compute strip content so we can decide whether to render the
  // wrapper at all (avoid an empty bordered row).
  const homeInjCount = countInjuries(match.home?.injuries);
  const awayInjCount = countInjuries(match.away?.injuries);
  const stripHasContent =
    (match.tags?.length || 0) > 0 || homeInjCount > 0 || awayInjCount > 0 ||
    !!match.home?.form || !!match.away?.form;

  return (
    <div style={{ padding: "12px 0" }}>
      {/* calc=null means the engine couldn't build a prediction — usually
          missing xG history for newly-promoted teams. Users previously saw
          a mostly-blank panel and assumed a bug; now they get a clear
          reason and can still see the match enrichment context below. */}
      {!calc && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 8,
          background: color.warnBg, border: `1px solid ${color.warn}30`,
          fontSize: 11, color: color.text, lineHeight: 1.5,
        }}>
          <strong style={{ color: color.warn }}>Keine Prognose verfügbar.</strong><br />
          Unzureichende xG-Historie — typisch bei neu aufgestiegenen Teams oder Saisonbeginn.
        </div>
      )}
      {/* Context strip — surfaces enrichment-pipeline data (tags + injury
          counts + form) that would otherwise be buried in the collapsed
          MEHR DETAILS block. The pipeline auto-fills tags (DERBY,
          MEISTERKAMPF, ABSTIEGSKAMPF, ROTATION) and Transfermarkt fills
          injuries — both directly affect engine λ (TAG_MAP +
          calcAbsenceImpact). Showing them here gives the user the WHY
          behind any subsequent value-bet recommendation. */}
      {stripHasContent && (
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
          marginBottom: 12, padding: "6px 10px",
          background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}15`, borderRadius: 6,
          fontSize: 11,
        }}>
          {/* Form per side — color-coded W/D/L dots */}
          {match.home?.form && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: `${color.goldMid}80` }}>
              <span style={{ fontSize: 9, color: `${color.goldMid}60` }}>H</span>
              <FormDots form={match.home.form} />
            </span>
          )}
          {match.away?.form && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: `${color.goldMid}80` }}>
              <span style={{ fontSize: 9, color: `${color.goldMid}60` }}>A</span>
              <FormDots form={match.away.form} />
            </span>
          )}

          {/* Spacer between form/injuries and tags */}
          {(homeInjCount > 0 || awayInjCount > 0) && (match.home?.form || match.away?.form) && (
            <span style={{ color: `${color.goldMid}30` }}>·</span>
          )}

          {/* Injury counters — tap/click to see the full roster of
              absent players. Previously `title=` tooltips worked only on
              hover (desktop) and never on touch; mobile users could see
              the count but never the names. */}
          {homeInjCount > 0 && (
            <InjuryPopover side="H" count={homeInjCount} injuries={match.home!.injuries!} />
          )}
          {awayInjCount > 0 && (
            <InjuryPopover side="A" count={awayInjCount} injuries={match.away!.injuries!} />
          )}

          {/* Tags — only show distinct ones, badge-style */}
          {(match.tags || []).slice(0, 4).map((tag) => (
            <span key={tag} style={{
              fontSize: 10, fontWeight: 600,
              padding: "2px 8px", borderRadius: 10,
              background: color.valueBg, color: color.value,
              border: `1px solid ${color.valueBorder}`,
              letterSpacing: 0.3,
            }}>
              {tagLabel(tag)}
            </span>
          ))}
        </div>
      )}

      {/* Probability Bar Large — ProbabilityRing was removed from this
          view per user request ("kreisförmige graphik im aufgefalteten
          spielanalyse überblick"). Kept on fuck-betting. */}
      {calc && (
        <div style={{ marginBottom: 16 }}>
          {(() => {
            const probs = [calc.mk.H, calc.mk.D, calc.mk.A];
            const top = Math.max(...probs);
            const fi = probs.indexOf(top);
            const fav = fi === 0 ? (match.home?.name?.split(" ").pop() || "Heim")
              : fi === 2 ? (match.away?.name?.split(" ").pop() || "Ausw.") : "Remis";
            const t = confidenceTier(top);
            const tc = tierTokens(t.key);
            return (
              <div title="Confidence = Modell-Wahrscheinlichkeit des Top-Tipps (dev-03, Benter-geblendet Richtung Pinnacle). Kalibriert (validiert 2026-05-28 cross-season, Production-Pfad): die angegebene Wkt entspricht ~der tatsächlichen Trefferquote. Nur HOCH-Tipps (≥65%) sind verlässlich."
                   style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: `${color.goldMid}70`, letterSpacing: 0.5, fontWeight: 600 }}>CONFIDENCE</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: tc.fg, background: tc.bg, border: `1px solid ${tc.border}`, borderRadius: 6, padding: "2px 8px" }}>
                  {t.label} · {pc(top)}
                </span>
                <span style={{ fontSize: 10, color: `${color.goldMid}70` }}>Tipp {fav} · {t.hist}</span>
              </div>
            );
          })()}
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11 }}>
            <span style={{ color: color.value, fontWeight: 600 }}>{match.home?.name?.split(" ").pop()} {pc(calc.mk.H)}</span>
            <span style={{ color: `${color.goldMid}60` }}>X {pc(calc.mk.D)}</span>
            <span style={{ color: color.warn, fontWeight: 600 }}>{match.away?.name?.split(" ").pop()} {pc(calc.mk.A)}</span>
          </div>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 2 }}>
            <div style={{ width: `${calc.mk.H * 100}%`, background: `linear-gradient(90deg, ${color.valueDark}, ${color.value})`, borderRadius: 5 }} />
            <div style={{ width: `${calc.mk.D * 100}%`, background: `${color.goldMid}60`, borderRadius: 5 }} />
            <div style={{ width: `${calc.mk.A * 100}%`, background: `linear-gradient(90deg, ${color.warn}, #a04040)`, borderRadius: 5 }} />
          </div>

          {/* Erwartetes Bild — die Engine-λ (erwartete Tore) als "verdienter
              Ausgang"-Lesart. PRÄSENTATION des bereits berechneten Signals, KEINE
              genauere Prognose (docs/FORECAST-QUALITY-ANALYSIS.md §12/§13): λ ist
              dieselbe Information wie die Wkt-Leiste, als erwartete Tore ausgedrückt
              — "wie das Modell das Duell sieht", nicht eine Score-Vorhersage. */}
          {(() => {
            const d = deservedPicture(calc.lambdaH, calc.lambdaA);
            const hueFor = d.side === "home" ? color.value : d.side === "away" ? color.warn : color.goldMid;
            return (
              <div title="Erwartetes Bild = die vom Modell erwarteten Tore je Team (λ, Dixon-Coles). Das ist die GLEICHE Information wie die Wahrscheinlichkeits-Leiste, nur als erwartete Tore ausgedrückt — wer hätte verdient gewinnen sollen und wie eng. KEINE Vorhersage des echten Ergebnisses (das trägt unvermeidbares Zufalls-Rauschen)."
                   style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: `${color.goldMid}70`, letterSpacing: 0.5, fontWeight: 600 }}>ERWARTETES BILD</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: color.value }}>{d.homeXg.toFixed(1)}</span>
                <span style={{ fontSize: 10, color: `${color.goldMid}60` }}>erwartete Tore</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: color.warn }}>{d.awayXg.toFixed(1)}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: hueFor, background: `${hueFor}1a`, border: `1px solid ${hueFor}33`, borderRadius: 6, padding: "2px 8px" }}>
                  {d.label}
                </span>
                <span style={{ fontSize: 10, color: `${color.goldMid}55` }}>
                  {d.total >= 3.0 ? "torreich erwartet" : d.total <= 2.0 ? "torarm erwartet" : "mittlere Tor-Erwartung"}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Engine-Vergleich — side-by-side H/X/2/Ü2.5 across all 3 engines.
          Flags divergence >= 8pp so you can spot when the engines disagree. */}
      {calc?.allEnginesMk && (
        <EngineComparison allEnginesMk={calc.allEnginesMk} activeEngine={engine} />
      )}

      {/* Top Scores */}
      {calc?.topScores?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: `${color.goldMid}70`, letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>WAHRSCHEINLICHSTE ERGEBNISSE</div>
          <div style={{ display: "flex", gap: 6 }}>
            {calc.topScores.map((sc: any, si: number) => {
              const [hGoals, aGoals] = sc.s.split(":").map(Number);
              const isHome = hGoals > aGoals, isDraw = hGoals === aGoals;
              return (
                <div key={si} style={{
                  flex: 1, background: si === 0 ? color.surfaceHover : "#0d070540",
                  border: `1px solid ${si === 0 ? `${color.goldMid}30` : `${color.goldMid}12`}`,
                  borderRadius: 8, padding: "8px 4px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: si === 0 ? color.gold : color.text, letterSpacing: 2 }}>{sc.s}</div>
                  <div style={{ fontSize: 9, color: si === 0 ? color.gold : `${color.goldMid}70`, marginTop: 2 }}>{pc(sc.p)}</div>
                  <div style={{ fontSize: 8, color: isHome ? color.value : isDraw ? color.goldMid : color.warn, fontWeight: 600 }}>
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
        <div style={{ padding: "10px 14px", borderRadius: 8, background: `${color.goldMid}0a`, border: `1px solid ${color.goldMid}12`, marginBottom: 16, fontSize: 12, lineHeight: 1.6, color: `${color.goldMid}80` }}>
          {calc.mk.H > 0.55 ? `${match.home?.name} klarer Favorit.` :
           calc.mk.A > 0.55 ? `${match.away?.name} klarer Favorit.` :
           calc.mk.H > 0.42 ? `${match.home?.name} leichter Favorit, offenes Spiel.` :
           calc.mk.A > 0.42 ? `${match.away?.name} leichter Favorit, offenes Spiel.` :
           "Ausgeglichenes Spiel, kein klarer Favorit."}
          {calc.mk.O25 > 0.6 ? ` Torreich erwartet.` : calc.mk.O25 < 0.4 ? ` Wenig Tore erwartet.` : ""}
        </div>
      )}

      {/* xG Breakdown — same component as fuck-betting. Reveals how
          the 8-game xG-Schnitt was composed (against which opponents,
          konstant vs Ausreißer). Especially important in less-coverage
          leagues where a single demolition can inflate the summary
          without the probability bar above showing it. */}
      {(match.home?.xg_h_history?.length || match.away?.xg_a_history?.length) && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}10`, marginBottom: 16 }}>
          <XGHistoryBreakdown
            history={match.home?.xg_h_history}
            venueLabel={`${match.home?.name?.split(" ").pop()} Heim`}
          />
          <XGHistoryBreakdown
            history={match.away?.xg_a_history}
            venueLabel={`${match.away?.name?.split(" ").pop()} Ausw.`}
          />
        </div>
      )}

      {/* Betting Summary Card */}
      <BettingSummary match={match} calc={calc} league={league} />

      {/* Value Bets — empty state when calc exists but no value found, so
          users don't stare at blank space wondering if something's broken. */}
      {calc && (!calc.bets || calc.bets.filter((b: BetCalc) => b.isValue).length === 0) && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 8,
          background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}15`,
          fontSize: 11, color: `${color.goldMid}80`, textAlign: "center",
        }}>
          Keine Value-Bets für dieses Spiel — Quoten fair bewertet.
        </div>
      )}
      {calc?.bets?.filter((b: BetCalc) => b.isValue).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: color.value, letterSpacing: 0.5, marginBottom: 8, fontWeight: 600 }}>VALUE BETS</div>
          {calc.bets.filter((b: BetCalc) => b.isValue).map((b: BetCalc) => {
            const confColor = b.confidence === "HIGH" ? color.value : b.confidence === "MEDIUM" ? color.gold : color.goldMid;
            // Consensus = both engine + Pinnacle-sharp see edge in the
            // 2.5–7.5% Goldilocks zone. The strongest possible signal —
            // two independent quant systems agree a price is wrong.
            const consensus = isConsensus(b, sharpProbs);
            return (
              <div
                key={b.label}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 12px", marginBottom: 6, borderRadius: 8,
                  // Subtle gold tint + thicker gold border on consensus
                  // bets so they stand out from engine-only value picks.
                  background: consensus ? `${color.gold}10` : color.valueGhost,
                  border: `1px solid ${consensus ? `${color.gold}40` : color.valueBorder}`,
                }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: color.text }}>{b.label}</span>
                  {/* Edge % — previously rendered in `color.value` on the value-tinted bg,
                      which gave ~1.0:1 contrast (fails WCAG AA). Now rendered in neutral
                      text color with only the leading +/− sign colored. */}
                  <span style={{ fontSize: 11, color: color.text, marginLeft: 8, fontWeight: 600 }}>
                    <span style={{ color: b.edge >= 0 ? color.value : color.warn }}>{b.edge >= 0 ? "+" : "−"}</span>
                    {(Math.abs(b.edge) * 100).toFixed(1)}%
                  </span>
                  <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 600, marginLeft: 6,
                    background: confColor + "18", color: confColor }}>{b.confidence}</span>
                  {consensus && (
                    <ConsensusBadge />
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Stake + odds combined: "5€ @ 3.40" tells the user
                      what they're actually committing to in one glance,
                      vs the previous bare "5€" which required scrolling
                      back to the All-Markets table to find the quote. */}
                  {br > 0 && (
                    <span style={{ fontSize: 13, fontWeight: 600, color: color.gold, fontFamily: "'SF Mono', Consolas, monospace", fontVariantNumeric: "tabular-nums" }}>
                      {/* v1.2 Filter-Shield indicator: shows when a CSD veto
                          reduced this stake. Without the prefix the user sees
                          a smaller €-amount than expected with no explanation.
                          Tooltip surfaces active veto names + multiplier. */}
                      {b.shieldMult != null && b.shieldMult < 1.0 && (
                        <span
                          style={{ color: color.warn, marginRight: 4 }}
                          title={`Filter-Shield: Kelly × ${b.shieldMult.toFixed(2)} — ${(b.shieldActive || []).join(", ")}`}
                        >
                          🛡
                        </span>
                      )}
                      €{(b.kelly * br).toFixed(0)}
                      {b.quote ? <span style={{ color: `${color.goldMid}80`, fontWeight: 500, marginLeft: 4 }}>@ {b.quote.toFixed(2)}</span> : null}
                    </span>
                  )}
                  {br > 0 && (
                    <button onClick={e => { e.stopPropagation(); onPlaceBet(match, b); }} disabled={placingBet === b.label}
                      style={{
                        fontSize: 10, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                        border: "none", background: color.value, color: "#fff", fontWeight: 700,
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

      {match.context && <div style={{ fontSize: 11, color: `${color.goldMid}60`, lineHeight: 1.6 }}>{match.context}</div>}
    </div>
  );
}

// ─── Odds Tab ────────────────────────────────────────────────────
function TabOdds({ match, calc, idx, odds, oddsHistory, saving, onSetOdds, onSaveOdds, onDelHist, budget, league }: {
  match: RawMatch; calc: any; idx: number; odds: OddsData; oddsHistory: OddsSnapshot[];
  saving: boolean; onSetOdds: (f: string, v: string) => void; onSaveOdds: () => void; onDelHist: () => void; budget: number;
  league?: string;
}) {
  const movement = analyzeLineMovement(oddsHistory);
  const br = budget;

  return (
    <div style={{ padding: "12px 0" }}>
      <OddsInput odds={odds} onSetOdds={onSetOdds} onSave={onSaveOdds} saving={saving} idx={idx} />

      {/* Sharp line movement (vig-removed Pinnacle prob over time).
          Renders nothing when <2 snapshots exist for this match — common
          during the data-accumulation period after a fresh fixture is added.
          Source: odds_snapshots, appended by fetch-odds.mjs cron (every 4h
          Fri-Sun + Wed since commit 652f2fa, 2026-05-08). */}
      {league && match.home?.name && match.away?.name && (
        <LineMovementChart
          league={league}
          homeTeam={match.home.name}
          awayTeam={match.away.name}
        />
      )}

      {/* All bets table */}
      {calc?.bets?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: `${color.goldMid}70`, letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>ALLE MÄRKTE</div>
          {calc.bets.map((b: BetCalc) => (
            <div key={b.label}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${color.goldMid}08`, fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {b.valueTrap && <div style={{ width: 5, height: 5, borderRadius: "50%", background: color.warn }} />}
                  {b.isValue && !b.valueTrap && <div style={{ width: 5, height: 5, borderRadius: "50%", background: color.value }} />}
                  <span style={{ color: b.valueTrap ? color.warn : color.text, fontWeight: 500 }}>{b.label}</span>
                </div>
                <span style={{ fontWeight: 600, color: b.valueTrap ? color.warn : b.isValue ? color.value : b.edge >= 0 ? `${color.goldMid}70` : color.warn }}>{pe(b.edge)}</span>
                <span style={{ color: b.isValue ? color.gold : `${color.goldMid}30` }}>
                  {b.isValue && br > 0 ? `€${(b.kelly * br).toFixed(0)}` : "—"}
                </span>
              </div>
              {b.valueTrap && (
                <div style={{ fontSize: 9, color: color.warn, padding: "2px 0 4px 9px", lineHeight: 1.3 }}>
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
          background: (calc.ov || 0) > 0.08 ? `${color.goldMid}10` : color.valueBg, color: (calc.ov || 0) > 0.08 ? color.goldMid : color.value }}>
          Marge: {pc(calc.ov || 0)}
        </div>
      )}

      {/* Odds History */}
      {oddsHistory.length > 0 && (
        <div style={{ background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}15`, borderRadius: 10, padding: 10, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 9, color: `${color.goldMid}70`, letterSpacing: 0.5 }}>QUOTENVERLAUF ({oddsHistory.length}x)</span>
            <button onClick={onDelHist} style={{ fontSize: 9, padding: "1px 6px", background: color.warnBg, color: color.warn, border: "none", borderRadius: 4, cursor: "pointer" }}>Löschen</button>
          </div>
          {oddsHistory.map((s: OddsSnapshot, si: number) => (
            <div key={si} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "3px 0", borderBottom: si < oddsHistory.length - 1 ? `1px solid ${color.goldMid}08` : "none" }}>
              <span style={{ color: `${color.goldMid}60`, minWidth: 42 }}>{new Date(s.snapshot_time).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</span>
              {["h", "d", "a"].map(k => {
                const val = parseFloat(String(s.odds[k] ?? "")), prev = si > 0 ? parseFloat(String(oddsHistory[si - 1].odds[k] ?? "")) : null;
                const mv = prev !== null && val > 0 && Math.abs(val - prev) >= 0.03;
                return <span key={k} style={{ minWidth: 40, textAlign: "right", fontWeight: mv ? 700 : 400,
                  color: mv ? (val < prev! ? color.value : color.warn) : `${color.goldMid}70` }}>
                  {val > 0 ? `${val.toFixed(2)}${mv ? (val < prev! ? "↓" : "↑") : ""}` : "—"}
                </span>;
              })}
            </div>
          ))}
          {movement && (
            <div style={{ background: `${color.goldMid}10`, borderRadius: 6, padding: "5px 8px", marginTop: 6 }}>
              {Object.values(movement).map((mv: { label: string; from: number; to: number; dir: string }, mi: number) => (
                <div key={mi} style={{ fontSize: 9, color: `${color.goldMid}70` }}>{mv.label}: {mv.from.toFixed(2)}→{mv.to.toFixed(2)} ({mv.dir})</div>
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
        { t: match.home, r: "H" as const, cl: color.gold, xg: match.home.xg_h8, xga: match.home.xga_h8, hist: match.home.xg_h_history },
        { t: match.away, r: "A" as const, cl: color.warn, xg: match.away.xg_a8, xga: match.away.xga_a8, hist: match.away.xg_a_history },
      ].map(({ t, r, cl, xg, xga, hist }) => t && (
        <div key={r} style={{ padding: "10px 0", borderBottom: `1px solid ${color.goldMid}10`, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Kit team={t.name} size={20} />
            <span style={{ fontWeight: 600, color: color.text, cursor: "pointer", textDecoration: `underline dotted ${color.goldMid}30` }}
              onClick={() => window.open("/team/" + encodeURIComponent(t.name), "_blank")}>{t.name}</span>
            <span style={{ fontWeight: 700, color: cl, fontSize: 10 }}>({r})</span>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: `${color.goldMid}60`, marginBottom: 4, paddingLeft: 28 }}>
            {xg && xg > 0 && <span>xG {(xg / (t.games || 8)).toFixed(2)}/Sp</span>}
            {xga && xga > 0 && <span>xGA {(xga / (t.games || 8)).toFixed(2)}/Sp</span>}
            {t.form && <span>{t.form}</span>}
          </div>
          {t.injuries && t.injuries !== "None" && (
            <div style={{ color: color.warn, fontSize: 10, paddingLeft: 28 }}>Ausfälle: {t.injuries}</div>
          )}
          {t.yellow_risk && <div style={{ color: color.goldMid, fontSize: 10, paddingLeft: 28 }}>Gelb: {t.yellow_risk}</div>}
          {hist && hist.length >= 2 && (
            <div style={{ marginTop: 6, paddingLeft: 28 }}><XGSparkline history={hist} width={180} height={36} /></div>
          )}
        </div>
      ))}

      {/* Lambdas */}
      {calc && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, margin: "12px 0" }}>
          {[["λ H", calc.lambdaH.toFixed(2)], ["λ A", calc.lambdaA.toFixed(2)], ["Ü2.5", pc(calc.mk.O25)], ["TOP", calc.mk.best]].map(([l, v]: any) => (
            <div key={l} style={{ background: `${color.goldMid}10`, border: `1px solid ${color.goldMid}18`, borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
              <div style={{ fontSize: 8, color: `${color.goldMid}60`, letterSpacing: 0.5 }}>{l}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: l === "TOP" ? color.gold : color.text }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Adjustments */}
      {calc?.enh && (
        <div style={{ fontSize: 10, marginBottom: 12, padding: "8px 10px", borderRadius: 8, background: `${color.goldMid}08`, border: `1px solid ${color.goldMid}12` }}>
          <div style={{ color: `${color.goldMid}55`, marginBottom: 4, fontWeight: 600, fontSize: 9, letterSpacing: 0.5 }}>ANPASSUNGEN</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ color: `${color.goldMid}70` }}>Regression: λ {calc.lambdaH_raw?.toFixed(2)}→{calc.enh.lambdaH_regressed.toFixed(2)} ({(calc.enh.shrinkageH * 100).toFixed(0)}%)</span>
          </div>
          {calc.enh.tagCorrections.length > 0 && (
            <div>{calc.enh.tagCorrections.map((tc: { reason: string }, ti: number) => <div key={ti} style={{ color: color.gold, fontSize: 9 }}>{tc.reason}</div>)}</div>
          )}
          <div style={{ color: `${color.goldMid}35`, fontSize: 9, marginTop: 4 }}>
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
            <div style={{ fontWeight: 600, color: color.gold, marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>EXAKTE ERGEBNISSE</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
              {scores.map((sc: any, si: number) => (
                <div key={si} style={{ background: si < 3 ? `${color.goldMid}12` : "#0d070533", border: `1px solid ${color.goldMid}15`, borderRadius: 5, padding: "3px 6px", textAlign: "center", minWidth: 38 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: si === 0 ? color.gold : color.text }}>{sc.score}</div>
                  <div style={{ fontSize: 8, color: `${color.goldMid}70` }}>{pc(sc.p)} · {(1 / sc.p).toFixed(1)}</div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 600, color: color.gold, marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>HALBZEIT / ENDSTAND</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 12 }}>
              {Object.entries(htft).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => (
                <div key={k} style={{ background: "#0d070533", border: `1px solid ${color.goldMid}15`, borderRadius: 4, padding: "3px 4px", textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 500, color: color.text }}>{k}</div>
                  <div style={{ fontSize: 8, color: `${color.goldMid}70` }}>{pc(v)}</div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 600, color: color.gold, marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>SIEGMARGE & BEIDE HZ</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 10 }}>
              {Object.entries(margin).slice(0, 5).map(([k, v]) => (
                <span key={k} style={{ color: k.startsWith("H") ? color.value : k === "Unent." ? color.gold : color.warn }}>{k} {pc(v)}</span>
              ))}
              <span style={{ color: `${color.goldMid}30` }}>·</span>
              <span style={{ color: color.value }}>BHZ Ja {pc(gbh.yes)}</span>
            </div>
          </div>
        );
      })()}

      {/* Warnings */}
      {calc?.warnings?.filter((w: { level: string; message: string }) => w.level === "error").length > 0 && (
        <div style={{ padding: 8, borderRadius: 8, background: color.warnBg, border: `1px solid ${color.warn}20`, marginTop: 12 }}>
          {calc.warnings.filter((w: { level: string; message: string }) => w.level === "error").map((w: { level: string; message: string }, wi: number) => (
            <div key={wi} style={{ fontSize: 10, color: color.warn, marginBottom: 2 }}>{w.message}</div>))}
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
    <div style={{ borderTop: `1px solid ${color.goldMid}15`, marginTop: 4 }}>
      {/* Tab Bar — 2 primary tabs, details embedded in Überblick */}
      <div role="tablist" aria-label="Match-Details" style={{ display: "flex", borderBottom: `1px solid ${color.goldMid}10` }}>
        <TabBtn label="Überblick" active={tab === "overview"} onClick={() => setTab("overview")} id={`tab-overview-${idx}`} controls={`panel-overview-${idx}`} />
        <TabBtn label="Quoten" active={tab === "odds"} onClick={() => setTab("odds")} id={`tab-odds-${idx}`} controls={`panel-odds-${idx}`} />
      </div>

      <div key={tab} className="tab-fade-in" role="tabpanel" id={`panel-${tab}-${idx}`} aria-labelledby={`tab-${tab}-${idx}`}>
        {tab === "overview" && (
          <>
            <TabOverview match={match} calc={calc} budget={budget} onPlaceBet={onPlaceBet} placingBet={placingBet} league={league} odds={odds} />
            {/* Detailed statistics — collapsed by default to reduce visual
                noise; power users expand when they want to verify λ,
                adjustments, HT/FT, winning margin etc. */}
            <details style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${color.goldMid}10` }}>
              <summary style={{
                cursor: "pointer", listStyle: "none",
                padding: "10px 12px", borderRadius: 6,
                background: `${color.goldMid}08`,
                color: `${color.goldMid}90`, fontSize: 11, fontWeight: 600,
                letterSpacing: 0.5, userSelect: "none",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span>MEHR DETAILS · λ · Statistik · Exakte Ergebnisse</span>
                <span aria-hidden="true" style={{ fontSize: 14 }}>▾</span>
              </summary>
              <TabDetails match={match} calc={calc} />
            </details>
          </>
        )}
        {tab === "odds" && <TabOdds match={match} calc={calc} idx={idx} odds={odds} oddsHistory={oddsHistory} saving={saving} onSetOdds={onSetOdds} onSaveOdds={onSaveOdds} onDelHist={onDelHist} budget={budget} league={league} />}
      </div>
    </div>
  );
}

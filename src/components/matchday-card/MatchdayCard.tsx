// ═══════════════════════════════════════════════════════════════════════
// src/components/matchday-card/MatchdayCard.tsx
//
// L0+L1 card composite. Sub-components are kept in this file for clarity —
// they all share the same MatchData prop and never re-render independently.
//
// Visual hierarchy (top → bottom):
//   1. CardHeader: crests + team names + kickoff
//   2. MatchReadBar: 1X2 stacked bar + per-team xG line (L0 match-read)
//   3. Market label (Over 2.5 / Home Win / ...)
//   4. EdgeTrustRow: edge pill + trust band (gold/caution/trap)
//   5. DualProbBar: engine vs market prob (for THIS bet)
//   6. ConfMeter: σ² + CLV/drift line
//   7. TriggerList: 0-3 L1 narrative bullets
//   8. ActionsRow: Show math → / Place bet · X€ · Kelly Y×
// ═══════════════════════════════════════════════════════════════════════

"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { color, fontWeight, radius, shadow } from "@/styles/tokens";
import type { TriggerPart, TriggerResult } from "@/lib/triggers";
import type { MatchData, TeamRef } from "./types";
import { MathSheet } from "./MathSheet";

// ─── Crest ─────────────────────────────────────────────────────────────

function Crest({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: 28, height: 28,
        borderRadius: "50%",
        background: color.leather2,
        border: `1px solid ${color.border}`,
        padding: 3,
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  );
}

// ─── Card Header ───────────────────────────────────────────────────────

function CardHeader({ home, away, kickoff }: { home: TeamRef; away: TeamRef; kickoff: string }) {
  const teamSide: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    color: color.gold,
    fontWeight: 600,
    fontSize: 13.5,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
  };
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      paddingBottom: 12,
      marginBottom: 12,
      borderBottom: `1px solid ${color.border}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        <span style={teamSide}>
          <Crest src={home.logo} alt={home.name} />
          <span>{home.name}</span>
        </span>
        <span style={{ color: color.textFaint, fontWeight: 400, fontSize: 14, margin: "0 2px" }}>×</span>
        <span style={teamSide}>
          <Crest src={away.logo} alt={away.name} />
          <span>{away.name}</span>
        </span>
      </div>
      <div style={{
        color: color.textMuted,
        fontSize: 11,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}>{kickoff}</div>
    </div>
  );
}

// ─── 1X2 Match Read Bar + xG Line ──────────────────────────────────────

function MatchReadBar({ card }: { card: MatchData }) {
  const isHomeBet = !!card.isHomeBet;
  const isAwayBet = !!card.isAwayBet;
  const isDrawBet = !!card.isDrawBet;

  const segBase: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "0 8px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    position: "relative",
  };
  const highlightSeg = (isHighlighted: boolean): CSSProperties => isHighlighted ? {
    outline: `2px solid ${color.gold}`,
    outlineOffset: -2,
    boxShadow: `inset 0 0 6px rgba(212,184,106,0.4)`,
  } : {};
  const betDiamond = (
    <span style={{ position: "absolute", top: 1, right: 3, fontSize: 7, color: color.gold }}>◆</span>
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: 6,
      }}>
        <span style={{
          color: color.textMuted,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}>Match Read</span>
        <span style={{
          color: color.textFaint,
          fontSize: 10,
          letterSpacing: "0.04em",
        }}>
          Engine 1X2{(isHomeBet || isAwayBet || isDrawBet) ? " · ◆ recommended bet" : ""}
        </span>
      </div>

      <div style={{
        display: "flex",
        height: 32,
        borderRadius: radius.sm,
        overflow: "hidden",
        border: `1px solid ${color.border}`,
        background: color.leather3,
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.2)",
      }}>
        <div style={{
          ...segBase,
          width: `${card.probH}%`,
          background: `linear-gradient(135deg, ${card.home.primary}, ${card.home.primaryDark})`,
          color: card.home.textOn,
          ...highlightSeg(isHomeBet),
        }}>
          <span style={{ textTransform: "uppercase", fontSize: 10.5 }}>{card.home.abbr}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{card.probH}%</span>
          {isHomeBet && betDiamond}
        </div>
        <div style={{
          ...segBase,
          width: `${card.probD}%`,
          background: `linear-gradient(90deg, ${color.goldDeep}, ${color.goldMuted})`,
          color: color.leather,
          ...highlightSeg(isDrawBet),
        }}>
          <span style={{ textTransform: "uppercase", fontSize: 10.5 }}>D</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{card.probD}%</span>
          {isDrawBet && betDiamond}
        </div>
        <div style={{
          ...segBase,
          width: `${card.probA}%`,
          background: `linear-gradient(135deg, ${card.away.primary}, ${card.away.primaryDark})`,
          color: card.away.textOn,
          ...highlightSeg(isAwayBet),
        }}>
          <span style={{ textTransform: "uppercase", fontSize: 10.5 }}>{card.away.abbr}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{card.probA}%</span>
          {isAwayBet && betDiamond}
        </div>
      </div>

      {/* xG Line — home left, Σ centered, away right */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: 7,
        padding: "0 6px",
        fontSize: 10.5,
        color: color.textFaint,
        letterSpacing: "0.02em",
        fontVariantNumeric: "tabular-nums",
      }}>
        <span>
          <span style={{ color: color.textMuted, fontWeight: 700, letterSpacing: "0.04em", marginRight: 4 }}>{card.home.abbr}</span>
          <span style={{ color: color.text, fontWeight: 600 }}>{card.xgH.toFixed(2)}</span>
          <span style={{ color: color.textFaint, fontSize: 9.5, marginLeft: 2 }}>xG</span>
        </span>
        <span style={{ color: color.textFaint, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Σ expected
          <span style={{ color: color.goldMuted, fontWeight: 700, margin: "0 2px", fontSize: 11 }}>{card.xgSum.toFixed(2)}</span>
        </span>
        <span>
          <span style={{ color: color.textFaint, fontSize: 9.5, marginRight: 2 }}>xG</span>
          <span style={{ color: color.text, fontWeight: 600 }}>{card.xgA.toFixed(2)}</span>
          <span style={{ color: color.textMuted, fontWeight: 700, letterSpacing: "0.04em", marginLeft: 4 }}>{card.away.abbr}</span>
        </span>
      </div>
    </div>
  );
}

// ─── Edge + Trust pill row ────────────────────────────────────────────

const TRUST_STYLES = {
  gold:    { bg: color.valueBg,   bd: `${color.value}30`, fg: color.value, metaFg: `${color.value}c0`, emoji: "🟢", label: "Gold Zone" },
  caution: { bg: color.goldGhost, bd: color.borderHover,  fg: color.gold,  metaFg: color.goldMuted,    emoji: "🟡", label: "Caution" },
  trap:    { bg: color.warnBg,    bd: `${color.warn}30`,  fg: color.warn,  metaFg: `${color.warn}cc`,  emoji: "🔴", label: "Trap Zone ⚠" },
} as const;

function EdgeTrustRow({ card }: { card: MatchData }) {
  const t = TRUST_STYLES[card.trustBand];
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 16,
      flexWrap: "wrap",
    }}>
      <span style={{
        background: color.gold,
        color: color.leather,
        fontWeight: 700,
        padding: "6px 13px",
        borderRadius: 999,
        fontSize: 13,
        letterSpacing: "0.02em",
        boxShadow: shadow.glow,
      }}>+{card.edgePct.toFixed(1)}% Edge</span>
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        background: t.bg,
        border: `1px solid ${t.bd}`,
        color: t.fg,
      }}>
        {t.emoji} {t.label}
        <span style={{
          fontWeight: 400,
          fontSize: 10.5,
          letterSpacing: 0,
          textTransform: "none",
          marginLeft: 4,
          color: t.metaFg,
        }}>
          {Math.round(card.trustHit * 100)}% hit · n={card.trustN}{card.trustUnderCov ? " (under-cov)" : ""}
        </span>
      </span>
    </div>
  );
}

// ─── Dual Probability Bar (Engine vs Markt for THIS bet) ──────────────

function DualProbBar({ card }: { card: MatchData }) {
  const row = (label: string, pct: number, fillBg: string, accent: string) => (
    <div style={{
      display: "grid",
      gridTemplateColumns: "56px 1fr 44px",
      alignItems: "center",
      gap: 10,
    }}>
      <span style={{
        color: accent,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}>{label}</span>
      <div style={{
        position: "relative",
        height: 8,
        background: color.leather3,
        borderRadius: 4,
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute",
          left: 0, top: 0, height: "100%",
          width: `${pct}%`,
          borderRadius: 4,
          background: fillBg,
          transition: "width 400ms ease",
        }} />
      </div>
      <span style={{
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        fontSize: 12.5,
        fontWeight: 700,
        color: accent,
      }}>{pct}%</span>
    </div>
  );
  return (
    <div style={{
      display: "grid",
      gap: 5,
      background: color.leather2,
      border: `1px solid ${color.border}`,
      borderRadius: radius.md,
      padding: "10px 12px",
    }}>
      {row("Engine", card.engineProb, `linear-gradient(90deg, ${color.valueDark}, ${color.value})`, color.value)}
      {row("Markt", card.marktProb, `linear-gradient(90deg, ${color.goldDeep}, ${color.goldMuted})`, color.goldMuted)}
      <div style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: `1px dashed ${color.border}`,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        color: color.textFaint,
        fontSize: 10.5,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}>
        Δ <span style={{
          color: card.gapWarn ? color.warn : color.value,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          textTransform: "none",
          letterSpacing: 0,
        }}>+{card.gapPp}pp</span> · Engine ahead
        {card.gapWarn && <span style={{ color: color.warn, textTransform: "none", letterSpacing: 0 }}> · drift-flagged</span>}
      </div>
    </div>
  );
}

// ─── Mini Confidence Meter ────────────────────────────────────────────

const CONF_METER_BG: Record<MatchData["confLevel"], string> = {
  high: `linear-gradient(90deg, ${color.valueDark}, ${color.value})`,
  med:  `linear-gradient(90deg, #a68040, #d4a040)`,
  low:  `linear-gradient(90deg, #8c3a3a, ${color.warn})`,
};

function ConfMeter({ card }: { card: MatchData }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      color: color.textFaint,
      fontSize: 11,
      marginTop: 10,
      flexWrap: "wrap",
    }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span style={{
          color: color.textMuted,
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}>Conf</span>
        <div style={{
          position: "relative",
          width: 60, height: 5,
          background: color.leather3,
          borderRadius: 3,
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", left: 0, top: 0, height: "100%",
            width: `${card.confPct}%`,
            borderRadius: 3,
            background: CONF_METER_BG[card.confLevel],
          }} />
        </div>
        <span style={{
          color: color.textFaint,
          fontVariantNumeric: "tabular-nums",
          fontSize: 10.5,
        }}>σ² {card.sigma2.toFixed(3)}</span>
      </div>
      {card.clv && (<>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{card.clv}</span>
      </>)}
      {card.noTriggers && (<>
        <span style={{ opacity: 0.4 }}>·</span>
        <span style={{ fontStyle: "italic" }}>no triggers fired</span>
      </>)}
      {card.driftWarn && (<>
        <span style={{ opacity: 0.4 }}>·</span>
        <span style={{ color: color.warn }}>{card.driftWarn}</span>
      </>)}
    </div>
  );
}

// ─── Trigger List ─────────────────────────────────────────────────────

function renderTriggerParts(parts: TriggerPart[]): ReactNode {
  return parts.map((p, i) => {
    switch (p.kind) {
      case "text":      return <span key={i}>{p.value}</span>;
      case "highlight": return <span key={i} style={{ color: color.gold, fontWeight: fontWeight.semibold }}>{p.value}</span>;
      case "warn":      return <span key={i} style={{ color: color.warn, fontWeight: fontWeight.medium }}>{p.value}</span>;
      case "sub":       return <span key={i} style={{ color: color.textMuted, fontSize: 11.5, display: "block", marginTop: 2 }}>{p.value}</span>;
    }
  });
}

function TriggerList({ triggers }: { triggers: TriggerResult[] }) {
  if (!triggers.length) return null;
  return (
    <div style={{
      margin: "12px 0",
      padding: "12px 0",
      borderTop: `1px dashed ${color.border}`,
      borderBottom: `1px dashed ${color.border}`,
    }}>
      {triggers.map((t, i) => (
        <div key={`${t.type}-${i}`} style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "3px 0",
          color: color.text,
          fontSize: 12.5,
          lineHeight: 1.55,
          marginTop: i > 0 ? 2 : 0,
        }}>
          <span style={{ color: color.goldMid, fontWeight: 700, flexShrink: 0, fontSize: 11, marginTop: 3 }}>▸</span>
          <span style={{ flex: 1 }}>{renderTriggerParts(t.parts)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Action Row ────────────────────────────────────────────────────────

function ActionsRow({ card, onShowMath }: { card: MatchData; onShowMath: () => void }) {
  const kellyColor =
    card.kellyMult === 1.0 ? "rgba(26,15,10,0.6)" :
    card.kellyMult === 0.7 ? "#6e5520" :
    "#8c3a3a";
  const kellyWeight: number = card.kellyMult === 1.0 ? 400 : (card.kellyMult === 0.7 ? 600 : 700);
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
      paddingTop: 10,
      flexWrap: "wrap",
    }}>
      <button
        onClick={onShowMath}
        style={{
          background: "transparent",
          border: `1px solid ${color.borderHover}`,
          color: color.gold,
          padding: "9px 14px",
          borderRadius: radius.md,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}>
        Show math →
      </button>
      <button style={{
        background: color.gold,
        color: color.leather,
        border: `1px solid ${color.gold}`,
        padding: "9px 14px",
        borderRadius: radius.md,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.02em",
        cursor: "pointer",
        fontFamily: "inherit",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}>
        Place bet · {card.betEuro}€
        <span style={{
          fontWeight: kellyWeight,
          marginLeft: 4,
          paddingLeft: 6,
          borderLeft: "1px solid rgba(26,15,10,0.3)",
          fontSize: 11,
          color: kellyColor,
        }}>Kelly {card.kellyMult.toFixed(1)}×</span>
      </button>
    </div>
  );
}

// ─── Main Card ─────────────────────────────────────────────────────────

export function MatchdayCard({ card }: { card: MatchData }) {
  const [mathOpen, setMathOpen] = useState(false);
  return (
    <>
      <div style={{
        background: `linear-gradient(180deg, ${color.leather2}, ${color.leather})`,
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding: 16,
        marginBottom: 12,
        boxShadow: shadow.card,
      }}>
        <CardHeader home={card.home} away={card.away} kickoff={card.kickoff} />
        <MatchReadBar card={card} />
        <div style={{
          color: color.textMuted,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 8,
          fontWeight: 500,
        }}>{card.marketLabel}</div>
        <EdgeTrustRow card={card} />
        <DualProbBar card={card} />
        <ConfMeter card={card} />
        <TriggerList triggers={card.triggers} />
        <ActionsRow card={card} onShowMath={() => setMathOpen(true)} />
      </div>
      <MathSheet open={mathOpen} onClose={() => setMathOpen(false)} card={card} />
    </>
  );
}

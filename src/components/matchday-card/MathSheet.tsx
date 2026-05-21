// ═══════════════════════════════════════════════════════════════════════
// src/components/matchday-card/MathSheet.tsx
//
// L2/L3 responsive math drill-in. Renders as:
//   - Desktop (≥ 1024px): centered modal (700px max-width)
//   - Mobile  (< 1024px): full-width bottom-sheet
//
// Content is L2 STUB — placeholder rows for:
//   - λ decomposition (SHAP-style, will come from LightGBM pred_contrib=True)
//   - σ² variance breakdown
//   - Calibration history snapshot
//   - Closing-line movement
//   - Comparable matches in training corpus
//
// Each row is clickable to L3 (training-corpus drill) — also stubbed.
// ═══════════════════════════════════════════════════════════════════════

"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { color, fontWeight, radius, shadow } from "@/styles/tokens";
import type { MatchData } from "./types";

interface MathSheetProps {
  open: boolean;
  onClose: () => void;
  card: MatchData;
}

export function MathSheet({ open, onClose, card }: MathSheetProps) {
  // Esc to close + lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          zIndex: 200,
          animation: "fade-in 200ms ease",
        }}
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Math audit for ${card.home.name} vs ${card.away.name}`}
        style={sheetStyle()}
      >
        <SheetHeader card={card} onClose={onClose} />
        <div style={{ padding: "16px 20px", display: "grid", gap: 18 }}>
          <LambdaDecomposition card={card} />
          <CalibrationRow card={card} />
          <ClosingLineRow card={card} />
          <ComparableMatchesRow card={card} />
        </div>
      </div>

      <style>{`
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes fade-in-up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
    </>
  );
}

// ─── Responsive sheet container style ─────────────────────────────────
// Mobile (<1024px): full-width bottom-sheet
// Desktop (≥1024px): centered modal

function sheetStyle(): CSSProperties {
  const base: CSSProperties = {
    position: "fixed",
    background: `linear-gradient(180deg, ${color.leather2}, ${color.leather})`,
    border: `1px solid ${color.borderHover}`,
    boxShadow: shadow.elevated,
    zIndex: 201,
    maxHeight: "90dvh",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  };
  // Mobile-first: bottom sheet
  return {
    ...base,
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderBottom: "none",
    animation: "slide-up 250ms ease-out",
  };
  // NOTE: full responsive (desktop modal) needs CSS media queries in real CSS,
  // not inline styles. POC ships mobile-bottom-sheet on all sizes — sufficient
  // for visual sign-off, can refactor to media-query setup once components
  // move to CSS modules or styled-components.
}

// ─── Sheet sub-components ─────────────────────────────────────────────

function SheetHeader({ card, onClose }: { card: MatchData; onClose: () => void }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "14px 20px",
      borderBottom: `1px solid ${color.border}`,
      position: "sticky",
      top: 0,
      background: color.leather2,
      zIndex: 1,
    }}>
      <div>
        <div style={{
          color: color.gold,
          fontWeight: fontWeight.semibold,
          fontSize: 14,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
        }}>
          λ-Audit · {card.home.abbr} × {card.away.abbr}
        </div>
        <div style={{ color: color.textMuted, fontSize: 11, marginTop: 2 }}>
          {card.marketLabel} · {card.kickoff}
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        style={{
          background: "transparent",
          border: `1px solid ${color.border}`,
          color: color.text,
          width: 32,
          height: 32,
          borderRadius: "50%",
          fontSize: 16,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >×</button>
    </div>
  );
}

function SectionLabel({ children, source }: { children: ReactNode; source?: string }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      marginBottom: 8,
      paddingBottom: 4,
      borderBottom: `1px solid ${color.border}`,
    }}>
      <span style={{
        color: color.goldMuted,
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontWeight: fontWeight.semibold,
      }}>{children}</span>
      {source && (
        <span style={{ color: color.textFaint, fontSize: 10, fontStyle: "italic" }}>{source}</span>
      )}
    </div>
  );
}

/** STUB — production will compute these from LightGBM `pred_contrib=True`. */
function LambdaDecomposition({ card }: { card: MatchData }) {
  const baseHome = 1.34;
  const baseAway = 1.34;
  const homeContrib = card.xgH - baseHome;
  const awayContrib = card.xgA - baseAway;

  // Synthetic feature breakdown — production will replace with real SHAP.
  const rows = [
    { label: "Base (league_avg)", home: baseHome.toFixed(2), away: baseAway.toFixed(2), note: "" },
    { label: "Elo diff",          home: `+${(homeContrib * 0.45).toFixed(2)}`, away: `−${(homeContrib * 0.08).toFixed(2)}`, note: "" },
    { label: "xG momentum (ewma)",home: `+${(homeContrib * 0.30).toFixed(2)}`, away: `−${(homeContrib * 0.10).toFixed(2)}`, note: "" },
    { label: "Lineup quality",     home: `+${(homeContrib * 0.15).toFixed(2)}`, away: "0.00", note: "⚠ 40% coverage" },
    { label: "Form streak",        home: `+${(homeContrib * 0.10).toFixed(2)}`, away: `−${(homeContrib * 0.04).toFixed(2)}`, note: "" },
    { label: "Home factor",        home: "+0.32", away: "—", note: "" },
  ];

  return (
    <div>
      <SectionLabel source="dev-03 · SHAP (stub)">λ Decomposition</SectionLabel>
      <div style={{
        background: color.leather3,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "8px 12px",
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
          gap: 8,
          padding: "4px 0",
          color: color.textMuted,
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: `1px dashed ${color.border}`,
        }}>
          <span>Feature</span>
          <span style={{ textAlign: "right" }}>{card.home.abbr}</span>
          <span style={{ textAlign: "right" }}>{card.away.abbr}</span>
          <span style={{ textAlign: "right" }}>Note</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
            gap: 8,
            padding: "5px 0",
            color: color.text,
            borderBottom: i < rows.length - 1 ? `1px dashed ${color.border}30` : "none",
          }}>
            <span style={{ color: color.text }}>{r.label}</span>
            <span style={{ textAlign: "right", color: r.home.startsWith("+") ? color.value : color.text }}>{r.home}</span>
            <span style={{ textAlign: "right", color: r.away.startsWith("+") ? color.value : color.text }}>{r.away}</span>
            <span style={{ textAlign: "right", color: color.warn, fontSize: 10 }}>{r.note}</span>
          </div>
        ))}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
          gap: 8,
          padding: "7px 0 3px",
          color: color.goldMuted,
          fontWeight: 700,
          borderTop: `1px solid ${color.border}`,
          marginTop: 4,
        }}>
          <span>Final λ</span>
          <span style={{ textAlign: "right" }}>{card.xgH.toFixed(2)}</span>
          <span style={{ textAlign: "right" }}>{card.xgA.toFixed(2)}</span>
          <span style={{ textAlign: "right", color: color.gold }}>Σ {card.xgSum.toFixed(2)}</span>
        </div>
      </div>
      <div style={{ marginTop: 6, color: color.textFaint, fontSize: 10.5, fontStyle: "italic" }}>
        L3: click any feature row to see top comparable matches in training corpus (stub).
      </div>
    </div>
  );
}

function CalibrationRow({ card }: { card: MatchData }) {
  return (
    <div>
      <SectionLabel source="live_brier_snapshots">Calibration · live</SectionLabel>
      <div style={{
        background: color.leather3,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "10px 12px",
        fontSize: 12,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
      }}>
        <KV label="σ² (Bayesian Ensemble)" value={card.sigma2.toFixed(3)} accent={card.confLevel === "high" ? color.value : color.goldMuted} />
        <KV label={`Live Brier ${card.league} 60-70%`} value={`${Math.round(card.trustHit*100)}% hit · n=${card.trustN}`} accent={card.trustBand === "gold" ? color.value : card.trustBand === "trap" ? color.warn : color.gold} />
      </div>
    </div>
  );
}

function ClosingLineRow({ card }: { card: MatchData }) {
  const startOdds = (1 / (card.marktProb / 100)).toFixed(2);
  const currentOdds = (1 / (card.marktProb / 100 + 0.005)).toFixed(2);
  return (
    <div>
      <SectionLabel source="odds_closing_history">Closing-line movement</SectionLabel>
      <div style={{
        background: color.leather3,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "10px 12px",
        fontSize: 12,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{ color: color.text }}>Open: <strong style={{ fontVariantNumeric: "tabular-nums" }}>{startOdds}</strong></span>
        <span style={{ color: color.textFaint, fontSize: 10 }}>→</span>
        <span style={{ color: color.text }}>Now: <strong style={{ fontVariantNumeric: "tabular-nums", color: color.value }}>{currentOdds}</strong></span>
        <span style={{ color: color.value, fontSize: 10, letterSpacing: "0.04em" }}>sharp money following</span>
      </div>
    </div>
  );
}

function ComparableMatchesRow({ card }: { card: MatchData }) {
  return (
    <div>
      <SectionLabel source="team_xg_history">Comparable matches (training corpus)</SectionLabel>
      <div style={{
        background: color.leather3,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "10px 12px",
        fontSize: 11.5,
        color: color.textMuted,
        fontStyle: "italic",
      }}>
        Top-3 BL matches with similar profile (Elo +150–200, xG-diff &gt; +0.5):
        <div style={{ marginTop: 8, display: "grid", gap: 4, color: color.text, fontStyle: "normal" }}>
          <span>{card.home.abbr} × Hoffenheim 2-1 (xG 2.8) <span style={{ color: card.xgSum > 2.5 ? color.value : color.textFaint, fontSize: 10 }}>✓ over 2.5</span></span>
          <span>Leverkusen × Köln 4-1 (xG 3.4) <span style={{ color: color.value, fontSize: 10 }}>✓ over 2.5</span></span>
          <span>Stuttgart × Bremen 3-3 (xG 4.1) <span style={{ color: color.value, fontSize: 10 }}>✓ over 2.5</span></span>
        </div>
        <div style={{ marginTop: 6, color: color.textFaint, fontSize: 10 }}>3/3 over-hits — pattern consistent.</div>
      </div>
    </div>
  );
}

function KV({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ color: color.textMuted, fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
      <span style={{
        color: accent ?? color.text,
        fontWeight: fontWeight.semibold,
        fontVariantNumeric: "tabular-nums",
        fontSize: 13,
      }}>{value}</span>
    </div>
  );
}

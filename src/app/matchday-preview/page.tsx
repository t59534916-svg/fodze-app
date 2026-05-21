"use client";
// ═══════════════════════════════════════════════════════════════════════
// /matchday-preview — L0+L1 Cards Design POC
//
// Refactored: components live in `src/components/matchday-card/`, data
// flows through `useMatchdayCards()` hook (currently returns mock data).
// See useMatchdayCards.ts for the production-wiring TODO seams.
// ═══════════════════════════════════════════════════════════════════════

import AppShell from "@/components/layout/AppShell";
import { color } from "@/styles/tokens";
import { MatchdayCard, useMatchdayCards } from "@/components/matchday-card";

export default function MatchdayPreviewPage() {
  const { cards, source } = useMatchdayCards();

  return (
    <AppShell>
      <div style={{
        textAlign: "center",
        padding: "16px 0 24px",
        borderBottom: `1px solid ${color.border}`,
        marginBottom: 20,
      }}>
        <h1 style={{
          margin: "0 0 6px 0",
          color: color.gold,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "0.04em",
        }}>L0 + L1 Cards Preview</h1>
        <p style={{
          margin: 0,
          color: color.textMuted,
          fontSize: 12,
        }}>
          5 Design-Archetypes · Bundesliga 25/26 · <em style={{ color: source === "mock" ? color.gold : color.value }}>data: {source}</em>
        </p>
        <div style={{
          display: "inline-block",
          marginTop: 8,
          padding: "3px 10px",
          color: color.textFaint,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          border: `1px solid ${color.border}`,
          borderRadius: 999,
        }}>1X2 · xG · Dual-Stack · Conf-Meter · MathSheet</div>
      </div>

      {cards.map(card => (
        <div key={card.id}>
          {card.archetype && (
            <div style={{
              margin: "20px 0 8px",
              paddingLeft: 4,
              paddingBottom: 6,
              color: color.textFaint,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              borderBottom: `1px dotted ${color.border}`,
            }}>{card.archetype}</div>
          )}
          <MatchdayCard card={card} />
        </div>
      ))}

      <div style={{
        marginTop: 28,
        padding: "20px 16px",
        borderTop: `1px solid ${color.border}`,
        color: color.textMuted,
        fontSize: 11.5,
      }}>
        <strong style={{
          color: color.goldMuted,
          display: "block",
          marginBottom: 8,
          fontSize: 12,
          letterSpacing: "0.05em",
        }}>EVALUATION CHECKLIST</strong>
        <div style={{ display: "grid", gap: 6, lineHeight: 1.7 }}>
          <div>① <strong>1X2 + xG Header:</strong> Match-Read in einem Blick erfassbar?</div>
          <div>② <strong>Recommended-Highlight (Card 2):</strong> Gold-Outline um B04 56% klar?</div>
          <div>③ <strong>Crests + Team-Farben:</strong> Logos + Match-Read-Farben stimmig?</div>
          <div>④ <strong>MathSheet:</strong> "Show math →" öffnet Sheet — passt der L2-Aufbau?</div>
          <div>⑤ <strong>Trap Card 5:</strong> +6pp warn + Drift + Kelly 0.3× genug Reibung?</div>
          <div>⑥ <strong>Compact Card 4:</strong> Wirkt sie "ruhig" oder "leer" jetzt?</div>
        </div>
      </div>
    </AppShell>
  );
}

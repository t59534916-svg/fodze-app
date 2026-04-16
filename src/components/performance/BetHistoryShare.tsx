"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useApp } from "@/contexts/AppContext";
import { shareBetCard } from "@/lib/bet-share-card";
import { betProfit, isSettled } from "@/lib/bet-metrics";
import { marketLabel } from "@/lib/market-labels";
import { fmtDateShort } from "@/lib/format";
import { color, fontSize, fontWeight, fontFamily, radius, space } from "@/styles/tokens";
import { card, text } from "@/styles/components";
import type { PlacedBet } from "@/types/match";

// ─── Styles ──────────────────────────────────────────────────────────

const S = {
  card: { ...card(), marginBottom: space[4] } as React.CSSProperties,
  label: { ...text.label, marginBottom: space[3] } as React.CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    alignItems: "center",
    gap: space[3],
    padding: `${space[3]}px 0`,
    borderBottom: `1px solid ${color.border}`,
  } as React.CSSProperties,
  rowLast: { borderBottom: "none" } as React.CSSProperties,
  matchName: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: color.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  meta: {
    fontSize: fontSize.xs,
    color: color.textFaint,
    marginTop: 2,
  } as React.CSSProperties,
  profit: (won: boolean) => ({
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    fontFamily: fontFamily.mono,
    color: won ? color.value : color.warn,
    minWidth: 64,
    textAlign: "right" as const,
  }),
  clv: (sign: 1 | -1 | 0) => ({
    fontSize: 10,
    fontFamily: fontFamily.mono,
    fontWeight: fontWeight.medium,
    color: sign > 0 ? color.value : sign < 0 ? color.warn : color.textFaint,
    marginTop: 2,
    textAlign: "right" as const,
  }),
  shareBtn: {
    minWidth: 44,
    minHeight: 44,
    padding: `${space[2]}px ${space[3]}px`,
    background: "transparent",
    border: `1px solid ${color.border}`,
    borderRadius: radius.sm,
    color: color.gold,
    cursor: "pointer",
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: "0.04em",
    transition: "all 0.15s",
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
  } as React.CSSProperties,
  toast: {
    position: "fixed" as const,
    bottom: 80,
    left: "50%",
    transform: "translateX(-50%)",
    padding: `${space[3]}px ${space[5]}px`,
    background: color.leather3,
    border: `1px solid ${color.gold}`,
    borderRadius: radius.full,
    color: color.gold,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
    zIndex: 1000,
    pointerEvents: "none" as const,
  },
  empty: {
    textAlign: "center" as const,
    padding: `${space[5]}px ${space[4]}px`,
    color: color.textMuted,
    fontSize: fontSize.sm,
  },
  filterChips: {
    display: "flex",
    gap: space[2],
    marginBottom: space[3],
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  chip: (active: boolean) => ({
    padding: `${space[2]}px ${space[3]}px`,
    minHeight: 32,
    borderRadius: radius.full,
    border: `1px solid ${active ? color.gold : color.border}`,
    background: active ? `${color.gold}20` : "transparent",
    color: active ? color.gold : color.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    cursor: "pointer",
    transition: "all 0.15s",
  }),
};

type Filter = "all" | "won" | "lost";

export default function BetHistoryShare() {
  const { userBets } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Cancel any pending toast when a new one fires or on unmount — prevents
  // setState-on-unmounted warnings and stale toasts racing each other.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2200);
  };
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // Single pass: filter to settled, sort newest-first, count won/lost
  const { settled, wonCount, lostCount } = useMemo(() => {
    const s: PlacedBet[] = [];
    let won = 0;
    for (const b of userBets) {
      if (isSettled(b)) s.push(b);
    }
    s.sort(
      (a, b) =>
        new Date(b.placed_at || 0).getTime() -
        new Date(a.placed_at || 0).getTime(),
    );
    for (const b of s) if (b.result === "won") won++;
    return { settled: s, wonCount: won, lostCount: s.length - won };
  }, [userBets]);

  const filtered = useMemo(() => {
    if (filter === "won") return settled.filter((b) => b.result === "won");
    if (filter === "lost") return settled.filter((b) => b.result === "lost");
    return settled;
  }, [settled, filter]);

  const handleShare = async (bet: PlacedBet) => {
    setSharingId(bet.id);
    try {
      const result = await shareBetCard(bet);
      if (result === "shared") showToast("Geteilt ✓");
      else if (result === "downloaded") showToast("Heruntergeladen ✓");
      else if (result === "cancelled") showToast("Abgebrochen");
    } catch (err) {
      console.error("[BetHistoryShare] render/share failed:", err);
      showToast("Fehler beim Teilen");
    } finally {
      setSharingId(null);
    }
  };

  if (settled.length === 0) {
    return (
      <div style={S.card}>
        <div style={S.label}>Vergangene Wetten</div>
        <div style={S.empty}>
          Noch keine abgerechneten Wetten. Platziere eine Wette und markiere
          sie als gewonnen/verloren, um sie hier zu teilen.
        </div>
      </div>
    );
  }

  const filterOptions: [Filter, string][] = [
    ["all", `Alle (${settled.length})`],
    ["won", `Gewonnen (${wonCount})`],
    ["lost", `Verloren (${lostCount})`],
  ];

  return (
    <div style={S.card}>
      <div style={S.label}>Vergangene Wetten ({settled.length})</div>

      <div style={S.filterChips} role="tablist" aria-label="Filter Wetten">
        {filterOptions.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            style={S.chip(filter === key)}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {filtered.length === 0 ? (
          <div style={S.empty}>Keine Wetten mit diesem Filter.</div>
        ) : (
          filtered.map((bet, i) => {
            const won = bet.result === "won";
            const profit = betProfit(bet);
            const dateStr = fmtDateShort(bet.placed_at);
            const isLast = i === filtered.length - 1;
            return (
              <div
                key={bet.id}
                style={{ ...S.row, ...(isLast ? S.rowLast : {}) }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={S.matchName}>
                    {bet.home_team} – {bet.away_team}
                  </div>
                  <div style={S.meta}>
                    {marketLabel(bet.market, "short")} @{" "}
                    {Number(bet.odds_placed).toFixed(2)} · €
                    {Number(bet.stake).toFixed(0)}
                    {dateStr && ` · ${dateStr}`}
                  </div>
                </div>
                <div>
                  <div style={S.profit(won)}>
                    {won ? "+" : "−"}€{Math.abs(profit).toFixed(0)}
                  </div>
                  {typeof bet.clv === "number" && Number.isFinite(bet.clv) && (
                    <div
                      style={S.clv(
                        bet.clv > 0 ? 1 : bet.clv < 0 ? -1 : 0,
                      )}
                      title="CLV — positiv = du hast die Closing-Quote geschlagen"
                    >
                      CLV {bet.clv >= 0 ? "+" : ""}
                      {bet.clv.toFixed(2)}%
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleShare(bet)}
                  disabled={sharingId === bet.id}
                  aria-label={`Wette ${bet.home_team} gegen ${bet.away_team} teilen`}
                  style={{
                    ...S.shareBtn,
                    opacity: sharingId === bet.id ? 0.5 : 1,
                    cursor: sharingId === bet.id ? "wait" : "pointer",
                  }}
                >
                  {sharingId === bet.id ? "…" : "↗ Teilen"}
                </button>
              </div>
            );
          })
        )}
      </div>

      {toast && (
        <div style={S.toast} role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

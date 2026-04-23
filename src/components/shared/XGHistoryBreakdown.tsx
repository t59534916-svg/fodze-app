"use client";
import { color } from "@/styles/tokens";
import type { XGHistoryEntry } from "@/types/match";

// ─── Per-Game Breakdown ──────────────────────────────────────────────
//
// Answers: "Wie hat sich der xG-Schnitt zusammengesetzt — gleichbleibend
// oder Ausreißer?" Shows each of the last N games as a compact pill:
//   [OLY 2.1]  [PAO 0.9↓]  [VOL 3.5↑]  [LAM 4.1↑↑]  ...
//
// Outliers are flagged by z-score against the window's own mean:
//   |z| < 1.0     normal       (no arrow, muted color)
//   1.0 ≤ z < 2.0 mild high    (single up arrow, green tint)
//   z ≥ 2.0       extreme high (double up arrow, strong green)
//   -2.0 < z ≤ -1.0 mild low   (single down arrow, red tint)
//   z ≤ -2.0      extreme low  (double down arrow, strong red)
//
// Tooltip on each pill shows the full context (opponent, xG, xGA, actual
// goals, match date) so power-users can verify the mark without leaving.
// Footer gives σ + outlier count as a consistency headline.

type Mark = "normal" | "high" | "highExt" | "low" | "lowExt";

function classify(z: number): Mark {
  if (z >= 2) return "highExt";
  if (z >= 1) return "high";
  if (z <= -2) return "lowExt";
  if (z <= -1) return "low";
  return "normal";
}

function markColor(m: Mark): { fg: string; bg: string; border: string } {
  switch (m) {
    case "highExt": return { fg: color.value, bg: `${color.value}25`, border: `${color.value}55` };
    case "high":    return { fg: color.value, bg: `${color.value}15`, border: `${color.value}30` };
    case "lowExt":  return { fg: color.warn,  bg: `${color.warn}25`,  border: `${color.warn}55` };
    case "low":     return { fg: color.warn,  bg: `${color.warn}15`,  border: `${color.warn}30` };
    default:        return { fg: `${color.goldMid}90`, bg: `${color.goldMid}10`, border: `${color.goldMid}20` };
  }
}

function markGlyph(m: Mark): string {
  if (m === "highExt") return "↑↑";
  if (m === "high") return "↑";
  if (m === "lowExt") return "↓↓";
  if (m === "low") return "↓";
  return "";
}

// Short opponent tag — take the first word's first 3 chars, uppercase.
// "Bayer 04 Leverkusen" → "BAY", "1. FC Nürnberg" → "NÜR" (skip 1.)
// Falls opponent leer ist (kommt vor wenn team_xg_history rows ohne
// opponent-Spalte kamen), fällt das Label auf das Datum zurück —
// besser eine valide Info als "???" überall.
function shortOpponent(opponent: string | undefined, dateShort: string): string {
  if (!opponent) return dateShort || "—";
  const tokens = opponent.split(/\s+/).filter(t => !/^(\d+\.?|FC|SC|SV|VfL|VfB|TSG|RB)$/.test(t));
  const head = tokens[0] || opponent;
  return head.slice(0, 3).toUpperCase();
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.` : iso;
}

export default function XGHistoryBreakdown({
  history,
  venueLabel,
}: {
  history?: XGHistoryEntry[];
  /** "Heim" | "Auswärts" — title shown above the pill row */
  venueLabel: string;
}) {
  if (!history || history.length < 3) return null;

  const xgs = history.map(e => e.xg);
  const mean = xgs.reduce((s, v) => s + v, 0) / xgs.length;
  const variance = xgs.reduce((s, v) => s + (v - mean) ** 2, 0) / xgs.length;
  const std = Math.sqrt(variance);

  const entries = history.map(e => {
    const z = std > 0.01 ? (e.xg - mean) / std : 0;
    return { entry: e, z, mark: classify(z) };
  });

  const outliers = entries.filter(e => e.mark !== "normal").length;
  const stdLabel =
    std < 0.5 ? "konstant"
    : std < 1.0 ? "moderat"
    : std < 1.5 ? "schwankend"
    : "volatil";

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        marginBottom: 6, fontSize: 10, color: `${color.goldMid}a0`,
      }}>
        <span style={{ fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Letzte {history.length} {venueLabel}spiele · xG pro Spiel
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 9 }}>
          Ø {mean.toFixed(2)} · σ {std.toFixed(2)} · {stdLabel}{outliers > 0 ? ` · ${outliers} Ausreißer` : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {entries.map((e, i) => {
          const c = markColor(e.mark);
          const glyph = markGlyph(e.mark);
          const date = formatDate(e.entry.date);
          const opp = shortOpponent(e.entry.opponent, date);
          const goalsLine =
            e.entry.goals_for != null && e.entry.goals_against != null
              ? ` · Tore ${e.entry.goals_for}:${e.entry.goals_against}`
              : "";
          const titleHead = e.entry.opponent
            ? `${date} vs ${e.entry.opponent}`
            : date || "Spiel";
          const title =
            `${titleHead}\n` +
            `xG ${e.entry.xg.toFixed(2)} · xGA ${e.entry.xga.toFixed(2)}${goalsLine}\n` +
            `z-Score ${e.z.toFixed(2)} · ${e.mark === "normal" ? "im Rahmen" : "Ausreißer"}`;
          return (
            <span
              key={i}
              title={title}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 6px",
                borderRadius: 3,
                background: c.bg,
                color: c.fg,
                border: `1px solid ${c.border}`,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <span style={{ opacity: 0.8, fontSize: 9 }}>{opp}</span>
              <span>{e.entry.xg.toFixed(1)}</span>
              {glyph && <span style={{ fontSize: 9 }}>{glyph}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

"use client";

interface XGHistoryEntry {
  xg: number;
  xga: number;
  result?: string;
  date?: string;
  proxy?: string;
}

interface XGSparklineProps {
  history: XGHistoryEntry[];
  width?: number;
  height?: number;
}

function rollingAvg(values: number[], window: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return result;
}

function getTrend(values: number[]): { arrow: string; label: string; color: string } {
  if (values.length < 3) return { arrow: "→", label: "stabil", color: "#d4b86a" };
  const recent = values.slice(-3);
  const earlier = values.slice(-6, -3).length > 0 ? values.slice(-6, -3) : values.slice(0, Math.min(3, values.length));
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgEarlier = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  const diff = avgRecent - avgEarlier;
  const threshold = 0.15;

  if (diff > threshold * 2) return { arrow: "↑", label: "steigend", color: "#6aad55" };
  if (diff > threshold) return { arrow: "↗", label: "leicht↑", color: "#8bbd6a" };
  if (diff < -threshold * 2) return { arrow: "↓", label: "fallend", color: "#c47070" };
  if (diff < -threshold) return { arrow: "↘", label: "leicht↓", color: "#c4a265" };
  return { arrow: "→", label: "stabil", color: "#d4b86a" };
}

export default function XGSparkline({ history, width = 160, height = 32 }: XGSparklineProps) {
  if (!history || history.length < 2) return null;

  const xgValues = history.map((h) => h.xg);
  const xgaValues = history.map((h) => h.xga);
  const xgRolling = rollingAvg(xgValues, 3);
  const xgaRolling = rollingAvg(xgaValues, 3);

  const allValues = [...xgRolling, ...xgaRolling];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;

  const padY = 4;
  const chartH = height - padY * 2;
  const padX = 2;
  const chartW = width - 46 - padX * 2; // reserve space for trend label

  const toX = (i: number) => padX + (i / (xgRolling.length - 1)) * chartW;
  const toY = (v: number) => padY + chartH - ((v - minVal) / range) * chartH;

  const xgPath = xgRolling.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
  const xgaPath = xgaRolling.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");

  const trend = getTrend(xgRolling);
  const isProxy = history.some((h) => h.proxy === "goals");

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <svg width={width - 42} height={height} style={{ overflow: "visible" }}>
        {/* xGA dashed brown line */}
        <path d={xgaPath} fill="none" stroke="#8b4513" strokeWidth={1.2} strokeDasharray="3,2" opacity={0.7} />
        {/* xG solid gold line */}
        <path d={xgPath} fill="none" stroke="#d4b86a" strokeWidth={1.5} />
        {/* End dot */}
        <circle cx={toX(xgRolling.length - 1)} cy={toY(xgRolling[xgRolling.length - 1])} r={2} fill="#d4b86a" />
      </svg>
      <div style={{ fontSize: 9, lineHeight: 1.2, textAlign: "left", minWidth: 38 }}>
        <div style={{ color: trend.color, fontWeight: 600 }}>
          {trend.arrow}{trend.label}
        </div>
        {isProxy && <div style={{ color: "#c4a26540", fontSize: 7 }}>(Tore)</div>}
      </div>
    </div>
  );
}

"use client";

interface XGHistoryEntry {
  xg: number;
  xga: number;
  result?: string;
  opponent?: string;
  date?: string;
  proxy?: string;
}

interface XGChartProps {
  history: XGHistoryEntry[];
  teamName: string;
  venue: "home" | "away";
  height?: number;
}

export default function XGChart({ history, teamName, venue, height = 200 }: XGChartProps) {
  if (!history || history.length === 0) {
    return (
      <div style={{
        background: "#1a0f08",
        borderRadius: 8,
        padding: 24,
        textAlign: "center",
        color: "#c4a26560",
        fontFamily: "Georgia, serif",
        fontSize: 13,
      }}>
        Keine History-Daten verf&uuml;gbar
      </div>
    );
  }

  const xgd = history.map(h => h.xg - h.xga);

  const padTop = 36;
  const padBottom = 28;
  const padLeft = 36;
  const padRight = 12;
  const viewW = 600;
  const chartH = height - padTop - padBottom;
  const chartW = viewW - padLeft - padRight;

  const maxAbs = Math.max(Math.abs(Math.min(...xgd)), Math.abs(Math.max(...xgd)), 0.5);
  const yRange = Math.ceil(maxAbs * 10) / 10;

  const toX = (i: number) => {
    if (xgd.length === 1) return padLeft + chartW / 2;
    return padLeft + (i / (xgd.length - 1)) * chartW;
  };
  const toY = (v: number) => padTop + chartH / 2 - (v / yRange) * (chartH / 2);

  const barWidth = xgd.length > 1
    ? Math.min(chartW / xgd.length * 0.6, 30)
    : 30;

  const zeroY = toY(0);

  const linePath = xgd
    .map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(" ");

  const yTicks: number[] = [];
  const step = yRange > 2 ? 1 : yRange > 1 ? 0.5 : 0.25;
  for (let v = -Math.floor(yRange / step) * step; v <= yRange; v += step) {
    if (Math.abs(v) <= yRange) yTicks.push(parseFloat(v.toFixed(2)));
  }

  const venueLabel = venue === "home" ? "Heim" : "Ausw\u00e4rts";

  return (
    <div style={{ background: "#1a0f08", borderRadius: 8, padding: "8px 4px 0" }}>
      {/* Title */}
      <div style={{
        fontFamily: "Georgia, serif",
        color: "#d4b86a",
        fontSize: 13,
        fontWeight: 600,
        textAlign: "center",
        marginBottom: 2,
        letterSpacing: 0.5,
      }}>
        {teamName} &mdash; xGD Rolling ({venueLabel})
      </div>

      {/* SVG Chart */}
      <svg viewBox={`0 0 ${viewW} ${height}`} width="100%" style={{ display: "block" }}>
        {/* Y-axis ticks + grid */}
        {yTicks.map(v => (
          <g key={v}>
            <line
              x1={padLeft} y1={toY(v)} x2={padLeft + chartW} y2={toY(v)}
              stroke={v === 0 ? "#d4b86a" : "#c4a26518"}
              strokeWidth={v === 0 ? 1 : 0.5}
              strokeDasharray={v === 0 ? "6,3" : "none"}
            />
            <text
              x={padLeft - 4} y={toY(v) + 3}
              fill="#c4a26550" fontSize={9} textAnchor="end"
              fontFamily="monospace"
            >
              {v > 0 ? "+" : ""}{v.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Bars */}
        {xgd.map((v, i) => {
          const x = toX(i) - barWidth / 2;
          const barH = Math.abs(toY(v) - zeroY);
          const y = v >= 0 ? toY(v) : zeroY;
          return (
            <rect
              key={`bar-${i}`}
              x={x} y={y} width={barWidth} height={barH}
              fill={v >= 0 ? "#6aad5530" : "#c4707030"}
              rx={2}
            />
          );
        })}

        {/* Gold line */}
        <path d={linePath} fill="none" stroke="#d4b86a" strokeWidth={2} strokeLinejoin="round" />

        {/* Dots */}
        {xgd.map((v, i) => (
          <circle
            key={`dot-${i}`}
            cx={toX(i)} cy={toY(v)} r={3.5}
            fill={v >= 0 ? "#6aad55" : "#c47070"}
            stroke="#1a0f08" strokeWidth={1}
          />
        ))}

        {/* X-axis labels */}
        {history.map((h, i) => {
          const label = h.opponent
            ? h.opponent.substring(0, 6)
            : `SP${i + 1}`;
          return (
            <text
              key={`x-${i}`}
              x={toX(i)} y={height - 6}
              fill="#c4a26550" fontSize={8} textAnchor="middle"
              fontFamily="monospace"
            >
              {label}
            </text>
          );
        })}
      </svg>

      {/* Data table */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${history.length}, 1fr)`,
        gap: 2,
        padding: "4px 8px 8px",
        fontSize: 9,
        fontFamily: "monospace",
        color: "#c4a26570",
      }}>
        {/* Header row: Gegner */}
        {history.map((h, i) => (
          <div key={`opp-${i}`} style={{ textAlign: "center", fontWeight: 600, color: "#c4a26580" }}>
            {h.opponent ? h.opponent.substring(0, 6) : `SP${i + 1}`}
          </div>
        ))}
        {/* xG row */}
        {history.map((h, i) => (
          <div key={`xg-${i}`} style={{ textAlign: "center", color: "#d4b86a" }}>
            {h.xg.toFixed(1)}
          </div>
        ))}
        {/* xGA row */}
        {history.map((h, i) => (
          <div key={`xga-${i}`} style={{ textAlign: "center", color: "#c47070" }}>
            {h.xga.toFixed(1)}
          </div>
        ))}
        {/* xGD row */}
        {history.map((h, i) => {
          const d = h.xg - h.xga;
          return (
            <div key={`xgd-${i}`} style={{ textAlign: "center", fontWeight: 700, color: d >= 0 ? "#6aad55" : "#c47070" }}>
              {d >= 0 ? "+" : ""}{d.toFixed(1)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

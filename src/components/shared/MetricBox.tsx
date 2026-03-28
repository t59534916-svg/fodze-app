"use client";
import type { CSSProperties } from "react";

const metricStyle: CSSProperties = {
  background: "#c4a26510", border: "1px solid #c4a26518", borderRadius: 8,
  padding: "8px 4px", textAlign: "center",
};

export default function MetricBox({ label, value, valueColor, style }: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...metricStyle, ...style }}>
      <div style={{ fontSize: 8, color: "#c4a26550", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: valueColor || "#ede4d4" }}>{value}</div>
    </div>
  );
}

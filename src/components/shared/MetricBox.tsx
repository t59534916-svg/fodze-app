"use client";
import type { CSSProperties } from "react";
import { color } from "@/styles/tokens";

const metricStyle: CSSProperties = {
  background: `${color.goldMid}10`, border: `1px solid ${color.goldMid}18`, borderRadius: 8,
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
      <div style={{ fontSize: 8, color: `${color.goldMid}50`, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: valueColor || color.text }}>{value}</div>
    </div>
  );
}

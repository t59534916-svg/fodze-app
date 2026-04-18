"use client";
import type { CSSProperties } from "react";
import { color } from "@/styles/tokens";

const tagStyle = (c: string, bg: string): CSSProperties => ({
  display: "inline-block", fontSize: 9, fontWeight: 600, padding: "2px 6px",
  borderRadius: 4, marginRight: 3, background: bg, color: c,
});

export default function ValueBadge({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return <span style={tagStyle(color, bg)}>{children}</span>;
}

// Pre-configured variants — all token-driven. The earlier mix of
// `#5a8c4a15` vs `color.value` was the exact drift that caused visually
// inconsistent greens across cards. One base hue, explicit alpha tints.
export function TagValue({ children }: { children?: React.ReactNode }) {
  return <ValueBadge color={color.value} bg={color.valueBg}>{children || "VALUE"}</ValueBadge>;
}
export function TagWarn({ children }: { children: React.ReactNode }) {
  return <ValueBadge color={color.warn} bg={color.warnBg}>{children}</ValueBadge>;
}
export function TagNeutral({ children }: { children: React.ReactNode }) {
  return <ValueBadge color={color.goldMid} bg={color.goldGhost}>{children}</ValueBadge>;
}
export function TagInfo({ children }: { children: React.ReactNode }) {
  return <ValueBadge color={`${color.goldMid}70`} bg={`${color.goldMid}10`}>{children}</ValueBadge>;
}

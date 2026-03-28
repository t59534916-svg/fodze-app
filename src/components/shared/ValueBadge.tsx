"use client";
import type { CSSProperties } from "react";

const tagStyle = (c: string, bg: string): CSSProperties => ({
  display: "inline-block", fontSize: 9, fontWeight: 600, padding: "2px 6px",
  borderRadius: 4, marginRight: 3, background: bg, color: c,
});

export default function ValueBadge({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return <span style={tagStyle(color, bg)}>{children}</span>;
}

// Pre-configured variants
export function TagValue({ children }: { children?: React.ReactNode }) {
  return <ValueBadge color="#6aad55" bg="#5a8c4a15">{children || "VALUE"}</ValueBadge>;
}
export function TagWarn({ children }: { children: React.ReactNode }) {
  return <ValueBadge color="#c47070" bg="#8c4a4a18">{children}</ValueBadge>;
}
export function TagNeutral({ children }: { children: React.ReactNode }) {
  return <ValueBadge color="#c4a265" bg="#c4a26520">{children}</ValueBadge>;
}
export function TagInfo({ children }: { children: React.ReactNode }) {
  return <ValueBadge color="#c4a26570" bg="#c4a26510">{children}</ValueBadge>;
}

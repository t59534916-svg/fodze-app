"use client";
import { TEAM_COLORS } from "@/lib/team-colors";

export default function Kit({ team, size = 16 }: { team: string; size?: number }) {
  const [primary, secondary] = TEAM_COLORS[team] || ["#c4a26540", "#c4a26520"];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M6 3L2 7v4l4-2v12h12V9l4 2V7l-4-4h-4c0 1.1-.9 2-2 2s-2-.9-2-2H6z"
        fill={primary} stroke={secondary} strokeWidth="1.2"/>
      <path d="M2 7l4-4M22 7l-4-4" stroke={secondary} strokeWidth="1" fill="none"/>
    </svg>
  );
}

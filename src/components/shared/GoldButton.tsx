"use client";
import type { CSSProperties } from "react";

const goldBtnStyle: CSSProperties = {
  background: "linear-gradient(110deg, #a68940 0%, #d4b86a 25%, #f5e6b8 50%, #d4b86a 75%, #a68940 100%)",
  backgroundSize: "200% 100%", border: "none", borderRadius: 8, padding: 14,
  color: "#1a0f0a", fontSize: 14, fontWeight: 700, cursor: "pointer",
  letterSpacing: "0.5px", width: "100%",
  animation: "goldShimmer 3s ease-in-out infinite",
};

export default function GoldButton({ children, style, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button style={{ ...goldBtnStyle, ...style }} {...props}>
      {children}
    </button>
  );
}

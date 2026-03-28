"use client";
import type { CSSProperties } from "react";

const corner = (pos: string): CSSProperties => ({
  position: "absolute", width: 22, height: 22, zIndex: 2,
  ...(pos === "tl" ? { top: 6, left: 6, borderTop: "2px solid #c4a26535", borderLeft: "2px solid #c4a26535", borderRadius: "4px 0 0 0" } :
    pos === "tr" ? { top: 6, right: 6, borderTop: "2px solid #c4a26535", borderRight: "2px solid #c4a26535", borderRadius: "0 4px 0 0" } :
    pos === "bl" ? { bottom: 6, left: 6, borderBottom: "2px solid #c4a26535", borderLeft: "2px solid #c4a26535", borderRadius: "0 0 0 4px" } :
    { bottom: 6, right: 6, borderBottom: "2px solid #c4a26535", borderRight: "2px solid #c4a26535", borderRadius: "0 0 4px 0" }),
});

export default function Corners() {
  return (
    <>
      <div style={corner("tl")} /><div style={corner("tr")} />
      <div style={corner("bl")} /><div style={corner("br")} />
      <div style={{ position: "absolute", inset: 6, border: "1px solid #c4a26510", borderRadius: 8, pointerEvents: "none", zIndex: 1 }} />
    </>
  );
}

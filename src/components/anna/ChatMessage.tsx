"use client";
import type { CSSProperties } from "react";

const assistantStyle: CSSProperties = {
  background: "#c4a2650c", border: "1px solid #c4a26518", borderRadius: "12px 12px 12px 4px",
  padding: "12px 14px", maxWidth: "88%", fontSize: 13, lineHeight: 1.65, color: "#ede4d4",
  whiteSpace: "pre-wrap", animation: "slideUp 0.2s ease",
};

const userStyle: CSSProperties = {
  background: "linear-gradient(135deg, #a68940, #d4b86a)", borderRadius: "12px 12px 4px 12px",
  padding: "10px 14px", maxWidth: "80%", fontSize: 13, lineHeight: 1.5, color: "#1a0f0a",
  fontWeight: 500, marginLeft: "auto", animation: "slideUp 0.15s ease",
};

const typingDots: CSSProperties = {
  display: "inline-flex", gap: 4, padding: "4px 0",
};

export default function ChatMessage({ role, content, isStreaming, children }: {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginBottom: 12 }}>
      {/* Role label */}
      <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 4, fontWeight: 600, letterSpacing: 0.5,
        textAlign: role === "user" ? "right" : "left" }}>
        {role === "assistant" ? "ANNA" : "DU"}
      </div>
      {/* Message bubble */}
      <div style={role === "user" ? userStyle : assistantStyle}>
        {content}
        {isStreaming && !content && (
          <div style={typingDots}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#c4a26560", animation: "pulse 1.5s infinite" }} />
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#c4a26560", animation: "pulse 1.5s infinite 0.3s" }} />
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#c4a26560", animation: "pulse 1.5s infinite 0.6s" }} />
          </div>
        )}
        {isStreaming && content && <span style={{ display: "inline-block", width: 2, height: 14, background: "#d4b86a", marginLeft: 2, animation: "pulse 1s infinite", verticalAlign: "text-bottom" }} />}
      </div>
      {/* Interactive elements below bubble */}
      {children && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

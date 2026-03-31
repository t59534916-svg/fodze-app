"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/contexts/AppContext";
import { loadLatestMatchday, loadLiveOdds, loadOddsHistory } from "@/lib/supabase";
import { LEAGUES, getHomeFactor, calcMatchEnhanced, calculateBetsEnhanced, validateXGData } from "@/lib/dixon-coles";
import { buildAnnaSystemPrompt } from "@/lib/anna-prompt";
import AppShell from "@/components/layout/AppShell";
import ChatMessage from "@/components/anna/ChatMessage";
import LeagueChips from "@/components/anna/LeagueChips";
import { BudgetReplies, RiskReplies } from "@/components/anna/QuickReplies";
import BetCard from "@/components/anna/BetCard";
import type { BetSuggestion } from "@/components/anna/BetCard";

type Phase = "greeting" | "leagues" | "budget" | "risk" | "loading" | "analysis" | "chat";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

// Offline fallback — generates analysis text purely from computed data
function generateOfflineAnalysis(leagueData: Record<string, any>, budget: number, risk: string): string {
  const frac = ({ K: 0.25, M: 0.33, A: 0.5 } as any)[risk] || 0.33;
  let text = "📊 **Analyse basierend auf Dixon-Coles Modell**\n\n";
  let totalValueBets = 0;
  let totalStake = 0;

  for (const [lgKey, data] of Object.entries(leagueData)) {
    const valueBets = [];
    for (const m of (data as any).matches) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (!b.isValue || b.edge <= 0) continue;
        valueBets.push({ ...b, home: m.home?.name, away: m.away?.name, kickoff: m.kickoff });
      }
    }

    if (valueBets.length === 0) {
      text += `🏟️ **${(data as any).label}**: Keine Value-Bets gefunden.\n\n`;
      continue;
    }

    text += `🏟️ **${(data as any).label}** — ${valueBets.length} Value-Bet${valueBets.length > 1 ? "s" : ""}:\n\n`;

    for (const bet of valueBets.sort((a, b) => b.edge - a.edge)) {
      const stake = bet.kelly * budget;
      totalStake += stake;
      totalValueBets++;

      text += `• **${bet.label}** ${bet.home} – ${bet.away}`;
      if (bet.kickoff) text += ` (${bet.kickoff})`;
      text += `\n`;
      text += `  Modell: ${pc(bet.pModel)} | Quote: ${bet.quote.toFixed(2)} | Edge: ${pe(bet.edge)} | ${bet.confidence}\n`;
      text += `  Kelly-Einsatz: €${stake.toFixed(0)}\n\n`;
    }
  }

  if (totalValueBets === 0) {
    text += "Aktuell keine Value-Bets mit positivem Edge gefunden. Warte auf bessere Quoten oder neue Spieltagsdaten.\n";
  } else {
    text += `───────────────\n`;
    text += `📋 **${totalValueBets} Value-Bets** | Gesamteinsatz: €${totalStake.toFixed(0)} / €${budget}\n`;
    text += `Verbleibend: €${Math.max(0, budget - totalStake).toFixed(0)}\n\n`;

    if (totalValueBets >= 3) {
      text += `💡 **Tipp:** Mit ${totalValueBets} Value-Legs eignet sich ein **2aus${totalValueBets} System** — höhere Gewinnchance bei moderatem Risiko.\n`;
    }
  }

  return text;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  interactive?: "leagues" | "budget" | "risk";
  betSuggestions?: BetSuggestion[];
}

const uid = () => Math.random().toString(36).slice(2, 8);

// Anna avatar images — add as many as you want in /public
const ANNA_AVATARS = [
  "/anna-avatar.jpg",
  "/anna-avatar-1.jpg",
  "/anna-avatar-2.jpg",
  "/anna-avatar-3.jpg",
  "/anna-avatar-4.jpg",
  "/anna-avatar-5.jpg",
];

export default function AnnaPage() {
  const { supabase, user, bankroll, leagueStatus } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState<Phase>("greeting");
  const [selectedLeagues, setSelectedLeagues] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState(0);
  const [riskLevel, setRiskLevel] = useState("M");
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [multiLeagueData, setMultiLeagueData] = useState<Record<string, any>>({});
  const [avatarIdx, setAvatarIdx] = useState(0);
  const [availableAvatars, setAvailableAvatars] = useState<string[]>([ANNA_AVATARS[0]]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Detect which avatar images actually exist in /public
  useEffect(() => {
    const found: string[] = [];
    let checked = 0;
    ANNA_AVATARS.forEach((src) => {
      const img = new Image();
      img.onload = () => { found.push(src); checked++; if (checked === ANNA_AVATARS.length) setAvailableAvatars(found.length > 0 ? found : [ANNA_AVATARS[0]]); };
      img.onerror = () => { checked++; if (checked === ANNA_AVATARS.length) setAvailableAvatars(found.length > 0 ? found : [ANNA_AVATARS[0]]); };
      img.src = src;
    });
  }, []);

  const cycleAvatar = useCallback(() => {
    if (availableAvatars.length <= 1) return;
    setAvatarIdx(prev => (prev + 1) % availableAvatars.length);
  }, [availableAvatars]);

  const currentAvatar = availableAvatars[avatarIdx % availableAvatars.length];

  // Auto-scroll to bottom
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isStreaming]);

  // Initialize greeting
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        id: uid(), role: "assistant",
        content: "Hallo! Ich bin Anna, deine Wettberaterin. 🎯\n\nWelche Ligen sollen wir uns heute ansehen?",
        interactive: "leagues",
      }]);
      setPhase("leagues");
    }
  }, []);

  const addMessage = (msg: Omit<Message, "id">) => {
    setMessages(prev => [...prev, { ...msg, id: uid() }]);
  };

  // ─── Phase Handlers ────────────────────────────────────────────

  const handleLeaguesConfirm = () => {
    const names = Array.from(selectedLeagues).map(k => LEAGUES[k]?.name).filter(Boolean).join(", ");
    addMessage({ role: "user", content: names });
    addMessage({ role: "assistant", content: "Gute Wahl! 💰\n\nWie viel Budget hast du heute zur Verfügung?", interactive: "budget" });
    setPhase("budget");
  };

  const handleBudgetSelect = (amount: number) => {
    setBudget(amount);
    addMessage({ role: "user", content: `€${amount}` });
    addMessage({ role: "assistant", content: "Und wie risikofreudig bist du heute?", interactive: "risk" });
    setPhase("risk");
  };

  const handleRiskSelect = async (level: string) => {
    setRiskLevel(level);
    const label = level === "K" ? "Konservativ" : level === "A" ? "Aggressiv" : "Moderat";
    addMessage({ role: "user", content: label });
    addMessage({ role: "assistant", content: `Perfekt — ${Array.from(selectedLeagues).length} Liga${selectedLeagues.size > 1 ? "n" : ""}, €${budget}, ${label}.\n\nIch lade die Spieltagsdaten und analysiere...` });
    setPhase("loading");
    await loadAndAnalyze(level);
  };

  // ─── Load Multi-League Data + Send to Anna ─────────────────────

  const loadAndAnalyze = async (risk: string) => {
    const frac = ({ K: 0.25, M: 0.33, A: 0.5 } as any)[risk] || 0.33;
    const leagueData: Record<string, any> = {};

    for (const lgKey of selectedLeagues) {
      const ld = LEAGUES[lgKey];
      if (!ld) continue;

      try {
        const cached = await loadLatestMatchday(supabase, lgKey);
        if (!cached?.data?.matches) continue;

        const live = await loadLiveOdds(supabase, lgKey);
        const rawMatches = cached.data.matches;
        const processedMatches: any[] = [];

        for (let i = 0; i < rawMatches.length; i++) {
          const match = rawMatches[i];
          const h = match.home, a = match.away;
          if (!h?.xg_h8 || !a?.xg_a8) { processedMatches.push({ ...match, calc: null }); continue; }

          // Auto-match live odds
          let oddsObj: any = {};
          const homeName = (h.name || "").toLowerCase();
          const awayName = (a.name || "").toLowerCase();
          const matched = live.find((lo: any) => {
            const loH = lo.home_team.toLowerCase(), loA = lo.away_team.toLowerCase();
            return (loH.includes(homeName) || homeName.includes(loH) ||
              loH.split(" ").some((w: string) => w.length > 3 && homeName.includes(w))) &&
              (loA.includes(awayName) || awayName.includes(loA) ||
              loA.split(" ").some((w: string) => w.length > 3 && awayName.includes(w)));
          });
          if (matched?.best_h) {
            oddsObj = { h: String(matched.best_h), d: String(matched.best_d), a: String(matched.best_a),
              o25: matched.best_over25 ? String(matched.best_over25) : "" };
          }

          // Also check manual odds history
          const key = `${lgKey}:${h.name}-${a.name}`.toLowerCase().replace(/\s/g, "");
          const hist = await loadOddsHistory(supabase, key);
          if (hist.length > 0) oddsObj = hist[hist.length - 1].odds;

          // Calc match
          const matchHf = getHomeFactor(h.name, ld.hf);
          const enh = calcMatchEnhanced(h.xg_h8, h.xga_h8, h.games || 8, h.form, a.xg_a8, a.xga_a8, a.games || 8, a.form,
            ld.avg, matchHf, match.tags || [], h.xg_h_history, a.xg_a_history,
            undefined, undefined, undefined, undefined, { league: lgKey });

          const no: Record<string, number> = {};
          for (const k of ["h", "d", "a", "o25", "u25", "btts"]) { const v = parseFloat(oddsObj[k]); if (v > 0) no[k] = v; }
          const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;
          const bets = calculateBetsEnhanced(enh.mk, enh.mk_low, enh.mk_high, no, frac);

          const topScores: { s: string; p: number }[] = [];
          if (enh.matrix) {
            for (let x = 0; x <= 5; x++)
              for (let y = 0; y <= 5; y++)
                if (enh.matrix[x]?.[y] > 0.005) topScores.push({ s: `${x}:${y}`, p: enh.matrix[x][y] });
          }
          topScores.sort((a, b) => b.p - a.p);

          processedMatches.push({
            ...match, calc: {
              lambdaH: enh.lambdaH, lambdaA: enh.lambdaA, mk: enh.mk, enh,
              bets, topScores: topScores.slice(0, 3), hasValue: bets.some((b: any) => b.isValue), hasOdds,
            }
          });
        }

        leagueData[lgKey] = {
          label: cached.matchday_label || cached.data?.matchday || "—",
          matches: processedMatches,
        };
      } catch { /* skip league on error */ }
    }

    setMultiLeagueData(leagueData);

    // Build system prompt and call Anna
    const systemPrompt = buildAnnaSystemPrompt({
      budget, riskLevel: risk, kellyFraction: frac, bankroll,
      leagueData,
    });

    await streamAnna(systemPrompt, [{
      role: "user",
      content: `Analysiere die Spieltage für ${Array.from(selectedLeagues).map(k => LEAGUES[k]?.name).join(" und ")}. Budget: €${budget}, Risiko: ${risk === "K" ? "Konservativ" : risk === "A" ? "Aggressiv" : "Moderat"}.`,
    }]);

    // Generate BetCards from computed data
    const suggestions: BetSuggestion[] = [];
    for (const [lgKey, data] of Object.entries(leagueData)) {
      for (const m of data.matches) {
        if (!m.calc?.bets) continue;
        for (const b of m.calc.bets) {
          if (!b.isValue || b.edge <= 0) continue;
          suggestions.push({
            type: "single", label: `${b.label} ${m.home?.name} – ${m.away?.name}`,
            legs: [{ match: `${m.home?.name} – ${m.away?.name}`, market: b.label, odds: b.quote, edge: b.edge }],
            stake: b.kelly * budget, expectedReturn: b.kelly * budget * b.quote,
            probability: b.pModel, confidence: b.confidence,
          });
        }
      }
    }
    if (suggestions.length > 0) {
      addMessage({ role: "assistant", content: "📋 Hier meine konkreten Vorschläge:", betSuggestions: suggestions });
    }
  };

  // ─── Streaming ─────────────────────────────────────────────────

  const streamAnna = async (systemPrompt: string, apiMessages: { role: string; content: string }[]) => {
    setIsStreaming(true);
    const assistantId = uid();
    setMessages(prev => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    try {
      const resp = await fetch("/api/anna", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, systemPrompt }),
      });

      // Check for offline mode (no API key)
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await resp.json();
        if (json.offline) {
          // Offline fallback — generate response from computed data
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: generateOfflineAnalysis(multiLeagueData, budget, riskLevel) } : m));
          setIsStreaming(false);
          setPhase("chat");
          return;
        }
        if (json.error) {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `Fehler: ${json.error}` } : m));
          setIsStreaming(false);
          setPhase("chat");
          return;
        }
      }

      if (!resp.ok) {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: "Fehler: API nicht erreichbar" } : m));
        setIsStreaming(false);
        setPhase("chat");
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const json = JSON.parse(raw);
            if (json.type === "content_block_delta" && json.delta?.text) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: m.content + json.delta.text } : m
              ));
            }
          } catch {}
        }
      }
    } catch (e: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: m.content || `Fehler: ${e.message}` } : m
      ));
    }

    setIsStreaming(false);
    setPhase("chat");
  };

  // ─── Free Chat ─────────────────────────────────────────────────

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    const userText = input.trim();
    setInput("");
    addMessage({ role: "user", content: userText });

    // Build full conversation for API
    const allMsgs = [...messages.filter(m => !m.interactive), { role: "user" as const, content: userText }]
      .map(m => ({ role: m.role, content: m.content }));

    const systemPrompt = buildAnnaSystemPrompt({
      budget, riskLevel, kellyFraction: ({ K: 0.25, M: 0.33, A: 0.5 } as any)[riskLevel] || 0.33,
      bankroll, leagueData: multiLeagueData,
    });

    await streamAnna(systemPrompt, allMsgs);
  };

  // ─── Render ────────────────────────────────────────────────────

  return (
    <AppShell>
      <style>{`
        .anna-container { display: flex; flex-direction: column; height: calc(100dvh - 80px); margin: -16px; margin-bottom: -80px; }
        .anna-messages { flex: 1; overflow-y: auto; padding: 16px; padding-bottom: 80px; }
        .anna-input-bar { position: fixed; bottom: 60px; left: 0; right: 0; max-width: 480px; margin: 0 auto; padding: 8px 12px; background: linear-gradient(to top, #0d0705 0%, #1a0f0aee 100%); border-top: 1px solid #c4a26518; z-index: 50; }
        @media (min-width: 768px) { .anna-input-bar { max-width: 640px; } }
        @media (min-width: 1024px) { .anna-input-bar { max-width: 720px; margin-left: 220px; } .anna-container { margin-bottom: 0; } }
      `}</style>

      <div className="anna-container">
        {/* Anna Header */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
          padding: "20px 16px 16px", borderBottom: "1px solid #c4a26515",
          background: "linear-gradient(to bottom, #1a0f0a, transparent)",
        }}>
          <button
            onClick={cycleAvatar}
            aria-label={`Anna Avatar — ${availableAvatars.length > 1 ? "Tippen zum Wechseln" : ""}`}
            style={{
              background: "none", border: "none", padding: 0, cursor: availableAvatars.length > 1 ? "pointer" : "default",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={currentAvatar}
              alt="Anna, KI-Wettberaterin"
              style={{
                width: 240, height: 240, borderRadius: "50%", objectFit: "cover",
                border: "3px solid #d4b86a50",
                boxShadow: "0 0 30px rgba(212,184,106,0.2)",
                transition: "transform 0.2s ease, box-shadow 0.2s ease",
              }}
              onMouseEnter={e => { if (availableAvatars.length > 1) { e.currentTarget.style.transform = "scale(1.03)"; e.currentTarget.style.boxShadow = "0 0 36px rgba(212,184,106,0.35)"; } }}
              onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 0 30px rgba(212,184,106,0.2)"; }}
            />
          </button>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#d4b86a", letterSpacing: 0.5 }}>Anna</div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#6aad55", boxShadow: "0 0 6px #6aad5580" }} />
            </div>
            <div style={{ fontSize: 11, color: "#c4a26560" }}>KI-Wettberaterin · FODZE</div>
            {availableAvatars.length > 1 && (
              <div style={{ fontSize: 8, color: "#c4a26535", marginTop: 3 }}>
                Tippe auf das Bild zum Wechseln · {avatarIdx + 1}/{availableAvatars.length}
              </div>
            )}
          </div>
        </div>

        <div className="anna-messages" ref={scrollRef} aria-live="polite" aria-label="Chat-Verlauf">
          {messages.map(msg => (
            <ChatMessage key={msg.id} role={msg.role} content={msg.content} isStreaming={isStreaming && msg === messages[messages.length - 1] && msg.role === "assistant"}>
              {/* Interactive elements */}
              {msg.interactive === "leagues" && phase === "leagues" && (
                <LeagueChips selected={selectedLeagues}
                  onToggle={k => setSelectedLeagues(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                  onConfirm={handleLeaguesConfirm} />
              )}
              {msg.interactive === "budget" && phase === "budget" && (
                <BudgetReplies onSelect={handleBudgetSelect} />
              )}
              {msg.interactive === "risk" && phase === "risk" && (
                <RiskReplies onSelect={handleRiskSelect} />
              )}
              {msg.betSuggestions && msg.betSuggestions.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {msg.betSuggestions.map((bet, i) => (
                    <BetCard key={i} bet={bet} />
                  ))}
                  <div style={{ fontSize: 10, color: "#c4a26570", textAlign: "center", marginTop: 8 }}>
                    Gesamteinsatz: €{msg.betSuggestions.reduce((s, b) => s + b.stake, 0).toFixed(0)} / €{budget}
                  </div>
                </div>
              )}
            </ChatMessage>
          ))}

          {/* Loading state */}
          {phase === "loading" && (
            <ChatMessage role="assistant" content="" isStreaming>
              {null}
            </ChatMessage>
          )}
        </div>

        {/* Input bar (visible in analysis + chat phase) */}
        {(phase === "analysis" || phase === "chat") && (
          <div className="anna-input-bar">
            <div style={{ display: "flex", gap: 8 }}>
              <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                aria-label="Nachricht an Anna eingeben"
                placeholder="Frage Anna..."
                rows={1}
                style={{
                  flex: 1, resize: "none", padding: "10px 14px", borderRadius: 20,
                  border: "1px solid #c4a26520", background: "#c4a2650a", color: "#ede4d4",
                  fontSize: 13, fontFamily: "inherit", outline: "none",
                }} />
              <button onClick={handleSend} disabled={isStreaming || !input.trim()}
                style={{
                  width: 40, height: 40, borderRadius: "50%", border: "none",
                  background: input.trim() ? "linear-gradient(135deg, #a68940, #d4b86a)" : "#c4a26515",
                  cursor: input.trim() ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s",
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={input.trim() ? "#1a0f0a" : "#c4a26540"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

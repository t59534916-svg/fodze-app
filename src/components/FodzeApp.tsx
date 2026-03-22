"use client";
import { useState, useCallback, useEffect, useMemo } from "react";
import { createClient, saveMatchday, loadLatestMatchday, saveOddsSnapshot, loadOddsHistory, deleteOddsHistory, loadProfile, updateProfile, saveBet, loadUserBets } from "@/lib/supabase";
import { LEAGUES, getHomeFactor, calculateBetsEnhanced, vigAdjustBest, analyzeLineMovement, validateXGData, calcMatchEnhanced, loadCalibrationCurves, isCalibrationActive, getCorrectScores, getHtFt, getAsianHandicap, getWinningMargin, getGoalBothHalves } from "@/lib/dixon-coles";
import ComboBuilder from "./ComboBuilder";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
const tsNow = () => new Date().toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

// ─── Leather + Shiny Gold Design Tokens ─────────────────────────────

const S = {
  page: {
    maxWidth: 480, margin: "0 auto" as const, padding: 16, minHeight: "100dvh",
    background: "radial-gradient(ellipse at 40% 20%, #2a1810 0%, #1a0f0a 50%, #0d0705 100%)",
    position: "relative" as const,
  },
  card: {
    background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10,
    padding: 14, marginBottom: 10, backdropFilter: "blur(4px)",
  },
  metric: {
    background: "#c4a26510", border: "1px solid #c4a26518", borderRadius: 8,
    padding: "8px 4px", textAlign: "center" as const,
  },
  goldBtn: {
    background: "linear-gradient(110deg, #a68940 0%, #d4b86a 25%, #f5e6b8 50%, #d4b86a 75%, #a68940 100%)",
    backgroundSize: "200% 100%", border: "none", borderRadius: 8, padding: 14,
    color: "#1a0f0a", fontSize: 14, fontWeight: 700 as const, cursor: "pointer",
    letterSpacing: "0.5px", width: "100%",
    animation: "goldShimmer 3s ease-in-out infinite",
  },
  outlineBtn: {
    background: "#c4a26510", border: "1px solid #c4a26530", borderRadius: 8,
    padding: "10px 16px", color: "#c4a265", cursor: "pointer", fontSize: 12,
  },
  lbl: { display: "block" as const, fontSize: 11, color: "#c4a26560", marginBottom: 3, letterSpacing: "0.5px" as const },
  goldText: {
    background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
  },
  tag: (c: string, bg: string): React.CSSProperties => ({
    display: "inline-block", fontSize: 9, fontWeight: 600, padding: "2px 6px",
    borderRadius: 4, marginRight: 3, background: bg, color: c,
  }),
  corner: (pos: string): React.CSSProperties => ({
    position: "absolute" as const, width: 22, height: 22, zIndex: 2,
    ...(pos === "tl" ? { top: 6, left: 6, borderTop: "2px solid #c4a26535", borderLeft: "2px solid #c4a26535", borderRadius: "4px 0 0 0" } :
      pos === "tr" ? { top: 6, right: 6, borderTop: "2px solid #c4a26535", borderRight: "2px solid #c4a26535", borderRadius: "0 4px 0 0" } :
      pos === "bl" ? { bottom: 6, left: 6, borderBottom: "2px solid #c4a26535", borderLeft: "2px solid #c4a26535", borderRadius: "0 0 0 4px" } :
      { bottom: 6, right: 6, borderBottom: "2px solid #c4a26535", borderRight: "2px solid #c4a26535", borderRadius: "0 0 4px 0" }),
  }),
};

// ─── Prompt Template ────────────────────────────────────────────────

const PROMPT_TEMPLATE = (league: string) => `Finde ALLE Spiele für den nächsten Spieltag in der ${league}.

Suche auf sofascore.com, fotmob.com, understat.com nach Fixtures und xG-Statistiken.
Suche auf transfermarkt.de nach Verletzungen und Sperren.

WICHTIG – xG-Daten EXAKT so liefern:
- xg_h8 = SUMME der xG die das HEIMTEAM in seinen letzten 8 HEIMSPIELEN ERZIELT hat (NICHT Durchschnitt, NUR Heimspiele)
- xga_h8 = SUMME der xGA die das HEIMTEAM in seinen letzten 8 HEIMSPIELEN KASSIERT hat
- xg_a8 = SUMME der xG die das AUSWÄRTSTEAM in seinen letzten 8 AUSWÄRTSSPIELEN ERZIELT hat
- xga_a8 = SUMME der xGA die das AUSWÄRTSTEAM in seinen letzten 8 AUSWÄRTSSPIELEN KASSIERT hat
- Erwartete Werte: Summen über 8 Spiele (5.0–20.0), NICHT Durchschnitte (0.8–2.5)

Beispiel: Bayern 8 Heimspiele xG: 2.1, 1.8, 3.2, 1.5, 2.4, 1.9, 2.7, 2.0 → xg_h8 = 17.6

KEINE Wettquoten. Antworte NUR als JSON:
{
  "league": "${league}",
  "matchday": "Spieltag XX",
  "date": "YYYY-MM-DD",
  "matches": [
    {
      "home": {"name": "Team A", "xg_h8": 12.5, "xga_h8": 7.2, "games": 8, "form": "W W D L W", "injuries": "Spieler (Verletzung)", "yellow_risk": "Spieler auf 4 Gelben", "notes": ""},
      "away": {"name": "Team B", "xg_a8": 9.0, "xga_a8": 11.5, "games": 8, "form": "L W W D W", "injuries": "", "yellow_risk": "", "notes": ""},
      "tags": ["DERBY"],
      "context": "Kurzer Kontext",
      "referee": "Name, Ø X Karten/Spiel",
      "kickoff": "15:30"
    }
  ],
  "data_confidence": "HIGH/MEDIUM/LOW",
  "sources": ["understat.com", "transfermarkt.de"]
}

NOCHMAL: xg_h8/xga_h8/xg_a8/xga_a8 sind SUMMEN (5.0–20.0), NICHT Durchschnitte.`;

const emptyMatch = () => ({
  home: { name: "", xg_h8: "", xga_h8: "", games: "8", form: "", injuries: "", yellow_risk: "", notes: "" },
  away: { name: "", xg_a8: "", xga_a8: "", games: "8", form: "", injuries: "", yellow_risk: "", notes: "" },
  tags: [] as string[], context: "", referee: "", kickoff: "",
});

// ─── Decorative Corners Component ───────────────────────────────────
const Corners = () => (<>
  <div style={S.corner("tl")} /><div style={S.corner("tr")} />
  <div style={S.corner("bl")} /><div style={S.corner("br")} />
  <div style={{ position: "absolute", inset: 6, border: "1px solid #c4a26510", borderRadius: 8, pointerEvents: "none" as const, zIndex: 1 }} />
</>);

// ─── Team Kit Colors ────────────────────────────────────────────────
const TEAM_COLORS: Record<string, [string, string]> = {
  // Bundesliga
  "Bayer 04 Leverkusen": ["#e32221", "#000"], "FC Bayern München": ["#dc052d", "#0066b2"],
  "Borussia Dortmund": ["#fde100", "#000"], "RB Leipzig": ["#dd0741", "#fff"],
  "SC Freiburg": ["#000", "#e2001a"], "VfB Stuttgart": ["#e32219", "#fff"],
  "Eintracht Frankfurt": ["#000", "#e1000f"], "1. FC Union Berlin": ["#eb1923", "#fce300"],
  "VfL Wolfsburg": ["#65b32e", "#fff"], "TSG Hoffenheim": ["#1961b5", "#fff"],
  "FC Augsburg": ["#ba3733", "#265e3a"], "SV Werder Bremen": ["#1d9053", "#fff"],
  "1. FC Heidenheim": ["#e30613", "#00427a"], "Borussia Mönchengladbach": ["#000", "#1db954"],
  "1. FSV Mainz 05": ["#c3141e", "#fff"], "FC St. Pauli": ["#6b3222", "#fff"],
  "Holstein Kiel": ["#003c8f", "#fff"], "VfL Bochum": ["#005ba5", "#fff"],
  // 2. Bundesliga
  "FC Schalke 04": ["#004d9d", "#fff"], "Fortuna Düsseldorf": ["#e4002b", "#fff"],
  "SC Paderborn 07": ["#005ca9", "#ffd700"], "Karlsruher SC": ["#003399", "#fff"],
  "1. FC Kaiserslautern": ["#e4002b", "#fff"], "Hertha BSC": ["#005daa", "#fff"],
  "Dynamo Dresden": ["#ffd700", "#000"], "1. FC Magdeburg": ["#004b87", "#fff"],
  "Arminia Bielefeld": ["#00326d", "#fff"], "SV Darmstadt 98": ["#004e9e", "#fff"],
  "SpVgg Greuther Fürth": ["#006a3a", "#fff"], "SV Elversberg": ["#fff", "#000"],
  // 3. Liga
  "MSV Duisburg": ["#003d7c", "#fff"], "TSV 1860 München": ["#00529c", "#fff"],
  "Rot-Weiss Essen": ["#e4002b", "#fff"], "FC Viktoria Köln": ["#000", "#e4002b"],
  "VfL Osnabrück": ["#4b0082", "#fff"], "Energie Cottbus": ["#e4002b", "#fff"],
  "Hansa Rostock": ["#003d7c", "#ff8c00"], "SV Waldhof Mannheim": ["#003d7c", "#000"],
  "Alemannia Aachen": ["#ffd700", "#000"], "1. FC Saarbrücken": ["#004b87", "#fff"],
  "Erzgebirge Aue": ["#4b0082", "#fff"], "SC Verl": ["#006633", "#fff"],
  "Preußen Münster": ["#006633", "#fff"], "SpVgg Unterhaching": ["#e4002b", "#fff"],
  "SSV Ulm 1846": ["#000", "#fff"], "Jahn Regensburg": ["#e4002b", "#fff"],
  "FC Ingolstadt 04": ["#e4002b", "#000"], "SV Wehen Wiesbaden": ["#e4002b", "#fff"],
  "TSG Hoffenheim II": ["#1961b5", "#fff"], "VfB Stuttgart II": ["#e32219", "#fff"],
  "1. FC Schweinfurt 05": ["#004b87", "#ffd700"], "TSV Havelse": ["#003d7c", "#fff"],
  // Premier League
  "Arsenal": ["#ef0107", "#fff"], "Liverpool": ["#c8102e", "#fff"],
  "Manchester City": ["#6cabdd", "#fff"], "Manchester United": ["#da291c", "#ffd700"],
  "Chelsea": ["#034694", "#fff"], "Tottenham Hotspur": ["#132257", "#fff"],
  "Newcastle United": ["#241f20", "#fff"], "Aston Villa": ["#670e36", "#95bfe5"],
  "Brighton & Hove Albion": ["#0057b8", "#fff"], "West Ham United": ["#7a263a", "#1bb1e7"],
  "Wolverhampton Wanderers": ["#fdb913", "#000"], "Bournemouth": ["#da291c", "#000"],
  "AFC Bournemouth": ["#da291c", "#000"],
  "Fulham": ["#fff", "#000"], "Crystal Palace": ["#1b458f", "#c4122e"],
  "Brentford": ["#e30613", "#fff"], "Everton": ["#003399", "#fff"],
  "Nottingham Forest": ["#dd0000", "#fff"], "Burnley": ["#6c1d45", "#87ceeb"],
  "Sunderland": ["#eb172b", "#fff"], "Leeds United": ["#fff", "#1d428a"],
  // La Liga
  "FC Barcelona": ["#a50044", "#004d98"], "Real Madrid": ["#fff", "#febe10"],
  "Atlético Madrid": ["#cb3524", "#272e61"], "Athletic Bilbao": ["#ee2523", "#fff"],
  "Athletic Club": ["#ee2523", "#fff"],
  "Real Sociedad": ["#003da5", "#fff"], "Real Betis": ["#00954c", "#fff"],
  "Rayo Vallecano": ["#fff", "#e4002b"], "RCD Mallorca": ["#e4002b", "#000"],
  "Celta Vigo": ["#8ebee5", "#fff"], "Espanyol Barcelona": ["#007fc3", "#fff"],
  "FC Getafe": ["#005999", "#fff"], "UD Levante": ["#004a9f", "#e4002b"],
  "FC Elche": ["#006633", "#fff"],
  // Serie A
  "Inter Milan": ["#009ee0", "#000"], "AC Milan": ["#fb090b", "#000"],
  "Juventus": ["#000", "#fff"], "Napoli": ["#009ee0", "#fff"],
  "Atalanta": ["#1e71b8", "#000"], "Roma": ["#8e1f2f", "#f0bc42"],
  "Lazio": ["#87d8f7", "#fff"], "Fiorentina": ["#482e92", "#fff"],
  "Bologna": ["#1a2f67", "#a52019"], "Torino": ["#8b0000", "#fff"],
  "Genoa": ["#a6093d", "#00387b"], "Lecce": ["#f8e500", "#e4002b"],
  "Udinese": ["#000", "#fff"], "Cagliari": ["#a6093d", "#003da5"],
  "Hellas Verona": ["#003da5", "#f0e130"], "US Sassuolo": ["#00a651", "#000"],
  "Cremonese": ["#da291c", "#777"], "Parma": ["#ffd700", "#004b87"],
  "Como 1907": ["#003da5", "#fff"], "AC Pisa 1909": ["#003da5", "#000"],
};

const Kit = ({ team, size = 16 }: { team: string; size?: number }) => {
  const [primary, secondary] = TEAM_COLORS[team] || ["#c4a26540", "#c4a26520"];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path d="M6 3L2 7v4l4-2v12h12V9l4 2V7l-4-4h-4c0 1.1-.9 2-2 2s-2-.9-2-2H6z"
        fill={primary} stroke={secondary} strokeWidth="1.2"/>
      <path d="M2 7l4-4M22 7l-4-4" stroke={secondary} strokeWidth="1" fill="none"/>
    </svg>
  );
};

// ─── Logo Component ─────────────────────────────────────────────────
const Logo = ({ size = 30 }: { size?: number }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", border: "1.5px solid #c4a26545",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "radial-gradient(circle, #c4a26510 0%, transparent 70%)",
    boxShadow: "0 0 16px #c4a26510" }}>
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 28 28">
      <defs><linearGradient id="gG" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#a68940"/><stop offset="40%" stopColor="#f5e6b8"/><stop offset="100%" stopColor="#a68940"/>
      </linearGradient></defs>
      <path d="M14 2L4 8v6c0 7.5 4.3 13.2 10 14 5.7-.8 10-6.5 10-14V8L14 2z" fill="none" stroke="url(#gG)" strokeWidth="1.5"/>
      <text x="14" y="19" textAnchor="middle" fill="url(#gG)" fontSize="13" fontWeight="700" fontFamily="Georgia,serif">O</text>
    </svg>
  </div>
);

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════

export default function FodzeApp({ user }: { user: any }) {
  const supabase = createClient();
  const [lg, setLg] = useState("bundesliga");
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [selectedMatch, setSelectedMatch] = useState<number | null>(null);
  const [profile, setProfile] = useState<any>({ risk_profile: "M", bankroll: 0, display_name: "" });
  const [step, setStep] = useState(0);
  const [oddsData, setOddsData] = useState<Record<number, any>>({});
  const [oddsHistory, setOddsHistory] = useState<Record<number, any[]>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [hasApi, setHasApi] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"import" | "auto" | "manual">("import");
  const [budget, setBudget] = useState("");
  const [jsonInput, setJsonInput] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [manualMatches, setManualMatches] = useState<any[]>([]);
  const [editingMatch, setEditingMatch] = useState<any>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Combo Builder state (lifted from ComboBuilder to persist across navigation)
  const [comboSelectedIds, setComboSelectedIds] = useState<Set<string>>(new Set());
  const [comboBankerIds, setComboBankerIds] = useState<Set<string>>(new Set());
  const [comboCustomLegs, setComboCustomLegs] = useState<any[]>([]);
  const [comboCustomCounter, setComboCustomCounter] = useState(0); // Bug 2: stable IDs
  const [comboSelectedSystem, setComboSelectedSystem] = useState<string | null>(null);

  // Top Tips & Analysis state
  const [tipSort, setTipSort] = useState<"ev"|"conf">("ev");
  const [showTips, setShowTips] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState<number|null>(null);
  const [marketsOpen, setMarketsOpen] = useState<number|null>(null);

  // Bet Tracking state
  const [userBets, setUserBets] = useState<any[]>([]);
  const [showBets, setShowBets] = useState(false);
  const [placingBet, setPlacingBet] = useState<string|null>(null);

  // Liga availability (which leagues have matchdays in DB)
  const [leagueStatus, setLeagueStatus] = useState<Record<string, { label: string; date: string } | null>>({});

  const ld = LEAGUES[lg];
  const frac = ({ K: 0.25, M: 0.33, A: 0.5 } as any)[profile.risk_profile] || 0.33;
  const totalBankroll = parseFloat(profile.bankroll) || 0;
  const dayBudget = parseFloat(budget) || 0;
  const br = dayBudget > 0 ? dayBudget : totalBankroll;

  // ── Isotonische Kalibrierungskurven laden (aus Backtest trainiert) ──
  useEffect(() => {
    fetch("/calibration_curves.json")
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(curves => {
        loadCalibrationCurves(curves);
        console.log("[FODZE] Isotonische Kalibrierung AKTIV (4 Kurven geladen)");
      })
      .catch(() => console.warn("[FODZE] calibration_curves.json nicht gefunden — Identity-Modus (raw P = calibrated P)"));
  }, []);

  useEffect(() => {
    loadProfile(supabase, user.id).then(p => { if (p) setProfile(p); });
    loadUserBets(supabase, user.id).then(b => setUserBets(b));
    fetch("/api/matchday").then(r => r.json()).then(d => setHasApi(d.hasKey === true)).catch(() => setHasApi(false));
    // Check which leagues have data
    (async () => {
      const status: Record<string, { label: string; date: string } | null> = {};
      for (const key of Object.keys(LEAGUES)) {
        const md = await loadLatestMatchday(supabase, key);
        status[key] = md ? { label: md.matchday_label || md.data?.matchday || "—", date: md.match_date || md.data?.date || "" } : null;
      }
      setLeagueStatus(status);
    })();
  }, [user.id]);

  const loadCached = useCallback(async () => {
    const cached = await loadLatestMatchday(supabase, lg);
    if (cached) {
      setData(cached.data); setStep(2);
      for (let i = 0; i < (cached.data.matches?.length || 0); i++) {
        const key = `${lg}:${cached.data.matches[i].home?.name}-${cached.data.matches[i].away?.name}`.toLowerCase().replace(/\s/g, "");
        const hist = await loadOddsHistory(supabase, key);
        if (hist.length > 0) { setOddsHistory(prev => ({ ...prev, [i]: hist })); setOddsData(prev => ({ ...prev, [i]: hist[hist.length - 1].odds })); }
      }
      return true;
    }
    return false;
  }, [lg]);

  const handleImport = useCallback(async () => {
    setImportError(null);
    try {
      const jsonMatch = jsonInput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Kein JSON gefunden.");
      const parsed = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
      if (!parsed.matches?.length) throw new Error("Keine Spiele im JSON.");
      await saveMatchday(supabase, lg, parsed.matchday || "Import", parsed, user.id);
      setData(parsed); setStep(2); setJsonInput("");
    } catch (e: any) { setImportError(e.message); }
  }, [jsonInput, lg, user.id]);

  const handleCopyPrompt = useCallback(() => {
    navigator.clipboard?.writeText(PROMPT_TEMPLATE(ld.name));
    setPromptCopied(true); setTimeout(() => setPromptCopied(false), 2000);
  }, [ld.name]);

  const doAutoFetch = useCallback(async () => {
    setLoading(true); setError(null); setStep(1); setOddsData({}); setOddsHistory({});
    const msgs = ["Suche Spieltag...", `Lade ${ld.name}...`, "Prüfe Verletzungen...", "Analysiere Kontext..."];
    let i = 0; const iv = setInterval(() => setLoadMsg(msgs[Math.min(i++, msgs.length - 1)]), 2500);
    try {
      const resp = await fetch("/api/matchday", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ league: ld.name }) });
      const result = await resp.json();
      if (result.error) throw new Error(result.message || result.error);
      await saveMatchday(supabase, lg, result.matchday, result, user.id);
      setData(result); setStep(2);
    } catch (e: any) { setError(e.message); setStep(0); }
    finally { clearInterval(iv); setLoading(false); }
  }, [lg, ld.name, user.id]);

  const handleAddManual = useCallback(() => {
    if (!editingMatch?.home?.name || !editingMatch?.away?.name) return;
    const m = { ...editingMatch,
      home: { ...editingMatch.home, xg_h8: parseFloat(editingMatch.home.xg_h8) || 0, xga_h8: parseFloat(editingMatch.home.xga_h8) || 0, games: parseInt(editingMatch.home.games) || 8 },
      away: { ...editingMatch.away, xg_a8: parseFloat(editingMatch.away.xg_a8) || 0, xga_a8: parseFloat(editingMatch.away.xga_a8) || 0, games: parseInt(editingMatch.away.games) || 8 } };
    setManualMatches(prev => [...prev, m]); setEditingMatch(null); setShowAddForm(false);
  }, [editingMatch]);

  const handleStartManual = useCallback(async () => {
    if (!manualMatches.length) return;
    const result = { league: ld.name, matchday: "Manuell", matches: manualMatches, data_confidence: "MANUAL", sources: ["Manuell"] };
    await saveMatchday(supabase, lg, "Manuell", result, user.id);
    setData(result); setStep(2);
  }, [manualMatches, lg, ld.name, user.id]);

  const handleSaveOdds = useCallback(async (idx: number) => {
    const o = oddsData[idx]; if (!o?.h && !o?.d && !o?.a) return;
    setSaving(idx);
    const match = data?.matches?.[idx];
    const key = `${lg}:${match?.home?.name}-${match?.away?.name}`.toLowerCase().replace(/\s/g, "");
    await saveOddsSnapshot(supabase, lg, key, match?.home?.name, match?.away?.name, o, user.id);
    const hist = await loadOddsHistory(supabase, key);
    setOddsHistory(prev => ({ ...prev, [idx]: hist })); setSaving(null);
  }, [oddsData, data, lg, user.id]);

  const handleDelHist = useCallback(async (idx: number) => {
    const match = data?.matches?.[idx];
    const key = `${lg}:${match?.home?.name}-${match?.away?.name}`.toLowerCase().replace(/\s/g, "");
    await deleteOddsHistory(supabase, key);
    setOddsHistory(prev => { const n = { ...prev }; delete n[idx]; return n; });
  }, [data, lg]);

  const setOdds = (idx: number, f: string, v: string) => setOddsData(prev => ({ ...prev, [idx]: { ...(prev[idx] || {}), [f]: v } }));

  const handlePlaceBet = useCallback(async (match: any, bet: any) => {
    const key = `${lg}:${match.home?.name}-${match.away?.name}`.toLowerCase().replace(/\s/g, "");
    setPlacingBet(bet.label);
    await saveBet(supabase, {
      match_key: key, home_team: match.home?.name, away_team: match.away?.name,
      market: bet.label, odds_placed: bet.quote, stake: bet.kelly * br,
      model_prob: bet.pModel, edge: bet.edge, result: "pending",
    }, user.id);
    const bets = await loadUserBets(supabase, user.id);
    setUserBets(bets);
    setPlacingBet(null);
  }, [lg, br, user.id]);
  const saveProf = async (f: string, v: any) => { setProfile((p: any) => ({ ...p, [f]: v })); await updateProfile(supabase, user.id, { [f]: v }); };

  function calcMatch(match: any, idx: number) {
    const h = match.home, a = match.away;
    if (!h?.xg_h8 || !a?.xg_a8) return null;
    const warnings = validateXGData(h.xg_h8, h.xga_h8, h.games || 8, a.xg_a8, a.xga_a8, a.games || 8, ld.avg);

    // Enhanced: regression to mean + form + tags + confidence intervals
    // Team-spezifischer Heimfaktor für 3. Liga (Fansupport-basiert)
    const matchHf = lg === "liga3" ? getHomeFactor(h.name, ld.hf) : ld.hf;
    const enh = calcMatchEnhanced(
      h.xg_h8, h.xga_h8, h.games || 8, h.form,
      a.xg_a8, a.xga_a8, a.games || 8, a.form,
      ld.avg, matchHf, match.tags || []
    );

    const o = oddsData[idx] || {};
    const no: Record<string, number> = {};
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) { const v = parseFloat(o[k]); if (v > 0) no[k] = v; }
    const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;
    const bets = calculateBetsEnhanced(enh.mk, enh.mk_low, enh.mk_high, no, frac);
    // Top exact scores from matrix
    const topScores: { s: string; p: number }[] = [];
    if (enh.matrix) {
      for (let i = 0; i <= 5; i++)
        for (let j = 0; j <= 5; j++)
          if (enh.matrix[i]?.[j] > 0.005) topScores.push({ s: `${i}:${j}`, p: enh.matrix[i][j] });
    }
    topScores.sort((a, b) => b.p - a.p);

    return {
      lambdaH: enh.lambdaH, lambdaA: enh.lambdaA,
      lambdaH_raw: enh.lambdaH_raw, lambdaA_raw: enh.lambdaA_raw,
      mk: enh.mk, bets, enh, topScores: topScores.slice(0, 5),
      ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
      hasValue: bets.some(b => b.isValue), hasOdds, warnings,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // SHARED: Process matches + build combo legs (MUST be before returns)
  // ═══════════════════════════════════════════════════════════════════
  const matches = data?.matches || [];
  const processed = useMemo(() =>
    matches.map((m: any, i: number) => ({ ...m, idx: i, calc: calcMatch(m, i) })),
    [data, oddsData, frac, ld.avg, ld.hf]
  );
  const valueMatches = useMemo(() => processed.filter((m: any) => m.calc?.hasValue), [processed]);
  const totalStake = useMemo(() => valueMatches.reduce((sum: number, m: any) => sum + m.calc.bets.filter((b: any) => b.isValue).reduce((s: number, b: any) => s + b.kelly * br, 0), 0), [valueMatches, br]);

  // Top 5 Tipps — all value bets sorted by EV or confidence
  const topTips = useMemo(() => {
    const tips: any[] = [];
    for (const m of processed) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (!b.isValue || b.edge <= 0) continue;
        tips.push({ ...b, home: m.home?.name, away: m.away?.name, matchIdx: m.idx, kickoff: m.kickoff });
      }
    }
    if (tipSort === "ev") tips.sort((a, b) => (b.ev || b.edge) - (a.ev || a.edge));
    else tips.sort((a, b) => {
      const confOrder: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return (confOrder[b.confidence] || 0) - (confOrder[a.confidence] || 0) || (b.ev || b.edge) - (a.ev || a.edge);
    });
    return tips.slice(0, 5);
  }, [processed, tipSort]);

  const comboLegs = useMemo(() => {
    const legs: any[] = [];
    for (const m of processed) {
      if (!m.calc?.bets) continue;
      for (const b of m.calc.bets) {
        if (b.quote <= 0) continue;
        legs.push({
          id: `${m.idx}-${b.label}`,
          label: `${b.label} ${m.home?.name?.split(" ").pop() || ""}–${m.away?.name?.split(" ").pop() || ""}`,
          match: `${m.home?.name} — ${m.away?.name}`,
          pModel: b.pModel,
          quote: b.quote,
          isValue: b.isValue,
        });
      }
    }
    return legs;
  }, [processed]);

  // ═══════════════════════════════════════════════════════════════════
  // STEP 0: HOME
  // ═══════════════════════════════════════════════════════════════════
  if (step === 0) return (
    <div style={S.page}>
      <Corners />
      <div style={{ position: "relative", zIndex: 3 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Logo size={36} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 2, fontFamily: "Georgia,serif", ...S.goldText }}>FODZE</div>
              <div style={{ fontSize: 7, color: "#c4a26530", letterSpacing: 0.5, marginTop: -1 }}>Fußball orientierte Datenbank zur Erwartungswertsteigerung</div>
              <div style={{ fontSize: 10, color: "#c4a26550" }}>
                {profile.display_name || user.email?.split("@")[0]}
                {isCalibrationActive() && <span style={{ ...S.tag("#6aad55", "#5a8c4a15"), marginLeft: 6 }}>Kalibrierung aktiv</span>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <a href="/workflow" style={{ ...S.outlineBtn, textDecoration: "none", fontSize: 10 }}>Workflow</a>
            <button onClick={() => supabase.auth.signOut()} style={S.outlineBtn}>Logout</button>
          </div>
        </div>

        {/* Settings */}
        <div style={S.card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26550", letterSpacing: 1 }}>BANKROLL</div><div style={{ fontSize: 16, fontWeight: 600, color: "#ede4d4" }}>€{totalBankroll || "—"}</div></div>
            <div style={{ ...S.metric, borderColor: "#c4a26530" }}><div style={{ fontSize: 8, color: "#c4a26550", letterSpacing: 1 }}>BUDGET</div>
              <input type="number" value={budget} onChange={e => setBudget(e.target.value)} placeholder="—"
                style={{ background: "transparent", border: "none", textAlign: "center" as const, fontSize: 16, fontWeight: 600, color: "#d4b86a", width: "100%", padding: 0 }} />
            </div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26550", letterSpacing: 1 }}>RISIKO</div><div style={{ fontSize: 16, fontWeight: 600, color: "#ede4d4" }}>{({K:"¼ K",M:"⅓ K",A:"½ K"} as any)[profile.risk_profile]}</div></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div><label style={S.lbl}>Bankroll €</label><input type="number" value={profile.bankroll || ""} placeholder="500" onChange={e => saveProf("bankroll", parseFloat(e.target.value) || 0)} /></div>
            <div><label style={S.lbl}>Risikoprofil</label><select value={profile.risk_profile} onChange={e => saveProf("risk_profile", e.target.value)}><option value="K">Konservativ</option><option value="M">Moderat</option><option value="A">Aggressiv</option></select></div>
          </div>
        </div>

        {/* Liga Grid */}
        <div style={{ ...S.card, padding: 12 }}>
          <div style={{ fontSize: 9, color: "#c4a26550", letterSpacing: 1, marginBottom: 8 }}>LIGA WÄHLEN</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {Object.entries(LEAGUES).map(([key, val]) => {
              const info = leagueStatus[key];
              const hasData = !!info;
              const isSelected = lg === key;
              const flag: Record<string, string> = { bundesliga: "🇩🇪", bundesliga2: "🇩🇪", liga3: "🇩🇪", epl: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", la_liga: "🇪🇸", serie_a: "🇮🇹", ligue_1: "🇫🇷", championship: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", eredivisie: "🇳🇱", cl: "🏆", el: "🏆", pokal: "🏆" };
              return (
                <div key={key} onClick={() => setLg(key)}
                  style={{ padding: "10px 10px", borderRadius: 8, cursor: "pointer", transition: "all 0.2s",
                    border: isSelected ? "1.5px solid #d4b86a" : "1px solid #c4a26515",
                    background: isSelected ? "#c4a26512" : "#0d070530" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 16 }}>{flag[key] || "⚽"}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: hasData ? "#d4b86a" : "#c4a26535" }}>{val.name}</div>
                      {hasData ? (
                        <div style={{ fontSize: 9, color: "#c4a26550" }}>{info.label} · {info.date}</div>
                      ) : (
                        <div style={{ fontSize: 9, color: "#c4a26525" }}>Keine Daten</div>
                      )}
                    </div>
                    {hasData && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6aad55" }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Mode Toggle */}
        <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #c4a26520", marginBottom: 12 }}>
          {(["import", "manual", "auto"] as const).map(k => (
            <button key={k} onClick={() => setMode(k)} disabled={k === "auto" && !hasApi}
              style={{ flex: 1, padding: "11px 4px", fontSize: 11, fontWeight: 600, border: "none",
                cursor: k === "auto" && !hasApi ? "not-allowed" : "pointer", letterSpacing: 0.5,
                background: mode === k ? "linear-gradient(110deg, #a68940, #d4b86a, #f5e6b8, #d4b86a, #a68940)" : "#c4a26508",
                backgroundSize: mode === k ? "200% 100%" : undefined,
                animation: mode === k ? "goldShimmer 3s ease-in-out infinite" : undefined,
                color: mode === k ? "#1a0f0a" : (k === "auto" && !hasApi ? "#c4a26520" : "#c4a26560") }}>
              {k === "import" ? "EINFÜGEN" : k === "manual" ? "MANUELL" : "KI-AUTO"}
            </button>
          ))}
        </div>

        {/* Import Mode */}
        {mode === "import" && (
          <div style={{ border: "1px dashed #c4a26525", borderRadius: 10, padding: 16 }}>
            <div style={{ color: "#c4a26570", fontSize: 11, marginBottom: 10, lineHeight: 1.6, textAlign: "center" as const }}>
              Prompt kopieren → In Gemini/Claude einfügen → Antwort hier einfügen
            </div>
            <button onClick={handleCopyPrompt}
              style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, marginBottom: 10, fontWeight: 600,
                background: promptCopied ? "#5a8c4a15" : "#c4a26510",
                color: promptCopied ? "#6aad55" : "#c4a265",
                border: promptCopied ? "1px solid #6aad5530" : "1px solid #c4a26530" }}>
              {promptCopied ? "✓ Kopiert!" : `Prompt für ${ld.name} kopieren`}
            </button>
            <textarea value={jsonInput} onChange={e => setJsonInput(e.target.value)} rows={6}
              placeholder="JSON-Antwort hier einfügen..."
              style={{ fontFamily: "monospace", fontSize: 11, resize: "vertical" as const, marginBottom: 10 }} />
            {importError && <div style={{ padding: 8, borderRadius: 8, background: "#8c4a4a18", color: "#c47070", fontSize: 12, marginBottom: 10 }}>{importError}</div>}
            <button onClick={handleImport} disabled={!jsonInput.trim()}
              style={{ ...S.goldBtn, opacity: jsonInput.trim() ? 1 : 0.3 }}>
              SPIELTAG IMPORTIEREN
            </button>
          </div>
        )}

        {/* Auto Mode */}
        {mode === "auto" && hasApi && (
          <button onClick={doAutoFetch} style={S.goldBtn}>{ld.name.toUpperCase()} AUTOMATISCH LADEN</button>
        )}

        {/* Manual Mode */}
        {mode === "manual" && (
          <div>
            <div style={{ border: "1px solid #c4a26520", borderRadius: 10, padding: 12, marginBottom: 10, fontSize: 11, color: "#c4a26560", lineHeight: 1.6 }}>
              Spiele einzeln hinzufügen. xG-Daten: <span style={{ color: "#d4b86a" }}>understat.com</span>, <span style={{ color: "#d4b86a" }}>FotMob</span>, <span style={{ color: "#d4b86a" }}>SofaScore</span>
            </div>
            {manualMatches.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #c4a26515" }}>
                <div><div style={{ fontSize: 13, fontWeight: 500, color: "#ede4d4" }}>{m.home.name} — {m.away.name}</div></div>
                <button onClick={() => setManualMatches(prev => prev.filter((_, j) => j !== i))} style={{ background: "#8c4a4a18", color: "#c47070", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
            ))}
            {showAddForm && editingMatch ? (
              <div style={{ ...S.card, marginTop: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <div><label style={S.lbl}>Heim *</label><input value={editingMatch.home.name} placeholder="Bayern" onChange={e => setEditingMatch({...editingMatch, home: {...editingMatch.home, name: e.target.value}})} /></div>
                  <div><label style={S.lbl}>Auswärts *</label><input value={editingMatch.away.name} placeholder="Dortmund" onChange={e => setEditingMatch({...editingMatch, away: {...editingMatch.away, name: e.target.value}})} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <div><label style={S.lbl}>H xG *</label><input type="number" step="0.1" value={editingMatch.home.xg_h8} placeholder="14.2" onChange={e => setEditingMatch({...editingMatch, home: {...editingMatch.home, xg_h8: e.target.value}})} /></div>
                  <div><label style={S.lbl}>H xGA *</label><input type="number" step="0.1" value={editingMatch.home.xga_h8} placeholder="8.5" onChange={e => setEditingMatch({...editingMatch, home: {...editingMatch.home, xga_h8: e.target.value}})} /></div>
                  <div><label style={S.lbl}>Spiele</label><input type="number" value={editingMatch.home.games} onChange={e => setEditingMatch({...editingMatch, home: {...editingMatch.home, games: e.target.value}})} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div><label style={S.lbl}>A xG *</label><input type="number" step="0.1" value={editingMatch.away.xg_a8} placeholder="10.8" onChange={e => setEditingMatch({...editingMatch, away: {...editingMatch.away, xg_a8: e.target.value}})} /></div>
                  <div><label style={S.lbl}>A xGA *</label><input type="number" step="0.1" value={editingMatch.away.xga_a8} placeholder="12.1" onChange={e => setEditingMatch({...editingMatch, away: {...editingMatch.away, xga_a8: e.target.value}})} /></div>
                  <div><label style={S.lbl}>Spiele</label><input type="number" value={editingMatch.away.games} onChange={e => setEditingMatch({...editingMatch, away: {...editingMatch.away, games: e.target.value}})} /></div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleAddManual} style={{ ...S.goldBtn, flex: 1, opacity: editingMatch.home.name && editingMatch.away.name ? 1 : 0.3 }}>HINZUFÜGEN</button>
                  <button onClick={() => { setShowAddForm(false); setEditingMatch(null); }} style={S.outlineBtn}>Abb.</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => { setShowAddForm(true); setEditingMatch(emptyMatch()); }} style={{ ...S.outlineBtn, flex: 1, textAlign: "center" as const }}>+ Spiel</button>
                {manualMatches.length > 0 && <button onClick={handleStartManual} style={{ ...S.goldBtn, flex: 1 }}>ANALYSIEREN</button>}
              </div>
            )}
          </div>
        )}

        {/* Cached */}
        <button onClick={loadCached} style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, marginTop: 10 }}>
          Gespeicherten Spieltag laden
        </button>

        {error && <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "#8c4a4a18", color: "#c47070", fontSize: 12 }}>{error}</div>}
        <div style={{ fontSize: 9, color: "#c4a26525", textAlign: "center" as const, marginTop: 20, letterSpacing: 0.5 }}>Sportwetten = Glücksspiel · spielen-mit-verantwortung.de</div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: LOADING
  // ═══════════════════════════════════════════════════════════════════
  if (step === 1) return (
    <div style={{ ...S.page, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Corners />
      <div style={{ textAlign: "center" as const, position: "relative" as const, zIndex: 3 }}>
        <div style={{ fontSize: 36, display: "inline-block", animation: "spin 1.5s linear infinite", marginBottom: 16, filter: "sepia(1) saturate(2) hue-rotate(-10deg) brightness(0.9)" }}>⚽</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, ...S.goldText }}>{ld.name}</div>
        <div style={{ fontSize: 13, color: "#c4a26560", animation: "pulse 2s ease-in-out infinite" }}>{loadMsg || "Starte..."}</div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: COMBO BUILDER
  // ═══════════════════════════════════════════════════════════════════
  if (step === 3) return (
    <div style={S.page}>
      <Corners />
      <div style={{ position: "relative", zIndex: 3 }}>
        <ComboBuilder
          availableLegs={comboLegs}
          budget={br}
          onBack={() => setStep(2)}
          selectedIds={comboSelectedIds}
          setSelectedIds={setComboSelectedIds}
          bankerIds={comboBankerIds}
          setBankerIds={setComboBankerIds}
          customLegs={comboCustomLegs}
          setCustomLegs={setComboCustomLegs}
          customCounter={comboCustomCounter}
          setCustomCounter={setComboCustomCounter}
          selectedSystem={comboSelectedSystem}
          setSelectedSystem={setComboSelectedSystem}
        />
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: RESULTS
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div style={S.page}>
      <Corners />
      <div style={{ position: "relative", zIndex: 3 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, ...S.goldText }}>{data?.league} — {data?.matchday}</div>
            <div style={{ fontSize: 10, color: "#c4a26540" }}>{matches.length} Spiele · {data?.data_confidence}</div>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {br > 0 && <div style={{ border: "1px solid #c4a26520", borderRadius: 6, padding: "3px 8px" }}>
              <span style={{ fontSize: 8, color: "#c4a26540" }}>BDG </span>
              <input type="number" value={budget} onChange={e => setBudget(e.target.value)} placeholder={String(totalBankroll || "—")}
                style={{ background: "transparent", border: "none", width: 48, fontSize: 12, fontWeight: 600, color: "#d4b86a", padding: 0, textAlign: "right" as const }} />
            </div>}
            <button onClick={() => { setStep(0); setData(null); setSelectedMatch(null); setOddsData({}); setOddsHistory({}); }} style={S.outlineBtn}>←</button>
          </div>
        </div>

        {/* Budget Bar */}
        {br > 0 && (
          <div style={{ ...S.card, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 9, color: "#c4a26550" }}>
              <span>Einsatz €{totalStake.toFixed(0)}</span>
              <span style={{ color: "#6aad55" }}>Frei €{Math.max(0, br - totalStake).toFixed(0)}</span>
              <span style={{ color: totalStake / br > 0.15 ? "#c47070" : "#c4a265" }}>{pc(totalStake / br)}</span>
            </div>
            <div style={{ height: 3, borderRadius: 2, background: "#c4a26510" }}>
              <div style={{ height: "100%", borderRadius: 2, width: `${Math.min((totalStake / br) / 0.15 * 100, 100)}%`,
                background: totalStake / br > 0.15 ? "#c47070" : "linear-gradient(90deg, #a68940, #f5e6b8, #a68940)",
                backgroundSize: "200% 100%", animation: "goldShimmer 4s ease-in-out infinite", transition: "width 0.3s" }} />
            </div>
          </div>
        )}

        {/* Top 5 Tipps */}
        {topTips.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div onClick={() => setShowTips(!showTips)}
              style={{ ...S.card, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
                background: "linear-gradient(135deg, #5a8c4a10, #c4a26508)", border: "1px solid #6aad5525" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>🏆</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>TOP {topTips.length} TIPPS</span>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button onClick={e => { e.stopPropagation(); setTipSort("ev"); }}
                  style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "ev" ? "#6aad5520" : "transparent", color: tipSort === "ev" ? "#6aad55" : "#c4a26550" }}>EV</button>
                <button onClick={e => { e.stopPropagation(); setTipSort("conf"); }}
                  style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "conf" ? "#d4b86a20" : "transparent", color: tipSort === "conf" ? "#d4b86a" : "#c4a26550" }}>Konfidenz</button>
                <span style={{ color: "#c4a26535", fontSize: 14 }}>{showTips ? "▾" : "▸"}</span>
              </div>
            </div>
            {showTips && (
              <div style={{ ...S.card, marginTop: -1, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                {topTips.map((tip, ti) => {
                  const confColor = tip.confidence === "HIGH" ? "#6aad55" : tip.confidence === "MEDIUM" ? "#d4b86a" : "#c4a265";
                  return (
                    <div key={ti} onClick={() => { setSelectedMatch(tip.matchIdx); setShowTips(false); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", cursor: "pointer",
                        borderBottom: ti < topTips.length - 1 ? "1px solid #c4a26510" : "none" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#d4b86a", width: 16 }}>#{ti + 1}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                          <Kit team={tip.home} size={12} />
                          <span style={{ color: "#ede4d4" }}>{tip.home?.split(" ").pop()}</span>
                          <span style={{ color: "#c4a26530" }}>–</span>
                          <Kit team={tip.away} size={12} />
                          <span style={{ color: "#ede4d4" }}>{tip.away?.split(" ").pop()}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#c4a26550", marginTop: 2 }}>
                          {tip.label} · Edge {pe(tip.edge)} · Quote {tip.quote.toFixed(2)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" as const }}>
                        <div style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontWeight: 600,
                          background: confColor + "18", color: confColor }}>{tip.confidence}</div>
                        {br > 0 && <div style={{ fontSize: 10, color: "#6aad55", marginTop: 2 }}>€{(tip.kelly * br).toFixed(0)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Match List */}
        <div style={S.card}>
          {processed.map((m: any, i: number) => {
            const c = m.calc, isOpen = selectedMatch === i, o = oddsData[i] || {}, hist = oddsHistory[i] || [], movement = analyzeLineMovement(hist);
            return (<div key={i}>
              {/* Row */}
              <div onClick={() => setSelectedMatch(isOpen ? null : i)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "11px 0", cursor: "pointer",
                  borderBottom: i < processed.length - 1 ? "1px solid #c4a26510" : "none" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#ede4d4", display: "flex", alignItems: "center", gap: 5 }}>
                    <Kit team={m.home?.name} size={14} />
                    {m.home?.name}
                    <span style={{ color: "#c4a26530", margin: "0 2px" }}>—</span>
                    <Kit team={m.away?.name} size={14} />
                    {m.away?.name}
                    {m.kickoff && <span style={{ color: "#c4a26540", fontSize: 10 }}> {m.kickoff}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 3, marginTop: 3, flexWrap: "wrap" as const }}>
                    {m.tags?.map((t: string) => <span key={t} style={S.tag("#c4a265", "#c4a26520")}>{t}</span>)}
                    {c?.warnings?.some((w: any) => w.level === "error") && <span style={S.tag("#c47070", "#8c4a4a18")}>xG!</span>}
                    {movement && <span style={S.tag("#c47070", "#8c4a4a18")}>Line!</span>}
                    {c?.hasValue && <span style={S.tag("#6aad55", "#5a8c4a15")}>VALUE</span>}
                    {hist.length > 0 && <span style={S.tag("#c4a26570", "#c4a26510")}>{hist.length}x</span>}
                  </div>
                </div>
                <div style={{ textAlign: "right" as const, fontSize: 10, color: "#c4a26550", minWidth: 52 }}>
                  {c && <><div>{c.lambdaH.toFixed(2)}–{c.lambdaA.toFixed(2)}</div><div style={{ fontSize: 9 }}>{pc(c.mk.H)}/{pc(c.mk.D)}/{pc(c.mk.A)}</div></>}
                </div>
                <span style={{ color: "#c4a26535", width: 14, fontSize: 14 }}>{isOpen ? "▾" : "▸"}</span>
              </div>

              {/* Expanded Detail */}
              {isOpen && (<div style={{ padding: "12px 0" }}>
                {m.context && <div style={{ fontSize: 11, color: "#c4a26555", marginBottom: 8, lineHeight: 1.5 }}>{m.context}</div>}

                {/* Teams */}
                {[{t:m.home,r:"H",cl:"#d4b86a",xk:"xg_h8",xak:"xga_h8"},{t:m.away,r:"A",cl:"#c47070",xk:"xg_a8",xak:"xga_a8"}].map(({t,r,cl,xk,xak}:any) => t && (
                  <div key={r} style={{ padding: "5px 0", borderBottom: "1px solid #c4a26510", fontSize: 11, display: "flex", gap: 6 }}>
                    <Kit team={t.name} size={18} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 500, color: "#ede4d4" }}>{t.name}</span>
                      <span style={{ fontWeight: 700, color: cl, fontSize: 9, marginLeft: 4 }}>({r})</span>
                      {t[xk]>0&&<span style={{color:"#c4a26550"}}> · xG {(t[xk]/(t.games||8)).toFixed(2)}/Sp · xGA {(t[xak]/(t.games||8)).toFixed(2)}/Sp</span>}
                      {t.form&&<span style={{color:"#c4a26550"}}> · {t.form}</span>}
                      {t.injuries&&t.injuries!=="None"&&<div style={{color:"#c47070",fontSize:10}}>Ausfälle: {t.injuries}</div>}
                      {t.yellow_risk&&<div style={{color:"#c4a265",fontSize:10}}>Gelb: {t.yellow_risk}</div>}
                    </div>
                  </div>
                ))}

                {/* Lambdas + Enhanced Info */}
                {c && <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5, margin: "10px 0" }}>
                    {[["λ H",c.lambdaH.toFixed(2)],["λ A",c.lambdaA.toFixed(2)],["Ü2.5",pc(c.mk.O25)],["TOP",c.mk.best]].map(([l,v]:any) => (
                      <div key={l} style={S.metric}><div style={{fontSize:8,color:"#c4a26540",letterSpacing:0.5}}>{l}</div><div style={{fontSize:14,fontWeight:600,color:l==="TOP"?"#d4b86a":"#ede4d4"}}>{v}</div></div>
                    ))}
                  </div>

                  {/* Top Ergebnisse */}
                  {c.topScores?.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 9, color: "#c4a26550", letterSpacing: 0.5, marginBottom: 4 }}>WAHRSCHEINLICHSTE ERGEBNISSE</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                        {c.topScores.map((sc: any, si: number) => {
                          const [hGoals, aGoals] = sc.s.split(":").map(Number);
                          const isHome = hGoals > aGoals, isDraw = hGoals === aGoals;
                          return (
                            <div key={si} style={{ background: si === 0 ? "#c4a26515" : "#0d070533", border: `1px solid ${si === 0 ? "#c4a26530" : "#c4a26515"}`,
                              borderRadius: 6, padding: "4px 8px", textAlign: "center" as const, minWidth: 44 }}>
                              <div style={{ fontSize: 14, fontWeight: 700, color: si === 0 ? "#d4b86a" : "#ede4d4", letterSpacing: 1 }}>{sc.s}</div>
                              <div style={{ fontSize: 9, color: si === 0 ? "#d4b86a" : "#c4a26550" }}>{pc(sc.p)}</div>
                              <div style={{ fontSize: 7, color: isHome ? "#6aad55" : isDraw ? "#c4a265" : "#c47070", fontWeight: 600 }}>
                                {isHome ? "H" : isDraw ? "X" : "A"}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Analyse Button */}
                  {(m.context || m.home?.injuries || m.away?.injuries) && (
                    <button onClick={() => setAnalysisOpen(analysisOpen === i ? null : i)}
                      style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, fontSize: 10, marginBottom: 8,
                        background: analysisOpen === i ? "#c4a26510" : "transparent", fontWeight: 600 }}>
                      {analysisOpen === i ? "▾ ANALYSE AUSBLENDEN" : "▸ DETAILLIERTE ANALYSE"}
                    </button>
                  )}
                  {analysisOpen === i && (
                    <div style={{ padding: "10px 12px", borderRadius: 8, background: "#c4a26508", border: "1px solid #c4a26512", marginBottom: 8, fontSize: 11, lineHeight: 1.6 }}>
                      <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 6, fontSize: 10, letterSpacing: 0.5 }}>SPIELANALYSE</div>
                      {m.context && <div style={{ color: "#c4a26570", marginBottom: 6 }}>📋 {m.context}</div>}
                      {m.home?.injuries && m.home.injuries !== "Keine bekannt" && m.home.injuries !== "None" && (
                        <div style={{ marginBottom: 4 }}><Kit team={m.home.name} size={12} /> <span style={{ color: "#c47070" }}>Ausfälle {m.home.name}:</span> <span style={{ color: "#c4a26560" }}>{m.home.injuries}</span></div>
                      )}
                      {m.away?.injuries && m.away.injuries !== "Keine bekannt" && m.away.injuries !== "None" && (
                        <div style={{ marginBottom: 4 }}><Kit team={m.away.name} size={12} /> <span style={{ color: "#c47070" }}>Ausfälle {m.away.name}:</span> <span style={{ color: "#c4a26560" }}>{m.away.injuries}</span></div>
                      )}
                      {m.home?.yellow_risk && <div style={{ color: "#c4a265", fontSize: 10 }}>⚠ Gelbgefährdete H: {m.home.yellow_risk}</div>}
                      {m.away?.yellow_risk && <div style={{ color: "#c4a265", fontSize: 10 }}>⚠ Gelbgefährdete A: {m.away.yellow_risk}</div>}
                      {m.referee && <div style={{ color: "#c4a26550", fontSize: 10 }}>🏁 Schiedsrichter: {m.referee}</div>}
                      <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#0d070533" }}>
                        <div style={{ fontSize: 9, color: "#c4a26540", marginBottom: 4 }}>MODELL-EINSCHÄTZUNG</div>
                        <div style={{ color: "#ede4d4", fontSize: 11 }}>
                          {c.mk.H > 0.55 ? `${m.home?.name} klarer Favorit (${pc(c.mk.H)}).` :
                           c.mk.A > 0.55 ? `${m.away?.name} klarer Favorit (${pc(c.mk.A)}).` :
                           c.mk.H > 0.42 ? `${m.home?.name} leichter Favorit, offenes Spiel.` :
                           c.mk.A > 0.42 ? `${m.away?.name} leichter Favorit, offenes Spiel.` :
                           "Ausgeglichenes Spiel, kein klarer Favorit."}
                          {c.mk.O25 > 0.6 ? ` Torreich erwartet (Ü2.5: ${pc(c.mk.O25)}).` :
                           c.mk.O25 < 0.4 ? ` Wenig Tore erwartet (Ü2.5: ${pc(c.mk.O25)}).` : ""}
                          {c.topScores?.[0] && ` Wahrscheinlichstes Ergebnis: ${c.topScores[0].s} (${pc(c.topScores[0].p)}).`}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Adjustments Applied */}
                  {c.enh && (
                    <div style={{ fontSize: 10, marginBottom: 8, padding: "8px 10px", borderRadius: 8, background: "#c4a26508", border: "1px solid #c4a26512" }}>
                      <div style={{ color: "#c4a26555", marginBottom: 4, fontWeight: 600, fontSize: 9, letterSpacing: 0.5 }}>ANPASSUNGEN</div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, marginBottom: 4 }}>
                        <span style={{ color: "#c4a26550" }}>Regression: λ {c.lambdaH_raw?.toFixed(2)}→{c.enh.lambdaH_regressed.toFixed(2)} ({(c.enh.shrinkageH * 100).toFixed(0)}% Daten)</span>
                      </div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, marginBottom: 4 }}>
                        <span style={{ color: c.enh.formH.mult >= 1.02 ? "#6aad55" : c.enh.formH.mult <= 0.98 ? "#c47070" : "#c4a26550" }}>
                          Form H: {c.enh.formH.label} ({c.enh.formH.mult.toFixed(3)}×)
                        </span>
                        <span style={{ color: c.enh.formA.mult >= 1.02 ? "#6aad55" : c.enh.formA.mult <= 0.98 ? "#c47070" : "#c4a26550" }}>
                          Form A: {c.enh.formA.label} ({c.enh.formA.mult.toFixed(3)}×)
                        </span>
                      </div>
                      {c.enh.tagCorrections.length > 0 && (
                        <div>
                          {c.enh.tagCorrections.map((tc: any, ti: number) => (
                            <div key={ti} style={{ color: "#d4b86a", fontSize: 9 }}>{tc.reason}</div>
                          ))}
                        </div>
                      )}
                      <div style={{ color: "#c4a26535", fontSize: 9, marginTop: 4 }}>
                        90% CI: λH {c.enh.ciH.low.toFixed(2)}–{c.enh.ciH.high.toFixed(2)} · λA {c.enh.ciA.low.toFixed(2)}–{c.enh.ciA.high.toFixed(2)}
                      </div>
                    </div>
                  )}

                  {/* Extended Markets */}
                  <button onClick={() => setMarketsOpen(marketsOpen === i ? null : i)}
                    style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, fontSize: 10, marginBottom: 8, fontWeight: 600 }}>
                    {marketsOpen === i ? "▾ MÄRKTE AUSBLENDEN" : "▸ ERWEITERTE MÄRKTE"}
                  </button>
                  {marketsOpen === i && c.enh?.matrix && (() => {
                    const mx = c.enh.matrix;
                    const scores = getCorrectScores(mx, 8);
                    const htft = getHtFt(c.lambdaH, c.lambdaA);
                    const margin = getWinningMargin(mx);
                    const gbh = getGoalBothHalves(c.lambdaH, c.lambdaA);
                    return (
                      <div style={{ padding: "10px 12px", borderRadius: 8, background: "#c4a26508", border: "1px solid #c4a26512", marginBottom: 8, fontSize: 10 }}>
                        {/* Correct Scores */}
                        <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>EXAKTE ERGEBNISSE</div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 10 }}>
                          {scores.map((sc: any, si: number) => (
                            <div key={si} style={{ background: si < 3 ? "#c4a26512" : "#0d070533", border: "1px solid #c4a26515", borderRadius: 5, padding: "3px 6px", textAlign: "center" as const, minWidth: 38 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: si === 0 ? "#d4b86a" : "#ede4d4" }}>{sc.score}</div>
                              <div style={{ fontSize: 8, color: "#c4a26550" }}>{pc(sc.p)} · {(1/sc.p).toFixed(1)}</div>
                            </div>
                          ))}
                        </div>

                        {/* HT/FT */}
                        <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>HALBZEIT / ENDSTAND</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 10 }}>
                          {Object.entries(htft).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => (
                            <div key={k} style={{ background: "#0d070533", border: "1px solid #c4a26515", borderRadius: 4, padding: "3px 4px", textAlign: "center" as const }}>
                              <div style={{ fontSize: 10, fontWeight: 500, color: "#ede4d4" }}>{k}</div>
                              <div style={{ fontSize: 8, color: "#c4a26550" }}>{pc(v)} · {(1/v).toFixed(2)}</div>
                            </div>
                          ))}
                        </div>

                        {/* Winning Margin */}
                        <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>SIEGMARGE</div>
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" as const, marginBottom: 10 }}>
                          {Object.entries(margin).map(([k, v]) => (
                            <div key={k} style={{ background: "#0d070533", border: "1px solid #c4a26515", borderRadius: 4, padding: "2px 6px", textAlign: "center" as const }}>
                              <div style={{ fontSize: 9, color: k.startsWith("H") ? "#6aad55" : k === "Unent." ? "#d4b86a" : "#c47070" }}>{k}</div>
                              <div style={{ fontSize: 8, color: "#c4a26550" }}>{pc(v)}</div>
                            </div>
                          ))}
                        </div>

                        {/* Goal Both Halves */}
                        <div style={{ fontWeight: 600, color: "#d4b86a", marginBottom: 4, fontSize: 9, letterSpacing: 0.5 }}>TOR IN BEIDEN HALBZEITEN</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <span style={{ color: "#6aad55" }}>Ja: {pc(gbh.yes)} ({(1/gbh.yes).toFixed(2)})</span>
                          <span style={{ color: "#c47070" }}>Nein: {pc(gbh.no)} ({(1/gbh.no).toFixed(2)})</span>
                        </div>
                      </div>
                    );
                  })()}
                </>}

                {/* xG Warnings */}
                {c?.warnings?.filter((w: any) => w.level === "error").length > 0 && (
                  <div style={{ padding: 8, borderRadius: 8, background: "#8c4a4a18", border: "1px solid #c4707020", marginBottom: 8 }}>
                    {c.warnings.filter((w: any) => w.level === "error").map((w: any, wi: number) => (
                      <div key={wi} style={{ fontSize: 10, color: "#c47070", marginBottom: 2 }}>{w.message}</div>))}
                  </div>
                )}
                {c?.warnings?.filter((w: any) => w.level === "warning").length > 0 && (
                  <div style={{ padding: 8, borderRadius: 8, background: "#c4a26510", border: "1px solid #c4a26520", marginBottom: 8 }}>
                    {c.warnings.filter((w: any) => w.level === "warning").map((w: any, wi: number) => (
                      <div key={wi} style={{ fontSize: 10, color: "#c4a26580", marginBottom: 2 }}>{w.message}</div>))}
                  </div>
                )}

                {/* Odds Input */}
                <div style={{ ...S.card, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 9, color: "#c4a26550", letterSpacing: 1, marginBottom: 8 }}>DEINE QUOTEN</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 5 }}>
                    {[["h","1"],["d","X"],["a","2"]].map(([k,l]) => (
                      <div key={k} style={{ background: "#0d070533", border: "1px solid #c4a26520", borderRadius: 6, padding: "6px 4px", textAlign: "center" as const }}>
                        <div style={{fontSize:8,color:"#c4a26540"}}>{l}</div>
                        <input type="number" step="0.01" value={o[k]||""} placeholder="—"
                          onChange={e=>setOdds(i,k,e.target.value)}
                          style={{ background: "transparent", border: "none", textAlign: "center" as const, fontSize: 14, fontWeight: 500, color: "#ede4d4", width: "100%", padding: 0 }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                    {[["o25","Ü2.5"],["u25","U2.5"],["btts","BTTS"]].map(([k,l]) => (
                      <div key={k} style={{ background: "#0d070533", border: "1px solid #c4a26520", borderRadius: 6, padding: "6px 4px", textAlign: "center" as const }}>
                        <div style={{fontSize:8,color:"#c4a26540"}}>{l}</div>
                        <input type="number" step="0.01" value={o[k]||""} placeholder="—"
                          onChange={e=>setOdds(i,k,e.target.value)}
                          style={{ background: "transparent", border: "none", textAlign: "center" as const, fontSize: 14, fontWeight: 500, color: "#ede4d4", width: "100%", padding: 0 }} />
                      </div>
                    ))}
                  </div>
                  <button onClick={() => handleSaveOdds(i)} disabled={saving===i}
                    style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, fontWeight: 600, fontSize: 11 }}>
                    {saving===i?"SPEICHERN...":`SPEICHERN (${tsNow()})`}
                  </button>
                </div>

                {/* Odds History */}
                {hist.length > 0 && (
                  <div style={{ ...S.card, padding: 10, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 9, color: "#c4a26550", letterSpacing: 0.5 }}>QUOTENVERLAUF ({hist.length}x)</span>
                      <button onClick={()=>handleDelHist(i)} style={{ fontSize: 9, padding: "1px 6px", background: "#8c4a4a18", color: "#c47070", border: "none", borderRadius: 4, cursor: "pointer" }}>Löschen</button>
                    </div>
                    {hist.map((s: any, si: number) => (
                      <div key={si} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "3px 0", borderBottom: si < hist.length - 1 ? "1px solid #c4a26508" : "none" }}>
                        <span style={{ color: "#c4a26540", minWidth: 42 }}>{new Date(s.snapshot_time).toLocaleString("de-DE",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"})}</span>
                        <span style={{ color: "#d4b86a", minWidth: 30 }}>{s.profiles?.display_name || "?"}</span>
                        {["h","d","a","o25"].map(k => {
                          const val = parseFloat(s.odds[k]), prev = si > 0 ? parseFloat(hist[si-1].odds[k]) : null;
                          const mv = prev !== null && val > 0 && Math.abs(val - prev) >= 0.03;
                          return <span key={k} style={{ minWidth: 36, textAlign: "right" as const, fontWeight: mv ? 700 : 400,
                            color: mv ? (val < prev! ? "#6aad55" : "#c47070") : "#c4a26550" }}>
                            {val > 0 ? `${val.toFixed(2)}${mv?(val<prev!?"↓":"↑"):""}` : "—"}
                          </span>;
                        })}
                      </div>
                    ))}
                    {movement && (
                      <div style={{ background: "#c4a26510", borderRadius: 6, padding: "5px 8px", marginTop: 6 }}>
                        {Object.values(movement).map((mv: any, mi: number) => (
                          <div key={mi} style={{ fontSize: 9, color: "#c4a26570" }}>{mv.label}: {mv.from.toFixed(2)}→{mv.to.toFixed(2)} ({mv.dir}) {mv.smart}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Edge */}
                {c && c.ov !== null && (
                  <div style={{ fontSize: 10, marginBottom: 6, padding: "3px 8px", borderRadius: 6, display: "inline-block",
                    background: c.ov > 0.08 ? "#c4a26510" : "#5a8c4a15", color: c.ov > 0.08 ? "#c4a265" : "#6aad55" }}>
                    OV: {pc(c.ov)} {c.ov > 0.08 ? "— hohe Marge" : "— ok"}
                  </div>
                )}
                {c?.bets?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {c.bets.map((b: any) => {
                      const confColor = b.confidence === "HIGH" ? "#6aad55" : b.confidence === "MEDIUM" ? "#d4b86a" : b.confidence === "LOW" ? "#c4a265" : "#c4a26530";
                      return (
                      <div key={b.label} style={{ padding: "6px 0", borderBottom: "1px solid #c4a26508" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 55 }}>
                            {b.isValue && <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#6aad55" }} />}
                            <span style={{ color: "#ede4d4" }}>{b.label}</span>
                          </div>
                          <span style={{ color: "#ede4d4" }}>{pc(b.pModel)}</span>
                          <span style={{ color: "#c4a26540" }}>{pc(b.pMarket)}</span>
                          <span style={{ fontWeight: 600, color: b.isValue ? "#6aad55" : b.edge >= 0 ? "#c4a26550" : "#c47070" }}>{pe(b.edge)}</span>
                          <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontWeight: 600,
                            background: confColor + "18", color: confColor }}>
                            {b.confidence}
                          </span>
                          <span style={{ color: b.isValue ? "#d4b86a" : "#c4a26530", minWidth: 42, textAlign: "right" as const }}>
                            {b.isValue ? `${br > 0 ? `€${(b.kelly * br).toFixed(0)}` : pc(b.kelly)}` : "—"}
                          </span>
                          {b.isValue && br > 0 && (
                            <button onClick={e => { e.stopPropagation(); handlePlaceBet(m, b); }}
                              disabled={placingBet === b.label}
                              style={{ fontSize: 8, padding: "2px 6px", borderRadius: 4, cursor: "pointer", border: "1px solid #6aad5540",
                                background: placingBet === b.label ? "#6aad5530" : "#6aad5510", color: "#6aad55", fontWeight: 600 }}>
                              {placingBet === b.label ? "..." : "BET"}
                            </button>
                          )}
                        </div>
                        {/* CI range for value bets */}
                        {b.isValue && b.edge_low !== undefined && (
                          <div style={{ fontSize: 9, color: "#c4a26540", marginTop: 2, paddingLeft: 9 }}>
                            Edge-Spanne: {pe(b.edge_low)} bis {pe(b.edge_high)}
                            {b.edgeSignificant ? <span style={{ color: "#6aad55" }}> · Signifikant ✓</span> : <span style={{ color: "#c47070" }}> · Unsicher ⚠</span>}
                          </div>
                        )}
                      </div>
                    );})}
                  </div>
                )}
              </div>)}
            </div>);
          })}
        </div>

        {/* Value Summary */}
        {valueMatches.length > 0 && (
          <div style={{ ...S.card, background: "#5a8c4a10", border: "1px solid #6aad5520" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>{valueMatches.length} Value-Bet{valueMatches.length>1?"s":""}</span>
              {br > 0 && <span style={{ fontSize: 11, color: "#6aad55" }}>€{totalStake.toFixed(0)} / €{br.toFixed(0)}</span>}
            </div>
            {valueMatches.map((m: any, mi: number) => (
              <div key={mi} style={{ fontSize: 11, color: "#6aad55aa", marginBottom: 2 }}>
                {m.home?.name} — {m.away?.name}: {m.calc.bets.filter((b: any) => b.isValue).map((b: any) => `${b.label} ${pe(b.edge)}${br>0?` €${(b.kelly*br).toFixed(0)}`:""}`).join(", ")}
              </div>
            ))}
          </div>
        )}

        {/* Combo Builder Button */}
        {processed.some((m: any) => m.calc?.hasOdds) && (
          <button onClick={() => setStep(3)} style={{ ...S.goldBtn, width: "100%", marginBottom: 10 }}>
            KOMBI-BUILDER →
          </button>
        )}

        {/* Bet History / P&L */}
        {userBets.length > 0 && (
          <div style={{ ...S.card, marginBottom: 10 }}>
            <div onClick={() => setShowBets(!showBets)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13 }}>📊</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#d4b86a" }}>WETT-TRACKER</span>
                <span style={{ fontSize: 10, color: "#c4a26550" }}>({userBets.length} Wetten)</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {(() => {
                  const settled = userBets.filter((b: any) => b.result === "won" || b.result === "lost");
                  const won = settled.filter((b: any) => b.result === "won");
                  const pnl = settled.reduce((s: number, b: any) => s + (b.result === "won" ? (b.odds_placed - 1) * b.stake : -b.stake), 0);
                  return settled.length > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: pnl >= 0 ? "#6aad55" : "#c47070" }}>
                      {pnl >= 0 ? "+" : ""}€{pnl.toFixed(0)} ({won.length}/{settled.length})
                    </span>
                  ) : null;
                })()}
                <span style={{ color: "#c4a26535", fontSize: 14 }}>{showBets ? "▾" : "▸"}</span>
              </div>
            </div>
            {showBets && (
              <div style={{ marginTop: 8, borderTop: "1px solid #c4a26510", paddingTop: 8 }}>
                {userBets.slice(0, 20).map((bet: any) => (
                  <div key={bet.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid #c4a26508", fontSize: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%",
                      background: bet.result === "won" ? "#6aad55" : bet.result === "lost" ? "#c47070" : "#c4a26540" }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ color: "#ede4d4" }}>{bet.home_team?.split(" ").pop()} – {bet.away_team?.split(" ").pop()}</span>
                      <span style={{ color: "#c4a26540" }}> · {bet.market} @ {parseFloat(bet.odds_placed).toFixed(2)}</span>
                    </div>
                    <span style={{ color: "#c4a26550" }}>€{parseFloat(bet.stake).toFixed(0)}</span>
                    {bet.result === "pending" ? (
                      <div style={{ display: "flex", gap: 2 }}>
                        <button onClick={async () => { await supabase.from("bets").update({ result: "won", settled_at: new Date().toISOString() }).eq("id", bet.id); setUserBets(await loadUserBets(supabase, user.id)); }}
                          style={{ fontSize: 8, padding: "1px 4px", border: "1px solid #6aad5540", borderRadius: 3, background: "#6aad5510", color: "#6aad55", cursor: "pointer" }}>W</button>
                        <button onClick={async () => { await supabase.from("bets").update({ result: "lost", settled_at: new Date().toISOString() }).eq("id", bet.id); setUserBets(await loadUserBets(supabase, user.id)); }}
                          style={{ fontSize: 8, padding: "1px 4px", border: "1px solid #c4707040", borderRadius: 3, background: "#c4707010", color: "#c47070", cursor: "pointer" }}>L</button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 9, fontWeight: 600, color: bet.result === "won" ? "#6aad55" : "#c47070" }}>
                        {bet.result === "won" ? `+€${((bet.odds_placed - 1) * bet.stake).toFixed(0)}` : `-€${parseFloat(bet.stake).toFixed(0)}`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: 9, color: "#c4a26520", textAlign: "center" as const, marginTop: 14, letterSpacing: 0.5 }}>
          * vig-bereinigt · Sportwetten = Glücksspiel · spielen-mit-verantwortung.de
        </div>
      </div>
    </div>
  );
}

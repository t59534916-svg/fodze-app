"use client";
import { useState } from "react";

const S = {
  page: { minHeight: "100dvh", padding: "16px 14px", background: "radial-gradient(ellipse at 50% 40%, #2a1810 0%, #1a0f0a 60%, #0d0705 100%)", color: "#ede4d4", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" } as React.CSSProperties,
  card: { background: "#0d070540", border: "1px solid #c4a26515", borderRadius: 10, padding: "14px", marginBottom: 10 } as React.CSSProperties,
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
  btn: { background: "transparent", border: "1px solid #c4a26530", color: "#c4a265", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 500 } as React.CSSProperties,
  code: { background: "#0d0705", border: "1px solid #c4a26520", borderRadius: 6, padding: "10px 12px", fontSize: 11, color: "#c4a26580", whiteSpace: "pre-wrap" as const, overflowX: "auto" as const, lineHeight: 1.5, fontFamily: "'Fira Code', 'SF Mono', monospace" } as React.CSSProperties,
};

const XG_SCRIPT = `// ═══ FODZE xG Fetcher v2 (with per-match history for EWMA) ═══
const result = {};
Object.keys(teamsData).forEach(id => {
  const t = teamsData[id];
  const home = t.history.filter(g => g.h_a === 'h');
  const away = t.history.filter(g => g.h_a === 'a');
  const hL8 = home.slice(-8), aL8 = away.slice(-8);
  result[t.title] = {
    xg_h8:  +hL8.reduce((s,g) => s + parseFloat(g.xG), 0).toFixed(1),
    xga_h8: +hL8.reduce((s,g) => s + parseFloat(g.xGA), 0).toFixed(1),
    xg_a8:  +aL8.reduce((s,g) => s + parseFloat(g.xG), 0).toFixed(1),
    xga_a8: +aL8.reduce((s,g) => s + parseFloat(g.xGA), 0).toFixed(1),
    // Per-match history for EWMA time-decay (Dixon-Coles 1997)
    xg_h_history: hL8.map(g => ({ xg: +parseFloat(g.xG).toFixed(2), xga: +parseFloat(g.xGA).toFixed(2), date: g.datetime?.split(' ')[0] || '' })),
    xg_a_history: aL8.map(g => ({ xg: +parseFloat(g.xG).toFixed(2), xga: +parseFloat(g.xGA).toFixed(2), date: g.datetime?.split(' ')[0] || '' })),
  };
});
copy(JSON.stringify(result, null, 2));
console.log('✅ xG-Daten in Clipboard kopiert!');
console.table(result);`;

const INJURY_PROMPT = `Du bist ein Fußball-Datenanalyst. Recherchiere für diese Spiele die aktuellsten Informationen.

[SPIELE HIER EINFÜGEN]

Recherchiere für JEDES Spiel:
1. VERLETZUNGEN & SPERREN (Name, Position, Grund)
2. FORM (letzte 5 Spiele mit Gegnern)
3. SCHIEDSRICHTER (Name, Karten-Schnitt)
4. KONTEXT (Tabelle, Derby?, Abstiegskampf?, CL-Sandwich?)

Quellen: sofascore.com, transfermarkt.de, kicker.de
Antworte als strukturiertes JSON. Nur FAKTEN, keine Vorhersagen.`;

const JSON_TEMPLATE = `{
  "league": "Bundesliga",
  "matchday": "Spieltag 28",
  "date": "2026-04-04",
  "data_confidence": "HIGH",
  "sources": ["understat.com", "transfermarkt.de"],
  "matches": [
    {
      "home": {
        "name": "Team A",
        "xg_h8": 12.5,  // SUMME letzte 8 Heimspiele
        "xga_h8": 7.2,  // SUMME kassierte xG
        "games": 8,
        "form": "W W D L W",
        "injuries": "Spieler (Grund)",
        "yellow_risk": "",
        "notes": "xG Understat"
      },
      "away": {
        "name": "Team B",
        "xg_a8": 9.0,   // SUMME letzte 8 Auswärtsspiele
        "xga_a8": 11.5,
        "games": 8,
        "form": "L W W D W",
        "injuries": "",
        "yellow_risk": "",
        "notes": "xG Understat"
      },
      "tags": ["DERBY"],
      "context": "Kurzer Kontext",
      "referee": "Name",
      "kickoff": "15:30"
    }
  ]
}`;

const SEED_CMD = `node scripts/seed-matchday.mjs --file spieltag.json --league bundesliga`;

interface Task {
  id: number;
  title: string;
  desc: string;
  why: string;
  content: "xg" | "injuries" | "json" | "seed" | "odds" | "spielplan";
}

const TASKS: Task[] = [
  { id: 1, title: "Spielplan holen", desc: "Alle Spiele mit Datum & Anstoßzeit", why: "Der Spielplan ist die Grundlage — ohne Paarungen keine xG-Zuordnung.", content: "spielplan" },
  { id: 2, title: "xG-Daten holen", desc: "Understat Browser-Script ausführen", why: "xG misst Chancenqualität, nicht nur ob Tore fielen. Das Modell erkennt die echte Stärke.", content: "xg" },
  { id: 3, title: "Verletzungen sammeln", desc: "3 AIs parallel befragen", why: "Einzelne AIs haben oft veraltete Daten. Cross-Check mit 3 AIs erhöht die Zuverlässigkeit.", content: "injuries" },
  { id: 4, title: "JSON zusammenbauen", desc: "Alle Daten im FODZE-Format", why: "Die Engine liest xg_h8 als SUMME. Falsche Werte (z.B. Durchschnitte) → komplett falsche Vorhersagen.", content: "json" },
  { id: 5, title: "In DB seeden", desc: "JSON per Script in Supabase laden", why: "Die App lädt den neuesten Spieltag pro Liga automatisch. Ohne DB-Eintrag → keine Daten.", content: "seed" },
  { id: 6, title: "Quoten & Value Bets", desc: "Buchmacher-Quoten eingeben", why: "Edge = pModel - pMarket. Das Modell zeigt wo der Buchmacher falsch liegt.", content: "odds" },
];

const UNDERSTAT_URLS: Record<string, string> = {
  "Bundesliga": "https://understat.com/league/Bundesliga",
  "Premier League": "https://understat.com/league/EPL",
  "La Liga": "https://understat.com/league/La_liga",
  "Serie A": "https://understat.com/league/Serie_A",
  "Ligue 1": "https://understat.com/league/Ligue_1",
};

export default function WorkflowPage() {
  const [done, setDone] = useState<Set<number>>(new Set());
  const [openTask, setOpenTask] = useState<number | null>(1);
  const [copied, setCopied] = useState<string | null>(null);

  const toggleDone = (id: number) => {
    setDone(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      // Fallback: select text for manual copy
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(label);
    }
    setTimeout(() => setCopied(null), 2000);
  };

  const progress = (done.size / TASKS.length) * 100;

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "Georgia, serif", letterSpacing: 2, ...S.goldText }}>WORKFLOW</div>
          <div style={{ fontSize: 11, color: "#c4a26550" }}>Spieltag-Analyse in 6 Schritten</div>
        </div>
        <a href="/" style={{ ...S.btn, textDecoration: "none" }}>← App</a>
      </div>

      {/* Progress */}
      <div style={{ ...S.card, padding: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#c4a26550", marginBottom: 4 }}>
          <span>{done.size} / {TASKS.length} erledigt</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: "#c4a26510" }}>
          <div style={{ height: "100%", borderRadius: 2, width: `${progress}%`, transition: "width 0.3s",
            background: "linear-gradient(90deg, #a68940, #f5e6b8, #a68940)", backgroundSize: "200% 100%" }} />
        </div>
      </div>

      {/* Tasks */}
      {TASKS.map(task => {
        const isOpen = openTask === task.id;
        const isDone = done.has(task.id);
        return (
          <div key={task.id} style={{ ...S.card, borderColor: isDone ? "#6aad5530" : "#c4a26515", background: isDone ? "#5a8c4a08" : "#0d070540" }}>
            {/* Task Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              onClick={() => setOpenTask(isOpen ? null : task.id)}>
              <div onClick={e => { e.stopPropagation(); toggleDone(task.id); }}
                style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${isDone ? "#6aad55" : "#c4a26530"}`,
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
                  background: isDone ? "#6aad5520" : "transparent" }}>
                {isDone && <span style={{ color: "#6aad55", fontSize: 12 }}>✓</span>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: isDone ? "#6aad55" : "#ede4d4" }}>
                  {task.id}. {task.title}
                </div>
                <div style={{ fontSize: 10, color: "#c4a26550" }}>{task.desc}</div>
              </div>
              <span style={{ color: "#c4a26535", fontSize: 14 }}>{isOpen ? "▾" : "▸"}</span>
            </div>

            {/* Task Detail */}
            {isOpen && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #c4a26510" }}>
                {/* Why */}
                <div style={{ fontSize: 10, color: "#d4b86a", marginBottom: 8, padding: "4px 8px", borderRadius: 4, background: "#c4a26508", borderLeft: "3px solid #d4b86a" }}>
                  💡 {task.why}
                </div>

                {/* Spielplan */}
                {task.content === "spielplan" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>Prompt für AI:</div>
                    <div style={S.code}>
                      {`Gib mir alle Spiele der [LIGA] am [SPIELTAG] [DATUM].\n\nFormat pro Spiel:\n- Heim vs Gast (Anstoßzeit)\n- Tabellenposition beider Teams\n- Relevanter Kontext (Derby? Abstiegskampf? CL-Sandwich?)\n\nQuellen: kicker.de, sofascore.com`}
                    </div>
                    <button onClick={() => copyText("Gib mir alle Spiele der [LIGA] am [SPIELTAG] [DATUM].\n\nFormat pro Spiel:\n- Heim vs Gast (Anstoßzeit)\n- Tabellenposition beider Teams\n- Relevanter Kontext (Derby? Abstiegskampf? CL-Sandwich?)\n\nQuellen: kicker.de, sofascore.com", "spielplan")}
                      style={{ ...S.btn, marginTop: 6 }}>{copied === "spielplan" ? "✅ Kopiert!" : "📋 Prompt kopieren"}</button>
                  </div>
                )}

                {/* xG */}
                {task.content === "xg" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>1. Öffne die Understat-Seite:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                      {Object.entries(UNDERSTAT_URLS).map(([name, url]) => (
                        <a key={name} href={url} target="_blank" rel="noreferrer"
                          style={{ ...S.btn, textDecoration: "none", fontSize: 9 }}>{name}</a>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>2. Öffne DevTools (F12) → Console → Paste:</div>
                    <div style={S.code}>{XG_SCRIPT}</div>
                    <button onClick={() => copyText(XG_SCRIPT, "xg")}
                      style={{ ...S.btn, marginTop: 6 }}>{copied === "xg" ? "✅ Kopiert!" : "📋 Script kopieren"}</button>
                    <div style={{ fontSize: 10, color: "#c4a26540", marginTop: 8 }}>
                      ⚠️ Für 2. Bundesliga & 3. Liga gibt es keine xG-Daten. Verwende Tore als Proxy (siehe WORKFLOW.md).
                    </div>
                  </div>
                )}

                {/* Injuries */}
                {task.content === "injuries" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 4 }}>Sende diesen Prompt an <strong>3 AIs parallel</strong> (Claude + Gemini + ChatGPT):</div>
                    <div style={S.code}>{INJURY_PROMPT}</div>
                    <button onClick={() => copyText(INJURY_PROMPT, "injuries")}
                      style={{ ...S.btn, marginTop: 6 }}>{copied === "injuries" ? "✅ Kopiert!" : "📋 Prompt kopieren"}</button>
                    <div style={{ fontSize: 10, marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#c4a26508" }}>
                      <div style={{ color: "#6aad55", marginBottom: 2 }}>✅ Alle 3 nennen es → sicher</div>
                      <div style={{ color: "#d4b86a", marginBottom: 2 }}>⚠️ 2 von 3 nennen es → wahrscheinlich</div>
                      <div style={{ color: "#c47070" }}>❌ Nur 1 nennt es → fraglich</div>
                    </div>
                  </div>
                )}

                {/* JSON */}
                {task.content === "json" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>JSON-Template (alle Felder erklärt):</div>
                    <div style={S.code}>{JSON_TEMPLATE}</div>
                    <button onClick={() => copyText(JSON_TEMPLATE, "json")}
                      style={{ ...S.btn, marginTop: 6 }}>{copied === "json" ? "✅ Kopiert!" : "📋 Template kopieren"}</button>
                    <div style={{ fontSize: 10, marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#8c4a4a10", border: "1px solid #c4707020" }}>
                      <div style={{ color: "#c47070", fontWeight: 600, marginBottom: 4 }}>⚠️ Häufige Fehler:</div>
                      <div style={{ color: "#c4a26560" }}>• xg_h8: 1.5 → Das ist ein Durchschnitt! Richtig: 12.0 (Summe über 8 Spiele)</div>
                      <div style={{ color: "#c4a26560" }}>• xg_h8: 0 → Fehlt! Engine kann nicht rechnen</div>
                      <div style={{ color: "#c4a26560" }}>• Faustregel: Wert / 8 ≈ 0.8 – 2.5 pro Spiel</div>
                    </div>
                  </div>
                )}

                {/* Seed */}
                {task.content === "seed" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>Option A: CLI-Script (empfohlen)</div>
                    <div style={S.code}>{SEED_CMD}</div>
                    <button onClick={() => copyText(SEED_CMD, "seed")}
                      style={{ ...S.btn, marginTop: 6 }}>{copied === "seed" ? "✅ Kopiert!" : "📋 Befehl kopieren"}</button>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginTop: 10, marginBottom: 4 }}>Liga-Codes:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {["bundesliga", "bundesliga2", "liga3", "epl", "la_liga", "serie_a", "ligue_1"].map(l => (
                        <span key={l} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#c4a26510", color: "#c4a26570" }}>{l}</span>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginTop: 10 }}>Option B: Import in der App</div>
                    <div style={{ fontSize: 10, color: "#c4a26550" }}>App öffnen → Liga wählen → "Import (JSON)" → JSON pasten → "ANALYSIEREN"</div>
                  </div>
                )}

                {/* Odds */}
                {task.content === "odds" && (
                  <div>
                    <div style={{ fontSize: 11, color: "#c4a26560", marginBottom: 6 }}>In der App:</div>
                    <div style={{ fontSize: 10, color: "#c4a26550", lineHeight: 1.8 }}>
                      1. Klick auf ein Spiel → Expandieren<br/>
                      2. Unter "DEINE QUOTEN": 1, X, 2, Ü2.5, U2.5, BTTS eingeben<br/>
                      3. Klick "SPEICHERN"<br/>
                      4. Grüne Markierung = Value Bet (Edge positiv)<br/>
                      5. Kelly-Einsatz wird automatisch berechnet
                    </div>
                    <div style={{ fontSize: 10, marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#c4a26508" }}>
                      <div style={{ color: "#d4b86a", fontWeight: 600, marginBottom: 4 }}>Grading:</div>
                      <div style={{ color: "#6aad55" }}>Grade A: Edge ≥ 8% — Starker Value</div>
                      <div style={{ color: "#6aad55" }}>Grade B: Edge 5-8% — Gut</div>
                      <div style={{ color: "#d4b86a" }}>Grade C: Edge 3-5% — Marginal</div>
                      <div style={{ color: "#c47070" }}>Grade D/F: Edge &lt;3% / negativ — Skip</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 9, color: "#c4a26520", textAlign: "center", marginTop: 14, letterSpacing: 0.5 }}>
        FODZE · Workflow v1.0 · Alle Prompts & Scripts sind Copy-Paste-Ready
      </div>
    </div>
  );
}

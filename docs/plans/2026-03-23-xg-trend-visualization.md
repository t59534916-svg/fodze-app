# Rolling xG Trend Visualization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Visualize per-match xG trends via inline SVG sparklines in match cards and a full team detail page.

**Architecture:** Extend the Understat extraction script to preserve per-match xG history (currently discarded). Store in existing JSONB `data` column alongside 8-game sums. Build two SVG components: a compact sparkline for match cards and a full chart for the team page. Zero new dependencies — pure inline SVG.

**Tech Stack:** React 18, Next.js 14 App Router, inline SVG, Supabase JSONB

---

### Task 1: Update Understat Extraction Script

**Files:**
- Modify: `WORKFLOW.md:63-83`

**Step 1: Update the browser console script in WORKFLOW.md**

Replace the existing script (lines 63-83) with:

```javascript
// ═══ FODZE xG Fetcher v2 — With Per-Match History ═══
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
    xg_home_history: hL8.map(g => ({
      xg: +parseFloat(g.xG).toFixed(2),
      xga: +parseFloat(g.xGA).toFixed(2),
      result: g.result,
      opponent: Object.keys(teamsData).map(i=>teamsData[i]).find(x=>x.id!==t.id&&x.history.some(h=>h.id===g.id))?.title||'',
      date: g.datetime?.split(' ')[0]||''
    })),
    xg_away_history: aL8.map(g => ({
      xg: +parseFloat(g.xG).toFixed(2),
      xga: +parseFloat(g.xGA).toFixed(2),
      result: g.result,
      opponent: Object.keys(teamsData).map(i=>teamsData[i]).find(x=>x.id!==t.id&&x.history.some(h=>h.id===g.id))?.title||'',
      date: g.datetime?.split(' ')[0]||''
    }))
  };
});
copy(JSON.stringify(result, null, 2));
console.log('✅ xG-Daten + History in Clipboard kopiert!');
```

**Step 2: Verify the script works**

Run: Open `https://understat.com/league/Bundesliga` in Chrome, paste script in console.
Expected: JSON output includes `xg_home_history` and `xg_away_history` arrays per team.

**Step 3: Commit**

```bash
git add WORKFLOW.md
git commit -m "feat: extend xG extraction script to include per-match history"
```

---

### Task 2: Create XGSparkline Component

**Files:**
- Create: `src/components/XGSparkline.tsx`

**Step 1: Create the sparkline component**

```tsx
"use client";
import React from "react";

interface HistoryEntry {
  xg: number;
  xga: number;
  result?: string;
  opponent?: string;
  date?: string;
  proxy?: string;
}

interface Props {
  history: HistoryEntry[];
  width?: number;
  height?: number;
  showLabels?: boolean;
}

function rollingAvg(data: number[], window: number): number[] {
  return data.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function trend(data: number[]): { arrow: string; label: string; color: string } {
  if (data.length < 3) return { arrow: "→", label: "stabil", color: "#c4a265" };
  const recent = data.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const older = data.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
  const diff = recent - older;
  if (diff > 0.3) return { arrow: "↑", label: "steigend", color: "#6aad55" };
  if (diff > 0.1) return { arrow: "↗", label: "leicht↑", color: "#8aad65" };
  if (diff < -0.3) return { arrow: "↓", label: "fallend", color: "#c47070" };
  if (diff < -0.1) return { arrow: "↘", label: "leicht↓", color: "#c4a070" };
  return { arrow: "→", label: "stabil", color: "#c4a265" };
}

function toPath(points: number[], w: number, h: number, min: number, max: number): string {
  if (points.length < 2) return "";
  const range = max - min || 1;
  const pad = 2;
  return points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((p - min) / range) * (h - 2 * pad);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export default function XGSparkline({ history, width = 200, height = 40, showLabels = true }: Props) {
  if (!history || history.length < 2) return null;

  const xgData = history.map(h => h.xg);
  const xgaData = history.map(h => h.xga);
  const xgSmooth = rollingAvg(xgData, 3);
  const xgaSmooth = rollingAvg(xgaData, 3);

  const all = [...xgSmooth, ...xgaSmooth];
  const min = Math.max(0, Math.min(...all) - 0.2);
  const max = Math.max(...all) + 0.2;

  const xgPath = toPath(xgSmooth, width, height, min, max);
  const xgaPath = toPath(xgaSmooth, width, height, min, max);
  const xgTrend = trend(xgSmooth);

  const isProxy = history.some(h => h.proxy === "goals");

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        style={{ background: "#1a0f0840", borderRadius: 4 }}>
        <path d={xgPath} fill="none" stroke="#d4b86a" strokeWidth={1.5} />
        <path d={xgaPath} fill="none" stroke="#8b4513" strokeWidth={1} strokeDasharray="3,2" />
      </svg>
      {showLabels && (
        <div style={{ fontSize: 9, lineHeight: 1.3 }}>
          <div style={{ color: xgTrend.color, fontWeight: 600 }}>
            {xgTrend.arrow} {xgTrend.label}
          </div>
          {isProxy && <div style={{ color: "#c4a26540", fontSize: 8 }}>(Tore)</div>}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/XGSparkline.tsx
git commit -m "feat: add XGSparkline inline SVG component"
```

---

### Task 3: Integrate Sparkline into Match Cards

**Files:**
- Modify: `src/components/FodzeApp.tsx:799-811`

**Step 1: Add import at top of FodzeApp.tsx**

After existing imports, add:
```tsx
import XGSparkline from "./XGSparkline";
```

**Step 2: Insert sparkline in team detail rows**

In the team detail section (line ~800-811), after the injuries line and before the closing `</div>`, add the sparkline:

```tsx
{t.xg_history && t.xg_history.length >= 2 && (
  <div style={{ marginTop: 4 }}>
    <XGSparkline history={t.xg_history} width={160} height={32} />
  </div>
)}
```

The `t` variable refers to either `m.home` or `m.away` in the existing `.map()`.

Note: `xg_history` key mapping:
- For home team: use `m.home.xg_home_history` or `m.home.xg_history`
- For away team: use `m.away.xg_away_history` or `m.away.xg_history`

In the seed script, map `xg_home_history` → `home.xg_history` and `xg_away_history` → `away.xg_history`.

**Step 3: Build and test**

Run: `npm run build`
Expected: No TypeScript errors.

**Step 4: Commit**

```bash
git add src/components/FodzeApp.tsx
git commit -m "feat: integrate xG sparklines into match detail cards"
```

---

### Task 4: Create Team Detail Page

**Files:**
- Create: `src/app/team/[name]/page.tsx`
- Create: `src/components/XGChart.tsx`

**Step 1: Create XGChart full-size component**

`src/components/XGChart.tsx` — Full-width SVG chart showing rolling xGD.

```tsx
"use client";
import React from "react";

interface HistoryEntry {
  xg: number;
  xga: number;
  result?: string;
  opponent?: string;
  date?: string;
}

interface Props {
  history: HistoryEntry[];
  teamName: string;
  venue: "home" | "away";
  height?: number;
}

export default function XGChart({ history, teamName, venue, height = 200 }: Props) {
  if (!history || history.length < 2) return (
    <div style={{ color: "#c4a26550", fontSize: 11, padding: 20, textAlign: "center" }}>
      Keine History-Daten verfügbar
    </div>
  );

  const width = 600; // SVG internal width, CSS scales to 100%
  const pad = { top: 20, right: 20, bottom: 30, left: 40 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const xgd = history.map(h => h.xg - h.xga);
  const maxAbs = Math.max(Math.abs(Math.min(...xgd)), Math.abs(Math.max(...xgd)), 1);
  const yMin = -maxAbs - 0.3;
  const yMax = maxAbs + 0.3;

  function x(i: number) { return pad.left + (i / (history.length - 1)) * cw; }
  function y(val: number) { return pad.top + ((yMax - val) / (yMax - yMin)) * ch; }

  const linePath = xgd.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);

  return (
    <div style={{ width: "100%", background: "#1a0f08", borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#d4b86a", fontFamily: "Georgia,serif", marginBottom: 8 }}>
        {teamName} — xGD Rolling ({venue === "home" ? "Heim" : "Auswärts"})
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
        {/* Grid */}
        <line x1={pad.left} y1={zeroY} x2={width - pad.right} y2={zeroY} stroke="#c4a26530" strokeWidth={1} />
        {[-1, -0.5, 0.5, 1].filter(v => v >= yMin && v <= yMax).map(v => (
          <g key={v}>
            <line x1={pad.left} y1={y(v)} x2={width - pad.right} y2={y(v)} stroke="#2a1810" strokeWidth={0.5} />
            <text x={pad.left - 4} y={y(v) + 3} fill="#c4a26540" fontSize={9} textAnchor="end">{v > 0 ? "+" : ""}{v}</text>
          </g>
        ))}

        {/* Bars */}
        {xgd.map((v, i) => (
          <rect key={i} x={x(i) - 8} y={v >= 0 ? y(v) : zeroY} width={16}
            height={Math.abs(y(v) - zeroY)} fill={v >= 0 ? "#6aad5530" : "#c4707030"} rx={2} />
        ))}

        {/* Line */}
        <path d={linePath} fill="none" stroke="#d4b86a" strokeWidth={2} />

        {/* Dots */}
        {xgd.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={v >= 0 ? "#6aad55" : "#c47070"} stroke="#1a0f08" strokeWidth={1} />
        ))}

        {/* X-axis labels */}
        {history.map((h, i) => (
          <text key={i} x={x(i)} y={height - 5} fill="#c4a26540" fontSize={7} textAnchor="middle">
            {h.opponent?.substring(0, 6) || `SP${i + 1}`}
          </text>
        ))}

        {/* Y-axis label */}
        <text x={5} y={height / 2} fill="#c4a26540" fontSize={8} textAnchor="middle"
          transform={`rotate(-90, 5, ${height / 2})`}>xGD</text>
      </svg>

      {/* Match table */}
      <div style={{ marginTop: 12, fontSize: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "3px 8px", color: "#c4a26550" }}>
          <div style={{ fontWeight: 600 }}>Gegner</div>
          <div style={{ fontWeight: 600 }}>xG</div>
          <div style={{ fontWeight: 600 }}>xGA</div>
          <div style={{ fontWeight: 600 }}>xGD</div>
          {history.map((h, i) => (
            <React.Fragment key={i}>
              <div style={{ color: "#ede4d4" }}>{h.opponent || `Spiel ${i + 1}`}</div>
              <div style={{ color: "#d4b86a" }}>{h.xg.toFixed(2)}</div>
              <div style={{ color: "#8b4513" }}>{h.xga.toFixed(2)}</div>
              <div style={{ color: h.xg - h.xga >= 0 ? "#6aad55" : "#c47070", fontWeight: 600 }}>
                {(h.xg - h.xga) >= 0 ? "+" : ""}{(h.xg - h.xga).toFixed(2)}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create team page**

`src/app/team/[name]/page.tsx`:

```tsx
"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import XGChart from "../../../components/XGChart";

export default function TeamPage() {
  const params = useParams();
  const router = useRouter();
  const teamName = decodeURIComponent(params.name as string);
  const [homeHistory, setHomeHistory] = useState<any[]>([]);
  const [awayHistory, setAwayHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    sb.from("matchdays").select("data").order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => {
        if (!data) return setLoading(false);
        for (const row of data) {
          const matches = row.data?.matches || [];
          for (const m of matches) {
            if (m.home?.name === teamName && m.home?.xg_history?.length) {
              setHomeHistory(m.home.xg_history);
            }
            if (m.away?.name === teamName && m.away?.xg_history?.length) {
              setAwayHistory(m.away.xg_history);
            }
          }
        }
        setLoading(false);
      });
  }, [teamName]);

  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(ellipse at 30% 20%, #2a1810, #0d0705)",
      color: "#ede4d4", padding: 20, fontFamily: "Georgia, serif" }}>
      <button onClick={() => router.back()}
        style={{ background: "none", border: "1px solid #c4a26530", color: "#c4a265",
          padding: "6px 14px", borderRadius: 6, cursor: "pointer", marginBottom: 16, fontSize: 12 }}>
        ← Zurück
      </button>
      <h1 style={{ fontSize: 22, color: "#d4b86a", marginBottom: 20 }}>{teamName}</h1>

      {loading ? <div style={{ color: "#c4a26550" }}>Lade Daten...</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 700 }}>
          {homeHistory.length >= 2 && <XGChart history={homeHistory} teamName={teamName} venue="home" />}
          {awayHistory.length >= 2 && <XGChart history={awayHistory} teamName={teamName} venue="away" />}
          {homeHistory.length < 2 && awayHistory.length < 2 && (
            <div style={{ color: "#c4a26550", fontSize: 13 }}>
              Keine xG-History-Daten für {teamName} verfügbar. Daten müssen mit dem erweiterten xG Fetcher v2 importiert werden.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Make team names clickable in FodzeApp.tsx**

In the team detail rows (~line 803), wrap the team name in a link:

```tsx
<span style={{ fontWeight: 500, color: "#ede4d4", cursor: "pointer", textDecoration: "underline dotted #c4a26530" }}
  onClick={(e) => { e.stopPropagation(); window.open(`/team/${encodeURIComponent(t.name)}`, '_blank'); }}>
  {t.name}
</span>
```

**Step 4: Build and test**

Run: `npm run build`
Expected: No TypeScript errors, new `/team/[name]` route compiled.

**Step 5: Commit**

```bash
git add src/components/XGChart.tsx src/app/team/\[name\]/page.tsx src/components/FodzeApp.tsx
git commit -m "feat: add team detail page with full xGD chart"
```

---

### Task 5: Re-seed Matchdays with xG History

**Files:**
- No code change — manual data update

**Step 1: Run updated Understat script for all xG leagues**

For each league (BL, PL, La Liga, Serie A), run the v2 script in browser console and re-seed the matchday data using the existing seed workflow.

**Step 2: Verify sparklines appear in app**

Open app, select a league, expand a match. Sparklines should show under each team.

**Step 3: Deploy**

```bash
git push origin main
npx vercel --prod --yes
```

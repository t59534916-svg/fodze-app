# Rolling xG Trend Visualization — Design

## Problem
The app stores only 8-game xG sums (xg_h8). This masks momentum — a team scoring 3.0 xG 8 weeks ago but 0.5 xG recently has the same sum as the reverse.

## Solution
Store per-match xG history and visualize rolling trends via inline SVG charts.

## Data Layer Changes

### 1. Understat Extraction Script (WORKFLOW.md Task 2)
Extend browser console script to extract per-match history:
```javascript
result[t.title] = {
  xg_h8: sum,     // existing
  xga_h8: sumA,   // existing
  xg_history: hL8.map(g => ({   // NEW
    xg: +parseFloat(g.xG).toFixed(2),
    xga: +parseFloat(g.xGA).toFixed(2),
    result: g.result,
    opponent: g.title,        // opponent name
    date: g.date
  }))
};
```

### 2. Match JSON Schema Extension
```typescript
interface XGHistoryEntry {
  xg: number;
  xga: number;
  result?: string;    // "2:1"
  opponent?: string;
  date?: string;
  proxy?: "goals";    // set for 2.BL/3.Liga
}

// Added to home/away objects:
xg_history?: XGHistoryEntry[];
```

### 3. Non-xG Leagues (2.BL, 3.Liga)
Same structure but with actual goals as proxy. Marked with `proxy: "goals"`.

## UI Components

### A. Sparkline (Match Detail)
- Size: 200×40px inline SVG
- Gold line (#d4b86a) = xG scored per game
- Brown dashed line (#8b4513) = xGA conceded per game
- Trend arrow (↑↗→↘↓) + text label
- 3-match rolling average smoothing
- Shown under each team name in expanded match card

### B. Team Page (/team/[name])
- Full-width SVG chart (100% × 200px): Rolling xGD
- Home/Away split toggle
- Last 8 matches table (opponent, xG, xGA, result)
- Linked from match detail via team name click

## Styling
- Chart background: #1a0f08
- xG line: #d4b86a (gold)
- xGA line: #8b4513 (brown)
- Grid lines: #2a1810
- Font: Georgia serif (consistent with app)

## Approach
Inline SVG (zero dependencies). Matches existing Kit SVG pattern.

## Files to Create/Modify
1. `src/components/XGSparkline.tsx` — NEW: Sparkline component
2. `src/components/XGChart.tsx` — NEW: Full team chart component
3. `src/app/team/[name]/page.tsx` — NEW: Team detail page
4. `src/components/FodzeApp.tsx` — MODIFY: Add sparklines to match cards
5. `WORKFLOW.md` — MODIFY: Update extraction script
6. `scripts/seed-matchday.mjs` — MODIFY: Accept xg_history field

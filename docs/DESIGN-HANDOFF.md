# FODZE Design Handoff

> Quantitative Fußball-Wettanalyse · Next.js 14 · React 18 · TypeScript · Inline Styles + Token System

---

## Design Tokens (`src/styles/tokens.ts`)

### Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `leather` | `#1a0f0a` | Page background (darkest) |
| `leather2` | `#231510` | Elevated card bg, nav bg |
| `leather3` | `#2a1810` | Gradient highlight |
| `surface` | `#c4a2650c` | Card background |
| `surfaceHover` | `#c4a26515` | Card hover |
| `gold` | `#d4b86a` | Primary accent, active states |
| `goldShine` | `#f5e6b8` | Brightest highlight |
| `goldDark` | `#a68940` | Gradient endpoints |
| `goldMuted` | `#c4a26560` | Muted accents |
| `text` | `#ede4d4` | Primary text |
| `textMuted` | `#c4a26590` | Secondary text (WCAG AA) |
| `textFaint` | `#c4a26560` | Decorative text |
| `value` | `#6aad55` | Positive/green |
| `warn` | `#c47070` | Negative/red |
| `info` | `#5a9ec4` | Info/blue |
| `border` | `#c4a26520` | Default borders |

### Typography

| Token | Value | Usage |
|-------|-------|-------|
| `fontFamily.sans` | Inter, system | Body text |
| `fontFamily.serif` | Georgia | Branding, headings |
| `fontFamily.mono` | SF Mono, Fira Code | Odds, numbers, data |
| `fontSize.xs` | 11px | Labels, tags |
| `fontSize.sm` | 13px | Buttons, secondary |
| `fontSize.base` | 16px | Body |
| `fontSize.lg` | 20px | Subheadings |
| `fontSize.xl` | 24px | Headings |
| `fontSize.xxl` | 32px | Large metrics |

### Spacing (8pt grid)

| Token | px | Usage |
|-------|-----|-------|
| `space.3` | 8 | Tight gaps |
| `space.4` | 12 | Card gap |
| `space.5` | 16 | Standard padding |
| `space.6` | 24 | Section spacing |
| `space.7` | 32 | Large spacing |

### Radii

| Token | px |
|-------|-----|
| `radius.sm` | 6 |
| `radius.md` | 10 |
| `radius.lg` | 16 |
| `radius.full` | 999 |

---

## Responsive Breakpoints

| Breakpoint | Max-Width | Nav | Layout |
|------------|-----------|-----|--------|
| Mobile (default) | 480px | Bottom bar 60px | Single column, 16px padding |
| Tablet (768px+) | 640px | Bottom bar 60px | Wider padding 24px 32px |
| Desktop (1024px+) | 720px | Sidebar 220px left | margin-left: 220px, 32px 40px padding |

---

## Components

### AppShell
Page wrapper: leather gradient bg, Corners decoration, Navbar.

### Navbar
- **Mobile**: 5 tabs fixed bottom (Home, Analyse, Kombis, Simulator, Stats), SVG icons, gold active indicator
- **Desktop**: Left sidebar 220px, Logo + vertical tabs, active = gold left-border + bg tint

### MatchCard
2-row design: Teams + kickoff | Probability bar (H green/D gray/A red) + VALUE edge badge. Hover: subtle bg.

### MatchDetail
3-tab system: Überblick | Quoten | Statistik. Each tab fades in. expandIn animation on open.

### OddsInput
3 main fields (1/X/2) prominent, Ü2.5/U2.5/BTTS expandable. Auto-save 1.5s debounce. Live badge if from API.

### ChatMessage (Anna)
Assistant: leather-card left-aligned, 12px rounded. User: gold gradient right-aligned. Typing: 3 pulsing dots. Streaming: gold cursor blink.

### GoldButton
Full-width CTA, 5-stop gold gradient, goldShimmer 3s infinite animation.

### Kit
Team jersey SVG (24x24), primary fill + secondary stroke, from TEAM_COLORS lookup.

### ValueBadge
Inline tag: VALUE (green), WARN (red), NEUTRAL (gold), INFO (muted). 9px, semibold, 4px radius.

---

## Animations (`src/app/globals.css`)

| Name | Duration | Easing | Usage |
|------|----------|--------|-------|
| `goldShimmer` | 3s infinite | ease-in-out | Gold button shimmer |
| `spin` | 1.5s infinite | linear | Loading spinner |
| `pulse` | 2s infinite | ease-in-out | Loading text, typing dots |
| `fadeIn` | 0.25s | ease | General entrance |
| `slideUp` | 0.3s | ease | Chat messages |
| `expandIn` | 0.3s | ease | Card detail expand |
| `tabFadeIn` | 0.2s | ease | Tab content switch |

All animations respect `prefers-reduced-motion: reduce`.

---

## States & Interactions

| Element | Default | Hover | Active | Disabled |
|---------|---------|-------|--------|----------|
| GoldButton | Shimmer gradient | — | scale(0.97) | opacity 0.5 |
| OutlineBtn | Transparent + border | — | scale(0.97) | opacity 0.5 |
| MatchCard | Transparent | bg #c4a2650a | — | — |
| LeagueTile | Subtle border | border #c4a26540 | scale(0.98) | opacity 0.45 |
| Input | Dashed border | — | Gold border + glow | opacity 0.5 |
| NavTab | Muted color | — | — | — (active = gold) |

---

## Accessibility

- Gold on leather: **5.2:1** contrast ✓ WCAG AA
- Muted text raised to **#c4a26590** for AA compliance
- Touch targets: minimum **44×44px**
- Focus: gold border + `0 0 0 2px rgba(212,184,106,0.15)` ring
- Color never sole indicator (always paired with text/icon)
- Scrollbar: 4px dark themed

---

## File Structure

```
src/
  styles/tokens.ts          ← Design tokens (single source of truth)
  styles/components.ts      ← Style factory functions
  app/globals.css           ← Resets, animations, utilities
  components/
    layout/AppShell.tsx     ← Page wrapper + responsive
    layout/Navbar.tsx       ← Bottom bar + sidebar
    shared/Kit.tsx          ← Team jersey SVG
    shared/Logo.tsx         ← App icon
    shared/Corners.tsx      ← Decorative frame
    shared/GoldButton.tsx   ← Primary CTA
    shared/MetricBox.tsx    ← KPI card
    shared/ValueBadge.tsx   ← Tag badges
    match/MatchCard.tsx     ← Match list item
    match/MatchDetail.tsx   ← Tabbed detail view
    match/OddsInput.tsx     ← Odds entry
    matchday/BetTracker.tsx ← Bet history
    home/LeagueGrid.tsx     ← Liga selector
    home/SettingsCard.tsx   ← Bankroll/risk
    anna/ChatMessage.tsx    ← Chat bubbles
    anna/LeagueChips.tsx    ← Liga chip selector
    anna/QuickReplies.tsx   ← Budget/risk buttons
    anna/BetCard.tsx        ← Bet suggestion card
```

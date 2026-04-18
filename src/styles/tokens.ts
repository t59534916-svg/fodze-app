// ═══════════════════════════════════════════════════════════════════════
// FODZE Design Tokens — Single Source of Truth
// Replaces 13 arbitrary font sizes & 6 independently declared S objects
// ═══════════════════════════════════════════════════════════════════════

// ─── Colors ──────────────────────────────────────────────────────────

export const color = {
  // Leather (backgrounds)
  leather:    "#1a0f0a",
  leather2:   "#231510",
  leather3:   "#2a1810",
  surface:    "#c4a2650c",   // card background (slightly more visible)
  surfaceHover: "#c4a26515",

  // Gold (accents)
  goldShine:  "#f5e6b8",
  goldLight:  "#e8d5a0",
  gold:       "#d4b86a",
  goldMid:    "#c4a265",
  goldDark:   "#a68940",
  goldDeep:   "#8b7340",
  goldMuted:  "#a89050",      // 4.0:1 (UI components need 3:1) ✓
  goldGhost:  "#c4a26520",   // decorative only, not for text

  // Text (WCAG AA: min 4.5:1 on leather #1a0f0a)
  text:       "#ede4d4",     // 11.2:1 ✓
  textMuted:  "#a89070",     // 4.6:1 ✓ (was #c4a26590 = 1.8:1 ✗)
  textFaint:  "#8a7560",     // 3.2:1 (large text OK, decorative only)

  // Semantic — value (bet-edge green). ONE base hue #6aad55 with explicit
  // alpha tints so hover / bg / border stay visually consistent instead
  // of the earlier drift into 3 near-identical greens (#4a8c3a / #5a8c4a /
  // #6aad55). Use `${color.value}08` pattern for one-off ghost fills.
  value:         "#6aad55",
  valueDark:     "#4a8c3a",    // gradient dark-stop (probability bar home)
  valueMid:      "#5a9e45",    // hover / stronger tint
  valueBg:       "#6aad5510",  // card-size background tint
  valueGhost:    "#6aad5508",  // faintest decorative fill
  valueBorder:   "#6aad5530",  // 1px borders on value cards
  warn:          "#e07070",    // 4.6:1 on leather ✓ (was #c47070 = 3.6:1)
  warnBg:        "#8c4a4a18",
  info:          "#5a9ec4",
  infoBg:        "#4a6e8c15",

  // Borders
  border:     "#c4a26520",
  borderHover: "#c4a26540",
  borderFocus: "#d4b86a60",
} as const;

// ─── Typography ──────────────────────────────────────────────────────

export const fontSize = {
  xs:   11,
  sm:   13,
  base: 16,
  lg:   20,
  xl:   24,
  xxl:  32,
} as const;

export const fontWeight = {
  normal:   400,
  medium:   500,
  semibold: 600,
  bold:     700,
} as const;

export const fontFamily = {
  sans:  "var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono:  "'SF Mono', 'Fira Code', 'Consolas', monospace",
} as const;

export const lineHeight = {
  tight:  1.2,
  normal: 1.5,
  relaxed: 1.7,
} as const;

// ─── Spacing ─────────────────────────────────────────────────────────

export const space = {
  0:  0,
  1:  2,
  2:  4,
  3:  8,
  4:  12,
  5:  16,
  6:  24,
  7:  32,
  8:  48,
} as const;

// ─── Radii ───────────────────────────────────────────────────────────

export const radius = {
  sm:   6,
  md:   10,
  lg:   16,
  full: 999,
} as const;

// ─── Shadows ─────────────────────────────────────────────────────────

export const shadow = {
  subtle:   "0 1px 3px rgba(0,0,0,0.2)",
  card:     "0 2px 8px rgba(0,0,0,0.3)",
  elevated: "0 4px 16px rgba(0,0,0,0.4)",
  glow:     "0 0 12px rgba(212,184,106,0.15)",
} as const;

// ─── Transitions ─────────────────────────────────────────────────────

export const transition = {
  fast:   "150ms ease",
  normal: "250ms ease",
  slow:   "400ms ease",
} as const;

// ─── Breakpoints ─────────────────────────────────────────────────────

export const breakpoint = {
  mobile:  480,
  tablet:  768,
  desktop: 1024,
} as const;

// ─── Layout ──────────────────────────────────────────────────────────

export const layout = {
  maxWidthMobile:  480,
  maxWidthTablet:  720,
  maxWidthDesktop: 960,
  navHeightMobile: 60,
  navWidthTablet:  220,
  cardGap:         12,
  sectionGap:      24,
} as const;

// ─── Z-Index ─────────────────────────────────────────────────────────

export const zIndex = {
  card:     1,
  sticky:   10,
  nav:      100,
  modal:    200,
  toast:    300,
} as const;

# FODZE — Quantitative Fußball-Wettanalyse

Quantitative Wettanalyse mit Dixon-Coles Bivariate Poisson Modell, isotonischer Kalibrierung und Kelly-Criterion Staking.

**v7.0.0** · 61 Dateien · Next.js 14 · TypeScript · Supabase

## Quick Start

```bash
git clone https://github.com/t59534916-svg/fodze-app.git
cd fodze-app
npm install
cp .env.example .env.local   # Keys eintragen
npm run dev                   # http://localhost:3000
```

## Features

| Feature | Beschreibung |
|---------|-------------|
| **Dixon-Coles Engine** | 15×15 Bivariate Poisson mit ρ-Korrektur, Neg-Binomial, XGBoost Residuals |
| **Value-Bet Erkennung** | Edge-Berechnung mit Konfidenzintervallen (90% CI) |
| **Kelly-Criterion** | Optimale Einsatzberechnung (¼/⅓/½ Kelly, capped bei 5%) |
| **System-Wetten** | 2aus3, 3aus4, 4aus5 mit EV und P(Gewinn) |
| **Ask Anna** | KI-Beraterin: Multi-Liga Chat mit Streaming (Groq kostenlos / Claude) |
| **Live-Odds** | Automatischer Quoten-Import via GitHub Actions + The-Odds-API |
| **12 Ligen** | Bundesliga, PL, La Liga, Serie A, Ligue 1, 2.BL, 3.Liga, CL, EL, ... |
| **PWA** | Installierbar, Offline-Cache via Service Worker |

## Architektur

```
src/
  app/               # Next.js 14 App Router (14 Routen)
    page.tsx          # Home — Liga-Auswahl
    matchday/         # Match-Analyse + Quoten + Kombi-Builder
    anna/             # Ask Anna — KI-Wettberaterin
    simulator/        # Monte Carlo Bankroll-Simulation
    performance/      # Modell-Backtest Dashboard (14.359 Spiele)
    api/              # Streaming AI + Matchday + Scraper
  components/         # 23 React-Komponenten
    layout/           # AppShell, Navbar (Mobile + Desktop Sidebar), AuthGate
    match/            # MatchCard (Probability Bar), MatchDetail (Tabs), OddsInput (Auto-Save)
    anna/             # ChatMessage, LeagueChips, BetCard, QuickReplies
    shared/           # Kit, Logo, Corners, GoldButton, ValueBadge, MetricBox
  contexts/           # AppContext (User/Liga/Profil), MatchdayContext (Matches/Odds/Bets)
  hooks/              # useMatchday, useBets
  lib/                # Dixon-Coles Engine (46KB), System-Bets, Supabase, Scrapers
  styles/             # Design Tokens (Leather+Gold), Component Factories
  types/              # TypeScript Interfaces (Match, Calc, Odds, Bet, Profile)
```

## Tech Stack

| Layer | Technologie |
|-------|------------|
| Frontend | Next.js 14 App Router, React 18, TypeScript 5.5, Inter Font |
| Styling | Custom Leather+Gold Token System (inline, kein UI-Framework) |
| State | AppContext + MatchdayContext + sessionStorage |
| Backend | Supabase PostgreSQL + Auth + Row-Level Security |
| AI | Groq Llama 3.3 70B (kostenlos) / Claude Sonnet 4 / Offline |
| Engine | Dixon-Coles + Neg-Binomial + XGBoost + Pinnacle Anchor + SoS |
| CI | GitHub Actions (Lint, TypeCheck, Test, Build) |
| Hosting | Vercel |

## Admin-Workflow

```bash
npm run spieltag    # Interaktiver 6-Schritt Wizard
```

1. **Spielplan** — Prompt generiert → Admin fügt in AI ein
2. **xG-Daten** — Understat Browser-Script oder Tor-Proxy Prompt
3. **Verletzungen** — Prompt an 2-3 AIs parallel für Cross-Check
4. **JSON bauen** — Prompt mit allen Daten → FODZE-Format
5. **Supabase seeden** — Validierung + Bestätigung + Seed
6. **Quoten eingeben** — In der App oder automatisch via Live-Odds

Details: [WORKFLOW.md](WORKFLOW.md)

## Scripts

```bash
npm run dev          # Lokaler Dev-Server
npm run build        # Production Build
npm run test         # vitest (13 Tests für Dixon-Coles Engine)
npm run test:watch   # Watch-Mode
npm run lint         # ESLint
npm run spieltag     # Admin Spieltag-Wizard
```

## Environment Variables

```bash
# Supabase (required)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...

# Ask Anna AI (optional — pick one)
GROQ_API_KEY=gsk_...          # FREE — https://console.groq.com
# CLAUDE_API_KEY=sk-ant-...   # PAID — https://console.anthropic.com
```

## Dokumentation

- **[Architecture](docs/ARCHITECTURE.md)** — System-Diagramm, Data Flow, Engine Pipeline, DB Schema
- **[Design Handoff](docs/DESIGN-HANDOFF.md)** — Tokens, Komponenten, Responsive, Accessibility
- **[Workflow](WORKFLOW.md)** — Admin Spieltag-Workflow mit Prompts
- **[CLAUDE.md](CLAUDE.md)** — Entwickler-Guide für Claude Code

## Qualität

| Metrik | Wert |
|--------|------|
| Build | ✅ 0 Fehler, 19 Routen |
| Tests | ✅ 13/13 (Dixon-Coles Engine) |
| TypeScript | 95% typisiert (52 justified `any`) |
| Accessibility | WCAG 2.1 AA (ARIA, Focus, Landmarks) |
| Security | HSTS, RLS, X-Frame-Options, Permissions-Policy |
| Dependencies | 5 Runtime, 5 Dev |

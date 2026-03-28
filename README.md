# FODZE — Quantitative Fußball-Wettanalyse

Quantitative Wettanalyse mit Dixon-Coles Bivariate Poisson Modell, isotonischer Kalibrierung und Kelly-Criterion Staking.

## Quick Start

```bash
npm install
cp .env.example .env.local  # Keys eintragen
npm run dev                  # http://localhost:3000
```

## Architektur

```
src/
  app/              # Next.js 14 App Router Seiten
    page.tsx         # Home — Liga-Auswahl
    matchday/        # Match-Analyse + Quoten + Kombi-Builder
    anna/            # Ask Anna — KI-Wettberaterin
    simulator/       # Monte Carlo Bankroll-Simulation
    performance/     # Modell-Backtest Dashboard
    api/             # API Routes (anna, matchday, seed-history)
  components/
    layout/          # AppShell, Navbar, AuthGate
    match/           # MatchCard, MatchDetail, OddsInput
    anna/            # ChatMessage, LeagueChips, BetCard
    shared/          # Kit, Logo, Corners, GoldButton, ValueBadge
    home/            # LeagueGrid, SettingsCard
  contexts/          # AppContext, MatchdayContext
  hooks/             # useMatchday, useBets
  lib/               # Dixon-Coles Engine, Supabase, System-Bets
  styles/            # Design Tokens, Component Factories
  types/             # TypeScript Interfaces
```

## Tech Stack

- **Next.js 14** (App Router) + **React 18** + **TypeScript**
- **Supabase** (PostgreSQL + Auth)
- **Groq** (Llama 3.3 70B, kostenlos) oder **Claude** für Ask Anna
- Kein UI-Framework — Custom Leather+Gold Design System

## Features

- **Dixon-Coles Modell** — Bivariate Poisson mit ρ-Korrektur, Home-Faktor, Form-Adjustierung
- **Value-Bet Erkennung** — Edge-Berechnung mit Konfidenzintervallen
- **Kelly-Criterion** — Optimale Einsatzberechnung (¼/⅓/½ Kelly)
- **System-Wetten** — 2aus3, 3aus4, 4aus5 mit EV und P(Gewinn)
- **Ask Anna** — KI-Beraterin mit Multi-Liga-Analyse und Streaming
- **Live-Odds** — Automatischer Quoten-Import via The-Odds-API
- **PWA** — Installierbar, Offline-Cache via Service Worker

## Environment Variables

Siehe `.env.example` für alle benötigten Keys.

## Tests

```bash
npm run test        # vitest (13 Tests für Dixon-Coles Engine)
npm run test:watch  # Watch-Mode
npm run lint        # ESLint
```

## Dokumentation

- **[Architecture](docs/ARCHITECTURE.md)** — System-Übersicht, Data Flow, Prediction Engine, DB Schema
- **[Design Handoff](docs/DESIGN-HANDOFF.md)** — Design Tokens, Komponenten-Specs, Responsive, Accessibility
- **[Workflow](WORKFLOW.md)** — 6-Schritt Daten-Ingestion Prozess


# FODZE Architecture

## System Overview

FODZE ist eine quantitative Fußball-Wettanalyse-Plattform. Der Kern ist ein Dixon-Coles Bivariate Poisson Modell das xG-Daten verarbeitet, Wahrscheinlichkeiten berechnet, und über ein Kelly-Criterion basiertes Staking-System Wettvorschläge generiert.

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  Next.js 16 App Router · React 19 · TypeScript              │
│                                                              │
│  ┌──────┐  ┌──────────┐  ┌───────┐  ┌──────┐  ┌─────┐     │
│  │ Home │  │ Matchday  │  │ Anna  │  │ Sim  │  │Stats│     │
│  │  /   │  │ /matchday │  │/anna  │  │/sim  │  │/perf│     │
│  └──┬───┘  └─────┬─────┘  └───┬───┘  └──────┘  └─────┘     │
│     │            │             │                             │
│  ┌──┴────────────┴─────────────┴──────────────────────┐     │
│  │           Contexts (AppContext, MatchdayContext)     │     │
│  └──┬────────────┬─────────────┬──────────────────────┘     │
│     │            │             │                             │
│  ┌──┴──┐   ┌────┴────┐   ┌───┴───────┐                     │
│  │Hooks│   │Components│   │Shared/UI  │                     │
│  └─────┘   └─────────┘   └───────────┘                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                      API ROUTES                              │
│  POST /api/anna     → Groq/Claude Streaming                 │
│  POST /api/matchday → Claude + Web Search                   │
│  GET  /api/seed-history → Cheerio Scraper                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                    PREDICTION ENGINE                         │
│  src/lib/dixon-coles.ts (46KB)                              │
│                                                              │
│  xG Data → Poisson λ → 15×15 Matrix → Market Probs         │
│       ↓          ↓          ↓             ↓                 │
│  Regression   Home Factor  ρ-Korrektur   Calibration        │
│  SoS          Form         Neg-Binomial  Pinnacle Anchor    │
│  Player Impact XGBoost     Tag Corrections                  │
│                                                              │
│  Output: H/D/A/O25/U25 Probabilities + CI + Edge + Kelly   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                      SUPABASE                                │
│  PostgreSQL + Auth + Row-Level Security                      │
│                                                              │
│  Tables: matchdays · odds_snapshots · bets · profiles       │
│          team_xg_history · live_odds                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Daten-Ingestion
```
Admin → JSON Import / Claude API / Cheerio Scraper
      → saveMatchday(supabase, league, label, data, userId)
      → Supabase matchdays table
```

### 2. Match-Analyse
```
User wählt Liga → loadLatestMatchday(supabase, league)
                → loadLiveOdds(supabase, league)
                → loadOddsHistory(supabase, matchKey)
                → calcMatchEnhanced() für jedes Spiel
                → calculateBetsEnhanced() für Edge/Kelly
                → processed[], valueMatches[], comboLegs[]
```

### 3. Ask Anna
```
User wählt Ligen + Budget + Risiko
→ loadLatestMatchday() für jede Liga
→ calcMatchEnhanced() für alle Matches
→ buildAnnaSystemPrompt() mit allen Berechnungen
→ POST /api/anna (Groq/Claude Streaming)
→ BetCards aus berechneten Daten
```

---

## Prediction Engine

### Dixon-Coles Modell

**Input:** xG-Summen der letzten 8 Heim/Auswärts-Spiele

**Pipeline:**
1. **Raw λ** — xG/games × league_avg
2. **Regression to Mean** — Shrinkage basierend auf Spielanzahl
3. **Home Factor** — Liga-spezifisch + Team-spezifisch (3. Liga)
4. **Form-Adjustment** — Letzte 5 Ergebnisse (W/D/L)
5. **Tag-Corrections** — DERBY (-5% goals), SANDWICH etc.
6. **SoS** — Strength-of-Schedule der Gegner
7. **Player Impact** — Key-Absenzen
8. **XGBoost Residuals** — Systematische Fehlerkorrektur
9. **Negative Binomial** — Overdispersion (mehr 0:0 und High-Score)
10. **ρ-Korrektur** — Dixon-Coles Correlation für niedrige Scores
11. **Pinnacle Anchor** — Adjustierung an scharfe Marktquoten
12. **Isotonische Kalibrierung** — Aus 14.359 Backtest-Spielen

**Output:** 15×15 Score-Matrix → H/D/A/O25/U25/BTTS Probabilities mit Konfidenzintervallen

### Kelly-Criterion Staking

```
Edge = pModel - (1/quote)
Kelly = (p × b - q) / b    wobei b = quote - 1, q = 1 - p
Fractional Kelly = Kelly × {0.25 | 0.33 | 0.5}
Stake = FractionalKelly × Budget
```

---

## Route Structure

| Route | Typ | Zweck |
|-------|-----|-------|
| `/` | Page | Liga-Auswahl, Settings |
| `/matchday` | Page | Match-Analyse, Quoten, Value-Bets |
| `/matchday/combos` | Page | Kombi-Builder, Systemwetten |
| `/anna` | Page | KI-Wettberaterin (Streaming Chat) |
| `/simulator` | Page | Monte Carlo Bankroll-Simulation |
| `/performance` | Page | Modell-Backtest Dashboard |
| `/sgp` | Page | Same-Game-Parlay Builder |
| `/season-sim` | Page | Saison-Simulation |
| `/team/[name]` | Page | Team xG-Trend Detail |
| `/workflow` | Page | Daten-Workflow Anleitung |
| `/api/anna` | API | Groq/Claude Streaming-Proxy |
| `/api/matchday` | API | Claude + Web Search für Spieltag |
| `/api/seed-history` | API | Kicker.de Scraper für 3. Liga |
| `/auth/callback` | API | Supabase OAuth Redirect |

---

## State Management

```
AuthGate
  └─ AppProvider (user, league, profile, bankroll, kellyFraction)
       └─ MatchdayProvider (data, oddsData, processed, valueMatches, comboLegs)
            └─ Pages
                 └─ useMatchday() — thin wrapper
                 └─ useBets() — bet placement + settlement
```

- **AppContext** — Global: User, Liga, Profil, Bankroll, Kalibrierung
- **MatchdayContext** — Spieltag: Rohdaten, Odds, berechnete Matches, Value-Bets, Combo-Legs
- **sessionStorage** — Combo-Auswahl überlebt Navigation

---

## Database Schema

```sql
matchdays (
  id, league, matchday_label, data JSONB, match_date,
  created_at, created_by → auth.users
)

odds_snapshots (
  id, league, match_key, home_team, away_team,
  odds JSONB, snapshot_time, created_by → auth.users
)

bets (
  id, match_key, home_team, away_team, market,
  odds_placed, stake, model_prob, edge,
  result: pending|won|lost, settled_at,
  placed_at, clv, created_by → auth.users
)

profiles (
  id → auth.users, display_name, bankroll,
  risk_profile: K|M|A, updated_at
)

team_xg_history (
  team, opponent, league, venue: home|away,
  match_date, xg, xga, goals_for, goals_against
)

live_odds (
  league, event_id, home_team, away_team,
  commence_time, best_h/d/a, sharp_h/d/a,
  bookmakers JSONB, num_bookmakers, fetched_at
)
```

RLS: Alle Tabellen gesichert. User sehen alle Daten, ändern nur eigene.

---

## Security

- **Auth:** Supabase Auth (Email/Password)
- **RLS:** Row-Level Security auf allen Tabellen
- **Headers:** HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy
- **API Keys:** Server-seitig in .env.local, nie im Client
- **PWA:** Service Worker mit Cache-First für Static, Network-First für API

---

## Key Decisions

| Entscheidung | Begründung |
|-------------|-----------|
| Inline Styles statt CSS-in-JS | Zero Runtime, Type-Safe, kein Dependency |
| Kein UI-Framework | Custom Leather+Gold Theme nicht abbildbar |
| Groq (Llama 3.3) statt OpenAI | Kostenlos, ausreichend für Analyse |
| MatchdayContext statt URL-State | Matchday-Daten zu groß für URL-Params |
| sessionStorage für Combos | Leichtgewichtig, kein Server-Roundtrip |
| Service Worker | PWA Offline-Fähigkeit, Cache für Static Assets |

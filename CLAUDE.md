# CLAUDE.md — Entwickler-Guide für Claude Code

## Was ist FODZE?

Quantitative Fußball-Wettanalyse App. Dixon-Coles Modell berechnet Wahrscheinlichkeiten aus xG-Daten, vergleicht mit Buchmacher-Quoten, findet Value-Bets und berechnet Kelly-Einsätze.

## Projekt starten

```bash
npm install
npm run dev       # http://localhost:3000
npm run test      # 13 Tests (Dixon-Coles Engine)
npm run build     # Production Build
```

## Architektur auf einen Blick

```
Supabase (DB + Auth)
  ↕
Next.js 14 App Router
  ├── Contexts: AppContext (User/Liga) → MatchdayContext (Matches/Odds)
  ├── Pages: / → /matchday → /matchday/combos → /anna → /simulator → /performance
  ├── API: /api/anna (Groq/Claude Streaming), /api/matchday (Claude + Web Search)
  └── Engine: src/lib/dixon-coles.ts (46KB, Prediction Core)
```

## Wichtige Dateien

| Datei | Was es tut | Wann anfassen |
|-------|-----------|---------------|
| `src/lib/dixon-coles.ts` | Prediction Engine (NICHT ändern ohne Tests) | Nur bei Modell-Verbesserungen |
| `src/contexts/MatchdayContext.tsx` | Matchday State + calcMatch | Bei neuen Datenfeldern |
| `src/contexts/AppContext.tsx` | User/Liga/Profil State | Bei neuen User-Settings |
| `src/app/matchday/page.tsx` | Haupt-Analyseseite | Bei UI-Änderungen an Matchday |
| `src/components/match/MatchDetail.tsx` | Tab-System (Überblick/Quoten/Statistik) | Bei neuen Analyse-Features |
| `src/app/anna/page.tsx` | Ask Anna Chat | Bei AI-Flow-Änderungen |
| `src/lib/anna-prompt.ts` | System-Prompt für Anna | Bei Prompt-Tuning |
| `src/styles/tokens.ts` | Design Tokens (Source of Truth) | Bei Design-Änderungen |
| `src/types/match.ts` | TypeScript Interfaces | Bei neuen Datenstrukturen |

## Konventionen

### Styling
- **Inline Styles** mit Token-Referenzen (`color.gold`, `fontSize.sm`, `space[5]`)
- **Kein Tailwind, kein CSS-in-JS** — alles über `src/styles/tokens.ts` + `components.ts`
- Farben: Leather (#1a0f0a) + Gold (#d4b86a) Theme
- Cards: `card()` Factory aus `components.ts`
- Buttons: `button("gold" | "outline" | "ghost")`

### Komponenten
- **"use client"** auf allen Komponenten (Next.js Client Components)
- Props typisieren mit Interfaces aus `@/types/match`
- Shared Components in `src/components/shared/`
- Seitenspezifische in `src/components/match/`, `anna/`, `home/`, `matchday/`

### State
- **AppContext**: User, Liga, Profil, Bankroll — global
- **MatchdayContext**: Matchday-Daten, Odds, berechnete Matches — überlebt Navigation
- **sessionStorage**: Combo-Auswahl — überlebt Seitenwechsel
- **Lokaler State**: UI-State (selectedMatch, showTips, tab)

### Neue Seite hinzufügen
1. `src/app/neue-seite/page.tsx` erstellen
2. `<AppShell>` wrappen
3. Navbar-Tab in `src/components/layout/Navbar.tsx` hinzufügen (falls nötig)

### Neue Berechnung hinzufügen
1. Funktion in `src/lib/dixon-coles.ts` exportieren
2. In `MatchdayContext.tsx` → `calcMatch()` einbinden
3. In `MatchDetail.tsx` anzeigen (passendem Tab)
4. Test in `tests/dixon-coles.test.ts` schreiben

## xG-Daten Format

**KRITISCH**: xG-Werte sind **SUMMEN** über 8 Spiele, NICHT Durchschnitte!

```
xg_h8 = 14.2  ← Summe xG der letzten 8 HEIMSPIELE (Bereich 5-25)
xga_h8 = 8.5  ← Summe xGA kassiert in letzten 8 HEIMSPIELEN
xg_a8 = 10.8  ← Summe xG der letzten 8 AUSWÄRTSSPIELE
xga_a8 = 12.1 ← Summe xGA in letzten 8 AUSWÄRTSSPIELEN
```

Faustregel: Wert / 8 ≈ 0.8–2.5 pro Spiel. Wenn < 5.0 → wahrscheinlich Durchschnitt!

## AI-Integration

```
Priority: GROQ_API_KEY (kostenlos) → CLAUDE_API_KEY (bezahlt) → Offline (Templates)
```

- **Groq**: Llama 3.3 70B, SSE Streaming, OpenAI-kompatibel → transformiert zu Anthropic-Format
- **Claude**: Sonnet 4, native SSE
- **Offline**: `generateOfflineAnalysis()` in anna/page.tsx — rein aus berechneten Daten

## Tests

```bash
npm run test              # Alle Tests
npm run test:watch        # Watch-Mode
npx vitest run --reporter=verbose  # Detailliert
```

Tests decken ab:
- LEAGUES Konfiguration (12 Ligen)
- xG-Daten Validierung
- Vig-Removal (Overround-Berechnung)
- Dixon-Coles λ-Berechnung + Score-Matrix
- Kelly-Criterion Staking
- Home-Factor Lookup

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- Lint → TypeCheck → Test → Build
- Triggered auf Push/PR zu `main`
- Lint + TypeCheck dürfen feilen (continue-on-error)
- Tests + Build müssen bestehen

## Bekannte Einschränkungen

- `ProcessedMatch.calc` ist `any` weil der Dixon-Coles Engine Return-Type zu komplex für ein statisches Interface ist
- `TeamData` hat Index-Signature `[key: string]: any` für dynamischen Key-Zugriff (xg_h8, xg_a8 etc.)
- Standalone-Seiten (Simulator, SGP, Season-Sim) haben eigene Inline-Engines die nicht den zentralen dixon-coles.ts nutzen
- Kein E2E Testing — nur Unit-Tests für die Engine

## Datenbank

```sql
-- Wichtigste Tabellen:
matchdays       -- Spieltag-JSON pro Liga (JSONB)
odds_snapshots  -- Quotenverlauf mit Timestamps
bets            -- Platzierte Wetten + P&L
profiles        -- Bankroll, Risikoprofil
live_odds       -- Auto-Import via GitHub Actions Cron
```

RLS aktiv: User sehen alles, ändern nur eigene Daten.

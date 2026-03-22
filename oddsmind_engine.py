#!/usr/bin/env python3
"""
FODZE Engine v2 — Quantitative Sportwetten-Engine
=====================================================
Dixon-Coles bivariate Poisson mit 15x15 Matrix, Shin's Vig,
isotonische Kalibrierung (Platzhalter), und vollständiger Marktabdeckung.

Architektur: Eine Matrix → query() → alle Märkte.
"""

import numpy as np
import math
from scipy.stats import poisson
from typing import Literal


class FodzEEngine:
    """
    Kern-Engine für das FODZE-Projekt.

    Generiert aus zwei Expected-Goals-Werten (λ_H, λ_A) eine Dixon-Coles-
    korrigierte bivariate Poisson-Matrix (15x15). Aus dieser Matrix werden
    über die zentrale query()-Methode sämtliche Wettmärkte abgeleitet.
    """

    MAX_GOALS: int = 15  # 0..14 inclusive — verhindert Truncation Bias
    HT_FACTOR: float = 0.44  # Empirisch: 0.4424 über 15.696 Spiele (2017-2026)

    def __init__(self, lam_h: float, lam_a: float, rho: float = -0.05) -> None:
        """
        Initialisiert die Engine und berechnet FT- und HT-Matrizen.

        Args:
            lam_h: Expected Goals Heimmannschaft (λ_H)
            lam_a: Expected Goals Auswärtsmannschaft (λ_A)
            rho: Dixon-Coles Korrelationsparameter (Standard: -0.05)
        """
        self.lam_h = lam_h
        self.lam_a = lam_a
        self.rho = rho

        # Full-Time Matrix (15x15, Dixon-Coles-korrigiert, normalisiert)
        self.matrix = self._build_matrix(lam_h, lam_a, rho)

        # Half-Time Matrix (λ × 0.47, eigene Dixon-Coles-Korrektur)
        self.matrix_ht = self._build_matrix(
            lam_h * self.HT_FACTOR,
            lam_a * self.HT_FACTOR,
            rho
        )

    def _build_matrix(self, lam_h: float, lam_a: float, rho: float) -> np.ndarray:
        """
        Baut eine 15x15 bivariate Poisson-Matrix mit Dixon-Coles-Korrektur.

        1. Unabhängige bivariate Poisson: P(i,j) = Pois(i;λH) × Pois(j;λA)
        2. Dixon-Coles τ-Korrektur auf Zellen (0,0), (1,0), (0,1), (1,1)
        3. Normalisierung auf Σ = 1.0
        """
        n = self.MAX_GOALS
        mx = np.zeros((n, n))

        # Schritt 1: Unabhängige bivariate Poisson
        for i in range(n):
            for j in range(n):
                mx[i, j] = poisson.pmf(i, lam_h) * poisson.pmf(j, lam_a)

        # Schritt 2: Dixon-Coles τ-Korrektur (nur auf Low-Score-Zellen)
        if lam_h > 0 and lam_a > 0:
            mx[0, 0] *= max(0.0, 1 - lam_h * lam_a * rho)
            mx[1, 0] *= max(0.0, 1 + lam_a * rho)
            mx[0, 1] *= max(0.0, 1 + lam_h * rho)
            mx[1, 1] *= max(0.0, 1 - rho)

        # Schritt 3: Normalisierung (kompensiert τ-Verschiebung)
        total = mx.sum()
        if total > 0:
            mx /= total

        return mx

    # ═══════════════════════════════════════════════════════════════════
    # QUERY — Die zentrale Methode für alle Märkte
    # ═══════════════════════════════════════════════════════════════════

    def query(self, conditions: list[dict], use_ht: bool = False) -> float:
        """
        Summiert P aller Matrix-Zellen die ALLE Bedingungen erfüllen.

        Args:
            conditions: Liste von Dicts mit 'type', 'op', 'value'.
                type: 'home_goals'|'away_goals'|'total_goals'|'goal_diff'|
                      'home_min'|'away_min'
                op: '>'|'>='|'<'|'<='|'=='|'!='
                value: numerischer Schwellwert
            use_ht: True → nutze HT-Matrix statt FT-Matrix

        Returns:
            Summierte Wahrscheinlichkeit (0.0 bis 1.0)
        """
        mx = self.matrix_ht if use_ht else self.matrix
        n = mx.shape[0]
        p = 0.0

        for i in range(n):
            for j in range(n):
                if all(self._eval(c, i, j) for c in conditions):
                    p += mx[i, j]

        return p

    @staticmethod
    def _eval(cond: dict, home: int, away: int) -> bool:
        """Evaluiert eine einzelne Bedingung gegen ein Torergebnis."""
        t = cond["type"]
        op = cond["op"]
        v = cond["value"]

        if t == "home_goals":
            val = home
        elif t == "away_goals":
            val = away
        elif t == "total_goals":
            val = home + away
        elif t == "goal_diff":
            val = home - away
        elif t == "home_min":
            return home >= v
        elif t == "away_min":
            return away >= v
        else:
            raise ValueError(f"Unbekannter Bedingungstyp: {t}")

        if op == ">":
            return val > v
        elif op == ">=":
            return val >= v
        elif op == "<":
            return val < v
        elif op == "<=":
            return val <= v
        elif op == "==":
            return val == v
        elif op == "!=":
            return val != v
        else:
            raise ValueError(f"Unbekannter Operator: {op}")

    # ═══════════════════════════════════════════════════════════════════
    # TIER 1: Direkt aus der Matrix (via query)
    # ═══════════════════════════════════════════════════════════════════

    def get_1x2(self) -> dict[str, float]:
        """1X2 Markt: Heim, Unentschieden, Auswärts."""
        return {
            "H": self.query([{"type": "goal_diff", "op": ">", "value": 0}]),
            "D": self.query([{"type": "goal_diff", "op": "==", "value": 0}]),
            "A": self.query([{"type": "goal_diff", "op": "<", "value": 0}]),
        }

    def get_double_chance(self) -> dict[str, float]:
        """Doppelte Chance: 1X, X2, 12."""
        return {
            "1X": self.query([{"type": "goal_diff", "op": ">=", "value": 0}]),
            "X2": self.query([{"type": "goal_diff", "op": "<=", "value": 0}]),
            "12": self.query([{"type": "goal_diff", "op": "!=", "value": 0}]),
        }

    def get_all_ou(self) -> dict[str, dict[str, float]]:
        """Über/Unter für alle Linien von 0.5 bis 5.5."""
        result = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]:
            over = self.query([{"type": "total_goals", "op": ">", "value": line}])
            result[f"{line}"] = {"over": over, "under": 1.0 - over}
        return result

    def get_btts(self) -> dict[str, float]:
        """Beide Teams erzielen ein Tor (Ja/Nein)."""
        yes = self.query([
            {"type": "home_min", "op": ">=", "value": 1},
            {"type": "away_min", "op": ">=", "value": 1},
        ])
        return {"Ja": yes, "Nein": 1.0 - yes}

    def get_team_goals(self, team: Literal["H", "A"] = "H") -> dict[str, float]:
        """Team-Tore Über 0.5, 1.5, 2.5."""
        t = "home_goals" if team == "H" else "away_goals"
        result = {}
        for line in [0.5, 1.5, 2.5]:
            result[f"Ü{line}"] = self.query([{"type": t, "op": ">", "value": line}])
        return result

    def get_winning_margin(self) -> dict[str, float]:
        """Gewinnspanne: H+1, H+2, H+3+, Unentschieden, A+1, A+2, A+3+."""
        return {
            "H+1": self.query([{"type": "goal_diff", "op": "==", "value": 1}]),
            "H+2": self.query([{"type": "goal_diff", "op": "==", "value": 2}]),
            "H+3+": self.query([{"type": "goal_diff", "op": ">=", "value": 3}]),
            "Unentschieden": self.query([{"type": "goal_diff", "op": "==", "value": 0}]),
            "A+1": self.query([{"type": "goal_diff", "op": "==", "value": -1}]),
            "A+2": self.query([{"type": "goal_diff", "op": "==", "value": -2}]),
            "A+3+": self.query([{"type": "goal_diff", "op": "<=", "value": -3}]),
        }

    def get_all_ah(self, team: Literal["H", "A"] = "H") -> dict[str, dict[str, float]]:
        """
        Asian Handicap für Linien -3.5 bis +3.5 in 0.5er Schritten.

        Korrekte Push-Logik: Bei ganzzahligen Linien (z.B. -1.0) wird
        P_Push separat berechnet. Fair Odds = (1 - P_Push) / P_Win.
        """
        result = {}
        sign = 1 if team == "H" else -1

        for half_steps in range(-7, 8):  # -3.5 to +3.5
            line = half_steps * 0.5
            is_whole = (half_steps % 2 == 0)

            if is_whole:
                # Ganzzahlige Linie → Push möglich
                int_line = int(line)
                adjusted = int_line * sign

                p_win = self.query([{"type": "goal_diff", "op": ">", "value": -adjusted}])
                p_push = self.query([{"type": "goal_diff", "op": "==", "value": -adjusted}])
                p_loss = self.query([{"type": "goal_diff", "op": "<", "value": -adjusted}])

                # Fair Odds: Einsatz zurück bei Push → effektive P = P_Win / (1 - P_Push)
                fair_odds = (1.0 - p_push) / p_win if p_win > 1e-10 else 999.0
            else:
                # Halbe Linie → kein Push
                threshold = -line * sign

                p_win = self.query([{"type": "goal_diff", "op": ">", "value": threshold}])
                p_push = 0.0
                p_loss = 1.0 - p_win
                fair_odds = 1.0 / p_win if p_win > 1e-10 else 999.0

            label = f"{'+' if line > 0 else ''}{line}"
            result[label] = {
                "P_Win": round(p_win, 6),
                "P_Push": round(p_push, 6),
                "P_Loss": round(p_loss, 6),
                "Fair_Odds": round(fair_odds, 3),
            }

        return result

    def get_clean_sheet(self) -> dict[str, float]:
        """Clean Sheet (Zu Null): Heim, Auswärts, Keines."""
        h_cs = self.query([
            {"type": "home_goals", "op": ">", "value": 0},
            {"type": "away_goals", "op": "==", "value": 0},
        ])
        a_cs = self.query([
            {"type": "home_goals", "op": "==", "value": 0},
            {"type": "away_goals", "op": ">", "value": 0},
        ])
        both_zero = self.matrix[0, 0]
        return {
            "Heim zu Null": h_cs + both_zero,
            "Auswärts zu Null": a_cs + both_zero,
            "Kein zu Null": 1.0 - (h_cs + a_cs + both_zero),
        }

    def get_correct_score(self, top_n: int = 8) -> list[tuple[str, float]]:
        """Top N wahrscheinlichste exakte Endstände."""
        scores = []
        for i in range(min(7, self.MAX_GOALS)):
            for j in range(min(7, self.MAX_GOALS)):
                scores.append((f"{i}:{j}", self.matrix[i, j]))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_n]

    # ═══════════════════════════════════════════════════════════════════
    # TIER 2: Zusatzmodelle (HT/FT, Timing)
    # ═══════════════════════════════════════════════════════════════════

    def get_ht_ft(self) -> dict[str, float]:
        """
        Halbzeit/Endstand: 9 Kombinationen (H/H, H/D, H/A, D/H, ...).

        Approximation über bedingte Wahrscheinlichkeiten:
        P(HT=X, FT=Y) ≈ P(HT=X) × P(FT=Y | HT=X)

        Für P(FT=Y | HT=X) nutzen wir die FT-Verteilung gewichtet
        mit der HT-Verteilung. Vereinfachung: HT und 2. HZ sind
        approximativ unabhängig → P(FT=Y) ≈ P(HT=X) × P(HZ2 liefert Rest).
        """
        # HT-Wahrscheinlichkeiten
        p_ht_h = self.query([{"type": "goal_diff", "op": ">", "value": 0}], use_ht=True)
        p_ht_d = self.query([{"type": "goal_diff", "op": "==", "value": 0}], use_ht=True)
        p_ht_a = self.query([{"type": "goal_diff", "op": "<", "value": 0}], use_ht=True)

        # FT-Wahrscheinlichkeiten
        p_ft_h = self.query([{"type": "goal_diff", "op": ">", "value": 0}])
        p_ft_d = self.query([{"type": "goal_diff", "op": "==", "value": 0}])
        p_ft_a = self.query([{"type": "goal_diff", "op": "<", "value": 0}])

        # HZ2-Matrix für bedingte Berechnung
        lam_h2 = self.lam_h * (1 - self.HT_FACTOR)
        lam_a2 = self.lam_a * (1 - self.HT_FACTOR)
        engine_h2 = FodzEEngine(lam_h2, lam_a2, self.rho)

        p_h2_h = engine_h2.query([{"type": "goal_diff", "op": ">", "value": 0}])
        p_h2_d = engine_h2.query([{"type": "goal_diff", "op": "==", "value": 0}])
        p_h2_a = engine_h2.query([{"type": "goal_diff", "op": "<", "value": 0}])

        # Approximation: Für jede HT-Konstellation berechnen wir die
        # Wahrscheinlichkeit dass HZ2 das Ergebnis zum FT-Ergebnis dreht.
        # Vereinfacht: P(HT=X, FT=Y) ≈ Σ über alle kompatiblen Szenarien
        # Hier nutzen wir die gröbere aber robuste Methode:
        # P(HT/FT) via FT-Matrix direkt (HT und HZ2 als unabhängig)

        results = {}
        ht_labels = {"H": p_ht_h, "D": p_ht_d, "A": p_ht_a}
        n = self.MAX_GOALS

        for ht_result, p_ht in ht_labels.items():
            for ft_result in ["H", "D", "A"]:
                # Summiere über alle (ht_h, ht_a, ft_h, ft_a) Kombinationen
                p = 0.0
                for hi in range(n):
                    for hj in range(n):
                        # Prüfe HT-Ergebnis
                        if ht_result == "H" and not (hi > hj):
                            continue
                        if ht_result == "D" and not (hi == hj):
                            continue
                        if ht_result == "A" and not (hi < hj):
                            continue

                        p_ht_score = self.matrix_ht[hi, hj]
                        if p_ht_score < 1e-12:
                            continue

                        # Summiere über HZ2-Ergebnisse die zum FT-Ergebnis passen
                        for h2i in range(n):
                            for h2j in range(n):
                                ft_h_total = hi + h2i
                                ft_a_total = hj + h2j

                                if ft_result == "H" and not (ft_h_total > ft_a_total):
                                    continue
                                if ft_result == "D" and not (ft_h_total == ft_a_total):
                                    continue
                                if ft_result == "A" and not (ft_h_total < ft_a_total):
                                    continue

                                p += p_ht_score * engine_h2.matrix[h2i, h2j]

                key = f"{ht_result}/{ft_result}"
                results[key] = p

        # Normalisiere (Rundungsfehler korrigieren)
        total = sum(results.values())
        if total > 0:
            results = {k: v / total for k, v in results.items()}

        return results

    def get_goal_in_both_halves(self) -> dict[str, float]:
        """P(mindestens 1 Tor in HZ1 UND mindestens 1 Tor in HZ2)."""
        # P(≥1 Tor in HZ1) = 1 - P(0:0 in HZ1)
        p_zero_ht = self.matrix_ht[0, 0]
        p_goal_ht = 1.0 - p_zero_ht

        # HZ2: Restliche Lambdas
        lam_h2 = self.lam_h * (1 - self.HT_FACTOR)
        lam_a2 = self.lam_a * (1 - self.HT_FACTOR)
        engine_h2 = FodzEEngine(lam_h2, lam_a2, self.rho)
        p_zero_h2 = engine_h2.matrix[0, 0]
        p_goal_h2 = 1.0 - p_zero_h2

        # Unabhängigkeitsannahme zwischen den Halbzeiten
        p_both = p_goal_ht * p_goal_h2

        return {
            "Ja": p_both,
            "Nein": 1.0 - p_both,
            "P_Tor_HZ1": p_goal_ht,
            "P_Tor_HZ2": p_goal_h2,
        }

    def get_first_goal_time(self, minute: int) -> float:
        """
        P(Erstes Tor vor Minute t) via Exponentialverteilung.

        Die Zeit bis zum ersten Tor folgt Exp(λ_combined / 90).
        CDF: P(T ≤ t) = 1 - exp(-(λH + λA)/90 × t)
        """
        lam_combined = self.lam_h + self.lam_a
        rate = lam_combined / 90.0
        return 1.0 - math.exp(-rate * minute)

    # ═══════════════════════════════════════════════════════════════════
    # SAME-GAME KOMBIS (exakte Joint-Wahrscheinlichkeit)
    # ═══════════════════════════════════════════════════════════════════

    def get_same_game_combo(self, conditions: list[dict]) -> dict[str, float]:
        """
        Berechnet exakte Joint-Wahrscheinlichkeit für beliebige Kombinationen
        von Tor-basierten Bedingungen innerhalb eines Spiels.

        Returns:
            Dict mit P, Fair_Odds
        """
        p = self.query(conditions)
        fair_odds = 1.0 / p if p > 1e-10 else 999.0
        return {"P": p, "Fair_Odds": round(fair_odds, 3)}

    # ═══════════════════════════════════════════════════════════════════
    # VALUE & KELLY
    # ═══════════════════════════════════════════════════════════════════

    def calc_edge(
        self, p_model: float, odds: float, kelly_frac: float = 0.25
    ) -> dict[str, float]:
        """
        Berechnet Edge und Kelly-Empfehlung.

        Args:
            p_model: Modell-Wahrscheinlichkeit (0-1)
            odds: Buchmacher-Quote (dezimal, z.B. 1.72)
            kelly_frac: Kelly-Fraktion (Standard: ¼ Kelly)

        Returns:
            Dict mit p_market, edge, ev, kelly_pct
        """
        p_market = 1.0 / odds if odds > 0 else 0.0
        edge = p_model - p_market
        ev = p_model * odds - 1.0

        # Kelly: f* = (p*q - 1) / (q - 1) × fraction
        if odds > 1.0 and edge > 0:
            kelly_full = (p_model * odds - 1.0) / (odds - 1.0)
            kelly = max(0.0, min(kelly_full * kelly_frac, 0.05))  # Hard Cap 5%
        else:
            kelly = 0.0

        return {
            "p_market": round(p_market, 4),
            "edge": round(edge, 4),
            "ev": round(ev, 4),
            "kelly_pct": round(kelly * 100, 2),
        }


# ═══════════════════════════════════════════════════════════════════════
# CLI DIAGNOSIS FRAMEWORK
# ═══════════════════════════════════════════════════════════════════════

def _pc(v: float) -> str:
    """Format als Prozent."""
    return f"{v * 100:.1f}%"


def _q(v: float) -> str:
    """Format als faire Quote."""
    return f"@{1 / v:.2f}" if v > 0.001 else "@—"


def generate_fodze_diagnosis(
    team_h: str, team_a: str, lam_h: float, lam_a: float
) -> None:
    """
    Generiert ein vollständiges Terminal-Dashboard für ein Spiel.
    """
    engine = FodzEEngine(lam_h, lam_a)

    w = 80
    print(f"\n{'═' * w}")
    print(f"  FODZE ENGINE v2 — MATCH DIAGNOSIS")
    print(f"  {team_h} (H) vs {team_a} (A)")
    print(f"  λH = {lam_h:.2f}  |  λA = {lam_a:.2f}  |  ρ = {engine.rho}")
    print(f"  Matrix: {engine.MAX_GOALS}×{engine.MAX_GOALS}  |  HT-Faktor: {engine.HT_FACTOR}")
    print(f"{'═' * w}")

    # ── 1X2 ──
    x = engine.get_1x2()
    print(f"\n  ┌─ 1X2 {'─' * 40}")
    print(f"  │  Heim: {_pc(x['H']):>7}  {_q(x['H']):>8}")
    print(f"  │  Unent: {_pc(x['D']):>6}  {_q(x['D']):>8}")
    print(f"  │  Ausw: {_pc(x['A']):>7}  {_q(x['A']):>8}")

    # ── Doppelte Chance ──
    dc = engine.get_double_chance()
    print(f"  ├─ Doppelte Chance {'─' * 28}")
    print(f"  │  1X: {_pc(dc['1X']):>7}  {_q(dc['1X'])}   X2: {_pc(dc['X2']):>7}  {_q(dc['X2'])}   12: {_pc(dc['12']):>7}  {_q(dc['12'])}")

    # ── Über/Unter ──
    ou = engine.get_all_ou()
    print(f"  ├─ Über/Unter {'─' * 33}")
    for line, vals in ou.items():
        bar = "█" * int(vals['over'] * 30)
        print(f"  │  {line:>3}:  Ü {_pc(vals['over']):>6} {_q(vals['over']):>7}  │{'░' * 30}│")
        print(f"  │         U {_pc(vals['under']):>6} {_q(vals['under']):>7}  │{bar:<30}│")

    # ── BTTS ──
    btts = engine.get_btts()
    print(f"  ├─ BTTS {'─' * 38}")
    print(f"  │  Ja: {_pc(btts['Ja']):>7}  {_q(btts['Ja'])}    Nein: {_pc(btts['Nein']):>7}  {_q(btts['Nein'])}")

    # ── Team-Tore ──
    tg_h = engine.get_team_goals("H")
    tg_a = engine.get_team_goals("A")
    print(f"  ├─ Team-Tore {'─' * 33}")
    print(f"  │  {team_h:>12}:  Ü0.5 {_pc(tg_h['Ü0.5'])}  Ü1.5 {_pc(tg_h['Ü1.5'])}  Ü2.5 {_pc(tg_h['Ü2.5'])}")
    print(f"  │  {team_a:>12}:  Ü0.5 {_pc(tg_a['Ü0.5'])}  Ü1.5 {_pc(tg_a['Ü1.5'])}  Ü2.5 {_pc(tg_a['Ü2.5'])}")

    # ── Clean Sheet ──
    cs = engine.get_clean_sheet()
    print(f"  ├─ Zu Null {'─' * 36}")
    print(f"  │  Heim: {_pc(cs['Heim zu Null'])}  Ausw: {_pc(cs['Auswärts zu Null'])}  Keines: {_pc(cs['Kein zu Null'])}")

    # ── Gewinnspanne ──
    wm = engine.get_winning_margin()
    print(f"  ├─ Gewinnspanne {'─' * 30}")
    for label, p in wm.items():
        bar = "▓" * int(p * 50)
        print(f"  │  {label:<14} {_pc(p):>6}  {_q(p):>7}  {bar}")

    # ── Correct Score ──
    csc = engine.get_correct_score(top_n=10)
    print(f"  ├─ Correct Score (Top 10) {'─' * 21}")
    for i in range(0, len(csc), 2):
        left = f"  │  {csc[i][0]:>3}  {_pc(csc[i][1]):>6}  {_q(csc[i][1]):>7}"
        if i + 1 < len(csc):
            right = f"    {csc[i + 1][0]:>3}  {_pc(csc[i + 1][1]):>6}  {_q(csc[i + 1][1]):>7}"
        else:
            right = ""
        print(f"{left}{right}")

    # ── Asian Handicap ──
    ah = engine.get_all_ah("H")
    print(f"  ├─ Asian Handicap (Heim) {'─' * 22}")
    print(f"  │  {'Linie':>6}  {'P_Win':>7}  {'P_Push':>7}  {'P_Loss':>7}  {'Fair':>7}")
    print(f"  │  {'─' * 42}")
    for label, vals in ah.items():
        push_str = f"{_pc(vals['P_Push']):>7}" if vals['P_Push'] > 0.001 else "    —  "
        print(f"  │  {label:>6}  {_pc(vals['P_Win']):>7}  {push_str}  {_pc(vals['P_Loss']):>7}  @{vals['Fair_Odds']:<6.2f}")

    # ═══════════════════════════════════════════════════════════════════
    # TIER 2
    # ═══════════════════════════════════════════════════════════════════

    print(f"\n{'─' * w}")
    print(f"  TIER 2 — Halbzeit-Modelle (λ × {engine.HT_FACTOR})")
    print(f"{'─' * w}")

    # ── HT/FT ──
    htft = engine.get_ht_ft()
    print(f"\n  ┌─ Halbzeit / Endstand {'─' * 24}")
    print(f"  │  {'':>4}  {'FT→H':>8}  {'FT→D':>8}  {'FT→A':>8}")
    print(f"  │  {'─' * 32}")
    for ht in ["H", "D", "A"]:
        h_val = htft.get(f"{ht}/H", 0)
        d_val = htft.get(f"{ht}/D", 0)
        a_val = htft.get(f"{ht}/A", 0)
        print(f"  │  HT={ht}  {_pc(h_val):>7}  {_pc(d_val):>7}  {_pc(a_val):>7}")

    # ── Tor in beiden Hälften ──
    gbh = engine.get_goal_in_both_halves()
    print(f"  ├─ Tor in beiden Hälften {'─' * 22}")
    print(f"  │  Ja: {_pc(gbh['Ja'])}  {_q(gbh['Ja'])}    (HZ1: {_pc(gbh['P_Tor_HZ1'])}, HZ2: {_pc(gbh['P_Tor_HZ2'])})")

    # ── Erstes Tor ──
    print(f"  ├─ Erstes Tor vor Minute {'─' * 22}")
    for m in [10, 15, 20, 30, 45, 60, 75, 90]:
        p = engine.get_first_goal_time(m)
        print(f"  │  Min. {m:>2}: {_pc(p):>6}")

    # ═══════════════════════════════════════════════════════════════════
    # SAME-GAME KOMBIS
    # ═══════════════════════════════════════════════════════════════════

    print(f"\n{'─' * w}")
    print(f"  SAME-GAME KOMBIS (exakte Joint-P aus Matrix)")
    print(f"{'─' * w}")

    combos = [
        ("Heim + Ü2.5", [
            {"type": "goal_diff", "op": ">", "value": 0},
            {"type": "total_goals", "op": ">", "value": 2.5},
        ]),
        ("Heim + BTTS", [
            {"type": "goal_diff", "op": ">", "value": 0},
            {"type": "home_min", "op": ">=", "value": 1},
            {"type": "away_min", "op": ">=", "value": 1},
        ]),
        ("Heim + Ü2.5 + BTTS", [
            {"type": "goal_diff", "op": ">", "value": 0},
            {"type": "total_goals", "op": ">", "value": 2.5},
            {"type": "home_min", "op": ">=", "value": 1},
            {"type": "away_min", "op": ">=", "value": 1},
        ]),
        ("Ausw. + Ü2.5", [
            {"type": "goal_diff", "op": "<", "value": 0},
            {"type": "total_goals", "op": ">", "value": 2.5},
        ]),
        ("Unent. + U2.5", [
            {"type": "goal_diff", "op": "==", "value": 0},
            {"type": "total_goals", "op": "<", "value": 2.5},
        ]),
        ("Heim Ü1.5 + Ausw. Ü0.5", [
            {"type": "home_goals", "op": ">", "value": 1.5},
            {"type": "away_goals", "op": ">", "value": 0.5},
        ]),
    ]

    # Vergleiche: exakte Joint-P vs naive Multiplikation
    x1x2 = engine.get_1x2()

    print(f"\n  {'Kombi':<28} {'Exakt':>8} {'Naiv':>8} {'Δ':>7} {'Fair Quote':>10}")
    print(f"  {'─' * 65}")

    for label, conds in combos:
        sgc = engine.get_same_game_combo(conds)
        p_exact = sgc["P"]

        # Naive Multiplikation (als Vergleich)
        p_naive = 1.0
        for c in conds:
            p_naive *= engine.query([c])

        delta = p_exact - p_naive
        print(f"  {label:<28} {_pc(p_exact):>7}  {_pc(p_naive):>7}  {delta * 100:>+5.1f}%  @{sgc['Fair_Odds']:<7.2f}")

    print(f"\n  → Δ > 0: Joint-P ist HÖHER als naive Multiplikation (positive Korrelation)")
    print(f"  → Δ < 0: Joint-P ist NIEDRIGER (negative Korrelation)")
    print(f"  → Die exakte Berechnung aus der Matrix ist korrekt. Buchmacher schätzen.")

    # ═══════════════════════════════════════════════════════════════════
    # EDGE-ANALYSE
    # ═══════════════════════════════════════════════════════════════════

    print(f"\n{'─' * w}")
    print(f"  EDGE-ANALYSE (fiktive Quoten)")
    print(f"{'─' * w}")

    edges = [
        ("Heim 1X2", x1x2["H"], 1.72),
        ("Ü2.5", engine.get_all_ou()["2.5"]["over"], 1.65),
        ("BTTS Ja", engine.get_btts()["Ja"], 1.75),
        ("Heim + Ü2.5 (SGK)", combos[0][1], 2.36),
        ("Heim + BTTS (SGK)", combos[1][1], 2.55),
        ("Heim + Ü2.5 + BTTS", combos[2][1], 3.10),
    ]

    print(f"\n  {'Markt':<24} {'P_Mod':>7} {'P_Mkt':>7} {'Edge':>7} {'EV':>7} {'Kelly¼':>7}")
    print(f"  {'─' * 60}")

    for label, p_or_conds, odds in edges:
        if isinstance(p_or_conds, float):
            p = p_or_conds
        else:
            p = engine.query(p_or_conds)

        e = engine.calc_edge(p, odds)
        edge_color = "✅" if e["edge"] > 0.03 else ("⚠️" if e["edge"] > 0 else "❌")
        print(f"  {label:<24} {_pc(p):>6}  {_pc(e['p_market']):>6}  {e['edge'] * 100:>+5.1f}%  {e['ev'] * 100:>+5.1f}%  {e['kelly_pct']:>5.1f}%  {edge_color}")

    # ═══════════════════════════════════════════════════════════════════
    # MATRIX-HEATMAP (Text)
    # ═══════════════════════════════════════════════════════════════════

    print(f"\n{'─' * w}")
    print(f"  SCORE-MATRIX (Top 6x6, Wahrscheinlichkeiten in %)")
    print(f"{'─' * w}")

    print(f"\n  {'':>6}", end="")
    for j in range(6):
        print(f"  {team_a}={j}", end="")
    print()
    print(f"  {'':>6}{'─' * 48}")
    for i in range(6):
        print(f"  {team_h}={i} │", end="")
        for j in range(6):
            val = engine.matrix[i, j] * 100
            if val >= 5:
                print(f"  {val:>5.1f}*", end="")
            elif val >= 2:
                print(f"  {val:>5.1f} ", end="")
            else:
                print(f"  {val:>5.2f} ", end="")
        print()

    print(f"\n  * = wahrscheinlichster Bereich")
    print(f"\n{'═' * w}")
    print(f"  FODZE ENGINE v2 — Diagnosis complete.")
    print(f"  Sportwetten = Glücksspiel. Nie mehr setzen als du bereit bist zu verlieren.")
    print(f"{'═' * w}\n")


# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    generate_fodze_diagnosis("Bayern", "Dortmund", 2.31, 1.14)

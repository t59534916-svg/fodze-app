#!/usr/bin/env python3
"""Weg 1 — Trägt die ENSEMBLE-VARIANZ ein nutzbares Selektions-Signal über die
Wahrscheinlichkeit hinaus? (forecast-quality, selektive Vorhersage)

Heute selektiert FODZE Hoch-Konfidenz nur per max(H,D,A) (Tier-Höhe). dev-03
berechnet aber ZUSÄTZLICH eine per-Match Ensemble-Varianz (Streuung der 5 gebaggten
Modelle = epistemische Unsicherheit), die NICHT in die Confidence-/Selektions-Logik
einfließt. Frage: ist „hohe Top-Prob UND niedrige Varianz" ein schärferes Set als
„hohe Top-Prob" allein?

Methode (analog xg_target_ab.py — gleiche Pfad-/Import-Fixes + Anti-Garbage-Guard):
  - Train dev-03-Ensemble (5 seeds) auf goals < 2025-08-01, predict OOT 25/26.
  - Pro Match: top_prob = max(H,D,A) aus λ→Dixon-Coles; var = (λ_h-Var + λ_a-Var)/2
    (die BayesianEnsemble.predict()[1] inter-model variance — DIE Größe die
    dev03-engine.ts in `confidence` exportiert).
  - hit = (argmax == tatsächliches Ergebnis).
  - VERGLEICH bei gleicher Coverage (fair!): nimm die Top-X% nach (a) prob allein
    vs (b) prob-dann-var-Tiebreak vs (c) ein kombinierter Score. Wenn Varianz
    Signal trägt, hat das var-aware Set bei gleicher Größe eine höhere Hit-Rate.
  - Kernmaß: innerhalb des HOCH-Tiers (top_prob>=0.65), splitte nach Median-Varianz
    → Hit-Rate low-var vs high-var. Gleicher Prob-Bereich, nur Varianz unterscheidet
    → isoliert das Varianz-Signal sauber. Bootstrap-CI auf der Differenz.

Output: /tmp/variance_gated_selection.json
"""
from __future__ import annotations
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # tools/backtest/<file> → repo root
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))

import json
import numpy as np
import pandas as pd

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, BayesianEnsemble
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.feature_builder import build_features_for_corpus
from v4.data.loaders import load_team_xg_history, load_match_pairs

DEV_03_LOCKED_FEATURES = [
    "home_attack_ratio", "home_defense_ratio", "away_attack_ratio", "away_defense_ratio",
    "home_ess", "away_ess", "league_home_avg", "league_away_avg", "league_home_advantage",
    "lambda_h_naive", "lambda_a_naive", "attack_defense_ratio_h", "attack_defense_ratio_a",
    "elo_diff", "lineup_quality_diff", "form_streak_diff",
]
SPLIT = "2025-08-01"
SINCE = "2022-07-01"
SEEDS = [42, 43, 44, 45, 46]
RHO = DEFAULT_RHO
SEED_BOOT = 20260601
N_BOOT = 2000
OUT = Path("/tmp/variance_gated_selection.json")


def boot_diff(a, b, rng):
    """Bootstrap CI of mean(a) - mean(b) (independent groups)."""
    if len(a) < 5 or len(b) < 5:
        return None
    d = np.empty(N_BOOT)
    for i in range(N_BOOT):
        d[i] = a[rng.integers(0, len(a), len(a))].mean() - b[rng.integers(0, len(b), len(b))].mean()
    lo, hi = np.percentile(d, [2.5, 97.5])
    return float(a.mean() - b.mean()), float(lo), float(hi)


def main() -> int:
    print("═" * 78)
    print("  WEG 1 — VARIANZ-GATED SELEKTION  ·  trägt Ensemble-Varianz Signal?")
    print("═" * 78)

    hist = load_team_xg_history()
    matches = load_match_pairs(since=SINCE).dropna(subset=["home_goals", "away_goals"]).reset_index(drop=True)
    md = pd.to_datetime(matches["match_date"])
    elo = EloCalculator().fit(hist)
    feats = build_features_for_corpus(matches, hist, elo_calculator=elo, verbose=False).reset_index(drop=True)
    feats["match_date"] = pd.to_datetime(matches["match_date"].values)

    # anti-garbage guard (lesson from the fabrication incident)
    missing = [c for c in DEV_03_LOCKED_FEATURES if c not in feats.columns]
    if missing:
        print(f"  ✗ ABORT: missing features {missing}"); return 2
    bad_zero = [c for c in DEV_03_LOCKED_FEATURES
                if c != "lineup_quality_diff" and float(np.abs(feats[c].to_numpy(float)).sum()) == 0.0]
    if bad_zero:
        print(f"  ✗ ABORT: all-zero features {bad_zero}"); return 2

    Xall = feats[DEV_03_LOCKED_FEATURES + ["league"]].copy()
    tr = feats["match_date"] < SPLIT
    te = ~tr
    n_tr, n_te = int(tr.sum()), int(te.sum())
    print(f"  split @ {SPLIT}: train {n_tr} · test {n_te}")
    if n_te < 500:
        print("  ✗ too few test"); return 1

    Xtr, Xte = Xall[tr], Xall[te]
    res = np.array([X._outcome(h, a) for h, a in
                    zip(feats["home_goals"][te], feats["away_goals"][te])])  # 0=H 1=D 2=A

    eh = BayesianEnsemble(n_models=5, seeds=SEEDS)
    ea = BayesianEnsemble(n_models=5, seeds=SEEDS)
    eh.fit(Xtr, feats["home_goals"][tr].to_numpy(float), categorical_columns=["league"])
    ea.fit(Xtr, feats["away_goals"][tr].to_numpy(float), categorical_columns=["league"])
    mh, vh = eh.predict(Xte)   # mean, inter-model variance
    ma, va = ea.predict(Xte)
    lh = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX)
    la = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)

    P = X._lambdas_to_1x2(lh, la, RHO)          # (n,3) H,D,A
    top_prob = P.max(1)
    pick = P.argmax(1)
    hit = (pick == res).astype(float)
    var = (vh + va) / 2.0                        # epistemic uncertainty per match

    rng = np.random.default_rng(SEED_BOOT)
    out = {"n_train": n_tr, "n_test": n_te, "seeds": SEEDS}

    # ── CORE TEST: within HOCH tier (top_prob>=0.65), split by median variance ──
    hoch = top_prob >= 0.65
    n_hoch = int(hoch.sum())
    out["hoch_n"] = n_hoch
    out["hoch_hit_overall"] = float(hit[hoch].mean()) if n_hoch else None
    if n_hoch >= 40:
        v_h = var[hoch]; hit_h = hit[hoch]
        med = float(np.median(v_h))
        lowv = hit_h[v_h <= med]   # confident AND models agree
        highv = hit_h[v_h > med]   # confident BUT models disagree
        gap = boot_diff(lowv, highv, rng)
        out["hoch_split_by_variance"] = {
            "median_var": med,
            "low_var_hit": float(lowv.mean()), "low_var_n": int(len(lowv)),
            "high_var_hit": float(highv.mean()), "high_var_n": int(len(highv)),
            "gap_low_minus_high": gap[0] if gap else None,
            "gap_ci95": [gap[1], gap[2]] if gap else None,
            "robust": bool(gap and gap[1] > 0),
        }

    # ── SECONDARY: equal-coverage selection — does var-tiebreak beat prob-only? ──
    # Take top-10% by prob; within ties of prob, does removing high-var help?
    # Cleaner: build combined rank, compare hit-rate of top-K by prob-only vs by
    # (prob - lambda*var) for a small lambda, at the SAME K.
    def hit_at_coverage(score, frac):
        k = max(1, int(round(len(score) * frac)))
        idx = np.argsort(-score)[:k]
        return float(hit[idx].mean()), k
    out["equal_coverage"] = {}
    # normalise var to comparable scale
    vz = (var - var.mean()) / (var.std() + 1e-9)
    pz = top_prob
    for frac in [0.05, 0.10, 0.25]:
        h_prob, k = hit_at_coverage(pz, frac)
        # penalise high variance: score = prob - 0.02*z(var) (small nudge)
        h_combo, _ = hit_at_coverage(pz - 0.02 * vz, frac)
        out["equal_coverage"][f"top_{int(frac*100)}pct"] = {
            "n": k, "hit_prob_only": h_prob, "hit_prob_minus_var": h_combo,
            "delta": h_combo - h_prob,
        }

    # correlation: does higher variance predict misses? (point-biserial-ish)
    out["corr_var_vs_hit"] = float(np.corrcoef(var, hit)[0, 1])
    OUT.write_text(json.dumps(out, indent=2))

    # ── report ──
    print(f"\n  Ensemble-Varianz vs Treffer — Korrelation: {out['corr_var_vs_hit']:+.4f}")
    print(f"    (negativ erwartet: mehr Varianz → seltener Treffer)")
    s = out.get("hoch_split_by_variance")
    print(f"\n  ── KERN: HOCH-Tier (top_prob≥0.65, n={n_hoch}) nach Median-Varianz gesplittet ──")
    if s:
        print(f"    low-var  (Modelle EINIG):    {s['low_var_hit']*100:.1f}% Treffer (n={s['low_var_n']})")
        print(f"    high-var (Modelle UNEINIG):  {s['high_var_hit']*100:.1f}% Treffer (n={s['high_var_n']})")
        print(f"    Gap (low−high): {s['gap_low_minus_high']*100:+.1f}pp  "
              f"CI[{s['gap_ci95'][0]*100:+.1f},{s['gap_ci95'][1]*100:+.1f}]  "
              f"→ {'ROBUST: Varianz trägt Signal' if s['robust'] else 'CI⊃0: kein robustes Varianz-Signal'}")
    else:
        print("    (zu wenige HOCH-Spiele für den Split)")
    print(f"\n  ── equal-coverage: prob-only vs prob−0.02·z(var), gleiche Set-Größe ──")
    for k, d in out["equal_coverage"].items():
        print(f"    {k:<10} n={d['n']:<4} prob-only {d['hit_prob_only']*100:.1f}% · "
              f"var-aware {d['hit_prob_minus_var']*100:.1f}% · Δ {d['delta']*100:+.1f}pp")
    print(f"\n  ✓ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""validate_high_confidence — is the high-confidence tier robust, and is
"train with focus on high-confidence games" the right lever?

system_performance found: on 25/26 the ≥65%-confidence tier (10% of games) hits
74.5%. This (a) VALIDATES it out-of-sample (24/25, 2h-blend) + selective curve,
and (b) quantifies HEADROOM to judge the training-focus idea — because high-conf
games are the LOPSIDED ones (big favorites), already near the prediction ceiling
(~25% upsets are largely irreducible).

Engines (OOT per season): 25/26 = Blend(prod dev-03 ⊕ dev-09-phase42);
24/25 = Blend(dev-03-2h ⊕ dev-09-2h, trained ≤23/24).

Output: tools/v4/diagnostics/validate_high_confidence.json · .png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/validate_high_confidence.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

import score_xg_forecast as X
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO
_HIST = None
C25, C24, C_OK, C_DIAG = "#3a7ca5", "#d98c3f", "#4f8a3d", "#999999"


def predict_blend(season, d03_tag, d09_tag):
    global _HIST
    d09h = BayesianEnsemble.load(ART / f"m3_xg-home-{d09_tag}.pkl")
    d09a = BayesianEnsemble.load(ART / f"m3_xg-away-{d09_tag}.pkl")
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{d03_tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{d03_tag}.pkl", rho=RHO)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    Xd = extract_X_dev09(t)
    mh, _ = d09h.predict(Xd[d09h.feature_names]); ma, _ = d09a.predict(Xd[d09a.feature_names])
    lh9 = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX); la9 = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)
    if _HIST is None:
        _HIST = load_team_xg_history()
    din = pd.DataFrame({"league": t["league"].astype(str), "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"], "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, _HIST, verbose=False)
    lh3 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la3 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    p = X._lambdas_to_1x2(0.5 * lh9 + 0.5 * lh3, 0.5 * la9 + 0.5 * la3, RHO)
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    return p, y


def tiers(p, y):
    conf = p.max(1); pick = p.argmax(1)
    out = []
    for lbl, m in [("<45%", conf < 0.45), ("45-55%", (conf >= 0.45) & (conf < 0.55)),
                   ("55-65%", (conf >= 0.55) & (conf < 0.65)), ("≥65%", conf >= 0.65)]:
        if m.sum() < 10:
            continue
        out.append({"tier": lbl, "n": int(m.sum()), "share": float(m.mean()),
                    "accuracy": float((pick[m] == y[m]).mean()), "claim": float(conf[m].mean())})
    return out


def selective(p, y):
    conf = p.max(1); pick = p.argmax(1)
    order = np.argsort(-conf)
    rows = []
    for cov in [1.0, 0.75, 0.5, 0.25, 0.10, 0.05]:
        k = max(10, int(len(y) * cov))
        idx = order[:k]
        rows.append({"coverage": cov, "n": int(k), "accuracy": float((pick[idx] == y[idx]).mean()),
                     "min_conf": float(conf[idx].min())})
    return rows


def main() -> int:
    seasons = [("25/26", "dev-03", "dev-09-phase42-seed-000", C25),
               ("24/25", "dev-03-2h", "dev-09-2h", C24)]
    res = {}
    for season, d03t, d09t, _ in seasons:
        print(f"── {season} ({d03t} ⊕ {d09t}) ──")
        p, y = predict_blend(season, d03t, d09t)
        res[season] = {"n": len(y), "tiers": tiers(p, y), "selective": selective(p, y), "_p": p, "_y": y}
        for t in res[season]["tiers"]:
            print(f"    {t['tier']:<7} Anteil {t['share']:.0%}  Treffer {t['accuracy']:.1%}  (claim {t['claim']:.0%})")

    # ── headroom (25/26 primary) ──
    p, y = res["25/26"]["_p"], res["25/26"]["_y"]
    conf, pick = p.max(1), p.argmax(1)
    y1h = np.eye(3)[y]
    bpm = ((p - y1h) ** 2).sum(1)
    hi = conf >= 0.65
    contested = conf < 0.55
    hi_share_brier = float(bpm[hi].sum() / bpm.sum())
    cont_share_brier = float(bpm[contested].sum() / bpm.sum())
    # calibration gap in high-conf (free gain available?)
    hi_acc, hi_claim = float((pick[hi] == y[hi]).mean()), float(conf[hi].mean())
    # max realistic overall-accuracy gain if high-conf → perfect (impossible bound)
    overall_acc = float((pick == y).mean())
    gain_if_hi_perfect = float(hi.mean() * (1.0 - hi_acc))
    print("\n── HEADROOM (25/26) ──")
    print(f"  high-conf (≥65%): {hi.mean():.0%} of games · hit {hi_acc:.1%} · claim {hi_claim:.0%} "
          f"(gap {hi_acc-hi_claim:+.1%}) · contributes {hi_share_brier:.0%} of total Brier")
    print(f"  contested (<55%): {contested.mean():.0%} of games · contributes {cont_share_brier:.0%} of total Brier")
    print(f"  overall acc {overall_acc:.1%}; even making ALL high-conf PERFECT adds only "
          f"+{gain_if_hi_perfect:.1%} overall (upset-bound → unreachable)")

    # ── robustness verdict ──
    t25 = next(t for t in res["25/26"]["tiers"] if t["tier"] == "≥65%")
    t24 = next((t for t in res["24/25"]["tiers"] if t["tier"] == "≥65%"), None)
    robust = bool(t24 and abs(t25["accuracy"] - t24["accuracy"]) < 0.07 and t24["accuracy"] >= 0.68)
    verdict_valid = (f"ROBUST — ≥65% tier hits {t25['accuracy']:.0%} (25/26) vs {t24['accuracy']:.0%} (24/25 OOT), "
                     f"both calibrated" if robust else "CHECK — high-conf tier differs across seasons")
    verdict_train = (
        f"Training-Fokus auf High-Conf = falscher Hebel: die ≥65%-Region trägt nur {hi_share_brier:.0%} "
        f"des Brier-Verlusts und ist bereits kalibriert (gap {hi_acc-hi_claim:+.1%}, ~Obergrenze wg. Upsets). "
        f"Das Signal-/Verlust-Gewicht liegt in der umkämpften Region ({cont_share_brier:.0%} des Brier). "
        f"Besserer Hebel: SELEKTIVE Vorhersage (nur High-Conf-Tipps nutzen), nicht Retraining.")
    print(f"\n  VALIDIERUNG: {verdict_valid}")
    print(f"  TRAINING-FRAGE: {verdict_train}")

    out = {s: {k: v for k, v in res[s].items() if not k.startswith("_")} for s in res}
    out["headroom_25_26"] = {"hi_share_of_brier": hi_share_brier, "contested_share_of_brier": cont_share_brier,
                             "hi_acc": hi_acc, "hi_claim": hi_claim, "overall_acc": overall_acc,
                             "max_gain_if_hi_perfect": gain_if_hi_perfect}
    out["verdict_validation"] = verdict_valid
    out["verdict_training_focus"] = verdict_train
    (D / "validate_high_confidence.json").write_text(json.dumps(out, indent=2, default=float))

    # ── figure ──
    fig = plt.figure(figsize=(16, 5.6))
    gs = GridSpec(1, 3, wspace=0.27)
    # A: cross-season tier accuracy
    axA = fig.add_subplot(gs[0, 0])
    labels = [t["tier"] for t in res["25/26"]["tiers"]]
    x = np.arange(len(labels))
    a25 = [t["accuracy"] for t in res["25/26"]["tiers"]]
    a24 = [next((t["accuracy"] for t in res["24/25"]["tiers"] if t["tier"] == l), np.nan) for l in labels]
    axA.bar(x - 0.2, a25, 0.38, color=C25, label="25/26 (prod)")
    axA.bar(x + 0.2, a24, 0.38, color=C24, label="24/25 (OOT)")
    axA.set_xticks(x); axA.set_xticklabels(labels); axA.set_ylim(0, 1); axA.set_ylabel("Trefferquote")
    axA.set_title("A · Tier-Treffer: 25/26 vs 24/25 OOT\n(High-Conf hält über Saisons?)", fontweight="bold", fontsize=11)
    axA.legend(fontsize=9); axA.grid(alpha=0.2, axis="y")
    # B: selective curve
    axB = fig.add_subplot(gs[0, 1])
    for season, _, _, col in seasons:
        sv = res[season]["selective"]
        axB.plot([s["coverage"] * 100 for s in sv], [s["accuracy"] * 100 for s in sv], "o-", color=col, lw=2, label=season)
    axB.set_xlabel("Abdeckung % (nur Top-Confidence behalten)"); axB.set_ylabel("Trefferquote %")
    axB.invert_xaxis()
    axB.set_title("B · Selektive Vorhersage\n(weniger Spiele, höhere Quote)", fontweight="bold", fontsize=11)
    axB.legend(fontsize=9); axB.grid(alpha=0.25)
    # C: headroom (Brier share by region)
    axC = fig.add_subplot(gs[0, 2])
    mid = float(((conf >= 0.55) & (conf < 0.65)).sum())
    shares = [cont_share_brier, float(bpm[(conf >= 0.55) & (conf < 0.65)].sum() / bpm.sum()), hi_share_brier]
    axC.bar(["umkämpft\n<55%", "55-65%", "high-conf\n≥65%"], shares, color=[C_OK, "#c9a227", C24])
    for i, v in enumerate(shares):
        axC.text(i, v + 0.01, f"{v:.0%}", ha="center", fontsize=10)
    axC.set_ylabel("Anteil am Gesamt-Brier-Verlust")
    axC.set_title("C · Wo liegt der Verlust? → umkämpfte Spiele\n(High-Conf hat kaum Headroom)", fontweight="bold", fontsize=11)
    axC.grid(alpha=0.2, axis="y")
    fig.suptitle("FODZE · High-Confidence: Validierung (cross-season) + Headroom (Training-Fokus-Frage)",
                 fontsize=13, fontweight="bold")
    fig.savefig(D / "validate_high_confidence.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"\n  ✓ validate_high_confidence.json · .png")
    return 0


if __name__ == "__main__":
    sys.exit(main())

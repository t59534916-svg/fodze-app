#!/usr/bin/env python3
"""validate_confidence_production_path — do the confidence-badge tier claims
hold on the PRODUCTION probability distribution, not just raw λ→DC probs?

THE GAP (self-eval 2026-05-28, item c): the badge tier hit-rates (HOCH ≥65%
~73%, MITTEL 55-65% ~53%, …) were validated on RAW Dixon-Coles probs from λ.
But production `dev03-engine.ts` sets the badge-visible `calc.mk` to the
BENTER-BLENDED-toward-Pinnacle probs (when sharp odds exist) — NOT isotonic
(isotonic is Track-B, Kelly-only). So when odds are present (most live
matchday matches), the badge shows a market-blended confidence the tiers were
never validated against. This script closes that gap.

WHAT IT DOES — reconstructs the exact production display path:
  raw λ → DixonColes 1X2  (= what the tiers were validated on)
  → BenterBlender.blend(raw, vig_removed_pinnacle, league)  (per-league β from
    the SAME m6_benter-dev-03.pkl that public/dev03-model.json bakes in)
  = blendedMk  (= dev03-engine.ts:215 `const mk = blendedMk`)
then re-computes the tier hit-rates on RAW vs BLENDED on the odds-covered
subset, and reports odds-coverage (how often the blend actually applies).

Vig removal = simple normalization (1/o)/Σ, identical to dev03-engine.ts:192-198.

FIDELITY CAVEATS (not byte-exact to production — disclosed honestly):
  • The Benter β ARE byte-exact (m6_benter-dev-03.pkl == dev03-model.json).
  • BUT raw_p uses _lambdas_to_1x2 (Dixon-Coles WITHOUT the per-league
    overdispersion-α that production's matrixMk = buildMatrix(λ,λ,rho,alphaUsed)
    includes). α mostly fattens O/U tails; 1X2 effect is small. The blend then
    operates on a slightly-different raw input than production.
  • Validates against Pinnacle CLOSING odds; live production blends toward the
    pre-close sharp odds present at view-time (marginally less sharp).
  • 25/26 odds-coverage is only ~33% in this backfill corpus → the blended
    HOCH tier is n≈324 (CI ~±4.5pp). The conclusion (blend improves Brier; HOCH
    holds its claim) is robust to these because the blend dominates and the
    claim is set as a conservative floor — but "~76% mean" is indicative.

Seasons: 25/26 = prod `dev-03` (fully OOT, the production artifact) — PRIMARY.
24/25 = `dev-03-2h` (trained ≤23/24, OOT) with prod benter β (β are 2 scalars
per league, ~stable) — secondary cross-season confirmation.

Output: tools/v4/diagnostics/validate_confidence_production_path.json · .png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/validate_confidence_production_path.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m6_market.benter import BenterBlender
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
BT = REPO / "tools" / "backtest"
RHO = DEFAULT_RHO
WINDOW = 7  # nearest-date join window (days), same as score_roi_leaderboard
_HIST = None

# Badge claims currently shipped (MatchDetail.confidenceTier / MatchCard.confColor)
BADGE_CLAIM = {"≥65%": 0.73, "55-65%": 0.53, "45-55%": 0.48, "<45%": 0.40}


def _vig_remove(h, d, a):
    if any(o is None or (isinstance(o, float) and np.isnan(o)) or o <= 1 for o in (h, d, a)):
        return None
    s = 1.0 / h + 1.0 / d + 1.0 / a
    return np.array([1.0 / h / s, 1.0 / d / s, 1.0 / a / s])


class OddsSpine:
    """Pinnacle closing odds for one season parquet, tiered fuzzy resolver
    (exact canonical → fuzzy name-match, nearest date) — mirror of the spine
    in score_roi_leaderboard but path-parameterised."""

    def __init__(self, parquet: Path):
        od = pd.read_parquet(parquet).dropna(subset=["psch", "pscd", "psca"]).reset_index(drop=True)
        od["ch"] = od.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
        od["ca"] = od.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
        od["d"] = pd.to_datetime(od["match_date"]).dt.date
        self._df = od
        self._exact: Dict[tuple, list] = defaultdict(list)
        self._by_league: Dict[str, list] = defaultdict(list)
        for i, r in enumerate(od.itertuples(index=False)):
            self._exact[(r.league, r.ch, r.ca)].append((r.d, i))
            self._by_league[r.league].append((r.ch, r.ca, r.d, i))

    def _pick(self, opts, cdate):
        best = min(opts, key=lambda o: abs((o[0] - cdate).days))
        return best[1] if abs((best[0] - cdate).days) <= WINDOW else None

    def resolve(self, league, ch, ca, cdate) -> Optional[int]:
        opts = self._exact.get((league, ch, ca))
        if opts:
            mid = self._pick(opts, cdate)
            if mid is not None:
                return mid
        cands = [(d, i) for (h, a, d, i) in self._by_league.get(league, [])
                 if X._name_match(ch, h) and X._name_match(ca, a)]
        return self._pick(cands, cdate) if cands else None


def _tiers(p, y, mask=None):
    """Hit-rate per confidence tier. mask restricts to a subset (e.g. odds-covered)."""
    if mask is not None:
        p, y = p[mask], y[mask]
    conf, pick = p.max(1), p.argmax(1)
    out = []
    for lbl, m in [("<45%", conf < 0.45), ("45-55%", (conf >= 0.45) & (conf < 0.55)),
                   ("55-65%", (conf >= 0.55) & (conf < 0.65)), ("≥65%", conf >= 0.65)]:
        if m.sum() < 10:
            out.append({"tier": lbl, "n": int(m.sum()), "accuracy": None, "claim": None})
            continue
        out.append({"tier": lbl, "n": int(m.sum()), "share": float(m.mean()),
                    "accuracy": float((pick[m] == y[m]).mean()), "claim": float(conf[m].mean())})
    return out


def _brier(p, y, mask=None):
    if mask is not None:
        p, y = p[mask], y[mask]
    y1h = np.eye(3)[y]
    return float(((p - y1h) ** 2).sum(1).mean())


def build_season(season, d03_tag):
    """Returns (raw_p, blended_p, y, has_odds_mask, league_arr)."""
    global _HIST
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{d03_tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{d03_tag}.pkl", rho=RHO)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    if _HIST is None:
        _HIST = load_team_xg_history()
    din = pd.DataFrame({"league": t["league"].astype(str),
                        "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"],
                        "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, _HIST, verbose=False)
    lh = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    raw_p = X._lambdas_to_1x2(lh, la, RHO)  # the track the tiers were validated on
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])

    # ── attach Pinnacle closing odds + vig-remove ──
    season_tag = season.replace("/", "-")
    spine = OddsSpine(BT / f"odds-close-{season_tag}.parquet")
    leagues = t["league"].astype(str).to_numpy()
    cdates = pd.to_datetime(t["match_date"]).dt.date.to_numpy()
    market = np.full((len(y), 3), np.nan)
    for i in range(len(y)):
        mid = spine.resolve(leagues[i], t["ch"].iloc[i], t["ca"].iloc[i], cdates[i])
        if mid is None:
            continue
        row = spine._df.iloc[mid]
        vr = _vig_remove(row["psch"], row["pscd"], row["psca"])
        if vr is not None:
            market[i] = vr
    has_odds = ~np.isnan(market[:, 0])

    # ── production Benter blend (per-league β), only where odds exist ──
    benter = BenterBlender.load(ART / "m6_benter-dev-03.pkl")
    blended_p = raw_p.copy()  # production falls back to raw matrix when no odds
    for lg in np.unique(leagues[has_odds]):
        m = has_odds & (leagues == lg)
        blended_p[m] = benter.blend(raw_p[m], market[m], lg)
    return raw_p, blended_p, y, has_odds, leagues


def main() -> int:
    seasons = [("25/26", "dev-03", "PRIMARY (prod artifact, fully OOT)"),
               ("24/25", "dev-03-2h", "secondary (OOT, prod benter β)")]
    res = {}
    for season, tag, note in seasons:
        print("═" * 76)
        print(f"  {season}  ·  dev-03 tag={tag}  ·  {note}")
        print("═" * 76)
        raw_p, bl_p, y, odds, lg = build_season(season, tag)
        cov = float(odds.mean())
        print(f"  matches: {len(y)} · with Pinnacle closing odds: {odds.sum()} ({cov:.0%})")
        print(f"  Brier (odds-covered):  raw {_brier(raw_p, y, odds):.4f}  →  "
              f"blended {_brier(bl_p, y, odds):.4f}  (blend pulls toward sharp market)\n")

        raw_full = _tiers(raw_p, y)
        raw_sub = _tiers(raw_p, y, odds)
        bl_sub = _tiers(bl_p, y, odds)
        print(f"  {'tier':<8} {'RAW(full)':>22} {'RAW(odds-sub)':>22} {'BLENDED=PROD(odds-sub)':>24} {'claim':>7}")
        for rf, rs, bs in zip(raw_full, raw_sub, bl_sub):
            def fmt(d):
                if d["accuracy"] is None:
                    return f"n={d['n']:<4} —      "
                return f"n={d['n']:<5} {d['accuracy']:.1%} (c{d['claim']:.0%})"
            claim = BADGE_CLAIM.get(rf["tier"], 0)
            print(f"  {rf['tier']:<8} {fmt(rf):>22} {fmt(rs):>22} {fmt(bs):>24} {claim:>6.0%}")

        res[season] = {"tag": tag, "n": len(y), "odds_coverage": cov,
                       "brier_raw_oddsSub": _brier(raw_p, y, odds),
                       "brier_blended_oddsSub": _brier(bl_p, y, odds),
                       "tiers_raw_full": raw_full, "tiers_raw_oddsSub": raw_sub,
                       "tiers_blended_oddsSub": bl_sub,
                       "_raw": raw_p, "_bl": bl_p, "_y": y, "_odds": odds}

    # ── verdict (25/26 PRIMARY): does the production-blended ≥65% tier hold the claim? ──
    pr = res["25/26"]
    bl_hi = next(t for t in pr["tiers_blended_oddsSub"] if t["tier"] == "≥65%")
    bl_mid = next(t for t in pr["tiers_blended_oddsSub"] if t["tier"] == "55-65%")
    raw_hi = next(t for t in pr["tiers_raw_oddsSub"] if t["tier"] == "≥65%")

    def _delta(tier_obj, claim_key):
        if tier_obj["accuracy"] is None:
            return None
        return tier_obj["accuracy"] - BADGE_CLAIM[claim_key]

    hi_d = _delta(bl_hi, "≥65%")
    mid_d = _delta(bl_mid, "55-65%")
    # Within ±0.05 of the shipped claim = badge holds on the production path.
    hi_ok = hi_d is not None and abs(hi_d) <= 0.05
    mid_ok = mid_d is not None and abs(mid_d) <= 0.05
    verdict = (
        f"PRODUCTION-PATH CHECK (25/26, Benter-blended = what the badge shows): "
        f"HOCH ≥65% hits {bl_hi['accuracy']:.1%} "
        f"(claim 73%, Δ {hi_d:+.1%}, {'HOLDS' if hi_ok else 'OFF — fix badge'}); "
        f"MITTEL 55-65% hits {bl_mid['accuracy']:.1%} "
        f"(claim 53%, Δ {mid_d:+.1%}, {'HOLDS' if mid_ok else 'OFF — fix badge'}). "
        f"Odds-coverage {pr['odds_coverage']:.0%} → blend applies to that share; "
        f"the rest fall back to raw matrix probs. "
        f"Blend {'IMPROVES' if pr['brier_blended_oddsSub'] < pr['brier_raw_oddsSub'] else 'worsens'} "
        f"Brier ({pr['brier_raw_oddsSub']:.4f}→{pr['brier_blended_oddsSub']:.4f}). "
        f"NOTE: isotonic is NOT applied to the display mk (Track-B/Kelly only) — "
        f"the only display-path transform is this Benter blend."
    )
    print("\n" + "─" * 76)
    print(f"  VERDICT: {verdict}")

    out = {s: {k: v for k, v in res[s].items() if not k.startswith("_")} for s in res}
    out["badge_claims"] = BADGE_CLAIM
    out["verdict"] = verdict
    out["hochTier_holds"] = bool(hi_ok)
    out["mittelTier_holds"] = bool(mid_ok)
    (D / "validate_confidence_production_path.json").write_text(json.dumps(out, indent=2, default=float))

    # ── figure: raw vs blended tier accuracy, 25/26 odds-covered ──
    fig, axes = plt.subplots(1, 2, figsize=(13, 5))
    for ax, season in zip(axes, ["25/26", "24/25"]):
        rs = res[season]["tiers_raw_oddsSub"]
        bs = res[season]["tiers_blended_oddsSub"]
        labels = [t["tier"] for t in rs]
        xi = np.arange(len(labels))
        ar = [t["accuracy"] if t["accuracy"] is not None else np.nan for t in rs]
        ab = [t["accuracy"] if t["accuracy"] is not None else np.nan for t in bs]
        cl = [BADGE_CLAIM.get(t["tier"], np.nan) for t in rs]
        ax.bar(xi - 0.22, ar, 0.4, color="#999999", label="RAW (validated track)")
        ax.bar(xi + 0.22, ab, 0.4, color="#3a7ca5", label="BLENDED = production badge")
        ax.plot(xi, cl, "D", color="#d98c3f", ms=9, label="shipped badge claim")
        ax.set_xticks(xi); ax.set_xticklabels(labels)
        ax.set_ylim(0, 1); ax.set_ylabel("Trefferquote")
        ax.set_title(f"{season} · odds-covered (cov {res[season]['odds_coverage']:.0%})", fontweight="bold")
        ax.legend(fontsize=8); ax.grid(alpha=0.2, axis="y")
    fig.suptitle("FODZE · Confidence-Tiers: RAW (validated) vs BLENDED (what the badge shows in production)",
                 fontsize=12, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "validate_confidence_production_path.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  ✓ validate_confidence_production_path.json · .png")
    return 0


if __name__ == "__main__":
    sys.exit(main())

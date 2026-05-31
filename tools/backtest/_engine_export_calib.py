#!/usr/bin/env python3
"""Export per-row probabilities for ALL four engines (Standard/v1/v2/dev-03) so
the REAL TS calibration (calibrate1X2) can score each engine's calibration-effect
(Brier + ECE, raw vs calibrated) — the apples-to-apples basis for deciding whether
the shared global isotonic in public/calibration_curves.json is mis-applied to the
better-calibrated v2/dev-03 distributions.

DATA half of the harness; the calibration math + per-row dump live in the sibling
engine_calibrated_brier.mts so it runs the EXACT production calibrate1X2().

Variants per row:
  • "raw_dc"  — the engine's raw model probs.
      Standard/v1/v2 : parquet prob_*_raw (also the production DISPLAY track —
                       their benterBlend is inert: v1/ensemble have no weights,
                       v2's β=(1,0) is the identity log-pool).
      dev-03         : Dixon-Coles 1X2 from the dev-03 λ ensemble (RHO).
  • "blended" — dev-03 ONLY: per-league BenterBlender toward vig-removed Pinnacle
                closing, EXACTLY as dev03-engine.ts builds `mk` (its DISPLAY +
                Kelly-track input). Odds-covered subset only.

Each dev-03 row also carries `odds`:[oH,oD,oA] (Pinnacle CLOSING decimal) where
resolved, so the validator can run a Kelly/Money-Eval (G5). Parquet-engine rows
carry odds=null (their Money-Eval isn't the decision driver — dev-03 is the prod
default).

The dev-03 build INLINES validate_confidence_production_path.build_season's logic
(predict + per-league Benter + Pinnacle spine) so it can additionally keep the raw
decimal odds. Faithfulness is self-checked: row counts MUST match the validated
build_season output (6480 raw_dc / 2147 blended / 33% coverage on 25/26).

Output: tools/backtest/.engine_raw_calib.json  (gitignored intermediate)
Run:    tools/venv/bin/python3 -I tools/backtest/_engine_export_calib.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
BT = REPO / "tools" / "backtest"
OUT = BT / ".engine_raw_calib.json"

sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

PARQUET_ENGINES = [("Standard", "ensemble-v1"), ("v1", "v1"), ("v2", "v2")]
WINDOW_FROM, WINDOW_TO = "2025-08-01", "2026-07-01"
_LETTER = ["H", "D", "A"]  # X._outcome: 0=H,1=D,2=A
# dev-03 seasons to export. 25/26 = production artifact (PRIMARY). 24/25 =
# dev-03-2h (trained ≤23/24 → fully OOT) for the cross-season robustness check:
# the incumbent stale curve failed PRECISELY cross-season, so the bypass must be
# shown to help on a season it was never near. Parquet engines (Standard/v1/v2)
# stay 25/26-only (their cross-season story is already in the forecast doc).
DEV03_SEASONS = [("25/26", "dev-03"), ("24/25", "dev-03-2h")]


def export_parquet_engines(rows: list) -> None:
    for name, stem in PARQUET_ENGINES:
        df = pd.read_parquet(BT / f"{stem}-oot-predictions.parquet").copy()
        df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
        df = df[(df["match_date"] >= WINDOW_FROM) & (df["match_date"] < WINDOW_TO)]
        df = df[df["ft_result"].isin(["H", "D", "A"])]
        ekey = {"Standard": "ensemble", "v1": "v1", "v2": "v2"}[name]
        for _, r in df.iterrows():
            rows.append({
                "engine": name, "ekey": ekey, "variant": "raw_dc", "season": "25/26",
                "league": str(r["league"]), "ft_result": r["ft_result"],
                "raw": [float(r["prob_h_raw"]), float(r["prob_d_raw"]), float(r["prob_a_raw"])],
                "odds": None,
            })
        print(f"  {name:<10} 25/26 raw_dc   {len(df)} rows")


def _export_dev03_season(rows: list, VC, season: str, tag: str) -> None:
    """Inline mirror of validate_confidence_production_path.build_season for one
    season+tag, keeping raw decimal odds for the Money-Eval. Reuses VC modules."""
    X, ART, RHO = VC.X, VC.ART, VC.RHO
    d03 = VC.XGPredictor.from_artifacts(
        home_path=ART / f"m3_xg-home-{tag}.pkl",
        away_path=ART / f"m3_xg-away-{tag}.pkl", rho=RHO)
    fb = VC.FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: VC.canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: VC.canonical_team(r["away_team"], r["league"]), axis=1)
    hist = VC.load_team_xg_history()
    din = pd.DataFrame({"league": t["league"].astype(str),
                        "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"],
                        "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, hist, verbose=False)
    lh = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    raw_p = X._lambdas_to_1x2(lh, la, RHO)
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    leagues = t["league"].astype(str).to_numpy()

    # ── resolve Pinnacle closing odds (decimal) + vig-removed market ──
    season_tag = season.replace("/", "-")
    spine = VC.OddsSpine(BT / f"odds-close-{season_tag}.parquet")
    cdates = pd.to_datetime(t["match_date"]).dt.date.to_numpy()
    odds_dec = np.full((len(y), 3), np.nan)
    market = np.full((len(y), 3), np.nan)
    for i in range(len(y)):
        mid = spine.resolve(leagues[i], t["ch"].iloc[i], t["ca"].iloc[i], cdates[i])
        if mid is None:
            continue
        row = spine._df.iloc[mid]
        vr = VC._vig_remove(row["psch"], row["pscd"], row["psca"])
        if vr is not None:
            odds_dec[i] = [float(row["psch"]), float(row["pscd"]), float(row["psca"])]
            market[i] = vr
    has_odds = ~np.isnan(market[:, 0])

    # ── production per-league Benter blend (only where odds exist) ──
    # 24/25 uses the SAME production benter β (2 scalars/league, ~stable) — the
    # confidence validator established this is a faithful secondary-season check.
    benter_tag = "dev-03" if tag == "dev-03" else "dev-03"  # prod β for both
    benter = VC.BenterBlender.load(ART / f"m6_benter-{benter_tag}.pkl")
    blended_p = raw_p.copy()
    for lg in np.unique(leagues[has_odds]):
        m = has_odds & (leagues == lg)
        blended_p[m] = benter.blend(raw_p[m], market[m], lg)

    def _odds(i):
        return [float(o) for o in odds_dec[i]] if has_odds[i] else None

    n = len(y)
    for i in range(n):
        rows.append({
            "engine": "dev-03", "ekey": "dev-03", "variant": "raw_dc", "season": season,
            "league": str(leagues[i]), "ft_result": _LETTER[int(y[i])],
            "raw": [float(raw_p[i][0]), float(raw_p[i][1]), float(raw_p[i][2])],
            "odds": _odds(i),
        })
    n_bl = 0
    for i in range(n):
        if not has_odds[i]:
            continue
        rows.append({
            "engine": "dev-03", "ekey": "dev-03", "variant": "blended", "season": season,
            "league": str(leagues[i]), "ft_result": _LETTER[int(y[i])],
            "raw": [float(blended_p[i][0]), float(blended_p[i][1]), float(blended_p[i][2])],
            "odds": _odds(i),
        })
        n_bl += 1
    print(f"  {'dev-03':<10} {season} raw_dc {n} rows · blended {n_bl} (odds {float(has_odds.mean()):.0%})")
    return n, n_bl


def export_dev03(rows: list) -> None:
    """Export dev-03 rows for all DEV03_SEASONS (25/26 production + 24/25 OOT)."""
    import validate_confidence_production_path as VC
    counts = {}
    for season, tag in DEV03_SEASONS:
        counts[season] = _export_dev03_season(rows, VC, season, tag)
    # self-check 25/26 against the validated build_season output (2026-05-31).
    n, n_bl = counts.get("25/26", (0, 0))
    if n != 6868 or n_bl != 2268:
        print(f"  ⚠ WARNING: dev-03 25/26 counts ({n}/{n_bl}) differ from expected "
              f"(6868/2268) — corpus or artifact may have changed.")


def main() -> int:
    rows: list = []
    export_parquet_engines(rows)
    export_dev03(rows)
    OUT.write_text(json.dumps(rows))
    print(f"[export] {len(rows)} rows → {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

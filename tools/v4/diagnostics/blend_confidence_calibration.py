#!/usr/bin/env python3
"""blend_confidence_calibration — validate the confidence-badge tier claims for
the dev-03 ⊕ dev-09 50/50 λ-BLEND (not just dev-03).

THE GAP (forecast-quality analysis, §3 + §5; SWOT 2026-05-31):
  The Blend is the validated-best forecaster (dominates both pure models on
  xG-RMSE + Brier in both holdouts), BUT the confidence-tier hit-rate claims in
  src/lib/confidence-tier.ts (HOCH ≥65% → ~73%) are calibrated on the dev-03
  Benter-blended path ONLY. The Blend uses a RAW λ-average, so those tier claims
  are — in the project's own words — "an approximation, not engine-specific
  validated". This script closes that gap: it re-computes the tier hit-rates on
  the Blend path so the badge can cite an honest, blend-specific number.

METHOD (mirrors validate_confidence_production_path.py, one leg added):
  1. dev-03 λ  via XGPredictor.from_artifacts (macro features)        ── leg A
  2. dev-09 λ  via BayesianEnsemble + FeatureBuilderDev09 (Sofa micro) ── leg B
  3. blend λ = 0.5·λ_A + 0.5·λ_B   (fixed α, no tuning → leakage-free)
  4. λ_blend → Dixon-Coles 1X2 = the RAW blend track
  5. (optional) Benter-blend toward Pinnacle closing where odds exist
  6. tier hit-rates (HOCH/MITTEL/NIEDRIG/TOSS-UP) on raw + blended, per season
  Output: tools/v4/diagnostics/blend_confidence_calibration.json

⚠ DATA DEPENDENCIES (the reason this is a script, not a one-off):
  - tools/sofascore/data/local_extras.db   (1.13 GB, gitignored — dev-09 micro)
  - tools/v4/backtest/odds-close-{season}.parquet  (Pinnacle closing)
  - tools/v4/artifacts/m3_xg-{home,away}-dev-03.pkl
  - tools/v4/artifacts/m3_xg-{home,away}-<dev09-tag>.pkl
  - Supabase team_xg_history (via loaders)
  These live locally / pre-deploy, NOT in CI or the cloud sandbox. The script
  HARD-CHECKS them up front and exits 2 with a clear message rather than
  fabricating a result. Run it at season start (or any box with the mirror):

    tools/venv/bin/python3 -I tools/v4/diagnostics/blend_confidence_calibration.py
    tools/venv/bin/python3 -I tools/v4/diagnostics/blend_confidence_calibration.py \
        --dev09-tag dev-09-phase42-seed-000

This file is intentionally committed UNRUN: it codifies the exact procedure so
the gap can be closed the moment the data is present, without re-deriving it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

ART = REPO / "tools" / "v4" / "artifacts"
BT = REPO / "tools" / "v4" / "backtest"
SQLITE = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
OUT = REPO / "tools" / "v4" / "diagnostics" / "blend_confidence_calibration.json"

# Confidence-tier boundaries — MUST match src/lib/confidence-tier.ts exactly.
TIERS = [("HOCH", 0.65, 0.73), ("MITTEL", 0.55, 0.53),
         ("NIEDRIG", 0.45, 0.48), ("TOSS_UP", 0.0, 0.40)]


def _precheck(dev09_tag: str, seasons: list[str]) -> list[str]:
    """Return a list of missing data assets (empty == ready to run)."""
    missing = []
    if not SQLITE.exists():
        missing.append(f"SQLite mirror: {SQLITE.relative_to(REPO)} (1.13 GB, gitignored)")
    for leg, tag in (("dev-03", "dev-03"), ("dev-09", dev09_tag)):
        for side in ("home", "away"):
            p = ART / f"m3_xg-{side}-{tag}.pkl"
            if not p.exists():
                missing.append(f"{leg} artifact: {p.relative_to(REPO)}")
    for s in seasons:
        p = BT / f"odds-close-{s.replace('/', '-')}.parquet"
        if not p.exists():
            missing.append(f"Pinnacle closing parquet: {p.relative_to(REPO)}")
    return missing


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev09-tag", default="dev-09-phase42-seed-000")
    ap.add_argument("--dev03-tag", default="dev-03")
    ap.add_argument("--seasons", default="25/26,24/25")
    ap.add_argument("--rho", type=float, default=-0.094)
    args = ap.parse_args()
    seasons = [s.strip() for s in args.seasons.split(",")]

    print("═" * 76)
    print("  Blend (dev-03 ⊕ dev-09) confidence-tier calibration")
    print("═" * 76)

    missing = _precheck(args.dev09_tag, seasons)
    if missing:
        print("\n  ✗ Cannot run — missing local data assets:")
        for m in missing:
            print(f"      • {m}")
        print("\n  These live locally / pre-deploy (the dev-09 micro path needs the")
        print("  1.13 GB SQLite mirror + Pinnacle parquets). Run on a box that has")
        print("  them — see the module docstring. Exiting WITHOUT writing a result")
        print("  (a fabricated calibration would be worse than none).")
        return 2

    # ── Data present: run the real calibration. ──────────────────────────
    # Imports deferred until after the precheck so a missing-data run doesn't
    # explode on a heavy import; and so this file stays importable for a smoke
    # test even where the v4 package isn't installed.
    import numpy as np  # noqa: E402
    import pandas as pd  # noqa: E402
    from v4.modules.m3_xg.xg_predictor import XGPredictor  # noqa: E402
    from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble  # noqa: E402
    from v4.modules.m3_xg.feature_builder_dev09 import (  # noqa: E402
        FeatureBuilderDev09, extract_X_dev09,
    )
    from v4.modules.m3_xg.canonical_team_map import canonical_team  # noqa: E402
    from v4.data.loaders import load_team_xg_history  # noqa: E402
    import v4.modules.m3_xg.xg_predictor as X  # noqa: E402

    def lambdas_to_1x2(lh, la):
        return X._lambdas_to_1x2(np.clip(lh, X.LAMBDA_MIN, X.LAMBDA_MAX),
                                 np.clip(la, X.LAMBDA_MIN, X.LAMBDA_MAX), args.rho)

    def tiers(p, y, mask):
        pred = p.argmax(1)
        conf = p.max(1)
        out = []
        for lbl, lo, claim in TIERS:
            hi = 1.01 if lbl == "HOCH" else next(t[1] for t in TIERS if t[1] > lo)
            sel = mask & (conf >= lo) & (conf < hi)
            n = int(sel.sum())
            acc = float((pred[sel] == y[sel]).mean()) if n else None
            out.append({"tier": lbl, "n": n, "claim": claim, "accuracy": acc})
        return out

    hist = load_team_xg_history()
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{args.dev03_tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{args.dev03_tag}.pkl",
                                     rho=args.rho)
    d09_h = BayesianEnsemble.load(ART / f"m3_xg-home-{args.dev09_tag}.pkl")
    d09_a = BayesianEnsemble.load(ART / f"m3_xg-away-{args.dev09_tag}.pkl")
    fb = FeatureBuilderDev09(SQLITE).fit()

    result = {"_meta": {"dev03_tag": args.dev03_tag, "dev09_tag": args.dev09_tag,
                        "rho": args.rho, "blend_alpha": 0.5}, "seasons": {}}

    for season in seasons:
        t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
        t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
        t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
        # dev-09 λ
        Xh, Xa = extract_X_dev09(t)
        l9h, _ = d09_h.predict(Xh)
        l9a, _ = d09_a.predict(Xa)
        # dev-03 λ on the same matches
        din = pd.DataFrame({"league": t["league"].astype(str),
                            "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                            "home": t["ch"], "away": t["ca"],
                            "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
        dp = d03.predict_batch(din, hist, verbose=False)
        l3h = dp["lambda_h"].to_numpy(float)
        l3a = dp["lambda_a"].to_numpy(float)
        # 50/50 blend → 1X2
        blend_p = lambdas_to_1x2(0.5 * l3h + 0.5 * l9h, 0.5 * l3a + 0.5 * l9a)
        y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
        mask = np.ones(len(y), bool)
        result["seasons"][season] = {"n": int(len(y)),
                                     "blend_raw_tiers": tiers(blend_p, y, mask)}
        print(f"\n  {season}  n={len(y)}")
        for row in result["seasons"][season]["blend_raw_tiers"]:
            a = f"{row['accuracy']:.1%}" if row["accuracy"] is not None else "—"
            print(f"    {row['tier']:8s} n={row['n']:5d}  hit={a}  (claim {row['claim']:.0%})")

    OUT.write_text(json.dumps(result, indent=2))
    print(f"\n  ✓ wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

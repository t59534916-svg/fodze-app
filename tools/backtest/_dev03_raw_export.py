#!/usr/bin/env python3
"""Export dev-03 (the NEW DEFAULT) raw matrix 1X2 + outcome on the 25/26 corpus,
so the real TS calibrate1X2 can measure the Kelly-track calibration effect on
dev-03 directly (not inferred from v2). dev-03's actual Kelly input is the
Benter-blended-toward-Pinnacle probs (even BETTER calibrated than this raw
matrix), so the calibration distortion measured here is a LOWER BOUND on the
real effect.

Output: tools/backtest/.dev03_raw.json
"""
from __future__ import annotations
import json, sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))
import numpy as np, pandas as pd
import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

ART = REPO / "tools" / "v4" / "artifacts"
SQLITE = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
RHO = DEFAULT_RHO

d03 = XGPredictor.from_artifacts(home_path=ART / "m3_xg-home-dev-03.pkl",
                                 away_path=ART / "m3_xg-away-dev-03.pkl", rho=RHO)
fb = FeatureBuilderDev09(SQLITE).fit()
t = fb.build_corpus(seasons=("25/26",), leagues=None, verbose=False)
t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
din = pd.DataFrame({"league": t["league"].astype(str),
                    "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                    "home": t["ch"], "away": t["ca"],
                    "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
dp = d03.predict_batch(din, load_team_xg_history(), verbose=False)
lh = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
la = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
P = X._lambdas_to_1x2(lh, la, RHO)
y = [X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])]
rows = [{"engine": "dev-03", "ekey": "dev-03", "league": str(t["league"].iloc[i]),
         "ft_result": ["H", "D", "A"][y[i]], "raw": [float(P[i, 0]), float(P[i, 1]), float(P[i, 2])]}
        for i in range(len(t))]
(REPO / "tools" / "backtest" / ".dev03_raw.json").write_text(json.dumps(rows))
print(f"[dev03-export] {len(rows)} rows")

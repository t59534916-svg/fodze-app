#!/usr/bin/env python3
"""Export raw 1X2 probs for the parquet engines (Standard/v1/v2) so the REAL TS
calibration (calibrate1X2(benterBlend(raw))) can score their PRODUCTION-DISPLAY
Brier — the apples-to-apples basis for the default-engine decision. The forecast
leaderboard ranked engines on RAW probs (where Standard is worst, +0.120 bias);
this checks whether the production calibration — which helps the most
mis-calibrated engine most — re-ranks them.

Output: tools/backtest/.engine_raw.json  (gitignored intermediate)
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
BT = REPO / "tools" / "backtest"
OUT = BT / ".engine_raw.json"

# (display name, parquet stem, benterBlend engine key)
ENGINES = [("Standard", "ensemble-v1", "ensemble"), ("v1", "v1", "v1"), ("v2", "v2", "v2")]
WINDOW_FROM, WINDOW_TO = "2025-08-01", "2026-07-01"


def main() -> int:
    rows = []
    for name, stem, ekey in ENGINES:
        df = pd.read_parquet(BT / f"{stem}-oot-predictions.parquet")
        df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
        df = df[(df["match_date"] >= WINDOW_FROM) & (df["match_date"] < WINDOW_TO)]
        df = df[df["ft_result"].isin(["H", "D", "A"])]
        for _, r in df.iterrows():
            rows.append({"engine": name, "ekey": ekey, "league": str(r["league"]),
                         "ft_result": r["ft_result"],
                         "raw": [float(r["prob_h_raw"]), float(r["prob_d_raw"]), float(r["prob_a_raw"])]})
        print(f"  {name:<10} {len(df)} rows")
    OUT.write_text(json.dumps(rows))
    print(f"[export] {len(rows)} rows → {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

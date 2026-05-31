#!/usr/bin/env python3
"""Export raw 1X2 probs for the parquet engines so the REAL TS calibration can
score per-engine raw-vs-calibrated Brier + ECE (calibration mis-fit audit)."""
import json
from pathlib import Path
import pandas as pd
REPO = Path(__file__).resolve().parents[2]; BT = REPO / "tools" / "backtest"
ENGINES = [("Standard", "ensemble-v1", "ensemble"), ("v1", "v1", "v1"), ("v2", "v2", "v2")]
rows = []
for name, stem, ekey in ENGINES:
    df = pd.read_parquet(BT / f"{stem}-oot-predictions.parquet")
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
    df = df[(df["match_date"] >= "2025-08-01") & (df["match_date"] < "2026-07-01")]
    df = df[df["ft_result"].isin(["H", "D", "A"])]
    for _, r in df.iterrows():
        rows.append({"engine": name, "ekey": ekey, "league": str(r["league"]), "ft_result": r["ft_result"],
                     "raw": [float(r["prob_h_raw"]), float(r["prob_d_raw"]), float(r["prob_a_raw"])]})
    print(f"  {name:<10} {len(df)} rows")
(BT / ".engine_raw.json").write_text(json.dumps(rows))
print(f"[export] {len(rows)} rows")

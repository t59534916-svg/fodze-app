#!/usr/bin/env python3
"""B1 of the runtime-faithful conformal re-fit (option B).

Exports the v2 OOT raw 1X2 probabilities + league + outcome to JSON so the
REAL TypeScript runtime calibration (benterBlend → calibrate1X2) can be run on
them by conformal_runtime_calibrate.mts (B2). We deliberately do NOT calibrate
here — reimplementing calibrate1X2 in Python is the mismatch we're eliminating.

Output: tools/backtest/.conformal_raw.json  (gitignored intermediate)
Run:    tools/venv/bin/python3 tools/backtest/_conformal_export_raw.py
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
PARQUET = REPO / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUT = REPO / "tools" / "backtest" / ".conformal_raw.json"

# Same OOT window the production fit uses (fit_conformal.py:198).
WINDOW_FROM, WINDOW_TO = "2025-08-01", "2026-07-01"


def main() -> int:
    df = pd.read_parquet(PARQUET)
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
    df = df[(df["match_date"] >= WINDOW_FROM) & (df["match_date"] < WINDOW_TO)].copy()
    df = df[df["ft_result"].isin(["H", "D", "A"])].copy()
    df = df.sort_values("match_date").reset_index(drop=True)  # chronological for temporal split

    rows = [
        {
            "league": str(r["league"]),
            "match_date": r["match_date"],
            "ft_result": r["ft_result"],
            "raw": [float(r["prob_h_raw"]), float(r["prob_d_raw"]), float(r["prob_a_raw"])],
        }
        for _, r in df.iterrows()
    ]
    OUT.write_text(json.dumps(rows))
    print(f"[B1] exported {len(rows)} rows ({WINDOW_FROM}→{WINDOW_TO}) → {OUT.relative_to(REPO)}")
    print(f"[B1] leagues: {df['league'].nunique()} · date span {df['match_date'].min()}…{df['match_date'].max()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

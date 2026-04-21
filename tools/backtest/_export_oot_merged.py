#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Cross-Engine OOT — Parquet → JSONL bridge
═══════════════════════════════════════════════════════════════════

Merges the two OOT parquets produced by the Python training +
odds-snapshot pipeline into a single newline-delimited JSON file
that Node can stream without pulling in a parquet reader:

  v2-oot-predictions.parquet  (prob_*_raw + ft_result + league + date)
  odds-close-oot.parquet      (psch / pscd / psca Pinnacle close)

                                │
                                ▼
                   v2-oot-merged.jsonl
                   (one row per OOT match)

The join is a LEFT join on (league, match_date, home_team, away_team) —
rows without Pinnacle close are kept (prediction-side only; Benter
blend falls back to passthrough at runtime for these).

Schema of each output line:
  {
    "match_date": "2023-08-04",
    "league": "championship",
    "home_team": "Sheffield Weds",
    "away_team": "Southampton",
    "prob_h_raw": 0.4230,
    "prob_d_raw": 0.3113,
    "prob_a_raw": 0.2657,
    "ft_result": "A",
    "psch": 2.1,   // may be null
    "pscd": 3.4,   // may be null
    "psca": 3.75   // may be null
  }

Usage:
  tools/venv/bin/python tools/backtest/_export_oot_merged.py
  tools/venv/bin/python tools/backtest/_export_oot_merged.py \\
      --predictions tools/backtest/v2-oot-predictions.parquet \\
      --odds        tools/backtest/odds-close-oot.parquet \\
      --out         tools/backtest/v2-oot-merged.jsonl

No side effects beyond writing --out.
═══════════════════════════════════════════════════════════════════
"""

import argparse
import json
import os
import sys

import pandas as pd

PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_PRED = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-predictions.parquet")
DEFAULT_ODDS = os.path.join(PROJECT_ROOT, "tools", "backtest", "odds-close-oot.parquet")
DEFAULT_OUT = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-merged.jsonl")

# Only the columns a downstream engine actually needs. Excluding the 21-dim
# feature vector + lambda predictions keeps the JSONL ~5× smaller without
# losing any information a runtime engine consumes.
KEEP_COLS = [
    "match_date", "league", "home_team", "away_team",
    "prob_h_raw", "prob_d_raw", "prob_a_raw",
    "ft_result",
]


def main() -> None:
    ap = argparse.ArgumentParser(description="Merge OOT predictions + Pinnacle close into JSONL.")
    ap.add_argument("--predictions", default=DEFAULT_PRED)
    ap.add_argument("--odds",        default=DEFAULT_ODDS)
    ap.add_argument("--out",         default=DEFAULT_OUT)
    args = ap.parse_args()

    if not os.path.exists(args.predictions):
        raise SystemExit(
            f"predictions parquet not found: {args.predictions}\n"
            f"regenerate via: tools/venv/bin/python tools/retrain_v2.py --no-optuna "
            f"--skip-public-export --use-full-csv --use-tactics --use-players --use-roster --use-shots"
        )
    if not os.path.exists(args.odds):
        # Odds snapshot is optional — predictions-only merge is still useful
        # for v2_raw + v2_dirichlet evaluation.
        print(f"  [warn] odds parquet not found: {args.odds} — Benter blend will passthrough everywhere")
        odds_df = pd.DataFrame(columns=["league", "match_date", "home_team", "away_team", "psch", "pscd", "psca"])
    else:
        odds_df = pd.read_parquet(args.odds)

    pred_df = pd.read_parquet(args.predictions)
    print(f"  loaded {len(pred_df)} predictions, {len(odds_df)} odds rows")

    pred_df = pred_df[[c for c in KEEP_COLS if c in pred_df.columns]].copy()
    # Normalize to ISO date strings — downstream Node uses them as opaque keys.
    pred_df["match_date"] = pd.to_datetime(pred_df["match_date"]).dt.date.astype(str)

    if len(odds_df) > 0:
        odds_df = odds_df.copy()
        odds_df["match_date"] = pd.to_datetime(odds_df["match_date"]).dt.date.astype(str)
        # Odds snapshot sometimes contains exact-duplicate rows (same match, same
        # Pinnacle close); a naive left-merge would multiply prediction rows by
        # the duplicate count. Dedupe on (league, date, home, away) first so the
        # output row count equals the prediction row count.
        keys = ["league", "match_date", "home_team", "away_team"]
        before = len(odds_df)
        odds_df = odds_df.drop_duplicates(subset=keys, keep="first")
        dropped = before - len(odds_df)
        if dropped:
            print(f"  deduped {dropped} duplicate odds rows")
        merged = pred_df.merge(
            odds_df[keys + ["psch", "pscd", "psca"]],
            on=keys,
            how="left",
        )
    else:
        merged = pred_df.assign(psch=None, pscd=None, psca=None)

    hit = int(merged["psch"].notna().sum())
    print(f"  merged: {len(merged)} rows ({hit} with Pinnacle close, "
          f"{len(merged) - hit} prediction-only)")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        for _, row in merged.iterrows():
            rec = {
                "match_date": row["match_date"],
                "league": row["league"],
                "home_team": row["home_team"],
                "away_team": row["away_team"],
                "prob_h_raw": float(row["prob_h_raw"]),
                "prob_d_raw": float(row["prob_d_raw"]),
                "prob_a_raw": float(row["prob_a_raw"]),
                "ft_result": row["ft_result"],
                "psch": (None if pd.isna(row.get("psch")) else float(row["psch"])),
                "pscd": (None if pd.isna(row.get("pscd")) else float(row["pscd"])),
                "psca": (None if pd.isna(row.get("psca")) else float(row["psca"])),
            }
            f.write(json.dumps(rec) + "\n")

    size_kb = os.path.getsize(args.out) / 1024
    print(f"  written: {args.out} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

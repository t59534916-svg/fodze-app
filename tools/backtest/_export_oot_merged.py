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
import glob
import json
import os
import sys

import pandas as pd

PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_PRED = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-predictions.parquet")
DEFAULT_V1   = os.path.join(PROJECT_ROOT, "tools", "backtest", "v1-oot-predictions.parquet")
DEFAULT_ODDS = os.path.join(PROJECT_ROOT, "tools", "backtest", "odds-close-oot.parquet")
DEFAULT_HIST = os.path.join(PROJECT_ROOT, "Historie")
DEFAULT_OUT  = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-merged.jsonl")

# football-data.co.uk Div → FODZE league key. Copied from
# tools/train_ensemble.py:89 so the JSONL stays consistent with the
# rest of the training stack. Liga 3 is missing here (football-data
# doesn't cover the German 3rd tier) — liga3 rows simply won't get
# best-book odds merged, and Kelly falls back to Pinnacle.
DIV_TO_LEAGUE = {
    "D1": "bundesliga", "D2": "bundesliga2",
    "E0": "epl", "E1": "championship", "E2": "league_one", "E3": "league_two",
    "SP1": "la_liga", "SP2": "la_liga2",
    "I1": "serie_a", "I2": "serie_b",
    "F1": "ligue_1", "F2": "ligue_2",
    "N1": "eredivisie",
    "B1": "jupiler_pro", "P1": "primeira_liga", "T1": "super_lig",
    "SC0": "scottish_prem", "G1": "greek_sl",
}

# Only the columns a downstream engine actually needs. Excluding the 21-dim
# feature vector + lambda predictions keeps the JSONL ~5× smaller without
# losing any information a runtime engine consumes.
KEEP_COLS = [
    "match_date", "league", "home_team", "away_team",
    "prob_h_raw", "prob_d_raw", "prob_a_raw",
    "ft_result",
]


def _parse_dd_mm_yyyy(s):
    """Parse 'DD/MM/YYYY' or 'DD/MM/YY' → 'YYYY-MM-DD'. Matches
    scripts/_lib/football-data-parse.mjs::parseDate 1:1."""
    if not s or "/" not in s:
        return None
    parts = s.split("/")
    if len(parts) != 3:
        return None
    d, m, y = parts
    if not (d.isdigit() and m.isdigit() and y.isdigit()):
        return None
    if len(y) == 2:
        y = "20" + y
    try:
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    except ValueError:
        return None


def load_football_data_max_close(histdir, date_min, date_max):
    """
    Walk Historie/data*/ for every CSV, extract
    (league, match_date, home_team, away_team, MaxCH, MaxCD, MaxCA)
    within the date window. Columns MaxCH/CD/CA = best 1X2 closing odds
    across the ~7 soft books that football-data.co.uk tracks; this is
    the "quote shopping" proxy the Kelly backtest needs.

    Rows outside DIV_TO_LEAGUE (uncovered leagues like Liga 3) or
    outside the date window are dropped silently.
    """
    out_rows = []
    folders = sorted(glob.glob(os.path.join(histdir, "data*")))
    for folder in folders:
        for csv_path in sorted(glob.glob(os.path.join(folder, "*.csv"))):
            div = os.path.splitext(os.path.basename(csv_path))[0]
            league = DIV_TO_LEAGUE.get(div)
            if league is None:
                continue
            try:
                # football-data.co.uk uses Windows-1252 for team names with
                # diacritics (Beşiktaş, Göztepe). Latin-1 is a close enough
                # superset and never throws — matches decodeBuffer() in
                # scripts/_lib/football-data-parse.mjs.
                df = pd.read_csv(csv_path, encoding="latin-1", low_memory=False)
            except Exception as e:  # noqa: BLE001
                print(f"  [warn] could not read {csv_path}: {e}", file=sys.stderr)
                continue
            if "MaxCH" not in df.columns:
                # Older seasons don't ship Max*C* columns — skip silently.
                continue
            if "Date" not in df.columns or "HomeTeam" not in df.columns:
                continue
            for _, r in df.iterrows():
                iso_date = _parse_dd_mm_yyyy(str(r.get("Date", "")))
                if not iso_date or not (date_min <= iso_date <= date_max):
                    continue
                home = str(r.get("HomeTeam", "")).strip()
                away = str(r.get("AwayTeam", "")).strip()
                if not home or not away:
                    continue
                h = pd.to_numeric(r.get("MaxCH"), errors="coerce")
                d = pd.to_numeric(r.get("MaxCD"), errors="coerce")
                a = pd.to_numeric(r.get("MaxCA"), errors="coerce")
                if pd.isna(h) or pd.isna(d) or pd.isna(a) or h <= 1 or d <= 1 or a <= 1:
                    continue
                out_rows.append({
                    "league": league,
                    "match_date": iso_date,
                    "home_team": home,
                    "away_team": away,
                    "best_close_h": float(h),
                    "best_close_d": float(d),
                    "best_close_a": float(a),
                })
    if not out_rows:
        return pd.DataFrame(columns=[
            "league", "match_date", "home_team", "away_team",
            "best_close_h", "best_close_d", "best_close_a",
        ])
    df = pd.DataFrame(out_rows)
    # Multiple CSV folders can contain the same match (historical snapshots);
    # keep first occurrence deterministically.
    return df.drop_duplicates(subset=["league", "match_date", "home_team", "away_team"], keep="first")


def main() -> None:
    ap = argparse.ArgumentParser(description="Merge OOT predictions + Pinnacle close into JSONL.")
    ap.add_argument("--predictions", default=DEFAULT_PRED)
    ap.add_argument("--v1",          default=DEFAULT_V1,
                    help="Optional v1-oot-predictions.parquet (from export_v1_oot.py) — "
                         "when present, probs are merged into each row as v1_prob_*_raw.")
    ap.add_argument("--odds",        default=DEFAULT_ODDS)
    ap.add_argument("--historie",    default=DEFAULT_HIST,
                    help="football-data.co.uk Historie/ directory — scanned for Max*C* "
                         "columns to populate best_close_{h,d,a} (quote-shopping proxy).")
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

    keys = ["league", "match_date", "home_team", "away_team"]
    if len(odds_df) > 0:
        odds_df = odds_df.copy()
        odds_df["match_date"] = pd.to_datetime(odds_df["match_date"]).dt.date.astype(str)
        # Odds snapshot sometimes contains exact-duplicate rows (same match, same
        # Pinnacle close); a naive left-merge would multiply prediction rows by
        # the duplicate count. Dedupe on (league, date, home, away) first so the
        # output row count equals the prediction row count.
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

    # football-data.co.uk best-soft-book close (Max*C*). The window is
    # clamped to the prediction parquet's date range so we don't drag in
    # irrelevant seasons.
    pred_dates = merged["match_date"]
    date_min, date_max = pred_dates.min(), pred_dates.max()
    best_df = load_football_data_max_close(args.historie, date_min, date_max)
    if len(best_df) > 0:
        merged = merged.merge(best_df, on=keys, how="left")
        best_hit = int(merged["best_close_h"].notna().sum())
        print(f"  best-book close: merged {best_hit}/{len(merged)} rows (football-data.co.uk Max*C*)")
    else:
        merged = merged.assign(best_close_h=None, best_close_d=None, best_close_a=None)
        print(f"  best-book close: no Historie/ CSVs with Max*C* in window {date_min}..{date_max}")

    # Optional v1 predictions — join by the same key. Left-join so rows
    # without a v1 prediction carry nulls (the Node CLI then omits v1
    # from those rows' engine list).
    if os.path.exists(args.v1):
        v1_df = pd.read_parquet(args.v1).copy()
        v1_df["match_date"] = pd.to_datetime(v1_df["match_date"]).dt.date.astype(str)
        v1_df = v1_df.drop_duplicates(subset=keys, keep="first")
        v1_df = v1_df[keys + ["prob_h_raw", "prob_d_raw", "prob_a_raw"]].rename(columns={
            "prob_h_raw": "v1_prob_h_raw",
            "prob_d_raw": "v1_prob_d_raw",
            "prob_a_raw": "v1_prob_a_raw",
        })
        merged = merged.merge(v1_df, on=keys, how="left")
        v1_hit = int(merged["v1_prob_h_raw"].notna().sum())
        print(f"  v1 predictions:   merged {v1_hit}/{len(merged)} rows")
    else:
        merged = merged.assign(v1_prob_h_raw=None, v1_prob_d_raw=None, v1_prob_a_raw=None)
        print(f"  v1 predictions:   skipped (missing {os.path.relpath(args.v1, PROJECT_ROOT)})")

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
                "best_close_h": (None if pd.isna(row.get("best_close_h")) else float(row["best_close_h"])),
                "best_close_d": (None if pd.isna(row.get("best_close_d")) else float(row["best_close_d"])),
                "best_close_a": (None if pd.isna(row.get("best_close_a")) else float(row["best_close_a"])),
                "v1_prob_h_raw": (None if pd.isna(row.get("v1_prob_h_raw")) else float(row["v1_prob_h_raw"])),
                "v1_prob_d_raw": (None if pd.isna(row.get("v1_prob_d_raw")) else float(row["v1_prob_d_raw"])),
                "v1_prob_a_raw": (None if pd.isna(row.get("v1_prob_a_raw")) else float(row["v1_prob_a_raw"])),
            }
            f.write(json.dumps(rec) + "\n")

    size_kb = os.path.getsize(args.out) / 1024
    print(f"  written: {args.out} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

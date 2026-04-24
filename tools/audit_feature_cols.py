"""Quick followup: which feature columns actually exist and how populated are they per league?"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.supabase_loader import fetch_xg_history
import pandas as pd

df = fetch_xg_history(verbose=False)
print(f"Rows: {len(df)}")
print(f"Columns ({len(df.columns)}):\n  " + "\n  ".join(sorted(df.columns)))

# Feature coverage by league
feat_cols = [
    "npxg", "npxga", "ppda_att", "ppda_def", "deep", "deep_allowed",
    "xg_while_leading", "xg_while_level", "xg_while_trailing",
    "shots_for", "shots_against", "shots_on_target_for", "shots_on_target_against",
    "corners_for", "corners_against", "referee",
]
avail = [c for c in feat_cols if c in df.columns]
missing = [c for c in feat_cols if c not in df.columns]
print(f"\nPresent: {avail}")
print(f"Missing from schema: {missing}")

# Coverage per league (non-null %)
if avail:
    print("\n% non-null per league:")
    header = f"{'league':18s} " + " ".join(f"{c[:11]:>11s}" for c in avail)
    print(header)
    print("━" * len(header))
    for league, sub in df.groupby("league"):
        row = f"{league:18s} " + " ".join(f"{100*sub[c].notna().mean():>10.0f}%" for c in avail)
        print(row)

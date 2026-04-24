"""
Liga-by-Liga Data Coverage Audit — run BEFORE any retraining.

Fetches ALL team_xg_history rows from Supabase and reports per league:
- Row count
- Date range (oldest, newest)
- Source breakdown (understat / shots-model-* / footystats / api-sports / goals-proxy)
- xG coverage (non-null xg + xga)
- Advanced-feature coverage: npxg, ppda, deep, shots_for, corners, referee
- Game-state xG coverage (xg_while_leading etc.)
- Per-season row counts (detect holes in recent seasons)

Output: pretty table + JSON dump for further analysis.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.supabase_loader import fetch_xg_history
import pandas as pd


PRIMARY_COLS = {
    "xg": "xG",
    "xga": "xGA",
    "goals_for": "Goals",
    "goals_against": "GA",
    "shots_for": "Shots",
    "shots_on_target_for": "SoT",
    "corners_for": "Corners",
    "npxg": "npxG",
    "npxga": "npxGA",
    "ppda_att": "PPDA",
    "deep": "Deep",
    "xg_while_leading": "xG-lead",
    "xg_while_level": "xG-level",
    "xg_while_trailing": "xG-trail",
    "referee": "Ref",
}


def main():
    print("🔍 FODZE Supabase coverage audit\n")
    df = fetch_xg_history(verbose=True)
    print(f"\n📊 Total rows: {len(df)}  |  Leagues: {df['league'].nunique()}\n")

    df["season"] = df["match_date"].dt.year.where(
        df["match_date"].dt.month >= 7,
        df["match_date"].dt.year - 1,
    )

    summary_rows = []
    for league, sub in df.groupby("league"):
        row = {
            "league": league,
            "rows": len(sub),
            "teams": sub["team"].nunique(),
            "date_min": sub["match_date"].min().strftime("%Y-%m-%d"),
            "date_max": sub["match_date"].max().strftime("%Y-%m-%d"),
        }
        # Per-column non-null %
        for col, short in PRIMARY_COLS.items():
            if col in sub.columns:
                pct = 100 * sub[col].notna().mean()
                row[f"%{short}"] = round(pct, 1)
            else:
                row[f"%{short}"] = 0.0
        # Source breakdown
        src_counts = sub["source"].value_counts().to_dict() if "source" in sub else {}
        row["sources"] = ", ".join(f"{s}:{c}" for s, c in src_counts.items())
        # Per-season row counts for 2022-2025
        for season in (2022, 2023, 2024, 2025):
            row[f"s{season}"] = int((sub["season"] == season).sum())
        summary_rows.append(row)

    summary = pd.DataFrame(summary_rows).sort_values("rows", ascending=False)

    # ─── Pretty-print primary metrics ───────────────────────────────
    print("━" * 120)
    print(f"{'League':18s} {'Rows':>6s} {'Teams':>5s} {'DateRange':25s} "
          f"{'%xG':>5s} {'%npxG':>6s} {'%Shot':>5s} {'%Corn':>6s} "
          f"{'s2022':>6s} {'s2023':>6s} {'s2024':>6s} {'s2025':>6s}")
    print("━" * 120)
    for _, r in summary.iterrows():
        dr = f"{r['date_min']}..{r['date_max']}"
        print(f"{r['league']:18s} {r['rows']:>6d} {r['teams']:>5d} {dr:25s} "
              f"{r['%xG']:>5.1f} {r['%npxG']:>6.1f} {r['%Shots']:>5.1f} "
              f"{r['%Corners']:>6.1f} "
              f"{r['s2022']:>6d} {r['s2023']:>6d} {r['s2024']:>6d} {r['s2025']:>6d}")
    print("━" * 120)

    # ─── Per-source breakdown ──────────────────────────────────────
    print("\n📦 Source breakdown per league:")
    for _, r in summary.iterrows():
        print(f"  {r['league']:18s} {r['sources']}")

    # ─── Identify under-represented Top-leagues ────────────────────
    print("\n⚠️  Imbalance check:")
    top5 = {"epl", "la_liga", "serie_a", "bundesliga", "ligue_1"}
    max_rows = summary["rows"].max()
    for _, r in summary.iterrows():
        tier = "TOP-5" if r["league"] in top5 else "side"
        pct = 100 * r["rows"] / max_rows
        if r["league"] in top5 and pct < 50:
            print(f"  🔴 [{tier}] {r['league']}: {r['rows']} rows ({pct:.0f}% of leader)")
        elif r["rows"] == 0:
            print(f"  🔴 {r['league']}: 0 rows!")

    # Save for programmatic use
    out = Path(__file__).resolve().parents[1] / "backups" / "coverage-audit.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    summary.to_csv(out, index=False)
    print(f"\n💾 Saved to {out}")


if __name__ == "__main__":
    main()

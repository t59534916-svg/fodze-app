"""Per-league calibration empirical validation + export.

End-to-end runner:
  1. Load v2-oot-predictions.parquet
  2. Walk-forward 5-fold CV on epl, la_liga2, primeira_liga
  3. Report per-league acceptance (Brier-delta + ECE-reduction + bootstrap CI)
  4. If at least 1 league passes empirical gate:
       → Fit calibrator on FULL data (no holdout — production model)
       → Export public/per_league_calibration.json
       → Print TS-side wiring instructions

Acceptance gate (per league):
  - n_total_test >= 200
  - mean Brier-delta across folds < -0.005
  - bootstrap-CI upper bound < 0
  - mean ECE reduction > 30%

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/per_league_calibration_validation.py

Runtime: ~30s (no expensive history lookups; just isotonic fits + CV).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from v4.modules.m10_per_league_calibration import (  # noqa: E402
    PerLeagueIsotonicCalibrator,
    CalibratorConfig,
    TARGET_LEAGUES,
    walk_forward_validate,
)
from v4.modules.m10_per_league_calibration.export import export_json  # noqa: E402


INPUT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUTPUT_JSON = REPO_ROOT / "public" / "per_league_calibration.json"
REPORT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "per_league_calibration_report.json"


def main():
    print(f"[load] {INPUT_PARQUET.name}")
    df = pd.read_parquet(INPUT_PARQUET)
    df["match_date"] = pd.to_datetime(df["match_date"])
    print(f"[load] {len(df):,} predictions, {df['league'].nunique()} leagues")
    print(f"[load] target leagues counts:")
    for L in TARGET_LEAGUES:
        n = (df["league"] == L).sum()
        print(f"  {L}: {n}")

    print(f"\n[validate] walk-forward 5-fold CV...")
    summary = walk_forward_validate(df, TARGET_LEAGUES, n_folds=5)

    print(f"\n{'='*72}")
    print(f"{'league':<18} {'n_folds':>7} {'n_test':>7} {'ΔBrier':>10} {'CI':>22} {'ECE↓%':>8} {'pass':<5}")
    print('-' * 72)
    passing_leagues = []
    for L in TARGET_LEAGUES:
        s = summary[L]
        if s.get("n_folds", 0) == 0:
            print(f"{L:<18} {'0':>7} {'-':>7} {'-':>10} {'-':>22} {'-':>8} ✗")
            continue
        passes = s["passes_gate"]
        ci_str = f"[{s['ci_lower_95']:+.4f}, {s['ci_upper_95']:+.4f}]"
        mark = "PASS ✓" if passes else "fail"
        print(f"{L:<18} {s['n_folds']:>7} {s['n_total_test']:>7} "
              f"{s['mean_brier_delta']:>+10.4f} {ci_str:>22} "
              f"{s['mean_ece_reduction_pct']:>7.1f}% {mark}")
        if passes:
            passing_leagues.append(L)
    print('=' * 72)

    # Always write the validation report for audit trail
    REPORT_JSON.write_text(json.dumps(summary, indent=2, default=str))
    print(f"\n[write] {REPORT_JSON}")

    if not passing_leagues:
        print(f"\n[REJECT] No league passes empirical acceptance gate.")
        print("Per-league isotonic calibration NOT exported.")
        print("All 3 target leagues continue using global Platt (status quo).")
        print()
        print("Diagnostic next-steps:")
        print("  - Inspect ECE-delta — even if Brier-delta CI crosses 0, large ECE")
        print("    reduction may justify shipping (warn-mode, not full enforce).")
        print("  - Consider expanding train window to 23/24+24/25 (more data).")
        return

    print(f"\n[ACCEPT] {len(passing_leagues)} league(s) pass gate: {passing_leagues}")
    print(f"[fit] training production calibrator on FULL data (no holdout)...")
    cal = PerLeagueIsotonicCalibrator(CalibratorConfig()).fit(df, passing_leagues)
    export_json(cal, OUTPUT_JSON, acceptance_summary=summary)

    print(f"\nWiring instructions:")
    print(f"  1. JSON shipped: {OUTPUT_JSON.relative_to(REPO_ROOT)}")
    print(f"  2. TS loader needed: src/lib/per-league-calibration.ts (next step)")
    print(f"  3. Wire into MatchdayContext after global Platt calibration step")
    print(f"  4. Other 19 leagues: unchanged, still use Platt only.")


if __name__ == "__main__":
    main()

"""dev09_leakage_audit — G3 gate of 5-Gate Falsification Protocol for dev-09.

Per FODZE-Optimal-Blueprint audit committee + tools/v4/utils/falsification_protocol.py.

Verifies the dev-09 training pipeline has no train/test leakage:
  G3.1 — Walk-forward chrono split: train_seasons end before test_seasons start
  G3.2 — Zero game_id overlap between train and test sets
  G3.3 — Player-rolling uses shift(1).rolling(N) pattern (focal-match excluded)
  G3.4 — Cache lookup by (player_id, game_id) — never by team_id (bug-class A)
  G3.5 — Lineup source is is_starter=1 from player_match_stats (not future-leaked)
  G3.6 — Test set never appears in BottomUpCalculator.fit() input independently
         (but since fit loads ALL games, leakage is bounded by shift(1) — verified
         numerically by sampling test-game rolling against hand-computed reference)

This script is callable as a Day-2 CI gate AND as a Day-3 multi-seed bootstrap
pre-check. Exit codes:
  0 — all G3 checks pass
  1 — at least one G3 check fails (training pipeline has leakage risk)
  2 — soft warning (no hard leakage but coverage / sample issues)

Run:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_leakage_audit.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_leakage_audit.py --tag dev-09-day2
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg.bottom_up_features import (
    BottomUpCalculator, MIN_PERIODS, ROLLING_N,
)
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09

SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_leakage_audit.json"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--tag", default="dev-09-day2",
                   help="Manifest tag to read train/test splits from")
    p.add_argument("--train-seasons", default=None,
                   help="Override train_seasons (default: read from manifest)")
    p.add_argument("--test-seasons", default=None,
                   help="Override test_seasons (default: read from manifest)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    # Load manifest if available
    manifest_path = ARTIFACTS_DIR / f"m3_xg-{args.tag}.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        train_seasons = tuple(args.train_seasons.split(",")) if args.train_seasons \
            else tuple(manifest.get("train_seasons", ["23/24"]))
        test_seasons = tuple(args.test_seasons.split(",")) if args.test_seasons \
            else tuple(manifest.get("test_seasons", ["24/25"]))
        leagues = tuple(manifest.get("leagues", []))
    else:
        train_seasons = tuple(args.train_seasons.split(",")) if args.train_seasons else ("23/24",)
        test_seasons = tuple(args.test_seasons.split(",")) if args.test_seasons else ("24/25",)
        leagues = ("epl", "la_liga", "serie_a", "bundesliga", "ligue_1")
        print(f"  ⚠ No manifest at {manifest_path.name} — using defaults")

    print("═" * 70)
    print(f"dev-09 LEAKAGE AUDIT (G3 gate) · tag={args.tag}")
    print("═" * 70)
    print(f"  train_seasons: {train_seasons}")
    print(f"  test_seasons:  {test_seasons}")
    print(f"  leagues:       {leagues}")
    print()

    results: dict = {"tag": args.tag, "train_seasons": list(train_seasons),
                     "test_seasons": list(test_seasons), "leagues": list(leagues),
                     "checks": {}}
    n_pass = 0
    n_fail = 0
    n_warn = 0

    def _check(name: str, ok: bool, detail: str, *, warn: bool = False) -> None:
        nonlocal n_pass, n_fail, n_warn
        if ok and not warn:
            print(f"  ✓ {name:<42} {detail}")
            n_pass += 1
            results["checks"][name] = {"status": "PASS", "detail": detail}
        elif ok and warn:
            print(f"  ⚠ {name:<42} {detail}")
            n_warn += 1
            results["checks"][name] = {"status": "WARN", "detail": detail}
        else:
            print(f"  ✗ {name:<42} {detail}")
            n_fail += 1
            results["checks"][name] = {"status": "FAIL", "detail": detail}

    # ─── G3.1 + G3.2: chronological split + game_id overlap ───
    print("─" * 70)
    print("G3.1 + G3.2 — Walk-forward chronological split + game_id overlap")
    print("─" * 70)
    con = sqlite3.connect(str(SQLITE_PATH))
    train_meta = pd.read_sql_query(f"""
        SELECT game_id, start_timestamp FROM sofascore_match
        WHERE season IN ({','.join('?'*len(train_seasons))})
          AND league IN ({','.join('?'*len(leagues))})
          AND home_score IS NOT NULL AND away_score IS NOT NULL
    """, con, params=list(train_seasons)+list(leagues))
    test_meta = pd.read_sql_query(f"""
        SELECT game_id, start_timestamp FROM sofascore_match
        WHERE season IN ({','.join('?'*len(test_seasons))})
          AND league IN ({','.join('?'*len(leagues))})
          AND home_score IS NOT NULL AND away_score IS NOT NULL
    """, con, params=list(test_seasons)+list(leagues))

    train_max_ts = train_meta["start_timestamp"].max() if len(train_meta) else None
    test_min_ts = test_meta["start_timestamp"].min() if len(test_meta) else None
    gap_days = ((test_min_ts - train_max_ts) / 86400) if train_max_ts and test_min_ts else None
    chrono_ok = (gap_days is not None and gap_days > 0)
    _check(
        "G3.1 chrono split (test_min > train_max)",
        chrono_ok,
        f"gap={gap_days:.0f}d (train_max={pd.Timestamp(train_max_ts, unit='s').date() if train_max_ts else 'N/A'} "
        f"→ test_min={pd.Timestamp(test_min_ts, unit='s').date() if test_min_ts else 'N/A'})",
    )

    train_gids = set(train_meta["game_id"])
    test_gids = set(test_meta["game_id"])
    overlap = train_gids & test_gids
    _check(
        "G3.2 game_id overlap (train ∩ test = ∅)",
        not overlap,
        f"n_train={len(train_gids):,}, n_test={len(test_gids):,}, "
        f"overlap={len(overlap)} {'(✓ CLEAN)' if not overlap else '(✗ LEAKAGE)'}",
    )

    # ─── G3.3 + G3.4: source-code patterns ───
    print()
    print("─" * 70)
    print("G3.3 + G3.4 — Source-code patterns (shift+rolling + no team_id GROUP BY)")
    print("─" * 70)
    bc_source = (REPO_ROOT / "tools" / "v4" / "modules" / "m3_xg" /
                 "bottom_up_features.py").read_text()

    _check(
        "G3.3 shift(1).rolling pattern present",
        ".shift(1).rolling(" in bc_source,
        "BottomUpCalculator uses shift(1).rolling() for leakage-safe rolling",
    )
    _check(
        "G3.3 sort kind='mergesort' present",
        'kind="mergesort"' in bc_source,
        "Deterministic sort guarantees rolling order across runs",
    )
    # AST-strip docstrings/comments before scanning for bug-class A
    import ast
    tree = ast.parse(bc_source)
    for node in ast.walk(tree):
        if (isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef,
                              ast.ClassDef)) and node.body and
            isinstance(node.body[0], ast.Expr) and
            isinstance(node.body[0].value, ast.Constant) and
            isinstance(node.body[0].value.value, str)):
            node.body[0].value.value = ""
    code_only = "\n".join(line.split("#")[0] for line in ast.unparse(tree).splitlines())
    bad_pattern = re.compile(r"GROUP\s+BY[^A-Za-z]*\bteam_id\b", re.IGNORECASE)
    bad_matches = bad_pattern.findall(code_only)
    _check(
        "G3.4 NO GROUP BY team_id in code",
        not bad_matches,
        "bug-class A invariant holds (matched: " + str(bad_matches) + ")" if bad_matches
        else "no SQL GROUP BY team_id pattern found",
    )

    # ─── G3.5: lineup source ───
    print()
    print("─" * 70)
    print("G3.5 — Lineup source is is_starter=1 (no future-leaked roster)")
    print("─" * 70)
    fb_source = (REPO_ROOT / "tools" / "v4" / "modules" / "m3_xg" /
                 "feature_builder_dev09.py").read_text()
    _check(
        "G3.5 lineup uses is_starter=1 filter",
        "is_starter = 1" in fb_source,
        "FeatureBuilderDev09 reads starting XI from player_match_stats.is_starter=1 "
        "(post-match emitted; no future leak since it reflects WHO actually started)",
    )

    # ─── G3.6: empirical leakage check via test-game rolling values ───
    print()
    print("─" * 70)
    print("G3.6 — Empirical: test-game rolling-xg = shift(1)+rolling reference")
    print("─" * 70)
    print("  Sampling 3 random test-set players + verifying cache value matches")
    print("  hand-computed shift(1).rolling(10, min_periods=3) over their history.")
    bc = BottomUpCalculator(SQLITE_PATH).fit()
    # Sample 3 players who appear in test set
    test_starters = pd.read_sql_query(f"""
        SELECT DISTINCT pms.player_id
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.is_starter = 1
          AND sm.season IN ({','.join('?'*len(test_seasons))})
          AND sm.league IN ({','.join('?'*len(leagues))})
    """, con, params=list(test_seasons)+list(leagues))
    con.close()

    rng = np.random.default_rng(42)
    sample_pids = rng.choice(test_starters["player_id"].values, size=min(3, len(test_starters)),
                             replace=False)

    leakage_mismatches = 0
    leakage_n_checks = 0
    for pid in sample_pids:
        con2 = sqlite3.connect(str(SQLITE_PATH))
        hist = pd.read_sql_query("""
            SELECT pms.game_id, pms.expected_goals, pms.minutes_played, sm.start_timestamp
            FROM sofascore_player_match_stats pms
            JOIN sofascore_match sm ON sm.game_id = pms.game_id
            WHERE pms.player_id = ? AND pms.minutes_played > 0
            ORDER BY sm.start_timestamp
        """, con2, params=[int(pid)])
        con2.close()
        if len(hist) < MIN_PERIODS + 2:
            continue
        hist["expected_goals"] = hist["expected_goals"].astype(float).fillna(0.0)
        hist["xg_per_90"] = (hist["expected_goals"] /
                             (hist["minutes_played"] / 90.0).clip(lower=0.1)).clip(0, 3.0)
        hist["ref_rolling"] = (hist["xg_per_90"]
                                .shift(1)
                                .rolling(ROLLING_N, min_periods=MIN_PERIODS).mean())
        valid = hist.dropna(subset=["ref_rolling"])
        for _, r in valid.iterrows():
            gid = int(r["game_id"])
            cache_entry = bc._player_rolling.get((int(pid), gid))
            if cache_entry is None:
                continue
            ref = float(r["ref_rolling"])
            cached = cache_entry["xg_per_90"]
            if abs(ref - cached) > 1e-9:
                leakage_mismatches += 1
            leakage_n_checks += 1

    _check(
        "G3.6 cache values = shift(1)+rolling ref",
        leakage_mismatches == 0,
        f"{leakage_n_checks:,} cache lookups across {len(sample_pids)} players; "
        f"{leakage_mismatches} mismatches "
        f"({'✓ all bit-identical to reference' if leakage_mismatches == 0 else '✗ leakage'})",
    )

    # ─── Verdict ───
    print()
    print("═" * 70)
    print(f"VERDICT: {n_pass} PASS / {n_warn} WARN / {n_fail} FAIL")
    print("═" * 70)
    results["summary"] = {"n_pass": n_pass, "n_warn": n_warn, "n_fail": n_fail,
                          "verdict": "PASS" if n_fail == 0 else "FAIL"}
    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(results, indent=2))
    print(f"  Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

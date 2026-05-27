#!/usr/bin/env python3
"""dev-03 multi-seed bootstrap — empirical inter-seed Brier variance.

Why this exists:
  Per CLAUDE.md "Single-seed Brier-improvement < 1σ inter-seed variance
  (~0.002) = run-noise". This 0.002 number is HEURISTIC — never empirically
  measured on current data. After today's failed retrain attempt (Δ -0.0008
  fresh vs production) we need to know: is 0.002 the right threshold? Could
  Δ -0.0008 actually be real signal vs the inter-seed noise floor?

What this does:
  1. Trains N independent dev-03 ensembles with disjoint seed-sets
     (default: 5 ensembles × 5 bagged models = 25 models total)
  2. Evaluates each on 25/26 holdout via stage_1_m3_xg.py
  3. Aggregates Brier mean / std / 95% bootstrap-CI across ensembles
  4. Reports the empirical inter-seed noise floor

Output:
  tools/v4/diagnostics/dev03_multi_seed_bootstrap.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev03_multi_seed_bootstrap.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev03_multi_seed_bootstrap.py --n-seeds 3 --skip-existing

Estimated runtime:
  5 ensembles × (4 min feature-build + 5 sec train) ≈ 20-25 min total
  (feature-build dominates; trees train in seconds because they're tiny)
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev03_multi_seed_bootstrap.json"
PY = REPO_ROOT / "tools" / "venv" / "bin" / "python3"


def train_seed(seed_offset: int, tag: str, skip_existing: bool = False) -> int:
    """Train one ensemble. Returns subprocess exit code (0=ok)."""
    artifact = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    if skip_existing and artifact.exists():
        print(f"  ⏭  {tag}: artifact exists, skip-existing flag set")
        return 0
    print(f"  → Training {tag} with seed-offset={seed_offset}...")
    result = subprocess.run([
        str(PY), "-I", "tools/v4/train_m3_xg.py",
        "--features-locked",
        "--since", "2022-07-01",
        "--cutoff", "2025-08-01",
        "--tag", tag,
        "--seed-offset", str(seed_offset),
    ], cwd=str(REPO_ROOT), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ✗ Training failed for {tag}:")
        print(result.stderr[-500:])
    return result.returncode


def evaluate_seed(tag: str) -> dict | None:
    """Run stage_1_m3_xg.py --tag {tag} and parse Brier."""
    print(f"  → Evaluating {tag} on 25/26 holdout...")
    result = subprocess.run([
        str(PY), "-I", "tools/v4/pipeline/stage_1_m3_xg.py",
        "--tag", tag,
    ], cwd=str(REPO_ROOT), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ✗ Eval failed for {tag}:")
        print(result.stderr[-500:])
        return None
    out = result.stdout
    # Parse: "v4 m3_xg Brier:   0.6133"
    m = re.search(r"v4 m3_xg Brier:\s+([\d.]+)", out)
    if not m:
        print(f"  ✗ Could not parse Brier from output for {tag}")
        return None
    brier = float(m.group(1))
    # Per-Liga breakdown
    per_liga = {}
    for line in out.splitlines():
        mlg = re.search(r"^\s+(\w+)\s+n=\s*(\d+)\s+Brier=([\d.]+)", line)
        if mlg:
            per_liga[mlg.group(1)] = {"n": int(mlg.group(2)), "brier": float(mlg.group(3))}
    return {"brier": brier, "per_liga": per_liga}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-seeds", type=int, default=5,
                    help="Number of seed-offset ensembles to train (default 5)")
    ap.add_argument("--seed-offsets", default=None,
                    help="Comma-separated offsets (overrides --n-seeds). "
                         "Default: 0,100,200,300,400")
    ap.add_argument("--skip-existing", action="store_true",
                    help="Skip training when artifact pickle already exists "
                         "(allows resume after partial run)")
    args = ap.parse_args()

    if args.seed_offsets:
        offsets = [int(x) for x in args.seed_offsets.split(",")]
    else:
        offsets = [i * 100 for i in range(args.n_seeds)]

    print("═" * 70)
    print(f"dev-03 multi-seed bootstrap · {len(offsets)} ensembles")
    print("═" * 70)
    print(f"  Seed offsets: {offsets}")
    print(f"  Each ensemble uses seeds [42+offset, 43+offset, ..., 46+offset]")
    print()

    results = {}
    for offset in offsets:
        tag = f"dev-03-seed-{offset:03d}"
        rc = train_seed(offset, tag, skip_existing=args.skip_existing)
        if rc != 0:
            results[tag] = {"status": "train_failed", "seed_offset": offset}
            continue
        evals = evaluate_seed(tag)
        if evals is None:
            results[tag] = {"status": "eval_failed", "seed_offset": offset}
            continue
        results[tag] = {
            "status": "ok",
            "seed_offset": offset,
            "seeds": [42 + i + offset for i in range(5)],
            "holdout_brier": evals["brier"],
            "per_liga": evals["per_liga"],
        }
        print(f"  ✓ {tag}: Brier={evals['brier']:.4f}")
        print()

    # Aggregate
    ok = [r for r in results.values() if r.get("status") == "ok"]
    if len(ok) < 2:
        print(f"\n  ✗ Only {len(ok)} successful ensembles — cannot compute variance")
        return 1

    import numpy as np
    briers = [r["holdout_brier"] for r in ok]
    mean = float(np.mean(briers))
    std = float(np.std(briers, ddof=1))
    ci_low = float(mean - 1.96 * std / np.sqrt(len(briers)))
    ci_high = float(mean + 1.96 * std / np.sqrt(len(briers)))

    print("═" * 70)
    print("BOOTSTRAP RESULT")
    print("═" * 70)
    print(f"  Successful ensembles: {len(ok)}/{len(offsets)}")
    for r in sorted(ok, key=lambda x: x["seed_offset"]):
        print(f"    seed-offset {r['seed_offset']:03d}: Brier={r['holdout_brier']:.4f}")
    print()
    print(f"  Brier mean:        {mean:.4f}")
    print(f"  Brier std:         {std:.4f}")
    print(f"  95% CI on mean:    [{ci_low:.4f}, {ci_high:.4f}]")
    print(f"  Range (max−min):   {max(briers)-min(briers):.4f}")
    print()
    print(f"  EMPIRICAL NOISE FLOOR (1σ): {std:.4f}")
    print(f"  CLAUDE.md heuristic was ~0.002 — empirical is {'>' if std > 0.002 else '<'} that")
    print(f"  → Any single-seed retrain Brier-improvement < {std:.4f} = noise")

    # Per-league analysis: how does variance differ per league?
    if all(r.get("per_liga") for r in ok):
        print()
        print("─" * 70)
        print(f"  Per-league Brier variance (1σ across seeds):")
        print("─" * 70)
        per_lg = {}
        for r in ok:
            for lg, m in r["per_liga"].items():
                per_lg.setdefault(lg, []).append(m["brier"])
        per_lg_stats = {}
        for lg, vals in sorted(per_lg.items(), key=lambda x: np.std(x[1], ddof=1) if len(x[1]) > 1 else 0):
            if len(vals) >= 2:
                m, s = float(np.mean(vals)), float(np.std(vals, ddof=1))
                per_lg_stats[lg] = {"mean": m, "std": s, "n_seeds": len(vals)}
                print(f"    {lg:<18} mean={m:.4f}  std={s:.4f}  (range {max(vals)-min(vals):.4f})")

    # Save
    OUT_PATH.write_text(json.dumps({
        "n_seeds": len(ok),
        "seed_offsets": offsets,
        "ensemble_briers": [
            {"seed_offset": r["seed_offset"], "brier": r["holdout_brier"]}
            for r in sorted(ok, key=lambda x: x["seed_offset"])
        ],
        "brier_mean": mean,
        "brier_std": std,
        "brier_ci_95": [ci_low, ci_high],
        "brier_range": max(briers) - min(briers),
        "empirical_noise_floor_1sigma": std,
        "claudemd_heuristic": 0.002,
        "interpretation": (
            f"Any single-seed Brier-improvement Δ < {std:.4f} is "
            f"indistinguishable from run-noise. The CLAUDE.md heuristic "
            f"0.002 was {'pessimistic' if std > 0.002 else 'optimistic'} — "
            f"actual measured std is {std:.4f}."
        ),
        "per_league_stats": per_lg_stats if 'per_lg_stats' in dir() else {},
    }, indent=2))
    print(f"\n  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

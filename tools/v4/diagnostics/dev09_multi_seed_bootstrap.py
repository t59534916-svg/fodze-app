#!/usr/bin/env python3
"""dev-09 multi-seed bootstrap — empirical inter-seed Brier variance.

Mirrors tools/v4/diagnostics/dev03_multi_seed_bootstrap.py but for the
dev-09 TABULA RASA architecture. Per FODZE-Optimal-Blueprint Day-3 deliverable.

Why this exists:
  - Day-2 Brier=0.6081 vs Day-3 Brier=0.5974 — both single-seed results
  - Need empirical inter-seed σ to know if Day-2-vs-Day-3 Δ -0.0107 is real
  - Need σ for G4 power analysis (audit committee binding)
  - dev-03's empirical σ=0.000456 (n=5 bootstrap) does NOT translate to
    dev-09: different architecture, different training corpus, different
    feature vector

What this does:
  1. Trains N independent dev-09 ensembles with disjoint seed-sets
     (default: 5 ensembles × 5 bagged models = 25 models total)
  2. Evaluates each on 24/25 holdout via stage_1_dev09.py
  3. Aggregates Brier mean / std / 95% bootstrap-CI across ensembles
  4. Reports the empirical inter-seed noise floor for dev-09

Output:
  tools/v4/diagnostics/dev09_multi_seed_bootstrap.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_multi_seed_bootstrap.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_multi_seed_bootstrap.py \
    --n-seeds 3 --skip-existing

Estimated runtime:
  5 ensembles × (20s feature build + ~5s train + ~2min eval) ≈ 12 min total
  (BC fit is the bottleneck per ensemble; trees train in seconds)
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
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_multi_seed_bootstrap.json"
PY = REPO_ROOT / "tools" / "venv" / "bin" / "python3"


def train_seed(seed_offset: int, tag: str, skip_existing: bool = False) -> int:
    """Train one dev-09 ensemble. Returns subprocess exit code (0=ok)."""
    artifact = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    if skip_existing and artifact.exists():
        print(f"  ⏭  {tag}: artifact exists, skip-existing flag set")
        return 0
    print(f"  → Training {tag} with seed-offset={seed_offset}...")
    result = subprocess.run([
        str(PY), "-I", "tools/v4/train_dev09.py",
        "--tag", tag,
        "--seed-offset", str(seed_offset),
        "--no-gates",  # skip in-line gates (we re-evaluate via stage_1_dev09)
    ], cwd=str(REPO_ROOT), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ✗ Training failed for {tag}:")
        print(result.stderr[-500:])
    return result.returncode


def evaluate_seed(tag: str) -> dict | None:
    """Run stage_1_dev09.py --tag {tag} and parse Brier + per-Liga."""
    print(f"  → Evaluating {tag} on 24/25 holdout...")
    result = subprocess.run([
        str(PY), "-I", "tools/v4/pipeline/stage_1_dev09.py",
        "--tag", tag,
    ], cwd=str(REPO_ROOT), capture_output=True, text=True)
    if result.returncode not in (0, 2):  # 2 = soft "above pass threshold"
        print(f"  ✗ Eval failed for {tag}:")
        print(result.stderr[-500:])
        return None
    out = result.stdout
    # Parse: "Brier 1X2: 0.5974"
    m = re.search(r"Brier 1X2:\s+([\d.]+)", out)
    if not m:
        print(f"  ✗ Could not parse Brier from output for {tag}")
        return None
    brier = float(m.group(1))
    # Per-Liga rows: "  bundesliga       306    0.6375   +0.0181     1.0565"
    # Bugfix: league names can contain digits (e.g. ligue_1, la_liga2, liga3)
    per_liga = {}
    for line in out.splitlines():
        mlg = re.search(r"^\s+([a-z][a-z0-9_]*)\s+(\d+)\s+([\d.]+)\s+([+-][\d.]+)\s+([\d.]+)\s*$", line)
        if mlg:
            per_liga[mlg.group(1)] = {
                "n": int(mlg.group(2)),
                "brier": float(mlg.group(3)),
                "delta_v2": float(mlg.group(4)),
            }
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
    print(f"dev-09 multi-seed bootstrap · {len(offsets)} ensembles")
    print("═" * 70)
    print(f"  Seed offsets: {offsets}")
    print(f"  Each ensemble uses seeds [42+offset, 43+offset, ..., 46+offset]")
    print()

    results = {}
    for offset in offsets:
        tag = f"dev-09-seed-{offset:03d}"
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
    print("BOOTSTRAP RESULT (dev-09)")
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
    print(f"  EMPIRICAL NOISE FLOOR for dev-09 (1σ): {std:.4f}")
    print(f"  dev-03's empirical σ (CLAUDE.md): 0.000456")
    print(f"  Ratio dev-09 / dev-03: {std/0.000456:.2f}×")
    print(f"  → Any single-seed dev-09 retrain Brier-improvement < {std:.4f} = noise")

    # Per-league analysis: how does variance differ per league?
    per_lg_stats = {}
    if all(r.get("per_liga") for r in ok):
        print()
        print("─" * 70)
        print(f"  Per-league Brier variance across {len(ok)} seeds:")
        print("─" * 70)
        per_lg: dict = {}
        for r in ok:
            for lg, m in r["per_liga"].items():
                per_lg.setdefault(lg, []).append(m["brier"])
        for lg, vals in sorted(per_lg.items(), key=lambda x: np.std(x[1], ddof=1) if len(x[1]) > 1 else 0):
            if len(vals) >= 2:
                m_v, s_v = float(np.mean(vals)), float(np.std(vals, ddof=1))
                per_lg_stats[lg] = {"mean": m_v, "std": s_v, "n_seeds": len(vals)}
                print(f"    {lg:<18} mean={m_v:.4f}  std={s_v:.4f}  (range {max(vals)-min(vals):.4f})")

    # Save
    OUT_PATH.write_text(json.dumps({
        "architecture": "dev-09-TABULA-RASA-bottom-up",
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
        "dev03_noise_floor_for_comparison": 0.000456,
        "interpretation": (
            f"For dev-09 architecture: any single-seed Brier-improvement Δ < {std:.4f} "
            f"is indistinguishable from run-noise. Per-feature G2 Holm correction requires "
            f"Δ > ~2σ ({2*std:.4f}) for any single-feature claim to survive correction at "
            f"α=0.05/11 = 0.00455."
        ),
        "per_league_stats": per_lg_stats,
    }, indent=2))
    print(f"\n  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

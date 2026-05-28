"""
walk_forward.py — Stage 3 tiered walk-forward CV orchestrator.

⏳ NOT YET IMPLEMENTED. Per V4-BACKTESTING-PROTOCOL §"Stage 3":

Tier-A (5-fold, data-rich):
  Fold 1: train 2017/18-2020/21  → test 2021/22
  Fold 2: train 2017/18-2021/22  → test 2022/23
  Fold 3: train 2017/18-2022/23  → test 2023/24
  Fold 4: train 2017/18-2023/24  → test 2024/25
  Fold 5: train 2017/18-2024/25  → test 2025/26

Tier-B (3-fold, FootyStats-era):
  Fold 1-3 starting from 2021/22

Tier-C (2-fold, sparse):
  Fold 1-2 starting from 2022/23

Pass criteria:
  - Tier-A mean Brier < v2 production Tier-A mean by ≥ 0.003
  - Tier-B mean Brier < v2 Tier-B mean by ≥ 0.002
  - Std-dev across folds (Tier-A) < 0.020 (G4)
  - Tier-C: no catastrophic drift (per-fold Brier < 0.70)

Usage (future):
  tools/venv/bin/python3 -I tools/v4/walk_forward.py --tier A --output reports/walk_forward.json
"""
from __future__ import annotations

import sys


def main() -> int:
    raise NotImplementedError(
        "walk_forward.py not yet implemented (Stage 3 — runs after Stage 1+2 pass)"
    )


if __name__ == "__main__":
    sys.exit(main())

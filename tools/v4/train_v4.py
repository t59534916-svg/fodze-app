"""
train_v4.py — main v4 training orchestrator (Stage 4 entry point).

⏳ NOT YET IMPLEMENTED. Will sequence:
  1. Stage 0 data-sanity (validate_schema + coverage_audit)
  2. m2_lambda fit on team_xg_history
  3. m3_xg training (LightGBM Tweedie + Bayesian Ensemble) with feature-lab gating
  4. m4_set_pieces training (XGBoost on shotmap)
  5. m6_market fit (Shin params + Benter blend weights per Liga)
  6. m7_kelly α-tuning grid-search
  7. Walk-forward CV (Stage 3 tiered Tier-A/B/C)
  8. Current-season OOT scoring (Stage 4)
  9. CLV bootstrap simulation (Stage 5)
  10. Reports → tools/v4/reports/

Usage (future):
  tools/venv/bin/python3 -I tools/v4/train_v4.py --cutoff 2025-08-01 --skip-stage 6
"""
from __future__ import annotations

import sys


def main() -> int:
    raise NotImplementedError(
        "train_v4.py orchestrator not yet implemented. "
        "Run individual stage scripts directly:\n"
        "  - tools/v4/pipeline/stage_0_data_sanity.py\n"
        "  - tools/v4/pipeline/stage_1_m1_score.py\n"
        "  - (m3_xg / m4 / m6 / m7 trainers — TBD)"
    )


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# FODZE model-artifact refit orchestrator
# ═══════════════════════════════════════════════════════════════════
#
# Call this after retrain_v2.py writes a new v2-oot-predictions.parquet.
# Re-runs every downstream fit in the correct order so the shipping
# artifacts stay consistent with each other:
#
#   v2-oot-predictions.parquet  (produced by retrain_v2.py, upstream)
#       │
#       ├─▶ public/dirichlet-calibration.json      (ODIR per cluster)
#       │       │
#       │       └─▶ public/conformal-quantiles.json (per-league q)
#       │               │
#       │               └─▶ tools/backtest/v1-oot-predictions.parquet
#       │                       │
#       │                       └─▶ public/backtest-summary.json
#       │                             + tools/backtest/cross-engine-oot-metrics.json
#       │
#       └─▶ public/benter-weights.json  (optional; only when odds cache exists)
#
# Skipping a step in this chain leaves downstream artifacts referring to
# a different probability distribution than the live app actually feeds
# them — exactly the bug fixed in f9c6ce7 when the conformal gate
# under-covered by 5 pp after Dirichlet default-flipped.
#
# Usage:
#   bash tools/backtest/refit-all.sh
#   bash tools/backtest/refit-all.sh --skip-benter
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

cd "$(dirname "$0")/../.."
PY=tools/venv/bin/python

SKIP_BENTER=0
for a in "$@"; do
  case "$a" in
    --skip-benter) SKIP_BENTER=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

if [[ ! -f tools/backtest/v2-oot-predictions.parquet ]]; then
  echo "v2-oot-predictions.parquet missing. Run retrain_v2.py first:" >&2
  echo "  $PY tools/retrain_v2.py --use-full-csv --use-tactics --use-players --use-roster --use-shots" >&2
  exit 1
fi

echo "── 1/5 Dirichlet-ODIR fit (per cluster)"
$PY tools/calibrate_dirichlet.py --engine v2 --lam 0.01

echo ""
echo "── 2/5 Conformal quantile fit (Dirichlet-calibrated input)"
$PY tools/fit_conformal.py --engine v2 --alphas 0.05,0.10,0.20 --calibration dirichlet

if [[ $SKIP_BENTER -eq 0 && -f tools/backtest/odds-close-oot.parquet ]]; then
  echo ""
  echo "── 3/5 Benter blend fit (requires odds-close-oot.parquet)"
  $PY tools/fit_benter_blend.py --engine v2 || true
else
  echo ""
  echo "── 3/5 Benter blend fit SKIPPED (--skip-benter or odds cache missing)"
fi

echo ""
echo "── 4/5 v1 Poisson-GLM OOT export"
$PY tools/backtest/export_v1_oot.py

echo ""
echo "── 5/5 Cross-engine OOT + publish backtest-summary.json"
node tools/backtest/run-cross-engine-oot.mjs --publish --no-bootstrap

echo ""
echo "✓ All model artifacts refit. The shipping artifacts are now:"
ls -la public/dirichlet-calibration.json public/conformal-quantiles.json public/benter-weights.json public/backtest-summary.json 2>/dev/null | awk '{print "  "$9"  "$5" bytes  mtime "$6" "$7" "$8}'
echo ""
echo "Review diffs with: git diff public/*.json"
echo "Then commit: git commit -am 'chore(models): refit artifacts against new v2 OOT parquet'"

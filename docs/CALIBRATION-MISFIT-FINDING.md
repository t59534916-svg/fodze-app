# Calibration mis-fit — the 1X2 Kelly-track calibration is ensemble-era (2026-05-31)

**Verdict: confirmed defect for the sharp engines (v2 / dev-03 / v1), NOT a
sharpness/reliability trade-off. Limited practical impact (Kelly/edge track only;
display is raw; betting edge is already dead). Fix has wide blast radius → needs a
validated sprint, not a quick patch.**

## What's actually running

`src/lib/calibration.ts::calibrate1X2` is on the **Kelly/edge track** only
(`dixon-coles.ts::calculateBetsEnhanced:1012` — `cal` feeds `pModel`/edge/Kelly;
the user-facing `calc.mk` display stays **raw** for Standard/v1/v2, Benter-blended
for dev-03). The active 1X2 calibration is the **hardcoded global isotonic curves**
`CAL_H/D/A` in `calibration.ts` (lines 8-69, header "trained on 14,359 games
2017-2025" — the Dixon-Coles/ensemble era):

- `loadCalibrationCurves(calibration_curves.json)` sees `method:"platt"`, sets
  `CALIBRATION_METHOD="platt"`, loads the Platt params, and **returns early** —
  never touching the hardcoded isotonic arrays.
- AppContext then `setCalibrationMethod("isotonic")` (from
  `NEXT_PUBLIC_CALIBRATION_METHOD=isotonic`), overriding to isotonic.
- So at runtime: **method=isotonic → the hardcoded global curves are used**, and
  the JSON's Platt params + **18 per-league overrides are loaded but DEAD**
  (never read). Confirmed empirically (a probe of `getCalibrationMethod()` +
  `calibrate1X2`).

## The measurement (real TS `calibrate1X2`, 25/26 OOT)

`tools/backtest/engine_per_row_calib.mts` (runs the real calibration) +
`calib_ece_analysis.py`:

| engine | n | Brier raw→cal | **ECE raw→cal** | verdict |
|---|---|---|---|---|
| Standard | 7458 | 0.682→0.651 (−0.031) | **0.151→0.052** (−0.099) | calibration HELPS (fit on it) |
| v1 | 6525 | 0.648→0.678 (+0.031) | 0.075→0.106 (+0.031) | **DEFECT** |
| v2 | 6525 | 0.624→0.652 (+0.029) | **0.013→0.058** (+0.044) | **DEFECT** |

**v2's raw is already near-perfectly calibrated (ECE 0.013).** The ensemble-era
curves quadruple its calibration error and raise Brier. Calibration helps **only**
Standard (the engine it was fit on). dev-03 is sharp like v2 (and now the default)
→ its Kelly track is being degraded the same way. ECE rules out the "sharpness
trade-off" defense: the curves worsen v2/v1 on **both** Brier and ECE.

## The fix (and why it's a sprint, not a patch)

Cleanest fix: **engine-aware calibration** — apply the ensemble-era curves only to
`ensemble-v1` (which needs them), and let the well-calibrated sharp engines
(`v2`, `poisson-ml-dev03`) use their raw/Benter-blended probs on the Kelly track.
The gate point is clean (`dixon-coles.ts:1012`, `engine` already in scope; v2 passes
`"v2"`, dev-03 `"dev-03"`).

**Blast radius — must re-validate before shipping:**
1. **Goldilocks value-detection** — edges = `pModel − pMarket` change for v2/dev-03.
2. **Money-Eval policy** (`bet-edge-policy.ts`) — dev-03's per-league ROI was
   validated **on the calibrated probs**; changing them invalidates that.
3. **Conformal gate** — the runtime-faithful re-fit (`fix/conformal-isotonic-refit`)
   fit quantiles on `calibrate1X2(raw)`; skipping calibration for v2 changes that
   distribution → re-fit needed (gate is `warn`/dormant, so no live staking risk).
4. Keep a safety cap (H/A ≤ 0.95) even when bypassing, for pathological raw rows.

**5-Gate + a Kelly backtest required before any production change.**

## Why it's not urgent

The display forecast is unaffected (raw for v2, Benter for dev-03 — both well
calibrated). The defect only touches Kelly/edge staking, and betting edge vs
Pinnacle is validated-impossible (FORECAST-QUALITY-ANALYSIS.md §5b), so the Kelly
track is risk-management, not profit. Worth fixing for correctness; not a fire.

## Reproduce

```bash
tools/venv/bin/python3 tools/backtest/_engine_export_raw.py
npx vitest run --config tools/backtest/calib-audit.vitest.config.mts   # real calibrate1X2
tools/venv/bin/python3 tools/backtest/calib_ece_analysis.py            # Brier + ECE per engine
```

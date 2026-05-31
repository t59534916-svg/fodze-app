#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE — Conformal Gate Drift Validation (Phase 2.5 Audit)
═══════════════════════════════════════════════════════════════════

⚠ DEPRECATED (2026-05-31) — DO NOT TRUST FOR FLIP DECISIONS. This validator
  applies calibration in the WRONG ORDER vs the runtime: it does Platt THEN
  Benter (apply_platt → apply_benter, line ~275/290), but production runs
  Benter BEFORE calibrate1X2 (dixon-coles.ts:992/1000/1012). Platt and Benter
  do not commute. It also uses an APPROXIMATE Platt (no D-clamp/H-A caps that
  calibrate1X2 has). Result: it scores a distribution production never serves,
  so its drift verdicts (incl. the old "5 catastrophic / BLOCK") are unreliable.
  → Use the runtime-faithful pipeline instead (runs the REAL TS calibrate1X2):
       tools/backtest/_conformal_export_raw.py        (B1)
       tools/backtest/conformal_runtime_calibrate.mts (B2, via dedicated config)
       tools/backtest/refit_conformal_runtime.py      (B3 fit + validate)

Validates whether the trained conformal quantiles in
`public/conformal-quantiles.json` (fitted 2026-04-21 against the
2023-08 → 2024-06 OOT window) still hold empirical coverage on the
current-season predictions in `tools/backtest/v2-oot-predictions.parquet`
(2025-08 → 2026-05, n=8979).

Methodology — empirical-coverage test:
  1. Load v2 leakage-safe predictions for current season
  2. Apply production-pipeline calibration (isotonic + Benter)
     — NOT Dirichlet, which was reverted on 2026-04-27 after
       drift +0.0075 vs raw on n=8306 current season
  3. Compute nonconformity score s_i = 1 - p_calibrated[ft_result]
  4. For each league × α (0.05 / 0.10 / 0.20):
       q_trained        = quantile from public/conformal-quantiles.json
       coverage_empir.  = mean(s_i ≤ q_trained) for that league
       drift            = coverage_empir. - (1 - α)
       flag             = ok / borderline / drift / catastrophic

Output:
  tools/backtest/conformal-drift-report.json — decision-grade artifact
  with per-league flags + summary recommendation. Used to decide
  whether to keep `warn` mode or trigger a re-fit via fit_conformal_gate.py.

Usage:
  tools/venv/bin/python3 tools/backtest/validate_conformal_drift.py
  tools/venv/bin/python3 tools/backtest/validate_conformal_drift.py --from 2025-08-01
═══════════════════════════════════════════════════════════════════
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
from datetime import datetime

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PRED_PARQUET = os.path.join(PROJECT_ROOT, "tools/backtest/v2-oot-predictions.parquet")
CALIB_JSON = os.path.join(PROJECT_ROOT, "public/calibration_curves.json")
BENTER_JSON = os.path.join(PROJECT_ROOT, "public/benter-weights.json")
QUANTILES_JSON = os.path.join(PROJECT_ROOT, "public/conformal-quantiles.json")
OUTPUT_JSON = os.path.join(PROJECT_ROOT, "tools/backtest/conformal-drift-report.json")

# Drift thresholds (in absolute coverage-percentage points)
THRESHOLDS = {
    "ok_min": -0.02,         # under-cover by ≤ 2pp → still ok
    "borderline_min": -0.03,  # 2-3pp under-cover → borderline (monitor)
    "drift_min": -0.05,       # 3-5pp under-cover → drift (refit)
    # below 5pp under-cover → catastrophic (block enforce mode)
}

# ─── Env loader (same as score_current_season.py) ──────────────
ENV_PATH = os.path.join(PROJECT_ROOT, ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)

SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_KEY")


# ─── Calibration math (mirrors src/lib/calibration.ts production pipeline) ───

def load_isotonic():
    """
    Loads public/calibration_curves.json. Despite the filename, this is
    actually Platt-style (sigmoid) calibration with per-outcome (a, b)
    parameters — matches production runtime in src/lib/calibration.ts.
    """
    with open(CALIB_JSON) as f:
        d = json.load(f)
    return d


def apply_platt(probs, calib, league):
    """
    probs: array [pH, pD, pA].
    calib: loaded calibration_curves.json content.
    Returns: calibrated array, normalized to sum=1.
    """
    league_params = calib.get("platt_params_league", {}).get(league)
    params = league_params if league_params else calib["platt_params"]

    def sig(p, ab):
        # sigmoid(a * logit(p) + b) — Platt's standard form
        a, b = ab["a"], ab["b"]
        eps = 1e-6
        p = np.clip(p, eps, 1 - eps)
        logit = np.log(p / (1 - p))
        return 1.0 / (1.0 + np.exp(-(a * logit + b)))

    out = np.array([
        sig(probs[0], params["H"]),
        sig(probs[1], params["D"]),
        sig(probs[2], params["A"]),
    ])
    s = out.sum()
    return out / s if s > 0 else np.array([1/3, 1/3, 1/3])


def load_benter():
    with open(BENTER_JSON) as f:
        d = json.load(f)
    return d.get("engines", {}).get("v2", {})


def vig_remove(odds_h, odds_d, odds_a):
    if any(o is None or pd.isna(o) or o <= 1 for o in [odds_h, odds_d, odds_a]):
        return None
    p = np.array([1.0 / odds_h, 1.0 / odds_d, 1.0 / odds_a])
    return p / p.sum()


def apply_benter(model_probs, pinn_probs, betas):
    """β1·log(model) + β2·log(pinn) → softmax. Matches src/lib/benter-blend.ts."""
    if pinn_probs is None or betas is None:
        return model_probs
    b1 = float(betas.get("beta1", 1.0))
    b2 = float(betas.get("beta2", 0.0))
    log_m = np.log(np.maximum(model_probs, 1e-9))
    log_p = np.log(np.maximum(pinn_probs, 1e-9))
    z = b1 * log_m + b2 * log_p
    z -= np.max(z)
    e = np.exp(z)
    return e / e.sum()


# ─── Supabase fetch (closing odds for Benter blend) ────────────

def normalize_team(name):
    if name is None or (isinstance(name, float) and pd.isna(name)):
        return ""
    return (str(name).lower().replace(" ", "").replace("ü", "u")
            .replace("ö", "o").replace("ä", "a").replace("ß", "ss")
            .replace(".", "").replace("'", ""))


def fuzzy_match(a, b):
    na, nb = normalize_team(a), normalize_team(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if len(na) >= 4 and (nb.startswith(na[:4]) or na in nb):
        return True
    if len(nb) >= 4 and (na.startswith(nb[:4]) or nb in na):
        return True
    return False


def fetch_closing_odds(date_from, date_to):
    if not SUPA_URL or not SUPA_KEY:
        print("⚠ Supabase env missing — Benter blend will skip", file=sys.stderr)
        return []
    headers = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
    out = []
    offset, page = 0, 1000
    while True:
        params = urllib.parse.urlencode({
            "select": "league,match_date,home_team,away_team,psch,pscd,psca",
            "match_date": f"gte.{date_from}",
        })
        url = f"{SUPA_URL}/rest/v1/odds_closing_history?{params}&match_date=lte.{date_to}&limit={page}&offset={offset}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req) as r:
                rows = json.loads(r.read().decode())
        except Exception as e:
            print(f"⚠ closing odds fetch failed: {e}", file=sys.stderr)
            return out
        if not rows:
            break
        out.extend(rows)
        offset += page
        if len(rows) < page:
            break
    return out


# ─── Drift classification ──────────────────────────────────────

def classify_drift(coverage_empirical, expected):
    drift = coverage_empirical - expected
    if drift >= THRESHOLDS["ok_min"]:
        return "ok", drift
    if drift >= THRESHOLDS["borderline_min"]:
        return "borderline", drift
    if drift >= THRESHOLDS["drift_min"]:
        return "drift", drift
    return "catastrophic", drift


# ─── Main ─────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="date_from", default="2025-08-01",
                    help="Start of validation window (default: current season)")
    ap.add_argument("--to", dest="date_to", default=datetime.utcnow().strftime("%Y-%m-%d"))
    ap.add_argument("--no-benter", action="store_true",
                    help="Skip Benter blend (test isotonic-only)")
    args = ap.parse_args()

    print("═══════════════════════════════════════════════════════════")
    print(" FODZE — Conformal Gate Drift Validation")
    print("═══════════════════════════════════════════════════════════")
    print(f"   Window: {args.date_from} → {args.date_to}")
    print("   ⚠ DEPRECATED: applies Platt→Benter (runtime is Benter→Platt) + approximate Platt.")
    print("     Verdicts unreliable — use refit_conformal_runtime.py (runs the REAL calibrate1X2).")
    if args.no_benter:
        print(f"   --no-benter → isotonic-only sanity check")
    print()

    # 1. Load predictions
    df = pd.read_parquet(PRED_PARQUET)
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
    df = df[(df["match_date"] >= args.date_from) & (df["match_date"] <= args.date_to)].copy()
    df = df[df["ft_result"].notna()].copy()
    print(f"   Predictions (current-season, with ft_result): {len(df)}")

    # 2. Load calibration artifacts
    calib = load_isotonic()
    benter_v2 = load_benter()
    benter_leagues = benter_v2.get("leagues", {})
    benter_global = benter_v2.get("global", {"beta1": 1.0, "beta2": 0.0})
    print(f"   Calibration: isotonic loaded ({len(calib.get('platt_params_league', {}))} league overrides)")
    print(f"   Benter: {len(benter_leagues)} per-league weights")

    # 3. Load conformal quantiles
    with open(QUANTILES_JSON) as f:
        quant = json.load(f)
    leagues_quantiles = quant["leagues"]
    quant_meta = quant.get("_meta", {})
    print(f"   Quantiles: {len(leagues_quantiles)} leagues, trained {quant_meta.get('trained_at', 'unknown')}")
    print()

    # 4. Load closing odds (if Benter active)
    odds_by_lg = {}
    if not args.no_benter:
        print("   Fetching closing odds from odds_closing_history...")
        odds = fetch_closing_odds(args.date_from, args.date_to)
        for o in odds:
            odds_by_lg.setdefault((o["league"], o["match_date"]), []).append(o)
        print(f"   Closing odds rows: {len(odds)}")
        print()

    # 5. Compute nonconformity scores per row
    scores_by_league = {}  # league -> list of nonconformity scores
    benter_applied_count = 0
    total_processed = 0

    for _, row in df.iterrows():
        league = row["league"]
        ft = row["ft_result"]
        if ft not in ("H", "D", "A"):
            continue

        raw = np.array([row["prob_h_raw"], row["prob_d_raw"], row["prob_a_raw"]])
        # Step 1: isotonic
        cal = apply_platt(raw, calib, league)

        # Step 2: optional Benter
        if not args.no_benter:
            odds_candidates = odds_by_lg.get((league, row["match_date"]), [])
            odds_match = None
            for o in odds_candidates:
                if (fuzzy_match(row["home_team"], o["home_team"])
                        and fuzzy_match(row["away_team"], o["away_team"])):
                    odds_match = o
                    break
            if odds_match:
                pinn = vig_remove(odds_match.get("psch"), odds_match.get("pscd"), odds_match.get("psca"))
                if pinn is not None:
                    betas = benter_leagues.get(league, benter_global)
                    cal = apply_benter(cal, pinn, betas)
                    benter_applied_count += 1

        # Step 3: nonconformity score s = 1 - p_calibrated[ft_result]
        idx = {"H": 0, "D": 1, "A": 2}[ft]
        score = 1.0 - cal[idx]

        scores_by_league.setdefault(league, []).append(score)
        total_processed += 1

    print(f"   Scored predictions: {total_processed}")
    print(f"   Benter blend applied: {benter_applied_count} ({benter_applied_count*100//max(total_processed,1)}%)")
    print()

    # 6. Per-league × per-alpha coverage measurement
    report = {
        "validated_at": datetime.utcnow().isoformat() + "Z",
        "calibration_pipeline": "isotonic" if args.no_benter else "isotonic+benter",
        "n_predictions_total": total_processed,
        "n_benter_applied": benter_applied_count,
        "window": {"from": args.date_from, "to": args.date_to},
        "trained_quantiles_source": quant_meta,
        "leagues": {},
        "summary": {},
    }

    flag_counts = {"ok": 0, "borderline": 0, "drift": 0, "catastrophic": 0}
    league_results = []

    print(f"{'LEAGUE':18s} | {'N':>5s} | {'α':>5s} | {'q':>6s} | {'EXPECT':>7s} | {'EMPIR':>7s} | {'DRIFT':>7s} | FLAG")
    print("-" * 90)

    for league, scores in sorted(scores_by_league.items()):
        scores_arr = np.array(scores)
        n = len(scores_arr)
        if league not in leagues_quantiles:
            continue
        league_q = leagues_quantiles[league]
        league_block = {"n": n, "alphas": {}}
        league_worst_flag = "ok"
        for alpha_str, q in sorted(league_q.items()):
            alpha = float(alpha_str)
            expected = 1.0 - alpha
            empirical = float(np.mean(scores_arr <= q))
            flag, drift = classify_drift(empirical, expected)
            league_block["alphas"][alpha_str] = {
                "q": float(q),
                "expected_coverage": expected,
                "empirical_coverage": empirical,
                "drift": float(drift),
                "flag": flag,
            }
            # Worst flag tracking — order: ok < borderline < drift < catastrophic
            order = {"ok": 0, "borderline": 1, "drift": 2, "catastrophic": 3}
            if order[flag] > order[league_worst_flag]:
                league_worst_flag = flag

            print(f"{league:18s} | {n:5d} | {alpha:5.2f} | {q:6.4f} | "
                  f"{expected:7.4f} | {empirical:7.4f} | {drift:+7.4f} | {flag}")

        league_block["worst_flag"] = league_worst_flag
        report["leagues"][league] = league_block
        flag_counts[league_worst_flag] += 1
        league_results.append((league, league_worst_flag, n))

    # Summary
    n_leagues_validated = len(report["leagues"])
    drift_or_worse = flag_counts["drift"] + flag_counts["catastrophic"]

    if flag_counts["catastrophic"] > 0:
        recommendation = "BLOCK enforce-mode flip; refit immediately"
    elif drift_or_worse >= 4:
        recommendation = "Refit recommended (≥4 leagues drifted)"
    elif drift_or_worse >= 1:
        recommendation = "Watch — 1-3 leagues drifting; conditional refit"
    else:
        recommendation = "Quantiles valid; warn-mode safe to keep"

    report["summary"] = {
        "n_leagues_validated": n_leagues_validated,
        "flag_counts": flag_counts,
        "recommendation": recommendation,
    }

    print()
    print("─" * 90)
    print(f"   Leagues validated:  {n_leagues_validated}")
    print(f"   ok:                 {flag_counts['ok']}")
    print(f"   borderline:         {flag_counts['borderline']}")
    print(f"   drift:              {flag_counts['drift']}")
    print(f"   catastrophic:       {flag_counts['catastrophic']}")
    print(f"   → recommendation:   {recommendation}")
    print()

    # Write artifact
    with open(OUTPUT_JSON, "w") as f:
        json.dump(report, f, indent=2)
    print(f"✅ Report → {OUTPUT_JSON}")


if __name__ == "__main__":
    main()

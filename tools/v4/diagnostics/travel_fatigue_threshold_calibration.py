"""Travel-fatigue veto threshold calibration — empirical pre-step.

Tests whether the combination of (away_team_travel_distance × rest_days_since_
last_match × congestion_last_14d) identifies matches where the away team is
systematically over-rated by our v2 model, justifying an away-side stake
haircut.

Methodology (analog to CSD calibration):
  1. Load v2-oot-predictions (6525 OOT matches).
  2. Build team → stadium lat/lng index from local mirror (278 teams, 100%
     coords where row exists; ~30% join coverage on FODZE team-universe).
  3. Per match × away_team: compute (travel_km_one_way, rest_days, congestion_14d).
  4. Per threshold-set, classify match as one of:
       brutal | high | moderate | low | no_data
  5. Multi-class Brier per bucket; bootstrap CI on lift vs "low" baseline.

Acceptance gate (per threshold-set × severity):
  PASS if Brier(in-state) - Brier(low) > +0.030 AND CI_lower > 0
       AND n_in_state >= 100

Coverage note:
  Stadium join coverage ≈ 30 % (84 of 362 FODZE teams). Bei missing coords:
  match wird als 'no_data' klassifiziert → kein Veto (M5 MNAR-safe).

Output:
  tools/v4/diagnostics/travel_fatigue_calibration.json
"""
from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from math import asin, cos, pi, radians, sin, sqrt
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from v4.data.loaders import load_team_xg_history  # noqa: E402

LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
INPUT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "travel_fatigue_calibration.json"

BOOTSTRAP_N = 1000
RNG_SEED = 20260521
BRIER_LIFT_GATE = 0.030
MIN_N_IN_STATE = 100


THRESHOLD_SETS = [
    # Each rule: (min_distance_km, max_rest_days, label)
    # Order = priority (most-severe first; first match wins).
    {
        "label": "loose",
        "rules": [
            {"min_km": 1500, "max_rest": 4, "severity": "brutal"},
            {"min_km":  800, "max_rest": 3, "severity": "high"},
            {"min_km":  400, "max_rest": 2, "severity": "moderate"},
        ],
    },
    {
        "label": "moderate",
        "rules": [
            {"min_km": 2000, "max_rest": 3, "severity": "brutal"},
            {"min_km": 1000, "max_rest": 2, "severity": "high"},
            {"min_km":  500, "max_rest": 1, "severity": "moderate"},
        ],
    },
    {
        "label": "tight",
        "rules": [
            {"min_km": 2500, "max_rest": 3, "severity": "brutal"},
            {"min_km": 1500, "max_rest": 2, "severity": "high"},
            {"min_km":  800, "max_rest": 1, "severity": "moderate"},
        ],
    },
    {
        # Distance-only — ignore rest entirely. Tests whether the signal
        # is pure-distance or really needs the rest-interaction.
        "label": "distance_only",
        "rules": [
            {"min_km": 2000, "max_rest": 99, "severity": "brutal"},
            {"min_km": 1000, "max_rest": 99, "severity": "high"},
            {"min_km":  500, "max_rest": 99, "severity": "moderate"},
        ],
    },
]


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance (same math as scripts/_lib/geo.mjs)."""
    if any(x is None or not np.isfinite(x) for x in (lat1, lng1, lat2, lng2)):
        return float("nan")
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * R * asin(min(1.0, sqrt(a)))


def load_stadium_index() -> dict[str, dict]:
    """team_name → {lat, lng} mapping."""
    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)
    rows = conn.execute(
        "SELECT team, lat, lng FROM stadiums WHERE lat IS NOT NULL AND lng IS NOT NULL"
    ).fetchall()
    conn.close()
    out: dict[str, dict] = {}
    for team, lat, lng in rows:
        out[team] = {"lat": float(lat), "lng": float(lng)}
    return out


def _classify(distance_km: float, rest_days: int, rules: list[dict]) -> str:
    if not np.isfinite(distance_km) or rest_days is None or rest_days < 0:
        return "no_data"
    for rule in rules:
        if distance_km >= rule["min_km"] and rest_days <= rule["max_rest"]:
            return rule["severity"]
    return "low"


def _match_brier(row) -> float:
    realized = {"H": 0, "D": 0, "A": 0}
    realized[row["ft_result"]] = 1
    return float(
        (row["prob_h_raw"] - realized["H"]) ** 2
        + (row["prob_d_raw"] - realized["D"]) ** 2
        + (row["prob_a_raw"] - realized["A"]) ** 2
    )


def _bootstrap_ci(brier_in: np.ndarray, brier_base: np.ndarray, n_boot=BOOTSTRAP_N):
    rng = np.random.default_rng(RNG_SEED)
    if len(brier_in) == 0 or len(brier_base) == 0:
        return (0.0, 0.0, 0.0)
    lifts = np.empty(n_boot)
    for i in range(n_boot):
        bi = rng.choice(brier_in, size=len(brier_in), replace=True).mean()
        bb = rng.choice(brier_base, size=len(brier_base), replace=True).mean()
        lifts[i] = bi - bb
    return (
        float(brier_in.mean() - brier_base.mean()),
        float(np.percentile(lifts, 2.5)),
        float(np.percentile(lifts, 97.5)),
    )


def main():
    print(f"[load] reading {INPUT_PARQUET.name}")
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date"] = pd.to_datetime(preds["match_date"])
    print(f"[load] {len(preds):,} predictions")

    print("[load] stadium index from local mirror")
    stadium_idx = load_stadium_index()
    print(f"[load] {len(stadium_idx):,} stadiums with coords")

    # Load team_xg_history for rest-days computation (need last-match-date per team)
    earliest = preds["match_date"].min() - pd.Timedelta(days=60)
    team_xg = load_team_xg_history(since=earliest.strftime("%Y-%m-%d"))
    print(f"[load] {len(team_xg):,} team-rows for rest-days computation")

    # Pre-index team match-dates per (league, team)
    print("[index] building team match-date index...")
    team_xg = team_xg.sort_values(["league", "team", "match_date"], kind="mergesort")
    team_dates_idx: dict[tuple[str, str], np.ndarray] = {}
    for (league, team), g in team_xg.groupby(["league", "team"], sort=False):
        team_dates_idx[(league, team)] = g["match_date"].values

    def last_match_date_before(league: str, team: str, kickoff: np.datetime64):
        arr = team_dates_idx.get((league, team))
        if arr is None or len(arr) == 0:
            return None
        mask = arr < kickoff
        if not mask.any():
            return None
        return arr[mask][-1]

    # Per-match: compute (distance, rest_days, congestion) for away team
    print("[compute] per-match travel-fatigue features...")
    distances = []
    rest_days = []
    coverage_misses = {"missing_home_stadium": 0, "missing_away_stadium": 0,
                      "missing_rest_data": 0, "complete": 0}

    for _, row in preds.iterrows():
        home_team = row["home_team"]
        away_team = row["away_team"]
        league = row["league"]
        kickoff = row["match_date"].to_datetime64()

        home_st = stadium_idx.get(home_team)
        away_st = stadium_idx.get(away_team)

        if home_st is None:
            coverage_misses["missing_home_stadium"] += 1
            distances.append(float("nan"))
            rest_days.append(None)
            continue
        if away_st is None:
            coverage_misses["missing_away_stadium"] += 1
            distances.append(float("nan"))
            rest_days.append(None)
            continue

        dist = haversine_km(away_st["lat"], away_st["lng"],
                           home_st["lat"], home_st["lng"])

        last_date = last_match_date_before(league, away_team, kickoff)
        if last_date is None:
            coverage_misses["missing_rest_data"] += 1
            distances.append(dist)
            rest_days.append(None)
            continue

        rd = int((kickoff - last_date) / np.timedelta64(1, "D"))
        distances.append(dist)
        rest_days.append(rd)
        coverage_misses["complete"] += 1

    preds["travel_km"] = distances
    preds["rest_days"] = rest_days
    preds["brier"] = preds.apply(_match_brier, axis=1)

    print(f"[coverage] {coverage_misses}")
    n_complete = coverage_misses["complete"]
    print(f"[coverage] {n_complete:,} of {len(preds):,} matches "
          f"({100*n_complete/len(preds):.1f}%) have full travel+rest data")

    # Quick distribution of distances on complete subset
    if n_complete > 0:
        d = pd.Series(distances).dropna()
        print(f"[dist] travel_km percentiles: "
              f"p50={d.quantile(0.50):.0f}, p75={d.quantile(0.75):.0f}, "
              f"p90={d.quantile(0.90):.0f}, p95={d.quantile(0.95):.0f}, "
              f"p99={d.quantile(0.99):.0f}, max={d.max():.0f}")
        r = pd.Series(rest_days).dropna()
        print(f"[dist] rest_days: p10={r.quantile(0.10):.0f}, "
              f"p25={r.quantile(0.25):.0f}, p50={r.quantile(0.50):.0f}, "
              f"p75={r.quantile(0.75):.0f}")

    # For each threshold-set, classify and compute Brier-lift
    results = []
    for ts_def in THRESHOLD_SETS:
        regimes = []
        for _, row in preds.iterrows():
            regimes.append(_classify(row["travel_km"], row["rest_days"], ts_def["rules"]))
        preds["_regime"] = regimes

        brier_low = preds.loc[preds["_regime"] == "low", "brier"].values
        if len(brier_low) == 0:
            continue

        for severity in ("brutal", "high", "moderate"):
            mask = preds["_regime"] == severity
            n_in = int(mask.sum())
            if n_in == 0:
                results.append({
                    "threshold_set": ts_def["label"],
                    "severity": severity,
                    "n_in_state": 0,
                    "brier_in_state": None,
                    "brier_low_baseline": float(brier_low.mean()),
                    "brier_lift": None,
                    "ci_lower_95": None,
                    "ci_upper_95": None,
                    "passes_gate": False,
                })
                continue
            brier_in = preds.loc[mask, "brier"].values
            lift, ci_lo, ci_hi = _bootstrap_ci(brier_in, brier_low)
            passes = (n_in >= MIN_N_IN_STATE
                     and lift > BRIER_LIFT_GATE and ci_lo > 0)
            results.append({
                "threshold_set": ts_def["label"],
                "severity": severity,
                "n_in_state": n_in,
                "brier_in_state": float(brier_in.mean()),
                "brier_low_baseline": float(brier_low.mean()),
                "brier_lift": lift,
                "ci_lower_95": ci_lo,
                "ci_upper_95": ci_hi,
                "passes_gate": passes,
            })

    # Recommendation
    passing = [r for r in results if r["passes_gate"]]
    if passing:
        best = max(passing, key=lambda r: r["brier_lift"])
        recommendation = {
            "ship_travel_veto": True,
            "threshold_set": best["threshold_set"],
            "severity": best["severity"],
            "n_in_state": best["n_in_state"],
            "brier_lift": best["brier_lift"],
            "ci_lower_95": best["ci_lower_95"],
            "rationale": (
                f"{best['severity']} severity on {best['threshold_set']} thresholds: "
                f"n={best['n_in_state']}, lift +{best['brier_lift']:.4f} "
                f"(CI [{best['ci_lower_95']:.4f}, {best['ci_upper_95']:.4f}])."
            ),
        }
    else:
        adequately_powered = [r for r in results
                              if r["n_in_state"] is not None
                              and r["n_in_state"] >= MIN_N_IN_STATE]
        if adequately_powered:
            closest = max(adequately_powered,
                         key=lambda r: r["brier_lift"] if r["brier_lift"] is not None else -1)
            rationale = (
                f"NO config passes gate. Closest: {closest['threshold_set']}/"
                f"{closest['severity']}: n={closest['n_in_state']}, "
                f"lift={closest['brier_lift']:.4f}, "
                f"CI=[{closest['ci_lower_95']:.4f}, {closest['ci_upper_95']:.4f}]."
            )
        else:
            rationale = (
                f"NO config has n >= {MIN_N_IN_STATE}. Stadium-coverage gap "
                f"({n_complete}/{len(preds)} complete) likely limits power."
            )
        recommendation = {"ship_travel_veto": False, "rationale": rationale}

    output = {
        "version": "1.0",
        "input_n": len(preds),
        "input_path": str(INPUT_PARQUET.relative_to(REPO_ROOT)),
        "coverage": coverage_misses,
        "params": {
            "bootstrap_n": BOOTSTRAP_N,
            "brier_lift_gate": BRIER_LIFT_GATE,
            "min_n_in_state": MIN_N_IN_STATE,
        },
        "threshold_sets": THRESHOLD_SETS,
        "results": results,
        "recommendation": recommendation,
    }

    OUTPUT_JSON.write_text(json.dumps(output, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")
    print(f"[recommendation] ship_travel_veto = {recommendation['ship_travel_veto']}")
    print(f"[rationale] {recommendation['rationale']}")


if __name__ == "__main__":
    main()

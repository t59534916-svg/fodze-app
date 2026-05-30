#!/usr/bin/env python3
"""eval_per_league_routing — does per-league engine routing beat one engine for all?

The honest version of "pick the best engine per league". The overfitting trap:
choosing the best engine per league ON a holdout and scoring ON the same holdout
is in-sample cherry-picking (looks great, is noise — cf. the O/U per-league
"winners" that flipped sign across seasons). So this is strictly CROSS-SEASON:

  decide routing on season A (argmin per-league Brier) → apply BLIND to season B
  → compare to "use one engine everywhere". If the routing decided on A still
  beats Blend-everywhere on B, per-league engine-strength is a persistent,
  routable property. If not, it's noise and the Blend already captures it.

Engines (only those scorable on BOTH seasons via the corpus builder; the parquet
engines Standard/v1/v2 are 25/26-only → excluded):
  dev-03  · dev-09  · Blend (50/50 λ)   — OOT-clean tags per season.
Metric: 1X2 Brier (RAW DC probs — the forecast-precision question, not betting).

Output: tools/v4/diagnostics/eval_per_league_routing.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/eval_per_league_routing.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO
ENGINES = ["dev-03", "dev-09", "Blend"]
MIN_LEAGUE_N = 30   # need this many matches in the DECISION season to route a league
_HIST = None


def predict_season(season, d03_tag, d09_tag):
    """Returns DataFrame: league, y(0/1/2), and 1X2 Brier-per-match for each engine."""
    global _HIST
    d09h = BayesianEnsemble.load(ART / f"m3_xg-home-{d09_tag}.pkl")
    d09a = BayesianEnsemble.load(ART / f"m3_xg-away-{d09_tag}.pkl")
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{d03_tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{d03_tag}.pkl", rho=RHO)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    if _HIST is None:
        _HIST = load_team_xg_history()
    Xd = extract_X_dev09(t)
    mh, _ = d09h.predict(Xd[d09h.feature_names]); ma, _ = d09a.predict(Xd[d09a.feature_names])
    lh9 = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX); la9 = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)
    din = pd.DataFrame({"league": t["league"].astype(str), "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"], "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, _HIST, verbose=False)
    lh3 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la3 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    p = {
        "dev-03": X._lambdas_to_1x2(lh3, la3, RHO),
        "dev-09": X._lambdas_to_1x2(lh9, la9, RHO),
        "Blend": X._lambdas_to_1x2(0.5 * (lh3 + lh9), 0.5 * (la3 + la9), RHO),
    }
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    y1h = np.eye(3)[y]
    out = {"league": t["league"].astype(str).to_numpy(), "y": y}
    for e in ENGINES:
        out[f"bpm__{e}"] = ((p[e] - y1h) ** 2).sum(1)  # per-match Brier
    return pd.DataFrame(out)


def league_brier(df, league=None):
    sub = df if league is None else df[df["league"] == league]
    return {e: float(sub[f"bpm__{e}"].mean()) for e in ENGINES}, len(sub)


def decide_routing(df_decide):
    """Per-league argmin-Brier engine on the decision season (fallback global-best)."""
    glob, _ = league_brier(df_decide)
    global_best = min(glob, key=glob.get)
    route = {}
    for lg in sorted(df_decide["league"].unique()):
        br, n = league_brier(df_decide, lg)
        route[lg] = (min(br, key=br.get) if n >= MIN_LEAGUE_N else global_best)
    return route, global_best


def apply_routing(df_apply, route, fallback):
    """Overall Brier when each match uses its league's routed engine."""
    bpm = np.array([df_apply.iloc[i][f"bpm__{route.get(df_apply.iloc[i]['league'], fallback)}"]
                    for i in range(len(df_apply))])
    return float(bpm.mean())


def main() -> int:
    seasons = {"25/26": ("dev-03", "dev-09-phase42-seed-000"),
               "24/25": ("dev-03-2h", "dev-09-2h")}
    dfs = {}
    for s, (d03t, d09t) in seasons.items():
        print(f"predicting {s} (dev-03={d03t} · dev-09={d09t}) …")
        dfs[s] = predict_season(s, d03t, d09t)
        gb, n = league_brier(dfs[s])
        print(f"  {s}: n={n} · global Brier " + " · ".join(f"{e} {gb[e]:.4f}" for e in ENGINES))

    res = {"engines": ENGINES, "min_league_n": MIN_LEAGUE_N, "directions": {}}
    print("\n" + "═" * 78)
    print("  CROSS-SEASON ROUTING (decide on A → apply BLIND to B)")
    print("═" * 78)
    for decide_s, apply_s in [("24/25", "25/26"), ("25/26", "24/25")]:
        route, gbest = decide_routing(dfs[decide_s])
        df_b = dfs[apply_s]
        routed = apply_routing(df_b, route, gbest)
        base = {e: league_brier(df_b)[0][e] for e in ENGINES}          # one-engine-everywhere
        glob_route = base[gbest]                                        # global-best-of-A applied to B
        # oracle: best-per-league chosen ON B itself (in-sample upper bound), n-weighted
        num, den = 0.0, 0
        for lg in df_b["league"].unique():
            br, n = league_brier(df_b, lg)
            num += min(br.values()) * n; den += n
        oracle = num / den

        best_base = min(base, key=base.get)
        print(f"\n  decide {decide_s} → apply {apply_s}:")
        print(f"    one-engine-everywhere: " + " · ".join(f"{e} {base[e]:.4f}" for e in ENGINES)
              + f"   (best: {best_base})")
        print(f"    ROUTED (A→B):          {routed:.4f}")
        print(f"    global-best({gbest}) of A on B: {glob_route:.4f}")
        print(f"    oracle (best-per-liga ON B, in-sample bound): {oracle:.4f}")
        delta_vs_blend = routed - base["Blend"]
        delta_vs_bestbase = routed - base[best_base]
        verdict = ("ROUTING ADDS SIGNAL" if delta_vs_bestbase < -0.0005
                   else "NO GAIN — routing ≈/worse than one-engine-everywhere (per-league strength is noise)")
        print(f"    Δ routed vs Blend-everywhere: {delta_vs_blend:+.4f} · vs best-single({best_base}): {delta_vs_bestbase:+.4f}  ⇒ {verdict}")
        res["directions"][f"{decide_s}->{apply_s}"] = {
            "routed_brier": routed, "one_engine_everywhere": base, "best_single": best_base,
            "global_best_of_decide": gbest, "global_best_applied": glob_route, "oracle_in_sample": oracle,
            "delta_vs_blend": delta_vs_blend, "delta_vs_best_single": delta_vs_bestbase, "verdict": verdict,
            "route": route,
        }

    # ── persistence table: does each league's best engine survive across seasons? ──
    print("\n" + "═" * 78)
    print("  PER-LEAGUE BEST ENGINE — persists across seasons? (the crux)")
    print("═" * 78)
    leagues = sorted(set(dfs["24/25"]["league"]) & set(dfs["25/26"]["league"]))
    persist = 0; total = 0
    persist_rows = {}
    for lg in leagues:
        b24, n24 = league_brier(dfs["24/25"], lg)
        b25, n25 = league_brier(dfs["25/26"], lg)
        if n24 < MIN_LEAGUE_N or n25 < MIN_LEAGUE_N:
            continue
        w24, w25 = min(b24, key=b24.get), min(b25, key=b25.get)
        same = w24 == w25
        persist += same; total += 1
        persist_rows[lg] = {"n24": n24, "n25": n25, "best_24_25": w24, "best_25_26": w25, "persists": same}
        print(f"    {lg:<16} 24/25→{w24:<7} 25/26→{w25:<7} {'✓ persists' if same else '✗ flips'}")
    print(f"\n  persistence: {persist}/{total} leagues keep the same best engine across seasons")
    res["persistence"] = {"n_persist": persist, "n_total": total, "rate": persist / total if total else None,
                          "per_league": persist_rows}

    # ── overall verdict ──
    d1 = res["directions"]["24/25->25/26"]; d2 = res["directions"]["25/26->24/25"]
    routing_helps = (d1["delta_vs_best_single"] < -0.0005) and (d2["delta_vs_best_single"] < -0.0005)
    prate = res["persistence"]["rate"]
    verdict = (
        f"Cross-season routing: 24/25→25/26 Δ {d1['delta_vs_best_single']:+.4f} vs best-single, "
        f"25/26→24/25 Δ {d2['delta_vs_best_single']:+.4f}. Per-league best-engine persistence "
        f"{persist}/{total} ({100*prate:.0f}%). VERDICT: "
        + ("ROUTING IS WORTH IT — gain persists both directions" if routing_helps else
           "ROUTING NOT WORTH IT — per-league engine-strength does NOT persist cross-season; "
           "it is noise (same trap as the O/U per-league winners). Use the globally-best engine "
           "everywhere (the Blend) instead.")
    )
    print("\n" + "─" * 78)
    print(f"  {verdict}")
    res["verdict"] = verdict
    (D / "eval_per_league_routing.json").write_text(json.dumps(res, indent=2, default=float))
    print(f"  ✓ {(D / 'eval_per_league_routing.json').relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

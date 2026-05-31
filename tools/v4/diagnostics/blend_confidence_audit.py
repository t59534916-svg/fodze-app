#!/usr/bin/env python3
"""blend_confidence_audit — PROVE the wired-Blend HOCH 76.4% is real, not fabricated.

Companion to blend_confidence_calibration.py. Where that script reports tier
aggregates, this one shows the WORK: it rebuilds the wired Blend (dev-03 ⊕ v2)
on 25/26 KEEPING the match identifiers, dumps EVERY ≥65%-confidence match (real
team names, date, blend probs, predicted pick, actual score, hit/miss) to a CSV,
and recomputes the HOCH hit-rate by trivial counting (hits / n) that the reader
can verify by eye. Then it cross-checks a sample of the actual scores against the
UPSTREAM sofascore_match table (home_score/away_score, joined on game_id) — proving
the outcomes are real Sofa results, NOT synthesized by the feature builder.

Three independent things this establishes:
  1. The HOCH number is a real count over real matches (full CSV trail).
  2. Those matches are real fixtures with real scores (game_id cross-check vs the
     raw sofascore_match table — a DIFFERENT table than the corpus extraction).
  3. The blend math is transparent (50/50 λ-average → Dixon-Coles, inline here).

Output: tools/v4/diagnostics/blend_confidence_audit_hoch_25-26.csv (+ stdout proof)
Run:    tools/venv/bin/python3 -I tools/v4/diagnostics/blend_confidence_audit.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X
# reuse ONLY the data-locating constants + the v2↔corpus nearest-date join helper
from blend_confidence_calibration import NearestResolver, ART, BT, SQLITE, RHO
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
SEASON = "25/26"


def main() -> int:
    print("═" * 80)
    print("  BLEND CONFIDENCE AUDIT — proving the wired dev-03⊕v2 HOCH (≥65%) is real")
    print("═" * 80)

    # ── 1. corpus with identifiers (game_id is the upstream Sofa key) ──
    fb = FeatureBuilderDev09(SQLITE).fit()
    t = fb.build_corpus(seasons=(SEASON,), leagues=None, verbose=False).reset_index(drop=True)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    league = t["league"].astype(str).to_numpy()
    cdate = pd.to_datetime(t["match_date"]).dt.date.to_numpy()
    gh = t["home_goals"].to_numpy(float)
    ga = t["away_goals"].to_numpy(float)
    actual = np.array([X._outcome(h, a) for h, a in zip(gh, ga)], dtype=int)
    print(f"  corpus: {len(t):,} matches (25/26 Sofa-native, game_id-keyed)")

    # ── 2. dev-03 λ (production pickle) ──
    d03 = XGPredictor.from_artifacts(home_path=ART / "m3_xg-home-dev-03.pkl",
                                     away_path=ART / "m3_xg-away-dev-03.pkl", rho=RHO)
    hist = load_team_xg_history()
    d03_in = pd.DataFrame({"league": t["league"].astype(str),
                           "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                           "home": t["ch"], "away": t["ca"],
                           "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(d03_in, hist, verbose=False)
    lh03 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la03 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)

    # ── 3. v2 λ from the OOT parquet, joined onto corpus rows (nearest date) ──
    v2 = X.parquet_engine(BT / "v2-oot-predictions.parquet")
    res = NearestResolver()
    for r in v2.itertuples(index=False):
        res.add(r.league, r.ch, r.ca, r.cdate, (float(r.lam_h), float(r.lam_a)))
    lhv2 = np.full(len(t), np.nan); lav2 = np.full(len(t), np.nan)
    for i in range(len(t)):
        hit = res.resolve(league[i], t["ch"].iloc[i], t["ca"].iloc[i], cdate[i])
        if hit is not None:
            lhv2[i], lav2[i] = hit
    has_v2 = np.isfinite(lhv2)
    print(f"  v2 join: {has_v2.sum():,}/{len(t):,} matches")

    # ── 4. the WIRED blend, exactly as MatchdayContext does it: 50/50 λ-average ──
    sel = has_v2  # blend only defined where both legs exist
    blH = 0.5 * (lh03[sel] + lhv2[sel])
    blA = 0.5 * (la03[sel] + lav2[sel])
    p = X._lambdas_to_1x2(np.clip(blH, X.LAMBDA_MIN, X.LAMBDA_MAX),
                          np.clip(blA, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    conf = p.max(1)
    pick = p.argmax(1)
    act = actual[sel]
    hit = (pick == act).astype(int)

    # full per-match table (the auditable trail)
    tbl = pd.DataFrame({
        "game_id": t["game_id"].to_numpy()[sel].astype("int64"),
        "date": pd.to_datetime(t["match_date"]).dt.strftime("%Y-%m-%d").to_numpy()[sel],
        "league": league[sel],
        "home": t["home_team"].to_numpy()[sel], "away": t["away_team"].to_numpy()[sel],
        "P_H": p[:, 0].round(3), "P_D": p[:, 1].round(3), "P_A": p[:, 2].round(3),
        "conf": conf.round(3), "pick": [["H", "D", "A"][i] for i in pick],
        "score": [f"{int(h)}-{int(a)}" for h, a in zip(gh[sel], ga[sel])],
        "actual": [["H", "D", "A"][i] for i in act], "hit": hit,
    })

    # ── 5. the HOCH tier: trivial count the reader can verify ──
    hoch = tbl[tbl["conf"] >= 0.65].reset_index(drop=True)
    n_hoch, n_hits = len(hoch), int(hoch["hit"].sum())
    rate = n_hits / n_hoch if n_hoch else float("nan")
    print("\n" + "─" * 80)
    print("  HOCH tier (blend top-prob ≥ 0.65) — recomputed by trivial counting:")
    print("─" * 80)
    print(f"    matches in tier (n) = {n_hoch}")
    print(f"    hits (pick == actual) = {n_hits}")
    print(f"    hit-rate = {n_hits}/{n_hoch} = {rate:.4f}  ({rate:.1%})")
    print(f"    → matches blend_confidence_calibration.json's 76.4% / n=386: "
          f"{'✓ YES' if (n_hoch == 386 and abs(rate - 0.764) < 0.002) else '✗ DRIFT — investigate'}")

    # ── 6. cross-check: are these REAL scores? join game_id → raw sofascore_match ──
    con = sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True)
    ids = ",".join(str(int(g)) for g in hoch["game_id"])
    raw = pd.read_sql_query(
        f"SELECT game_id, home_team, away_team, home_score, away_score "
        f"FROM sofascore_match WHERE game_id IN ({ids})", con)
    con.close()
    merged = hoch.merge(raw, on="game_id", how="left", suffixes=("", "_sofa"))
    merged["sofa_score"] = merged.apply(
        lambda r: f"{int(r['home_score'])}-{int(r['away_score'])}"
        if pd.notna(r["home_score"]) else "MISSING", axis=1)
    matched = (merged["score"] == merged["sofa_score"]).sum()
    missing = (merged["sofa_score"] == "MISSING").sum()
    print("\n" + "─" * 80)
    print("  CROSS-CHECK vs upstream sofascore_match (game_id join, a DIFFERENT table):")
    print("─" * 80)
    print(f"    corpus score == raw Sofa score:  {matched}/{n_hoch}"
          f"  ({'✓ all real' if matched == n_hoch else f'⚠ {n_hoch - matched} differ'})")
    if missing:
        print(f"    (game_ids absent from sofascore_match: {missing})")

    # ── 7. recognizable examples for an eyeball check ──
    print("\n  Sample HOCH matches (real fixtures · blend pick · real score · hit):")
    print(f"    {'date':<11}{'league':<14}{'match':<34}{'pick':>5}{'P':>7}{'score':>7}{'hit':>5}")
    show = hoch.sort_values("conf", ascending=False).head(8)
    tail = hoch.sort_values("conf", ascending=False).tail(4)
    for r in pd.concat([show, tail]).itertuples(index=False):
        m = f"{r.home} vs {r.away}"[:32]
        print(f"    {r.date:<11}{r.league:<14}{m:<34}{r.pick:>5}{r.conf:>7.2f}{r.score:>7}{'✓' if r.hit else '✗':>5}")

    out = D / "blend_confidence_audit_hoch_25-26.csv"
    hoch.to_csv(out, index=False)
    print(f"\n  ✓ full {n_hoch}-row audit trail → {out.relative_to(REPO)}")
    print("═" * 80)
    ok = (n_hoch == 386 and abs(rate - 0.764) < 0.002 and matched == n_hoch)
    print(f"  VERDICT: {'REAL — number reproduced from per-match data + scores verified vs upstream Sofa.' if ok else 'CHECK FAILED — see above.'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

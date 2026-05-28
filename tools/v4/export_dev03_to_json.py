"""
export_dev03_to_json.py — Export the dev-03 m3_xg + m6_benter artifacts to
a single browser-loadable JSON file at public/dev03-model.json.

What gets exported:
  - 5 home + 5 away bagged LightGBM models (full tree structures via
    Booster.dump_model())
  - The `pandas_categorical` mapping (league string → integer index)
  - feature_names + categorical_features
  - rho (Dixon-Coles handoff parameter, default -0.094)
  - m6_benter per-league weights (β_model + β_market) for log-pool blending
  - Golden-test fixtures (5 random feature vectors + expected ensemble outputs)
    so the TS runtime can verify byte-for-byte parity within 1e-4 tolerance.

Pipeline: pickle → dump_model() → assemble JSON → write to public/.

Output is ~5-10 MB. Trees use ALL the LightGBM JSON keys (decision_type,
threshold, default_left, missing_type, internal_value, ...). TS runtime only
uses split_feature, threshold, decision_type, left_child, right_child, leaf_value.
The other fields are kept for debugging / future audit.

Usage:
    tools/venv/bin/python3 tools/v4/export_dev03_to_json.py
"""
from __future__ import annotations

import json
import pickle
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
M3_HOME = ROOT / "tools/v4/artifacts/m3_xg-home-dev-03.pkl"
M3_AWAY = ROOT / "tools/v4/artifacts/m3_xg-away-dev-03.pkl"
M3_MANIFEST = ROOT / "tools/v4/artifacts/m3_xg-dev-03.json"
M6_BENTER = ROOT / "tools/v4/artifacts/m6_benter-dev-03.pkl"
OUTPUT = ROOT / "public/dev03-model.json"

# Dixon-Coles ρ for downstream score-grid handoff. v4 predictor uses -0.094.
RHO = -0.094

# Feature order MUST match the trained model. Locked into m3_xg-dev-03.json.
FEATURES_LOCKED = [
    "home_attack_ratio",
    "home_defense_ratio",
    "away_attack_ratio",
    "away_defense_ratio",
    "home_ess",
    "away_ess",
    "league_home_avg",
    "league_away_avg",
    "league_home_advantage",
    "lambda_h_naive",
    "lambda_a_naive",
    "attack_defense_ratio_h",
    "attack_defense_ratio_a",
    "elo_diff",
    "lineup_quality_diff",
    "form_streak_diff",
    "league",  # categorical
]


def export_ensemble(pickle_path: Path) -> Dict[str, Any]:
    """Load a BayesianEnsemble pickle, dump all 5 boosters to JSON-serializable dicts.

    Returns dict with `models` (list of dump_model() outputs) + ensemble metadata.
    """
    with open(pickle_path, "rb") as f:
        payload = pickle.load(f)

    n_models = payload["n_models"]
    seeds = payload["seeds"]
    feature_names = payload["feature_names"]
    categorical_columns = payload["categorical_columns"]
    base_params = payload["base_params"]

    if feature_names != FEATURES_LOCKED:
        raise ValueError(
            f"Feature order mismatch — pickle has {feature_names} "
            f"but expected {FEATURES_LOCKED}"
        )

    models_json = []
    pandas_categorical = None
    for i, model in enumerate(payload["models"]):
        booster = model.booster_
        dump = booster.dump_model()
        # All 5 boosters should share the same pandas_categorical (training set
        # was identical — only bootstrap-resampled). Stash from first.
        if pandas_categorical is None:
            pandas_categorical = dump.get("pandas_categorical")
        elif dump.get("pandas_categorical") != pandas_categorical:
            raise ValueError(
                f"pandas_categorical drift between models {i-1} and {i} — "
                "this should never happen for a single training run"
            )

        # Slim down: keep only what runtime needs. Strip diagnostic keys
        # (internal_value, internal_weight, split_gain) that bloat size by ~30%.
        slim_trees = [_slim_tree(t["tree_structure"]) for t in dump["tree_info"]]
        models_json.append({
            "seed": seeds[i],
            "n_trees": len(slim_trees),
            "trees": slim_trees,
        })

    return {
        "n_models": n_models,
        "seeds": seeds,
        "feature_names": feature_names,
        "categorical_columns": categorical_columns,
        "pandas_categorical": pandas_categorical,
        "base_params": base_params,
        "models": models_json,
    }


def _slim_tree(node: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively prune diagnostic-only fields from a tree node.

    Keeps: split_feature, threshold, decision_type, default_left, missing_type,
           left_child, right_child, leaf_value, leaf_index.
    Drops: split_gain, split_index, internal_value, internal_weight, internal_count,
           leaf_weight, leaf_count.
    """
    if "leaf_value" in node:
        return {"leaf_value": float(node["leaf_value"])}
    out = {
        "split_feature": int(node["split_feature"]),
        "threshold": node["threshold"],  # keep type — str for ||-sep cat, float for numeric
        "decision_type": node["decision_type"],
        "default_left": bool(node["default_left"]),
        # missing_type is mostly "None" — keep for completeness but it's tiny
        "missing_type": node.get("missing_type", "None"),
        "left_child": _slim_tree(node["left_child"]),
        "right_child": _slim_tree(node["right_child"]),
    }
    return out


def load_benter_weights() -> Dict[str, Any]:
    """Load m6_benter-dev-03.pkl and pack weights into JSON-ready dict."""
    with open(M6_BENTER, "rb") as f:
        bp = pickle.load(f)
    return {
        "default_betas": list(bp["default_betas"]),
        "global_weights": list(bp["global_weights"]) if bp["global_weights"] else None,
        "liga_weights": bp["liga_weights"],
        "min_liga_samples": bp["min_liga_samples"],
    }


def generate_golden_tests(
    home_payload: Dict[str, Any], away_payload: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Generate 5 deterministic feature vectors + Python predictions for them.

    The TS runtime tests verify it produces the same lambda_mean/lambda_var per fixture
    within 1e-4 tolerance.
    """
    # Load original models for prediction
    with open(M3_HOME, "rb") as f:
        home = pickle.load(f)
    with open(M3_AWAY, "rb") as f:
        away = pickle.load(f)

    pandas_cat = home["models"][0].booster_.dump_model()["pandas_categorical"][0]

    # Deterministic fixtures spanning the feature space
    fixtures_raw = [
        {  # 1. Strong home favorite (Bayern vs weak team in BL)
            "home_attack_ratio": 1.45, "home_defense_ratio": 0.75,
            "away_attack_ratio": 0.85, "away_defense_ratio": 1.30,
            "home_ess": 9.0, "away_ess": 8.5,
            "league_home_avg": 1.60, "league_away_avg": 1.25,
            "league_home_advantage": 0.32,
            "lambda_h_naive": 2.10, "lambda_a_naive": 0.75,
            "attack_defense_ratio_h": 1.885, "attack_defense_ratio_a": 0.638,
            "elo_diff": 250.0, "lineup_quality_diff": 0.9, "form_streak_diff": 0.6,
            "league": "bundesliga",
        },
        {  # 2. Balanced derby (Serie A)
            "home_attack_ratio": 1.20, "home_defense_ratio": 0.95,
            "away_attack_ratio": 1.18, "away_defense_ratio": 0.98,
            "home_ess": 8.5, "away_ess": 8.5,
            "league_home_avg": 1.45, "league_away_avg": 1.18,
            "league_home_advantage": 0.27,
            "lambda_h_naive": 1.50, "lambda_a_naive": 1.18,
            "attack_defense_ratio_h": 1.176, "attack_defense_ratio_a": 1.121,
            "elo_diff": 15.0, "lineup_quality_diff": 0.0, "form_streak_diff": 0.0,
            "league": "serie_a",
        },
        {  # 3. Strong away favorite (EPL)
            "home_attack_ratio": 0.85, "home_defense_ratio": 1.25,
            "away_attack_ratio": 1.50, "away_defense_ratio": 0.70,
            "home_ess": 7.0, "away_ess": 9.5,
            "league_home_avg": 1.50, "league_away_avg": 1.20,
            "league_home_advantage": 0.30,
            "lambda_h_naive": 0.85, "lambda_a_naive": 2.05,
            "attack_defense_ratio_h": 0.595, "attack_defense_ratio_a": 1.875,
            "elo_diff": -300.0, "lineup_quality_diff": -0.8, "form_streak_diff": -0.5,
            "league": "epl",
        },
        {  # 4. Low-scoring match (Greek SL)
            "home_attack_ratio": 0.95, "home_defense_ratio": 1.00,
            "away_attack_ratio": 1.00, "away_defense_ratio": 0.95,
            "home_ess": 6.0, "away_ess": 6.5,
            "league_home_avg": 1.30, "league_away_avg": 1.05,
            "league_home_advantage": 0.25,
            "lambda_h_naive": 1.10, "lambda_a_naive": 1.05,
            "attack_defense_ratio_h": 0.903, "attack_defense_ratio_a": 1.000,
            "elo_diff": 25.0, "lineup_quality_diff": 0.1, "form_streak_diff": 0.0,
            "league": "greek_sl",
        },
        {  # 5. League outside categorical training (lower-tier liga3)
            "home_attack_ratio": 1.10, "home_defense_ratio": 0.90,
            "away_attack_ratio": 1.05, "away_defense_ratio": 1.00,
            "home_ess": 7.5, "away_ess": 7.0,
            "league_home_avg": 1.50, "league_away_avg": 1.15,
            "league_home_advantage": 0.30,
            "lambda_h_naive": 1.65, "lambda_a_naive": 1.05,
            "attack_defense_ratio_h": 1.100, "attack_defense_ratio_a": 0.945,
            "elo_diff": 75.0, "lineup_quality_diff": 0.3, "form_streak_diff": 0.1,
            "league": "liga3",
        },
    ]

    out = []
    for fx in fixtures_raw:
        # Build the feature DataFrame with proper categorical dtype
        df = pd.DataFrame([fx])
        df["league"] = pd.Categorical(df["league"], categories=pandas_cat)
        X = df[FEATURES_LOCKED]

        # Predict on each of the 5 home / 5 away models, get ensemble mean+var
        home_preds = np.array([m.predict(X) for m in home["models"]]).flatten()
        away_preds = np.array([m.predict(X) for m in away["models"]]).flatten()

        # Build the feature vector in TS-runtime-shape: numeric values + categorical INDEX
        # (the TS code receives league as STRING and resolves it to index internally)
        out.append({
            "name": f"fixture_{len(out)+1}_{fx['league']}",
            "features": {k: fx[k] for k in FEATURES_LOCKED},
            "expected_home_lambda_mean": float(home_preds.mean()),
            "expected_home_lambda_var": float(home_preds.var(ddof=0)),
            "expected_away_lambda_mean": float(away_preds.mean()),
            "expected_away_lambda_var": float(away_preds.var(ddof=0)),
            # For debugging — per-model raw outputs
            "_home_per_model": home_preds.tolist(),
            "_away_per_model": away_preds.tolist(),
        })
    return out


def main() -> None:
    print(f"Loading dev-03 home ensemble from {M3_HOME.relative_to(ROOT)}")
    home = export_ensemble(M3_HOME)
    print(f"  → {sum(m['n_trees'] for m in home['models'])} trees across {home['n_models']} bagged models")

    print(f"Loading dev-03 away ensemble from {M3_AWAY.relative_to(ROOT)}")
    away = export_ensemble(M3_AWAY)
    print(f"  → {sum(m['n_trees'] for m in away['models'])} trees across {away['n_models']} bagged models")

    # Sanity: both ensembles share pandas_categorical (single training corpus)
    if home["pandas_categorical"] != away["pandas_categorical"]:
        raise ValueError("home + away pandas_categorical mismatch — different training data?")

    print(f"Loading m6_benter weights from {M6_BENTER.relative_to(ROOT)}")
    benter = load_benter_weights()
    n_computed = sum(1 for v in benter["liga_weights"].values() if v.get("fit_success"))
    print(f"  → {n_computed}/{len(benter['liga_weights'])} per-Liga fits succeeded ({n_computed} computed, rest fallback to global)")

    print("Generating golden test fixtures (5 deterministic predictions)…")
    golden = generate_golden_tests(home, away)
    for g in golden:
        print(f"  - {g['name']}: λ_h={g['expected_home_lambda_mean']:.4f}, λ_a={g['expected_away_lambda_mean']:.4f}")

    payload = {
        "version": "dev-03",
        "engine": "dev-03",
        "exported_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "rho": RHO,
        "feature_names": FEATURES_LOCKED,
        "categorical_features": ["league"],
        "pandas_categorical": home["pandas_categorical"],
        "home_ensemble": {
            "n_models": home["n_models"],
            "seeds": home["seeds"],
            "models": home["models"],
        },
        "away_ensemble": {
            "n_models": away["n_models"],
            "seeds": away["seeds"],
            "models": away["models"],
        },
        "benter": benter,
        "golden_tests": golden,
        "meta": {
            "source_files": {
                "m3_home": str(M3_HOME.relative_to(ROOT)),
                "m3_away": str(M3_AWAY.relative_to(ROOT)),
                "m6_benter": str(M6_BENTER.relative_to(ROOT)),
            },
            # Read training metadata dynamically from manifest so re-exports
            # after retrain reflect the actual fresh training state — not a
            # hard-coded snapshot from when this script was first authored.
            # Fixed 2026-05-22 after self-eval found stale May-14 timestamps
            # in dev03-model.json after the May-22 multi-season retrain.
            "trained_at": _manifest.get("trained_at", "unknown") if (_manifest := json.loads(M3_MANIFEST.read_text()) if M3_MANIFEST.exists() else {}) else "unknown",
            "training_corpus_n": _manifest.get("n_train_matches") if _manifest else None,
            "training_since": _manifest.get("since") if _manifest else None,
            "training_cutoff": _manifest.get("cutoff") if _manifest else None,
            "n_features": _manifest.get("n_features") if _manifest else None,
            "note": (
                "dev-03 LightGBM Tweedie ensemble (5 bagged). Metadata above "
                "auto-read from m3_xg-dev-03.json manifest at export time."
            ),
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))  # compact

    size_mb = OUTPUT.stat().st_size / (1024 * 1024)
    print(f"\nWrote {OUTPUT.relative_to(ROOT)} ({size_mb:.2f} MB)")
    print(f"  - {home['n_models']} home models + {away['n_models']} away models")
    print(f"  - {len(home['pandas_categorical'][0])} categorical leagues mapped")
    print(f"  - {len(golden)} golden test fixtures")
    print(f"  - {len(benter['liga_weights'])} per-Liga benter weights")


if __name__ == "__main__":
    main()

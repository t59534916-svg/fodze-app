#!/usr/bin/env python3
"""
FODZE — StatsBomb events → per-team-per-match aggregate CSV

Reads /tools/statsbomb/data/events/*.json (downloaded by download.py)
and aggregates each match into:
  - per team: total xG (StatsBomb's own model), shot counts, shot-location
    stats (avg x/y, fraction inside box, fraction under pressure),
    pass / possession-style features.
  - writes CSV: tools/statsbomb/aggregates.csv

The CSV is the training-ready view for:
  - A richer shots-to-xG regression that ADDS inside-box + pressure features
    (vs the current shots_total + shots_on_target only model)
  - As validation corpus for v3's features (via team-season matching)

StatsBomb event type IDs (from their docs):
  16 = Shot
  30 = Pass
  43 = Carry
  39 = Dribbled Past
  22 = Foul Committed
  42 = Ball Receipt
Shot outcomes: Goal, Saved, Blocked, Off T, Post, Wayward, Saved Off T, Saved To Post

Coordinate system:
  x: 0 (own goal) ... 120 (opponent goal)
  y: 0 (bottom sideline) ... 80 (top)
  Penalty box: x ∈ [102, 120], y ∈ [18, 62]
"""

import os
import sys
import json
import csv
import argparse
from collections import defaultdict

TOOL_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.join(TOOL_ROOT, "data")
EVENTS_DIR = os.path.join(DATA_ROOT, "events")
MATCHES_DIR = os.path.join(DATA_ROOT, "matches")
OUTPUT_CSV = os.path.join(TOOL_ROOT, "aggregates.csv")

# Penalty-box boundary in StatsBomb coordinates
BOX_X_MIN = 102.0
BOX_X_MAX = 120.0
BOX_Y_MIN = 18.0
BOX_Y_MAX = 62.0


def in_box(loc):
    """loc is [x, y]. True if coordinates are inside the opposing penalty box."""
    if not loc or len(loc) < 2:
        return False
    x, y = loc[0], loc[1]
    return BOX_X_MIN <= x <= BOX_X_MAX and BOX_Y_MIN <= y <= BOX_Y_MAX


def match_to_comp_season(matches_by_id):
    """Return dict match_id → {competition, season, match_date, home_team, away_team, home_score, away_score}."""
    out = {}
    for mid, m in matches_by_id.items():
        out[mid] = {
            "match_id": mid,
            "competition": m.get("competition", {}).get("competition_name"),
            "season": m.get("season", {}).get("season_name"),
            "match_date": m.get("match_date"),
            "home_team": m.get("home_team", {}).get("home_team_name"),
            "away_team": m.get("away_team", {}).get("away_team_name"),
            "home_score": m.get("home_score"),
            "away_score": m.get("away_score"),
        }
    return out


def load_matches_index():
    """Walk DATA_ROOT/matches/**/*.json and build {match_id: match_obj}."""
    idx = {}
    if not os.path.isdir(MATCHES_DIR):
        return idx
    for comp_dir in os.listdir(MATCHES_DIR):
        comp_path = os.path.join(MATCHES_DIR, comp_dir)
        if not os.path.isdir(comp_path):
            continue
        for fname in os.listdir(comp_path):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(comp_path, fname)) as f:
                    for m in json.load(f):
                        idx[m["match_id"]] = m
            except Exception as e:
                print(f"  ! error loading {fname}: {e}")
    return idx


def aggregate_events(events, home_team_id, away_team_id):
    """Extract per-team aggregates from a single match's events list."""
    per_team = {
        home_team_id: {
            "shots_total": 0, "shots_on_target": 0, "shots_in_box": 0,
            "shots_outside_box": 0, "shots_under_pressure": 0,
            "shots_head": 0, "shots_foot": 0,
            "goals": 0, "xg_total": 0.0,
            "passes_total": 0, "passes_completed": 0,
            "pressures": 0, "carries": 0, "fouls": 0, "offsides": 0,
            "shot_location_x_sum": 0.0, "shot_location_y_sum": 0.0,
        },
        away_team_id: None,  # initialized below with copy
    }
    per_team[away_team_id] = {k: (0.0 if isinstance(v, float) else 0) for k, v in per_team[home_team_id].items()}

    for ev in events:
        tid = ev.get("team", {}).get("id")
        if tid not in per_team:
            continue
        t = per_team[tid]
        etype = ev.get("type", {}).get("id")

        if etype == 16:  # Shot
            t["shots_total"] += 1
            shot = ev.get("shot", {})
            if shot.get("statsbomb_xg") is not None:
                t["xg_total"] += float(shot["statsbomb_xg"])
            loc = ev.get("location")
            if loc and len(loc) >= 2:
                t["shot_location_x_sum"] += loc[0]
                t["shot_location_y_sum"] += loc[1]
                if in_box(loc):
                    t["shots_in_box"] += 1
                else:
                    t["shots_outside_box"] += 1
            # on target if outcome is Goal or Saved
            out = shot.get("outcome", {}).get("name", "")
            if out in ("Goal", "Saved", "Saved to Post"):
                t["shots_on_target"] += 1
            if out == "Goal":
                t["goals"] += 1
            if ev.get("under_pressure"):
                t["shots_under_pressure"] += 1
            bp = shot.get("body_part", {}).get("name", "")
            if "Head" in bp:
                t["shots_head"] += 1
            elif "Foot" in bp or "Left" in bp or "Right" in bp:
                t["shots_foot"] += 1

        elif etype == 30:  # Pass
            t["passes_total"] += 1
            pas = ev.get("pass", {})
            # Completed = no outcome field (incomplete/etc. would have one)
            if "outcome" not in pas:
                t["passes_completed"] += 1

        elif etype == 43:  # Carry
            t["carries"] += 1
        elif etype == 17:  # Pressure
            t["pressures"] += 1
        elif etype == 22:  # Foul Committed
            t["fouls"] += 1
        elif etype == 8:   # Offside
            t["offsides"] += 1

    # Derived fields
    for tid in per_team:
        t = per_team[tid]
        if t["shots_total"] > 0:
            t["avg_shot_x"] = t["shot_location_x_sum"] / t["shots_total"]
            t["avg_shot_y"] = t["shot_location_y_sum"] / t["shots_total"]
            t["xg_per_shot"] = t["xg_total"] / t["shots_total"]
            t["pct_shots_in_box"] = t["shots_in_box"] / t["shots_total"]
            t["pct_shots_under_pressure"] = t["shots_under_pressure"] / t["shots_total"]
        else:
            t["avg_shot_x"] = None
            t["avg_shot_y"] = None
            t["xg_per_shot"] = None
            t["pct_shots_in_box"] = None
            t["pct_shots_under_pressure"] = None
        if t["passes_total"] > 0:
            t["pass_pct"] = 100.0 * t["passes_completed"] / t["passes_total"]
        else:
            t["pass_pct"] = None

    return per_team


def process_match(mid, matches_idx):
    """Parse one match's events.json → two CSV rows (home + away perspective)."""
    events_path = os.path.join(EVENTS_DIR, f"{mid}.json")
    if not os.path.exists(events_path):
        return []
    try:
        with open(events_path) as f:
            events = json.load(f)
    except Exception:
        return []

    m = matches_idx.get(mid)
    if not m:
        return []
    home = m.get("home_team", {})
    away = m.get("away_team", {})
    home_id = home.get("home_team_id")
    away_id = away.get("away_team_id")
    if not home_id or not away_id:
        return []

    agg = aggregate_events(events, home_id, away_id)
    base = {
        "match_id": mid,
        "competition": m.get("competition", {}).get("competition_name"),
        "season": m.get("season", {}).get("season_name"),
        "match_date": m.get("match_date"),
    }

    rows = []
    for team_id, venue, opp_id, team_name, opp_name in [
        (home_id, "home", away_id, home.get("home_team_name"), away.get("away_team_name")),
        (away_id, "away", home_id, away.get("away_team_name"), home.get("home_team_name")),
    ]:
        row = {
            **base,
            "team": team_name,
            "opponent": opp_name,
            "venue": venue,
        }
        t = agg[team_id]
        opp = agg[opp_id]
        row.update({
            "shots_for": t["shots_total"],
            "shots_against": opp["shots_total"],
            "shots_on_target_for": t["shots_on_target"],
            "shots_on_target_against": opp["shots_on_target"],
            "shots_in_box_for": t["shots_in_box"],
            "shots_in_box_against": opp["shots_in_box"],
            "shots_outside_box_for": t["shots_outside_box"],
            "shots_outside_box_against": opp["shots_outside_box"],
            "shots_under_pressure_for": t["shots_under_pressure"],
            "shots_head_for": t["shots_head"],
            "shots_foot_for": t["shots_foot"],
            "xg_for": round(t["xg_total"], 4),
            "xg_against": round(opp["xg_total"], 4),
            "goals_for": t["goals"],
            "goals_against": opp["goals"],
            "xg_per_shot_for": (round(t["xg_per_shot"], 4) if t["xg_per_shot"] is not None else None),
            "pct_shots_in_box_for": (round(t["pct_shots_in_box"], 4) if t["pct_shots_in_box"] is not None else None),
            "pct_shots_under_pressure_for": (round(t["pct_shots_under_pressure"], 4) if t["pct_shots_under_pressure"] is not None else None),
            "avg_shot_x_for": (round(t["avg_shot_x"], 2) if t["avg_shot_x"] is not None else None),
            "avg_shot_y_for": (round(t["avg_shot_y"], 2) if t["avg_shot_y"] is not None else None),
            "passes_total": t["passes_total"],
            "passes_completed": t["passes_completed"],
            "pass_pct": (round(t["pass_pct"], 2) if t["pass_pct"] is not None else None),
            "carries": t["carries"],
            "pressures": t["pressures"],
            "fouls": t["fouls"],
            "offsides": t["offsides"],
        })
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default=OUTPUT_CSV, help="Output CSV path")
    ap.add_argument("--limit", type=int, default=0, help="Max matches to process (0 = all)")
    ap.add_argument("--only-competition", help="Filter by competition name (e.g. '1. Bundesliga')")
    args = ap.parse_args()

    print("Loading matches index ...")
    matches_idx = load_matches_index()
    print(f"  {len(matches_idx)} matches in index")

    if not os.path.isdir(EVENTS_DIR):
        print(f"  no events directory ({EVENTS_DIR}) — run download.py first")
        sys.exit(1)

    event_files = [f for f in os.listdir(EVENTS_DIR) if f.endswith(".json")]
    print(f"  {len(event_files)} event files on disk")
    if len(event_files) == 0:
        print("  no events — nothing to parse")
        sys.exit(0)

    # Filter
    to_process = []
    for f in event_files:
        mid = int(f.split(".")[0])
        m = matches_idx.get(mid)
        if not m:
            continue
        if args.only_competition and m.get("competition", {}).get("competition_name") != args.only_competition:
            continue
        to_process.append(mid)

    if args.limit > 0:
        to_process = to_process[:args.limit]

    print(f"Processing {len(to_process)} matches ...")
    all_rows = []
    for i, mid in enumerate(to_process, 1):
        try:
            rows = process_match(mid, matches_idx)
            all_rows.extend(rows)
        except Exception as e:
            print(f"  ! match {mid}: {e}")
        if i % 100 == 0:
            print(f"  {i}/{len(to_process)} processed ({len(all_rows)} rows)")

    if not all_rows:
        print("  no rows produced")
        sys.exit(0)

    # Write CSV
    print(f"\nWriting {len(all_rows)} rows → {args.output}")
    fields = list(all_rows[0].keys())
    with open(args.output, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(all_rows)

    # Sanity report
    xg_total = sum(r["xg_for"] for r in all_rows)
    goals_total = sum(r["goals_for"] for r in all_rows)
    shots_total = sum(r["shots_for"] for r in all_rows)
    print(f"\n━━━ Summary ━━━")
    print(f"  Matches: {len(all_rows) // 2}")
    print(f"  Team-match rows: {len(all_rows)}")
    print(f"  Total xG: {xg_total:.1f}")
    print(f"  Total goals: {goals_total}")
    print(f"  Total shots: {shots_total}")
    print(f"  xG / shot: {xg_total/max(1,shots_total):.4f}")
    print(f"  goals / xG: {goals_total/max(1,xg_total):.4f}  (should be ~1.0 in calibrated xG)")


if __name__ == "__main__":
    main()

"""
FODZE — Shared Supabase REST loader for Python training scripts.

Replaces duplicated load_env + fetch_xg_history logic in retrain_v2.py and
retrain_v3.py. Native urllib (no new deps). Paginates via Range header,
sorts server-side (critical for Phase 3 leakage-safe rolling features),
sanity-asserts row count to catch the silent 1000-row PostgREST truncation.
"""
import os
import json
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from typing import Optional, List
import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT / ".env.local"
PAGE_SIZE = 1000


def load_env(env_path: Path = ENV_PATH) -> None:
    """Populate os.environ from .env.local without a python-dotenv dep."""
    if not env_path.exists():
        return
    with env_path.open() as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _resolve_supabase_creds():
    load_env()
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    )
    if not url or not key:
        raise RuntimeError(
            "Missing SUPABASE env — need NEXT_PUBLIC_SUPABASE_URL + "
            "SUPABASE_SERVICE_KEY in .env.local"
        )
    return url.rstrip("/"), key


def fetch_xg_history(
    table: str = "team_xg_history",
    sources: Optional[List[str]] = None,
    min_date: Optional[str] = None,
    max_date: Optional[str] = None,
    leagues: Optional[List[str]] = None,
    limit: Optional[int] = None,
    date_column: str = "match_date",
    verbose: bool = True,
) -> pd.DataFrame:
    """
    Fetches rows from Supabase via PostgREST with deterministic pagination.

    Args:
        table: PostgREST table name (default team_xg_history)
        sources: optional filter on `source` column (e.g. ['understat'])
        min_date / max_date: ISO date strings, server-side filter on date_column
        leagues: optional filter on `league` column
        limit: hard cap on total rows returned (for smoke tests)
        date_column: column name to sort + filter by (match_date or date)
        verbose: print download progress

    Returns:
        DataFrame sorted ascending by date_column. Empty DataFrame if no rows.
    """
    supa_url, supa_key = _resolve_supabase_creds()
    base_url = f"{supa_url}/rest/v1/{table}"

    query = [("select", "*"), ("order", f"{date_column}.asc")]
    if sources:
        query.append(("source", f"in.({','.join(sources)})"))
    if leagues:
        query.append(("league", f"in.({','.join(leagues)})"))
    if min_date:
        query.append((date_column, f"gte.{min_date}"))
    if max_date:
        query.append((date_column, f"lte.{max_date}"))
    url = f"{base_url}?{urllib.parse.urlencode(query)}"

    headers_base = {
        "apikey": supa_key,
        "Authorization": f"Bearer {supa_key}",
        "Content-Type": "application/json",
        "Range-Unit": "items",
    }

    all_rows: list = []
    offset = 0

    if verbose:
        print(f"📡 Supabase GET {table} (sources={sources}, leagues={leagues}, "
              f"date range={min_date}..{max_date})")

    while True:
        chunk = PAGE_SIZE
        if limit is not None:
            remaining = limit - len(all_rows)
            if remaining <= 0:
                break
            chunk = min(PAGE_SIZE, remaining)

        headers = {**headers_base, "Range": f"{offset}-{offset + chunk - 1}"}
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                if resp.status not in (200, 206):
                    raise RuntimeError(f"Unexpected status {resp.status}")
                batch = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise RuntimeError(f"HTTP {e.code}: {body}") from e

        if not batch:
            break
        all_rows.extend(batch)
        if verbose and (len(all_rows) % 10000 < PAGE_SIZE):
            print(f"   … {len(all_rows)} rows")

        if len(batch) < chunk:
            break
        offset += chunk

    if verbose:
        print(f"✅ Downloaded {len(all_rows)} rows from {table}")

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)

    # Sanity — detect silent truncation at exactly PAGE_SIZE.
    # If the user didn't set an explicit limit AND we got exactly PAGE_SIZE rows,
    # that's suspicious (probably hit a hidden server-side cap). A production
    # fetch on 80k+ rows should be nowhere near 1000.
    if limit is None and len(df) == PAGE_SIZE:
        print(f"⚠️  WARNING: fetched exactly {PAGE_SIZE} rows — possible "
              f"silent pagination cap. Check server logs.")

    # Chronological sort — Phase 3 leakage-safe feature engineering relies
    # on this. Server-side ORDER BY already did it, but re-assert after
    # DataFrame construction.
    if date_column in df.columns:
        df[date_column] = pd.to_datetime(df[date_column], utc=True, errors="coerce")
        df = df.sort_values(date_column).reset_index(drop=True)

    return df


if __name__ == "__main__":
    # Smoke test — load 2500 rows and show head + source breakdown
    df = fetch_xg_history(limit=2500)
    print(f"\n📊 {len(df)} rows, {df['league'].nunique() if 'league' in df.columns else 0} leagues")
    if "source" in df.columns:
        print(df["source"].value_counts())
    if "league" in df.columns:
        print(df.groupby("league").size().sort_values(ascending=False).head(10))

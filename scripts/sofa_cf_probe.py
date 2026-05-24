"""Sofa CF probe: test if curl_cffi chrome fingerprint bypasses CF block.
Run from GitHub Actions runner (different IP from Mac)."""
import curl_cffi.requests as cc

games = [10388349, 10388346, 10388343]
endpoints = ['statistics', 'lineups', 'incidents', 'managers']

print(f"Probing {len(games)} games × {len(endpoints)} endpoints = {len(games)*len(endpoints)} requests\n")

successes = 0
total = 0
for game_id in games:
    for endpoint in endpoints:
        url = f"https://api.sofascore.com/api/v1/event/{game_id}/{endpoint}"
        try:
            r = cc.get(url, impersonate="chrome124", timeout=15)
            total += 1
            ok = r.status_code == 200
            if ok:
                successes += 1
                data = r.json()
                keys = list(data.keys())[:3]
                print(f"✓ {game_id}/{endpoint:<12} HTTP {r.status_code}  size={len(r.content):>5}  keys={keys}")
            else:
                print(f"✗ {game_id}/{endpoint:<12} HTTP {r.status_code}  size={len(r.content)}")
        except Exception as e:
            total += 1
            print(f"✗ {game_id}/{endpoint:<12} {type(e).__name__}: {e}")

print(f"\nResult: {successes}/{total} success ({100*successes/total:.0f}%)")

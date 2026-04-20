# FODZE Betfair Stream Consumer

Long-lived Node.js process that subscribes to the Betfair Exchange Streaming API (Delayed App Key tier — free with any Betfair account after a one-week request wait) and pushes goal / red-card / kick-off events into Supabase's `live_match_events` table. A downstream edge function turns each event into a fresh `live_wp_snapshots` row via `src/lib/live-wp.ts`.

**Status: scaffolding only.** The files in this directory are documented skeletons. Running the full pipeline requires:
1. A Betfair account + approved Delayed App Key
2. A persistent host (Fly.io Machine / Railway / any VPS) — this is NOT serverless-friendly because the Stream API uses a sticky WebSocket connection
3. Supabase service-role credentials

The browser runtime already degrades gracefully — `live_wp_snapshots` is empty until this consumer is live, so the `/live` page stays inert.

## Files

- `Dockerfile` — Node 22 + ws + @supabase/supabase-js
- `index.mjs` — the stream consumer entry point
- `fly.toml` — deploy hint for Fly.io Machines (optional)

## Data contract

### Input: Betfair Exchange Stream v2
See `https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3lu3yomq5qye0ni/pages/1146976/Exchange+Stream+API`.

Per-market (`marketId`) updates contain:
- `rc[]` — runner changes (price + traded volumes) — not used here
- `mc.marketDefinition.markerTime` — current match minute (approximate)
- Special markets: "Match Odds", "Correct Score", "Over/Under 2.5 Goals" all share the same `eventId`; we subscribe to *Match Odds* only for WP signal.

Goal + red-card events are inferred from `marketDefinition.status == "SUSPENDED"` followed by a price-jump on resume — matches how tradable-odds books flag major events. The skeleton below shows where to wire that detection.

### Output: `live_match_events` (append)
```
match_key   TEXT    "{league}|{home}|{away}|{YYYY-MM-DD}"
minute      INT     0-95
event_type  TEXT    "goal" | "red_card" | "kickoff" | "halftime" | "fulltime"
team        TEXT    which side scored / was penalised
source      TEXT    "betfair-stream"
```

## Deployment

```bash
# Locally (development, burns API credits)
BETFAIR_APP_KEY=... BETFAIR_SESSION_TOKEN=... \
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
node services/betfair-stream/index.mjs

# Fly.io (production)
fly launch --dockerfile services/betfair-stream/Dockerfile
fly secrets set BETFAIR_APP_KEY=... BETFAIR_SESSION_TOKEN=...
fly machine run --image registry.fly.io/fodze-stream:latest
```

## Known gaps vs Robberechts 2021

- **No direct goal-notification endpoint** in the free stream tier — we infer goals from market-pause + price-discontinuity. That adds ~8 s latency to `live_match_events`, which the `/live` page compensates for with a "latency" banner.
- **No lineup-aware attacking intensity** — the pregame λ comes from the standard engine and doesn't update mid-match as subs land. Would require a separate lineup stream (not in delayed tier).
- **Single-match-at-a-time** — the skeleton subscribes to ONE market on connect. Multi-match fanout needs a subscription manager not built here.

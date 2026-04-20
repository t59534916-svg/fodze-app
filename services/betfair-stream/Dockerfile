# FODZE Betfair Stream Consumer — Node 22 + WebSocket + Supabase client
FROM node:22-alpine

WORKDIR /app

# Runtime-only deps. No build step; ESM entry.
RUN npm init -y --silent \
 && npm install --silent \
    ws@^8 \
    @supabase/supabase-js@^2

COPY index.mjs ./

# Delayed App Key lets the connection sit idle for minutes — no need for
# aggressive restarts. SIGTERM is handled cleanly in index.mjs.
CMD ["node", "index.mjs"]

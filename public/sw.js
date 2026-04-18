// FODZE Service Worker — Network-First with Offline Fallback + SWR for models
// Cache version bumped on every deploy to invalidate stale content
const CACHE_NAME = "fodze-v4";
const STATIC_ASSETS = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
];

// Stale-while-revalidate targets. These are ~400KB combined, rarely change
// between deploys, and AppContext re-fetches them every page load. Serving
// from cache immediately (while revalidating in the background) removes
// them from the critical path without risking stale predictions — the
// cache version bump on each deploy invalidates them atomically.
const SWR_PATHS = [
  "/calibration_curves.json",
  "/ensemble-model.json",
  "/lgbm-model-v2.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET") return;
  if (url.hostname.includes("supabase")) return;
  if (url.pathname.startsWith("/api/")) return;

  // Stale-while-revalidate for model artifacts: respond with cached
  // version immediately if present, kick off a network refresh in the
  // background. First-ever visit falls through to network-first below.
  if (SWR_PATHS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkUpdate = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => null);
        return cached || networkUpdate;
      })
    );
    return;
  }

  // Default: network-first with cache fallback for offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === "navigate") {
            return caches.match("/");
          }
        });
      })
  );
});

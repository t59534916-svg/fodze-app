// FODZE Service Worker — Network-First with Offline Fallback
// Cache version bumped on every deploy to invalidate stale content
const CACHE_NAME = "fodze-v3";
const STATIC_ASSETS = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
];

// Install: cache static shell, force activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete ALL old caches to force fresh content
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: NETWORK-FIRST for everything (fixes stale deploy issue)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and external API calls
  if (event.request.method !== "GET") return;
  if (url.hostname.includes("supabase")) return;
  if (url.pathname.startsWith("/api/")) return;

  // Network-first: try network, fall back to cache for offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Offline fallback for navigation
          if (event.request.mode === "navigate") {
            return caches.match("/");
          }
        });
      })
  );
});

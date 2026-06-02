const CACHE = "capital-queue-v4";
const STATIC = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/logo.svg",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Никогда не кешируем API: там приватные финансовые данные и auth-state.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static: cache-first, fallback to index.html for SPA/PWA offline shell.
  event.respondWith(
    caches
      .match(event.request)
      .then(
        (cached) =>
          cached ||
          fetch(event.request).catch(() => caches.match("/index.html")),
      ),
  );
});

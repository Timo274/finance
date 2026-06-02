const CACHE = 'capital-queue-v3';
const STATIC = ['/', '/index.html', '/styles.css', '/app.js', '/logo.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const API_CACHE = 'capital-queue-api-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== API_CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API: network-first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    if (event.request.method !== 'GET') return;
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  // Static: cache-first, fallback to index.html
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request).catch(() => caches.match('/index.html')))
  );
});
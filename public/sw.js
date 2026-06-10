// Версия подставляется сервером из hash содержимого статики —
// меняется код, меняется версия везде одновременно.
const VERSION = "__STATIC_VERSION__";
const CACHE = `capital-queue-${VERSION}`;
const STATIC = [
  `/styles.css?v=${VERSION}`,
  `/fonts/fonts.css?v=${VERSION}`,
  `/app.js?v=${VERSION}`,
  `/lib/api.js?v=${VERSION}`,
  `/lib/dom.js?v=${VERSION}`,
  `/lib/format.js?v=${VERSION}`,
  `/lib/charts.js?v=${VERSION}`,
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
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Версионированная статика иммутабельна — cache-first (аудит 11.3).
  if (url.searchParams.has("v") || STATIC.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Остальное — network-first без записи в кеш: случайные URL
  // (например /admin.php -> index.html) не должны замусоривать кеш.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// ---------- Push-уведомления ----------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Capital Queue", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate?.(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});

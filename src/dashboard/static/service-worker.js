const CACHE_VERSION = 'codebot-v5';
const SHELL_ASSETS = [
  '/style.css',
  '/app.js',
  '/logo.svg',
  '/favicon.svg',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Network-first for API calls, WebSocket upgrades, and navigation (HTML has injected token)
  if (url.pathname.startsWith('/api') || e.request.headers.get('upgrade') === 'websocket' || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // Stale-while-revalidate for static assets — serve cached immediately, update in background
  e.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(e.request).then((cached) => {
        const networkFetch = fetch(e.request).then((resp) => {
          cache.put(e.request, resp.clone());
          return resp;
        });
        return cached || networkFetch;
      })
    )
  );
});

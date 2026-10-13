// Service worker body. VERSION and PRECACHE are prepended by the server (see routes/offline-assets.js).
/* global VERSION, PRECACHE */
const CACHE = 'salon-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('salon-') && k !== CACHE && k !== 'salon-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Gives up on the network quickly so a sleeping salon computer doesn't leave the iPad waiting.
function fromNetwork(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then((r) => (clearTimeout(timer), resolve(r)), (e) => (clearTimeout(timer), reject(e)));
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  // Google Fonts: keep a copy so the app looks the same offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open('salon-fonts').then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => (c.put(req, res.clone()), res)))));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Pages: the newest app when the computer answers, the saved copy when it doesn't.
    event.respondWith(fromNetwork(req, 3000).catch(() => caches.match('/', { cacheName: CACHE })));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

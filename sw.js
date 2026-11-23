// Catch Log service worker: works offline, keeps map tiles you've looked at.
const VERSION = 'v1.3.2';
const SHELL = 'shell-' + VERSION;
const TILES = 'tiles-v1';
const MAX_TILES = 3000;
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/fonts.css',
  ...['zilla-slab-latin-700', 'caveat-latin-600', 'barlow-latin-400', 'barlow-latin-600', 'barlow-latin-700', 'barlow-latin-800'].map(f => `vendor/fonts/${f}-normal.woff2`),
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Satellite tiles: serve saved copy if we have one, refresh when there's signal.
  if (url.hostname.endsWith('arcgisonline.com')) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req.url);
      const net = fetch(req.url, { mode: 'cors' }).then(async r => {
        if (r.ok) { await c.put(req.url, r.clone()); trimTiles(); }
        return r;
      }).catch(() => fetch(req).catch(() => hit || Response.error()));
      return hit || net;
    })());
    return;
  }

  // Weather is always live.
  if (url.hostname.endsWith('open-meteo.com')) return;

  // App shell: cache first, then network.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        if (req.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }
    })());
  }
});

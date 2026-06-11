/* KUKL Survey — Service Worker
   Strategy:
     - App shell (HTML/CSS/JS/logo/manifest)  → cache-first, network refresh in background
     - CDN libs (Leaflet, SheetJS, html5-qrcode, piexifjs, jsPDF) → cache-first
     - OSM tiles (*.tile.openstreetmap.org)   → stale-while-revalidate (capped LRU)
     - Everything else → network-first, fall back to cache
*/
const VERSION = 'v68-2026-06-11-gis-report-autoid';
const SHELL_CACHE = `kukl-shell-${VERSION}`;
const LIB_CACHE   = `kukl-libs-${VERSION}`;
const TILE_CACHE  = `kukl-tiles-${VERSION}`;
const TILE_LIMIT  = 600; // ~30 MB rough budget

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?v=55',
  './js/app.js?v=20',
  './js/nrw-builder.js?v=4',
  './js/extra-sections.js?v=12',
  './js/media-widgets.js?v=1',
  './js/gps-sampler.js?v=3',
  './js/geo-utils.js?v=1',
  './js/dma-overlay.js?v=8',
  './js/gnss-connector.js?v=1',
  './js/gis-editor.js?v=27',
  './js/theme-boot.js?v=1',
  './js/nav-wiring.js?v=3',
  './assets/vendor/leaflet-geoman.min.js',
  './assets/vendor/leaflet-geoman.css',
  './assets/vendor/shp.min.js',
  './assets/vendor/togeojson.js',
  './assets/vendor/xlsx.full.min.js',
  './data/dma/index.json',
  './assets/kukl-logo.png',
];

const LIB_URLS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_ASSETS).catch(() => {});
    const libs = await caches.open(LIB_CACHE);
    await Promise.all(LIB_URLS.map(u =>
      fetch(u, { mode: 'cors' }).then(r => r.ok && libs.put(u, r)).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, LIB_CACHE, TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map(n => keep.has(n) ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isTile(url) {
  return /\.tile\.openstreetmap\.org/.test(url.hostname) ||
         /server\.arcgisonline\.com/.test(url.hostname);
}
function isLib(url) {
  return ['unpkg.com', 'cdn.jsdelivr.net'].includes(url.hostname);
}
function isShellNav(req) {
  return req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Don't intercept POST/PUT/etc, dev-tools, or non-http(s)
  if (!url.protocol.startsWith('http')) return;

  // OSM tiles → stale-while-revalidate
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          cache.put(req, res.clone());
          trimCache(TILE_CACHE, TILE_LIMIT);
        }
        return res;
      }).catch(() => null);
      return cached || network || new Response('', { status: 504 });
    })());
    return;
  }

  // CDN libs → cache-first
  if (isLib(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Same-origin navigations → network-first, fallback to cached index
  if (url.origin === self.location.origin && isShellNav(req)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
        return res;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(req)) || (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Same-origin static (CSS/JS/IMG) → cache-first w/ background update
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || network || new Response('', { status: 504 });
    })());
  }
});

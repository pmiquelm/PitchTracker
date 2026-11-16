// Service worker: makes the app open with no signal.
// Cache-first with a versioned cache. BUMP `VERSION` WHENEVER ANY APP FILE CHANGES,
// otherwise installed copies keep running the old files.
const VERSION = 'v1';
const CACHE = `pitchtracker-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/game.js',
  './js/db.js',
  './js/sync.js',
  './js/backup.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pitchtracker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});

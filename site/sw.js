// Service worker for the installed app.
//
// The shell is cached so the app opens with no network at all — and that is
// not a degraded mode here: with no host reachable the app already falls back
// to a private per-browser copy of the network, so an offline launch is a
// working app rather than an error page.
//
// The act log is never cached. A stale feed served from disk would be a second
// source of truth, and this project has paid for those twice already.
const VERSION = 'peer-shell-v4';
const SHELL = [
  './',
  './index.html',
  './app.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Individually, so one missing file cannot fail the whole install.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Anything live goes straight to the network, always: the act log, the host
  // pointer, media, call signalling. Never served from cache.
  if (url.pathname.includes('/api/') || url.pathname.endsWith('host.json') || url.origin !== self.location.origin) {
    return;
  }

  // Shell: try the network first so a redeploy is picked up, fall back to the
  // cache when there is none. Cache-first would strand people on an old build.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./app.html'))),
  );
});

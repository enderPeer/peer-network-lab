// Service worker for the installed app.
//
// The shell is cached so the app opens with no network at all — and that is
// not a degraded mode here: with no host reachable the app already falls back
// to a private per-browser copy of the network, so an offline launch is a
// working app rather than an error page.
//
// The act log is never cached. A stale feed served from disk would be a second
// source of truth, and this project has paid for those twice already.
// v5: the tab row went from eight entries to six, so a cached shell shows a
// navigation that no longer matches what the app dispatches. Bumping evicts it.
// v7: the shell learned to save media, so it must be the version that knows
// how to play it back.
// v8: the shell cache is scoped by where this copy is DEPLOYED. On an IPFS
// path gateway (gateway/ipfs/<cid>/) every site on that gateway shares one
// origin, so an unscoped name meant any other copy of this app activating
// there would sweep this one's shell as "stale". The scope path makes the
// name this copy's own, and the sweep below never reaches past it.
// v9: the install page and the install file joined the shell, so the site
// can still explain how to install itself when it is opened with no network —
// and the offline fallback below became navigations-only, so a missing
// subresource fails honestly instead of impersonating the app page.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const VERSION = 'peer-shell-v9:' + SCOPE_PATH;
const SHELL = [
  './',
  './index.html',
  './app.html',
  './install.html',
  './endernet.mobileconfig',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

// Media somebody asked to keep. A SECOND cache, deliberately, and deliberately
// not named after the shell version: the shell is evicted on every redeploy and
// saved music must not be. What is stored here is content-addressed and served
// `immutable`, so a hit can never be stale — the bytes behind a hash are the
// only bytes that hash to it.
const MEDIA_CACHE = 'peer-media-v1';
// The stable key. NOT the URL it was fetched from: this host's address is a
// tunnel that changes on every restart, so a blob cached under the live origin
// would become unreachable the moment the host moved, with the bytes intact and
// the hash unchanged. The hash is the identity; the origin is an accident.
const MEDIA_PATH = /\/(?:api|archive)\/media\/([a-f0-9]{64})$/;
function mediaKey(hash) {
  return self.location.origin + '/_peer_media/' + hash;
}

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
      // Only stale SHELLS, and only THIS deployment's. Deleting every
      // non-current cache would wipe saved posts; deleting another scope's
      // shell would wipe a sibling deployment on a shared gateway origin.
      // The legacy unscoped v7 name is still collected wherever it appears.
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION
          && (k === 'peer-shell-v7' || (k.startsWith('peer-shell-') && k.endsWith(':' + SCOPE_PATH))))
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/**
 * Answer a Range request out of a whole cached response.
 *
 * The host answers Range with a full 200 today for anything it serves live, so
 * this is not about matching it — it is about what browsers require. Chromium
 * will seek inside a 200 it has; Safari refuses to play media at all from a
 * source that will not answer 206. Saved music that will not play on an iPhone
 * is not saved music.
 */
async function withRange(req, res) {
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200) return res;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return res;
  const buf = await res.clone().arrayBuffer();
  const total = buf.byteLength;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) { start = 0; end = total - 1; }
  else if (start === null) { start = Math.max(0, total - end); end = total - 1; }
  else if (end === null) { end = total - 1; }
  end = Math.min(end, total - 1);
  if (!(start >= 0) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes',
    },
  });
}

/**
 * Media: what is on this device first, the network second.
 *
 * Cache-first is right here in a way it is emphatically not right for the
 * shell. A shell served from cache strands somebody on an old build; a blob
 * served from cache is the same bytes the network would send, because the URL
 * is a hash of them.
 *
 * Nothing is written to the cache here. Saving is something a person asks for
 * on a specific post, and the page does it with an explicit CORS fetch —
 * populating from element requests would fill the store with opaque responses
 * nobody chose and the browser counts against the quota at a padded size.
 */
async function serveMedia(req, hash) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(mediaKey(hash));
    if (hit) return await withRange(req, hit);
  } catch { /* no cache API, or a quota error: fall through to the network */ }
  return fetch(req);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Media, before anything else — the bypass below matches '/api/' and would
  // otherwise pre-empt this. Both shapes are handled: the live host's
  // /api/media/<hash>, and the published archive's archive/media/<hash>. They
  // are the same bytes under the same name, so they share one store.
  const hit = MEDIA_PATH.exec(url.pathname);
  if (hit) { e.respondWith(serveMedia(req, hit[1])); return; }

  // Anything live goes straight to the network, always: the act log, the host
  // pointer, call signalling. Never served from cache.
  if (url.pathname.includes('/api/') || url.pathname.endsWith('host.json') || url.origin !== self.location.origin) {
    return;
  }

  // Shell: try the network first so a redeploy is picked up, fall back to the
  // cache when there is none. Cache-first would strand people on an old build.
  // The app-page fallback is for NAVIGATIONS only: handing app.html to a
  // subresource fetch would give the requester a 200 full of the wrong bytes —
  // the install page once printed the whole app as "the install file's text"
  // that way. A subresource with no cache entry fails honestly instead.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(
        (hit2) => hit2 || (req.mode === 'navigate' ? caches.match('./app.html') : Response.error()),
      )),
  );
});

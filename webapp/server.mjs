// Minimal shared host for the Peer social sandbox (roadmap Phase-3 lite).
// Owns the append-only act log; every client replays it deterministically.
//   GET  /            → the assembled sandbox page
//   GET  /api/acts    → { acts } (optionally ?since=N for the tail)
//   POST /api/act     → append one validated act, returns the full log
// Persistence: server-data/acts.jsonl (one JSON act per line).
// Run: node server.mjs [port]   (default 5210)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, 'public/peer-social-preview.html');
const DATA_DIR = resolve(here, 'server-data');
const LOG = resolve(DATA_DIR, 'acts.jsonl');
const PORT = Number(process.argv[2] ?? 5210);

const ACT_KINDS = new Set(['register', 'burn', 'post', 'opinion', 'review', 'tag', 'closeEpoch',
  'deposit', 'burnL0', 'redeem', 'transferL0', 'closeCycle']);
const MAX_ACT_BYTES = 4096;
const MAX_ACTS = 50000;

mkdirSync(DATA_DIR, { recursive: true });

// Startup backup rotation: snapshot the log, keep the newest 5 snapshots.
if (existsSync(LOG) && statSync(LOG).size > 0) {
  try {
    copyFileSync(LOG, join(DATA_DIR, `acts-${Date.now()}.bak`));
    const baks = readdirSync(DATA_DIR).filter((f) => /^acts-\d+\.bak$/.test(f)).sort();
    while (baks.length > 5) unlinkSync(join(DATA_DIR, baks.shift()));
  } catch { /* backup is best-effort */ }
}

const acts = [{ t: 'seedWorld' }];
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { acts.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
}

// ── Protection layers ────────────────────────────────────────────────
// Behind the Cloudflare tunnel every socket is localhost; the real client
// IP arrives in CF-Connecting-IP. Buckets are (windowStart, count) pairs.
function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown').toString();
}
function makeLimiter(limit, windowMs) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
    if (buckets.size > 10000) buckets.clear(); // memory backstop
    b.count += 1;
    return b.count <= limit;
  };
}
const actLimiter = makeLimiter(20, 60_000);        // 20 acts/min/IP
const registerLimiter = makeLimiter(8, 3_600_000); // 8 registrations/hour/IP
const pinFailLimiter = makeLimiter(12, 600_000);   // 12 failed PIN tries/10min/IP
const readLimiter = makeLimiter(600, 60_000);      // 600 reads/min/IP

// Only whitelisted fields survive into the public log — nothing can smuggle
// extra payload through unexpected keys.
const ACT_FIELDS = {
  register: ['t', 'id', 'handle', 'seed', 'epoch', 'pinHash'],
  burn: ['t', 'id', 'amt'],
  post: ['t', 'author', 'text', 'a'],
  opinion: ['t', 'author', 'target', 'p', 'r'],
  review: ['t', 'author', 'target', 'e', 'f', 'text'],
  tag: ['t', 'author', 'target', 'name', 'r', 'c'],
  closeEpoch: ['t', 'epoch'],
  deposit: ['t', 'id', 'amt'],
  burnL0: ['t', 'id', 'x'],
  redeem: ['t', 'id', 'x'],
  transferL0: ['t', 'from', 'to', 'x', 'cls'],
  closeCycle: ['t'],
};
// post gains optional reference + media fields
ACT_FIELDS.post = ['t', 'author', 'text', 'a', 'ref', 'media'];

// ── Media store: content-addressed payload carriage (never scored) ──
const MEDIA_DIR = resolve(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);
const MEDIA_MAX_IMAGE = 2 * 1024 * 1024;
const MEDIA_MAX_VIDEO = 12 * 1024 * 1024;
const MEDIA_STORE_CAP = 300 * 1024 * 1024;
const mediaLimiter = makeLimiter(10, 60_000); // 10 uploads/min/IP
function mediaDirSize() {
  let s = 0;
  try { for (const f of readdirSync(MEDIA_DIR)) s += statSync(join(MEDIA_DIR, f)).size; } catch {}
  return s;
}
function sanitize(act) {
  const keep = ACT_FIELDS[act.t] || [];
  const clean = {};
  for (const k of keep) if (act[k] !== undefined) clean[k] = act[k];
  return clean;
}
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']'); // C0 controls except tab+newline
function hasControlChars(act) {
  for (const v of Object.values(act)) {
    if (typeof v === 'string' && CONTROL_CHARS.test(v)) return true;
  }
  return false;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
};

function persist(act) {
  appendFileSync(LOG, JSON.stringify(act) + '\n', 'utf8');
}

function json(res, code, body) {
  const buf = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(buf);
}

// PIN protection: a register act may carry pinHash = H(id + ':' + pin).
// Later acts by that identity must carry the raw pin in `auth`; the server
// verifies the hash and STRIPS auth before the act enters the public log.
const pinIndex = new Map();
for (const a of acts) if (a.t === 'register' && a.pinHash) pinIndex.set(a.id, a.pinHash);

function hashPin(id, pin, likeStored) {
  if (typeof likeStored === 'string' && likeStored.startsWith('fnv')) {
    // parity with the client's non-secure-context fallback hash
    let h = 0x811c9dc5;
    const s = id + ':' + pin;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'fnv' + h.toString(16);
  }
  return createHash('sha256').update(id + ':' + pin, 'utf8').digest('hex');
}

function authError(act) {
  const actor = act.t === 'register' ? null
    : (act.author ?? act.from ?? (['burn', 'deposit', 'burnL0', 'redeem'].includes(act.t) ? act.id : null));
  if (!actor) return null; // closeEpoch/closeCycle are communal; register is checked for uniqueness only
  const stored = pinIndex.get(actor);
  if (!stored) return null;
  const pin = typeof act.auth === 'string' ? act.auth : '';
  if (!pin || hashPin(actor, pin, stored) !== stored) return 'this handle is PIN-secured — wrong or missing PIN';
  return null;
}

function validate(act) {
  if (!act || typeof act !== 'object' || !ACT_KINDS.has(act.t)) return 'unknown act kind';
  if (JSON.stringify(act).length > MAX_ACT_BYTES) return 'act too large';
  if (acts.length >= MAX_ACTS) return 'log full — test instance capacity reached';
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const inR = (v) => num(v) && v >= -1 && v <= 1;
  const str = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
  switch (act.t) {
    case 'register':
      if (!str(act.id, 24) || !/^u_[a-z0-9]+$/.test(act.id) || !str(act.handle, 16)) return 'bad registration';
      if (!num(act.seed) || act.seed !== 1) return 'bad seed';
      if (acts.some((a) => a.t === 'register' && a.id === act.id)) return 'handle already registered';
      if (act.pinHash !== undefined && !(/^[a-f0-9]{64}$/.test(act.pinHash) || /^fnv[0-9a-f]{1,8}$/.test(act.pinHash))) return 'bad pin hash';
      break;
    case 'burn':
      if (!str(act.id, 24) || act.amt !== 1) return 'bad burn';
      break;
    case 'post':
      if (!str(act.author, 24) || !str(act.text, 1000) || !inR(act.a)) return 'bad post';
      if (act.ref !== undefined && !str(act.ref, 40)) return 'bad reference';
      if (act.media !== undefined) {
        if (!Array.isArray(act.media) || act.media.length > 2) return 'bad media';
        for (const m of act.media) {
          if (!m || typeof m !== 'object' || !/^[a-f0-9]{64}$/.test(m.h ?? '') || !MEDIA_TYPES.has(m.m)) return 'bad media entry';
          if (!existsSync(join(MEDIA_DIR, m.h))) return 'unknown media hash — upload first';
        }
      }
      break;
    case 'opinion':
      if (!str(act.author, 24) || !str(act.target, 40) || !inR(act.p) || !inR(act.r)) return 'bad opinion';
      break;
    case 'review':
      if (!str(act.author, 24) || !str(act.target, 40) || !inR(act.e) || !inR(act.f) || !str(act.text, 1000)) return 'bad review';
      break;
    case 'tag':
      if (!str(act.author, 24) || !str(act.target, 40) || !str(act.name, 20) || !inR(act.r) || !inR(act.c)) return 'bad tag';
      break;
    case 'closeEpoch':
      if (!num(act.epoch)) return 'bad epoch';
      break;
    case 'deposit':
      if (!str(act.id, 24) || !num(act.amt) || act.amt <= 0 || act.amt > 1000) return 'bad deposit';
      break;
    case 'burnL0':
    case 'redeem':
      if (!str(act.id, 24) || !num(act.x) || act.x <= 0 || act.x > 10000) return 'bad amount';
      break;
    case 'transferL0':
      if (!str(act.from, 24) || !str(act.to, 24) || !num(act.x) || act.x <= 0 || act.x > 10000) return 'bad transfer';
      if (act.cls !== undefined && act.cls !== 'live' && act.cls !== 'tlock') return 'bad class';
      break;
    case 'closeCycle':
      break;
  }
  return null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  if (req.method === 'GET' && url.pathname === '/api/acts') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down — too many requests' }); return; }
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const body = JSON.stringify({ acts: acts.slice(since), total: acts.length });
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && body.length > 1024;
    if (wantsGzip) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', ...SECURITY_HEADERS });
      res.end(gzipSync(Buffer.from(body)));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/media') {
    if (!mediaLimiter(ip)) { json(res, 429, { error: 'upload limit — try again in a minute' }); return; }
    const mime = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!MEDIA_TYPES.has(mime)) { json(res, 415, { error: 'unsupported media type' }); return; }
    const cap = mime.startsWith('video/') ? MEDIA_MAX_VIDEO : MEDIA_MAX_IMAGE;
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0 || size > cap) { json(res, 413, { error: 'media too large' }); return; }
      if (mediaDirSize() + size > MEDIA_STORE_CAP) { json(res, 507, { error: 'media store full — test instance capacity reached' }); return; }
      const buf = Buffer.concat(chunks);
      const hash = createHash('sha256').update(buf).digest('hex');
      const file = join(MEDIA_DIR, hash);
      if (!existsSync(file)) {
        writeFileSync(file, buf);
        writeFileSync(file + '.meta', JSON.stringify({ mime, size }));
      }
      json(res, 200, { h: hash, m: mime, size });
    });
    return;
  }
  if (req.method === 'GET' && /^\/api\/media\/[a-f0-9]{64}$/.test(url.pathname)) {
    const hash = url.pathname.slice('/api/media/'.length);
    const file = join(MEDIA_DIR, hash);
    try {
      const meta = JSON.parse(readFileSync(file + '.meta', 'utf8'));
      const buf = readFileSync(file);
      // content-addressed ⇒ immutable: clients and proxies may cache forever
      res.writeHead(200, {
        'Content-Type': meta.mime,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: '"' + hash.slice(0, 16) + '"',
        ...SECURITY_HEADERS,
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down — the network accepts at most 20 acts per minute from one place' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_ACT_BYTES * 2) req.destroy(); });
    req.on('end', () => {
      let act;
      try { act = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
      // Client's known log length: reply with just the tail it is missing.
      const since = Math.max(0, Number(act.since ?? 0) || 0);
      delete act.since;
      const auth = typeof act.auth === 'string' ? act.auth : '';
      act = sanitize(act); // whitelist fields; auth/since never persist
      if (hasControlChars(act)) { json(res, 400, { error: 'unprintable characters are not allowed' }); return; }
      if (act.t === 'register' && !registerLimiter(ip)) {
        json(res, 429, { error: 'registration limit reached — try again in an hour' }); return;
      }
      const err = validate(act);
      if (err) { json(res, err === 'handle already registered' ? 409 : 400, { error: err }); return; }
      const aerr = authError({ ...act, auth });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { error: 'too many PIN attempts — locked for a few minutes' }); return; }
        json(res, 401, { error: aerr }); return;
      }
      acts.push(act);
      persist(act);
      if (act.t === 'register' && act.pinHash) pinIndex.set(act.id, act.pinHash);
      json(res, 200, { acts: acts.slice(Math.min(since, acts.length)), since: Math.min(since, acts.length), total: acts.length });
    });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const page = readFileSync(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#131110"></head><body>' + page.toString() + '</body></html>');
    } catch {
      res.writeHead(500); res.end('build missing — run: npm run build:social');
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`peer host on http://localhost:${PORT} — ${acts.length} act(s) loaded`);
});

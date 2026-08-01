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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, 'public/peer-social-preview.html');
const DATA_DIR = resolve(here, 'server-data');
const LOG = resolve(DATA_DIR, 'acts.jsonl');
const PORT = Number(process.argv[2] ?? 5210);

const ACT_KINDS = new Set(['register', 'burn', 'post', 'opinion', 'review', 'tag', 'closeEpoch',
  'deposit', 'burnL0', 'redeem', 'transferL0', 'closeCycle', 'setPin', 'dm',
  'editPost', 'deletePost', 'deleteAccount', 'call']);
const MAX_ACT_BYTES = 4096;
const MAX_ACTS = 50000;
const EDIT_WINDOW_MS = 5 * 60 * 1000; // posts are editable for 5 minutes

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
  setPin: ['t', 'id', 'pinHash'],
  dm: ['t', 'from', 'to', 'text'],
};
// post gains optional reference + media fields
ACT_FIELDS.post = ['t', 'author', 'text', 'a', 'ref', 'media'];
ACT_FIELDS.editPost = ['t', 'author', 'target', 'text'];
ACT_FIELDS.call = ['t', 'from', 'to', 'outcome', 'dur'];
ACT_FIELDS.deletePost = ['t', 'author', 'target'];
ACT_FIELDS.deleteAccount = ['t', 'id'];

// ── Deletion in an append-only log ──────────────────────────────────────────
// Content ids are minted by a replay counter, and later acts reference them
// ('c167'), so acts can never be physically removed — the ids of everything
// after them would shift. Deletion is therefore: a tombstone act in the log,
// PLUS in-place redaction of the target's content bytes in the stored file
// (same line count, so since-based sync stays valid). Replay keeps full
// counter/θ parity for redacted acts; only payloads, edges and visibility go.
//
// Mentions are the one place replay parses TEXT to mint counter increments
// and θ-debits — so redacting text would corrupt every later content id.
// Fix: the server stamps `rmen` (resolved mention ids) on every accepted
// post, and computes it retroactively before blanking an old one. Replay
// prefers rmen over parsing. The register act's handle is likewise kept even
// after account deletion: mention parsing of later acts depends on it (the
// UI displays '[deleted]' instead).
const deletedIds = new Set(acts.filter((a) => a.t === 'deleteAccount').map((a) => a.id));

// Mirror of the client's parseMentions — must resolve identically.
function parseMentionsSrv(text, handles) {
  const slugToId = {};
  for (const id in handles) slugToId[(handles[id] || '').toLowerCase().replace(/[^a-z0-9]/g, '')] = id;
  const out = []; const seen = {};
  const re = /@([a-zA-Z0-9_]{1,16})/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < 3) {
    const id2 = slugToId[m[1].toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (id2 && !seen[id2]) { seen[id2] = 1; out.push(id2); }
  }
  return out;
}
// Handle map as it stood before act index i — mention resolution is
// position-dependent (you cannot mention someone not yet registered).
// The client's replay materialises four seed-world actors before any register
// act (its seedWorld branch). They ARE mentionable, so the server's map must
// contain them too — otherwise retroactive rmen stamping silently drops a
// mention of @Alice/@Bob/@Carol/@Dave, and with it one counter increment and
// one θ-debit, which shifts every later content id and re-points stored
// references at the wrong posts.
const SEED_HANDLES = { alice: 'Alice', bob: 'Bob', carol: 'Carol', dave: 'Dave' };
function handlesAt(idx) {
  const h = { ...SEED_HANDLES };
  for (let i = 0; i < idx && i < acts.length; i++) {
    if (acts[i].t === 'register') h[acts[i].id] = acts[i].handle;
  }
  return h;
}

function redactPostAct(orig, idx) {
  if (orig.rmen === undefined) orig.rmen = parseMentionsSrv(orig.text || '', handlesAt(idx));
  orig.text = '';
  delete orig.media;
  orig.redacted = true;
}

// Atomic rewrite of the whole log. acts[0] is the in-memory seedWorld and
// must never reach the file — it would double on the next boot.
function rewriteLog() {
  const tmp = LOG + '.tmp';
  writeFileSync(tmp, acts.slice(1).map((a) => JSON.stringify(a)).join('\n') + '\n');
  renameSync(tmp, LOG);
}

// Drop media blobs no surviving act references.
// Upload happens when a file is picked; the post act arrives only when the
// composer hits Share. A blob with no act yet may therefore be a perfectly
// live draft — someone else's — so young files are never collected.
const MEDIA_GC_GRACE_MS = 60 * 60 * 1000;
function gcMedia() {
  const referenced = new Set();
  for (const a of acts) {
    if (Array.isArray(a.media)) for (const m of a.media) if (m && m.h) referenced.add(m.h);
  }
  const now = Date.now();
  try {
    for (const f of readdirSync(MEDIA_DIR)) {
      const hash = f.replace(/\.meta$/, '');
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      if (referenced.has(hash)) continue;
      const file = join(MEDIA_DIR, f);
      try {
        if (now - statSync(file).mtimeMs < MEDIA_GC_GRACE_MS) continue; // pending draft
        unlinkSync(file);
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

// ── Media store: content-addressed payload carriage (never scored) ──
const MEDIA_DIR = resolve(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/webm',
  'application/pdf', 'text/plain', 'application/json', 'application/zip', 'application/octet-stream',
]);
/**
 * Browsers disagree on type names for the same bytes — Windows Chrome sends
 * application/x-zip-compressed for a .zip, Safari audio/x-m4a, some tools
 * audio/mp3 or image/jpg. Fold the aliases onto the canonical type instead of
 * rejecting real files.
 */
const MIME_ALIASES = {
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'multipart/x-zip': 'application/zip',
  'application/x-compressed': 'application/zip',
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/vorbis': 'audio/ogg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'video/x-m4v': 'video/mp4',
  'video/mov': 'video/quicktime',
  'video/x-quicktime': 'video/quicktime',
  'text/csv': 'text/plain',
  'text/markdown': 'text/plain',
};
const canonicalMime = (m) => MIME_ALIASES[m] ?? m;

const MEDIA_MAX_IMAGE = 6 * 1024 * 1024;  // HEIC originals upload as-is
const MEDIA_MAX_VIDEO = 25 * 1024 * 1024;
const MEDIA_MAX_OTHER = 12 * 1024 * 1024; // audio + generic attachments
const MEDIA_STORE_CAP = 300 * 1024 * 1024;
const mediaLimiter = makeLimiter(10, 60_000); // 10 uploads/min/IP

// ── Call signaling: ephemeral mailboxes, deliberately NOT acts ──────────────
// A call is negotiated (SDP/ICE) through the host but carried peer-to-peer;
// nothing about it enters the public record. Mailboxes live in memory only,
// expire fast, and are drained by the recipient. Auth mirrors /api/act: a
// PIN-secured handle must present its PIN both to send and to collect.
const SIGNAL_KINDS = new Set(['ring', 'accept', 'ice', 'hangup', 'decline']);
const SIGNAL_TTL = 90_000;      // undelivered signals evaporate
const SIGNAL_RING_TTL = 45_000; // a stale ring must not pop up minutes later
const SIGNAL_BOX_CAP = 64;      // per-recipient queue bound
const SIGNAL_PAYLOAD_MAX = 16_384; // SDP with candidates stays well under this
const signalBoxes = new Map();  // handle id -> [{sid, from, kind, payload, ts}]
const signalLimiter = makeLimiter(240, 60_000); // ICE bursts + 1s in-call polling
let signalSeq = 1; // sids let clients dedup re-delivered rings
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
  // microphone=(self): voice calls decode/capture on the page itself; camera
  // stays closed until video calls are a designed feature, not a side effect.
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  // img-src/media-src must allow blob: — host-served media is fetched and
  // rendered from object URLs; data: covers the local sandbox's inline images.
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "img-src 'self' data: blob:; media-src 'self' data: blob:; base-uri 'none'; form-action 'none'",
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
// Replay BOTH sources in log order (newest wins): a PIN set after
// registration must survive a restart, or protection silently evaporates.
const pinIndex = new Map();
for (const a of acts) {
  if ((a.t === 'register' || a.t === 'setPin') && a.pinHash) pinIndex.set(a.id, a.pinHash);
}

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

// Acts that destroy or rewrite existing content are irreversible: a deleted
// account can never be re-registered, redacted bytes are gone, and an edit
// overwrites the stored post. An unsecured handle is claimable by anyone who
// knows its id, so for these kinds "no PIN on file" must mean REFUSED, not
// waved through — otherwise a stranger can erase someone else's account with a
// single request. Ordinary acts keep the old permissive behaviour.
const PIN_REQUIRED = new Set(['editPost', 'deletePost', 'deleteAccount']);

function authError(act) {
  const actor = act.t === 'register' ? null
    : (act.author ?? act.from ?? (['burn', 'deposit', 'burnL0', 'redeem', 'setPin', 'deleteAccount'].includes(act.t) ? act.id : null));
  if (!actor) return null; // closeEpoch/closeCycle are communal; register is checked for uniqueness only
  const stored = pinIndex.get(actor);
  if (!stored) {
    if (PIN_REQUIRED.has(act.t)) {
      return 'this handle has no PIN — set one before deleting or editing, otherwise anyone could do it in your name';
    }
    return null;
  }
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
          if (m.n !== undefined && (typeof m.n !== 'string' || m.n.length > 80)) return 'bad media name';
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
    case 'setPin':
      if (!str(act.id, 24)) return 'bad id';
      if (!(/^[a-f0-9]{64}$/.test(act.pinHash ?? '') || /^fnv[0-9a-f]{1,8}$/.test(act.pinHash ?? ''))) return 'bad pin hash';
      break;
    case 'dm':
      if (!str(act.from, 24) || !str(act.to, 24) || !str(act.text, 500)) return 'bad message';
      break;
    case 'editPost': {
      if (!str(act.author, 24) || !Number.isInteger(act.target) || !str(act.text, 1000)) return 'bad edit';
      const orig = acts[act.target];
      if (!orig || orig.t !== 'post') return 'edit target is not a post';
      if (orig.author !== act.author) return 'only the author can edit a post';
      if (orig.redacted) return 'that post was deleted';
      if (!orig.ts || Date.now() - orig.ts > EDIT_WINDOW_MS) return 'edit window closed — posts are editable for 5 minutes';
      break;
    }
    case 'deletePost': {
      if (!str(act.author, 24) || !Number.isInteger(act.target)) return 'bad delete';
      const orig = acts[act.target];
      if (!orig || orig.t !== 'post') return 'delete target is not a post';
      if (orig.author !== act.author) return 'only the author can delete a post';
      if (orig.redacted) return 'already deleted';
      break;
    }
    case 'deleteAccount':
      if (!str(act.id, 24)) return 'bad id';
      if (!acts.some((a) => a.t === 'register' && a.id === act.id)) return 'unknown handle';
      if (deletedIds.has(act.id)) return 'already deleted';
      break;
    case 'call':
      // The caller's client records the outcome after the call ends; the voice
      // itself was peer-to-peer and never touched the host.
      if (!str(act.from, 24) || !str(act.to, 24) || act.from === act.to) return 'bad call';
      if (!['completed', 'missed', 'declined', 'failed'].includes(act.outcome)) return 'bad outcome';
      if (act.dur !== undefined && (!Number.isInteger(act.dur) || act.dur < 0 || act.dur > 86400)) return 'bad duration';
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
    const mime = canonicalMime((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase());
    if (!MEDIA_TYPES.has(mime)) { json(res, 415, { error: 'unsupported media type: ' + mime }); return; }
    const cap = mime.startsWith('video/') ? MEDIA_MAX_VIDEO
      : mime.startsWith('image/') ? MEDIA_MAX_IMAGE : MEDIA_MAX_OTHER;
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
        // stored bytes are untrusted payload: never let them script or navigate
        'Content-Security-Policy': 'sandbox',
        'Content-Disposition': meta.mime.startsWith('image/') || meta.mime.startsWith('video/') || meta.mime.startsWith('audio/') ? 'inline' : 'attachment',
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
      // A deleted account is gone as an actor — nothing more can be done as it.
      const actorId = act.author ?? act.from ?? act.id;
      if (actorId && deletedIds.has(actorId)) { json(res, 410, { error: 'this account was deleted' }); return; }
      if (act.to && deletedIds.has(act.to)) { json(res, 410, { error: 'that account was deleted' }); return; }
      const aerr = authError({ ...act, auth });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { error: 'too many PIN attempts — locked for a few minutes' }); return; }
        json(res, 401, { error: aerr }); return;
      }
      act.ts = Date.now(); // server clock is the arbiter of the edit window
      if (act.t === 'post') act.rmen = parseMentionsSrv(act.text, handlesAt(acts.length));
      acts.push(act);
      persist(act);
      if ((act.t === 'register' || act.t === 'setPin') && act.pinHash) pinIndex.set(act.id, act.pinHash);
      if (act.t === 'setPin') pinIndex.set(act.id, act.pinHash); // newest wins; enforced from now on
      // Deletion/edit reach back into the stored log: content bytes leave the
      // file, structure (line count, ids, θ-parity fields) stays.
      if (act.t === 'editPost') {
        const orig = acts[act.target];
        orig.text = act.text; orig.edited = true;
        rewriteLog();
      } else if (act.t === 'deletePost') {
        redactPostAct(acts[act.target], act.target);
        rewriteLog(); gcMedia();
      } else if (act.t === 'deleteAccount') {
        deletedIds.add(act.id);
        for (let ai = 1; ai < acts.length; ai++) {
          const a = acts[ai];
          if (a.t === 'post' && a.author === act.id && !a.redacted) redactPostAct(a, ai);
          else if ((a.t === 'review' && a.author === act.id) || (a.t === 'dm' && (a.from === act.id || a.to === act.id))) {
            if (a.text) { a.text = ''; a.redacted = true; }
          }
        }
        rewriteLog(); gcMedia();
      }
      json(res, 200, { acts: acts.slice(Math.min(since, acts.length)), since: Math.min(since, acts.length), total: acts.length });
    });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/signal' || url.pathname === '/api/signal/poll')) {
    if (!signalLimiter(ip)) { json(res, 429, { error: 'signaling limit — slow down' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > SIGNAL_PAYLOAD_MAX * 2) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
      const idOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 24;
      const now = Date.now();
      const sweep = (box) => box.filter((s) => now - s.ts < (s.kind === 'ring' ? SIGNAL_RING_TTL : SIGNAL_TTL));

      if (url.pathname === '/api/signal/poll') {
        // Collecting your mailbox requires the same proof as acting as you —
        // otherwise anyone could silently swallow your incoming calls.
        if (!idOk(msg.who)) { json(res, 400, { error: 'bad handle' }); return; }
        const aerr = authError({ t: 'dm', from: msg.who, auth: typeof msg.auth === 'string' ? msg.auth : '' });
        if (aerr) {
          if (!pinFailLimiter(ip)) { json(res, 429, { error: 'too many PIN attempts — locked for a few minutes' }); return; }
          json(res, 401, { error: aerr }); return;
        }
        const box = sweep(signalBoxes.get(msg.who) ?? []);
        // Rings persist across polls: a second open tab of the same handle
        // must not silently swallow an incoming call. Clients dedup by sid;
        // rings leave the box on accept/decline/hangup or by TTL.
        const rings = box.filter((s) => s.kind === 'ring');
        if (rings.length) signalBoxes.set(msg.who, rings); else signalBoxes.delete(msg.who);
        json(res, 200, { signals: box });
        return;
      }

      if (!idOk(msg.from) || !idOk(msg.to) || msg.from === msg.to) { json(res, 400, { error: 'bad endpoints' }); return; }
      if (!SIGNAL_KINDS.has(msg.kind)) { json(res, 400, { error: 'unknown signal kind' }); return; }
      const payload = msg.payload === undefined ? null : msg.payload;
      if (payload !== null && JSON.stringify(payload).length > SIGNAL_PAYLOAD_MAX) { json(res, 413, { error: 'signal too large' }); return; }
      const aerr = authError({ t: 'dm', from: msg.from, auth: typeof msg.auth === 'string' ? msg.auth : '' });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { error: 'too many PIN attempts — locked for a few minutes' }); return; }
        json(res, 401, { error: aerr }); return;
      }
      let box = sweep(signalBoxes.get(msg.to) ?? []);
      // Ending a call clears its pending rings so no tab keeps ringing:
      // caller hangup removes their rings from the callee's box; a callee's
      // accept/decline removes the caller's rings from the callee's own box.
      if (msg.kind === 'hangup') {
        box = box.filter((s) => !(s.kind === 'ring' && s.from === msg.from));
      } else if (msg.kind === 'accept' || msg.kind === 'decline') {
        const own = sweep(signalBoxes.get(msg.from) ?? []).filter((s) => !(s.kind === 'ring' && s.from === msg.to));
        if (own.length) signalBoxes.set(msg.from, own); else signalBoxes.delete(msg.from);
      }
      if (box.length >= SIGNAL_BOX_CAP) box.shift();
      box.push({ sid: signalSeq++, from: msg.from, kind: msg.kind, payload, ts: now });
      signalBoxes.set(msg.to, box);
      json(res, 200, { ok: true });
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

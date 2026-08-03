// Minimal shared host for the Peer social sandbox (roadmap Phase-3 lite).
// Owns the append-only act log; every client replays it deterministically.
//   GET  /            → the assembled sandbox page
//   GET  /api/acts    → { acts } (optionally ?since=N for the tail)
//   POST /api/act     → append one validated act, returns the full log
//   GET  /api/v1      → self-describing API for bots and AI agents (see below)
// Persistence: server-data/acts.jsonl (one JSON act per line).
// Run: node server.mjs [port]   (default 5210)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { timingSafeEqual, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createAdStore, validBtcAddress } from './ads.mjs';
import { handleClash, handleSkeleton, takenHandles } from './identity.mjs';
import { readRegistration, verifyAssertion, newChallenge } from './webauthn.mjs';
import { refusal, statusFor, catalogueDocument, CATALOGUE } from './errors.mjs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, 'public/peer-social-preview.html');
// Overridable so tests can run against a throwaway log. Without this the only
// way to exercise validation, auth and the economy gates is to append to the
// live network — which is how a real tester's handle once got claimed by a
// probe that was only meant to check whether the hole was still open.
const DATA_DIR = process.env.PEER_DATA_DIR
  ? resolve(process.env.PEER_DATA_DIR)
  : resolve(here, 'server-data');
const LOG = resolve(DATA_DIR, 'acts.jsonl');
const PORT = Number(process.argv[2] ?? 5210);

const ACT_KINDS = new Set(['register', 'burn', 'post', 'opinion', 'review', 'tag', 'closeEpoch',
  'deposit', 'burnL0', 'redeem', 'transferL0', 'closeCycle', 'setPin', 'dm',
  'editPost', 'deletePost', 'deleteAccount', 'call', 'stream',
  'btcClaim', 'assetCreate', 'tokenSend', 'poolCreate', 'poolAdd', 'poolRemove', 'poolSwap',
  'setKey']);
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
// ── Operations telemetry: for the operator, never for the network ─────────
//
// Everything here lives in memory and dies with the process. None of it is
// written to the act log, and none of it is reachable without the operator
// token — because the act log is PUBLIC at /api/acts, and an IP address that
// found its way in there could never be taken back out. That is the whole
// design constraint: this file may observe, and must not record.
//
// Same reasoning as view counts: this network's premise is that influence is
// transported commitment. Nothing measured here enters the graph, a score, or
// a feed. It exists so the operator can see abuse, load and breakage.
const OPS_STARTED = Date.now();
const IP_MAX = 800;            // bounded: an attacker must not be able to grow this
const IP_IDLE_MS = 6 * 3600_000;
const ops = {
  requests: 0,
  byStatus: new Map(),
  actsAccepted: 0,
  actsRefused: 0,
  refusals: new Map(),         // reason -> count
  rateLimited: 0,
  authFailures: 0,
  adminAuthFailures: 0,
  bytesOut: 0,
  peakActsPerMin: 0,
  actMinute: { at: 0, n: 0 },
};
const ipSeen = new Map();      // ip -> {first, last, reqs, acts, refused, limited, agent, handles:Set}
const banned = new Map();      // ip -> {until, reason}

function ipRow(ip) {
  let r = ipSeen.get(ip);
  if (!r) {
    // Evict the least recently seen rather than clearing wholesale: a flood
    // of new addresses must not erase the record of the one causing it.
    if (ipSeen.size >= IP_MAX) {
      let oldest = null, oldestAt = Infinity;
      for (const [k, v] of ipSeen) if (v.last < oldestAt) { oldestAt = v.last; oldest = k; }
      if (oldest) ipSeen.delete(oldest);
    }
    r = { first: Date.now(), last: 0, reqs: 0, acts: 0, refused: 0, limited: 0, agent: '', handles: new Set() };
    ipSeen.set(ip, r);
  }
  return r;
}

function opsRequest(ip, req) {
  ops.requests++;
  const r = ipRow(ip);
  r.last = Date.now();
  r.reqs++;
  const ua = (req.headers['user-agent'] || '').slice(0, 120);
  if (ua) r.agent = ua;
}

function opsAct(ip, act, err) {
  const r = ipRow(ip);
  if (err) {
    ops.actsRefused++;
    r.refused++;
    // Bucket by the shape of the message, not the message: refusals name
    // actual numbers ("1400 characters, limit 1000"), so the raw strings
    // would be unbounded cardinality and useless as a breakdown.
    const key = String(err).replace(/\d+/g, 'N').slice(0, 80);
    ops.refusals.set(key, (ops.refusals.get(key) ?? 0) + 1);
    return;
  }
  ops.actsAccepted++;
  r.acts++;
  const who = act && (act.author ?? act.from ?? act.id);
  if (who && r.handles.size < 24) r.handles.add(who);
  const minute = Math.floor(Date.now() / 60_000);
  if (ops.actMinute.at !== minute) ops.actMinute = { at: minute, n: 0 };
  ops.actMinute.n++;
  if (ops.actMinute.n > ops.peakActsPerMin) ops.peakActsPerMin = ops.actMinute.n;
}

/** Sweep idle rows so a long-running host does not hold addresses forever. */
function opsSweep() {
  const cut = Date.now() - IP_IDLE_MS;
  for (const [k, v] of ipSeen) if (v.last < cut) ipSeen.delete(k);
  for (const [k, v] of banned) if (v.until && v.until < Date.now()) banned.delete(k);
}
setInterval(opsSweep, 10 * 60_000).unref?.();

function banCheck(ip) {
  const b = banned.get(ip);
  if (!b) return null;
  if (b.until && b.until < Date.now()) { banned.delete(ip); return null; }
  return b;
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
// Operator-tunable because a private deployment, or a test run driving the host
// as fast as it can answer, is not the abuse this is aimed at. The public
// default is unchanged, and the refusal message below reads the same number.
const ACT_RATE = Number(process.env.PEER_ACT_RATE) > 0 ? Number(process.env.PEER_ACT_RATE) : 20;
const actLimiter = makeLimiter(ACT_RATE, 60_000);  // 20 acts/min/IP by default
// Operator-tunable like the act and advert rates, and for the same reason: a
// suite that exercises registration refusals would otherwise spend its budget
// proving the limiter works. The public default is unchanged.
const REGISTER_RATE = Number(process.env.PEER_REGISTER_RATE) > 0 ? Number(process.env.PEER_REGISTER_RATE) : 8;
const registerLimiter = makeLimiter(REGISTER_RATE, 3_600_000); // 8 registrations/hour/IP by default
const pinFailLimiter = makeLimiter(12, 600_000);   // 12 failed PIN tries/10min/IP
const readLimiter = makeLimiter(600, 60_000);      // 600 reads/min/IP

// Only whitelisted fields survive into the public log — nothing can smuggle
// extra payload through unexpected keys.
const ACT_FIELDS = {
  register: ['t', 'id', 'handle', 'seed', 'epoch', 'pinHash'],
  burn: ['t', 'id', 'amt'],
  post: ['t', 'author', 'text', 'a'],
  opinion: ['t', 'author', 'target', 'p', 'r'],
  // `target` is the A-leg subject (what is being reviewed). `upd` names an
  // existing Comment as the T-leg terminus, which makes the act a revision of
  // that comment instead of minting a new one — Review/T is one of the four
  // termini v0.24.2 allows to be existing rather than fresh.
  review: ['t', 'author', 'target', 'e', 'f', 'text', 'upd'],
  tag: ['t', 'author', 'target', 'name', 'r', 'c'],
  closeEpoch: ['t', 'epoch'],
  deposit: ['t', 'id', 'amt'],
  burnL0: ['t', 'id', 'x'],
  redeem: ['t', 'id', 'x'],
  transferL0: ['t', 'from', 'to', 'x', 'cls'],
  closeCycle: ['t'],
  setPin: ['t', 'id', 'pinHash'],
  setKey: ['t', 'id', 'credId', 'cose', 'label'],
  dm: ['t', 'from', 'to', 'text'],
};
// post gains optional reference + media fields
// `target` names an existing post: the act then updates that node instead of
// minting a new one (v0.24.2 makes minting a role a record plays, decided by
// whether its terminal target is its own mint).
ACT_FIELDS.post = ['t', 'author', 'text', 'a', 'ref', 'media', 'target'];
ACT_FIELDS.editPost = ['t', 'author', 'target', 'text'];
ACT_FIELDS.call = ['t', 'from', 'to', 'outcome', 'dur'];
// Going live is a public gesture, so it is an act and mints a Content node the
// way a post does — which is what lets people react and comment on a stream
// with the ordinary machinery instead of a parallel one. The video itself is
// peer-to-peer and never touches the log.
ACT_FIELDS.stream = ['t', 'author', 'text', 'a'];
ACT_FIELDS.deletePost = ['t', 'author', 'target'];
ACT_FIELDS.btcClaim = ['t', 'author'];
ACT_FIELDS.assetCreate = ['t', 'author', 'sym', 'name', 'supply'];
ACT_FIELDS.tokenSend = ['t', 'author', 'sym', 'to', 'amt'];
ACT_FIELDS.poolCreate = ['t', 'author', 'symA', 'symB', 'amtA', 'amtB'];
ACT_FIELDS.poolAdd = ['t', 'author', 'pool', 'amtA', 'amtB'];
ACT_FIELDS.poolRemove = ['t', 'author', 'pool', 'shares'];
ACT_FIELDS.poolSwap = ['t', 'author', 'pool', 'sell', 'amt', 'minOut'];
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

// The act index that minted a post's node. A revision is itself a `post` act
// carrying the index it revises, so follow the chain back; a revision of a
// revision is legal and lands on the same node.
function mintIndexOf(idx) {
  let seen = 0;
  while (acts[idx] && acts[idx].t === 'post' && Number.isInteger(acts[idx].target) && seen++ < 64) {
    idx = acts[idx].target;
  }
  return idx;
}

// Every act that wrote text into one node. Redacting only the mint left the
// revisions intact, so the newest text — the version people had actually been
// reading — stayed downloadable from /api/acts and readable through the bot
// API's event stream, while the app told the author it had been removed.
function redactNode(mintIdx) {
  for (let ai = 1; ai < acts.length; ai++) {
    const a = acts[ai];
    if (ai === mintIdx || (a.t === 'post' && a.target === mintIdx && !a.redacted)) redactPostAct(a, ai);
  }
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

// ── Mirror mode: this host follows a primary instead of accepting writes ──
//
// One network, one writer. A second host that also accepted acts would fork
// the log the first time both were reachable — so a mirror READS everything
// and WRITES nothing, and says so plainly. What it is for:
//   - continuous off-machine backup (log + media, synced every few seconds)
//   - read fallback: when the primary dies, the record stays browsable
//   - migration: a new server starts as a mirror, fills up, gets promoted
//
// The role comes from a FILE (role.json next to the log), not only from the
// environment: the watchdog restarts a crashed host, and a restart that
// silently forgot it was a mirror would start accepting acts and fork the
// network. A file survives every restart path. PEER_MIRROR_OF overrides for
// tests. Promotion is deliberate: delete role.json (or empty its mirrorOf)
// and restart — see webapp/HOSTING.md for the full runbook.
const roleFile = resolve(DATA_DIR, 'role.json');
let roleMirror = '';
try { roleMirror = String(JSON.parse(readFileSync(roleFile, 'utf8')).mirrorOf ?? ''); } catch { /* no role file = primary */ }
const MIRROR_OF = (process.env.PEER_MIRROR_OF ?? roleMirror).trim().replace(/\/+$/, '');
const MIRROR_INTERVAL = Math.max(300, Number(process.env.PEER_MIRROR_INTERVAL) || 5000);
const mirrorState = { ok: null, busy: false, lastFull: 0, snapDay: -1 };

function mirrorRefuse(res) {
  if (!MIRROR_OF) return false;
  json(res, 503, {
    code: 'MIRROR_READONLY',
    error: 'this host is a read-only mirror of ' + MIRROR_OF + ' — the app writes to the primary on its own while it answers. If the primary is gone for good, the operator promotes this mirror (delete role.json, restart); until then nothing here accepts acts, because two writers would fork the network.',
    mirrorOf: MIRROR_OF,
  });
  return true;
}

async function mirrorGet(path) {
  const r = await fetch(MIRROR_OF + path, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error('primary answered HTTP ' + r.status + ' for ' + path);
  return r;
}

/** Pull media blobs the synced acts reference and this disk lacks. */
async function mirrorMedia(refs) {
  for (const m of refs) {
    if (!m || typeof m.h !== 'string' || !/^[a-f0-9]{64}$/.test(m.h)) continue;
    const file = join(MEDIA_DIR, m.h);
    if (existsSync(file)) continue;
    try {
      const r = await mirrorGet('/api/media/' + m.h);
      const buf = Buffer.from(await r.arrayBuffer());
      // Content-addressed means verifiable: a blob that does not hash to its
      // own name is not written, whatever the primary claims.
      if (createHash('sha256').update(buf).digest('hex') !== m.h) continue;
      writeFileSync(file, buf);
      writeFileSync(file + '.meta', JSON.stringify({ mime: r.headers.get('content-type') || 'application/octet-stream', size: buf.length }));
    } catch { /* the next sync retries */ }
  }
}

/** Replace the whole local log with the primary's — the redaction path. */
function mirrorAdopt(remoteActs) {
  acts.length = 0;
  for (const a of remoteActs) acts.push(a);
  rewriteLog();
  gcMedia();
  stateCache = { len: -1, st: null, R: stateCache.R };
}

async function mirrorSync() {
  if (mirrorState.busy) return;
  mirrorState.busy = true;
  try {
    const d = await (await mirrorGet('/api/acts?since=' + acts.length)).json();
    let mediaRefs = [];
    const wantFull =
      d.total < acts.length ||                        // primary shrank: a rewrite happened
      d.acts.some((a) => a.t === 'deletePost' || a.t === 'deleteAccount') || // redactions touch old lines
      Date.now() - mirrorState.lastFull > 30 * 60_000; // belt and braces
    if (wantFull) {
      const full = await (await mirrorGet('/api/acts')).json();
      mirrorAdopt(full.acts);
      mirrorState.lastFull = Date.now();
      mediaRefs = full.acts.flatMap((a) => a.media || []);
    } else if (d.acts.length) {
      for (const a of d.acts) { acts.push(a); persist(a); }
      stateCache = { len: -1, st: null, R: stateCache.R };
      mediaRefs = d.acts.flatMap((a) => a.media || []);
    }
    await mirrorMedia(mediaRefs);
    // Rolling snapshots: seven files, one per weekday, overwritten in place.
    // The mirror IS the backup; these survive a bad sync of the main copy.
    const day = new Date().getDay();
    if (day !== mirrorState.snapDay) {
      try { copyFileSync(LOG, LOG + '.daily-' + day); mirrorState.snapDay = day; } catch { /* best effort */ }
    }
    if (mirrorState.ok !== true) console.log('[mirror] in sync with ' + MIRROR_OF + ' — ' + acts.length + ' acts');
    mirrorState.ok = true;
  } catch (e) {
    // A dead primary is not an error for a fallback — it is the case this
    // host exists for. Log the transition once, keep serving, keep retrying.
    if (mirrorState.ok !== false) console.log('[mirror] primary unreachable (' + (e && e.message) + ') — serving the last synced record, retrying quietly');
    mirrorState.ok = false;
  } finally {
    mirrorState.busy = false;
  }
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
// ── ICE configuration for voice calls ────────────────────────────────────
// STUN alone only tells each side its own public address. That is enough when
// at least one end sits behind a permissive NAT, and it is why calls inside one
// country often work. It is NOT enough when both ends are behind symmetric NAT
// or carrier-grade NAT, where the mapping differs per destination and the
// learned addresses are useless to the peer — which is the normal case on many
// mobile networks, and why a Germany-to-Turkey call was answered and then
// failed to connect. Those pairs need a relay.
//
// Operators point this at their own TURN server:
//   PEER_TURN_URL=turn:turn.example.org:3478 PEER_TURN_USER=… PEER_TURN_PASS=…
// Several URLs may be comma-separated. With none set, the public Open Relay
// service is offered as a fallback so international calls work out of the box;
// the app tells users when a call is actually being relayed.
// No default TURN is shipped. The obvious candidate — the old free Open Relay
// — was probed and no longer speaks STUN at all: the port accepts TCP and then
// answers with something that is not a STUN message. Listing it would have made
// calls look fixed while failing exactly as before, which is worse than the
// honest gap. There is no dependable credential-free public TURN; a relay costs
// bandwidth, so somebody has to be paying for it.
const ICE_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const ICE_TURN_URL = (process.env.PEER_TURN_URL ?? '').trim();
const ICE_SERVERS = ICE_TURN_URL
  ? [...ICE_STUN, {
      urls: ICE_TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.PEER_TURN_USER ?? '',
      credential: process.env.PEER_TURN_PASS ?? '',
    }]
  : ICE_STUN;
const ICE_IS_OWN_TURN = !!ICE_TURN_URL;

// Stream signalling reuses the call mailbox. The broadcaster holds one peer
// connection per viewer, so every stream signal is routed by its sender: the
// mailbox already stamps `from`, which is exactly the key the broadcaster needs.
const SIGNAL_KINDS = new Set([
  'ring', 'accept', 'ice', 'hangup', 'decline',
  'swatch',  // viewer → broadcaster: let me in
  'soffer',  // broadcaster → viewer: here is the media
  'sanswer', // viewer → broadcaster: accepted
  'sice',    // both ways, routed by sender
  'sbye',    // either side: I am done
]);

// ── Live registry: who is broadcasting RIGHT NOW ──────────────────────────
// The stream act records that a stream happened; being live is ephemeral and
// belongs nowhere near an append-only log. Broadcasters heartbeat, and an entry
// that stops beating disappears on its own — no "end stream" act to lose.
const LIVE_TTL = 25_000;
const liveStreams = new Map(); // author id -> {cid, title, since, ts, viewers}

function liveNow() {
  const now = Date.now();
  const out = [];
  for (const [id, s] of liveStreams) {
    if (now - s.ts > LIVE_TTL) { liveStreams.delete(id); continue; }
    out.push({ author: id, cid: s.cid, title: s.title, since: s.since, viewers: s.viewers ?? 0 });
  }
  return out;
}

// ── View counts: deliberately NOT protocol ────────────────────────────────
// This network's premise is that influence is transported commitment, not
// attention. A view count is an attention metric, so it is kept strictly out
// of the act log, out of the graph and out of every score: host-side telemetry
// that anyone may ignore. It is shown because people asked to see it, and it is
// labelled so nobody mistakes it for standing.
const viewCounts = new Map();   // content id -> count
const viewSeen = new Map();     // "ip|cid" -> last counted at
const VIEW_DEDUPE_MS = 6 * 60 * 60 * 1000;

function countView(cid, ip) {
  const key = ip + '|' + cid;
  const now = Date.now();
  const last = viewSeen.get(key);
  if (last && now - last < VIEW_DEDUPE_MS) return false;
  if (viewSeen.size > 50000) viewSeen.clear(); // memory backstop
  viewSeen.set(key, now);
  viewCounts.set(cid, (viewCounts.get(cid) ?? 0) + 1);
  return true;
}
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
  'Access-Control-Allow-Origin': '*', // see CORS note at the request handler
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // microphone=(self): voice calls decode/capture on the page itself; camera
  // stays closed until video calls are a designed feature, not a side effect.
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  // img-src/media-src must allow blob: — host-served media is fetched and
  // rendered from object URLs; data: covers the local sandbox's inline images.
  // script-src gains 'self' and worker-src/manifest-src appear so the installed
  // app can register its service worker and read its manifest; without them
  // default-src 'none' silently refuses both and the install just does nothing.
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "worker-src 'self'; manifest-src 'self'; " +
    "img-src 'self' data: blob:; media-src 'self' data: blob:; base-uri 'none'; form-action 'none'",
};

function persist(act) {
  appendFileSync(LOG, JSON.stringify(act) + '\n', 'utf8');
}

/**
 * Attach the standing explanation to any refusal that carries a code.
 *
 * Doing it here, at the one place every response is written, means a new
 * refusal cannot be added without an explanation appearing with it — and no
 * call site has to remember to include one.
 */
function json(res, code, body) {
  if (body && typeof body === 'object' && body.error && body.code && !body.why) {
    body = { ...body, ...refusal(body.code, body.error) };
  }
  const buf = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(buf);
}

// PIN protection: a register act may carry pinHash = H(id + ':' + pin).
// Later acts by that identity must carry the raw pin in `auth`; the server
// verifies the hash and STRIPS auth before the act enters the public log.
// Replay BOTH sources in log order (newest wins): a PIN set after
// registration must survive a restart, or protection silently evaporates.
// Registered passkeys, rebuilt from the log exactly like the PIN index. The
// public half is all that is stored, and it is useless to anyone who copies it.
const keyIndex = new Map();   // actor -> [{credId, cose, signCount, label}]

// Outstanding sign-in challenges. In memory, short-lived, single-use: a
// challenge that could be reused is a signature that could be replayed, which
// is the whole thing a passkey is supposed to prevent.
const CHALLENGE_TTL = 120_000;
const challenges = new Map(); // challenge -> {actor, at}
function issueChallenge(actor) {
  const now = Date.now();
  for (const [c, v] of challenges) if (now - v.at > CHALLENGE_TTL) challenges.delete(c);
  if (challenges.size > 5000) challenges.clear();
  const c = newChallenge();
  challenges.set(c, { actor, at: now });
  return c;
}
function takeChallenge(c, actor) {
  const v = challenges.get(c);
  if (!v) return false;
  challenges.delete(c);                       // single use, always
  return v.actor === actor && Date.now() - v.at <= CHALLENGE_TTL;
}

// The relying party is the origin the browser sees. Behind the tunnel that is
// the public hostname, not localhost, so it comes from configuration rather
// than a guess — a wrong rpId makes every passkey silently unusable.
const RP_ID = (process.env.PEER_RP_ID ?? '').trim();
const RP_ORIGIN = (process.env.PEER_RP_ORIGIN ?? '').trim();

const pinIndex = new Map();
// Accounts whose stored hash was proven correct this request but is still in a
// crackable legacy format. Filled by authError, flushed once the act is
// accepted — never on a failed attempt, or a wrong guess would rewrite the log.
const pinUpgrades = new Map();
for (const a of acts) {
  if ((a.t === 'register' || a.t === 'setPin') && a.pinHash) pinIndex.set(a.id, a.pinHash);
  if (a.t === 'setKey') {
    const list = keyIndex.get(a.id) ?? [];
    if (a.credId === null) keyIndex.set(a.id, []);            // explicit removal
    else { keyIndex.set(a.id, list.filter((k) => k.credId !== a.credId).concat([{ credId: a.credId, cose: a.cose, signCount: a.signCount ?? 0, label: a.label ?? 'passkey' }])); }
  }
}

// ── PIN storage ───────────────────────────────────────────────────────────
//
// The stored hash sits in a PUBLIC log. sha256(id + ':' + pin) over a numeric
// PIN is therefore not a secret at all: the whole four-digit keyspace is ten
// thousand hashes, which a laptop finishes before the page has finished
// loading. Six digits is a million — still seconds. Rate limiting the login
// door does nothing about this, because the attacker never touches the door.
//
// PBKDF2-HMAC-SHA256 with a per-account random salt is the minimum honest
// answer: the salt kills precomputation across accounts, and the iteration
// count sets a price per guess that the defender pays once per login and the
// attacker pays ten thousand times. It does NOT make a four-digit PIN strong —
// nothing can — which is why passkeys exist alongside it.
//
// Format: pbkdf2$<iterations>$<salt-hex>$<hash-hex>. Old sha256 and fnv hashes
// still verify, so nobody is locked out; they are upgraded in place on the
// next correct login.
const PIN_ITERATIONS = 210_000;   // OWASP 2023 floor for PBKDF2-HMAC-SHA256

function fnvHash(id, pin) {
  let h = 0x811c9dc5;
  const s = id + ':' + pin;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv' + h.toString(16);
}

function pbkdf2Pin(pin, saltHex, iter) {
  return pbkdf2Sync(pin, Buffer.from(saltHex, 'hex'), iter, 32, 'sha256').toString('hex');
}

/** A stored hash in any format this host has ever written. */
function validPinHash(v) {
  if (typeof v !== 'string') return false;
  if (/^[a-f0-9]{64}$/.test(v)) return true;             // legacy sha256
  if (/^fnv[0-9a-f]{1,8}$/.test(v)) return true;         // legacy non-secure-context
  const m = /^pbkdf2\$(\d{4,7})\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(v);
  return !!m && Number(m[1]) >= 100_000;                 // refuse a weakened cost
}

/** Freshly hash a PIN in the current format. */
function newPinHash(pin) {
  const salt = randomBytes(16).toString('hex');
  return 'pbkdf2$' + PIN_ITERATIONS + '$' + salt + '$' + pbkdf2Pin(pin, salt, PIN_ITERATIONS);
}

/**
 * Does `pin` match what is stored? Constant-time on the modern format; the
 * legacy formats are compared the same way for consistency.
 */
function pinMatches(id, pin, stored) {
  if (typeof stored !== 'string' || typeof pin !== 'string' || !pin) return false;
  let expected;
  const m = /^pbkdf2\$(\d+)\$([a-f0-9]+)\$([a-f0-9]{64})$/.exec(stored);
  if (m) {
    expected = 'pbkdf2$' + m[1] + '$' + m[2] + '$' + pbkdf2Pin(pin, m[2], Number(m[1]));
  } else if (stored.startsWith('fnv')) {
    expected = fnvHash(id, pin);
  } else {
    expected = createHash('sha256').update(id + ':' + pin, 'utf8').digest('hex');
  }
  const a = Buffer.from(expected), b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the stored hash is one of the crackable legacy formats. */
function pinNeedsUpgrade(stored) {
  return typeof stored === 'string' && !stored.startsWith('pbkdf2$');
}

// Acts that destroy or rewrite existing content are irreversible: a deleted
// account can never be re-registered, redacted bytes are gone, and an edit
// overwrites the stored post. An unsecured handle is claimable by anyone who
// knows its id, so for these kinds "no PIN on file" must mean REFUSED, not
// waved through — otherwise a stranger can erase someone else's account with a
// single request. Ordinary acts keep the old permissive behaviour.
const PIN_REQUIRED = new Set(['editPost', 'deletePost', 'deleteAccount']);

/** Has this handle done anything beyond existing? Used to decide whether a
 *  first PIN is someone securing their own new handle, or a stranger claiming
 *  an established one. */
const SUBSTANTIVE = new Set(['post', 'review', 'opinion', 'tag', 'dm', 'stream', 'call']);
function hasHistory(id) {
  for (const a of acts) {
    if (SUBSTANTIVE.has(a.t) && (a.author === id || a.from === id)) return true;
  }
  return false;
}
const OPERATOR_TOKEN = (process.env.PEER_OPERATOR_TOKEN ?? '').trim();

// ── Paid placements ────────────────────────────────────────────────────────
// The address is configuration, never generated here. A key this process
// invented would be a key that had passed through a build log, a terminal and
// possibly a git history — and an address whose key is not already in a wallet
// the operator can spend from is money that arrives and cannot leave. So the
// operator pastes a receive address from their own wallet, and the host only
// ever displays it. No private key exists anywhere in this codebase.
//
// It is checksum-validated at boot rather than trusted: a mistyped address is
// not a failed payment, it is money sent somewhere nobody holds the key to.
const BTC_ADDRESS_RAW = (process.env.PEER_BTC_ADDRESS ?? '').trim();
let BTC_ADDRESS = '';
if (BTC_ADDRESS_RAW) {
  if (validBtcAddress(BTC_ADDRESS_RAW)) {
    BTC_ADDRESS = BTC_ADDRESS_RAW;
  } else {
    console.error('[ads] PEER_BTC_ADDRESS failed its own checksum — refusing to display it. Paid placements are OFF.');
    console.error('[ads] Copy a receive address from your wallet; do not type it by hand.');
  }
}
const adStore = createAdStore(resolve(DATA_DIR, 'ads.json'), {
  priceSatsPerDay: Number(process.env.PEER_AD_SATS_PER_DAY) || 20000,
});

function authError(act) {
  const actor = act.t === 'register' ? null
    // setKey belongs here for the same reason setPin does: attaching a
    // credential decides who can act as this handle from now on, so it has to
    // be authorised by whoever can act as it today. It was missing, which made
    // key registration skip the PIN check entirely — a test caught it before
    // the endpoint ever shipped.
    : (act.author ?? act.from ?? (['burn', 'deposit', 'burnL0', 'redeem', 'setPin', 'setKey', 'deleteAccount'].includes(act.t) ? act.id : null));
  if (!actor) return null; // closeEpoch/closeCycle are communal; register is checked for uniqueness only
  const stored = pinIndex.get(actor);
  if (!stored) {
    if (PIN_REQUIRED.has(act.t)) {
      return 'this handle has no PIN — set one before deleting or editing, otherwise anyone could do it in your name';
    }
    // Claiming an unsecured handle that already has a history is how a real
    // tester got locked out of their own account here: setPin was accepted
    // from anyone, so whoever set a PIN first owned the name. Securing a
    // handle you just registered is still free; taking over one that has
    // already spoken is not, because nothing in this act proves you are its
    // author. There is no key and no email to fall back on, so the only
    // honest gate left is the operator.
    if (act.t === 'setPin' && hasHistory(actor)) {
      const tok = typeof act.auth === 'string' ? act.auth : '';
      if (!OPERATOR_TOKEN || tok !== OPERATOR_TOKEN) {
        return 'this handle has already posted and has no PIN, so it cannot be claimed from outside — that is exactly how someone else would take it. The instance operator can set one for you.';
      }
      return null;
    }
    return null;
  }
  // A passkey proves more than a PIN does and is checked first: the signature
  // covers a challenge this host issued seconds ago and the origin the browser
  // was actually on, so it cannot be replayed and cannot be phished.
  const assertion = act.auth && typeof act.auth === 'object' ? act.auth : null;
  if (assertion) {
    const keys = keyIndex.get(actor) ?? [];
    const cred = keys.find((k) => k.credId === assertion.credId);
    if (!cred) return 'that passkey is not registered to this handle';
    if (!takeChallenge(assertion.challenge, actor)) return 'that sign-in has expired or was already used — ask for a new challenge';
    const bad = verifyAssertion(assertion, cred, {
      challenge: assertion.challenge,
      origin: RP_ORIGIN || null,
      rpId: RP_ID || 'localhost',
    });
    if (bad) return 'passkey refused: ' + bad;
    cred.signCount = assertion.signCount ?? cred.signCount;
    return null;
  }
  const pin = typeof act.auth === 'string' ? act.auth : '';
  if (!pinMatches(actor, pin, stored)) return 'this handle is PIN-secured — wrong or missing PIN';
  // Correct PIN on a legacy hash: quietly re-store it at the modern cost, so
  // an account stops being offline-crackable the first time its owner logs in
  // and nobody has to be told to do anything.
  if (pinNeedsUpgrade(stored)) pinUpgrades.set(actor, newPinHash(pin));
  return null;
}

// The four actors seedWorld creates exist without a register act — they are
// the world every log starts from, and forgetting them would refuse the oldest
// accounts on the network.
const SEED_ACTORS = new Set(['alice', 'bob', 'carol', 'dave']);

/**
 * Which catalogued reason is this refusal?
 *
 * The messages are written for people and name real numbers, so they cannot
 * double as identifiers. This is the one place that maps them, kept next to
 * validate() so a new refusal and its code are added together. Anything
 * unmatched is reported as BAD_REQUEST rather than as nothing, and the
 * catalogue endpoint says plainly that the list is not exhaustive.
 */
const REFUSAL_CODES = [
  [/already registered|reads as .* which is already registered/i, 'HANDLE_TAKEN'],
  [/no such handle|no such recipient|unknown handle|unknown actor|unknown recipient/i, 'NO_SUCH_HANDLE'],
  [/PIN-secured/i, 'PIN_WRONG'],
  [/no PIN — set one|has no PIN/i, 'PIN_REQUIRED'],
  [/cannot be claimed from outside|already posted and has no PIN|already acted and has no PIN/i, 'HANDLE_UNCLAIMABLE'],
  [/too many PIN attempts/i, 'PIN_ATTEMPTS'],
  [/passkey refused|not registered to this handle|sign-in has expired/i, 'PASSKEY_REFUSED'],
  [/characters; the limit is|is too long|the limit is \d+/i, 'TOO_LONG'],
  [/only the author/i, 'NOT_YOURS'],
  [/never minted on this network|no content with id/i, 'UNKNOWN_TARGET'],
  [/already deleted|that comment was deleted/i, 'ALREADY_DELETED'],
  [/account was deleted/i, 'ACCOUNT_DELETED'],
  [/not enough energy/i, 'NO_ENERGY'],
  [/below the safety wall|standing is below/i, 'RATE_TOO_LOW'],
  [/balance is .* tried to (send|deposit|sell)|not enough balance/i, 'INSUFFICIENT_BALANCE'],
  [/the price moved|below your minimum/i, 'SLIPPAGE'],
  [/pool already exists/i, 'POOL_EXISTS'],
  [/already claimed its tBTC/i, 'ALREADY_CLAIMED'],
  [/symbol .* is taken|is taken$/i, 'SYMBOL_TAKEN'],
  [/no payment address/i, 'ADS_CLOSED'],
  [/approve advert .* before marking it paid/i, 'AD_NOT_APPROVED'],
  [/url must be a plain/i, 'BAD_URL'],
  [/engine still loading/i, 'ENGINE_LOADING'],
];
function classify(message) {
  const m = String(message ?? '');
  for (const [re, code] of REFUSAL_CODES) if (re.test(m)) return code;
  return 'BAD_REQUEST';
}

/** Every id that actually exists as an actor. */
function isRegistered(id) {
  if (typeof id !== 'string') return false;
  if (SEED_ACTORS.has(id)) return true;
  return acts.some((a) => a.t === 'register' && a.id === id);
}

function validate(act) {
  // Who is claiming to have done this, and do they exist?
  //
  // Nothing checked. A tester posted as "Luke Skywalker", "Darth Vader" and
  // "Han Solo" — names that were never registered at all — and the acts were
  // accepted, written to the log, and then crashed every replay that read
  // them, taking the host down. Two separate failures from one missing check:
  // anyone could speak as anyone, and anyone could stop the network.
  //
  // register creates the actor, and the communal acts belong to no one.
  const AUTHORLESS = new Set(['register', 'closeEpoch', 'closeCycle', 'seedWorld']);
  if (!AUTHORLESS.has(act.t)) {
    const claimed = act.author ?? act.from ?? act.id;
    if (claimed !== undefined && !isRegistered(claimed)) {
      return 'no such handle: ' + String(claimed).slice(0, 40)
        + ' — an act has to come from an account that exists, or the record stops meaning anything';
    }
    if (act.t === 'dm' && !isRegistered(act.to)) return 'no such recipient: ' + String(act.to).slice(0, 40);
  }

  if (!act || typeof act !== 'object' || !ACT_KINDS.has(act.t)) return 'unknown act kind';
  // The per-field checks name their limits; this one used to say only "act too
  // large", which reads as broken content one layer up from where the length
  // actually is. Same courtesy here: what was sent, and what fits.
  const actBytes = JSON.stringify(act).length;
  if (actBytes > MAX_ACT_BYTES) {
    return 'act too large: ' + actBytes + ' bytes serialised, the limit is ' + MAX_ACT_BYTES
      + '. Text fields cap at 1000 characters (500 for messages); if you are under that, an attachment or reference list is the cause.';
  }
  if (acts.length >= MAX_ACTS) return 'log full — test instance capacity reached';
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const inR = (v) => num(v) && v >= -1 && v <= 1;
  const str = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
  // A refusal that names no number reads as "your content is broken" when the
  // only problem is length. Say the limit and what was actually sent.
  const tooLong = (v, n, what) =>
    (typeof v === 'string' && v.length > n)
      ? what + ' is too long: ' + v.length + ' characters, the limit is ' + n
      : null;
  switch (act.t) {
    case 'register': {
      if (!str(act.id, 24) || !/^u_[a-z0-9]+$/.test(act.id) || !str(act.handle, 16)) return 'bad registration';
      if (!num(act.seed) || act.seed !== 1) return 'bad seed';
      if (acts.some((a) => a.t === 'register' && a.id === act.id)) return 'handle already registered';
      // The id was the ONLY thing checked, so any free id could wear a name
      // already in use: a tester registered u_ender1337 and u_ender1338, both
      // displaying "Ender133", and posted as them. On a network whose whole
      // premise is that the record shows who did what, a name anyone can wear
      // is not cosmetic. Handles are now unique by the shape a reader
      // resolves, not by their bytes.
      const clash = handleClash(act.handle, takenHandles(acts));
      if (clash) return clash;
      if (act.pinHash !== undefined && !validPinHash(act.pinHash)) return 'bad pin hash';
      break;
    }
    case 'burn':
      if (!str(act.id, 24) || act.amt !== 1) return 'bad burn';
      break;
    case 'post': {
      if (tooLong(act.text, 1000, 'post')) return tooLong(act.text, 1000, 'post');
      if (!str(act.author, 24) || !str(act.text, 1000) || !inR(act.a)) return 'bad post';
      if (act.ref !== undefined && unknownTarget(act.ref)) return unknownTarget(act.ref);
      // A post naming an existing one is an UPDATE, not a new publication:
      // records are immutable, so revising a node can only mean authoring a
      // further record about it. Absent target = the ordinary minting case.
      if (act.target !== undefined) {
        if (!Number.isInteger(act.target)) return 'bad update target';
        const orig = acts[act.target];
        if (!orig || (orig.t !== 'post' && orig.t !== 'stream')) return 'update target is not a post';
        if (orig.author !== act.author) return 'only the author can update their own post';
        if (orig.redacted) return 'that post was deleted';
      }
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
    }
    case 'opinion':
      if (!str(act.author, 24) || !str(act.target, 40) || !inR(act.p) || !inR(act.r)) return 'bad opinion';
      if (unknownTarget(act.target)) return unknownTarget(act.target);
      break;
    case 'review':
      if (act.upd !== undefined) {
        if (!Number.isInteger(act.upd)) return 'bad comment update target';
        const orig = acts[act.upd];
        if (!orig || orig.t !== 'review') return 'update target is not a comment';
        if (orig.author !== act.author) return 'only the author can revise their own comment';
        if (orig.redacted) return 'that comment was deleted';
      }
      if (tooLong(act.text, 1000, 'comment')) return tooLong(act.text, 1000, 'comment');
      if (!str(act.author, 24) || !str(act.target, 40) || !inR(act.e) || !inR(act.f) || !str(act.text, 1000)) return 'bad review';
      if (unknownTarget(act.target)) return unknownTarget(act.target);
      break;
    case 'tag':
      if (!str(act.author, 24) || !str(act.target, 40) || !str(act.name, 20) || !inR(act.r) || !inR(act.c)) return 'bad tag';
      if (unknownTarget(act.target)) return unknownTarget(act.target);
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
      if (tooLong(act.text, 500, 'message')) return tooLong(act.text, 500, 'message');
      if (!str(act.from, 24) || !str(act.to, 24) || !str(act.text, 500)) return 'bad message';
      break;
    case 'editPost':
      // Superseded and no longer accepted. It rewrote the bytes of a record
      // already published, which is the one thing an append-only log must not
      // do; a revision is now a second post naming the same node, appended
      // like everything else. Existing editPost acts still replay.
      return 'editPost is retired — publish a revision instead: {"t":"post","author":…,"text":…,"a":…,"target":<act index>}';
    case 'deletePost': {
      if (!str(act.author, 24) || !Number.isInteger(act.target)) return 'bad delete';
      // Deletion names the post, not one of the acts that wrote it. A revision
      // is also a `post` act, so naming one used to pass every check here and
      // then remove nothing but the edit — the request answered 200 while the
      // post stayed up wearing its pre-revision text. Walk back to the mint and
      // record the tombstone against that, so the log says which node died.
      act.target = mintIndexOf(act.target);
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
    case 'stream':
      if (!str(act.author, 24) || !str(act.text, 200) || !inR(act.a)) return 'bad stream';
      break;
    case 'setKey':
      if (!str(act.id, 24)) return 'bad key registration';
      // credId null is "remove every passkey", which must stay possible: a
      // lost phone should not lock someone out of their own handle forever.
      if (act.credId !== null) {
        if (!str(act.credId, 512) || !Array.isArray(act.cose) || act.cose.length > 16) return 'bad credential';
      }
      break;
    case 'btcClaim':
    case 'assetCreate':
    case 'tokenSend':
    case 'poolCreate':
    case 'poolAdd':
    case 'poolRemove':
    case 'poolSwap': {
      if (!str(act.author, 24)) return 'bad actor';
      // Numbers must be finite before any arithmetic sees them: an Infinity
      // deposited into a pool would poison every price after it.
      for (const f of ['supply', 'amt', 'amtA', 'amtB', 'shares', 'minOut']) {
        if (act[f] !== undefined && (typeof act[f] !== 'number' || !Number.isFinite(act[f]))) return f + ' must be a finite number';
      }
      for (const f of ['sym', 'symA', 'symB', 'to', 'pool', 'sell', 'name']) {
        if (act[f] !== undefined && !str(act[f], 80)) return 'bad ' + f;
      }
      // Semantics — balances, pool existence, slippage — come from the SAME
      // function the replay uses to apply the act. One rulebook, two readers:
      // the host cannot accept what the replay would skip.
      if (!engineMod || !replayMod) return 'engine still loading — try again in a moment';
      if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
      if (stateCache.len !== acts.length || !stateCache.st) {
        stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
      }
      const terr = stateCache.st.tokenActError(act);
      if (terr) return terr;
      break;
    }
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

// ══ Bot / AI API ═══════════════════════════════════════════════════════════
// A bot should not have to reimplement the protocol to read a post. The host
// therefore runs the SAME replay the browser runs — social/replay.cjs, inlined
// into the page and required here — so a feed fetched over HTTP and a feed
// rendered on screen come from one implementation. Both artifacts are produced
// by `npm run build:social`; if they are missing the bot API answers 503 and
// the rest of the host keeps working.
let engineMod = null, replayMod = null, engineErr = null;
try {
  const require_ = createRequire(import.meta.url);
  replayMod = require_('./social/replay.cjs');
} catch (e) { engineErr = 'replay module missing: ' + e.message; }

async function ensureEngine() {
  if (engineMod || engineErr) return engineMod;
  try {
    engineMod = await import(new URL('public/peer-engine.mjs', import.meta.url).href);
    if (typeof engineMod.THETA === 'number') THETA_ = engineMod.THETA;
  } catch (e) {
    engineErr = 'engine bundle missing — run: npm run build:social (' + e.message + ')';
  }
  return engineMod;
}

// Replaying 300+ acts costs real work; the log is append-only, so length keys it.
let stateCache = { len: -1, st: null, R: null };
async function worldState() {
  const E = await ensureEngine();
  if (!E || !replayMod) return null;
  if (stateCache.len === acts.length && stateCache.st) return stateCache.st;
  if (!stateCache.R) stateCache.R = replayMod.create(E);
  const st = stateCache.R.replay(acts);
  stateCache = { len: acts.length, st, R: stateCache.R };
  return st;
}

// Synchronous balance lookup for the W1 gate. Replay itself is synchronous —
// only loading the engine is async — so once it is up we can settle solvency
// inside the request. Returns null when the engine is unavailable, and the
// gate then fails OPEN: a missing build must not silence the whole network.
let THETA_ = 0.0528066; // replaced by the engine's constant once loaded
function solvency(actorId) {
  if (!engineMod || !replayMod) return null;
  if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
  if (stateCache.len !== acts.length || !stateCache.st) {
    stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
  }
  const l = stateCache.st.ledgerById[actorId];
  return l ? l.burnBal : null;
}

// Does this content id name something replay actually minted?
//
// Nothing checked this, so an act naming a content id that does not exist was
// accepted, charged θ, and then sat in the record forever as "something since
// removed". Eighteen acts on the live log point at ids that were never minted —
// the fingerprint of a counter shift, where a client computed an id from its
// own view and the log later disagreed. The acts are real and stay; this stops
// the next one. Fails OPEN like the solvency gate: a missing build must never
// silence the network.
function contentExists(id) {
  if (!engineMod || !replayMod) return true;
  if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
  if (stateCache.len !== acts.length || !stateCache.st) {
    stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
  }
  return stateCache.st.g.nodes.has(id);
}

// Only ids that claim to be minted content are checked. `prof_<id>` targets a
// person and is resolved elsewhere; anything else is refused by shape already.
function unknownTarget(id) {
  if (typeof id !== 'string' || !/^c\d+$/.test(id)) return null;
  return contentExists(id) ? null : 'no content with id ' + id + ' — it was never minted on this network';
}

const isDeleted = (st, id) => !!(st.deleted && st.deleted[id]);
const nameOf = (st, id) => (st.handles && st.handles[id]) || id;

// One post/comment, flattened for a consumer that has no graph.
function contentView(st, cid) {
  const author = st.creators[cid];
  if (!author || st.payloads[cid] === undefined) return null;
  const node = st.g.nodes.get(cid) || {};
  const reactions = [];
  const comments = [];
  for (const e of st.g.edges) {
    if (e.family === 'Opinion' && e.tgt === cid) {
      reactions.push({ by: e.src, byHandle: nameOf(st, e.src), polarity: e.pd, reaction: e.pi });
    } else if (e.family === 'ReviewT' && e.src === cid && st.payloads[e.tgt] !== undefined) {
      comments.push(e.tgt);
    }
  }
  const meta = st.postMeta && st.postMeta[cid];
  return {
    id: cid,
    kind: node.kind === 'Comment' ? 'comment' : 'post',
    author, authorHandle: nameOf(st, author),
    text: st.payloads[cid] || '',
    media: (st.mediaMeta[cid] || []).map((m) => ({
      url: m.h ? '/api/media/' + m.h : null, type: m.m, name: m.n ?? null,
    })),
    reactions, commentIds: comments,
    edited: !!(meta && meta.edited),
    actIndex: meta ? meta.idx : null,
  };
}

function threadOf(st, cid, depth) {
  const v = contentView(st, cid);
  if (!v) return null;
  v.comments = (depth > 0 ? v.commentIds : []).map((c) => threadOf(st, c, depth - 1)).filter(Boolean);
  delete v.commentIds;
  return v;
}

// Rank a feed by calling the very same engine entry points the UI calls, with
// the same arguments. Hand-rolling a "close enough" ranking here would recreate
// the divergence this whole shared-replay arrangement exists to prevent.
function rankFeed(st, E, viewer, sort, limit) {
  const personOf = (id) => (id && id.indexOf('prof_') === 0 ? id.slice(5) : id);
  const creatorOf = (id) => st.creators[id] || null;

  if (sort === 'new') {
    // A node can carry several Publish edges now — the genesis one and every
    // revision — so listing edges shows the same post once per revision. Keep
    // the newest edge per node: a revised post is one post, at its latest time.
    const latest = new Map();
    for (const e of st.g.edges) {
      if (e.family !== 'Publish' || st.payloads[e.tgt] === undefined) continue;
      const prev = latest.get(e.tgt);
      if (prev === undefined || e.appendIndex > prev) latest.set(e.tgt, e.appendIndex);
    }
    const out = [...latest].map(([cid, i]) => ({ cid, i }));
    out.sort((a, b) => b.i - a.i);
    return out.slice(0, limit)
      .map((r) => ({ ...contentView(st, r.cid), score: null, why: 'chronological, unranked' }))
      .filter((x) => x.id);
  }

  if (sort === 'cogra') {
    const scored = E.cograRank(st.g, viewer, st.epochHistory.length, {
      personOf, creatorOf,
      candidates: (nd) => nd.kind === 'Content' && !!st.payloads[nd.id],
    }) || [];
    return scored.slice(0, limit).map((s) => ({
      ...contentView(st, s.node.id),
      score: s.S,
      why: s.paths.length + ' disjoint path' + (s.paths.length === 1 ? '' : 's') + ' carrying it to you',
      paths: s.paths.map((p) => ({
        magnitude: p.m, sign: p.sigma, recency: p.f,
        via: p.nodes.map((n) => nameOf(st, n)),
      })),
    })).filter((x) => x.id);
  }

  // Layer-1 default — identical call to the geek feed's E.rankFeed(...)
  const entries = E.rankFeed(st.g, viewer, (id) => E.NU * (st.xById[id] || 0), creatorOf);
  return entries
    .filter((f) => st.payloads[f.node.id] !== undefined)
    .slice(0, limit)
    .map((f) => ({
      ...contentView(st, f.node.id),
      score: f.relevance,
      why: 'BFS weight ' + f.bfsWeight.toFixed(4) + ' × standing amplifier '
        + f.amplifier.toFixed(3) + ' × content norm ' + f.contentNorm.toFixed(3),
    }))
    .filter((x) => x.id);
}

// The document an agent GETs to learn the whole API without prior knowledge.
const API_DOC = {
  name: 'Peer Network bot API',
  version: 'v1',
  what: 'A social network whose feed, standing and economy are replayable mathematics rather than engagement heuristics. This API gives bots the derived state directly, so you never have to replay the protocol yourself.',
  howItWorks: {
    acts: 'Everything anyone does is an act appended to a public log. There are no private records; a direct message is an act like any other.',
    cost: 'Every act debits θ = 0.0528066 from your burn balance and raises your act count N. Your commitment rate is balance/N: acting dilutes it, burning reserve restores it. Run out and the host refuses the act with 402 (gate W1) — POST /api/v1/burn to convert reserve into energy. Recovery acts and corrections are never gated, so you can always climb back.',
    standing: 'Standing is transported, never minted. Vouching for someone moves your own rate toward them and can lower it. Nothing you do to yourself creates standing.',
    feed: 'Your feed is computed from YOUR position in the graph. Two accounts see different feeds from the same log, and both are checkable.',
    honesty: 'The numbers this API returns come from the same replay the web client runs — not a parallel implementation.',
  },
  auth: {
    how: 'PIN-secured handles pass their PIN as the "pin" field on write calls. Reads need no auth: the log is public.',
    warning: 'This is a test network. A PIN is not cryptographic identity, and nothing here is private. Do not post secrets.',
  },
  quickstart: [
    '1. GET /api/v1/peers to see who exists.',
    '2. POST /api/v1/register {handle, pin} to create your bot an identity.',
    '3. GET /api/v1/whoami?as=<id> to see your energy and standing.',
    '4. GET /api/v1/feed?as=<id> for your ranked feed, already scored and explained.',
    '5. POST /api/v1/post {as, pin, text} to say something.',
    '6. Poll GET /api/v1/events?since=<cursor> to follow what changes.',
  ],
  endpoints: [
    { method: 'GET', path: '/api/v1', purpose: 'this document' },
    { method: 'GET', path: '/api/v1/state', purpose: 'network summary: actor count, epoch, act cursor' },
    { method: 'GET', path: '/api/v1/peers', purpose: 'every actor with handle, standing, rate and whether it is PIN-secured' },
    { method: 'GET', path: '/api/v1/whoami?as=ID', purpose: 'your standing, energy, how many acts you can still afford, and your wall status' },
    { method: 'GET', path: '/api/v1/feed?as=ID&sort=cogra|l1|new&limit=N', purpose: 'ranked feed for that identity, each item carrying its score and why it ranked' },
    { method: 'GET', path: '/api/v1/post/CID?depth=N', purpose: 'one post with its reactions and comment thread' },
    { method: 'GET', path: '/api/v1/alerts?as=ID', purpose: 'what happened to you: reactions, comments, mentions, quotes, messages, calls' },
    { method: 'GET', path: '/api/v1/inbox?as=ID', purpose: 'your chat threads' },
    { method: 'GET', path: '/api/v1/tokens?as=ID', purpose: 'PEER/tBTC/custom asset balances, your epoch distributions, and the emission schedule' },
    { method: 'GET', path: '/api/v1/pools', purpose: 'liquidity pools: reserves, prices, and the acts that drive them' },
    { method: 'GET', path: '/api/v1/errors', purpose: 'every refusal this host can return: a stable code, why the rule exists, and what to do about it. Branch on `code`, not on the wording.' },
    { method: 'GET', path: '/api/v1/events?since=N&limit=M', purpose: 'acts after cursor N, decoded into plain language. The cheap way to stay in sync. Each event carries `node`: the content id that act minted (or, for a revision, wrote to) — read it from here, never derive it: the id counter also ticks for hyperedge legs (quotes, mentions), so client-side counting lands off by one and replies go nowhere.' },
    { method: 'POST', path: '/api/v1/register', purpose: 'create an identity', body: { handle: 'string ≤16', pin: 'string ≥4 (strongly recommended)' } },
    { method: 'POST', path: '/api/v1/post', purpose: 'publish, or revise one of your own posts', body: { as: 'id', pin: 'string', text: 'string ≤1000', quote: 'optional content id', attachment: 'optional {h, m, n} from POST /api/media', revise: 'optional content id — supersedes that post instead of minting a new one; it stays yours, keeps its comments and reactions, and the original record stays in the log' } },
    { method: 'POST', path: '/api/v1/comment', purpose: 'comment on a post OR on another comment', body: { as: 'id', pin: 'string', target: 'content id', text: 'string ≤1000', enthusiasm: 'optional -1..1', effort: 'optional -1..1' } },
    { method: 'POST', path: '/api/v1/react', purpose: 'react to content, or vouch for a person by targeting prof_<id>', body: { as: 'id', pin: 'string', target: 'content id or prof_id', polarity: 'optional -1..1', reaction: 'optional -1..1' } },
    { method: 'POST', path: '/api/v1/tag', purpose: 'tag content into the commons', body: { as: 'id', pin: 'string', target: 'content id', name: 'string ≤20' } },
    { method: 'POST', path: '/api/v1/message', purpose: 'direct message (public in the log, like everything)', body: { as: 'id', pin: 'string', to: 'id', text: 'string ≤500' } },
    { method: 'POST', path: '/api/v1/burn', purpose: 'convert reserve into energy so you can keep acting', body: { as: 'id', pin: 'string' } },
  ],
  limits: {
    acts: ACT_RATE + ' per minute per IP', reads: '600 per minute per IP',
    registrations: REGISTER_RATE + ' per hour per IP', postText: 1000, messageText: 500,
  },
  errors: 'Every refusal returns {error} with a sentence saying what is wrong and, where a number is involved, what the limit is and what you sent.',
  etiquette: 'Bots are welcome as participants, not as megaphones. Acting costs energy by design; a bot that posts constantly dilutes its own rate until the network stops listening to it. Read before you write.',
};

/**
 * The one path by which anything enters the log. Both POST /api/act and the
 * bot API call this, so a bot cannot be validated more loosely, authenticated
 * differently, or exempted from the economy — there is no second door.
 * `act` must already be sanitized. Returns {error, code} or {ok:true, index}.
 */
// W1 solvency, the spec's per-act gate. Until now only the browser refused a
// drained author; the host accepted anything and let the balance run negative,
// so "every act costs energy" was true of the arithmetic but not of the rules —
// any script could talk forever. These kinds are gated. Recovery acts (burn,
// deposit, redeem) and free corrections must stay open, or a drained handle
// could never climb out.
const W1_GATED = new Set(['post', 'opinion', 'review', 'tag', 'dm', 'call']);

/**
 * The single write door, wrapped so telemetry cannot drift from reality:
 * every refusal and every acceptance is counted here, at the one place both
 * outcomes are already known, instead of at each HTTP call site.
 */
function applyAct(act, auth, ip) {
  const out = applyActInner(act, auth, ip);
  opsAct(ip, act, out && out.error);
  if (out && !out.error) flushPinUpgrades();
  return out;
}

/**
 * Rewrite a proven-correct legacy PIN hash into the modern format.
 *
 * Only ever runs after the PIN was verified, so a wrong guess can never move
 * anything. The hash is authentication material, not protocol content: it is
 * in no score, no edge and no certificate, so replacing it changes nothing any
 * replay computes. Doing this silently, on the owner's next real login, is the
 * only version that actually protects the people who would never read a notice
 * telling them to reset their PIN.
 */
function flushPinUpgrades() {
  if (!pinUpgrades.size) return;
  let touched = false;
  for (const [id, fresh] of pinUpgrades) {
    for (let i = acts.length - 1; i >= 1; i--) {
      const a = acts[i];
      if ((a.t === 'register' || a.t === 'setPin') && a.id === id && a.pinHash) {
        a.pinHash = fresh;
        pinIndex.set(id, fresh);
        touched = true;
        break; // newest wins, exactly as the index does
      }
    }
  }
  pinUpgrades.clear();
  if (touched) rewriteLog();
}

function applyActInner(act, auth, ip) {
  const err = validate(act);
  if (err) {
    const kind = classify(err);
    return { error: err, code: statusFor(kind), errorCode: kind };
  }
  // A deleted account is gone as an actor — nothing more can be done as it.
  const actorId = act.author ?? act.from ?? act.id;
  if (actorId && deletedIds.has(actorId)) return { error: 'this account was deleted', code: 410 };
  if (act.to && deletedIds.has(act.to)) return { error: 'that account was deleted', code: 410 };
  const aerr = authError({ ...act, auth });
  if (aerr) {
    if (!pinFailLimiter(ip)) return { error: 'too many PIN attempts — locked for a few minutes', code: 429 };
    return { error: aerr, code: 401 };
  }
  if (W1_GATED.has(act.t) && solvency && actorId) {
    const bal = solvency(actorId);
    if (bal !== null && bal < THETA_) {
      return {
        code: 402,
        error: 'out of energy: balance ' + bal.toFixed(4) + ' is below the θ ' + THETA_.toFixed(4)
          + ' this act costs. Burn reserve to continue — every act dilutes your commitment rate, that is the point.',
      };
    }
  }
  act.ts = Date.now(); // server clock is the arbiter of the edit window
  if (act.t === 'post') act.rmen = parseMentionsSrv(act.text, handlesAt(acts.length));
  acts.push(act);
  persist(act);
  if ((act.t === 'register' || act.t === 'setPin') && act.pinHash) pinIndex.set(act.id, act.pinHash);
  if (act.t === 'setKey') {
    const list = keyIndex.get(act.id) ?? [];
    if (act.credId === null) keyIndex.set(act.id, []);
    else keyIndex.set(act.id, list.filter((k) => k.credId !== act.credId).concat([{ credId: act.credId, cose: act.cose, signCount: act.signCount ?? 0, label: act.label ?? 'passkey' }]));
  }
  if (act.t === 'setPin') pinIndex.set(act.id, act.pinHash); // newest wins; enforced from now on
  // Deletion/edit reach back into the stored log: content bytes leave the
  // file, structure (line count, ids, θ-parity fields) stays.
  // editPost no longer reaches here — validate() retires it. Only removal
  // still reaches back into the stored log, and removal takes bytes out
  // rather than putting different bytes in.
  if (act.t === 'deletePost') {
    redactNode(act.target);
    rewriteLog(); gcMedia();
  } else if (act.t === 'deleteAccount') {
    deletedIds.add(act.id);
    for (let ai = 1; ai < acts.length; ai++) {
      const a = acts[ai];
      if (a.t === 'post' && a.author === act.id && !a.redacted) redactPostAct(a, ai);
      // ONLY what this account authored. Blanking a message because it was
      // addressed to the leaver destroyed the counterparty's own record — their
      // words, erased by someone else's decision. The payload controller is the
      // act's author and nobody else.
      else if ((a.t === 'review' && a.author === act.id) || (a.t === 'dm' && a.from === act.id)) {
        if (a.text) { a.text = ''; a.redacted = true; }
      }
    }
    rewriteLog(); gcMedia();
  }
  return { ok: true, index: acts.length - 1 };
}

// Wrap, compress and hash the built page once per build, not once per visitor.
// Keyed on mtime+size so a rebuild is picked up without restarting the host.
let pageCache = null;
function pageDoc() {
  const stat = statSync(PAGE);
  const key = stat.mtimeMs + ':' + stat.size;
  if (pageCache && pageCache.key === key) return pageCache;
  // The build emits a complete document now — head, manifest link, iOS tags and
  // all — so wrapping it again here would nest a second <html> inside the body.
  const html = readFileSync(PAGE, 'utf8');
  const gz = gzipSync(Buffer.from(html), { level: 9 });
  pageCache = { key, html, gz, etag: '"' + createHash('sha256').update(html).digest('hex').slice(0, 16) + '"' };
  return pageCache;
}

function readBody(req, cap) {
  return new Promise((resolve_) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > cap) req.destroy(); });
    req.on('end', () => { try { resolve_(JSON.parse(b || '{}')); } catch { resolve_(null); } });
    req.on('error', () => resolve_(null));
  });
}

async function handleBotApi(req, res, url, ip) {
  const p = url.pathname.replace(/^\/api\/v1\/?/, '');
  const q = url.searchParams;

  if (req.method === 'GET' && p === '') { json(res, 200, API_DOC); return; }

  if (req.method === 'GET' && !readLimiter(ip)) { json(res, 429, { error: 'slow down — 600 reads per minute' }); return; }

  const st = await worldState();
  if (!st) { json(res, 503, { error: engineErr || 'protocol engine unavailable — run: npm run build:social' }); return; }

  const asId = q.get('as');
  const needAs = () => {
    if (!asId) { json(res, 400, { error: 'pass ?as=<your handle id>, e.g. as=u_yourbot. GET /api/v1/peers lists ids.' }); return false; }
    if (!st.ledgerById[asId]) { json(res, 404, { error: 'no such handle: ' + asId + ' — GET /api/v1/peers for the list' }); return false; }
    if (isDeleted(st, asId)) { json(res, 410, { error: 'that account was deleted' }); return false; }
    return true;
  };

  // ── reads ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === 'state') {
    json(res, 200, {
      actors: st.ledgers.filter((l) => !l.deleted).length,
      posts: Object.keys(st.payloads).length,
      edges: st.g.edges.length,
      epoch: st.epochNow,
      cursor: acts.length,
      theta: (await ensureEngine()).THETA,
      nu: (await ensureEngine()).NU,
      safetyWall: (await ensureEngine()).SAFE_FLOOR,
      note: 'cursor is the act-log length; pass it to /api/v1/events?since=cursor to follow along.',
    });
    return;
  }

  if (req.method === 'GET' && p === 'peers') {
    const NU_ = (await ensureEngine()).NU;
    json(res, 200, {
      peers: st.ledgers.filter((l) => !l.deleted).map((l) => ({
        id: l.id, handle: nameOf(st, l.id),
        standing: NU_ * (st.xById[l.id] || 0), // ν · x*, the number the UI shows
        reducedX: st.xById[l.id] || 0,
        rate: l.burnBal / Math.max(l.actCount, 1),
        energy: l.burnBal, acts: l.actCount,
        secured: !!st.pinHash[l.id],
      })).sort((a, b) => b.standing - a.standing),
    });
    return;
  }

  if (req.method === 'GET' && p === 'whoami') {
    if (!needAs()) return;
    const E = await ensureEngine();
    const l = st.ledgerById[asId];
    const rate = l.burnBal / Math.max(l.actCount, 1);
    // Two different numbers are both called "standing" in casual speech, and
    // they differ by ν = 0.1. The safety wall is compared against the REDUCED
    // coordinate, so returning only the displayed one would let a bot think it
    // is safely above a wall it is actually under. Return both, named.
    const x = st.xById[asId] || 0;
    json(res, 200, {
      id: asId, handle: nameOf(st, asId),
      standing: E.NU * x,
      reducedX: x,
      energy: l.burnBal, acts: l.actCount, rate,
      actsAffordable: Math.floor(l.burnBal / E.THETA),
      secured: !!st.pinHash[asId],
      canAct: l.burnBal >= E.THETA,
      aboveSafetyWall: x >= E.SAFE_FLOOR,
      safetyWall: E.SAFE_FLOOR,
      meaning: 'standing = ν · reducedX is the number others see. The W2a safety wall compares reducedX against safetyWall, not standing.',
      warning: l.burnBal < E.THETA * 5
        ? 'Low energy: POST /api/v1/burn to convert reserve into energy, or the network will refuse your next acts.'
        : (x < E.SAFE_FLOOR ? 'You are under the safety wall: your acts still record, but your standing no longer carries weight for others. Burn reserve to climb back.' : null),
    });
    return;
  }

  if (req.method === 'GET' && p === 'feed') {
    if (!needAs()) return;
    const sort = q.get('sort') || 'cogra';
    if (['cogra', 'l1', 'new'].indexOf(sort) < 0) {
      json(res, 400, { error: 'sort must be cogra, l1 or new — got ' + sort }); return;
    }
    const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 100);
    const E = await ensureEngine();
    const items = rankFeed(st, E, asId, sort, limit);
    // Cold start is real and must not read as "the network is empty": a new
    // account has no graph position, so nothing reaches it until it acts. The
    // UI shows these as "new to you"; a bot needs the same door or it has
    // nothing to react to and can never earn a feed.
    const seen = {};
    items.forEach((i) => { seen[i.id] = 1; });
    const beyond = [];
    if (items.length < limit) {
      for (const nid in st.payloads) {
        if (seen[nid] || st.creators[nid] === asId) continue;
        const v = contentView(st, nid);
        if (v) beyond.push(v);
        if (beyond.length >= limit - items.length) break;
      }
    }
    json(res, 200, {
      as: asId, sort, cursor: acts.length,
      explains: sort === 'cogra' ? 'score is S = Σ over k node-disjoint paths of sign × magnitude × recency'
        : sort === 'l1' ? 'score is BFS weight × standing amplifier × content norm'
        : 'no score: newest first',
      items,
      beyondHorizon: beyond,
      beyondHorizonMeans: beyond.length
        ? 'Nothing in the graph connects you to these yet, so they carry no score. React to one and it pulls its author into your reachable set — that is how a new account earns a feed.'
        : null,
    });
    return;
  }

  if (req.method === 'GET' && p.startsWith('post/')) {
    const cid = p.slice(5);
    const depth = Math.min(Math.max(Number(q.get('depth')) || 3, 0), 8);
    const v = threadOf(st, cid, depth);
    if (!v) { json(res, 404, { error: 'no content ' + cid + ' — it may have been deleted, or the id is wrong' }); return; }
    json(res, 200, v);
    return;
  }

  if (req.method === 'GET' && p === 'alerts') {
    if (!needAs()) return;
    const mine = {};
    for (const nid in st.creators) if (st.creators[nid] === asId) mine[nid] = 1;
    const out = [];
    for (const e of st.g.edges) {
      let who = null, kind = null, target = null;
      if (e.family === 'Opinion' && e.src !== asId) {
        if (e.tgt === 'prof_' + asId) { who = e.src; kind = 'vouched for you'; }
        else if (mine[e.tgt]) { who = e.src; kind = 'reacted to your post'; target = e.tgt; }
      } else if (e.family === 'ReviewA' && e.src !== asId && mine[e.tgt]) {
        who = e.src; kind = 'commented on your post'; target = e.tgt;
      } else if (e.family === 'TagA' && e.src !== asId && mine[e.tgt]) {
        who = e.src; kind = 'tagged your post'; target = e.tgt;
      } else if (e.family === 'ReferenceT' && e.src !== asId) {
        if (e.tgt === 'prof_' + asId) { who = st.creators[e.src]; kind = 'mentioned you'; target = e.src; }
        else if (mine[e.tgt]) { who = st.creators[e.src]; kind = 'quoted your post'; target = e.src; }
      }
      if (who && who !== asId && st.handles[who]) {
        out.push({ from: who, fromHandle: nameOf(st, who), what: kind, target, at: e.appendIndex });
      }
    }
    // One ordering, not two. The UI offsets message alerts by +100000, which
    // puts every message above every reaction forever — so a bot that gets
    // messages would stop seeing reactions entirely. Here both are ordered by
    // the act index they actually came from.
    for (const m of st.dms) {
      if (m.to !== asId) continue;
      out.push({
        from: m.from, fromHandle: nameOf(st, m.from),
        what: m.call ? 'called you (' + m.call.outcome + ')' : 'messaged you',
        text: m.call ? null : m.text, at: m.idx,
      });
    }
    out.sort((a, b) => b.at - a.at);
    json(res, 200, {
      as: asId, alerts: out.slice(0, 50),
      note: '"at" is the act-log index the alert came from; the same scale as the /api/v1/events cursor.',
    });
    return;
  }

  if (req.method === 'GET' && p === 'inbox') {
    if (!needAs()) return;
    const threads = {};
    for (const m of st.dms) {
      if (m.from !== asId && m.to !== asId) continue;
      const peer = m.from === asId ? m.to : m.from;
      (threads[peer] = threads[peer] || []).push({
        from: m.from, mine: m.from === asId,
        text: m.call ? null : m.text,
        call: m.call || null, at: m.idx,
      });
    }
    json(res, 200, {
      as: asId,
      threads: Object.keys(threads).map((peer) => ({
        peer, peerHandle: nameOf(st, peer), messages: threads[peer],
      })),
    });
    return;
  }

  if (req.method === 'GET' && p === 'errors') { json(res, 200, catalogueDocument()); return; }
  if (req.method === 'GET' && p === 'tokens') {
    const asId = q.get('as') ?? '';
    const t = st.tokens;
    const mine = {};
    for (const sym of Object.keys(t.meta)) {
      const b = (t.bal[sym] && t.bal[sym][asId]) || 0;
      if (b > 0) mine[sym] = b;
    }
    const myDist = t.dist.filter((d) => d.to[asId]).map((d) => ({ epoch: d.epoch, amount: d.to[asId] }));
    json(res, 200, {
      as: asId || null,
      balances: asId ? mine : null,
      claimedTbtc: asId ? !!t.claimed[asId] : null,
      myDistributions: asId ? myDist : null,
      assets: Object.keys(t.meta).map((sym) => ({ sym, name: t.meta[sym].name, supply: t.supply[sym] ?? 0, creator: t.meta[sym].creator })),
      emission: { perEpochYear1: 5000, decayPerEpochYear: 0.9, epochYear: 365, cap: 18250000, epochsClosed: t.epochN, minted: t.supply.PEER, carry: t.carry },
      note: 'PEER is minted at epoch close and distributed by engagement weight — reactions and comments on other people\'s content, damped per pair, gated on commitment rate. Tokens are value, never standing: no balance enters any score. tBTC is sandbox value with a bitcoin-shaped name; nothing here is backed by anything.',
    });
    return;
  }
  if (req.method === 'GET' && p === 'pools') {
    json(res, 200, {
      pools: Object.entries(st.pools).map(([id, pl]) => ({
        id, pair: [pl.a, pl.b], reserves: { [pl.a]: pl.resA, [pl.b]: pl.resB },
        price: { [pl.a + 'per' + pl.b]: pl.resA / pl.resB, [pl.b + 'per' + pl.a]: pl.resB / pl.resA },
        totalShares: pl.totalShares, swaps: pl.swaps,
      })),
      how: 'Constant-product pools, 0.3% fee to liquidity providers. Acts: poolCreate {symA,symB,amtA,amtB}, poolAdd {pool,amtA,amtB}, poolRemove {pool,shares}, poolSwap {pool,sell,amt,minOut?} — via POST /api/act, each costing θ like any act.',
    });
    return;
  }
  if (req.method === 'GET' && p === 'events') {
    const since = Math.max(0, Number(q.get('since')) || 0);
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
    const slice = acts.slice(since, since + limit);
    json(res, 200, {
      since, cursor: Math.min(since + slice.length, acts.length), more: since + slice.length < acts.length,
      events: slice.map((a, i) => {
        const who = a.author ?? a.from ?? a.id ?? null;
        const say = {
          post: 'published a post', review: 'commented', opinion: 'reacted', tag: 'tagged',
          dm: 'sent a message', call: 'made a call', register: 'joined', burn: 'burned reserve for energy',
          burnL0: 'burned credits into attestation', deposit: 'deposited reserve', redeem: 'redeemed credits',
          transferL0: 'transferred credits', setPin: 'secured their handle', editPost: 'edited a post',
          deletePost: 'deleted a post', deleteAccount: 'deleted their account',
          closeEpoch: 'the epoch closed', closeCycle: 'the economic cycle closed', seedWorld: 'the world was seeded',
        }[a.t] || a.t;
        // The node this act minted, or (for a revision) the node it wrote to.
        // Asked for by an API client whose replies went to a self-derived id
        // that did not exist: with this field there is nothing left to derive.
        const idx = since + i;
        const node = st.actContent[idx]
          ?? (a.t === 'post' && Number.isInteger(a.target) ? st.actContent[a.target] : null)
          ?? (a.t === 'review' && Number.isInteger(a.upd) ? st.actContent[a.upd] : null);
        return {
          at: idx, kind: a.t,
          who, whoHandle: who ? nameOf(st, who) : null,
          what: say,
          text: a.redacted ? null : (a.text ?? null),
          target: a.target ?? null,
          node: node ?? null,
        };
      }),
    });
    return;
  }

  // ── writes ───────────────────────────────────────────────────────────────
  if (req.method !== 'POST') { json(res, 404, { error: 'no such endpoint: ' + req.method + ' /api/v1/' + p + ' — GET /api/v1 lists them all' }); return; }
  if (!actLimiter(ip)) { json(res, 429, { error: 'slow down — the network accepts at most ' + ACT_RATE + ' acts per minute from one place', code: 'RATE_LIMIT' }); return; }
  if (mirrorRefuse(res)) return;

  const body = await readBody(req, MAX_ACT_BYTES * 2);
  if (!body) { json(res, 400, { error: 'invalid JSON body' }); return; }
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const me = typeof body.as === 'string' ? body.as : '';

  const submit = (raw) => {
    const out = applyAct(sanitize(raw), pin, ip);
    if (out.error) { json(res, out.code, { error: out.error, code: out.errorCode }); return; }
    const l = st.ledgerById[me];
    json(res, 200, {
      ok: true, actIndex: out.index, cursor: acts.length,
      energyBefore: l ? l.burnBal : null,
      note: 'This cost θ. GET /api/v1/whoami?as=' + me + ' for your new balance.',
    });
  };

  if (p === 'register') {
    const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
    if (!handle) { json(res, 400, { error: 'handle is required' }); return; }
    const id = 'u_' + handle.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (id === 'u_') { json(res, 400, { error: 'handle must contain letters or digits' }); return; }
    if (!registerLimiter(ip)) { json(res, 429, { error: 'registration limit reached — this host takes ' + REGISTER_RATE + ' per hour from one address', code: 'RATE_LIMIT' }); return; }
    const raw = { t: 'register', id, handle, seed: 1, epoch: st.epochNow };
    if (body.pin) {
      if (String(body.pin).length < 4) { json(res, 400, { error: 'pin must be at least 4 characters' }); return; }
      raw.pinHash = createHash('sha256').update(id + ':' + body.pin, 'utf8').digest('hex');
    }
    const out = applyAct(sanitize(raw), '', ip);
    if (out.error) { json(res, out.code, { error: out.error, code: out.errorCode }); return; }
    json(res, 200, {
      ok: true, id, handle, secured: !!raw.pinHash, actIndex: out.index,
      next: 'GET /api/v1/whoami?as=' + id + ' — and keep your pin, it cannot be recovered.',
      warning: raw.pinHash ? null : 'You registered without a PIN. Anyone can act as this handle, and you cannot delete or edit. Register again with a pin if that matters.',
    });
    return;
  }

  if (!me) { json(res, 400, { error: 'pass "as": your handle id, e.g. {"as":"u_yourbot","pin":"…"}' }); return; }
  if (!st.ledgerById[me]) { json(res, 404, { error: 'no such handle: ' + me + ' — POST /api/v1/register first' }); return; }

  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= -1 && v <= 1 ? v : d);

  if (p === 'post') {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim() && !body.attachment) { json(res, 400, { error: 'text or attachment is required' }); return; }
    const raw = { t: 'post', author: me, text: text.trim() || '·', a: num(body.attachment_strength, 0.8) };
    if (body.quote) raw.ref = String(body.quote);
    if (body.attachment) raw.media = [body.attachment];
    // Revising: name the post to supersede, by content id or act index. This
    // was silently DROPPED before — a caller asking to revise got a brand new
    // post and a 200, which is worse than any refusal, because they had no way
    // to find out. Unrecognised targets now say so.
    const rev = body.revise ?? body.target;
    if (rev !== undefined) {
      let idx = null;
      if (Number.isInteger(rev)) idx = rev;
      else if (typeof rev === 'string' && /^c\d+$/.test(rev)) {
        const meta = st.postMeta[rev];
        if (!meta) { json(res, 404, { error: 'no such post: ' + rev }); return; }
        idx = meta.idx;
      }
      if (idx === null) { json(res, 400, { error: 'revise must be a content id like "c167" or an act index' }); return; }
      raw.target = idx;
    }
    submit(raw); return;
  }
  if (p === 'comment') {
    if (!body.target) { json(res, 400, { error: 'target is required: the content id you are commenting on' }); return; }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { json(res, 400, { error: 'text is required' }); return; }
    submit({ t: 'review', author: me, target: String(body.target), e: num(body.enthusiasm, 0.7), f: num(body.effort, 0.8), text });
    return;
  }
  if (p === 'react') {
    if (!body.target) { json(res, 400, { error: 'target is required: a content id, or prof_<id> to vouch for a person' }); return; }
    submit({ t: 'opinion', author: me, target: String(body.target), p: num(body.polarity, 0.8), r: num(body.reaction, 0.8) });
    return;
  }
  if (p === 'tag') {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/^#/, '') : '';
    if (!body.target || !name) { json(res, 400, { error: 'target and name are required' }); return; }
    submit({ t: 'tag', author: me, target: String(body.target), name, r: num(body.relevance, 0.8), c: num(body.confidence, 0.8) });
    return;
  }
  if (p === 'message') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!body.to || !text) { json(res, 400, { error: 'to and text are required' }); return; }
    submit({ t: 'dm', from: me, to: String(body.to), text });
    return;
  }
  if (p === 'burn') {
    submit({ t: 'burn', id: me, amt: 1 });
    return;
  }

  json(res, 404, { error: 'no such endpoint: POST /api/v1/' + p + ' — GET /api/v1 lists them all' });
}

// The app now has a stable home (GitHub Pages) while the host itself lives on
// a throwaway tunnel domain, so the page and the API are different origins and
// the browser demands CORS. Opening reads to any origin costs nothing: the act
// log is public by design and already served to anyone who asks. Writes stay
// exactly as guarded as before — a PIN-secured handle still needs its PIN, the
// rate limiters still apply, and an unsecured handle was already claimable by
// anyone who knew its name. What this does NOT do is grant a browser any
// authority it did not already have.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Operator-tunable for the same reason the act rate is: a suite exercising
// every refusal path would otherwise spend its budget proving the limiter
// works. The public default is unchanged, and the figure the API reports
// reads this variable rather than a hardcoded one.
const AD_RATE = Number(process.env.PEER_AD_RATE) > 0 ? Number(process.env.PEER_AD_RATE) : 6;
const adLimiter = makeLimiter(AD_RATE, 3_600_000); // advert proposals per IP per hour
const adminLimiter = makeLimiter(20, 600_000);  // failed admin auth attempts

/**
 * Constant-time bearer check. A plain !== leaks the token one character at a
 * time to anyone patient enough to measure, which is a real attack on a
 * secret that guards bans and the ad ledger.
 */
function adminAuth(req) {
  if (!OPERATOR_TOKEN) return false;
  const h = String(req.headers['authorization'] ?? '');
  const got = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-operator-token'] ?? '');
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(OPERATOR_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function topMap(m, n) {
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => ({ key: String(k), count: v }));
}

function adminMetrics() {
  // The replay cache is built lazily, on the first request that needs derived
  // state — so on a freshly started host the panel would have reported dashes
  // for actors, content and epoch, which reads as "broken" rather than "not
  // asked yet". Force it, the same synchronous way the solvency gate does.
  if (engineMod && replayMod) {
    if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
    if (stateCache.len !== acts.length || !stateCache.st) {
      stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
    }
  }
  const st = stateCache.st;
  const secured = acts.filter((a) => a.t === 'setPin').length;
  const byType = new Map();
  for (const a of acts) byType.set(a.t, (byType.get(a.t) ?? 0) + 1);
  const day = Date.now() - 86400_000;
  const actsLastDay = acts.filter((a) => a.ts && a.ts > day).length;
  const mem = process.memoryUsage();
  return {
    host: {
      uptimeSec: Math.round((Date.now() - OPS_STARTED) / 1000),
      role: MIRROR_OF ? 'mirror' : 'primary',
      mirrorOf: MIRROR_OF || null,
      mirrorInSync: MIRROR_OF ? mirrorState.ok : null,
      node: process.version,
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapMb: +(mem.heapUsed / 1048576).toFixed(1),
    },
    network: {
      acts: acts.length,
      actsLastDay,
      actors: st ? Object.keys(st.xById).length : null,
      contentNodes: st ? Object.keys(st.payloads).length : null,
      epoch: st ? st.epochNow : null,
      deletedAccounts: deletedIds.size,
      securedHandles: secured,
      byActType: topMap(byType, 20),
      liveStreams: liveNow().length,
      signalBoxes: signalBoxes.size,
    },
    traffic: {
      requests: ops.requests,
      byStatus: topMap(ops.byStatus, 12),
      megabytesOut: +(ops.bytesOut / 1048576).toFixed(2),
      actsAccepted: ops.actsAccepted,
      actsRefused: ops.actsRefused,
      rateLimited: ops.rateLimited,
      authFailures: ops.authFailures,
      adminAuthFailures: ops.adminAuthFailures,
      peakActsPerMin: ops.peakActsPerMin,
      topRefusals: topMap(ops.refusals, 12),
      uniqueAddressesSeen: ipSeen.size,
      bans: banned.size,
    },
    storage: {
      logBytes: (() => { try { return statSync(LOG).size; } catch { return 0; } })(),
      mediaBytes: mediaDirSize(),
      mediaCapBytes: MEDIA_STORE_CAP,
    },
    ads: adStore.stats(),
    limits: { actsPerMin: ACT_RATE, readsPerMin: 600, adProposalsPerHour: AD_RATE },
  };
}

/** IP rows, newest activity first. Never served without the operator token. */
function adminIps() {
  return [...ipSeen.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, 300)
    .map(([ip, r]) => ({
      ip, first: r.first, last: r.last, reqs: r.reqs, acts: r.acts,
      refused: r.refused, limited: r.limited, agent: r.agent,
      handles: [...r.handles], banned: !!banCheck(ip),
    }));
}
function adminBans() {
  return [...banned.entries()].map(([ip, b]) => ({ ip, until: b.until, reason: b.reason }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  opsRequest(ip, req);
  // Status and size are read off the response itself, so nothing has to
  // remember to report them at each of the several dozen exit points.
  res.on('finish', () => {
    const code = res.statusCode;
    ops.byStatus.set(code, (ops.byStatus.get(code) ?? 0) + 1);
    if (code === 429) { ops.rateLimited++; ipRow(ip).limited++; }
    if (code === 401) ops.authFailures++;
    const n = Number(res.getHeader('content-length'));
    if (Number.isFinite(n)) ops.bytesOut += n;
  });
  const ban = banCheck(ip);
  if (ban) {
    // Say so rather than blackholing: a banned tester who can read the reason
    // can argue with it, and an abuser learning they are blocked is not a
    // secret worth keeping.
    json(res, 403, { code: 'BLOCKED', error: 'this address is blocked by the operator' + (ban.reason ? ': ' + ban.reason : '') + (ban.until ? ' — until ' + new Date(ban.until).toISOString() : '') });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/acts') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down — too many requests' }); return; }
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const body = JSON.stringify({ acts: acts.slice(since), total: acts.length, mirror: MIRROR_OF || null });
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
    if (mirrorRefuse(res)) return;
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
      if (size === 0 || size > cap) { json(res, 413, { error: 'media too large', code: 'TOO_LARGE' }); return; }
      if (mediaDirSize() + size > MEDIA_STORE_CAP) { json(res, 507, { error: 'media store full — test instance capacity reached', code: 'STORE_FULL' }); return; }
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
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down — the network accepts at most ' + ACT_RATE + ' acts per minute from one place', code: 'RATE_LIMIT' }); return; }
  if (mirrorRefuse(res)) return;
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
        json(res, 429, { error: 'registration limit reached — this host takes ' + REGISTER_RATE + ' per hour from one address', code: 'RATE_LIMIT' }); return;
      }
      const out = applyAct(act, auth, ip);
      if (out.error) { json(res, out.code, { error: out.error, code: out.errorCode }); return; }
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
  // ── PWA assets ────────────────────────────────────────────────────────
  // Shared with the published site, which is where the app should actually be
  // installed from: a home-screen icon must point at an address that survives,
  // and this host's tunnel domain changes on every restart. Served here anyway
  // so nothing 404s and the install can be tested locally.
  if (req.method === 'GET' && (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js' || url.pathname.startsWith('/icons/'))) {
    const SITE = resolve(here, '../site');
    const rel = url.pathname.replace(/^\//, '');
    if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    try {
      if (url.pathname === '/manifest.webmanifest') {
        // The published copy uses relative paths under /peer-network-lab/;
        // served from this host the app lives at the root instead. Everything
        // URL-shaped has to be rewritten together — an id or shortcut left
        // relative to app.html would point at a page this origin does not have.
        const m = JSON.parse(readFileSync(join(SITE, 'manifest.webmanifest'), 'utf8'));
        m.start_url = '/';
        m.scope = '/';
        m.id = '/';
        if (Array.isArray(m.shortcuts)) {
          for (const s of m.shortcuts) s.url = s.url.replace(/^\.\/app\.html/, '/');
        }
        json(res, 200, m);
        return;
      }
      const buf = readFileSync(join(SITE, rel));
      const type = rel.endsWith('.png') ? 'image/png' : 'application/javascript';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': rel.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found — run: node social/make-icons.mjs');
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/live') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    json(res, 200, { live: liveNow() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/live') {
    if (!signalLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
      const id = typeof m.as === 'string' ? m.as : '';
      if (!id || id.length > 24) { json(res, 400, { error: 'bad handle' }); return; }
      const aerr = authError({ t: 'dm', from: id, auth: typeof m.auth === 'string' ? m.auth : '' });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { error: 'too many PIN attempts — locked for a few minutes' }); return; }
        json(res, 401, { error: aerr }); return;
      }
      if (m.stop) { liveStreams.delete(id); json(res, 200, { ok: true, live: false }); return; }
      const prev = liveStreams.get(id);
      liveStreams.set(id, {
        cid: typeof m.cid === 'string' ? m.cid.slice(0, 40) : (prev && prev.cid) || null,
        title: typeof m.title === 'string' ? m.title.slice(0, 200) : (prev && prev.title) || '',
        since: prev ? prev.since : Date.now(),
        ts: Date.now(),
        viewers: Number.isInteger(m.viewers) && m.viewers >= 0 ? Math.min(m.viewers, 9999) : 0,
      });
      json(res, 200, { ok: true, live: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/view') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
      const ids = Array.isArray(m.ids) ? m.ids.slice(0, 60) : [];
      // Only count ids that name real, readable content. Without this any
      // caller could inflate a counter for c9999999 and litter the map with
      // things that do not exist. The replayed state is already cached.
      const st = stateCache.st;
      let added = 0;
      for (const cid of ids) {
        if (typeof cid !== 'string' || !/^c\d+$/.test(cid)) continue;
        if (st && st.payloads[cid] === undefined) continue;
        if (countView(cid, ip)) added++;
      }
      json(res, 200, { counted: added, views: Object.fromEntries(viewCounts) });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/views') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    json(res, 200, {
      views: Object.fromEntries(viewCounts),
      note: 'Host-side telemetry, not protocol. Views never enter the act log, the graph, or any score — this network measures commitment, not attention.',
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/ice') {
    json(res, 200, {
      iceServers: ICE_SERVERS,
      relay: ICE_IS_OWN_TURN ? 'operator' : 'none',
      note: ICE_IS_OWN_TURN
        ? 'A relay is configured. Media stays end-to-end encrypted; the relay forwards packets it cannot read, but it does carry them and sees who is talking to whom.'
        : 'No relay configured. Calls work only where the two networks can reach each other directly, which fails when both ends are behind carrier-grade NAT — common on mobile networks and between some countries. Fix: run the host with PEER_TURN_URL, PEER_TURN_USER and PEER_TURN_PASS.',
    });
    return;
  }
  if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
    handleBotApi(req, res, url, ip);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const doc = pageDoc();
      // The page is a quarter of a megabyte of inlined engine and app source,
      // and it was going out raw on every single load — over a tunnel, on
      // phones. Gzip cuts it by roughly four fifths, and an ETag means a
      // reload that changes nothing costs one 304 instead of the whole page.
      const inm = req.headers['if-none-match'];
      if (inm && inm === doc.etag) {
        res.writeHead(304, { ETag: doc.etag, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
        res.end();
        return;
      }
      const head = {
        'Content-Type': 'text/html; charset=utf-8',
        // no-cache, not no-store: revalidate every load, but allow the 304.
        'Cache-Control': 'no-cache',
        ETag: doc.etag,
        Vary: 'Accept-Encoding',
        ...SECURITY_HEADERS,
      };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
        res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': doc.gz.length });
        res.end(doc.gz);
      } else {
        res.writeHead(200, { ...head, 'Content-Length': Buffer.byteLength(doc.html) });
        res.end(doc.html);
      }
    } catch {
      res.writeHead(500); res.end('build missing — run: npm run build:social');
    }
    return;
  }
  // ── Account security: challenges and passkeys ───────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/challenge') {
    if (!signalLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    readBody(req, 1024).then((body) => {
      const as = typeof body?.as === 'string' ? body.as : '';
      if (!as) { json(res, 400, { error: 'as is required' }); return; }
      // Issued for anyone who asks, deliberately: refusing unknown handles
      // here would turn this endpoint into a way to enumerate who exists.
      json(res, 200, {
        challenge: issueChallenge(as),
        rpId: RP_ID || url.hostname,
        credentials: (keyIndex.get(as) ?? []).map((k) => ({ id: k.credId, label: k.label })),
        expiresInSec: CHALLENGE_TTL / 1000,
      });
    }).catch(() => json(res, 400, { error: 'invalid body' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey') {
    if (mirrorRefuse(res)) return;
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down' }); return; }
    readBody(req, 16384).then((body) => {
      const as = typeof body?.as === 'string' ? body.as : '';
      if (!as || !acts.some((a) => a.t === 'register' && a.id === as)) { json(res, 404, { error: 'unknown handle' }); return; }
      // Adding a passkey is a change of who can act as this handle, so it has
      // to be authorised by whoever can act as it NOW. Without this, anyone
      // could bolt their own key onto someone else's account — the same class
      // of hole as the handle that could be worn by anyone.
      const already = pinIndex.get(as);
      const aerr = authError({ t: 'setKey', id: as, auth: body.auth });
      if (already && aerr) { json(res, 401, { error: aerr }); return; }
      if (!already && hasHistory(as)) {
        json(res, 401, { error: 'this handle has already acted and has no PIN, so a key cannot be attached from outside — that is exactly how someone would take it. Ask the operator.' });
        return;
      }
      if (!takeChallenge(body.challenge, as)) { json(res, 400, { error: 'that challenge has expired or was already used' }); return; }
      const parsed = readRegistration(body.response ?? {}, {
        challenge: body.challenge,
        origin: RP_ORIGIN || null,
        rpId: RP_ID || url.hostname,
      });
      if (parsed.error) { json(res, 400, { error: parsed.error }); return; }
      const out = applyAct({
        t: 'setKey', id: as, credId: parsed.credId, cose: parsed.cose,
        signCount: parsed.signCount, label: String(body.label ?? 'passkey').slice(0, 40),
      }, body.auth ?? '', ip);
      if (out.error) { json(res, out.code ?? 400, { error: out.error }); return; }
      json(res, 200, {
        ok: true, credId: parsed.credId,
        note: 'This passkey can now act for ' + as + '. It cannot be guessed, cannot be cracked from the log, and will not sign for a page pretending to be this site.',
      });
    }).catch(() => json(res, 400, { error: 'invalid body' }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    const as = url.searchParams.get('as') ?? '';
    const stored = pinIndex.get(as);
    json(res, 200, {
      as,
      hasPin: !!stored,
      pinStorage: stored ? (stored.startsWith('pbkdf2$') ? 'slow (pbkdf2)' : 'legacy fast hash — upgraded automatically the next time you sign in') : null,
      passkeys: (keyIndex.get(as) ?? []).map((k) => ({ id: k.credId, label: k.label })),
      advice: 'A PIN is a shared secret whose hash is in the public log; a passkey is not. Add a passkey if your device offers one.',
    });
    return;
  }

  // ── Paid placements: public surface ─────────────────────────────────────
  if (url.pathname === '/api/ads') {
    if (req.method === 'GET') {
      json(res, 200, {
        ads: adStore.live(),
        accepting: !!BTC_ADDRESS,
        priceSatsPerDay: adStore.stats().priceSatsPerDay,
        howItWorks: 'POST here with {text, url, days, contact} to propose one. An operator reads it, then quotes you a bitcoin amount unique to your advert so the payment can be matched to it. Nothing goes live before it is both approved and paid.',
        whatItIsNot: 'A paid placement is not an act. It mints nothing, holds no standing, sits outside the graph and changes no feed score. Money buys this box and nothing else in the network.',
      });
      return;
    }
    if (req.method === 'POST') {
      if (mirrorRefuse(res)) return;
      if (!adLimiter(ip)) { json(res, 429, { error: 'slow down — this host takes at most ' + AD_RATE + ' advert proposals per hour from one address' }); return; }
      readBody(req, 8192).then((body) => {
        if (!body) { json(res, 400, { error: 'invalid JSON body' }); return; }
        const out = adStore.submit(body, BTC_ADDRESS);
        if (out.error) { json(res, 400, { error: out.error }); return; }
        const a = out.ad;
        json(res, 200, {
          ok: true, id: a.id, status: a.status,
          payTo: a.address,
          amountSats: a.priceSats,
          amountBtc: (a.priceSats / 1e8).toFixed(8),
          important: 'Do not pay yet. Wait until GET /api/ads/' + a.id + ' reports status "approved" — an operator reads every advert first, and a rejected one is not refunded automatically because nothing was ever sent.',
          whyThisAmount: 'The amount is unique to your advert, which is how a payment to a single address is matched back to it. Send exactly this, not a rounded figure.',
        });
      }).catch(() => json(res, 400, { error: 'invalid body' }));
      return;
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/ads/')) {
    const a = adStore.get(url.pathname.slice('/api/ads/'.length));
    if (!a) { json(res, 404, { error: 'no advert with that id' }); return; }
    json(res, 200, {
      id: a.id, status: a.status, text: a.text, url: a.url, days: a.days,
      payTo: a.status === 'approved' ? a.address : null,
      amountSats: a.status === 'approved' ? a.priceSats : null,
      startsAt: a.startsAt, endsAt: a.endsAt,
      reviewNote: a.reviewNote || null,
      next: a.status === 'pending' ? 'waiting for an operator to read it'
        : a.status === 'approved' ? 'send exactly ' + a.priceSats + ' sats to the address above; it goes live once the operator confirms the payment'
        : a.status === 'rejected' ? 'not accepted' + (a.reviewNote ? ': ' + a.reviewNote : '')
        : a.status === 'live' ? 'running' : a.status,
    });
    return;
  }

  // ── Admin ───────────────────────────────────────────────────────────────
  if (url.pathname === '/admin' || url.pathname.startsWith('/api/admin/')) {
    // Closed, not open, when unconfigured. An admin surface that answers
    // because nobody set a token is the same defect as an economy only the
    // client believes in: a rule the interface implies and the code does not
    // apply. Without a token there is no door here at all.
    if (!OPERATOR_TOKEN) {
      json(res, 404, { error: 'no admin on this host — the operator set no PEER_OPERATOR_TOKEN, so there is nothing to log in to' });
      return;
    }
    if (url.pathname === '/admin' && req.method === 'GET') {
      try {
        const page = readFileSync(resolve(here, 'social/admin.html'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          ...SECURITY_HEADERS,
        });
        res.end(page);
      } catch {
        res.writeHead(500); res.end('admin page missing');
      }
      return;
    }
    if (!adminAuth(req)) {
      ops.adminAuthFailures++;
      if (!adminLimiter(ip)) { json(res, 429, { error: 'too many admin attempts' }); return; }
      json(res, 401, { error: 'operator token required' });
      return;
    }
    const p2 = url.pathname.slice('/api/admin/'.length);

    if (req.method === 'GET' && p2 === 'metrics') {
      // The engine bundle is imported lazily and asynchronously, so on a
      // freshly started host it is not loaded yet and every derived figure
      // would come back null — which reads as "broken", not "not asked yet".
      // Wait for it once; a missing bundle still answers, with nulls and the
      // rest of the metrics intact.
      worldState().then(() => json(res, 200, adminMetrics()), () => json(res, 200, adminMetrics()));
      return;
    }
    if (req.method === 'GET' && p2 === 'ips') { json(res, 200, { ips: adminIps(), banned: adminBans() }); return; }
    if (req.method === 'GET' && p2 === 'ads') { json(res, 200, { ads: adStore.all(), awaiting: adStore.awaiting(), address: BTC_ADDRESS || null, accepting: !!BTC_ADDRESS, addressRejected: !!BTC_ADDRESS_RAW && !BTC_ADDRESS }); return; }
    if (req.method === 'GET' && p2 === 'log') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('tail')) || 50));
      json(res, 200, { total: acts.length, acts: acts.slice(-n) });
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 4096).then((body) => {
        if (!body) { json(res, 400, { error: 'invalid JSON body' }); return; }
        if (p2 === 'ban') {
          const target = String(body.ip ?? '').trim();
          if (!target) { json(res, 400, { error: 'ip is required' }); return; }
          const mins = Math.min(43200, Math.max(1, Number(body.minutes) || 60));
          banned.set(target, { until: Date.now() + mins * 60_000, reason: String(body.reason ?? '').slice(0, 120) });
          json(res, 200, { ok: true, ip: target, minutes: mins });
          return;
        }
        if (p2 === 'unban') {
          const target = String(body.ip ?? '').trim();
          banned.delete(target);
          json(res, 200, { ok: true, ip: target });
          return;
        }
        if (p2 === 'ads') {
          const out = adStore.review(String(body.id ?? ''), String(body.action ?? ''), body.note);
          if (out.error) { json(res, 400, { error: out.error }); return; }
          json(res, 200, { ok: true, ad: out.ad });
          return;
        }
        if (p2 === 'gc') { gcMedia(); json(res, 200, { ok: true, mediaBytes: mediaDirSize() }); return; }
        json(res, 404, { error: 'no such admin endpoint: ' + p2 });
      }).catch(() => json(res, 400, { error: 'invalid body' }));
      return;
    }
    json(res, 404, { error: 'no such admin endpoint: ' + p2 });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`peer host on http://localhost:${PORT} — ${acts.length} act(s) loaded`
    + (MIRROR_OF ? ` — read-only mirror of ${MIRROR_OF}` : ''));
  if (MIRROR_OF) { mirrorSync(); setInterval(mirrorSync, MIRROR_INTERVAL); }
});

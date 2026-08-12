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
import { createHub, acceptUpgrade, isWebSocketUpgrade } from './stream.mjs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { activeAuthors, pickWriter, strictlyLonger } from './chain/election.mjs';
import { commonPrefixLen, forkChainMergeable } from './chain/reconcile.mjs';
import { loadOrCreateProducerKey } from './chain/keys.mjs';
import { earningsTree, cleanAddress } from './chain/earnings.mjs';

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

const ACT_KINDS = new Set(['register', 'burn', 'btcBurn', 'resetTokens', 'post', 'opinion', 'review', 'tag', 'closeEpoch',
  'deposit', 'burnL0', 'redeem', 'transferL0', 'closeCycle', 'setPin', 'dm',
  'editPost', 'deletePost', 'deleteAccount', 'call', 'stream',
  'btcClaim', 'assetCreate', 'tokenSend', 'poolCreate', 'poolAdd', 'poolRemove', 'poolSwap',
  'setKey', 'advert', 'adStop',
  'follow', 'profile', 'setRecovery',
  'event', 'invite', 'rsvp',
  // Where this handle's epoch earnings are payable on Base. See ACT_FIELDS
  // below and chain/earnings.mjs for what it binds and what it cannot.
  'bindAddress',
  // Prender Markets. `market` mints content like a post; the rest move value
  // against it and mint nothing. See MARKETS.md.
  'market', 'bet', 'modStand', 'modVote', 'attest', 'marketVoid']);
const MAX_ACT_BYTES = 4096;
const MAX_ACTS = 50000;
const EDIT_WINDOW_MS = 5 * 60 * 1000; // posts are editable for 5 minutes
// How long a jury has to certify a bet once its answer became knowable. After
// this, anyone may call time and every stake goes back.
//
// Enforced HERE, because it is a wall-clock rule and the replay must never
// consult one — but the NUMBER comes from the replay, which publishes it so
// the screen can draw the same deadline the door will enforce. The fallback
// covers the window before the engine has finished loading.
const MKT_RESOLVE_FALLBACK = 7 * 24 * 60 * 60 * 1000;
function marketResolveMs(st) {
  return (st && st.marketLimits && st.marketLimits.resolveMs) || MKT_RESOLVE_FALLBACK;
}
// The furthest ahead a bet may close. A question that settles in 2140 is a way
// to hold other people's money indefinitely, not a market.
const MKT_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

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
  follow: ['t', 'from', 'to', 'on'],
  // fee, cur and cap MUST be listed. sanitize is a hard whitelist: an omitted
  // field is deleted and the act is accepted 200 with a free, uncapped event
  // the author believes is priced.
  event: ['t', 'author', 'text', 'at', 'place', 'fee', 'cur', 'cap'],
  invite: ['t', 'from', 'to', 'cid'],
  // The answer names what it pays and to whom, so the organiser cannot
  // reprice between the moment somebody reads the card and the moment their
  // answer lands.
  rsvp: ['t', 'from', 'cid', 'on', 'amt', 'cur', 'to'],
  // `pic` MUST be listed for the same reason fee/cur/cap are: sanitize is a
  // hard whitelist, so an omitted field is deleted and the act is accepted 200
  // — the author is told 'Profile saved' and no picture was ever stored.
  profile: ['t', 'id', 'bio', 'link', 'pic'],
  setRecovery: ['t', 'id', 'codeHash'],
  closeEpoch: ['t', 'epoch'],
  // The txid is the whole point: it is what lets a reader verify the burn
  // against the chain without believing this host. addr is recorded so a
  // later change of burn address cannot make old burns ambiguous.
  btcBurn: ['t', 'id', 'txid', 'sats', 'addr', 'ts'],
  resetTokens: ['t', 'id', 'ts'],
  deposit: ['t', 'id', 'amt'],
  burnL0: ['t', 'id', 'x'],
  redeem: ['t', 'id', 'x'],
  transferL0: ['t', 'from', 'to', 'x', 'cls'],
  closeCycle: ['t'],
  setPin: ['t', 'id', 'pinHash', 'byOperator', 'byRecovery'],
  setKey: ['t', 'id', 'credId', 'cose', 'label'],
  advert: ['t', 'author', 'text', 'url', 'days', 'placement', 'tags', 'people', 'posts', 'regions'],
  adStop: ['t', 'author', 'ad', 'operator'],
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
// ── Prender Markets ─────────────────────────────────────────────────────────
// `opts` MUST be listed, and so must every one of bond/feeBp/seats/cur, for
// the reason fee/cur/cap are listed on an event: sanitize is a hard whitelist,
// so a field left out is deleted in silence and the act is accepted 200 — the
// author would be told their bet was published and the thing on screen would
// be a different bet from the one they wrote.
// The one act that points at money outside this network. `addr` MUST be
// listed for the reason fee/cur/cap and pic are: sanitize is a hard whitelist,
// so a field left out is deleted in silence and the act is accepted 200 — the
// handle would be told its earnings were bound and the log would carry a
// binding to nothing.
ACT_FIELDS.bindAddress = ['t', 'id', 'addr'];
ACT_FIELDS.market = ['t', 'author', 'text', 'opts', 'cur', 'at', 'seats', 'bond', 'feeBp', 'mods'];
ACT_FIELDS.bet = ['t', 'author', 'cid', 'opt', 'amt'];
ACT_FIELDS.modStand = ['t', 'author', 'cid', 'on'];
ACT_FIELDS.modVote = ['t', 'author', 'cid', 'for'];
ACT_FIELDS.attest = ['t', 'author', 'cid', 'opt'];
ACT_FIELDS.marketVoid = ['t', 'author', 'cid'];

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
  // An event carries a place: where a named person will physically be, at a
  // named time. Blanking only the text would leave that behind after a delete
  // that promised to remove it.
  if (orig.place !== undefined) orig.place = '';
  // A bet's answers are payload and go with the question. The COUNT is
  // structure and stays: stakes name an answer by number, and an escrow that
  // forgot how many answers it had could not pay itself out. Blanking in
  // place, never splicing.
  if (Array.isArray(orig.opts)) orig.opts = orig.opts.map(() => '');
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
/**
 * Every blob an act points at — the ONE place that knows.
 *
 * It used to be `a.media` inlined in three files, and the moment a second kind
 * of reference existed (a profile picture) each of those three would have had
 * to be found and changed by hand. Two of them delete things: the collector
 * unlinks anything unreferenced, and the mirror pulls only what it sees here.
 * A reference this function forgets is a picture that vanishes an hour after
 * it is uploaded, and is missing from the fallback host for good.
 */
function mediaRefsOf(a) {
  const out = [];
  if (!a) return out;
  if (Array.isArray(a.media)) for (const m of a.media) if (m && m.h) out.push(m);
  if (a.t === 'profile' && typeof a.pic === 'string' && a.pic) out.push({ h: a.pic, m: 'image/jpeg' });
  return out;
}
function gcMedia() {
  const referenced = new Set();
  for (const a of acts) for (const m of mediaRefsOf(a)) referenced.add(m.h);
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
let roleFromFile = null;
try { roleFromFile = String(JSON.parse(readFileSync(roleFile, 'utf8')).mirrorOf ?? ''); } catch { /* no role file yet */ }
// The role is MUTABLE at runtime now: the writer is an office, not a machine.
// The election below promotes and demotes by rewriting role.json AND this
// object together, so every door that asks "am I a mirror?" reads the
// current answer, and a crash between the two leaves the FILE authoritative
// — which is the safe direction, because the file is what a watchdog
// restart reads.
//
// Precedence: the FILE, when it exists, outranks the environment. The env
// is frozen at launch; the election rewrites the file. A watchdog restart
// that let a stale PEER_MIRROR_OF resurrect a pre-promotion role would
// hand a promoted writer back to a mirror seat — with two hosts, that is
// the mutual-mirror deadlock (each mirroring the other, nobody writing).
// PEER_MIRROR_OF keeps working where it always did: fresh data dirs with
// no role file, which is what the tests spawn.
const role = {
  mirrorOf: (roleFromFile !== null ? roleFromFile : (process.env.PEER_MIRROR_OF ?? '')).trim().replace(/\/+$/, ''),
  // True while a freshly-started primary checks the federation for a longer
  // record before accepting its first act. This closes the oldest trap in
  // HOSTING.md: a watchdog restarting a stale primary used to recreate the
  // two-writer split; now the restart asks first.
  quarantine: false,
};
const isMirror = () => !!role.mirrorOf;
function writeRole(mirrorOf) {
  role.mirrorOf = (mirrorOf || '').trim().replace(/\/+$/, '');
  try { writeFileSync(roleFile, JSON.stringify({ mirrorOf: role.mirrorOf }) + '\n'); }
  catch (e) { console.error('[election] could not persist role.json: ' + e.message); }
}
const MIRROR_INTERVAL = Math.max(300, Number(process.env.PEER_MIRROR_INTERVAL) || 5000);
const mirrorState = { ok: null, busy: false, lastFull: 0, snapDay: -1 };

function mirrorRefuse(res) {
  if (role.mirrorOf) {
    json(res, 503, {
      code: 'MIRROR_READONLY',
      error: 'this host is a read-only mirror of ' + role.mirrorOf + ' — the app writes to the primary on its own while it answers. If the primary stays gone, the election promotes the best-placed mirror automatically (longest sealed chain, longest log, most active people); nothing here accepts acts meanwhile, because two writers would fork the network.',
      mirrorOf: role.mirrorOf,
    });
    return true;
  }
  if (role.quarantine) {
    json(res, 503, {
      code: 'ELECTION_PENDING',
      error: 'this host just started and is checking the federation for a longer record before accepting acts — retry in a few seconds.',
    });
    return true;
  }
  return false;
}

async function mirrorGet(path) {
  const r = await fetch(role.mirrorOf + path, { signal: AbortSignal.timeout(15_000) });
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

/**
 * Adopt the primary's log, but never DESTROY acts this host holds and the
 * primary does not. Wholesale adoption is right for a redaction (the point
 * of the full-sync path) and catastrophic for a diverged tail: a host that
 * was briefly a writer, or whose role file and memory disagreed after a
 * failed persist, would silently erase every act it accepted. Same rule as
 * demotion: the tail is written out first, and the log line says how to
 * merge it back.
 */
function mirrorAdoptSafely(remoteActs) {
  try {
    if (stateCache.R) {
      const ourFile = acts.filter((a) => a && a.t !== 'seedWorld');
      const theirFile = (remoteActs || []).filter((a) => a && a.t !== 'seedWorld');
      const P = commonPrefixLen(ourFile, theirFile, stateCache.R.parseMentions);
      if (P < ourFile.length) saveForkTail(ourFile, P, 'adopting ' + (role.mirrorOf || 'the primary') + '’s record');
    }
  } catch (e) { console.error('[mirror] divergence check failed before adopting: ' + e.message); }
  mirrorAdopt(remoteActs);
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
  // The role can change mid-flight now that it is elected: a promotion can
  // land between this fetch and its response. Applying the old primary's
  // tail AFTER this host started accepting its own acts interleaves two
  // writers inside one file — corruption, not even a clean fork. So the
  // role is captured here and re-checked after every await.
  const syncingFor = role.mirrorOf;
  const stillMine = () => role.mirrorOf === syncingFor && syncingFor !== '';
  try {
    const d = await (await mirrorGet('/api/acts?since=' + acts.length)).json();
    if (!stillMine()) return;
    let mediaRefs = [];
    const wantFull =
      d.total < acts.length ||                        // primary shrank: a rewrite happened
      d.acts.some((a) => a.t === 'deletePost' || a.t === 'deleteAccount') || // redactions touch old lines
      Date.now() - mirrorState.lastFull > 30 * 60_000; // belt and braces
    if (wantFull) {
      const full = await (await mirrorGet('/api/acts')).json();
      if (!stillMine()) return;
      mirrorAdoptSafely(full.acts);
      mirrorState.lastFull = Date.now();
      mediaRefs = full.acts.flatMap(mediaRefsOf);
    } else if (d.acts.length) {
      for (const a of d.acts) { acts.push(a); persist(a); }
      stateCache = { len: -1, st: null, R: stateCache.R };
      mediaRefs = d.acts.flatMap(mediaRefsOf);
    }
    await mirrorMedia(mediaRefs);
    // Rolling snapshots: seven files, one per weekday, overwritten in place.
    // The mirror IS the backup; these survive a bad sync of the main copy.
    const day = new Date().getDay();
    if (day !== mirrorState.snapDay) {
      try { copyFileSync(LOG, LOG + '.daily-' + day); mirrorState.snapDay = day; } catch { /* best effort */ }
    }
    if (mirrorState.ok !== true) console.log('[mirror] in sync with ' + role.mirrorOf + ' — ' + acts.length + ' acts');
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

// ── Writer election: the pen is an office, not a machine ───────────────────
//
// One writer at a time is still the law — two writers fork the log. What
// changed is WHO holds the pen: the federation elects it, deterministically,
// from numbers anyone can verify — the longest sealed chain, then the
// longest log, then the most people active in the last hour of the public
// record, then a meaningless stable tiebreak (chain/election.mjs).
//
// Four rules hold the whole thing up, and each one exists because dropping
// it produced a real failure in review or in a drill:
//
//   1. SILENCE IS NOT A MANDATE. A federated host that has heard from nobody
//      does not write. Quarantine lifts on a successful probe round, never
//      on a failed one — otherwise a watchdog restart inside a partition
//      hands the isolated side a second pen, which is the exact split this
//      feature exists to prevent.
//   2. AN INCUMBENT KEEPS THE PEN. A live writer yields only to a STRICTLY
//      longer record. Tiebreaks choose a successor for a dead writer; if
//      they could unseat a live one, two equal hosts demote into each
//      other's mirrors and nobody can write.
//   3. NEVER FOLLOW SOMEONE WHO FOLLOWS YOU. A peer that reports it mirrors
//      this host is not a writer, and a peer that is quarantined or mirrors
//      anyone is not a candidate. Without this, a restored-from-backup
//      primary and its mirror seat each other forever.
//   4. CLAIMS ARE CHECKED, NOT BELIEVED. A peer's numbers only start a
//      handover; before yielding, this host fetches the record and verifies
//      the claim — length, shared prefix, and the sealed chain — and refuses
//      when two signed histories exist. Anyone can say "I have a million
//      acts"; nobody can produce them on demand.
//
// The failure mode that remains, stated plainly: a partition can still
// elect one writer per side (CAP is not negotiable). Healing is a
// deterministic rebase plus an attributable report — chain/merge.mjs — not
// "there is no merge".
//
// Standalone hosts opt out by doing nothing: with no federation configured,
// no probe is sent, no quarantine is imposed, and behavior is exactly the
// old behavior. Federation is any of: PEER_FEDERATION (comma URLs),
// server-data/federation.json ({urls: []}), PEER_SITE_URL (the published
// site whose host.json names the current hosts), or simply being a mirror.
const ELECTION_INTERVAL = Math.max(2000, Number(process.env.PEER_ELECTION_INTERVAL) || 15_000);
const PROMOTE_AFTER = Math.max(2, Number(process.env.PEER_PROMOTE_AFTER) || 8);
const SITE_URL = (process.env.PEER_SITE_URL || '').trim().replace(/\/+$/, '');
const PEERS_FILE = resolve(DATA_DIR, 'peers.json');
// A body cap on every federation fetch. The 30s timeout bounds TIME; without
// this, a peer that answers slowly forever — or claims a gigabyte of acts —
// takes the host down through the one code path that must never fail.
const FED_MAX_BYTES = Math.max(1_000_000, Number(process.env.PEER_FED_MAX_BYTES) || 64 * 1024 * 1024);
const ROSTER_MAX = 16;
const electionState = {
  fails: 0, roster: [], rosterAt: 0, nodeId: null, lastWriter: null,
  heard: false,          // has ANY probe round ever succeeded?
  quietOnce: false,      // the "nobody answered" notice is said once, not every tick
  known: new Set(),      // peers learned across role changes; see rememberPeer
  frozen: null,          // set when two signed histories meet: needs a human
};
try {
  electionState.nodeId = loadOrCreateProducerKey(resolve(DATA_DIR, 'chain', 'producer.pem')).pub;
} catch (e) { console.error('[election] no node identity: ' + e.message); }
try {
  for (const u of JSON.parse(readFileSync(PEERS_FILE, 'utf8')).urls || []) electionState.known.add(u);
} catch { /* first run */ }

/** Peers survive role changes. A promoted mirror used to forget the primary
 *  it had just replaced — its roster emptied, it stopped probing, and the
 *  returning host wrote in parallel forever. */
function rememberPeer(url) {
  if (!url || electionState.known.has(url)) return;
  electionState.known.add(url);
  try { writeFileSync(PEERS_FILE, JSON.stringify({ urls: [...electionState.known] }) + '\n'); }
  catch { /* the in-memory set still works for this process */ }
}

/** Fetch from a peer with a hard byte ceiling. The timeout bounds TIME; a
 *  peer that answers slowly forever, or claims a gigabyte of acts, must not
 *  be able to take this host down through the one path that decides who
 *  writes. */
async function fedText(url, ms = 15_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
  const text = await r.text();
  if (text.length > FED_MAX_BYTES) throw new Error('response from ' + url + ' exceeds ' + FED_MAX_BYTES + ' bytes');
  return text;
}
const fedJson = async (url, ms = 15_000) => JSON.parse(await fedText(url, ms));
/** /api/chain serves the block file itself: one canonical block per line. */
const fedBlocks = async (url, ms = 15_000) =>
  (await fedText(url, ms)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

function chainHeadInfo() {
  try {
    const h = JSON.parse(readFileSync(resolve(DATA_DIR, 'chain', 'HEAD.json'), 'utf8'));
    return { height: Number(h.height) || 0, hash: typeof h.hash === 'string' ? h.hash : null };
  } catch { return { height: 0, hash: null }; }
}

function selfCandidate() {
  const h = chainHeadInfo();
  return {
    nodeId: electionState.nodeId, chainHeight: h.height, chainHead: h.hash,
    acts: acts.length, active: activeAuthors(acts, Date.now()), url: null, self: true,
  };
}

function rosterConfigured() {
  return !!(process.env.PEER_FEDERATION || SITE_URL || electionState.known.size
    || existsSync(resolve(DATA_DIR, 'federation.json')));
}

/**
 * Normalise a peer address to a bare origin, and decide whether it may be
 * fetched at all. Roster entries arrive from a file this host controls but
 * ALSO from a host.json fetched over the network, so a remote entry is
 * untrusted input aimed at a fetch() — the classic SSRF seam. Paths and
 * queries are stripped (a query could otherwise swallow the /api/election
 * suffix and point the probe anywhere), and private addresses are accepted
 * only from local configuration, never from a remote list.
 */
function normalizePeer(raw, { local }) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const isPrivate = host === 'localhost' || host === '::1' || /\.local$/.test(host)
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^\[?(fc|fd|fe80)/.test(host);
  if (isPrivate && !local) return null;      // a remote list may not aim this host inward
  if (u.protocol === 'http:' && !isPrivate && !local) return null;
  return u.origin;
}

async function resolveRoster() {
  if (Date.now() - electionState.rosterAt < 300_000 && electionState.roster.length) return electionState.roster;
  const urls = new Set();
  const put = (u, local) => { const o = normalizePeer(u, { local }); if (o) urls.add(o); };
  for (const u of (process.env.PEER_FEDERATION || '').split(',')) put(u, true);
  try { for (const u of JSON.parse(readFileSync(resolve(DATA_DIR, 'federation.json'), 'utf8')).urls || []) put(u, true); } catch { /* optional */ }
  for (const u of electionState.known) put(u, true);
  if (role.mirrorOf) put(role.mirrorOf, true);
  // The published site's host.json names the current hosts, and every static
  // mirror of the site carries the same file — discovery with no single home.
  // Untrusted: it is a file on the open internet, so its entries go through
  // the remote path of normalizePeer and share the same cap.
  if (SITE_URL) {
    try {
      const d = await fedJson(SITE_URL + '/host.json', 10_000);
      for (const u of (Array.isArray(d.urls) && d.urls.length ? d.urls : [d.url])) put(u, false);
    } catch { /* the static site being down changes nothing for a running federation */ }
  }
  electionState.roster = [...urls].slice(0, ROSTER_MAX);
  electionState.rosterAt = Date.now();
  return electionState.roster;
}

async function probeCandidate(url) {
  try {
    const e = await fedJson(url + '/api/election', 10_000);
    if (!e || typeof e.nodeId !== 'string') return null;
    return {
      nodeId: e.nodeId, chainHeight: Number(e.chainHeight) || 0, chainHead: e.chainHead || null,
      acts: Number(e.acts) || 0, active: Number(e.active) || 0,
      // Role, as the peer reports it. A peer that mirrors someone (in
      // particular, one that mirrors THIS host) is not a writer and must
      // never be treated as one — that is the mutual-mirror deadlock.
      primary: typeof e.primary === 'string' ? e.primary : null,
      quarantine: !!e.quarantine,
      url,
    };
  } catch { return null; }
}

/** Write this host's unsynced tail where the merge tool can find it. */
function saveForkTail(ourFile, prefixLen, why) {
  const forkFile = resolve(DATA_DIR, 'fork-' + Date.now() + '.jsonl');
  writeFileSync(forkFile, ourFile.map((a) => JSON.stringify(a)).join('\n') + '\n');
  console.log('[election] ' + (ourFile.length - prefixLen) + ' act(s) of this host are not in the record it is '
    + why + '. They are saved, not lost: ' + forkFile);
  console.log('[election] heal with: node chain/merge.mjs --base <winner acts.jsonl> --fork "' + forkFile + '" --apply  (run it where the winner’s log lives)');
  return forkFile;
}

function promoteSelf() {
  console.log('[election] PROMOTED — the writer has been unreachable for ' + electionState.fails
    + ' probe(s) and this host ranks first in the federation. Accepting acts now.'
    + ' A returning host will demote itself against this record; if it wrote past the'
    + ' split, its tail lands in a fork file and chain/merge.mjs heals it.');
  writeRole('');
  role.quarantine = false;
  electionState.fails = 0;
  mirrorState.ok = null;
  scheduleChainSeal();
}

/**
 * Hand the pen over — but only after verifying the claim that won it.
 *
 * A candidate's numbers arrive over HTTP from a machine this host does not
 * control, and they decide who may write. So they are treated as a claim to
 * be checked: fetch the record, confirm it really is longer, and confirm the
 * sealed chains are compatible. A peer that cannot produce the history it
 * advertised keeps nothing.
 */
async function demoteTo(writer, opts) {
  // Two callers, two thresholds. A SEATED writer yields only to a strictly
  // longer record (rule 2). A host still in boot quarantine has not taken
  // the pen at all, so it yields to any live writer whose record is at
  // least as long — that is the equal-record case, where both hosts hold
  // the same acts and exactly one of them is already serving.
  const atLeast = !!(opts && opts.atLeast);
  if (!stateCache.R) {
    await ensureEngine(); // lazy elsewhere; the divergence check needs it NOW
    if (engineMod && replayMod) stateCache.R = replayMod.create(engineMod);
  }
  if (!stateCache.R) throw new Error(engineErr || 'engine bundle not loaded');

  const theirs = await fedJson(writer.url + '/api/acts', 30_000);
  const theirFile = (theirs.acts || []).filter((a) => a && a.t !== 'seedWorld');
  const ourFile = acts.filter((a) => a && a.t !== 'seedWorld');
  const mine = selfCandidate();
  // The claim, checked against what was actually DELIVERED — and both sides
  // counted the same way. The host's in-memory log carries a seedWorld act
  // that never reaches the file, so comparing `acts.length` against a served
  // file length is off by one and made a legitimate handover look like a lie.
  const ours = { chainHeight: mine.chainHeight, acts: ourFile.length };
  const served = { chainHeight: writer.chainHeight, acts: theirFile.length };
  const goodEnough = atLeast ? !strictlyLonger(ours, served) : strictlyLonger(served, ours);
  if (!goodEnough) {
    console.log('[election] ' + writer.url + ' advertised ' + writer.acts + ' act(s) but served '
      + theirFile.length + ' against this host’s ' + ourFile.length + ' — ignoring the claim and keeping the pen.');
    return;
  }
  // Two signed histories are two attributable records, and code must not
  // pick between them. reconcile.mjs refuses the same case for the same
  // reason; here the host freezes read-only and names a person's decision.
  if (mine.chainHeight > 0) {
    try {
      const theirBlocks = await fedBlocks(writer.url + '/api/chain', 30_000);
      const ourBlocks = readBlocksLocal();
      if (!forkChainMergeable(theirBlocks, ourBlocks)) {
        electionState.frozen = writer.url;
        role.quarantine = true;
        console.error('[election] FROZEN: this host and ' + writer.url + ' hold DIVERGED SEALED chains —'
          + ' two signed histories, each attributable to its producer. Nothing here will write or adopt'
          + ' until a person decides. Verify both (node chain/verify.mjs), choose the record that stands,'
          + ' and merge the other side with chain/merge.mjs.');
        return;
      }
    } catch (e) {
      console.error('[election] could not check ' + writer.url + '’s chain (' + e.message + ') — keeping the pen rather than yielding blind');
      return;
    }
  }

  const P = commonPrefixLen(ourFile, theirFile, stateCache.R.parseMentions);
  if (P < ourFile.length) {
    saveForkTail(ourFile, P, 'yielding to (' + writer.url + ')');
  } else {
    console.log('[election] DEMOTED — ' + writer.url + ' holds the longer record (chain height '
      + writer.chainHeight + ', ' + theirFile.length + ' acts). Becoming its mirror; every act here is in its log.');
  }
  rememberPeer(writer.url);
  writeRole(writer.url);
  role.quarantine = false;
  // Adopt what was already fetched and verified, rather than leaving the
  // diverged tail in the live log for the next incremental sync to append
  // the winner's acts on top of — that produced a silently corrupt log with
  // every position reference off by the length of the tail.
  mirrorAdopt(theirs.acts || []);
  mirrorState.lastFull = Date.now();
  mirrorState.ok = null;
}

function readBlocksLocal() {
  try {
    return readFileSync(resolve(DATA_DIR, 'chain', 'blocks.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function electionTick() {
  if (electionState.frozen) return;   // a person decides; nothing moves meanwhile
  const roster = await resolveRoster();
  if (!roster.length) {
    // Nobody to ask. A host that never had peers is standalone and writes;
    // a host whose peers all vanished from the roster keeps whatever role it
    // holds rather than inventing a promotion.
    if (!rosterConfigured()) role.quarantine = false;
    return;
  }
  const self = selfCandidate();
  const probes = await Promise.all(roster.map(probeCandidate));
  const answered = probes.filter(Boolean);
  const peers = answered.filter((p) => p.nodeId && p.nodeId !== self.nodeId);
  for (const p of peers) rememberPeer(p.url);

  if (answered.length) electionState.heard = true;
  else if (role.quarantine) {
    // Rule 1: silence is not a mandate. Say it once, keep asking.
    if (!electionState.quietOnce) {
      console.log('[election] no peer answered — this host stays read-only rather than risk a second writer.'
        + ' It opens as soon as one answers. If the federation is genuinely gone for good, the operator'
        + ' promotes it deliberately: stop the host, delete server-data/role.json, unset PEER_FEDERATION, restart.');
      electionState.quietOnce = true;
    }
    return;
  }

  // Rule 3: a peer that mirrors anyone, or is still checking, is not a
  // writer and cannot be one.
  const eligible = peers.filter((p) => !p.primary && !p.quarantine);
  const writer = pickWriter([self, ...eligible]);
  electionState.lastWriter = writer && (writer.self ? 'self' : writer.url);

  if (isMirror()) {
    // Following the chain of "who does your primary follow" can lead back
    // here. A host mirroring ITSELF syncs from itself forever, so its own
    // liveness check always passes and it never promotes — a deadlock that
    // survives the death of every other host. Seen in the mutual-mirror
    // drill; the knot is cut by dropping the role and re-deciding from
    // scratch through the same path a fresh boot takes.
    if (answered.some((p) => p.url === role.mirrorOf && p.nodeId === self.nodeId)) {
      console.log('[election] this host was set to mirror ITSELF (' + role.mirrorOf
        + ') — dropping that role and re-deciding.');
      writeRole('');
      role.quarantine = true;
      electionState.fails = 0;
      mirrorState.ok = null;
      return;
    }
    const mine = peers.find((p) => p.url === role.mirrorOf);
    // The primary counts as alive only if it is still a WRITER. One that now
    // mirrors this host (or anyone) is not, and waiting for it forever is
    // the deadlock rule 3 exists to break. Its own act-sync succeeding is
    // the second, independent liveness signal.
    const primaryWrites = !!(mine && !mine.primary && !mine.quarantine);
    const primaryUp = primaryWrites || (mirrorState.ok === true && (!mine || !mine.primary));
    electionState.fails = primaryUp ? 0 : electionState.fails + 1;
    if (mine && mine.primary && mine.primary !== role.mirrorOf) {
      // It followed someone; follow the same writer rather than a mirror —
      // unless that someone is this host, which is the knot above seen from
      // the other side. Then the pen is ours to take, not to chase.
      const target = normalizePeer(mine.primary, { local: false }) || normalizePeer(mine.primary, { local: true });
      if (target && target !== role.mirrorOf) {
        const probe = await probeCandidate(target);
        if (probe && probe.nodeId === self.nodeId) {
          console.log('[election] ' + role.mirrorOf + ' says the writer is this host — taking the pen rather than mirroring in a circle.');
          writeRole('');
          role.quarantine = true;
          electionState.fails = 0;
          mirrorState.ok = null;
          return;
        }
        if (probe) {
          console.log('[election] ' + role.mirrorOf + ' is now a mirror of ' + target + ' — following the writer');
          rememberPeer(target);
          writeRole(target);
          mirrorState.ok = null;
          electionState.fails = 0;
          return;
        }
      }
    }
    if (electionState.fails >= PROMOTE_AFTER) {
      if (writer && writer.self) promoteSelf();
      else if (writer && writer.url && writer.url !== role.mirrorOf) {
        console.log('[election] the writer moved to ' + writer.url + ' — following it');
        rememberPeer(writer.url);
        writeRole(writer.url);
        mirrorState.ok = null;
        electionState.fails = 0;
      }
    }
    return;
  }

  // A primary. Two different questions, and conflating them cost a drill:
  // while QUARANTINED this host has not yet taken the pen, so any live
  // writer with a record at least as long keeps it (rule 1 + the equal-
  // record case). Once seated, only a strictly longer record unseats it
  // (rule 2).
  const liveWriters = eligible.filter((p) => p.acts > 0 || p.chainHeight > 0);
  if (role.quarantine) {
    const incumbent = pickWriter(liveWriters.filter((p) => !strictlyLonger(self, p)));
    if (incumbent) { await demoteTo(incumbent, { atLeast: true }); return; }
    console.log('[election] no host holds a record at least as long as this one — taking the pen with '
      + self.acts + ' act(s), chain height ' + self.chainHeight + '.');
    role.quarantine = false;
    return;
  }
  if (writer && !writer.self && writer.url && strictlyLonger(writer, self)) await demoteTo(writer);
}

let electionErrOnce = false;
function electionTickSafe() {
  electionTick().catch((e) => {
    if (!electionErrOnce) { console.error('[election] tick failed: ' + e.message + ' — retrying on the interval'); electionErrOnce = true; }
  });
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
// A post used to carry at most two files. Two is not an album, so the ceiling
// is the number of tracks a record can honestly hold: the act itself is capped
// at MAX_ACT_BYTES and a named entry serialises to ~176 bytes, which leaves
// room for sixteen alongside a full-length text. Twelve is under that with
// headroom for the caption.
const MEDIA_MAX_ENTRIES = 12;
// ...and a second ceiling in bytes, because the entry count was doing capacity
// work as a side effect. Twelve audio files at the per-file cap would be 144 MB
// — half this instance's whole store in one act. The sizes are read from the
// blobs already on disk, never from a number the client sends.
const MEDIA_MAX_ACT_BYTES = 60 * 1024 * 1024;
// An avatar is drawn at 42 CSS px at the largest. 256px square at JPEG q0.82
// measures ~21 KB; this leaves an order of magnitude of slack and still
// refuses an unresized photo outright.
const PROFILE_PIC_MAX = 256 * 1024;
// Ten a minute was set when a post carried one file. A post now carries up to
// MEDIA_MAX_ENTRIES of them, and somebody who picks twelve tracks has to be
// able to upload twelve tracks — a limiter that refuses the eleventh is not a
// defence, it is a half-published album. Capacity is guarded where it actually
// lives and is checked on every single request: the per-kind size caps and the
// 300 MB store ceiling.
const MEDIA_RATE = Math.max(MEDIA_MAX_ENTRIES + 4, Number(process.env.PEER_MEDIA_RATE) || 40);
const mediaLimiter = makeLimiter(MEDIA_RATE, 60_000);

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

// The relay itself. Video does not travel between browsers any more: it comes
// here and goes out again, because a connection to this host is the one path
// every viewer demonstrably has — see stream.mjs for what the mesh could not
// do and why WebSocket rather than a chunked response.
const streamHub = createHub();
setInterval(() => streamHub.sweep(), 5_000);

function liveNow() {
  const now = Date.now();
  const out = [];
  // Relayed broadcasts are authoritative: the push socket either exists or it
  // does not, so there is no heartbeat to miss and no stale entry to guess at.
  for (const s of streamHub.list()) {
    out.push({
      author: s.owner, cid: s.id, title: s.title, since: s.started,
      viewers: s.viewers, relay: true, formats: s.formats, can: s.can, kbps: s.kbps,
    });
  }
  // Heartbeats from the peer-to-peer version of this feature. Kept so an app
  // that has not reloaded yet still gets a sane answer instead of an error;
  // marked, because the current app cannot join one of these.
  for (const [id, s] of liveStreams) {
    if (now - s.ts > LIVE_TTL) { liveStreams.delete(id); continue; }
    if (out.some((e) => e.author === id)) continue;
    out.push({ author: id, cid: s.cid, title: s.title, since: s.since, viewers: s.viewers ?? 0, relay: false });
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
    // connect-src gains wss: because the live relay runs over a WebSocket to
  // this same host; without it the browser refuses the socket and the
  // stream fails with nothing in the network tab to explain why.
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss:; " +
    "worker-src 'self'; manifest-src 'self'; " +
    "img-src 'self' data: blob:; media-src 'self' data: blob:; base-uri 'none'; form-action 'none'",
};

function persist(act) {
  appendFileSync(LOG, JSON.stringify(act) + '\n', 'utf8');
}

/**
 * Write an act the HOST itself authored, bypassing the client door.
 *
 * A few acts must exist in the record but must never be accepted from
 * outside: a verified Bitcoin burn (a client declaring its own burn would
 * make the verification decorative) and an operator's ledger reset. `validate`
 * refuses both at the door; this is the only way they get written, and every
 * caller must have done its own checking first.
 */
function mintInternal(act) {
  acts.push(act);
  persist(act);
  return act;
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
// id -> stored hash of a recovery CODE. A code is 128 random bits, so unlike
// an email address it cannot be guessed from a dictionary and a hash of one
// is genuinely a secret. That is the whole reason recovery here is a code and
// not an address.
const recoveryIndex = new Map();
// Actors who have just proven a recovery code. Single use, in memory, and
// spent by the very next setPin — it is a grant, not a session.
const recoveryGrant = new Set();
// Accounts whose stored hash was proven correct this request but is still in a
// crackable legacy format. Filled by authError, flushed once the act is
// accepted — never on a failed attempt, or a wrong guess would rewrite the log.
const pinUpgrades = new Map();
for (const a of acts) {
  if ((a.t === 'register' || a.t === 'setPin') && a.pinHash) pinIndex.set(a.id, a.pinHash);
  if (a.t === 'setRecovery' && a.codeHash) recoveryIndex.set(a.id, a.codeHash);
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
// 'bindAddress' belongs here and it is the sharpest case in the set. Whoever
// binds an address to a handle collects that handle's epoch earnings from then
// on, and an unsecured handle is claimable by anyone who knows its id — so
// "no PIN on file" must mean REFUSED here, or a stranger could point somebody
// else's earnings at their own wallet with a single request. Rebinding is
// allowed, but only ever by whoever can already act as the handle, and it
// cannot reach an epoch whose root is already published.
const PIN_REQUIRED = new Set(['editPost', 'deletePost', 'deleteAccount', 'bindAddress']);

/** Has this handle done anything beyond existing? Used to decide whether a
 *  first PIN is someone securing their own new handle, or a stranger claiming
 *  an established one. */
// 'event' belongs here: a handle whose only acts are events has spoken, and
// without this a stranger could still claim it as though it never had.
const SUBSTANTIVE = new Set(['post', 'review', 'opinion', 'tag', 'dm', 'stream', 'call', 'event', 'market']);
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
// ── Proof of burn ──────────────────────────────────────────────────────────
//
// The dead address. Not a wallet: a P2WSH output committing to the script
// OP_RETURN, which fails the instant it executes, so no witness can ever
// spend it. That is the difference between "nobody knows the key" and "there
// is no key" — the first is a rumour, the second is arithmetic. Derivation
// (reproduce it yourself): scriptPubKey = OP_0 PUSH32 sha256(0x6a), address =
// bech32('bc', 0, that hash). Verified against the BIP-173/350 vectors and
// two independent explorers, which also show the address has received coins
// and never once spent any.
//
// It is configuration, not a constant, because an operator running their own
// copy must be able to point somewhere they derived themselves rather than
// trust a string that arrived in someone else's source file.
const BURN_ADDRESS_DEFAULT = 'bc1qrz05qq6tu7senu06nzgkdrhr4dsyn7pd8rrghec0t9h2ktsc27msqvznj2';
const BURN_ADDRESS_RAW = (process.env.PEER_BURN_ADDRESS ?? '').trim();
let BURN_ADDRESS = '';
// Proof of burn is OFF unless an operator switches it on. A network that
// starts asking strangers for real money because a default said so would be
// the worst possible default.
if (BURN_ADDRESS_RAW) {
  if (validBtcAddress(BURN_ADDRESS_RAW)) BURN_ADDRESS = BURN_ADDRESS_RAW;
  else console.error('[burn] PEER_BURN_ADDRESS failed its checksum — proof of burn is OFF.');
}
// How many confirmations before a burn counts. Unconfirmed transactions can
// be replaced; a burn that could be un-burned is not a burn.
const BURN_MIN_CONF = Math.max(1, Number(process.env.PEER_BURN_MIN_CONF) || 2);
// The two explorers, as configuration. They were hard-coded, which meant the
// verification path could only ever be exercised against the real internet —
// so the one piece of code that decides whether money was destroyed was the
// one piece no test could reach.
// De-duplicated, because the check below counts sources and a list that says
// the same explorer twice would satisfy "two independent explorers agree" by
// agreeing with itself.
const BURN_EXPLORERS = [...new Set((process.env.PEER_BURN_EXPLORERS
  ?? 'https://blockstream.info/api,https://mempool.space/api')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean))];

/**
 * Verify that a transaction really destroyed value, by asking two independent
 * public explorers and requiring them to agree.
 *
 * Trusting one explorer would put this host's economy inside somebody else's
 * API. Requiring agreement means a single wrong or hostile answer produces a
 * refusal rather than minted weight — and a refusal is recoverable, whereas a
 * credited burn that never happened is a lie the log would carry forever.
 *
 * Nothing here is taken on faith by readers either: the txid goes into the
 * act, so anyone can repeat this check against any explorer they like, or
 * against their own node.
 */
async function verifyBurnTx(txid) {
  if (BURN_EXPLORERS.length < 2) {
    return { ok: false, why: 'this host has fewer than two block explorers configured, and one explorer is not a check — nothing was recorded' };
  }
  const sources = BURN_EXPLORERS.map((b) => b + '/tx/' + txid);
  const seen = [];
  for (const u of sources) {
    let r;
    try {
      r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    } catch {
      return { ok: false, why: 'could not reach a block explorer to check that transaction — try again shortly' };
    }
    if (r.status === 404) return { ok: false, why: 'no such transaction on the Bitcoin chain' };
    if (!r.ok) return { ok: false, why: 'a block explorer answered ' + r.status + ' — nothing was recorded' };
    let tx;
    try { tx = await r.json(); } catch { return { ok: false, why: 'a block explorer returned something unreadable' }; }
    // Sum every output paying the dead address: one transaction may burn
    // across several outputs, and counting only the first would under-credit.
    let sats = 0;
    for (const o of (tx.vout || [])) {
      if (o && o.scriptpubkey_address === BURN_ADDRESS) sats += Number(o.value) || 0;
    }
    const confirmed = !!(tx.status && tx.status.confirmed);
    const height = tx.status && tx.status.block_height ? Number(tx.status.block_height) : null;
    seen.push({ sats, confirmed, height });
  }
  // Agreement, field by field. Explorers at slightly different tips are
  // normal; disagreeing about what a transaction PAID is not.
  if (seen[0].sats !== seen[1].sats) {
    return { ok: false, why: 'the explorers disagree about what that transaction paid — refusing to record it' };
  }
  if (seen[0].sats <= 0) {
    return { ok: false, why: 'that transaction pays nothing to the dead address ' + BURN_ADDRESS };
  }
  if (!seen[0].confirmed || !seen[1].confirmed) {
    return { ok: false, why: 'that transaction is not confirmed yet — an unconfirmed burn can still be replaced, so it does not count until it is mined' };
  }
  // Depth, not merely "mined". /api/burn has always announced two
  // confirmations and this function only ever checked for one, so the number
  // in the documentation was a wish. A one-deep block is exactly the block a
  // reorg takes back, which is the whole reason the threshold exists.
  if (BURN_MIN_CONF > 1) {
    // Which block, settled the same way as what it paid: by agreement. The
    // first version read the height from source 0 alone and skipped the check
    // entirely when that field was missing — so one explorer, or one absent
    // field, could hand back the depth threshold that two explorers exist to
    // make unfalsifiable.
    if (!seen[0].height || !seen[1].height) {
      return { ok: false, why: 'an explorer called that transaction confirmed without saying which block it is in — refusing to count confirmations on that' };
    }
    if (seen[0].height !== seen[1].height) {
      return { ok: false, why: 'the explorers disagree about which block that transaction is in — refusing to record it' };
    }
    const tip = await chainTip();
    if (tip == null) {
      return { ok: false, why: 'could not read the chain tip to count confirmations — try again shortly' };
    }
    const depth = tip - seen[0].height + 1;
    if (depth < BURN_MIN_CONF) {
      return { ok: false, why: 'that transaction is ' + depth + ' block' + (depth === 1 ? '' : 's')
        + ' deep and this host waits for ' + BURN_MIN_CONF + ' — a burn that a reorg could take back is not a burn yet' };
    }
  }
  return { ok: true, sats: seen[0].sats, height: seen[0].height };
}

/**
 * The current block height — the LOWEST that at least two explorers report.
 *
 * Taking the first answer would have left the depth threshold resting on one
 * source: a tip inflated by ten blocks makes a one-deep burn look buried, and
 * the whole point of counting confirmations is that it cannot be talked into
 * a wrong answer by one party. The minimum is the conservative direction — a
 * lagging explorer can only ever make this host wait longer.
 */
async function chainTip() {
  const heights = [];
  for (const b of BURN_EXPLORERS) {
    try {
      const r = await fetch(b + '/blocks/tip/height', { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const n = Number((await r.text()).trim());
      if (Number.isFinite(n) && n > 0) heights.push(n);
    } catch { /* try the next one */ }
  }
  return heights.length >= 2 ? Math.min(...heights) : null;
}

// ── The watcher ────────────────────────────────────────────────────────────
//
// Burning was two steps and only the first one was real. The coins left the
// wallet the moment the wallet signed; the reserve appeared only if a browser
// tab stayed open long enough to poll for confirmations and file the claim.
// Close the laptop, lose the tunnel, sign from MetaMask's own screen — the
// bitcoin was destroyed and the network never heard about it. Two real burns
// sat on the address unclaimed for four days, which is how this got written.
//
// So the host watches the address itself. What it cannot do is guess WHOSE a
// payment is: an output pays a script, not a handle, and there is nothing in
// a Bitcoin transaction that says "ender". That is what an intent is for —
// the handle says, with its PIN, "a burn of N satoshi, from this address, is
// mine", and the watcher credits the matching transaction whenever it lands,
// with nobody watching. An intent is filed BEFORE the send by the app, or
// afterwards for a burn already on the chain; both work, because the intent
// is a statement about a payment, not a permission to make one.
//
// What the watcher will never do is credit a transaction that matches no
// intent. Four of the six burns at that address were made by strangers before
// this network existed. They stay exactly where they are.
const INTENTS = resolve(DATA_DIR, 'burn-intents.json');
// How far back an intent may reach for a burn already on the chain. A week
// covers "I sent it, then the tab died, then it was the weekend".
const BURN_LOOKBACK_MS = Math.max(1, Number(process.env.PEER_BURN_LOOKBACK_HOURS) || 168) * 3600_000;
// How long an unmatched intent stays open. Without a limit, an intent for
// 2000 sat filed today would silently adopt an unrelated 2000-sat burn made
// next month.
const BURN_INTENT_TTL_MS = Math.max(1, Number(process.env.PEER_BURN_INTENT_TTL_HOURS) || 48) * 3600_000;
const BURN_WATCH_MS = Math.max(15_000, Number(process.env.PEER_BURN_WATCH_INTERVAL) || 90_000);

let intents = [];
try { intents = JSON.parse(readFileSync(INTENTS, 'utf8')); } catch { intents = []; }
if (!Array.isArray(intents)) intents = [];
function saveIntents() {
  try { writeFileSync(INTENTS, JSON.stringify(intents, null, 2), 'utf8'); }
  catch (e) { console.error('[burn] could not persist burn-intents.json: ' + e.message); }
}
/**
 * Does this handle exist?
 *
 * Through the replay when the engine bundle is loaded, and through the log
 * itself when it is not. The burn doors used to ask `engineMod && replayMod`
 * and skip the question entirely when the answer was no — which is every
 * request before something else has warmed the engine. A burn credited to a
 * handle nobody registered is a burn nobody can ever spend.
 */
function handleExists(id) {
  if (engineMod && replayMod) {
    if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
    if (stateCache.len !== acts.length || !stateCache.st) {
      stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
    }
    return !!stateCache.st.ledgerById[id];
  }
  // isRegistered, not a hand-rolled scan for a register act: the four seed
  // actors exist through acts[0] = {t:'seedWorld'} and have no register act of
  // their own, so a scan refuses their burns while the replay accepts them —
  // the same door answering differently depending on whether the engine
  // bundle happened to be warm.
  return isRegistered(id);
}

/** Every txid already in the log. The log is the authority on what is paid. */
function claimedTxids() {
  const s = new Set();
  for (const a of acts) if (a && a.t === 'btcBurn' && a.txid) s.add(a.txid);
  return s;
}

/**
 * Every transaction that has paid the dead address, with the addresses that
 * paid it — the one fact that ties a burn to a wallet the sender controls.
 *
 * One explorer is enough HERE, because this only proposes candidates:
 * verifyBurnTx re-checks the winner against both before a satoshi is
 * credited. A lying explorer can therefore waste a request and nothing else.
 */
const burnTxCache = { at: 0, list: null, inflight: null };
const BURN_TX_CACHE_MS = Math.max(0, Number(process.env.PEER_BURN_TX_CACHE_MS ?? 20_000));

/**
 * The candidate list for READERS. GET /api/burn/pending is public and calls
 * this on every request, so without a memo one anonymous caller in a loop
 * turns this host into a request amplifier pointed at somebody else's
 * explorer — and that explorer's rate limit, once hit, stops burns being
 * credited for everyone. In-flight requests are coalesced too, or a burst
 * arriving in the same second all miss the cache together.
 *
 * The watcher does NOT read this. Showing somebody a list that is twenty
 * seconds old costs nothing; deciding who owns a burn from one is a different
 * thing entirely, and the tick pays for a fresh answer every time.
 */
async function burnAddressTxs() {
  const now = Date.now();
  if (burnTxCache.list && now - burnTxCache.at < BURN_TX_CACHE_MS) return burnTxCache.list;
  if (burnTxCache.inflight) return burnTxCache.inflight;
  burnTxCache.inflight = burnAddressTxsFresh().then((list) => {
    if (list) { burnTxCache.list = list; burnTxCache.at = Date.now(); }
    burnTxCache.inflight = null;
    return list;
  }, (e) => { burnTxCache.inflight = null; throw e; });
  return burnTxCache.inflight;
}

async function burnAddressTxsFresh() {
  for (const b of BURN_EXPLORERS) {
    let txs;
    try {
      const r = await fetch(b + '/address/' + BURN_ADDRESS + '/txs', { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      txs = await r.json();
    } catch { continue; }
    if (!Array.isArray(txs)) continue;
    return txs.map((t) => {
      let sats = 0;
      for (const o of (t.vout || [])) {
        if (o && o.scriptpubkey_address === BURN_ADDRESS) sats += Number(o.value) || 0;
      }
      const from = [];
      for (const i of (t.vin || [])) {
        const a = i && i.prevout && i.prevout.scriptpubkey_address;
        if (a) from.push(a);
      }
      return {
        txid: String(t.txid || ''),
        sats,
        from,
        confirmed: !!(t.status && t.status.confirmed),
        // Seconds, as the explorers report it. Unconfirmed transactions have
        // no block time; they are not candidates yet anyway.
        time: (t.status && t.status.block_time ? Number(t.status.block_time) : 0) * 1000,
      };
    }).filter((t) => /^[a-f0-9]{64}$/.test(t.txid) && t.sats > 0);
  }
  return null;
}

/**
 * Which intent owns which transaction. Pure, and separated from the fetching
 * for one reason: this is the part that can be wrong in a way that credits
 * the wrong person, so it is the part a test has to be able to reach without
 * the internet.
 *
 * The thing worth understanding here: EVERY fact an intent can state is
 * public once the burn is on the chain. The txid, the amount and the paying
 * wallet are all readable by anyone with a block explorer — and this host
 * publishes them itself at /api/burn/pending. So specificity alone cannot
 * decide who a burn belongs to: a bystander can name a txid exactly, and the
 * first version let them outrank the person who had described their own burn
 * before making it.
 *
 * What a bystander cannot do is say it FIRST. An intent filed before the
 * transaction was in a block was written by somebody who knew what was coming,
 * and that is the only evidence here that copying cannot manufacture. So it
 * dominates: foreknowledge first, specificity second.
 *
 *   SPECIFICITY (what the transaction confirms about what the intent said)
 *     3  the wallet AND the amount, both named in advance and both right
 *     2  the transaction named by txid · or the wallet with no amount claimed
 *        · or the amount with no wallet claimed
 *     1  the wallet is right and the amount named with it is not — last
 *        resort, for a transaction nothing else describes
 *   FOREKNOWLEDGE
 *     +10 the intent predates the block this transaction is in
 *
 * A pair matching none of these is not a match. Every burn already in the log
 * is out of the running, and one transaction can satisfy only one intent.
 *
 * A burn already confirmed before anyone spoke for it is therefore first-come
 * among equals — which is exactly what POST /api/burn/claim has always been,
 * and is stated plainly at /api/burn/pending rather than dressed up.
 */
function matchBurns(open, candidates, claimed) {
  const pairs = [];
  for (const it of open) {
    for (const tx of candidates) {
      if (claimed.has(tx.txid) || !tx.confirmed) continue;
      let spec = 0;
      if (it.wantTxid) {
        // Naming the transaction says WHICH burn, never WHOSE. No window is
        // applied — a txid is unambiguous — but it ranks with the other
        // single facts, not above them.
        if (it.wantTxid === tx.txid) spec = 2;
      } else {
        if (tx.time < it.ts - BURN_LOOKBACK_MS || tx.time > it.ts + BURN_INTENT_TTL_MS) continue;
        const byFrom = !!it.from && tx.from.includes(it.from);
        const byAmt = !!it.sats && tx.sats === it.sats;
        // The both-named case used to fall to 0 when only the amount matched,
        // so naming your wallet as well as your amount could score BELOW
        // naming the amount alone — more evidence making a match strictly
        // worse. It falls back to the amount-only rank instead.
        if (it.from && it.sats) spec = (byFrom && byAmt) ? 3 : (byAmt ? 2 : (byFrom ? 1 : 0));
        else if (it.from) spec = byFrom ? 2 : 0;
        else if (it.sats) spec = byAmt ? 2 : 0;
      }
      if (!spec) continue;
      // Filed before the block that carries the transaction. tx.time is the
      // block time, so this is generous by up to an hour on the honest side
      // and cannot be back-dated on the dishonest one: the intent's timestamp
      // is written by this host, not by the caller.
      const ahead = tx.time > 0 && it.ts < tx.time;
      pairs.push({ intent: it, tx, score: spec + (ahead ? 10 : 0), spec, ahead });
    }
  }
  // Best evidence first, everywhere at once — not oldest-intent-first. Greedy
  // by age credited the right person for the wrong reason: an intent naming a
  // wallet would swallow ANY burn from that wallet, including one a later
  // intent named to the satoshi. Sorting globally means the exact match wins
  // and the vague one keeps waiting for the burn it actually described.
  // Ties: earlier transaction, then older intent — never explorer order.
  // The last tie-break is what makes an already-confirmed burn first-come.
  pairs.sort((a, b) => b.score - a.score || a.tx.time - b.tx.time || a.intent.ts - b.intent.ts);
  const out = [], usedTx = new Set(claimed), usedIntent = new Set();
  for (const p of pairs) {
    if (usedTx.has(p.tx.txid) || usedIntent.has(p.intent)) continue;
    usedTx.add(p.tx.txid); usedIntent.add(p.intent);
    out.push(p);
  }
  return out;
}

const burnWatch = { last: 0, lastError: null, credited: 0, running: false };

/**
 * One tick. Nothing here is trusted: the candidate comes from an address
 * listing, but the credit goes through verifyBurnTx exactly as a hand-filed
 * claim does — two explorers, agreement, confirmations.
 */
async function burnTick() {
  if (!BURN_ADDRESS || burnWatch.running) return;
  // A mirror does not write acts, and a primary in quarantine has not yet
  // established that it is the writer. Either one minting burns would be a
  // second writer, which is the fork this whole design exists to prevent.
  if (isMirror() || role.quarantine) return;
  const now = Date.now();
  // Expire before matching, so a dead intent cannot adopt a fresh burn. A
  // satisfied one is kept a week — long enough to answer "what happened to my
  // burn", short of growing forever. Nothing depends on it after that: the
  // log, not this file, is what stops a transaction being credited twice.
  const before = intents.length;
  intents = intents.filter((i) => (i.txid
    ? now - (i.creditedAt || i.ts) < 7 * 86_400_000
    : now - i.ts < BURN_INTENT_TTL_MS));
  if (intents.length !== before) saveIntents();
  const open = intents.filter((i) => !i.txid);
  if (!open.length) { burnWatch.last = now; return; }
  burnWatch.running = true;
  try {
    const candidates = await burnAddressTxsFresh();
    if (!candidates) { burnWatch.lastError = 'no explorer answered'; return; }
    const claimed = claimedTxids();
    for (const m of matchBurns(open, candidates, claimed)) {
      const v = await verifyBurnTx(m.tx.txid);
      // Not an error: an unconfirmed or too-shallow burn simply is not ready.
      // The intent stays open and the next tick asks again.
      if (!v.ok) continue;
      // The role is re-checked HERE, for the same reason the log is: this tick
      // passed the guard at the top before spending tens of seconds on the
      // network, and the role changes during exactly that kind of window — an
      // election can demote this host, and boot quarantine is imposed while
      // the first tick is already running. Minting either way is a second
      // writer, which is the one failure the whole design exists to prevent.
      if (isMirror() || role.quarantine) return;
      // Checked once more against the log, immediately before writing: a
      // hand-filed claim may have landed while this tick was on the network.
      if (claimedTxids().has(m.tx.txid)) { m.intent.txid = m.tx.txid; m.intent.note = 'already claimed'; saveIntents(); continue; }
      mintInternal({ t: 'btcBurn', id: m.intent.id, txid: m.tx.txid, sats: v.sats, addr: BURN_ADDRESS, ts: Date.now() });
      m.intent.txid = m.tx.txid;
      m.intent.sats = v.sats;
      m.intent.creditedAt = Date.now();
      m.intent.by = (m.spec === 3 ? 'sending address and amount'
        : (m.spec === 2 ? (m.intent.wantTxid ? 'txid' : (m.intent.from ? 'sending address' : 'amount'))
          : 'sending address, for a different amount than the one named'))
        + (m.ahead ? ', declared in advance' : '');
      burnWatch.credited++;
      // One burn gets described more than once by design: the panel files the
      // amount before the send, the local page files it again when it opens,
      // and the wallet files the txid afterwards. Exactly one of those can be
      // credited — and the survivors then describe a transaction that is
      // already paid, so they sit open waiting to adopt the NEXT burn of that
      // size, which belongs to somebody else. That is not hypothetical: it
      // was reproduced, and it credited one handle's burn to another. Retire
      // the siblings with the burn they described. Only this handle's own —
      // another handle's intent is not this one's to close — and only those
      // that contradict nothing about the transaction just paid.
      for (const other of intents) {
        if (other === m.intent || other.txid || other.id !== m.intent.id) continue;
        if (other.wantTxid && other.wantTxid !== m.tx.txid) continue;
        if (other.sats && other.sats !== v.sats) continue;
        if (other.from && !m.tx.from.includes(other.from)) continue;
        if (!other.wantTxid && !other.sats && !other.from) continue;
        other.txid = m.tx.txid;
        other.creditedAt = Date.now();
        other.note = 'described the same burn; credited once, under another intent';
      }
      saveIntents();
      console.log('[burn] credited ' + v.sats + ' sat to ' + m.intent.id + ' — ' + m.tx.txid + ' (matched by ' + m.intent.by + ')');
    }
    burnWatch.lastError = null;
  } catch (e) {
    burnWatch.lastError = String(e && e.message ? e.message : e).slice(0, 200);
  } finally {
    burnWatch.running = false;
    burnWatch.last = Date.now();
  }
}

// Contact addresses live beside the log, never in it. server-data/ is
// gitignored wholesale, the mirror copies only acts and media, and the static
// archive publishes only acts.jsonl — so nothing here can escape by accident.
const CONTACTS = resolve(DATA_DIR, 'contacts.json');

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
    // btcBurn belongs here for the plainest reason: a burn binds destroyed
    // money to a handle, so it must be authorised by whoever can act as that
    // handle. Without it the actor derives null, the PIN check is skipped,
    // and anyone watching the chain could claim a stranger's burn.
    : (act.author ?? act.from ?? (['burn', 'btcBurn', 'deposit', 'burnL0', 'redeem', 'setPin', 'setKey', 'deleteAccount',
      // profile and setRecovery carry their actor in `id`, like setPin. Left
      // out of this list they derive a null actor and skip the PIN check
      // entirely: anyone could rewrite anyone's biography, or attach a
      // recovery code to a handle that is not theirs and then take it.
      'profile', 'setRecovery',
      // bindAddress carries its actor in `id` too, and it is the most
      // expensive omission available: a null actor here skips the PIN check,
      // and the act says where a handle's epoch earnings are paid. Missing
      // from this list, the PIN_REQUIRED entry above would be decorative.
      'bindAddress'].includes(act.t) ? act.id : null));
  if (!actor) return null; // closeEpoch/closeCycle are communal; register is checked for uniqueness only
  const stored = pinIndex.get(actor);
  // "Is this handle secured?" is a question about CREDENTIALS, not about PINs.
  // This read pinIndex alone and treated an empty entry as "no credential", so
  // a handle secured with a passkey and nothing else fell into the branch
  // below before the assertion check further down was ever reached. Two things
  // followed, both bad in the same direction:
  //
  //   - the strongest credential this codebase offers could not do the one act
  //     that turns epoch tokens into money. bindAddress is PIN_REQUIRED, so a
  //     passkey-only handle was refused every time and told to set a PIN — a
  //     weaker credential — or watch its share stay unbound and return to the
  //     steward at every sweep;
  //   - and for ordinary acts the same empty `stored` meant nothing verified
  //     the assertion at all: the branch returned null and waved them through,
  //     so a passkey secured nothing until a PIN sat beside it.
  //
  // Both stores are consulted now, and the no-credential branch is entered
  // only when BOTH are empty.
  const keys = keyIndex.get(actor) ?? [];
  if (!stored && keys.length === 0) {
    if (PIN_REQUIRED.has(act.t)) {
      return 'this handle has no PIN and no passkey — secure it before binding an address, editing or deleting, otherwise anyone could do it in your name';
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
  // ── Recovery ────────────────────────────────────────────────────────────
  //
  // The one way back into a handle whose PIN is gone that does not involve
  // the operator. The grant is only ever placed by /api/auth/recover after a
  // code has been verified, it is spent immediately, and it authorises
  // exactly one thing: replacing the PIN.
  if (act.t === 'setPin' && recoveryGrant.has(actor)) {
    recoveryGrant.delete(actor);
    return null;
  }

  // ── Operator reset of an EXISTING PIN ───────────────────────────────────
  //
  // The operator could set a FIRST PIN on an unclaimed handle but could not
  // reset one already set, so somebody who forgot their own PIN was locked out
  // permanently — no email, no recovery key, nothing. That is not a security
  // property, it is a missing feature that looked like one.
  //
  // The power is real and worth naming: whoever holds this token can take over
  // any handle on this instance. That was already true — they run the host and
  // could edit the log directly — so the honest move is to make it an act
  // everyone can see rather than something done quietly with a text editor.
  // The act is stamped, and the record says the operator did it, not the owner.
  if (act.t === 'setPin' && OPERATOR_TOKEN && act.auth === OPERATOR_TOKEN) {
    act.byOperator = true;
    return null;
  }

  // A passkey proves more than a PIN does and is checked first: the signature
  // covers a challenge this host issued seconds ago and the origin the browser
  // was actually on, so it cannot be replayed and cannot be phished.
  const assertion = act.auth && typeof act.auth === 'object' ? act.auth : null;
  if (assertion) {
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
  // No assertion, and this handle has no PIN to fall back on: it is secured by
  // passkey alone, and the only thing that opens it is a signature. Saying so
  // matters — the old path fell into pinMatches with nothing stored and
  // answered "wrong or missing PIN", which sends the owner of a perfectly good
  // credential looking for one that does not exist.
  if (!stored) {
    return 'this handle is secured with a passkey and has no PIN — sign the act with the passkey (POST /api/auth/challenge, then send `auth` as the assertion object). A PIN cannot open it.';
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
  // Ahead of PIN_REQUIRED on purpose: this refusal also contains "has no PIN",
  // and a caller told PIN_REQUIRED would go and set a weaker credential on a
  // handle that already holds a stronger one. The remedy here is a signature.
  [/secured with a passkey/i, 'PASSKEY_REQUIRED'],
  [/no PIN — set one|has no PIN|needs a PIN on this handle/i, 'PIN_REQUIRED'],
  [/cannot be claimed from outside|already posted and has no PIN|already acted and has no PIN/i, 'HANDLE_UNCLAIMABLE'],
  [/too many PIN attempts/i, 'PIN_ATTEMPTS'],
  [/passkey refused|not registered to this handle|sign-in has expired/i, 'PASSKEY_REFUSED'],
  [/characters; the limit is|is too long|the limit is \d+/i, 'TOO_LONG'],
  [/only the author/i, 'NOT_YOURS'],
  [/never minted on this network|no content with id/i, 'UNKNOWN_TARGET'],
  [/already deleted|that comment was deleted/i, 'ALREADY_DELETED'],
  [/account was deleted/i, 'ACCOUNT_DELETED'],
  // "not enough energy" was the wording years ago; the sentence has said
  // "out of energy" for as long as anyone can check. A classifier keyed on
  // prose silently stops classifying when the prose is improved, which is
  // exactly what happened here — so both spellings, and the caller that
  // matters names NO_ENERGY outright rather than trusting this table.
  [/out of energy|not enough energy/i, 'NO_ENERGY'],
  [/below the safety wall|standing is below/i, 'RATE_TOO_LOW'],
  [/balance is .* tried to (send|deposit|sell)|not enough balance|costs .* and you hold|you hold \d/i, 'INSUFFICIENT_BALANCE'],
  [/runs between 1 and 90 days|advert text is|the advert needs text/i, 'BAD_REQUEST'],
  [/only the advertiser|no advert with id/i, 'NOT_YOURS'],
  [/the price moved|below your minimum/i, 'SLIPPAGE'],
  [/pool already exists/i, 'POOL_EXISTS'],
  [/already claimed its tBTC/i, 'ALREADY_CLAIMED'],
  [/symbol .* is taken|is taken$/i, 'SYMBOL_TAKEN'],
  [/no payment address/i, 'ADS_CLOSED'],
  [/approve advert .* before marking it paid/i, 'AD_NOT_APPROVED'],
  [/url must be a plain/i, 'BAD_URL'],
  [/engine still loading/i, 'ENGINE_LOADING'],
  [/betting on this closed|jury for this bet was settled|still open — a jury certifies|jury has until/i, 'MARKET_CLOSED'],
  [/no bet is running|no such bet/i, 'NO_MARKET'],
  [/already resolved|was voided/i, 'MARKET_SETTLED'],
  [/holds no seat|already certified|cannot back an answer|does not hold a position|cannot also certify/i, 'NOT_YOURS'],
  [/not an ethereum address|bad address binding/i, 'BAD_ADDRESS'],
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
    // The faucet, closed HERE rather than further down. A second `case
    // 'burn'` added below would have been dead code: the first matching case
    // wins a switch, so the door would have stayed open while the source
    // read as though it were shut.
    case 'burn':
      return 'the reserve faucet is closed — it was named for destruction and destroyed nothing, crediting reserve from thin air. Reserve comes from a verified Bitcoin burn now: GET /api/burn';
    case 'btcBurn': {
      // Never accepted from the outside door. A burn is minted by the host
      // only after /api/burn/claim has verified the transaction against two
      // independent public explorers; letting a client post one directly
      // would make the whole mechanism a self-declaration.
      return 'a burn is recorded by the host after it verifies the transaction — POST /api/burn/claim with your txid instead';
    }
    case 'resetTokens': {
      return 'the token ledger is reset by the operator, not through this door';
    }
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
        if (!Array.isArray(act.media)) return 'bad media';
        // A whitelist INSIDE the entry, which until now did not exist.
        //
        // sanitize() copies whitelisted TOP-LEVEL keys, and `media` is one of
        // them — so the array goes through by reference and every nested key
        // survives verbatim. hasControlChars() has the same shape: it walks
        // Object.values(act) and never descends. Both were checked by running
        // them, not by reading them: an entry carrying a 300-character junk
        // field and a filename with a U+0001 in it was accepted 200 and
        // written into the public, mirrored, permanently-published log.
        //
        // The log is append-only and its bytes are hashed into the archive
        // manifest, so anything that lands here lands forever.
        const ENTRY_KEYS = new Set(['h', 'm', 'n', 's', 'cv']);
        for (const m of act.media) {
          if (!m || typeof m !== 'object' || Array.isArray(m)) return 'bad media entry';
          for (const k of Object.keys(m)) {
            if (!ENTRY_KEYS.has(k)) return 'an attachment carries an unknown field: ' + k;
            if (typeof m[k] === 'string' && CONTROL_CHARS.test(m[k])) return 'unprintable characters are not allowed';
          }
        }
        // Name the number. A refusal that says 'bad media' sends an author
        // deleting text to fix an attachment problem — the byte limit above
        // blames 'an attachment or reference list' for exactly that reason.
        if (act.media.length > MEDIA_MAX_ENTRIES) {
          return 'a post carries at most ' + MEDIA_MAX_ENTRIES + ' files; this one has ' + act.media.length;
        }
        let total = 0;
        let covers = 0;
        for (const m of act.media) {
          if (!m || typeof m !== 'object' || !/^[a-f0-9]{64}$/.test(m.h ?? '') || !MEDIA_TYPES.has(m.m)) return 'bad media entry';
          if (m.n !== undefined && (typeof m.n !== 'string' || m.n.length > 80)) return 'bad media name';
          if (!existsSync(join(MEDIA_DIR, m.h))) return 'unknown media hash — upload first';
          // The cover. Exactly the number 1 and nothing else — a string, an
          // object or a truthy value would reopen the nested channel the
          // whitelist above just closed.
          if (m.cv !== undefined) {
            if (m.cv !== 1) return 'a cover is marked with cv:1 and nothing else';
            if (!String(m.m).startsWith('image/')) return 'a cover has to be an image';
            covers += 1;
          }
          // The kind, from the sidecar the upload wrote — not from the act.
          //
          // This checked an allow-list and nothing else, so `m` was the
          // author's claim about their own bytes rather than a fact about
          // them. Demonstrated on a throwaway host: a 16-byte PNG published as
          // {m:'audio/mpeg', n:'Definitely A Song.mp3'} was accepted 200, and
          // every reader would have seen a player that silently refuses to
          // decode. The profile-picture branch has read the sidecar since the
          // day it shipped, for exactly this reason; the post branch had not.
          //
          // Compared by top-level type, not exact string: MIME_ALIASES folds
          // audio/mp3 to audio/mpeg on the way in, and a client that names a
          // sibling type of the same family is describing the same bytes.
          let stored = '';
          try { stored = String(JSON.parse(readFileSync(join(MEDIA_DIR, m.h) + '.meta', 'utf8')).mime || ''); } catch { /* below */ }
          if (stored && stored.split('/')[0] !== String(m.m).split('/')[0]) {
            return 'that attachment is ' + stored + ' and the post calls it ' + m.m;
          }
          // The real size, from the blob on disk. `s` is carried in the record
          // so a reader can say what a download will cost BEFORE fetching it —
          // but it is checked against the bytes, so it can never be a number
          // the client made up.
          let real = 0;
          try { real = statSync(join(MEDIA_DIR, m.h)).size; } catch { /* refused below */ }
          if (!real) return 'unknown media hash — upload first';
          if (m.s !== undefined && (!Number.isInteger(m.s) || m.s !== real)) {
            return 'that attachment claims ' + m.s + ' bytes and the stored blob is ' + real;
          }
          total += real;
        }
        if (covers > 1) return 'a post has one cover; this one names ' + covers;
        if (total > MEDIA_MAX_ACT_BYTES) {
          return 'the files on one post come to at most ' + Math.round(MEDIA_MAX_ACT_BYTES / (1024 * 1024))
            + ' MB; these come to ' + Math.round(total / (1024 * 1024)) + ' MB';
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
    case 'follow': {
        if (!str(act.from, 24) || !str(act.to, 40)) return 'bad follow';
        if (act.from === act.to) return 'a handle cannot follow itself';
        if (!isRegistered(act.to)) return 'no such handle: ' + act.to;
        if (act.on !== undefined && typeof act.on !== 'boolean') return 'bad follow';
        break;
      }
    case 'profile': {
        if (!str(act.id, 24)) return 'bad profile';
        if (act.bio !== undefined && (typeof act.bio !== 'string' || act.bio.length > 280)) {
          return 'a profile note is at most 280 characters; yours is ' + String(act.bio || '').length;
        }
        if (act.link !== undefined && act.link !== '') {
          if (typeof act.link !== 'string' || act.link.length > 200) return 'that link is too long';
          // Same rule the adverts use: a link is the one thing everybody
          // clicks, so javascript: and data: are refused rather than escaped.
          if (!/^https?:\/\//i.test(act.link)) return 'a profile link must be a plain http(s) URL';
        }
        // A picture is a hash of bytes already uploaded, and nothing else. It
        // is checked for existence like post media, and for being an image at
        // all — the mime comes from the stored sidecar, not from the act, so
        // an act cannot describe a video as a portrait.
        if (act.pic !== undefined && act.pic !== '') {
          if (typeof act.pic !== 'string' || !/^[a-f0-9]{64}$/.test(act.pic)) return 'bad profile picture';
          const pf = join(MEDIA_DIR, act.pic);
          if (!existsSync(pf)) return 'unknown picture hash — upload first';
          let pm = '';
          try { pm = String(JSON.parse(readFileSync(pf + '.meta', 'utf8')).mime || ''); } catch { /* below */ }
          if (!pm.startsWith('image/')) return 'a profile picture has to be an image';
          // Sized here as well as on the device. The picture appears beside
          // every handle on every screen, so it is fetched far more often than
          // any post attachment — a phone photo in that slot is bytes paid for
          // hundreds of times over. The client crops to 256px, ~21 KB.
          let ps = 0;
          try { ps = statSync(pf).size; } catch { /* below */ }
          if (ps > PROFILE_PIC_MAX) {
            return 'a profile picture is at most ' + Math.round(PROFILE_PIC_MAX / 1024) + ' KB; this one is '
              + Math.round(ps / 1024) + ' KB — it should be cropped and re-encoded before it is uploaded';
          }
        }
        break;
      }
    case 'setRecovery': {
        if (!str(act.id, 24)) return 'bad recovery';
        if (!validPinHash(act.codeHash)) return 'bad recovery code hash';
        break;
      }
    case 'bindAddress': {
        // Where this handle's epoch earnings are payable on Base. The act is
        // public, like everything else here, and it is the security boundary
        // between a number in this log and money on a chain — so it is
        // PIN-gated above and shape-checked to the byte here.
        if (!str(act.id, 24)) return 'bad address binding';
        const given = typeof act.addr === 'string' ? act.addr.trim() : '';
        // Either case is accepted and LOWERCASE is stored. An address is
        // twenty bytes whichever way a wallet prints them, and lowercase is
        // the exact byte string the claim leaf hashes (chain/earnings.mjs,
        // PeerClaim._hex). What is deliberately NOT done: the EIP-55 checksum
        // is defined over keccak-256, this repo imports no hashing library on
        // purpose, and node's crypto offers sha3-256 — a different function —
        // so a checksum cannot be verified here without breaking that rule.
        // Said plainly rather than implied: A MISTYPED ADDRESS CANNOT BE
        // CAUGHT. Paste it from the wallet, never type it. That is also why
        // rebinding exists, and why a rebinding lands in the next epoch.
        if (!/^0x[0-9a-fA-F]{40}$/.test(given)) {
          return 'that is not an ethereum address: it must be 0x followed by exactly 40 hex characters (20 bytes) — paste it from your wallet rather than typing it, because nothing here can check a typo';
        }
        const addr = given.toLowerCase();
        if (addr === '0x0000000000000000000000000000000000000000') {
          return 'that is not an ethereum address: the zero address holds no key, so earnings bound to it could never be claimed by anyone';
        }
        act.addr = addr;   // canonical form enters the log, never the input's case
        break;
      }
      case 'event': {
      if (!str(act.author, 24) || !str(act.text, 280)) return 'bad event';
      if (act.at !== undefined && !num(act.at)) return 'bad event time';
      if (act.place !== undefined && (typeof act.place !== 'string' || act.place.length > 120)) return 'that place is too long';
      if (act.fee !== undefined && act.fee !== 0) {
        // Finite and positive, checked here as well as in the replay: a
        // negative fee run through debit-then-credit mints currency, and
        // Infinity passes a naive comparison.
        if (!num(act.fee) || !(act.fee > 0)) return 'an entry fee must be a positive number';
        if (act.fee > 1e9) return 'that entry fee is not a real number';
        // PEER, or any asset somebody minted. Not tBTC: it is retired, and a
        // whitelist naming a currency nobody can obtain prices tickets in
        // nothing. A minted symbol is honest — worth what a pool says it is,
        // and the buyer can see who created it.
        if (!/^[A-Z][A-Z0-9]{2,7}$/.test(String(act.cur || ''))) return 'entry is payable in PEER, or in any minted asset';
      }
      if (act.cap !== undefined && act.cap !== 0 && (!num(act.cap) || act.cap < 1 || act.cap > 100000)) return 'bad capacity';
      break;
    }
    case 'invite': {
      if (!str(act.from, 24) || !str(act.to, 24) || !str(act.cid, 40)) return 'bad invite';
      if (act.from === act.to) return 'you are already at your own event';
      if (!isRegistered(act.to)) return 'no such handle: ' + act.to;
      if (unknownTarget(act.cid)) return unknownTarget(act.cid);
      break;
    }
    case 'rsvp': {
      if (!str(act.from, 24) || !str(act.cid, 40)) return 'bad rsvp';
      if (act.on !== undefined && typeof act.on !== 'boolean') return 'bad rsvp';
      if (unknownTarget(act.cid)) return unknownTarget(act.cid);
      if (act.amt !== undefined && act.amt !== 0) {
        if (!num(act.amt) || !(act.amt > 0)) return 'an entry payment must be a positive number';
        // PEER, or any asset somebody minted. Not tBTC: it is retired, and a
        // whitelist naming a currency nobody can obtain prices tickets in
        // nothing. A minted symbol is honest — worth what a pool says it is,
        // and the buyer can see who created it.
        if (!/^[A-Z][A-Z0-9]{2,7}$/.test(String(act.cur || ''))) return 'entry is payable in PEER, or in any minted asset';
        if (!str(act.to, 24)) return 'an entry payment must name who receives it';
      }
      // A deleted event, and an event that is over, both stop taking money.
      //
      // Deliberately here and NOT in the replay's tokenActError: deletion is
      // retroactive in that file and a wall-clock comparison is retroactive by
      // construction, so either check there would rewrite balances in a log
      // that has already been replayed — including payments that were entirely
      // valid when they were made. The door closes at the door.
      if (act.on !== false) {
        if (engineMod && replayMod) {
          if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
          if (stateCache.len !== acts.length || !stateCache.st) {
            stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
          }
          const ev = stateCache.st.events && stateCache.st.events[act.cid];
          if (ev) {
            if (stateCache.st.payloads[act.cid] === undefined) {
              return 'that event was deleted — its door is closed';
            }
            if (ev.at && ev.at < Date.now()) {
              return 'that event has already happened — its door is closed';
            }
          }
        }
      }
      // Authorisation before arithmetic. authError waves an unsecured handle
      // through for ordinary acts, and a paid answer would drain it while the
      // record read as that person choosing to attend — the amount lives in
      // the event, not in the act, so nothing in the log would look unusual.
      // Asked here, ahead of the balance check, so a stranger probing a handle
      // is told it needs a PIN rather than told what it holds.
      if (act.amt > 0 && act.on !== false && !pinIndex.has(act.from)) {
        return 'paying to enter an event needs a PIN on this handle — without one, anyone could spend its balance in your name';
      }
      // Balances, capacity and whether the price moved come from the SAME
      // function the replay applies with. Wiring one without the other fails
      // in both directions: the host would accept a payment the replay skips,
      // or refuse every answer the replay would have allowed.
      if (act.on !== false) {
        if (!engineMod || !replayMod) return 'engine still loading — try again in a moment';
        if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
        if (stateCache.len !== acts.length || !stateCache.st) {
          stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
        }
        const rerr = stateCache.st.tokenActError({
          t: 'rsvp', author: act.from, cid: act.cid, amt: act.amt, cur: act.cur, to: act.to,
        });
        if (rerr) return rerr;
      }
      break;
    }
    // ── Prender Markets ───────────────────────────────────────────────────
    //
    // Two kinds of check live here and only here, because neither belongs in
    // a replay: the WALL CLOCK (betting closes, then the jury certifies, then
    // anyone may call time) and DELETION (a bet whose question was redacted
    // takes no new money). Everything about who may do what and whether the
    // arithmetic works is asked of marketActError — the same function the
    // replay applies with — so the host cannot accept what the replay skips.
    case 'market': {
      if (!str(act.author, 24) || !str(act.text, 280)) return 'bad bet';
      if (!Array.isArray(act.opts)) return 'a bet needs its answers as a list';
      for (const o of act.opts) {
        if (!str(o, 60)) return 'every answer needs text, at most 60 characters';
      }
      if (new Set(act.opts.map((o) => o.trim().toLowerCase())).size !== act.opts.length) {
        return 'two answers on this bet say the same thing — stakes name an answer, so they have to be distinguishable';
      }
      // A closing time is not optional. Without one there is no moment the
      // answer becomes knowable, which means no moment betting is unfair
      // after — somebody who already knows could back a certainty.
      if (!num(act.at) || act.at <= Date.now()) return 'a bet needs a closing time in the future';
      if (act.at > Date.now() + MKT_MAX_AHEAD_MS) return 'a bet closes within a year — beyond that it is a way to hold other people\'s money, not a question';
      if (Array.isArray(act.mods)) {
        if (act.mods.length > 8) return 'name at most eight people to moderate';
        for (const mid of act.mods) {
          if (!str(mid, 24)) return 'bad nomination';
          if (!isRegistered(mid)) return 'no such handle: ' + String(mid).slice(0, 40);
        }
      } else if (act.mods !== undefined) return 'bad nominations';
      return marketDoor(act, { author: act.author, opts: act.opts, cur: act.cur,
        seats: act.seats, bond: act.bond, feeBp: act.feeBp });
    }
    case 'bet':
    case 'modStand':
    case 'modVote':
    case 'attest':
    case 'marketVoid': {
      if (!str(act.author, 24) || !str(act.cid, 40)) return 'bad ' + act.t;
      if (unknownTarget(act.cid)) return unknownTarget(act.cid);
      if (act.t === 'bet' && !num(act.amt)) return 'a stake must be a number';
      if ((act.t === 'bet' || act.t === 'attest') && !num(act.opt)) return 'that act does not name an answer';
      if (act.t === 'modStand' && act.on !== undefined && typeof act.on !== 'boolean') return 'bad modStand';
      if (act.t === 'modVote') {
        if (!Array.isArray(act.for)) return 'a ballot is a list of handles';
        for (const cid of act.for) if (!str(cid, 24)) return 'bad ballot';
      }
      // Authorisation before arithmetic, exactly as a paid RSVP does it: a
      // stake and a bond both spend a balance, and authError waves an
      // unsecured handle through for ordinary acts. Asked ahead of the balance
      // check so probing a stranger's handle tells you it needs a PIN rather
      // than telling you what it holds.
      if ((act.t === 'bet' || (act.t === 'modStand' && act.on !== false)) && !pinIndex.has(act.author)) {
        return 'staking on a bet needs a PIN on this handle — without one, anyone could spend its balance in your name';
      }
      const st = freshState();
      if (!st) return 'engine still loading — try again in a moment';
      const m = st.markets && st.markets[act.cid];
      if (!m) return 'no bet is running on ' + act.cid;
      const closed = m.at > 0 && m.at <= Date.now();
      if (act.t === 'bet' || act.t === 'modStand' || act.t === 'modVote') {
        // Everything that shapes the answer stops at the same instant. If
        // ballots were still counted afterwards, whoever now KNOWS the answer
        // could seat a jury to certify it.
        if (closed) {
          return act.t === 'bet'
            ? 'betting on this closed at ' + new Date(m.at).toLocaleString() + ' — the answer is knowable now'
            : 'the jury for this bet was settled when betting closed';
        }
        if (st.payloads[act.cid] === undefined) {
          return 'that bet was deleted — no new money goes in. What is already staked still settles.';
        }
      }
      if (act.t === 'attest' && !closed) {
        return 'this bet is still open — a jury certifies after betting closes, not before';
      }
      if (act.t === 'marketVoid' && Date.now() < m.at + marketResolveMs(st)) {
        return 'the jury has until ' + new Date(m.at + marketResolveMs(st)).toLocaleString()
          + ' to certify this bet; time can be called after that';
      }
      return marketDoor(act, { author: act.author, cid: act.cid, opt: act.opt, amt: act.amt,
        on: act.on, for: act.for });
    }
    case 'tag':
      if (!str(act.author, 24) || !str(act.target, 40) || !str(act.name, 20) || !inR(act.r) || !inR(act.c)) return 'bad tag';
      if (unknownTarget(act.target)) return unknownTarget(act.target);
      break;
    case 'closeEpoch':
      if (!num(act.epoch)) return 'bad epoch';
      break;
    case 'setPin':
      if (!str(act.id, 24)) return 'bad id';
      // Must accept every format this host has ever written, PBKDF2 included.
      //
      // This line was missed when PIN storage moved to PBKDF2 — the register
      // path was updated and this one was not, so from the moment the new
      // client shipped, EVERY attempt to set or change a PIN through the app
      // was refused with "bad pin hash". The app reported a failure the user
      // could do nothing about, their stored PIN silently stayed the old one,
      // and at least one person concluded their account had been taken.
      //
      // The lesson is not "check both paths". It is that a validator written
      // as a literal in two places will drift; there is one function now, and
      // both callers use it.
      if (!validPinHash(act.pinHash ?? '')) return 'bad pin hash';
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
      // 'event' is here because an event act carries a place: where a named
      // person will physically be, at a named time. A delete that could not
      // reach it would leave that standing after the account was gone.
      // 'market' is here so an author can take down a question they should
      // not have asked. It redacts the question and the answers; it does NOT
      // touch the escrow, and the jury can still certify — money already
      // staked has to be able to find its way home.
      if (!orig || (orig.t !== 'post' && orig.t !== 'event' && orig.t !== 'market')) {
        return 'delete target is not a post, an event or a bet';
      }
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
    // Every door that used to mint value out of nothing, closed at the host
    // as well as in the replay, so a refusal arrives as a sentence rather
    // than as an act that quietly does nothing.
    //
    // `burn` was the worst of them: it was named for destruction and
    // destroyed nothing, crediting reserve from thin air. Layer 0 was an
    // attestation economy over deposits nobody ever made — full-reserve
    // arithmetic on an empty reserve. And tBTC wore bitcoin's name on a
    // number this code invented. Reserve now comes from bitcoin actually
    // destroyed at an address with no key, proven by a txid anyone can
    // check, and from nowhere else.
    case 'btcClaim':
      return 'tBTC is retired — it was never bitcoin. Burn real bitcoin instead: GET /api/burn';
    case 'deposit':
    case 'burnL0':
    case 'redeem':
    case 'transferL0':
    case 'closeCycle':
      return 'Layer 0 is retired — it kept full-reserve books over a reserve nobody had funded. The only real value here is bitcoin destroyed at the dead address: GET /api/burn';
    case 'assetCreate':
    case 'tokenSend':
    case 'poolCreate':
    case 'poolAdd':
    case 'poolRemove':
    case 'poolSwap':
    case 'advert':
    case 'adStop': {
      if (!str(act.author, 24)) return 'bad actor';
      if (act.t === 'advert') {
        // Targeting is matched on the reader's device, so the host only checks
        // that the criteria are the right shape and small enough to ship to
        // everyone. It never evaluates them, and never learns who matched.
        for (const f of ['placement', 'tags', 'people', 'posts', 'regions']) {
          if (act[f] !== undefined && (!Array.isArray(act[f]) || act[f].length > 12)) return f + ' must be a list of at most 12 entries';
          if (Array.isArray(act[f])) for (const v of act[f]) if (!str(v, 40)) return 'bad ' + f + ' entry';
        }
      }
      // Numbers must be finite before any arithmetic sees them: an Infinity
      // deposited into a pool would poison every price after it.
      for (const f of ['supply', 'amt', 'amtA', 'amtB', 'shares', 'minOut', 'days']) {
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

// ── The epoch chain ─────────────────────────────────────────────────────────
// Every closeEpoch seals a signed block over that epoch's act range and state
// package (chain/). Sealing runs off the request path and is best-effort: a
// chain that lags is visible at /api/chain and heals on the next close or the
// next `node chain/build.mjs`; a write path that waited on a standing solve
// would hold every author hostage to a certificate nobody had asked for yet.
// Mirrors never seal — a mirror signing blocks would be a second writer
// wearing a different hat. The producer key lives in server-data/chain/ and
// is not, and must never be, served by any route.
let chainBusy = false, chainAgain = false;
function scheduleChainSeal() {
  if (role.mirrorOf) return;
  // An explicitly keyless writer (PEER_SEAL=off — the cloud stand-in) does
  // not seal: loadOrCreateProducerKey would happily mint a NEW key here, and
  // blocks signed by it are exactly what the producer-pinned archive must
  // refuse. A chain that pauses at its last sealed height is honest; a
  // second signature pretending to be the record's author is not.
  if (String(process.env.PEER_SEAL || '').toLowerCase() === 'off') return;
  if (chainBusy) { chainAgain = true; return; }
  chainBusy = true;
  setImmediate(async () => {
    try {
      const [{ loadProtocol, buildBlocks }, { loadOrCreateProducerKey }, { readBlocksFile, writeChain }] =
        await Promise.all([import('./chain/chain.mjs'), import('./chain/keys.mjs'), import('./chain/build.mjs')]);
      const { R, editions, constants } = await loadProtocol(here);
      const chainDir = resolve(DATA_DIR, 'chain');
      const key = loadOrCreateProducerKey(resolve(chainDir, 'producer.pem'));
      const existing = readBlocksFile(resolve(chainDir, 'blocks.jsonl'));
      const fileActs = acts.slice(1); // the in-memory seedWorld is not a line
      const { blocks, sealed } = buildBlocks({ fileActs, R, editions, constants, key, existing });
      if (sealed > 0) {
        writeChain(chainDir, blocks);
        console.log(`[chain] sealed ${sealed} block(s) — height ${blocks.length}`);
      }
    } catch (e) {
      console.error('[chain] seal failed: ' + e.message);
    } finally {
      chainBusy = false;
      if (chainAgain) { chainAgain = false; scheduleChainSeal(); }
    }
  });
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
  const st = freshState();
  return st ? st.g.nodes.has(id) : true;
}

/**
 * The world as the replay sees it right now, or null while the engine is
 * still loading. Every door check that needs state goes through here, so the
 * cache is refreshed in exactly one place rather than in each caller's own
 * copy of the same four lines.
 */
function freshState() {
  if (!engineMod || !replayMod) return null;
  if (!stateCache.R) stateCache.R = replayMod.create(engineMod);
  if (stateCache.len !== acts.length || !stateCache.st) {
    stateCache = { len: acts.length, st: stateCache.R.replay(acts), R: stateCache.R };
  }
  return stateCache.st;
}

/**
 * Ask the replay's own rulebook whether a market act applies, and hand back
 * its sentence unchanged.
 *
 * This is the whole reason the host cannot drift from the record: balances,
 * eligibility, seats and the arithmetic of a stake are decided by
 * marketActError, which is the function the replay itself applies with. The
 * host adds exactly two things on top — the clock and deletion — and both are
 * things a pure replay must never know about.
 */
function marketDoor(act, probe) {
  const st = freshState();
  if (!st) return 'engine still loading — try again in a moment';
  if (!st.marketActError) return 'this host is running a replay with no markets in it';
  return st.marketActError({ t: act.t, ...probe }) || null;
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
      // A bot that can set a cover has to be able to read one back, or it can
      // only ever guess which of its own attachments is the sleeve.
      cover: m.cv === 1 || undefined, bytes: m.s ?? null,
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
  name: 'Ender Net bot API',
  version: 'v1',
  what: 'A social network whose feed, standing and economy are replayable mathematics rather than engagement heuristics. This API gives bots the derived state directly, so you never have to replay the protocol yourself.',
  howItWorks: {
    acts: 'Everything anyone does is an act appended to a public log. There are no private records; a direct message is an act like any other.',
    cost: 'Every act debits θ = 0.0528066 from your burn balance and raises your act count N. Your commitment rate is balance/N: acting dilutes it, burning reserve restores it. Run out and the host refuses the act with 402 (gate W1) — burn bitcoin to get more: GET /api/burn. Recovery acts and corrections are never gated, so you can always climb back.',
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
    { method: 'GET', path: '/api/v1/epoch/N/claim?as=ID|address=0x…', purpose: 'one CLOSED epoch\'s earnings as a merkle tree: the root, the total in raw 18-decimal units, every leaf (address, amount, the handles behind it), the handles that earned and had no address bound, and — when you name a claimant — that claimant\'s amount and the bytes32[] proof PeerClaim.claim takes. Every leaf is returned on purpose: rebuild the root yourself and compare it with the one published on-chain rather than trusting this host to have computed it honestly.' },
    { method: 'POST', path: '/api/v1/bind', purpose: 'bind an ethereum address to your handle, so that from the NEXT epoch close your share is a leaf under that address in the epoch\'s earnings tree. That is all binding does. Whether such a leaf is ever payable on Base is a separate question and not this host\'s to answer: PEER has no mint, so every claim is a transfer out of the steward\'s own holdings, and an epoch becomes claimable only if the steward chooses to open and fund it. Credential required — whoever binds collects. Costs no energy. A root already published cannot change, so binding again replaces it forward only.', body: { as: 'id', pin: 'string — your PIN, or the passkey assertion object under `auth` if this handle is secured with a passkey and no PIN', address: '0x + 40 hex — paste it from your wallet, a typo cannot be detected here' } },
    { method: 'GET', path: '/api/v1/pools', purpose: 'liquidity pools: reserves, prices, and the acts that drive them — this is the in-log AMM; the real on-chain named pools, when a factory is configured, are under namedPools at GET /api/token/onchain' },
    { method: 'GET', path: '/api/v1/gatherings?past=1', purpose: 'the calendar: what is happening, when, where, the fee, and how many are going. Upcoming only unless past=1. NOTE the name — /api/v1/events is the act stream, this is the thing people turn up to.' },
    { method: 'GET', path: '/api/v1/markets?all=1', purpose: 'Prender Markets: every open bet with its answers, what is staked on each, the elected jury, the bond, the fee and the deadlines. Settled ones too with all=1. Read the content id from here — never derive it. Stakes and juries touch no standing.' },
    // Undiscoverable until now, which made it useless: proof of burn is the
    // ONLY source of weight in the PEER distribution since the faucet closed,
    // and a door nobody can find pays nobody. Sixty epochs had minted zero.
    { method: 'GET', path: '/api/burn', purpose: 'proof of burn: the dead address to send to, how many confirmations count, and what it does and does not buy. Destroying bitcoin at a provably unspendable output is the only thing that earns weight in the PEER distribution — the faucet buys energy to act, never a share of the mint.' },
    { method: 'POST', path: '/api/burn/claim', purpose: 'bind a burn you already made to your handle. The host checks the txid against two independent public block explorers, which must agree, and requires confirmations — then records it with the txid, so any reader can check the chain instead of believing this host.', body: { id: 'your handle id', txid: '64 hex characters', auth: 'your PIN' } },
    { method: 'POST', path: '/api/burn/intent', purpose: 'the same thing without holding a connection open. Say which burn is yours — by amount, by sending address, or both — and the host watches the address and credits the transaction when it confirms, whether or not you are still connected. Works before the send and afterwards, for a burn already on the chain. This is the reliable path: a claim needs you to be there at the moment it confirms, an intent does not.', body: { id: 'your handle id', auth: 'your PIN', txid: 'the transaction, if you already have it — the exact match, and it needs nothing else', sats: 'the amount you sent', from: 'the address you sent from — the strongest match short of a txid' } },
    { method: 'GET', path: '/api/burn/pending', purpose: 'what the watcher can see: intents still waiting, and every transaction the chain shows at the dead address that this log has not recorded. Nothing here is credited to anyone until an intent or a claim names it.' },
    { method: 'GET', path: '/api/v1/errors', purpose: 'every refusal this host can return: a stable code, why the rule exists, and what to do about it. Branch on `code`, not on the wording.' },
    { method: 'GET', path: '/api/v1/events?since=N&limit=M', purpose: 'acts after cursor N, decoded into plain language. The cheap way to stay in sync. Each event carries `node`: the content id that act minted (or, for a revision, wrote to) — read it from here, never derive it: the id counter also ticks for hyperedge legs (quotes, mentions), so client-side counting lands off by one and replies go nowhere.' },
    { method: 'POST', path: '/api/v1/gathering', purpose: 'host something: a time, a place, a fee, a cap — any of them optional', body: { text: 'what it is', at: 'unix ms, optional', place: 'string, optional', fee: 'number, optional', currency: 'symbol, default PEER', cap: 'number, optional' } },
    { method: 'POST', path: '/api/v1/rsvp', purpose: 'turn up, or stop turning up. A fee is the host’s to set and is attached for you — you never name your own price for someone else’s gathering.', body: { target: 'content id of the gathering', going: 'boolean, default true' } },
    { method: 'POST', path: '/api/v1/register', purpose: 'create an identity', body: { handle: 'string ≤16', pin: 'string ≥4 (strongly recommended)' } },
    { method: 'POST', path: '/api/v1/post', purpose: 'publish, or revise one of your own posts', body: { as: 'id', pin: 'string', text: 'string ≤1000', quote: 'optional content id', attachment: 'optional {h, m, n} from POST /api/media', attachments: 'optional ordered array of those, up to ' + MEDIA_MAX_ENTRIES + ' and ' + Math.round(MEDIA_MAX_ACT_BYTES / (1024 * 1024)) + ' MB in total — several audio files on one post are played as a playlist, in this order. One image entry may carry cv:1 to mark it as the album cover.', revise: 'optional content id — supersedes that post instead of minting a new one; it stays yours, keeps its comments and reactions, and the original record stays in the log' } },
    { method: 'POST', path: '/api/v1/comment', purpose: 'comment on a post OR on another comment', body: { as: 'id', pin: 'string', target: 'content id', text: 'string ≤1000', enthusiasm: 'optional -1..1', effort: 'optional -1..1' } },
    { method: 'POST', path: '/api/v1/react', purpose: 'react to content, or vouch for a person by targeting prof_<id>', body: { as: 'id', pin: 'string', target: 'content id or prof_id', polarity: 'optional -1..1', reaction: 'optional -1..1' } },
    { method: 'POST', path: '/api/v1/tag', purpose: 'tag content into the commons', body: { as: 'id', pin: 'string', target: 'content id', name: 'string ≤20' } },
    { method: 'POST', path: '/api/v1/message', purpose: 'direct message (public in the log, like everything)', body: { as: 'id', pin: 'string', to: 'id', text: 'string ≤500' } },
    { method: 'POST', path: '/api/v1/follow', purpose: 'follow or unfollow an account. Recorded in the log and deliberately absent from every score: following is attention, and this network measures transported commitment. It is free — it debits no reserve and raises no act count, because θ is itself a standing input and a follow must not move one.', body: { as: 'id', pin: 'string', to: 'id', on: 'optional boolean, false to unfollow' } },
    { method: 'POST', path: '/api/v1/profile', purpose: 'write your own description. Public like everything in the log, and in no score.', body: { as: 'id', pin: 'string', bio: 'string ≤280', link: 'optional http(s) URL ≤200', picture: 'optional media hash from POST /api/media — an image, at most ' + Math.round(PROFILE_PIC_MAX / 1024) + ' KB, shown beside your handle everywhere' } },
    { method: 'POST', path: '/api/v1/burn', purpose: 'GONE (410). The faucet it drove credited reserve from nothing. Use GET /api/burn and POST /api/burn/claim.' },
  ],
  limits: {
    acts: ACT_RATE + ' per minute per IP', reads: '600 per minute per IP',
    mediaUploads: MEDIA_RATE + ' per minute per IP', mediaPerPost: MEDIA_MAX_ENTRIES,
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
// 'follow' is in: a free follow is a free lever, and this is the one network
// where pulling a lever is meant to cost the puller something. 'profile' is
// NOT — editing your own description is a correction, and corrections are
// never gated on reserve here.
// 'stream' belongs here and was missing: replay.cjs debits a stream exactly
// like a post (debit(); weighHome()) and debit() has no floor, so a drained
// author could mint a Content node the host would refuse them as a post and
// drive their balance negative. That is precisely the defect this set was
// introduced to close, left open on one act kind.
const W1_GATED = new Set(['post', 'opinion', 'review', 'tag', 'dm', 'call', 'event', 'stream',
  // A bet mints a Content node exactly as a post does, so it is gated
  // exactly as a post is. Leaving it out would be the same defect this set
  // was introduced to close, reopened on one act kind.
  'market']);

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
  // APPENDED, never rewritten in place — learned from a real fault. The old
  // version edited the newest register/setPin act's pinHash where it stood,
  // reasoning the hash is "in no score, no edge and no certificate". True of
  // the replay; false of the CHAIN: the sealed block's structural hash covers
  // those exact bytes, and the first upgrade of an already-sealed act made
  // block 31 unverifiable ("the log was rewritten beyond lawful redaction")
  // — which then correctly froze every verify-then-publish pipeline. A
  // setPin act is the append-only way to say the same thing: pinIndex and
  // both replays already take the newest one in log order.
  for (const [id, fresh] of pinUpgrades) {
    const act = { t: 'setPin', id, pinHash: fresh, ts: Date.now() };
    acts.push(act);
    persist(act);
    pinIndex.set(id, fresh);
  }
  pinUpgrades.clear();
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
    if (!pinFailLimiter(ip)) return { error: 'too many wrong PIN attempts from this address — the lock lasts about ten minutes, and while it holds even the CORRECT PIN is refused. Wait it out rather than trying again.', code: 429, errorCode: 'PIN_ATTEMPTS' };
    // Credential refusals used to come back with a 401 and no `code` at all,
    // while every validate() refusal carried one — so the catalogue's own rule
    // ("branch on `code`, the wording may change") did not hold for exactly the
    // refusals a caller most needs to tell apart. "Set a PIN", "wrong PIN" and
    // "this handle takes a passkey, not a PIN" want three different next steps.
    return { error: aerr, code: 401, errorCode: classify(aerr) };
  }
  if (W1_GATED.has(act.t) && solvency && actorId) {
    const bal = solvency(actorId);
    if (bal !== null && bal < THETA_) {
      return {
        code: 402,
        // Named explicitly rather than left to classify(). This is the most
        // common refusal on the network — every bot meets it — and it spent
        // months answering with a bare sentence while GET /api/v1/errors
        // promised every refusal carries a code to branch on. Twice it was
        // reported fixed because the paths either side of it had been.
        errorCode: 'NO_ENERGY',
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
  if (act.t === 'setRecovery' && act.codeHash) recoveryIndex.set(act.id, act.codeHash);
  if (act.t === 'setKey') {
    const list = keyIndex.get(act.id) ?? [];
    if (act.credId === null) keyIndex.set(act.id, []);
    else keyIndex.set(act.id, list.filter((k) => k.credId !== act.credId).concat([{ credId: act.credId, cose: act.cose, signCount: act.signCount ?? 0, label: act.label ?? 'passkey' }]));
  }
  if (act.t === 'setPin') pinIndex.set(act.id, act.pinHash); // newest wins; enforced from now on
  if (act.t === 'closeEpoch') scheduleChainSeal();
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
      if ((a.t === 'post' || a.t === 'event' || a.t === 'market') && a.author === act.id && !a.redacted) redactPostAct(a, ai);
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

/**
 * A request body, as an object, or null.
 *
 * `null`, `7` and `"hello"` are all valid JSON documents and none of them has
 * fields. Every door in this file parsed a body and then read a field off it
 * immediately, so four bytes — the word `null` — threw a TypeError inside a
 * request handler and took the whole host down with it, from anywhere, with
 * no account and no PIN. Verified against the live host, which died.
 *
 * A throw is fatal either way here: in a sync handler it is an uncaught
 * exception, in an async one an unhandled rejection, and this process
 * installs no handler for either — deliberately, because a host in an unknown
 * state should die rather than keep writing to the log. So the parse has to
 * be the thing that cannot produce a surprise.
 */
function parseBody(body) {
  let v;
  try { v = JSON.parse(body); } catch { return null; }
  return (v && typeof v === 'object') ? v : null;
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
        ? 'Low energy: burn bitcoin to get more (GET /api/burn), or the network will refuse your next acts.'
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
  // ── One closed epoch's earnings, as something a wallet can act on ────────
  //
  // Everything here is DERIVED from the public log and nothing is authored by
  // this host: the amounts come from the replay's tokenDist, the addresses
  // from 'bindAddress' acts, the tree from chain/earnings.mjs and its root
  // from chain/merkle.mjs — the same module PeerClaim reads back on Base. So
  // the leaf list is returned in full, not only the caller's own leaf. That is
  // the point of the endpoint: a claimant can rebuild the root from the leaves,
  // check it against what was published on-chain, and discover for themselves
  // that this host computed the same thing rather than taking its word.
  //
  // The bindings used are the ones frozen AT THAT EPOCH'S CLOSE
  // (state.addressesAt), never today's. Somebody rebinding this morning must
  // not change what a root published last month commits to.
  if (req.method === 'GET' && /^epoch\/\d+\/claim$/.test(p)) {
    const n = Number(p.split('/')[1]);
    const dist = (st.tokens.dist || []).find((d) => d.epoch === n);
    if (!dist) {
      json(res, 404, { code: 'EPOCH_NOT_CLOSED',
        error: 'epoch ' + n + ' has not closed on this host — ' + st.tokens.epochN + ' epoch(s) have, so there is no distribution to prove yet' });
      return;
    }
    let tree;
    try {
      tree = earningsTree(dist, (st.addressesAt && st.addressesAt[n]) || {});
    } catch (e) {
      // Unreachable from the log this host wrote — every input was already
      // validated at the door — so it is reported as the fault it would be
      // rather than smoothed over into an empty tree somebody might publish.
      json(res, 500, { error: 'this epoch\'s earnings tree could not be built: ' + e.message });
      return;
    }
    // Who is asking. An explicit ?address wins over ?as, because the address is
    // what the contract pays and the handle is only a way of looking one up.
    const askedAddr = q.get('address');
    let who = '';
    let asked = null;
    if (askedAddr) {
      who = cleanAddress(askedAddr);
      if (!who) { json(res, 400, { code: 'BAD_ADDRESS', error: 'that is not an ethereum address: ' + String(askedAddr).slice(0, 60) }); return; }
    } else if (asId) {
      asked = asId;
      who = cleanAddress(((st.addressesAt && st.addressesAt[n]) || {})[asId] || '');
    }
    const leaf = who ? tree.leaves.find((l) => l.address === who) : null;
    const proof = leaf ? tree.proofs[leaf.address] : null;
    // Is any of this payable? A root, an amount and a proof are arithmetic over
    // the log and this host can always produce them; whether they are money is
    // a fact about Base that only Base can answer. This endpoint used to skip
    // the question entirely — it named no contract, never read PEER_CLAIM_ADDR,
    // and handed out `call: PeerClaim.claim(…)` in the shipped state where no
    // claim contract is configured at all. Two files away, onchain.mjs already
    // refuses to do that. The same refusal belongs here, because this is where
    // somebody decides to open their wallet.
    let onchain;
    try {
      const m = await import('./chain-l2/onchain.mjs');
      onchain = await m.epochOnChain(n);
    } catch (e) {
      onchain = { configured: null, error: 'this host could not check the chain (' + String(e.message).slice(0, 60) + ')' };
    }
    if (onchain && onchain.opened) {
      // Does the epoch on Base commit to the tree this host just computed? A
      // mismatch is the loudest fact available and is never smoothed over: it
      // means the published root came from a different log, a different
      // binding snapshot, or a different builder, and every proof below would
      // revert. Bare lowercase hex on both sides, so this is a string compare.
      onchain.rootMatches = onchain.root === tree.root;
      if (!onchain.rootMatches) {
        onchain.rootMismatch =
          'the root opened on-chain for this epoch is NOT the root this host computes from its log. Nothing below is claimable against it — do not spend gas on these proofs, and treat the difference as the thing to investigate.';
      }
    }
    // Payable RIGHT NOW: opened, still open, funded, matching, and a leaf to
    // claim. Anything less and `call` below stays a description rather than an
    // instruction.
    const payable = !!(leaf && onchain && onchain.open && onchain.rootMatches);
    json(res, 200, {
      epoch: n,
      // Both spellings of the same 32 bytes: bare hex is what chain/merkle.mjs
      // and the block certificates use, 0x-prefixed is what a wallet hands a
      // bytes32 argument. Neither is a different number.
      root: tree.root,
      root0x: '0x' + tree.root,
      // Raw 18-decimal units as a STRING. A uint256 does not survive JSON's
      // number type, and an epoch's earnings silently losing its low digits to
      // a double is exactly the arithmetic this whole pipeline exists to avoid.
      total: String(tree.total),
      totalPeer: tree.totalPeer,
      decimals: tree.decimals,
      minted: tree.minted,
      leafCount: tree.leaves.length,
      leaves: tree.leaves.map((l) => ({
        index: l.index, address: l.address, amount: String(l.amount), peer: l.peer,
        handles: l.handles, leaf: l.hex,
      })),
      unbound: {
        count: tree.unbound.handles.length,
        total: String(tree.unbound.total),
        totalPeer: tree.unbound.totalPeer,
        handles: tree.unbound.handles.map((u) => ({ id: u.id, handle: nameOf(st, u.id), amount: String(u.amount), peer: u.peer })),
        note: 'These handles earned this epoch and had no address bound when it closed, so they have NO LEAF in the tree and nothing to claim. Their share is not shared out among the others and is not held for them: it stays in the epoch\'s remainder and returns to whoever funded it when the claim window closes. Binding now takes effect from the NEXT epoch — a published root cannot change.',
      },
      claimant: leaf ? {
        as: asked, address: leaf.address, handles: leaf.handles,
        index: leaf.index, amount: String(leaf.amount), peer: leaf.peer, leaf: leaf.hex,
        // The bytes32[] argument itself: the path word first, then the
        // siblings, bottom of the tree first. Folded back to the root before
        // this answer was written (chain/earnings.mjs verifies every proof it
        // builds), so a proof that would revert on Base never leaves here.
        proof: proof.words,
        pathWord: proof.words[0],
        // TRUE only when this proof would be paid if sent now. It is not a
        // property of the proof — the proof is fine either way — it is a
        // property of whether anyone has funded this epoch on Base.
        payable,
        call: payable
          ? 'PeerClaim.claim(uint256 epoch, uint256 amount, bytes32[] proof) at ' + onchain.contract + ' — from THIS address and no other: the contract verifies the proof over msg.sender, so nobody can claim it for you, including you from a second wallet.'
          : 'PeerClaim.claim(uint256 epoch, uint256 amount, bytes32[] proof) is the call this proof is shaped for, and it is NOT payable right now — see `onchain` for which part is missing. Sending it would revert and cost you the gas. The proof is verified over msg.sender, so when it does become payable it is claimable from THIS address and no other.',
      } : null,
      claimantNote: leaf ? null
        : (askedAddr ? 'That address has no leaf in this epoch: nothing was bound to it when the epoch closed, or the handle that bound it earned nothing.'
          : asked ? (who ? 'That handle had an address bound but earned nothing this epoch.'
            : 'That handle had no address bound when this epoch closed, so it has no leaf here. POST /api/v1/bind to bind one; it takes effect from the next epoch close.')
            : 'Pass ?as=<handle id> or ?address=0x… to get that claimant\'s amount and proof.'),
      // What Base says about this epoch, or plainly that nothing was asked.
      onchain,
      onchainIs: 'Everything above this line is derived from the act log and would be the same on any host replaying it. This block is the other question: has anybody actually put PEER behind it? PEER has no mint, so every claim is a transfer out of the steward\'s own holdings, and an epoch is claimable only if the steward chose to open and fund it. A tree without an open epoch is a correct answer to "what did the log credit me", and no answer at all to "can I collect".',
      how: 'The tree is built by chain/earnings.mjs over chain/merkle.mjs — SHA-256 over lowercase hex strings, leaves domain-separated with "L", interior nodes with "N", an odd node carried up. A leaf is the 40 hex chars of the address followed by the 64 hex chars of the amount in raw units. Rebuild it from `leaves` yourself and compare the root with the one on-chain; that check is the whole reason this endpoint returns every leaf and not just yours. Sum `leaves` against the epoch\'s on-chain `totalRaw` too: no contract can add a tree\'s leaves up, so a root that oversums its deposit pays first-come and reverts for everyone after — and that is checkable here, before the first claim, or not at all.',
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
  // Every bet, drawn from st.markets — the same map the interface reads, so a
  // bot and a person can never be shown different odds, a different jury, or a
  // different answer. The seats come from the replay's own election function
  // rather than from a second count that could disagree with it.
  if (req.method === 'GET' && p === 'markets') {
    const now = Date.now();
    const open = q.get('all') !== '1';
    const rows = Object.entries(st.markets || {}).map(([cid, m]) => {
      const seats = st.marketSeats(m);
      return {
        id: cid,
        by: m.by, handle: nameOf(st, m.by),
        text: st.payloads[cid] ?? null,        // null once the question is redacted
        answers: m.opts.map((label, i) => ({
          n: i, label: label || null,
          staked: m.totals[i],
          // The only "odds" this network will state: a share of the pool. It
          // is not a probability and it is not a price — it is what fraction
          // of the money is on this answer right now.
          shareOfPool: m.pool > 0 ? m.totals[i] / m.pool : 0,
        })),
        currency: m.cur, pool: m.pool, feeBp: m.feeBp, bond: m.bond, seats: m.seats,
        closesAt: m.at || null,
        juryDeadline: m.at ? m.at + marketResolveMs(st) : null,
        betting: m.state === 'open' && !!m.at && m.at > now,
        state: m.state,
        outcome: m.outcome >= 0 ? m.outcome : null,
        nominated: m.nominees,
        standing: Object.keys(m.cands).map((id) => ({
          id, handle: nameOf(st, id), bond: m.cands[id],
          votes: seats.weight[id] || 0, seated: seats.seated.indexOf(id) >= 0,
          certified: m.attests[id] === undefined ? null : m.attests[id],
        })).sort((a, b) => b.votes - a.votes),
        struck: m.struck, paid: m.paid, refunded: m.refunded, earned: m.earned,
      };
    }).filter((m) => (open ? m.state === 'open' : true))
      .sort((a, b) => (a.closesAt ?? Infinity) - (b.closesAt ?? Infinity));
    json(res, 200, {
      markets: rows, now,
      how: 'Ask one with POST /api/act {t:"market", text, opts:[2..7], cur, at, seats:1|3|5, bond, feeBp, mods?}. '
        + 'Back one with {t:"bet", cid, opt, amt}. Stand for a seat with {t:"modStand", cid, on}, elect with '
        + '{t:"modVote", cid, for:[ids]}, certify with {t:"attest", cid, opt} (opt -1 = void), and after the jury '
        + 'deadline anyone may {t:"marketVoid", cid}. Every one costs θ like any act.',
      note: 'Stakes and bonds are value and touch no standing: no market act appends an edge, compiles a vouch, '
        + 'or enters an epoch certificate. Ballots are weighed by satoshis the voter proved they destroyed.',
    });
    return;
  }
  // What is happening, for anyone who cannot see the Events tab. Same source
  // the interface draws from — st.events — so a bot and a person cannot be
  // told different things about when something starts or whether it is full.
  if (req.method === 'GET' && p === 'gatherings') {
    const now = Date.now();
    const past = q.get('past') === '1';
    const rows = Object.entries(st.events || {}).map(([cid, ev]) => {
      const going = Object.keys((st.eventGoing && st.eventGoing[cid]) || {});
      return {
        cid,
        host: ev.host,
        handle: st.handles[ev.host] || ev.host,
        text: st.payloads[cid] ?? null,   // null once the payload is removed
        at: ev.at ?? null,
        place: ev.place ?? null,
        fee: ev.fee ?? 0,
        currency: ev.cur ?? null,
        cap: ev.cap ?? null,
        going: going.length,
        full: typeof ev.cap === 'number' && ev.cap > 0 && going.length >= ev.cap,
        invitedOnly: !!(st.eventInvites && st.eventInvites[cid]),
        upcoming: typeof ev.at === 'number' ? ev.at > now : true,
      };
    }).filter((e) => (past ? true : e.upcoming))
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    json(res, 200, {
      gatherings: rows,
      now,
      how: 'Host one with POST /api/v1/gathering {text, at?, place?, fee?, currency?, cap?}; turn up with POST /api/v1/rsvp {target, going?}. A fee is the host’s to set — rsvp attaches it for you. Both cost θ like any act. This is the calendar; /api/v1/events is the act stream.',
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
  // The credential for every write on this door: `pin` as a string, or a
  // passkey assertion object under `auth` (or under `pin`, for a caller who
  // only knows the one field name). It read `body.pin` as a string and nothing
  // else, so a handle secured with a passkey and no PIN could not reach a
  // single endpoint here — including /api/v1/bind, the one act that decides
  // where its epoch earnings are paid. What it can carry is exactly what
  // authError can check; nothing new is trusted.
  const assertion = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const pin = typeof body.pin === 'string' ? body.pin
    : (assertion(body.auth) ?? assertion(body.pin) ?? '');
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
    // One attachment, or an ordered list of them — several audio files on one
    // post are played as a playlist, and the order is the array's order.
    if (Array.isArray(body.attachments)) raw.media = body.attachments;
    else if (body.attachment) raw.media = [body.attachment];
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
  // Gatherings, and joining one.
  //
  // The network has had `event`, `invite` and `rsvp` acts and an Events tab
  // for a long time, and the bot API could reach none of them: a resident
  // could read the feed and post to it but could not see that anything was
  // happening, let alone turn up. That is not a missing convenience, it is
  // the bot API and the human interface disagreeing about what this network
  // contains — the same class of divergence as an economy only the client
  // believes in. (`/api/v1/events` is the ACT STREAM and keeps that name;
  // gatherings live here, because renaming a documented endpoint would break
  // every bot that follows the log.)
  if (p === 'gathering') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { json(res, 400, { error: 'text is required: what the gathering is' }); return; }
    const raw = { t: 'event', author: me, text };
    if (body.at !== undefined) {
      const at = Number(body.at);
      if (!isFinite(at) || at <= 0) { json(res, 400, { error: 'at must be a unix timestamp in milliseconds' }); return; }
      raw.at = at;
    }
    if (typeof body.place === 'string' && body.place.trim()) raw.place = body.place.trim();
    if (body.fee !== undefined) { raw.fee = Number(body.fee); raw.cur = String(body.currency || body.cur || 'PEER'); }
    if (body.cap !== undefined) raw.cap = Number(body.cap);
    submit(raw); return;
  }
  if (p === 'rsvp') {
    if (!body.target) { json(res, 400, { error: 'target is required: the content id of the gathering' }); return; }
    const meta = st.postMeta[String(body.target)];
    if (!meta) { json(res, 404, { error: 'no such gathering: ' + body.target }); return; }
    const raw = { t: 'rsvp', from: me, cid: String(body.target), on: body.going !== false };
    // A paid gathering needs the fee attached, and the amount is the host's
    // to set — a caller naming their own price would be paying whatever they
    // felt like for a thing somebody else priced.
    const ev = st.events && st.events[String(body.target)];
    if (ev && ev.fee > 0 && raw.on) {
      raw.amt = ev.fee;
      raw.cur = ev.cur || 'PEER';
      raw.to = ev.host;
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
  if (p === 'rsvpEvent') {
    if (!body.cid) { json(res, 400, { error: 'cid is required: the event id' }); return; }
    submit({ t: 'rsvp', from: me, cid: String(body.cid), on: body.on === false ? false : true,
      amt: num(body.amount, 0), cur: typeof body.currency === 'string' ? body.currency : '', to: typeof body.to === 'string' ? body.to : '' });
    return;
  }
  if (p === 'follow') {
    if (!body.to) { json(res, 400, { error: 'to is required: the handle id to follow' }); return; }
    submit({ t: 'follow', from: me, to: String(body.to), on: body.on === false ? false : true });
    return;
  }
  if (p === 'profile') {
    submit({ t: 'profile', id: me, bio: typeof body.bio === 'string' ? body.bio : '',
      link: typeof body.link === 'string' ? body.link : '',
      pic: typeof body.picture === 'string' ? body.picture : '' });
    return;
  }
  if (p === 'message') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!body.to || !text) { json(res, 400, { error: 'to and text are required' }); return; }
    submit({ t: 'dm', from: me, to: String(body.to), text });
    return;
  }
  // Say where this handle's epoch earnings are payable on Base.
  //
  // Not routed through submit(), and the difference is not cosmetic: submit()
  // answers "This cost θ", and this act costs none. A binding debits nothing
  // and is not W1-gated, because an account that earned a share and then ran
  // out of reserve must still be able to say where that share goes — earning
  // needs no reserve and speaking does, so the two run out at different times.
  // What guards it instead is the PIN: bindAddress is in PIN_REQUIRED, so an
  // unsecured handle is refused rather than waved through, and the act carries
  // its actor in `id` so authError checks the credential of the handle whose
  // money this decides.
  if (p === 'bind') {
    const given = typeof body.address === 'string' ? body.address : (typeof body.addr === 'string' ? body.addr : '');
    if (!given.trim()) {
      json(res, 400, { code: 'BAD_ADDRESS', error: 'address is required: the ethereum address on Base your epoch earnings should be paid to' });
      return;
    }
    const out = applyAct(sanitize({ t: 'bindAddress', id: me, addr: given }), pin, ip);
    if (out.error) { json(res, out.code, { error: out.error, code: out.errorCode }); return; }
    json(res, 200, {
      ok: true, as: me, address: given.trim().toLowerCase(), actIndex: out.index, cursor: acts.length,
      effectiveFrom: st.tokens.epochN + 1,
      note: 'Bound. This cost no energy, and it changes nothing about epochs that have already closed: their earnings roots are published and cannot be recomputed. From epoch ' + (st.tokens.epochN + 1) + ' on, your share is a leaf under this address. Bind again whenever you like — the newest binding wins, forward only.',
      warning: 'Whoever can act as this handle can move this binding, and whoever holds the address collects. Nothing here can check that the address is yours, or that it is not a typo — the checksum a wallet shows is keccak-based and this codebase hashes with no library. Read it back from GET /api/v1/epoch/<n>/claim?as=' + me + ' after the next epoch closes.',
    });
    return;
  }
  // The faucet route, kept only to explain itself.
  //
  // It submitted a `burn` act, which the door refuses, so it could only
  // ever answer 400 - and the API document, the low-energy warning and
  // four bots in this repo all still drove it. A dead route that four
  // callers believe in is worse than a missing one: every retry looked
  // like a transient failure.
  json(res, 410, { code: 'FAUCET_GONE',
    error: 'the reserve faucet is gone - it credited reserve from nothing',
    why: 'Reserve is what every act is debited from, and it now comes only from bitcoin destroyed at an address with no key, proven by a transaction id anyone can check.',
    fix: 'GET /api/burn for the address and terms, then POST /api/burn/claim {id, txid, auth} once the transaction confirms.' });
  return;

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
  const chainNow = chainHeadInfo();
  return {
    // The election candidacy, in the open: every number a peer would rank
    // this host by is served from the same door anyone can read, so the
    // ordering is checkable by whoever cares to check it.
    election: {
      nodeId: electionState.nodeId,
      chainHeight: chainNow.height,
      chainHead: chainNow.hash,
      acts: acts.length,
      active: activeAuthors(acts, Date.now()),
      quarantine: role.quarantine,
      primary: role.mirrorOf || null,
      writer: electionState.lastWriter,
    },
    host: {
      uptimeSec: Math.round((Date.now() - OPS_STARTED) / 1000),
      role: role.mirrorOf ? 'mirror' : 'primary',
      mirrorOf: role.mirrorOf || null,
      mirrorInSync: role.mirrorOf ? mirrorState.ok : null,
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
      stream: streamHub.stats(),
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

// /api/token/onchain answers from this cache for 30 seconds. Every open tab
// renders the token panel, every render used to be a full round of eth_calls
// to a public RPC, and the chain does not change fast enough to justify
// asking mainnet.base.org the same questions once per tab per render. The
// per-account lookups (?of=) deliberately stay outside the cache: a cached
// balance — or a cached "you already claimed epoch 12" — would show one
// viewer's wallet to everyone who asked within the same 30 seconds. They are
// a handful of cheap calls, capped inside onchain.mjs and paid for by the
// read limiter this door spends like every other GET.
//
// `inFlight` is the other half of that, and the half a cache is usually
// missing. A cold cache with twenty tabs arriving at once used to start
// twenty full rounds — a pool scan each, dozens of calls apiece — because
// every one of them checked the cache before any of them had filled it.
// The refresh is one promise now: the first caller starts it, everyone else
// waits on the same one, and the endpoint's load stops depending on how
// many people opened the page in the same second.
let onchainCache = { at: 0, value: null, inFlight: null };

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
    const body = JSON.stringify({ acts: acts.slice(since), total: acts.length, mirror: role.mirrorOf || null });
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
  // The election candidacy, on its own engine-free door. The first federated
  // drill promoted a mirror OVER A LIVE PRIMARY because the probe rode on
  // /api/v1/state, which answers 503 while the engine bundle loads — a
  // healthy host looked dead to the one question where looking dead changes
  // who holds the pen. A liveness probe must depend on nothing heavier than
  // the thing it certifies.
  if (req.method === 'GET' && url.pathname === '/api/election') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down — too many requests' }); return; }
    const chainNow = chainHeadInfo();
    json(res, 200, {
      nodeId: electionState.nodeId,
      chainHeight: chainNow.height,
      chainHead: chainNow.hash,
      acts: acts.length,
      active: activeAuthors(acts, Date.now()),
      quarantine: role.quarantine,
      primary: role.mirrorOf || null,
      writer: electionState.lastWriter,
    });
    return;
  }
  // The epoch chain, published. blocks.jsonl is every sealed block in height
  // order; HEAD.json names the tip and the producer key. Anyone holding
  // /api/acts and these files can run `node chain/verify.mjs` and needs no
  // further word from this host — that is the point of publishing them.
  if (req.method === 'GET' && (url.pathname === '/api/chain' || url.pathname === '/api/chain/head')) {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down — too many requests' }); return; }
    const isHead = url.pathname === '/api/chain/head';
    const file = resolve(DATA_DIR, 'chain', isHead ? 'HEAD.json' : 'blocks.jsonl');
    if (!existsSync(file)) {
      json(res, 404, { code: 'NO_CHAIN', error: 'no epoch has been sealed on this host yet — the chain appears at the first closeEpoch after this feature shipped, or after `node chain/build.mjs`' });
      return;
    }
    const body = readFileSync(file);
    const type = isHead ? 'application/json' : 'application/x-ndjson';
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && body.length > 1024;
    if (wantsGzip) {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', ...SECURITY_HEADERS });
      res.end(gzipSync(body));
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/media') {
    if (!mediaLimiter(ip)) { json(res, 429, { error: 'upload limit — ' + MEDIA_RATE + ' files a minute from one address; try again in a minute' }); return; }
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
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/media\/[a-f0-9]{64}$/.test(url.pathname)) {
    const hash = url.pathname.slice('/api/media/'.length);
    const file = join(MEDIA_DIR, hash);
    try {
      const meta = JSON.parse(readFileSync(file + '.meta', 'utf8'));
      const buf = readFileSync(file);
      // Range, because a playlist is long audio and a seek used to re-download
      // the whole track: the route answered 200 with the full body to every
      // request, Range header or not. Safari goes further and refuses to play
      // media at all from a source that will not answer 206.
      const rng = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
      if (rng && req.method === 'GET') {
        let start = rng[1] === '' ? null : Number(rng[1]);
        let end = rng[2] === '' ? null : Number(rng[2]);
        if (start === null && end === null) { start = 0; end = buf.length - 1; }
        else if (start === null) { start = Math.max(0, buf.length - end); end = buf.length - 1; }
        else if (end === null) { end = buf.length - 1; }
        end = Math.min(end, buf.length - 1);
        if (start > end || start >= buf.length) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length, ...SECURITY_HEADERS });
          res.end();
          return;
        }
        const slice = buf.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': meta.mime,
          'Content-Length': slice.length,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.length,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: '"' + hash.slice(0, 16) + '"',
          ...SECURITY_HEADERS,
          'Content-Security-Policy': 'sandbox',
        });
        res.end(slice);
        return;
      }
      // content-addressed ⇒ immutable: clients and proxies may cache forever
      res.writeHead(200, {
        'Content-Type': meta.mime,
        'Content-Length': buf.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: '"' + hash.slice(0, 16) + '"',
        ...SECURITY_HEADERS,
        // stored bytes are untrusted payload: never let them script or navigate
        'Content-Security-Policy': 'sandbox',
        'Content-Disposition': meta.mime.startsWith('image/') || meta.mime.startsWith('video/') || meta.mime.startsWith('audio/') ? 'inline' : 'attachment',
      });
      // HEAD answers the headers and nothing else — it is how a reader learns
      // what a download will cost without paying for it.
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
    return;
  }
  // Where a burn becomes a record. The person sends coins to the dead address
  // themselves, from their own wallet — this host never touches money, holds
  // no key, and could not move a satoshi if it wanted to — and then hands in
  // the txid. Everything after that is verification.
  if (req.method === 'POST' && url.pathname === '/api/burn/claim') {
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down', code: 'RATE_LIMIT' }); return; }
    if (mirrorRefuse(res)) return;
    if (!BURN_ADDRESS) {
      json(res, 404, { code: 'BURN_OFF', error: 'proof of burn is not switched on for this host',
        why: 'no burn address is configured, so there is nothing to verify against and nothing to send to.' });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let b;
      b = parseBody(body);
      if (!b) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
      const id = String(b.id || '').slice(0, 24);
      const txid = String(b.txid || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(txid)) { json(res, 400, { code: 'BAD_TXID', error: 'a Bitcoin txid is 64 hex characters' }); return; }
      await ensureEngine();
      if (!handleExists(id)) { json(res, 404, { code: 'NO_SUCH_HANDLE', error: 'no such handle: ' + id }); return; }
      // The PIN, exactly as every other act by a secured handle needs it —
      // otherwise a stranger could bind a burn they watched on the chain to
      // an account that is not theirs.
      const aerr = authError({ t: 'btcBurn', id, auth: typeof b.auth === 'string' ? b.auth : '' });
      if (aerr) { json(res, 401, { code: 'PIN_REQUIRED', error: aerr }); return; }
      // Claimed once, ever — checked against the log itself, which is the
      // only record that survives a restart.
      for (const a of acts) {
        if (a && a.t === 'btcBurn' && a.txid === txid) {
          json(res, 409, { code: 'BURN_ALREADY_CLAIMED', error: 'that transaction is already recorded' + (a.id === id ? ' — for this handle' : ' for another handle') });
          return;
        }
      }
      const v = await verifyBurnTx(txid);
      if (!v.ok) { json(res, 400, { code: 'BURN_UNVERIFIED', error: v.why }); return; }
      // Asked again, immediately before the write, with nothing awaited in
      // between — which is what makes it decisive on a single thread. The
      // check further up only saves an explorer round trip; verifyBurnTx
      // spends seconds on the network, and the watcher is now a second minter
      // that can put this very txid in the log during that window. The
      // watcher has always re-checked here; this door did not, and the two
      // together could credit one burn twice, to two different handles.
      if (claimedTxids().has(txid)) {
        json(res, 409, { code: 'BURN_ALREADY_CLAIMED',
          error: 'that transaction was recorded while this claim was being checked' });
        return;
      }
      // The role, for the same reason: mirrorRefuse ran before the network
      // wait, and an election can demote this host during it.
      if (isMirror() || role.quarantine) { mirrorRefuse(res); return; }
      // Minted here rather than through applyAct: `validate` refuses btcBurn
      // at every door on purpose, so that a client cannot declare its own
      // burn. This is the one place allowed to write one, and only after
      // verifyBurnTx said yes.
      mintInternal({ t: 'btcBurn', id, txid, sats: v.sats, addr: BURN_ADDRESS, ts: Date.now() });
      json(res, 200, { ok: true, sats: v.sats, txid, address: BURN_ADDRESS, blockHeight: v.height,
        note: 'recorded. The coins are gone — this address has no key and never had one. Anyone can check this txid against the chain.' });
    });
    return;
  }
  // Say in advance — or afterwards — which burn is yours, and stop watching.
  //
  // This is the door that makes closing the tab safe. It writes nothing to
  // the log and grants nothing: an intent is a statement, and the watcher
  // still puts the transaction through the same two-explorer verification a
  // hand-filed claim goes through before a satoshi is credited.
  if (req.method === 'POST' && url.pathname === '/api/burn/intent') {
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down', code: 'RATE_LIMIT' }); return; }
    if (mirrorRefuse(res)) return;
    if (!BURN_ADDRESS) {
      json(res, 404, { code: 'BURN_OFF', error: 'proof of burn is not switched on for this host',
        why: 'no burn address is configured, so there is nothing to watch for.' });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let b;
      b = parseBody(body);
      if (!b) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
      await ensureEngine();
      const id = String(b.id || '').slice(0, 24);
      const sats = Math.floor(Number(b.sats) || 0);
      const fromRaw = String(b.from || '').trim();
      // bech32 is case-insensitive and a BIP-173 QR payload is uppercase, but
      // every explorer reports scriptpubkey_address in lower case — so an
      // uppercase address passes its checksum, is stored verbatim, and then
      // never equals anything for as long as the intent lives. The owner is
      // told the host is watching, and it is watching for a string that
      // cannot occur. base58 IS case-sensitive, so only bech32 may be folded.
      const from = /^(bc1|tb1)/i.test(fromRaw) ? fromRaw.toLowerCase() : fromRaw;
      const wantTxid = String(b.txid || '').trim().toLowerCase();
      if (wantTxid && !/^[a-f0-9]{64}$/.test(wantTxid)) {
        json(res, 400, { code: 'BAD_TXID', error: 'a Bitcoin txid is 64 hex characters' });
        return;
      }
      if (from && !validBtcAddress(from)) {
        json(res, 400, { code: 'BAD_ADDRESS', error: 'that sending address fails its own checksum' });
        return;
      }
      // One of the three, or the intent describes every burn ever made and
      // would adopt a stranger's.
      if (!wantTxid && !from && !(sats > 0)) {
        json(res, 400, { code: 'BURN_INTENT_VAGUE',
          error: 'an intent needs the txid, the amount in satoshi, the sending address, or some combination — otherwise it matches anybody\'s burn' });
        return;
      }
      if (!handleExists(id)) { json(res, 404, { code: 'NO_SUCH_HANDLE', error: 'no such handle: ' + id }); return; }
      // The same PIN as the claim it replaces. Anything less and an intent
      // would be a way to be credited for other people's burns while they
      // were still in the mempool.
      const aerr = authError({ t: 'btcBurn', id, auth: typeof b.auth === 'string' ? b.auth : '' });
      if (aerr) { json(res, 401, { code: 'PIN_REQUIRED', error: aerr }); return; }
      // authError waves through a handle that has no PIN at all — there is
      // nothing to check against — which would let anyone file intents FOR
      // somebody else's unsecured handle: filling their quota, and taking
      // credit into an account they do not control. A handle that money is
      // going to be credited into has to be one somebody can prove they own,
      // the same rule contact addresses already follow.
      if (!pinIndex.has(id)) {
        json(res, 401, { code: 'PIN_REQUIRED',
          error: 'set a PIN on this handle before burning into it — without one, nothing distinguishes you from anyone else naming it' });
        return;
      }
      const now = Date.now();
      const mine = intents.filter((i) => i.id === id && !i.txid && now - i.ts < BURN_INTENT_TTL_MS);
      if (mine.length >= 20) {
        json(res, 429, { code: 'TOO_MANY_INTENTS',
          error: 'you already have 20 burns pending — they expire on their own, or one of them is not coming' });
        return;
      }
      // Filing the same description twice is not worth a refusal — the log
      // already refuses to credit one burn twice — but stacking duplicates
      // leaves dead intents behind, and a dead intent is one that adopts
      // somebody else's next burn of the same size. Reuse the pending one.
      let it = intents.find((i) => !i.txid && i.id === id
        && (i.wantTxid || '') === wantTxid
        && (i.from || '') === (from || '')
        && (i.sats || 0) === (sats > 0 ? sats : 0));
      // Keeping the ORIGINAL timestamp, not refreshing it. When the intent
      // was first filed is evidence — it is what says this was described
      // before the burn was on the chain — and re-stating the same thing
      // should never cost the person who said it first their place.
      if (!it) {
        it = { id, sats: sats > 0 ? sats : 0, from: from || '', wantTxid: wantTxid || '', ts: now, txid: null };
        intents.push(it);
      }
      saveIntents();
      // Ask straight away rather than at the next tick: for a burn that is
      // already confirmed on the chain, the credit lands inside this request
      // and the answer below can already say so.
      burnTick().then(() => {
        json(res, 200, {
          ok: true, watching: true, address: BURN_ADDRESS,
          credited: it.txid ? { txid: it.txid, sats: it.sats, matchedBy: it.by || null } : null,
          note: it.txid
            ? 'that burn is on the chain and is now recorded — the reserve is yours.'
            : 'the host is watching the address. When the transaction confirms it is credited to ' + id
              + ' with nothing open on your side. You can close this.',
          expiresInHours: Math.round(BURN_INTENT_TTL_MS / 3600_000),
        });
      });
    });
    return;
  }
  // What the watcher can see. Open intents carry no PIN and never did — this
  // is the same list the host matches against, published so nobody has to
  // trust a spinner. Unmatched burns are listed too: a burn nobody has
  // claimed is a fact about a public address, and hiding it would only hide
  // it from the person who made it.
  if (req.method === 'GET' && url.pathname === '/api/burn/pending') {
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down', code: 'RATE_LIMIT' }); return; }
    if (!BURN_ADDRESS) { json(res, 404, { code: 'BURN_OFF', error: 'proof of burn is not switched on for this host' }); return; }
    const now = Date.now();
    const open = intents.filter((i) => !i.txid && now - i.ts < BURN_INTENT_TTL_MS)
      .map((i) => ({ id: i.id, sats: i.sats || null, from: i.from || null, txid: i.wantTxid || null, ts: i.ts }));
    burnAddressTxs().then((txs) => {
      const claimed = claimedTxids();
      const unclaimed = (txs || []).filter((t) => !claimed.has(t.txid))
        .map((t) => ({ txid: t.txid, sats: t.sats, confirmed: t.confirmed, time: t.time, from: t.from }));
      json(res, 200, {
        address: BURN_ADDRESS,
        watching: open.length,
        open,
        unclaimed,
        lastTick: burnWatch.last || null,
        lastError: burnWatch.lastError,
        creditedSinceStart: burnWatch.credited,
        note: 'An unclaimed transaction is one the chain shows and this log does not. It is credited to whoever files an intent or a claim for it — POST /api/burn/intent {id, auth, txid|sats|from} — and to nobody otherwise.',
        howItIsDecided: 'An intent filed BEFORE the block carrying the transaction outranks anything filed after it, because everything else an intent can state — the txid, the amount, the paying wallet — is public here and on any explorer, and only saying it first cannot be copied. Among intents filed after the fact this is first-come, exactly as POST /api/burn/claim has always been. If a burn of yours is listed here, claim it now rather than later.',
      });
    }).catch(() => json(res, 502, { code: 'EXPLORER_UNREACHABLE', error: 'could not read the address from any explorer' }));
    return;
  }
  // The token as it exists on the chain, not as this host wishes it existed.
  // Read-only by construction: chain-l2/onchain.mjs contains no signing code
  // and accepts no key, so this door cannot move value however it is called.
  if (req.method === 'GET' && url.pathname === '/api/token/onchain') {
    // The same read limiter every other GET on this router spends. The 30s
    // cache below covers the pool scan, but ?of= deliberately sits OUTSIDE
    // it — one uncached eth_call per request, aimed at a public RPC on
    // someone else's rate limit — so an unlimited door here lets one client
    // spend the host's endpoint quota walking a list of addresses.
    if (!readLimiter(ip)) { json(res, 429, { error: 'slow down — too many requests', code: 'RATE_LIMIT' }); return; }
    import('./chain-l2/onchain.mjs').then(async (m) => {
      if (!m.L2_ON) {
        json(res, 404, { code: 'ONCHAIN_OFF', deployed: false,
          error: 'no on-chain token is configured for this host',
          why: 'PEER_TOKEN_ADDR is unset. An address baked into source is one nobody verified, so this stays off until an operator points it at a deployment they made themselves.' });
        return;
      }
      const q = url.searchParams.get('of');
      const now = Date.now();
      let state = onchainCache.value;
      if (!state || now - onchainCache.at >= 30_000) {
        if (!onchainCache.inFlight) {
          const p = m.tokenState();
          onchainCache.inFlight = p;
          p.then(
            (v) => { onchainCache = { at: Date.now(), value: v, inFlight: null }; },
            // A failed refresh must not wedge the door shut: clear the slot
            // so the next request tries again, and let every waiter see the
            // same error (the 502 below).
            () => { onchainCache.inFlight = null; },
          );
        }
        state = await onchainCache.inFlight;
      }
      // Compose onto a fresh object, never onto the cached one: attaching
      // an account balance to the shared state would hand it to every other
      // viewer for the rest of the cache window.
      //
      // Everything the chain says about the epoch contracts — the anchors,
      // and each recent epoch's root, total, paid and deadline — is already
      // inside `state`, because it is the same answer for everybody and
      // belongs in the same 30-second cache as the pool scan that pays for
      // it. Only the per-account questions are asked per request.
      const out = { deployed: true, ...state };
      if (q) {
        // If the state above is a refusal — the RPC answered for a chain
        // this host does not claim — then a balance read from that same
        // endpoint does not become trustworthy by sitting in a different
        // field. This body used to say both at once: "refusing to report
        // its numbers" and, underneath, a number. Say it once.
        if (state && state.chainIdMatches === false) {
          out.account = { read: false, error: 'not read — ' + state.error };
        } else {
          out.account = await m.balanceOf(q);
          // Has this address already claimed the epochs on screen? That is
          // one viewer's business, so it hangs off `account` with the balance
          // rather than being folded into claimState — a claimed flag written
          // into the cached epoch rows would be answered from the first
          // asker's wallet for everyone who asked in the next thirty seconds.
          // The epochs asked about are exactly the ones this body reports, so
          // the two can never describe different sets.
          const eps = state && state.claimState && Array.isArray(state.claimState.epochs)
            ? state.claimState.epochs.map((e) => e.epoch)
            : [];
          const claims = eps.length ? await m.claimsOf(q, eps) : null;
          if (claims) out.account = out.account ? { ...out.account, claims } : { address: claims.address, claims };
        }
      }
      json(res, 200, out);
    }).catch((e) => json(res, 502, { code: 'L2_UNREACHABLE', error: 'could not read the chain: ' + String(e.message).slice(0, 120) }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/burn') {
    json(res, 200, {
      accepting: !!BURN_ADDRESS,
      address: BURN_ADDRESS || null,
      minConfirmations: BURN_MIN_CONF,
      watching: !!BURN_ADDRESS,
      whatThisIs: BURN_ADDRESS
        ? 'Send from your own wallet to this address and the coins are destroyed — it is a P2WSH output committing to the script OP_RETURN, which can never be satisfied, so no key exists and none ever did. Tell the host it is yours with POST /api/burn/intent {id, auth, sats, from} — before or after you send — and it watches the address and credits you when the transaction confirms, with nothing left open on your side. POST /api/burn/claim {id, txid, auth} still works if you have the txid in hand. Either way the host verifies against two independent public explorers before recording anything. What you get is weight in the PEER distribution, which is play money on a test network. You are not buying anything and nothing is redeemable.'
        : 'Proof of burn is not switched on for this host.',
      verifyItYourself: BURN_ADDRESS
        ? 'sha256 of the single byte 0x6a is the witness program; address = bech32(hrp "bc", version 0, that hash).'
        : null,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    if (!actLimiter(ip)) { json(res, 429, { error: 'slow down — the network accepts at most ' + ACT_RATE + ' acts per minute from one place', code: 'RATE_LIMIT' }); return; }
  if (mirrorRefuse(res)) return;
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_ACT_BYTES * 2) req.destroy(); });
    req.on('end', () => {
      let act;
      act = parseBody(body);
      if (!act) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
      // Client's known log length: reply with just the tail it is missing.
      const since = Math.max(0, Number(act.since ?? 0) || 0);
      delete act.since;
      // A PIN string, or a passkey assertion object. The object used to be
      // discarded here — `typeof act.auth === 'string' ? act.auth : ''` — so
      // authError's assertion branch was unreachable from the main write door
      // and a passkey could authorise nothing but its own registration. It is
      // never persisted either way: sanitize() strips `auth` on the next line,
      // and only this local copy reaches the credential check.
      const auth = typeof act.auth === 'string' ? act.auth
        : (act.auth && typeof act.auth === 'object' && !Array.isArray(act.auth) ? act.auth : '');
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
      msg = parseBody(body);
      if (!msg) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
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
  // ── Live-stream relay ──────────────────────────────────────────────────
  //
  // Opening a stream is a POST because it needs the account's PIN once, and a
  // credential belongs in a request body rather than in a socket URL. What
  // comes back is a short-lived key; the media socket presents that instead.
  if (req.method === 'POST' && url.pathname === '/api/stream/open') {
    if (mirrorRefuse(res)) return;
    if (!signalLimiter(ip)) { json(res, 429, { code: 'RATE_LIMIT', error: 'slow down' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m;
      m = parseBody(body);
      if (!m) { json(res, 400, { code: 'BAD_REQUEST', error: 'invalid JSON: expected an object' }); return; }
      const as = typeof m.as === 'string' ? m.as : '';
      if (!as || as.length > 24) { json(res, 400, { code: 'BAD_REQUEST', error: 'bad handle' }); return; }
      // authError lets a handle with no PIN through, which is right for a post
      // and wrong for a broadcast: a stream puts a face and a voice on a name,
      // and nothing afterwards could show it was not the owner.
      if (!pinIndex.has(as)) {
        json(res, 403, { code: 'STREAM_NEEDS_PIN', error: 'set a PIN on this account before broadcasting from it' });
        return;
      }
      const aerr = authError({ t: 'dm', from: as, auth: typeof m.auth === 'string' ? m.auth : '' });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { code: 'PIN_ATTEMPTS', error: 'too many PIN attempts — locked for a few minutes' }); return; }
        json(res, 401, { code: 'PIN_WRONG', error: aerr }); return;
      }
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 40) : '';
      if (!cid) { json(res, 400, { code: 'BAD_REQUEST', error: 'a broadcast needs the content id of its stream act' }); return; }
      const r = streamHub.open({ id: cid, owner: as, title: m.title, can: m.can });
      if (r.error) { json(res, 503, { code: 'STREAM_BUSY', error: r.error }); return; }
      json(res, 200, {
        ok: true, id: r.id, key: r.key,
        ws: '/api/stream/ws',
        limits: {
          maxBitrateKbps: Math.round(streamHub.limits.maxBitrateBps / 1000),
          maxViewers: streamHub.limits.maxViewersPerStream,
          maxMinutes: Math.round(streamHub.limits.maxStreamMs / 60000),
        },
      });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/stream/list') {
    if (!readLimiter(ip)) { json(res, 429, { code: 'RATE_LIMIT', error: 'slow down' }); return; }
    json(res, 200, { streams: streamHub.list(), stats: streamHub.stats() });
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
      m = parseBody(body);
      if (!m) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
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
      m = parseBody(body);
      if (!m) { json(res, 400, { error: 'invalid JSON: expected an object' }); return; }
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
  // Prove a recovery code and set a new PIN. Nothing else about the account
  // is touched, and the act that results says plainly how it happened.
  if (req.method === 'POST' && url.pathname === '/api/auth/recover') {
    if (mirrorRefuse(res)) return;
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m;
      m = parseBody(body);
      if (!m) { json(res, 400, { code: 'BAD_REQUEST', error: 'invalid JSON: expected an object' }); return; }
      const as = typeof m.as === 'string' ? m.as : '';
      const code = typeof m.code === 'string' ? m.code : '';
      // The same limiter a wrong PIN spends. A recovery code is long, but the
      // door it opens is the whole account, so it gets the same doorman.
      if (!pinFailLimiter(ip)) {
        json(res, 429, { code: 'PIN_ATTEMPTS', error: 'too many attempts from this address — wait a few minutes' });
        return;
      }
      const stored = recoveryIndex.get(as);
      if (!as || !code || !stored || !pinMatches(as, code, stored)) {
        // One message for every failure: whether the handle exists, whether it
        // has a code, and whether the code is right are all the same answer.
        json(res, 401, { code: 'PIN_WRONG', error: 'that handle and recovery code do not match' });
        return;
      }
      if (!validPinHash(m.pinHash)) { json(res, 400, { code: 'BAD_REQUEST', error: 'bad PIN hash' }); return; }
      recoveryGrant.add(as);
      const out = applyAct({ t: 'setPin', id: as, pinHash: m.pinHash, byRecovery: true }, '', ip);
      recoveryGrant.delete(as);
      if (out.error) { json(res, out.code || 400, { code: out.errorCode, error: out.error }); return; }
      // Said accurately: the code stays valid until its owner replaces it.
      // The index is rebuilt from the log at every restart, so 'used once'
      // would be a claim this design cannot keep.
      json(res, 200, { ok: true, note: 'PIN replaced. This recovery code still works — make a new one if it may have been seen.' });
    });
    return;
  }

  // A contact address, kept OUT of the act log on purpose.
  //
  // The log is public: served at /api/acts, copied to every mirror, and
  // published as a static archive. An address written there would be public
  // for good, and hashing would not save it — addresses are guessable in a
  // way a random code is not. So it lives here, in a file that is gitignored,
  // never mirrored and never archived, and it is only ever a way for the
  // operator to reach somebody. This host cannot send mail at all.
  if (req.method === 'POST' && url.pathname === '/api/contact') {
    if (mirrorRefuse(res)) return;
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m;
      m = parseBody(body);
      if (!m) { json(res, 400, { code: 'BAD_REQUEST', error: 'invalid JSON: expected an object' }); return; }
      const as = typeof m.as === 'string' ? m.as : '';
      const email = typeof m.email === 'string' ? m.email.trim() : '';
      if (!as || !pinIndex.has(as)) {
        json(res, 403, { code: 'PIN_REQUIRED', error: 'set a PIN on this account before adding a contact address' });
        return;
      }
      const aerr = authError({ t: 'dm', from: as, auth: typeof m.auth === 'string' ? m.auth : '' });
      if (aerr) {
        if (!pinFailLimiter(ip)) { json(res, 429, { code: 'PIN_ATTEMPTS', error: 'too many PIN attempts' }); return; }
        json(res, 401, { code: 'PIN_WRONG', error: aerr }); return;
      }
      if (email && (email.length > 160 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email))) {
        json(res, 400, { code: 'BAD_REQUEST', error: 'that does not look like an address' }); return;
      }
      let book = {};
      try { book = JSON.parse(readFileSync(CONTACTS, 'utf8')); } catch { /* first one */ }
      if (email) book[as] = { email, at: Date.now() };
      else delete book[as];
      writeFileSync(CONTACTS, JSON.stringify(book, null, 2), 'utf8');
      json(res, 200, { ok: true, set: !!email });
    });
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
      worldState().then((st) => {
        const now = Date.now();
        const live = !st ? [] : st.adverts
          .filter((a) => !a.stopped && a.until > now)
          .map((a) => ({
            id: a.id, by: a.by, byHandle: st.handles[a.by] || a.by,
            text: a.text, url: a.url, label: 'paid placement',
            paidTbtc: a.paid, until: a.until,
            aim: a.aim,
            note: 'Paid with tBTC — sandbox value, burned rather than paid to anyone. This is not in the graph: it holds no standing and changes no feed score.',
          }));
        json(res, 200, {
          ads: live,
          pricePeerPerDay: st ? st.adPricePerDay : null,
          howItWorks: 'Post an `advert` act with {text, url, days} and optional targeting. It costs θ like any act plus tBTC for the days you buy, and it is live the moment it lands — there is no approval queue. The tBTC is burned, not paid to anyone.',
          whatItIsNot: 'An advert holds no standing, sits in no graph and changes no feed score, including its own. Money buys this box and nothing else in the network.',
          targeting: 'placement (feed/live/record), tags, people (handle ids), posts (content ids — shown to anyone who engaged with them), regions (a country or language code). ALL of it is matched in the reader\'s browser against the public log and their own device locale. The host serves an identical list to everyone and never learns who saw what. Where someone connects from is never used.',
          moderation: 'Publish first, moderate after: the advertiser or the operator can stop an advert with an `adStop` act. A test network with play money does not need a review queue in front of the button.',
        });
      }).catch(() => json(res, 503, { error: 'engine still loading', code: 'ENGINE_LOADING' }));
      return;
    }
    if (req.method === 'POST') {
      // Adverts are acts now. Kept as a signpost rather than a 404, because
      // the old endpoint was documented and somebody may still be pointing at
      // it — a dead route that explains itself is worth four lines.
      json(res, 410, {
        code: 'NOT_FOUND',
        error: 'adverts are acts now: POST /api/act with {t:"advert", author, text, url, days} and optional placement/tags/people/posts/regions. It costs tBTC, goes live immediately, and there is no approval step.',
      });
      return;
    }
    if (false) {
      if (!adLimiter(ip)) { json(res, 429, { error: 'unused' }); return; }
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

    // Zero the token ledger. Deliberately awkward: it takes the operator
    // token AND a typed confirmation, because it is the one action here that
    // changes what everyone's balance says. Nothing is deleted — every act
    // stays in the log and still replays; the reset is itself an act, so the
    // record shows the ledger was zeroed, when, and by whom.
    if (req.method === 'POST' && p2 === 'reset-tokens') {
      if (mirrorRefuse(res)) return;
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
        if (b.confirm !== 'reset the token ledger') {
          json(res, 400, { code: 'CONFIRM_REQUIRED',
            error: 'send {"confirm":"reset the token ledger"} — this zeroes every PEER balance on the network' });
          return;
        }
        mintInternal({ t: 'resetTokens', id: null, ts: Date.now() });
        json(res, 200, { ok: true, note: 'the ledger is zeroed from this epoch on; the log is unchanged and still replays' });
      });
      return;
    }

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

// ── The media socket ──────────────────────────────────────────────────────
//
// One endpoint, two roles. The broadcaster pushes; everybody else pulls. Both
// arrive here because HTTP upgrade is the only thing that gets a live byte
// stream through the tunnel in front of this host without being buffered into
// eight-second lumps — measured, see stream.mjs.
const streamConnLimiter = makeLimiter(120, 60_000);

// CORS does not apply to WebSockets: a browser will happily open one from any
// page to any host and send cookies with it. Nothing but this check refuses a
// socket opened by a site the user did not visit.
const EXTRA_ORIGINS = String(process.env.PEER_STREAM_ORIGINS || '')
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;      // not a browser: a test, a bot, curl
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;                 // the app served from here
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return true;
  if (host === 'enderpeer.github.io') return true;            // the published copy
  return EXTRA_ORIGINS.includes(origin.replace(/\/+$/, ''));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/stream/ws' || !isWebSocketUpgrade(req)) { socket.destroy(); return; }
  const ip = clientIp(req);
  if (banCheck(ip) || !streamConnLimiter(ip) || !originAllowed(req)) { socket.destroy(); return; }

  const conn = acceptUpgrade(req, socket, head);
  if (!conn) return;
  const role = url.searchParams.get('role') === 'push' ? 'push' : 'watch';
  const id = String(url.searchParams.get('s') || '').slice(0, 40);

  if (role === 'watch') {
    // The viewer speaks first, saying what its MediaSource can decode. Without
    // that the host would have to guess, and guessing wrong is a black screen.
    let joined = false;
    conn.onMessage = (data, isBinary) => {
      if (isBinary || joined) return;
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (m.t !== 'can') return;
      joined = true;
      const r = streamHub.watch(id, conn, m.list);
      if (!r.ok) {
        conn.sendText(JSON.stringify({ t: 'no', why: r.why }));
        conn.close(1000, r.why);
      }
    };
    setTimeout(() => { if (!joined && !conn.closed) conn.close(1002, 'said nothing'); }, 15_000);
    return;
  }

  // ── the broadcaster ──
  if (mirrorSocketRefuse(conn)) return;
  let stream = null;
  const mimes = [];      // rendition index -> mime, declared by the pusher
  conn.onMessage = (data, isBinary) => {
    if (!isBinary) {
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (m.t === 'auth') {
        stream = streamHub.claimKey(String(m.key || ''), id);
        if (!stream) { conn.close(1008, 'that broadcast key is not valid any more'); return; }
        streamHub.attachPusher(stream, conn);
        mimes[0] = String(m.mime || '');
        conn.sendText(JSON.stringify({ t: 'ready', id }));
        return;
      }
      if (!stream) return;
      if (m.t === 'rendition' && Number.isInteger(m.i) && m.i >= 0 && m.i < 4) {
        mimes[m.i] = String(m.mime || '').slice(0, 120);
      }
      return;
    }
    if (!stream || data.length < 2) return;
    // Byte 0 says which format these bytes belong to, so one socket carries
    // every rendition in order. Two sockets would race, and media that arrives
    // out of order is media that does not decode.
    const mime = mimes[data[0]];
    if (!mime) return;
    const r = streamHub.push(stream, mime, data.subarray(1));
    if (!r.ok) {
      conn.sendText(JSON.stringify({ t: 'error', why: r.why }));
      conn.close(1008, r.why);
      streamHub.end(id, r.why);
    }
  };
  conn.onClose = () => { if (stream) streamHub.end(id, 'the broadcaster disconnected'); };
  setTimeout(() => { if (!stream && !conn.closed) conn.close(1008, 'no broadcast key'); }, 15_000);
});

/** A mirror carries no broadcasts, for the same reason it accepts no acts. */
function mirrorSocketRefuse(conn) {
  if (!role.mirrorOf) return false;
  conn.close(1013, 'this host is a read-only mirror — broadcast to the primary');
  return true;
}

// A host that cannot take the port must DIE, not linger.
//
// Node's default on a failed listen is to emit 'error' and keep the process
// alive with nothing listening. Measured on this machine: five server.mjs
// processes at once, four of them awake, holding the act log open, answering
// nothing. The watchdog restarts on "the port does not answer", so every
// restart while a healthy host already held the port added another ghost.
//
// Worse than untidy: these processes have the writable log open and the
// federation would count them as instances. A second writer is the one
// failure this whole design exists to prevent, so the safe answer to "the
// address is in use" is to exit and let whoever holds it keep working.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[host] port ${PORT} is already in use — another host is running. Exiting rather than lingering.`);
    process.exit(1);
  }
  console.error('[host] listen failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`peer host on http://localhost:${PORT} — ${acts.length} act(s) loaded`
    + (role.mirrorOf ? ` — read-only mirror of ${role.mirrorOf}` : ''));
  // Warm the engine now rather than on the first request that happens to need
  // it. Several door checks — a paid RSVP, every market act — consult the
  // replay, and a sync validator cannot await a lazy import, so until this
  // landed the first person through the door after a restart was told 'engine
  // still loading' and had to guess that trying again would work.
  ensureEngine().catch(() => { /* engineErr already carries the reason */ });
  // The role can change while the process runs, so the sync loop always
  // ticks and asks the CURRENT role — a promoted mirror stops pulling, a
  // demoted primary starts, no restart in between.
  if (isMirror()) mirrorSync();
  // A primary that closed epochs while this feature was absent, or while the
  // process was down, seals the backlog now rather than at the next close.
  else scheduleChainSeal();
  setInterval(() => { if (isMirror()) mirrorSync(); }, MIRROR_INTERVAL);
  // Election: only a federated host participates. A standalone primary keeps
  // exactly the old behavior — no probes, no quarantine, no surprises.
  if (isMirror() || rosterConfigured()) {
    if (!isMirror()) {
      // Boot quarantine: the two-writer split always began with a stale
      // primary waking up and taking writes it should not. Ask first.
      role.quarantine = true;
      console.log('[election] federated primary starting in quarantine — checking for a longer record before accepting acts');
    }
    electionTickSafe();
    setInterval(electionTickSafe, ELECTION_INTERVAL);
  }
  // The burn watcher, started AFTER the quarantine flag is set and not before.
  // It ticks whether or not anybody is looking at a page, which is the entire
  // point of it — and it does nothing until some handle has filed an intent,
  // so a host with no pending burns makes no network requests.
  //
  // The order of these two blocks is load-bearing. Started first, the boot
  // tick read `role.quarantine` while it was still false and went on to mint
  // during precisely the window the quarantine exists to cover: a restarted
  // federated primary writing before it has established that it is still the
  // writer. That is the two-writer fork, arriving through the one door that
  // writes to the log without a request.
  if (BURN_ADDRESS) {
    console.log(`[burn] watching ${BURN_ADDRESS} every ${Math.round(BURN_WATCH_MS / 1000)}s`
      + ` — ${intents.filter((i) => !i.txid).length} intent(s) pending`);
    burnTick();
    setInterval(burnTick, BURN_WATCH_MS).unref?.();
  }
});

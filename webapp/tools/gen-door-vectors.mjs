// Golden-vector generator for the ACT DOOR contract (Rust migration, phase 3).
//
// server.mjs has no exports and listens the moment it is imported, so the only
// faithful way to capture what the door does is to RUN a real host against a
// throwaway data directory and drive it over HTTP — exactly what
// tests/host.test.ts and tests/security.test.ts do. This script does that and
// writes, for every act kind in ACT_FIELDS: the request body, the HTTP status,
// the response JSON, and — for accepted acts — the EXACT bytes of the line the
// host appended to acts.jsonl (key order + JSON.stringify formatting +
// server-stamped fields). That line is the byte contract; the chain hashes it.
//
// It NEVER touches webapp/server-data (the live log) and NEVER connects to
// port 5210 (the live host): the data dir is a fresh mkdtemp and the port is
// whatever the OS hands out.
//
// Run:   node webapp/tools/gen-door-vectors.mjs
// Out:   backend/crates/ender-door/tests/vectors/door-vectors.json
//
// Everything in the throwaway world is fake: the PINs, the burn txids, the
// addresses. Nothing here is redacted because there is nothing to protect.
//
// Non-determinism, stated up front (a re-run does not reproduce these bytes):
//   - `ts` is Date.now() at acceptance (stamped by applyActInner).
//   - the first correct legacy-PIN login appends a setPin with a RANDOM salt.
//   - market refusals embed new Date(..).toLocaleString() — locale-dependent.
//   - the passkey vectors sign with a key generated per run.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, pbkdf2Sync, generateKeyPairSync, createSign } from 'node:crypto';
import { createServer as netServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const WEBAPP = resolve(here, '..');
const REPO = resolve(WEBAPP, '..');
const SERVER = join(WEBAPP, 'server.mjs');
const OUT_DIR = join(REPO, 'backend', 'crates', 'ender-door', 'tests', 'vectors');
const OUT = join(OUT_DIR, 'door-vectors.json');

// ── Pull ACT_KINDS / ACT_FIELDS out of server.mjs itself ────────────────────
// No exports, so the source is parsed. Declaration order of each field list is
// the persisted key order, which is why it is copied verbatim rather than
// retyped here.
const src = readFileSync(SERVER, 'utf8');
function extractActKinds() {
  const m = /const ACT_KINDS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!m) throw new Error('ACT_KINDS not found in server.mjs');
  return new Function('return [' + m[1] + '];')();
}
function extractActFields() {
  const start = src.indexOf('const ACT_FIELDS = {');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('ACT_FIELDS not found in server.mjs');
  let code = src.slice(start, end + 3);
  // Later single-line assignments extend/replace entries; apply them in order.
  const re = /^ACT_FIELDS\.(\w+) = \[[^\]]*\];/gm;
  let mm;
  const extra = [];
  while ((mm = re.exec(src)) !== null) extra.push(mm[0]);
  code += '\n' + extra.join('\n') + '\nreturn ACT_FIELDS;';
  return new Function(code)();
}
const ACT_KINDS = extractActKinds();
const ACT_FIELDS = extractActFields();
for (const k of ACT_KINDS) if (!ACT_FIELDS[k]) throw new Error('ACT_KINDS has ' + k + ' but ACT_FIELDS does not');
for (const k of Object.keys(ACT_FIELDS)) if (!ACT_KINDS.includes(k)) throw new Error('ACT_FIELDS has ' + k + ' but ACT_KINDS does not');

// ── The throwaway world ─────────────────────────────────────────────────────
const sha = (id, pin) => createHash('sha256').update(id + ':' + pin, 'utf8').digest('hex');
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
// PBKDF2 hash with a FIXED salt so the seed is reproducible (the host itself
// salts randomly; the format is what validPinHash checks).
function pbk(pin, saltHex) {
  return 'pbkdf2$210000$' + saltHex + '$' + pbkdf2Sync(pin, Buffer.from(saltHex, 'hex'), 210000, 32, 'sha256').toString('hex');
}
const SALT_A = 'a1'.repeat(16), SALT_C = 'c3'.repeat(16), SALT_B = 'b7'.repeat(16), SALT_H = '9e'.repeat(16);
const PIN = { u_alpha: '1234', u_bravo: '2222', u_charlie: '4444', u_broke: '3333', u_hotel: '6666' };
const OPERATOR = 'door-operator-token';

const TX = (n) => createHash('sha256').update('door-seed-burn-' + n).digest('hex');
const seedActs = [
  { t: 'register', id: 'u_alpha', handle: 'Alpha', seed: 1, epoch: 0, pinHash: pbk(PIN.u_alpha, SALT_A) },
  // Legacy sha256 hash, exactly as the oldest live accounts carry: the first
  // correct login upgrades it by APPENDING a setPin act.
  { t: 'register', id: 'u_bravo', handle: 'Bravo', seed: 1, epoch: 0, pinHash: sha('u_bravo', PIN.u_bravo) },
  { t: 'register', id: 'u_charlie', handle: 'Charlie', seed: 1, epoch: 0, pinHash: pbk(PIN.u_charlie, SALT_C) },
  { t: 'register', id: 'u_open', handle: 'Open', seed: 1, epoch: 0 },
  { t: 'register', id: 'u_fresh', handle: 'Fresh', seed: 1, epoch: 0 },
  { t: 'register', id: 'u_broke', handle: 'Broke', seed: 1, epoch: 0, pinHash: pbk(PIN.u_broke, SALT_B) },
  // Reserve: 100 sat per unit, θ ≈ 0.0528 per act. Written directly, the way
  // the tests seed it, because the door refuses btcBurn from outside.
  { t: 'btcBurn', id: 'u_alpha', txid: TX(1), sats: 20000, addr: 'bc1qdead' },
  { t: 'btcBurn', id: 'u_bravo', txid: TX(2), sats: 10000, addr: 'bc1qdead' },
  { t: 'btcBurn', id: 'u_charlie', txid: TX(3), sats: 10000, addr: 'bc1qdead' },
  { t: 'btcBurn', id: 'u_open', txid: TX(4), sats: 10000, addr: 'bc1qdead' },
  // u_open has spoken; u_fresh has not. That decides who may still put a
  // first PIN on a handle from outside.
  { t: 'post', author: 'u_open', text: 'a post from an unsecured handle', a: 0.8, rmen: [] },
];

const tmpRoot = process.env.DOOR_TMP_ROOT || tmpdir();
mkdirSync(tmpRoot, { recursive: true });
const dir = mkdtempSync(join(tmpRoot, 'ender-door-'));
const DATA = join(dir, 'server-data');
mkdirSync(DATA, { recursive: true });
const LOG = join(DATA, 'acts.jsonl');
writeFileSync(LOG, seedActs.map((a) => JSON.stringify(a)).join('\n') + '\n');
const seedLines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.length);

// ── Spawn ───────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((res, rej) => {
    const s = netServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = await freePort();
if (PORT === 5210) throw new Error('refusing to use the live port');
const BASE = 'http://127.0.0.1:' + PORT;

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PEER_')));
Object.assign(env, {
  PEER_DATA_DIR: DATA,
  PEER_OPERATOR_TOKEN: OPERATOR,
  // The limiters are real; raised so the battery does not spend its budget
  // proving them (one PIN-attempt case below exercises the one that matters).
  PEER_ACT_RATE: '100000',
  PEER_REGISTER_RATE: '100000',
});
const errLog = join(dir, 'host-stderr.log');
const child = spawn(process.execPath, [SERVER, String(PORT)], {
  cwd: WEBAPP, env, stdio: ['ignore', 'ignore', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (c) => { stderrBuf += c; });
let childExited = false;
child.on('exit', () => { childExited = true; });

function killHost() {
  if (!childExited) { try { child.kill(); } catch { /* already gone */ } }
}
process.on('exit', killHost);
process.on('SIGINT', () => { killHost(); process.exit(130); });

for (let i = 0; i < 100; i++) {
  if (childExited) break;
  try { await fetch(BASE + '/api/acts'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  if (i === 99) { killHost(); throw new Error('host did not come up\n' + stderrBuf); }
}
if (childExited) throw new Error('host exited early\n' + stderrBuf);

// ── HTTP + log helpers ──────────────────────────────────────────────────────
let ipSeq = 0;
const freshIp = () => '10.' + (Math.floor(ipSeq / 65536) % 256) + '.' + (Math.floor(ipSeq / 256) % 256) + '.' + (ipSeq++ % 256);

async function http(method, path, { body, rawBody, ip, headers } = {}) {
  const h = { ...(headers || {}) };
  if (ip) h['CF-Connecting-IP'] = ip;
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  try {
    const r = await fetch(BASE + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text: json === null ? text : undefined };
  } catch (e) {
    return { status: null, transportError: String(e && (e.cause && e.cause.code || e.message)) };
  }
}
const get = async (path) => (await http('GET', path)).json;
const total = async () => (await get('/api/acts')).total;
const readLog = () => readFileSync(LOG, 'utf8').split('\n').filter((l) => l.length);

// Content id a given act index minted (or wrote to).
async function nodeOf(idx) {
  const d = await get('/api/v1/events?since=' + idx + '&limit=1');
  return d && d.events && d.events[0] ? d.events[0].node : null;
}

const cases = [];
const auxCases = [];
const gaps = [];
const kindCounts = {};

/**
 * Send one request and record everything about it, including what changed
 * in acts.jsonl. `kind` is the act kind the case is about (or a label for
 * door-level cases with no kind).
 */
async function run(name, kind, via, req, opts = {}) {
  const before = readLog();
  const ip = opts.ip || freshIp();
  let sent = req;
  const path = via === 'act' ? '/api/act' : via === 'v1' ? '/api/v1/' + req.endpoint : req.path;
  let body = req.body;
  if (via === 'act' && body && typeof body === 'object' && !Array.isArray(body) && opts.since !== false && req.rawBody === undefined) {
    body = { ...body, since: before.length + 1 }; // in-memory index counts seedWorld at 0
  }
  const r = await http('POST', path, { body, rawBody: req.rawBody, ip, headers: req.headers });
  const after = readLog();
  const rec = {
    name, kind, via,
    request: { method: 'POST', path, ...(req.rawBody !== undefined ? { rawBody: req.rawBody } : { body }) },
    ip,
    logLinesBefore: before.length,
    status: r.status,
    response: r.json !== null && r.json !== undefined ? r.json : (r.text !== undefined ? { _nonJsonBody: r.text } : null),
  };
  if (r.transportError) rec.transportError = r.transportError;
  const added = after.slice(before.length);
  const rewritten = [];
  for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) rewritten.push({ line: i, before: before[i], after: after[i] });
  rec.persisted = added.length ? added[0] : null;
  if (added.length) rec.persistedLine = before.length;
  if (added.length > 1) rec.alsoPersisted = added.slice(1);
  if (rewritten.length) rec.rewritten = rewritten;
  if (opts.note) rec.note = opts.note;
  if (opts.expect !== undefined && r.status !== opts.expect) rec.unexpectedStatus = { expected: opts.expect, got: r.status };
  const bucket = opts.aux ? auxCases : cases;
  bucket.push(rec);
  if (!opts.aux) kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  void sent;
  return { ...rec, actIndex: added.length ? before.length + 1 : null, r };
}
const act = (name, kind, body, opts) => run(name, kind, 'act', { body }, opts);
const v1 = (name, kind, endpoint, body, opts) => run(name, kind, 'v1', { endpoint, body }, opts);
const raw = (name, kind, rawBody, opts) => run(name, kind, 'act', { rawBody }, opts);

// ── Passkey machinery (real P-256, the way security.test.ts does it) ────────
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, cose: [[1, 2], [3, -7], [-1, 1], [-2, jwk.x], [-3, jwk.y]] };
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function assertWith(privateKey, challenge, { rpId = 'localhost', origin = 'http://localhost', counter = 1, type = 'webauthn.get' } = {}) {
  const clientData = Buffer.from(JSON.stringify({ type, challenge, origin }));
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, counter]),
  ]);
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  const der = createSign('SHA256').update(signed).sign(privateKey);
  const rl = der[3];
  const rr = der.subarray(4, 4 + rl);
  const sl = der[4 + rl + 1];
  const ss = der.subarray(4 + rl + 2, 4 + rl + 2 + sl);
  const pad = (b) => Buffer.concat([Buffer.alloc(Math.max(0, 32 - b.length)), b.subarray(Math.max(0, b.length - 32))]);
  return { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(Buffer.concat([pad(rr), pad(ss)])) };
}
async function challengeFor(as) {
  const d = await http('POST', '/api/auth/challenge', { body: { as } });
  return d.json.challenge;
}

// ═══════════════════════════════════════════════════════════════════════════
// The battery
// ═══════════════════════════════════════════════════════════════════════════
try {
  // The engine loads LAZILY on the first bot-API request. Until then validate's
  // content-existence, W1 solvency, token and market checks either fail open
  // or answer "engine still loading". Every vector below is taken with the
  // engine loaded, so warm it first and prove it answered.
  for (let i = 0; i < 100; i++) {
    const s = await http('GET', '/api/v1/state');
    if (s.status === 200) break;
    if (i === 99) throw new Error('engine never loaded: ' + JSON.stringify(s.json));
    await new Promise((r) => setTimeout(r, 100));
  }
  const state0 = await get('/api/v1/state');
  const THETA = state0.theta;

  const A = 'u_alpha', B = 'u_bravo', C = 'u_charlie', O = 'u_open', F = 'u_fresh', K = 'u_broke';
  const pa = PIN.u_alpha, pb = PIN.u_bravo, pc = PIN.u_charlie, pk = PIN.u_broke;

  // ── Door-level: body shapes that never reach validate ─────────────────────
  await raw('door: invalid JSON', 'door', '{not json', { expect: 400 });
  await raw('door: JSON null', 'door', 'null', { expect: 400 });
  await raw('door: JSON number', 'door', '7', { expect: 400 });
  await raw('door: JSON string', 'door', '"post"', { expect: 400 });
  await raw('door: JSON array', 'door', '[]', { note: 'an array is an object to parseBody; sanitize sees t undefined → {} → unknown act kind' });
  await raw('door: empty object', 'door', '{}');
  await raw('door: empty body', 'door', '', { expect: 400 });
  await raw('door: duplicate keys, last wins', 'door', '{"t":"post","author":"u_open","text":"first","text":"second","a":0.5}',
    { note: 'JSON.parse keeps the last duplicate; the persisted text is "second"' });
  await raw('door: body over 2×MAX_ACT_BYTES is destroyed mid-read', 'door', JSON.stringify({ t: 'post', author: O, text: 'z'.repeat(9000), a: 0.5 }),
    { note: 'req.destroy() once the body passes 8192 bytes: no HTTP response at all' });
  await act('door: unknown act kind, no author', 'door', { t: 'bogus', foo: 1 });
  await act('door: unknown act kind with unregistered author (sanitize strips author before validate)', 'door', { t: 'bogus', author: 'nobody' });
  await act('door: unknown act kind with registered author', 'door', { t: 'bogus', author: A, auth: pa });
  await act('door: t is a number', 'door', { t: 7, author: A });
  await act('door: t is null', 'door', { t: null });
  await act('door: since is stripped and never persisted (post via act door)', 'post',
    { t: 'post', author: A, text: 'since must not persist', a: 0.5, auth: pa, since: 999999 }, { since: false });
  await act('door: unknown extra fields are stripped by sanitize', 'post',
    { t: 'post', author: A, text: 'extra fields', a: 0.5, auth: pa, foo: 'bar', nested: { x: 1 }, admin: true, ts: 1, rmen: ['u_bravo'] },
    { note: 'ts and rmen are NOT in ACT_FIELDS.post: the client-sent ones are dropped and the server stamps its own' });
  await act('door: request key order does not matter, persisted order is ACT_FIELDS order', 'post',
    { a: 0.5, text: 'scrambled keys', auth: pa, author: A, t: 'post' });

  // ── register ──────────────────────────────────────────────────────────────
  await act('register: valid, no PIN', 'register', { t: 'register', id: 'u_delta', handle: 'Delta', seed: 1, epoch: 0 }, { expect: 200 });
  await act('register: valid with legacy sha256 pinHash', 'register', { t: 'register', id: 'u_echo', handle: 'Echo', seed: 1, epoch: 0, pinHash: sha('u_echo', '7777') }, { expect: 200 });
  await act('register: valid with pbkdf2 pinHash', 'register', { t: 'register', id: 'u_hotel', handle: 'Hotel', seed: 1, epoch: 0, pinHash: pbk(PIN.u_hotel, SALT_H) }, { expect: 200 });
  await act('register: valid, fnv legacy pinHash format', 'register', { t: 'register', id: 'u_india', handle: 'India', seed: 1, epoch: 0, pinHash: 'fnvdeadbeef' }, { expect: 200 });
  await act('register: epoch is not validated (string persists)', 'register', { t: 'register', id: 'u_juliet', handle: 'Juliet', seed: 1, epoch: 'whatever' }, { expect: 200, note: 'validate() checks id/handle/seed/pinHash only; epoch passes through as sent' });
  await act('register: epoch missing persists without the key', 'register', { t: 'register', id: 'u_kilo', handle: 'Kilo', seed: 1 }, { expect: 200 });
  await act('register: unknown fields stripped, auth stripped', 'register', { t: 'register', id: 'u_lima', handle: 'Lima', seed: 1, epoch: 0, auth: 'zzz', extra: 1, author: 'u_alpha' }, { expect: 200 });
  await act('register: passkey-only handle later (no PIN)', 'register', { t: 'register', id: 'u_golf', handle: 'Golf', seed: 1, epoch: 0 }, { expect: 200 });
  await act('register: missing handle', 'register', { t: 'register', id: 'u_mike', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle too long (17)', 'register', { t: 'register', id: 'u_mike', handle: 'M'.repeat(17), seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle empty', 'register', { t: 'register', id: 'u_mike', handle: '', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: id not u_[a-z0-9]+', 'register', { t: 'register', id: 'Mike', handle: 'Mike', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: id uppercase', 'register', { t: 'register', id: 'u_Mike', handle: 'Mike', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: id too long (25)', 'register', { t: 'register', id: 'u_' + 'm'.repeat(23), handle: 'Mike', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: id exactly 24 chars is fine', 'register', { t: 'register', id: 'u_' + 'n'.repeat(22), handle: 'Nov', seed: 1, epoch: 0 }, { expect: 200 });
  await act('register: id missing', 'register', { t: 'register', handle: 'Mike', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: seed wrong (2)', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', seed: 2, epoch: 0 }, { expect: 400 });
  await act('register: seed missing', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', epoch: 0 }, { expect: 400 });
  await act('register: seed string "1"', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', seed: '1', epoch: 0 }, { expect: 400 });
  await raw('register: seed 1e999 (Infinity via JSON.parse)', 'register', '{"t":"register","id":"u_mike","handle":"Mike","seed":1e999,"epoch":0}', { expect: 400 });
  await act('register: id already registered', 'register', { t: 'register', id: 'u_alpha', handle: 'Someone', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle taken exactly', 'register', { t: 'register', id: 'u_mike', handle: 'Alpha', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle taken by case', 'register', { t: 'register', id: 'u_mike', handle: 'alpha', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle look-alike (AIpha)', 'register', { t: 'register', id: 'u_mike', handle: 'AIpha', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle look-alike (Cyrillic а)', 'register', { t: 'register', id: 'u_mike', handle: 'Alphа', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle only decoration', 'register', { t: 'register', id: 'u_mike', handle: '!!!', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: bad pinHash', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', seed: 1, epoch: 0, pinHash: 'nope' }, { expect: 400 });
  await act('register: pbkdf2 pinHash with weakened iterations', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', seed: 1, epoch: 0, pinHash: 'pbkdf2$1000$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32) }, { expect: 400 });
  await act('register: pinHash null', 'register', { t: 'register', id: 'u_mike', handle: 'Mike', seed: 1, epoch: 0, pinHash: null }, { expect: 400, note: 'null !== undefined, so validPinHash(null) runs and fails' });
  await act('register: control char in handle (act door only)', 'register', { t: 'register', id: 'u_mike', handle: 'Mi\u0001ke', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: DEL (0x7f) in handle', 'register', { t: 'register', id: 'u_mike', handle: 'Mi\u007fke', seed: 1, epoch: 0 }, { expect: 400 });
  await act('register: handle with tab is allowed by the control-char rule', 'register', { t: 'register', id: 'u_oscar', handle: 'Os\tcar', seed: 1, epoch: 0 }, { expect: 200 });
  await act('register: handle with astral emoji', 'register', { t: 'register', id: 'u_papa', handle: 'Papa\u{1F600}', seed: 1, epoch: 0 }, { expect: 200 });
  await raw('register: handle with lone surrogate (JSON escape survives)', 'register', '{"t":"register","id":"u_quebec","handle":"Que\\ud800bec","seed":1,"epoch":0}', { expect: 200, note: 'JSON.stringify re-escapes the lone surrogate as \\ud800 in the persisted line' });
  await act('register: seed actor name is not a taken handle', 'register', { t: 'register', id: 'u_alice2', handle: 'Alice', seed: 1, epoch: 0 }, { expect: 200, note: 'seedWorld actors alice/bob/carol/dave carry no register act, so takenHandles does not know them' });
  await v1('register (v1): valid with pin', 'register', 'register', { handle: 'Foxtrot', pin: '5555' }, { expect: 200, note: 'the wrapper writes pinHash = LEGACY sha256(id:pin), not pbkdf2' });
  await v1('register (v1): valid, no pin', 'register', 'register', { handle: 'Romeo' }, { expect: 200 });
  await v1('register (v1): handle with spaces and punctuation → id folds', 'register', 'register', { handle: ' Sierra Tango! ' }, { expect: 200 });
  await v1('register (v1): missing handle', 'register', 'register', { pin: '1234' }, { expect: 400 });
  await v1('register (v1): handle without letters or digits', 'register', 'register', { handle: '!!!' }, { expect: 400 });
  await v1('register (v1): pin too short', 'register', 'register', { handle: 'Uniform', pin: '123' }, { expect: 400 });
  await v1('register (v1): pin numeric (String() applied)', 'register', 'register', { handle: 'Victor', pin: 98765 }, { expect: 200, note: 'body.pin truthy non-string: String(body.pin).length ≥ 4 passes, hash uses id + ":" + 98765' });
  await v1('register (v1): handle taken', 'register', 'register', { handle: 'Alpha' }, { expect: 400 });
  await v1('register (v1): body null', 'register', 'register', null, { expect: 400 });
  await run('register (v1): body is JSON number', 'register', 'v1', { endpoint: 'register', rawBody: '7' }, { expect: 400 });

  // ── post ──────────────────────────────────────────────────────────────────
  const P1 = await act('post: valid minimal', 'post', { t: 'post', author: A, text: 'hello world', a: 0.8, auth: pa }, { expect: 200 });
  const P1cid = await nodeOf(P1.actIndex);
  const P2 = await act('post: valid with @mention → rmen', 'post', { t: 'post', author: A, text: 'hi @Bravo and @Charlie and @nobody and @Alice', a: 0.8, auth: pa }, { expect: 200, note: 'rmen resolves handles known at this index incl. seed actors; unknown mentions dropped; max 3' });
  await act('post: valid, mention of a handle registered LATER is not resolved', 'post', { t: 'post', author: A, text: 'ping @Zulu', a: 0.8, auth: pa }, { expect: 200 });
  const P3 = await act('post: unsecured handle, no auth (permissive)', 'post', { t: 'post', author: O, text: 'open handle posts freely', a: 0.5 }, { expect: 200 });
  const P3cid = await nodeOf(P3.actIndex);
  await act('post: seed actor alice, no auth', 'post', { t: 'post', author: 'alice', text: 'seed actor speaks', a: 0.5 }, { expect: 200, note: 'SEED_ACTORS pass isRegistered; they have no PIN and 3 units of reserve' });
  await act('post: legacy-PIN handle first correct login → setPin upgrade appended', 'post', { t: 'post', author: B, text: 'bravo logs in', a: 0.6, auth: pb }, { expect: 200, note: 'alsoPersisted carries the pbkdf2 setPin with a random salt; the legacy hash stays in the register act' });
  const PB = await act('post: legacy-PIN handle second login (upgraded hash verifies)', 'post', { t: 'post', author: B, text: 'bravo again', a: 0.6, auth: pb }, { expect: 200 });
  const PBcid = await nodeOf(PB.actIndex);
  await act('post: numeric formatting (0.1+0.2, -0, 1e-7, 1.0)', 'post', { t: 'post', author: A, text: 'numbers', a: 0.30000000000000004, auth: pa }, { expect: 200 });
  await raw('post: a = -0 persists as 0', 'post', JSON.stringify({ t: 'post', author: A, text: 'negative zero', a: -0, auth: pa }).replace('"a":0', '"a":-0'), { expect: 200 });
  await raw('post: a = 1E-1 (exponent form in) persists as 0.1', 'post', '{"t":"post","author":"u_alpha","text":"exp form","a":1E-1,"auth":"1234"}', { expect: 200 });
  await act('post: a = 1 boundary', 'post', { t: 'post', author: A, text: 'a=1', a: 1, auth: pa }, { expect: 200 });
  await act('post: a = -1 boundary', 'post', { t: 'post', author: A, text: 'a=-1', a: -1, auth: pa }, { expect: 200 });
  await act('post: text exactly 1000 chars', 'post', { t: 'post', author: A, text: 'x'.repeat(1000), a: 0.5, auth: pa }, { expect: 200 });
  await act('post: text with tab and newline (allowed controls)', 'post', { t: 'post', author: A, text: 'line1\n\tline2\r\n', a: 0.5, auth: pa }, { expect: 200 });
  await act('post: text with unicode (é, emoji, CJK, U+2028)', 'post', { t: 'post', author: A, text: 'café \u{1F984} 日本語   <>&"\\/', a: 0.5, auth: pa }, { expect: 200 });
  await raw('post: text with lone surrogate', 'post', '{"t":"post","author":"u_alpha","text":"lone \\udc00 surrogate","a":0.5,"auth":"1234"}', { expect: 200 });
  await act('post: valid ref to existing content', 'post', { t: 'post', author: A, text: 'quoting', a: 0.5, ref: P1cid, auth: pa }, { expect: 200 });
  await act('post: valid ref to a profile', 'post', { t: 'post', author: A, text: 'ref profile', a: 0.5, ref: 'prof_u_bravo', auth: pa }, { expect: 200, note: 'unknownTarget only checks /^c\\d+$/ ids' });
  await act('post: valid ref of arbitrary string ≤40', 'post', { t: 'post', author: A, text: 'ref junk', a: 0.5, ref: 'not-a-content-id', auth: pa }, { expect: 200 });
  const REV = await act('post: valid revision (target = own act index)', 'post', { t: 'post', author: A, text: 'hello world, revised', a: 0.8, target: P1.actIndex, auth: pa }, { expect: 200 });
  await act('post: valid revision of a revision (lands on same node)', 'post', { t: 'post', author: A, text: 'hello world, revised twice', a: 0.8, target: REV.actIndex, auth: pa }, { expect: 200 });
  await act('post: text too long (1001)', 'post', { t: 'post', author: A, text: 'x'.repeat(1001), a: 0.5, auth: pa }, { expect: 400 });
  await act('post: act too large (serialised > 4096)', 'post', { t: 'post', author: A, text: 'x'.repeat(4100), a: 0.5, auth: pa }, { expect: 400, note: 'the byte check precedes the per-field length check' });
  await act('post: text missing', 'post', { t: 'post', author: A, a: 0.5, auth: pa }, { expect: 400 });
  await act('post: text empty', 'post', { t: 'post', author: A, text: '', a: 0.5, auth: pa }, { expect: 400 });
  await act('post: text not a string', 'post', { t: 'post', author: A, text: 42, a: 0.5, auth: pa }, { expect: 400 });
  await act('post: a missing', 'post', { t: 'post', author: A, text: 'no a', auth: pa }, { expect: 400 });
  await act('post: a out of range (1.5)', 'post', { t: 'post', author: A, text: 'a=1.5', a: 1.5, auth: pa }, { expect: 400 });
  await act('post: a out of range (-1.0001)', 'post', { t: 'post', author: A, text: 'a<-1', a: -1.0001, auth: pa }, { expect: 400 });
  await act('post: a string', 'post', { t: 'post', author: A, text: 'a string', a: '0.5', auth: pa }, { expect: 400 });
  await act('post: a null', 'post', { t: 'post', author: A, text: 'a null', a: null, auth: pa }, { expect: 400 });
  await act('post: a boolean', 'post', { t: 'post', author: A, text: 'a bool', a: true, auth: pa }, { expect: 400 });
  await raw('post: a = 1e999 (Infinity)', 'post', '{"t":"post","author":"u_alpha","text":"inf","a":1e999,"auth":"1234"}', { expect: 400 });
  await raw('post: a = -1e999 (-Infinity)', 'post', '{"t":"post","author":"u_alpha","text":"-inf","a":-1e999,"auth":"1234"}', { expect: 400 });
  await raw('post: NaN literal is invalid JSON', 'post', '{"t":"post","author":"u_alpha","text":"nan","a":NaN,"auth":"1234"}', { expect: 400 });
  await act('post: author unregistered', 'post', { t: 'post', author: 'u_ghost', text: 'ghost', a: 0.5 }, { expect: 400 });
  await act('post: author unregistered, long name is truncated in the message', 'post', { t: 'post', author: 'Luke Skywalker of Tatooine and the Outer Rim Territories', text: 'ghost', a: 0.5 }, { expect: 400 });
  await act('post: author missing', 'post', { t: 'post', text: 'no author', a: 0.5 }, { expect: 400 });
  await act('post: author not a string', 'post', { t: 'post', author: 42, text: 'num author', a: 0.5 }, { expect: 400 });
  await act('post: control char in text (act door)', 'post', { t: 'post', author: A, text: 'bad\u0001char', a: 0.5, auth: pa }, { expect: 400 });
  await act('post: control char in ref (act door)', 'post', { t: 'post', author: A, text: 'ok', a: 0.5, ref: 'c\u0002', auth: pa }, { expect: 400 });
  await act('post: ref unknown content id', 'post', { t: 'post', author: A, text: 'quoting nothing', a: 0.5, ref: 'c99999', auth: pa }, { expect: 404 });
  await act('post: ref too long', 'post', { t: 'post', author: A, text: 'ref long', a: 0.5, ref: 'r'.repeat(41), auth: pa }, { expect: 400 });
  await act('post: ref not a string', 'post', { t: 'post', author: A, text: 'ref num', a: 0.5, ref: 5, auth: pa }, { expect: 400 });
  await act('post: target non-integer', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: 1.5, auth: pa }, { expect: 400 });
  await act('post: target string', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: 'c1', auth: pa }, { expect: 400 });
  await act('post: target not a post (index 0 = seedWorld)', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: 0, auth: pa }, { expect: 400 });
  await act('post: target not a post (a register act)', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: 1, auth: pa }, { expect: 400 });
  await act('post: target out of range', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: 999999, auth: pa }, { expect: 400 });
  await act('post: target negative', 'post', { t: 'post', author: A, text: 'rev', a: 0.5, target: -1, auth: pa }, { expect: 400 });
  await act('post: revising someone else’s post', 'post', { t: 'post', author: A, text: 'hijack', a: 0.5, target: P3.actIndex, auth: pa }, { expect: 400 });
  await act('post: PIN missing on secured handle', 'post', { t: 'post', author: A, text: 'no pin', a: 0.5 }, { expect: 401 });
  await act('post: PIN wrong', 'post', { t: 'post', author: A, text: 'wrong pin', a: 0.5, auth: '0000' }, { expect: 401 });
  await act('post: auth is a number', 'post', { t: 'post', author: A, text: 'num pin', a: 0.5, auth: 1234 }, { expect: 401, note: 'only a string or an assertion object counts; a number is treated as no auth' });
  await act('post: auth is an array', 'post', { t: 'post', author: A, text: 'arr pin', a: 0.5, auth: ['1234'] }, { expect: 401 });
  await act('post: auth is an empty object (assertion with no credId)', 'post', { t: 'post', author: A, text: 'obj pin', a: 0.5, auth: {} }, { expect: 401 });
  await act('post: W1 gate — PIN ok, zero energy', 'post', { t: 'post', author: K, text: 'broke', a: 0.5, auth: pk }, { expect: 402 });
  await act('post: W1 gate — unsecured handle with zero energy', 'post', { t: 'post', author: F, text: 'fresh and broke', a: 0.5 }, { expect: 402 });
  // v1 post
  const V1P = await v1('post (v1): valid', 'post', 'post', { as: A, pin: pa, text: 'from the bot door' }, { expect: 200, note: 'a defaults to 0.8; text is trimmed' });
  const V1Pcid = await nodeOf(V1P.actIndex);
  await v1('post (v1): text trimmed, attachment_strength honoured', 'post', 'post', { as: A, pin: pa, text: '  padded  ', attachment_strength: -0.25 }, { expect: 200 });
  await v1('post (v1): attachment_strength out of range silently defaults', 'post', 'post', { as: A, pin: pa, text: 'strength 5', attachment_strength: 5 }, { expect: 200, note: 'the wrapper num(v,d) substitutes the default rather than refusing' });
  await v1('post (v1): quote', 'post', 'post', { as: A, pin: pa, text: 'quoting via v1', quote: P1cid }, { expect: 200 });
  await v1('post (v1): revise by content id', 'post', 'post', { as: A, pin: pa, text: 'revised via v1', revise: V1Pcid }, { expect: 200 });
  await v1('post (v1): revise by act index', 'post', 'post', { as: A, pin: pa, text: 'revised via v1 by index', revise: V1P.actIndex }, { expect: 200 });
  await v1('post (v1): target alias of revise', 'post', 'post', { as: A, pin: pa, text: 'revised via target', target: V1P.actIndex }, { expect: 200 });
  await v1('post (v1): control chars pass through (no hasControlChars on this door)', 'post', 'post', { as: A, pin: pa, text: 'bot\u0001char' }, { note: 'DIVERGENCE: /api/act refuses this with 400; the v1 wrapper never calls hasControlChars' });
  await v1('post (v1): text missing', 'post', 'post', { as: A, pin: pa }, { expect: 400 });
  await v1('post (v1): text whitespace only', 'post', 'post', { as: A, pin: pa, text: '   ' }, { expect: 400 });
  await v1('post (v1): text too long', 'post', 'post', { as: A, pin: pa, text: 'y'.repeat(1001) }, { expect: 400 });
  await v1('post (v1): revise unknown content id', 'post', 'post', { as: A, pin: pa, text: 'x', revise: 'c99999' }, { expect: 404 });
  await v1('post (v1): revise bad type', 'post', 'post', { as: A, pin: pa, text: 'x', revise: 'nope' }, { expect: 400 });
  await v1('post (v1): revise someone else’s', 'post', 'post', { as: A, pin: pa, text: 'x', revise: P3cid }, { expect: 400 });
  await v1('post (v1): quote unknown', 'post', 'post', { as: A, pin: pa, text: 'x', quote: 'c99999' }, { expect: 404 });
  await v1('post (v1): as missing', 'post', 'post', { pin: pa, text: 'x' }, { expect: 400 });
  await v1('post (v1): as unknown', 'post', 'post', { as: 'u_ghost', pin: pa, text: 'x' }, { expect: 404 });
  await v1('post (v1): pin missing on secured handle', 'post', 'post', { as: A, text: 'x' }, { expect: 401 });
  await v1('post (v1): pin wrong', 'post', 'post', { as: A, pin: '0000', text: 'x' }, { expect: 401 });
  await v1('post (v1): pin as number is ignored (treated as no credential)', 'post', 'post', { as: A, pin: 1234, text: 'x' }, { expect: 401 });
  await v1('post (v1): W1 gate', 'post', 'post', { as: K, pin: pk, text: 'broke bot' }, { expect: 402 });
  await v1('post (v1): unsecured handle, no pin', 'post', 'post', { as: O, text: 'open bot' }, { expect: 200 });
  await v1('post (v1): body null', 'post', 'post', null, { expect: 400 });
  await run('post (v1): body JSON string', 'post', 'v1', { endpoint: 'post', rawBody: '"x"' }, { expect: 400 });
  await v1('post (v1): unknown endpoint falls through to the FAUCET_GONE 410', 'door', 'nonexistent', { as: A, pin: pa }, { expect: 410, note: 'the trailing 404 in handleBotApi is unreachable: every unmatched POST answers the faucet 410' });
  await v1('post (v1): /api/v1/burn is the faucet 410', 'burn', 'burn', { as: A, pin: pa }, { expect: 410 });

  // ── media (upload two blobs, then exercise the post media branch) ─────────
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cfc00000020001e221bc330000000049454e44ae426082', 'hex');
  const upPng = await http('POST', '/api/media', { headers: { 'Content-Type': 'image/png' }, rawBody: png });
  const audio = Buffer.from('fffb9064000000000000000000000000000000000000', 'hex');
  const upAud = await http('POST', '/api/media', { headers: { 'Content-Type': 'audio/mp3' }, rawBody: audio });
  auxCases.push({ name: 'media upload png', via: 'aux', request: { method: 'POST', path: '/api/media', contentType: 'image/png', bytesHex: png.toString('hex') }, status: upPng.status, response: upPng.json });
  auxCases.push({ name: 'media upload audio (alias audio/mp3 → audio/mpeg)', via: 'aux', request: { method: 'POST', path: '/api/media', contentType: 'audio/mp3', bytesHex: audio.toString('hex') }, status: upAud.status, response: upAud.json });
  const HP = upPng.json.h, HA = upAud.json.h;
  await act('post: valid media (image)', 'post', { t: 'post', author: A, text: 'with picture', a: 0.5, media: [{ h: HP, m: 'image/png' }], auth: pa }, { expect: 200 });
  await act('post: valid media with n, s, cv:1', 'post', { t: 'post', author: A, text: 'album', a: 0.5, media: [{ h: HP, m: 'image/png', n: 'cover.png', s: png.length, cv: 1 }, { h: HA, m: 'audio/mpeg', n: 'track 1.mp3', s: audio.length }], auth: pa }, { expect: 200 });
  await act('post: valid media, sibling mime of the same family', 'post', { t: 'post', author: A, text: 'sibling type', a: 0.5, media: [{ h: HP, m: 'image/jpeg' }], auth: pa }, { expect: 200, note: 'compared by top-level type: stored image/png vs claimed image/jpeg passes' });
  await act('post: valid empty media list', 'post', { t: 'post', author: A, text: 'empty media', a: 0.5, media: [], auth: pa }, { expect: 200 });
  await act('post: media not an array', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: { h: HP, m: 'image/png' }, auth: pa }, { expect: 400 });
  await act('post: media entry not an object', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: ['x'], auth: pa }, { expect: 400 });
  await act('post: media entry is an array', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [[HP]], auth: pa }, { expect: 400 });
  await act('post: media entry null', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [null], auth: pa }, { expect: 400 });
  await act('post: media entry unknown field', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', junk: 'z'.repeat(300) }], auth: pa }, { expect: 400 });
  await act('post: media entry control char in n', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', n: 'bad\u0001name' }], auth: pa }, { expect: 400 });
  await act('post: media too many entries (13)', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: Array.from({ length: 13 }, () => ({ h: HP, m: 'image/png' })), auth: pa }, { expect: 400 });
  await act('post: media bad hash', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: 'nothex', m: 'image/png' }], auth: pa }, { expect: 400 });
  await act('post: media hash missing', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ m: 'image/png' }], auth: pa }, { expect: 400 });
  await act('post: media unknown mime', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/bmp' }], auth: pa }, { expect: 400 });
  await act('post: media name too long (81)', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', n: 'n'.repeat(81) }], auth: pa }, { expect: 400 });
  await act('post: media name not a string', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', n: 5 }], auth: pa }, { expect: 400 });
  await act('post: media unknown hash (never uploaded)', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: 'f'.repeat(64), m: 'image/png' }], auth: pa }, { expect: 400 });
  await act('post: media cv:2', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', cv: 2 }], auth: pa }, { expect: 400 });
  await act('post: media cv:true', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', cv: true }], auth: pa }, { expect: 400 });
  await act('post: media cover on non-image', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HA, m: 'audio/mpeg', cv: 1 }], auth: pa }, { expect: 400 });
  await act('post: media type claim contradicts sidecar', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'audio/mpeg' }], auth: pa }, { expect: 400 });
  await act('post: media size claim wrong', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', s: 5 }], auth: pa }, { expect: 400 });
  await act('post: media size non-integer', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', s: 1.5 }], auth: pa }, { expect: 400 });
  await act('post: media two covers', 'post', { t: 'post', author: A, text: 'x', a: 0.5, media: [{ h: HP, m: 'image/png', cv: 1 }, { h: HP, m: 'image/png', cv: 1 }], auth: pa }, { expect: 400 });
  await v1('post (v1): attachment', 'post', 'post', { as: A, pin: pa, text: 'bot with attachment', attachment: { h: HP, m: 'image/png' } }, { expect: 200 });
  await v1('post (v1): attachments list', 'post', 'post', { as: A, pin: pa, text: 'bot playlist', attachments: [{ h: HA, m: 'audio/mpeg', n: 'a.mp3' }, { h: HA, m: 'audio/mpeg', n: 'b.mp3' }] }, { expect: 200 });
  await v1('post (v1): attachment only, no text → text becomes "·"', 'post', 'post', { as: A, pin: pa, attachment: { h: HP, m: 'image/png' } }, { expect: 200 });
  await v1('post (v1): attachment with unknown field', 'post', 'post', { as: A, pin: pa, text: 'x', attachment: { h: HP, m: 'image/png', evil: 1 } }, { expect: 400 });

  // ── opinion ───────────────────────────────────────────────────────────────
  await act('opinion: valid on content', 'opinion', { t: 'opinion', author: B, target: P1cid, p: 0.7, r: 0.6, auth: pb }, { expect: 200 });
  await act('opinion: valid vouch (prof_ target)', 'opinion', { t: 'opinion', author: B, target: 'prof_' + A, p: 0.5, r: 0.5, auth: pb }, { expect: 200 });
  await act('opinion: valid negative', 'opinion', { t: 'opinion', author: C, target: P1cid, p: -0.4, r: -1, auth: pc }, { expect: 200 });
  await act('opinion: valid, extra fields stripped', 'opinion', { t: 'opinion', author: A, target: P3cid, p: 0.1, r: 0.2, e: 0.9, text: 'not for opinion', auth: pa }, { expect: 200 });
  await act('opinion: valid target with 40 chars (non-content, unchecked)', 'opinion', { t: 'opinion', author: A, target: 'x'.repeat(40), p: 0.1, r: 0.2, auth: pa }, { expect: 200, note: 'unknownTarget only checks c\\d+ ids; other strings ≤40 pass' });
  await act('opinion: p missing', 'opinion', { t: 'opinion', author: A, target: P1cid, r: 0.5, auth: pa }, { expect: 400 });
  await act('opinion: r missing', 'opinion', { t: 'opinion', author: A, target: P1cid, p: 0.5, auth: pa }, { expect: 400 });
  await act('opinion: p out of range', 'opinion', { t: 'opinion', author: A, target: P1cid, p: 1.01, r: 0.5, auth: pa }, { expect: 400 });
  await act('opinion: p string', 'opinion', { t: 'opinion', author: A, target: P1cid, p: '0.5', r: 0.5, auth: pa }, { expect: 400 });
  await raw('opinion: r = 1e999', 'opinion', '{"t":"opinion","author":"u_alpha","target":"' + P1cid + '","p":0.5,"r":1e999,"auth":"1234"}', { expect: 400 });
  await act('opinion: target missing', 'opinion', { t: 'opinion', author: A, p: 0.5, r: 0.5, auth: pa }, { expect: 400 });
  await act('opinion: target too long (41)', 'opinion', { t: 'opinion', author: A, target: 'x'.repeat(41), p: 0.5, r: 0.5, auth: pa }, { expect: 400 });
  await act('opinion: target unknown content id', 'opinion', { t: 'opinion', author: A, target: 'c99999', p: 0.5, r: 0.5, auth: pa }, { expect: 404 });
  await act('opinion: author unregistered', 'opinion', { t: 'opinion', author: 'u_ghost', target: P1cid, p: 0.5, r: 0.5 }, { expect: 400 });
  await act('opinion: PIN wrong', 'opinion', { t: 'opinion', author: A, target: P1cid, p: 0.5, r: 0.5, auth: 'x' }, { expect: 401 });
  await act('opinion: W1 gate', 'opinion', { t: 'opinion', author: K, target: P1cid, p: 0.5, r: 0.5, auth: pk }, { expect: 402 });
  await v1('react (v1): valid', 'opinion', 'react', { as: B, pin: pb, target: P1cid, polarity: 0.3, reaction: -0.2 }, { expect: 200 });
  await v1('react (v1): defaults (0.8/0.8)', 'opinion', 'react', { as: C, pin: pc, target: PBcid }, { expect: 200 });
  await v1('react (v1): out-of-range polarity silently defaults', 'opinion', 'react', { as: C, pin: pc, target: P3cid, polarity: 9 }, { expect: 200 });
  await v1('react (v1): vouch prof_', 'opinion', 'react', { as: C, pin: pc, target: 'prof_' + B }, { expect: 200 });
  await v1('react (v1): target missing', 'opinion', 'react', { as: B, pin: pb }, { expect: 400 });
  await v1('react (v1): target unknown', 'opinion', 'react', { as: B, pin: pb, target: 'c99999' }, { expect: 404 });
  await v1('react (v1): target numeric is stringified', 'opinion', 'react', { as: B, pin: pb, target: 12345 }, { expect: 200, note: 'String(12345) is not a c-id, so it passes unknownTarget and is stored as "12345"' });

  // ── review ────────────────────────────────────────────────────────────────
  const R1 = await act('review: valid', 'review', { t: 'review', author: B, target: P1cid, e: 0.7, f: 0.8, text: 'a comment', auth: pb }, { expect: 200 });
  const R1cid = await nodeOf(R1.actIndex);
  await act('review: valid reply to a comment', 'review', { t: 'review', author: A, target: R1cid, e: 0.5, f: 0.5, text: 'a reply', auth: pa }, { expect: 200 });
  await act('review: valid revision (upd)', 'review', { t: 'review', author: B, target: P1cid, e: 0.7, f: 0.8, text: 'a comment, revised', upd: R1.actIndex, auth: pb }, { expect: 200 });
  await act('review: text 1000 chars', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, text: 'r'.repeat(1000), auth: pa }, { expect: 200 });
  await act('review: text too long (1001)', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, text: 'r'.repeat(1001), auth: pa }, { expect: 400 });
  await act('review: text missing', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, auth: pa }, { expect: 400 });
  await act('review: e out of range', 'review', { t: 'review', author: A, target: P1cid, e: 2, f: 0.1, text: 'x', auth: pa }, { expect: 400 });
  await act('review: f missing', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, text: 'x', auth: pa }, { expect: 400 });
  await act('review: target unknown', 'review', { t: 'review', author: A, target: 'c99999', e: 0.1, f: 0.1, text: 'x', auth: pa }, { expect: 404 });
  await act('review: target missing', 'review', { t: 'review', author: A, e: 0.1, f: 0.1, text: 'x', auth: pa }, { expect: 400 });
  await act('review: upd non-integer', 'review', { t: 'review', author: B, target: P1cid, e: 0.1, f: 0.1, text: 'x', upd: 1.5, auth: pb }, { expect: 400 });
  await act('review: upd not a review', 'review', { t: 'review', author: B, target: P1cid, e: 0.1, f: 0.1, text: 'x', upd: P1.actIndex, auth: pb }, { expect: 400 });
  await act('review: upd someone else’s comment', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, text: 'x', upd: R1.actIndex, auth: pa }, { expect: 400 });
  await act('review: PIN missing', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, text: 'x' }, { expect: 401 });
  await act('review: W1 gate', 'review', { t: 'review', author: K, target: P1cid, e: 0.1, f: 0.1, text: 'x', auth: pk }, { expect: 402 });
  await act('review: control char in text', 'review', { t: 'review', author: A, target: P1cid, e: 0.1, f: 0.1, text: 'x\u001fy', auth: pa }, { expect: 400 });
  await v1('comment (v1): valid', 'review', 'comment', { as: C, pin: pc, target: P1cid, text: 'bot comment' }, { expect: 200, note: 'e defaults 0.7, f defaults 0.8' });
  await v1('comment (v1): enthusiasm/effort honoured', 'review', 'comment', { as: C, pin: pc, target: P1cid, text: 'bot comment 2', enthusiasm: -0.5, effort: 0.25 }, { expect: 200 });
  await v1('comment (v1): target missing', 'review', 'comment', { as: C, pin: pc, text: 'x' }, { expect: 400 });
  await v1('comment (v1): text missing', 'review', 'comment', { as: C, pin: pc, target: P1cid }, { expect: 400 });
  await v1('comment (v1): target unknown', 'review', 'comment', { as: C, pin: pc, target: 'c99999', text: 'x' }, { expect: 404 });

  // ── tag ───────────────────────────────────────────────────────────────────
  await act('tag: valid', 'tag', { t: 'tag', author: A, target: P1cid, name: 'streetart', r: 0.8, c: 0.9, auth: pa }, { expect: 200 });
  await act('tag: name 20 chars', 'tag', { t: 'tag', author: A, target: P1cid, name: 't'.repeat(20), r: 0.8, c: 0.9, auth: pa }, { expect: 200 });
  await act('tag: name too long (21)', 'tag', { t: 'tag', author: A, target: P1cid, name: 't'.repeat(21), r: 0.8, c: 0.9, auth: pa }, { expect: 400 });
  await act('tag: name missing', 'tag', { t: 'tag', author: A, target: P1cid, r: 0.8, c: 0.9, auth: pa }, { expect: 400 });
  await act('tag: r out of range', 'tag', { t: 'tag', author: A, target: P1cid, name: 'x', r: 1.5, c: 0.9, auth: pa }, { expect: 400 });
  await act('tag: c missing', 'tag', { t: 'tag', author: A, target: P1cid, name: 'x', r: 0.5, auth: pa }, { expect: 400 });
  await act('tag: target unknown', 'tag', { t: 'tag', author: A, target: 'c99999', name: 'x', r: 0.5, c: 0.5, auth: pa }, { expect: 404 });
  await act('tag: W1 gate', 'tag', { t: 'tag', author: K, target: P1cid, name: 'x', r: 0.5, c: 0.5, auth: pk }, { expect: 402 });
  await v1('tag (v1): valid, leading # stripped', 'tag', 'tag', { as: A, pin: pa, target: P1cid, name: '#Design' }, { expect: 200 });
  await v1('tag (v1): relevance/confidence honoured', 'tag', 'tag', { as: A, pin: pa, target: P1cid, name: 'Rated', relevance: 0.1, confidence: -0.1 }, { expect: 200 });
  await v1('tag (v1): name missing', 'tag', 'tag', { as: A, pin: pa, target: P1cid }, { expect: 400 });
  await v1('tag (v1): name only #', 'tag', 'tag', { as: A, pin: pa, target: P1cid, name: '#' }, { expect: 400 });

  // ── follow ────────────────────────────────────────────────────────────────
  await act('follow: valid', 'follow', { t: 'follow', from: A, to: B, auth: pa }, { expect: 200 });
  await act('follow: valid on:false', 'follow', { t: 'follow', from: A, to: B, on: false, auth: pa }, { expect: 200 });
  await act('follow: valid on:true', 'follow', { t: 'follow', from: A, to: B, on: true, auth: pa }, { expect: 200 });
  await act('follow: seed actor as target', 'follow', { t: 'follow', from: A, to: 'alice', auth: pa }, { expect: 200 });
  await act('follow: not W1-gated (zero energy still follows)', 'follow', { t: 'follow', from: K, to: A, auth: pk }, { expect: 200 });
  await act('follow: self', 'follow', { t: 'follow', from: A, to: A, auth: pa }, { expect: 400 });
  await act('follow: to unknown', 'follow', { t: 'follow', from: A, to: 'u_ghost', auth: pa }, { expect: 400 });
  await act('follow: to missing', 'follow', { t: 'follow', from: A, auth: pa }, { expect: 400 });
  await act('follow: from missing', 'follow', { t: 'follow', to: B }, { expect: 400 });
  await act('follow: on not boolean', 'follow', { t: 'follow', from: A, to: B, on: 'yes', auth: pa }, { expect: 400 });
  await act('follow: on null', 'follow', { t: 'follow', from: A, to: B, on: null, auth: pa }, { expect: 400 });
  await act('follow: PIN wrong', 'follow', { t: 'follow', from: A, to: B, auth: 'x' }, { expect: 401 });
  await v1('follow (v1): valid', 'follow', 'follow', { as: A, pin: pa, to: C }, { expect: 200 });
  await v1('follow (v1): unfollow', 'follow', 'follow', { as: A, pin: pa, to: C, on: false }, { expect: 200 });
  await v1('follow (v1): on truthy non-boolean → true', 'follow', 'follow', { as: A, pin: pa, to: C, on: 'no' }, { expect: 200 });
  await v1('follow (v1): to missing', 'follow', 'follow', { as: A, pin: pa }, { expect: 400 });
  await v1('follow (v1): to unknown', 'follow', 'follow', { as: A, pin: pa, to: 'u_ghost' }, { expect: 400 });

  // ── profile ───────────────────────────────────────────────────────────────
  await act('profile: valid full', 'profile', { t: 'profile', id: A, bio: 'I am alpha', link: 'https://example.org/alpha', pic: HP, auth: pa }, { expect: 200 });
  await act('profile: valid empty strings clear', 'profile', { t: 'profile', id: A, bio: '', link: '', pic: '', auth: pa }, { expect: 200 });
  await act('profile: valid bio only', 'profile', { t: 'profile', id: A, bio: 'b'.repeat(280), auth: pa }, { expect: 200 });
  await act('profile: valid, http link', 'profile', { t: 'profile', id: A, link: 'HTTP://EXAMPLE.ORG', auth: pa }, { expect: 200 });
  await act('profile: not W1-gated', 'profile', { t: 'profile', id: K, bio: 'broke but present', auth: pk }, { expect: 200 });
  await act('profile: unsecured handle, no auth', 'profile', { t: 'profile', id: O, bio: 'open bio' }, { expect: 200 });
  await act('profile: bio too long (281)', 'profile', { t: 'profile', id: A, bio: 'b'.repeat(281), auth: pa }, { expect: 400 });
  await act('profile: bio not a string', 'profile', { t: 'profile', id: A, bio: 5, auth: pa }, { expect: 400 });
  await act('profile: link too long', 'profile', { t: 'profile', id: A, link: 'https://' + 'l'.repeat(200), auth: pa }, { expect: 400 });
  await act('profile: link javascript:', 'profile', { t: 'profile', id: A, link: 'javascript:alert(1)', auth: pa }, { expect: 400 });
  await act('profile: link not a string', 'profile', { t: 'profile', id: A, link: 5, auth: pa }, { expect: 400 });
  await act('profile: pic bad hash', 'profile', { t: 'profile', id: A, pic: 'zzz', auth: pa }, { expect: 400 });
  await act('profile: pic unknown hash', 'profile', { t: 'profile', id: A, pic: 'e'.repeat(64), auth: pa }, { expect: 400 });
  await act('profile: pic not an image', 'profile', { t: 'profile', id: A, pic: HA, auth: pa }, { expect: 400 });
  await act('profile: id missing', 'profile', { t: 'profile', bio: 'x' }, { expect: 400 });
  await act('profile: id unregistered', 'profile', { t: 'profile', id: 'u_ghost', bio: 'x' }, { expect: 400 });
  await act('profile: PIN wrong', 'profile', { t: 'profile', id: A, bio: 'x', auth: 'x' }, { expect: 401 });
  await act('profile: someone else’s id with own PIN', 'profile', { t: 'profile', id: B, bio: 'hijack', auth: pa }, { expect: 401 });
  await v1('profile (v1): valid', 'profile', 'profile', { as: A, pin: pa, bio: 'bot bio', link: 'https://bot.example', picture: HP }, { expect: 200, note: 'the wrapper always sends bio/link/pic (empty strings when absent)' });
  await v1('profile (v1): empty body fields', 'profile', 'profile', { as: A, pin: pa }, { expect: 200 });
  await v1('profile (v1): bio too long', 'profile', 'profile', { as: A, pin: pa, bio: 'b'.repeat(281) }, { expect: 400 });

  // ── setRecovery ───────────────────────────────────────────────────────────
  const RCODE = 'recovery-code-for-alpha';
  await act('setRecovery: valid (sha256 format)', 'setRecovery', { t: 'setRecovery', id: A, codeHash: sha(A, RCODE), auth: pa }, { expect: 200 });
  await act('setRecovery: valid pbkdf2 format', 'setRecovery', { t: 'setRecovery', id: C, codeHash: pbk('charlie-code', SALT_C), auth: pc }, { expect: 200 });
  await act('setRecovery: bad hash', 'setRecovery', { t: 'setRecovery', id: A, codeHash: 'x', auth: pa }, { expect: 400 });
  await act('setRecovery: hash missing', 'setRecovery', { t: 'setRecovery', id: A, auth: pa }, { expect: 400 });
  await act('setRecovery: id missing', 'setRecovery', { t: 'setRecovery', codeHash: sha(A, RCODE) }, { expect: 400 });
  await act('setRecovery: PIN wrong', 'setRecovery', { t: 'setRecovery', id: A, codeHash: sha(A, RCODE), auth: 'x' }, { expect: 401 });
  await act('setRecovery: unsecured handle, no auth', 'setRecovery', { t: 'setRecovery', id: O, codeHash: sha(O, 'open-code') }, { expect: 200 });

  // ── bindAddress ───────────────────────────────────────────────────────────
  const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  await act('bindAddress: valid (mixed case → lowercase persisted)', 'bindAddress', { t: 'bindAddress', id: A, addr: ADDR, auth: pa }, { expect: 200 });
  await act('bindAddress: valid with surrounding whitespace (trimmed)', 'bindAddress', { t: 'bindAddress', id: C, addr: '  ' + ADDR.toLowerCase() + '  ', auth: pc }, { expect: 200 });
  await act('bindAddress: not W1-gated', 'bindAddress', { t: 'bindAddress', id: K, addr: '0x' + '1'.repeat(40), auth: pk }, { expect: 200 });
  await act('bindAddress: unsecured handle → PIN_REQUIRED', 'bindAddress', { t: 'bindAddress', id: O, addr: ADDR }, { expect: 401 });
  await act('bindAddress: bad address (39 hex)', 'bindAddress', { t: 'bindAddress', id: A, addr: '0x' + 'a'.repeat(39), auth: pa }, { expect: 400 });
  await act('bindAddress: no 0x', 'bindAddress', { t: 'bindAddress', id: A, addr: 'a'.repeat(40), auth: pa }, { expect: 400 });
  await act('bindAddress: zero address', 'bindAddress', { t: 'bindAddress', id: A, addr: '0x' + '0'.repeat(40), auth: pa }, { expect: 400 });
  await act('bindAddress: addr missing', 'bindAddress', { t: 'bindAddress', id: A, auth: pa }, { expect: 400 });
  await act('bindAddress: addr not a string', 'bindAddress', { t: 'bindAddress', id: A, addr: 5, auth: pa }, { expect: 400 });
  await act('bindAddress: PIN wrong', 'bindAddress', { t: 'bindAddress', id: A, addr: ADDR, auth: 'x' }, { expect: 401 });
  await act('bindAddress: id missing', 'bindAddress', { t: 'bindAddress', addr: ADDR }, { expect: 400 });
  await v1('bind (v1): valid', 'bindAddress', 'bind', { as: A, pin: pa, address: '0x' + '2'.repeat(40) }, { expect: 200 });
  await v1('bind (v1): addr alias', 'bindAddress', 'bind', { as: A, pin: pa, addr: '0x' + '3'.repeat(40) }, { expect: 200 });
  await v1('bind (v1): address missing', 'bindAddress', 'bind', { as: A, pin: pa }, { expect: 400 });
  await v1('bind (v1): bad address', 'bindAddress', 'bind', { as: A, pin: pa, address: '0x123' }, { expect: 400 });
  await v1('bind (v1): unsecured handle', 'bindAddress', 'bind', { as: O, address: '0x' + '4'.repeat(40) }, { expect: 401 });

  // ── tokens: assetCreate / tokenSend / pools ───────────────────────────────
  await act('assetCreate: valid ABC', 'assetCreate', { t: 'assetCreate', author: A, sym: 'ABC', name: 'Alpha Coin', supply: 1000, auth: pa }, { expect: 200 });
  await act('assetCreate: valid XYZ', 'assetCreate', { t: 'assetCreate', author: A, sym: 'XYZ', name: 'Xyz Coin', supply: 500.5, auth: pa }, { expect: 200 });
  await act('assetCreate: valid, name trimmed by replay only (persisted untrimmed)', 'assetCreate', { t: 'assetCreate', author: C, sym: 'CHR', name: '  Charlie Coin  ', supply: 10, auth: pc }, { expect: 200 });
  await act('assetCreate: sym lowercase', 'assetCreate', { t: 'assetCreate', author: A, sym: 'abc', name: 'x', supply: 10, auth: pa }, { expect: 400 });
  await act('assetCreate: sym taken', 'assetCreate', { t: 'assetCreate', author: A, sym: 'ABC', name: 'x', supply: 10, auth: pa }, { expect: 409 });
  await act('assetCreate: sym PEER taken (built-in)', 'assetCreate', { t: 'assetCreate', author: A, sym: 'PEER', name: 'x', supply: 10, auth: pa }, { expect: 409 });
  await act('assetCreate: sym too long for door (81)', 'assetCreate', { t: 'assetCreate', author: A, sym: 'S'.repeat(81), name: 'x', supply: 10, auth: pa }, { expect: 400 });
  await act('assetCreate: supply 0', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'x', supply: 0, auth: pa }, { expect: 400 });
  await act('assetCreate: supply too big', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'x', supply: 1e9 + 1, auth: pa }, { expect: 400 });
  await raw('assetCreate: supply 1e999', 'assetCreate', '{"t":"assetCreate","author":"u_alpha","sym":"DEF","name":"x","supply":1e999,"auth":"1234"}', { expect: 400 });
  await act('assetCreate: supply string', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'x', supply: '10', auth: pa }, { expect: 400 });
  await act('assetCreate: supply missing', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'x', auth: pa }, { expect: 400 });
  await act('assetCreate: name missing', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', supply: 10, auth: pa }, { expect: 400 });
  await act('assetCreate: name too long (61)', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'n'.repeat(61), supply: 10, auth: pa }, { expect: 400 });
  await act('assetCreate: author missing', 'assetCreate', { t: 'assetCreate', sym: 'DEF', name: 'x', supply: 10 }, { expect: 400 });
  await act('assetCreate: PIN wrong', 'assetCreate', { t: 'assetCreate', author: A, sym: 'DEF', name: 'x', supply: 10, auth: 'x' }, { expect: 401 });
  await act('assetCreate: zero energy → tokenActError "not enough energy" (402 via classify, BEFORE auth)', 'assetCreate', { t: 'assetCreate', author: K, sym: 'DEF', name: 'x', supply: 10, auth: 'wrong' }, { expect: 402, note: 'token acts are not in W1_GATED but tokenActError checks θ inside validate(), which runs before authError' });
  await act('tokenSend: valid', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: B, amt: 100, auth: pa }, { expect: 200 });
  await act('tokenSend: valid to charlie', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: C, amt: 50, auth: pa }, { expect: 200 });
  await act('tokenSend: valid XYZ to bravo', 'tokenSend', { t: 'tokenSend', author: A, sym: 'XYZ', to: B, amt: 10, auth: pa }, { expect: 200 });
  await act('tokenSend: fractional amount', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: B, amt: 0.000001, auth: pa }, { expect: 200 });
  await act('tokenSend: to self', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: A, amt: 1, auth: pa }, { expect: 400 });
  await act('tokenSend: unknown asset', 'tokenSend', { t: 'tokenSend', author: A, sym: 'QQQ', to: B, amt: 1, auth: pa }, { expect: 400 });
  await act('tokenSend: amount 0', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: B, amt: 0, auth: pa }, { expect: 400 });
  await act('tokenSend: amount negative', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: B, amt: -1, auth: pa }, { expect: 400 });
  await act('tokenSend: amount string', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: B, amt: '1', auth: pa }, { expect: 400 });
  await act('tokenSend: insufficient balance', 'tokenSend', { t: 'tokenSend', author: B, sym: 'ABC', to: A, amt: 1e6, auth: pb }, { expect: 400 });
  await act('tokenSend: to unknown', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: 'u_ghost', amt: 1, auth: pa }, { expect: 400 });
  await act('tokenSend: to seed actor', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', to: 'alice', amt: 1, auth: pa }, { expect: 200 });
  await act('tokenSend: to missing', 'tokenSend', { t: 'tokenSend', author: A, sym: 'ABC', amt: 1, auth: pa }, { expect: 400 });
  await act('poolCreate: valid ABC/XYZ', 'poolCreate', { t: 'poolCreate', author: A, symA: 'ABC', symB: 'XYZ', amtA: 100, amtB: 100, auth: pa }, { expect: 200 });
  await act('poolCreate: same asset twice', 'poolCreate', { t: 'poolCreate', author: A, symA: 'ABC', symB: 'ABC', amtA: 1, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolCreate: unknown asset', 'poolCreate', { t: 'poolCreate', author: A, symA: 'ABC', symB: 'QQQ', amtA: 1, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolCreate: pool exists (reversed order)', 'poolCreate', { t: 'poolCreate', author: A, symA: 'XYZ', symB: 'ABC', amtA: 1, amtB: 1, auth: pa }, { expect: 409 });
  await act('poolCreate: amount 0', 'poolCreate', { t: 'poolCreate', author: A, symA: 'ABC', symB: 'CHR', amtA: 0, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolCreate: insufficient balance', 'poolCreate', { t: 'poolCreate', author: A, symA: 'ABC', symB: 'CHR', amtA: 1, amtB: 1, auth: pa }, { expect: 400, note: 'alpha holds no CHR' });
  await act('poolCreate: liquidity too small', 'poolCreate', { t: 'poolCreate', author: C, symA: 'ABC', symB: 'CHR', amtA: 1e-9, amtB: 1e-9, auth: pc }, { expect: 400 });
  await raw('poolCreate: amtA 1e999', 'poolCreate', '{"t":"poolCreate","author":"u_alpha","symA":"ABC","symB":"CHR","amtA":1e999,"amtB":1,"auth":"1234"}', { expect: 400 });
  await act('poolCreate: symA not a string', 'poolCreate', { t: 'poolCreate', author: A, symA: 5, symB: 'CHR', amtA: 1, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolAdd: valid', 'poolAdd', { t: 'poolAdd', author: A, pool: 'ABC/XYZ', amtA: 10, amtB: 10, auth: pa }, { expect: 200 });
  await act('poolAdd: no such pool', 'poolAdd', { t: 'poolAdd', author: A, pool: 'ABC/QQQ', amtA: 1, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolAdd: amount 0', 'poolAdd', { t: 'poolAdd', author: A, pool: 'ABC/XYZ', amtA: 0, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolAdd: not enough balance', 'poolAdd', { t: 'poolAdd', author: C, pool: 'ABC/XYZ', amtA: 10, amtB: 10, auth: pc }, { expect: 400 });
  await act('poolAdd: pool missing', 'poolAdd', { t: 'poolAdd', author: A, amtA: 1, amtB: 1, auth: pa }, { expect: 400 });
  await act('poolSwap: valid', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'ABC', amt: 5, auth: pa }, { expect: 200 });
  await act('poolSwap: valid with minOut', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'XYZ', amt: 2, minOut: 0.1, auth: pa }, { expect: 200 });
  await act('poolSwap: slippage', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'ABC', amt: 1, minOut: 1000, auth: pa }, { expect: 409 });
  await act('poolSwap: wrong sell asset', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'CHR', amt: 1, auth: pa }, { expect: 400 });
  await act('poolSwap: no such pool', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/CHR', sell: 'ABC', amt: 1, auth: pa }, { expect: 400 });
  await act('poolSwap: amount 0', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'ABC', amt: 0, auth: pa }, { expect: 400 });
  await act('poolSwap: insufficient balance', 'poolSwap', { t: 'poolSwap', author: C, pool: 'ABC/XYZ', sell: 'XYZ', amt: 1, auth: pc }, { expect: 400 });
  await act('poolSwap: minOut string', 'poolSwap', { t: 'poolSwap', author: A, pool: 'ABC/XYZ', sell: 'ABC', amt: 1, minOut: '1', auth: pa }, { expect: 400 });
  await act('poolRemove: valid', 'poolRemove', { t: 'poolRemove', author: A, pool: 'ABC/XYZ', shares: 1, auth: pa }, { expect: 200 });
  await act('poolRemove: too many shares', 'poolRemove', { t: 'poolRemove', author: A, pool: 'ABC/XYZ', shares: 1e6, auth: pa }, { expect: 400 });
  await act('poolRemove: shares 0', 'poolRemove', { t: 'poolRemove', author: A, pool: 'ABC/XYZ', shares: 0, auth: pa }, { expect: 400 });
  await act('poolRemove: no such pool', 'poolRemove', { t: 'poolRemove', author: A, pool: 'nope', shares: 1, auth: pa }, { expect: 400 });
  await act('poolRemove: holds none', 'poolRemove', { t: 'poolRemove', author: B, pool: 'ABC/XYZ', shares: 1, auth: pb }, { expect: 400 });
  await act('poolRemove: zero energy', 'poolRemove', { t: 'poolRemove', author: K, pool: 'ABC/XYZ', shares: 1, auth: pk }, { expect: 402 });

  // ── event / invite / rsvp ─────────────────────────────────────────────────
  const FUTURE = Date.now() + 3600_000;
  const E1 = await act('event: valid minimal', 'event', { t: 'event', author: A, text: 'a gathering', auth: pa }, { expect: 200 });
  const E1cid = await nodeOf(E1.actIndex);
  const E2 = await act('event: valid full (fee in ABC)', 'event', { t: 'event', author: A, text: 'a paid gathering', at: FUTURE, place: 'the square', fee: 5, cur: 'ABC', cap: 3, auth: pa }, { expect: 200 });
  const E2cid = await nodeOf(E2.actIndex);
  const E3 = await act('event: valid in the past (at is not checked)', 'event', { t: 'event', author: A, text: 'already happened', at: 1000, auth: pa }, { expect: 200 });
  const E3cid = await nodeOf(E3.actIndex);
  await act('event: valid fee 0 and cap 0 (explicit "none")', 'event', { t: 'event', author: A, text: 'free explicit', fee: 0, cap: 0, cur: 'whatever', auth: pa }, { expect: 200, note: 'fee 0 skips the currency check entirely, so cur passes through unchecked' });
  await act('event: valid at = 1e21 (persists as 1e+21)', 'event', { t: 'event', author: A, text: 'far future number format', at: 1e21, auth: pa }, { expect: 200 });
  await act('event: valid text 280', 'event', { t: 'event', author: A, text: 'e'.repeat(280), auth: pa }, { expect: 200 });
  const E4 = await act('event: valid by bravo (paid, PEER, for pin cases)', 'event', { t: 'event', author: B, text: 'bravo hosts', fee: 1, cur: 'PEER', auth: pb }, { expect: 200 });
  const E4cid = await nodeOf(E4.actIndex);
  await act('event: text too long (281)', 'event', { t: 'event', author: A, text: 'e'.repeat(281), auth: pa }, { expect: 400 });
  await act('event: text missing', 'event', { t: 'event', author: A, auth: pa }, { expect: 400 });
  await act('event: at not a number', 'event', { t: 'event', author: A, text: 'x', at: 'tomorrow', auth: pa }, { expect: 400 });
  await raw('event: at 1e999', 'event', '{"t":"event","author":"u_alpha","text":"x","at":1e999,"auth":"1234"}', { expect: 400 });
  await act('event: place too long (121)', 'event', { t: 'event', author: A, text: 'x', place: 'p'.repeat(121), auth: pa }, { expect: 400 });
  await act('event: place not a string', 'event', { t: 'event', author: A, text: 'x', place: 5, auth: pa }, { expect: 400 });
  await act('event: fee negative', 'event', { t: 'event', author: A, text: 'x', fee: -1, cur: 'ABC', auth: pa }, { expect: 400 });
  await act('event: fee string', 'event', { t: 'event', author: A, text: 'x', fee: '5', cur: 'ABC', auth: pa }, { expect: 400 });
  await raw('event: fee 1e999', 'event', '{"t":"event","author":"u_alpha","text":"x","fee":1e999,"cur":"ABC","auth":"1234"}', { expect: 400 });
  await act('event: fee > 1e9', 'event', { t: 'event', author: A, text: 'x', fee: 1e9 + 1, cur: 'ABC', auth: pa }, { expect: 400 });
  await act('event: fee with bad cur', 'event', { t: 'event', author: A, text: 'x', fee: 5, cur: 'abc', auth: pa }, { expect: 400 });
  await act('event: fee with cur missing', 'event', { t: 'event', author: A, text: 'x', fee: 5, auth: pa }, { expect: 400 });
  await act('event: fee with cur of an unminted symbol passes the door', 'event', { t: 'event', author: A, text: 'priced in nothing', fee: 5, cur: 'NOPE', auth: pa }, { expect: 200, note: 'the door checks the symbol shape only; whether NOPE exists is not asked' });
  await act('event: cap 0.5', 'event', { t: 'event', author: A, text: 'x', cap: 0.5, auth: pa }, { expect: 400 });
  await act('event: cap 100001', 'event', { t: 'event', author: A, text: 'x', cap: 100001, auth: pa }, { expect: 400 });
  await act('event: cap string', 'event', { t: 'event', author: A, text: 'x', cap: '3', auth: pa }, { expect: 400 });
  await act('event: W1 gate', 'event', { t: 'event', author: K, text: 'x', auth: pk }, { expect: 402 });
  await act('event: PIN missing', 'event', { t: 'event', author: A, text: 'x' }, { expect: 401 });
  await v1('gathering (v1): valid minimal', 'event', 'gathering', { as: A, pin: pa, text: 'bot gathering' }, { expect: 200 });
  await v1('gathering (v1): valid full', 'event', 'gathering', { as: A, pin: pa, text: 'bot paid gathering', at: FUTURE, place: 'online', fee: 2, currency: 'ABC', cap: 10 }, { expect: 200 });
  await v1('gathering (v1): fee without currency defaults to PEER', 'event', 'gathering', { as: A, pin: pa, text: 'default cur', fee: 1 }, { expect: 200 });
  await v1('gathering (v1): fee as string is Number()ed', 'event', 'gathering', { as: A, pin: pa, text: 'string fee', fee: '3', cur: 'ABC' }, { expect: 200 });
  await v1('gathering (v1): text missing', 'event', 'gathering', { as: A, pin: pa }, { expect: 400 });
  await v1('gathering (v1): at invalid', 'event', 'gathering', { as: A, pin: pa, text: 'x', at: 'soon' }, { expect: 400 });
  await v1('gathering (v1): at negative', 'event', 'gathering', { as: A, pin: pa, text: 'x', at: -5 }, { expect: 400 });
  await v1('gathering (v1): cap string non-numeric → NaN → bad capacity', 'event', 'gathering', { as: A, pin: pa, text: 'x', cap: 'lots' }, { expect: 400 });
  // invite
  await act('invite: valid', 'invite', { t: 'invite', from: A, to: B, cid: E1cid, auth: pa }, { expect: 200 });
  await act('invite: valid, non-host inviting (door does not check host)', 'invite', { t: 'invite', from: B, to: C, cid: E1cid, auth: pb }, { expect: 200, note: 'replay ignores an invite whose from is not the host; the door accepts it' });
  await act('invite: not W1-gated', 'invite', { t: 'invite', from: K, to: A, cid: E1cid, auth: pk }, { expect: 200 });
  await act('invite: self', 'invite', { t: 'invite', from: A, to: A, cid: E1cid, auth: pa }, { expect: 400 });
  await act('invite: to unknown', 'invite', { t: 'invite', from: A, to: 'u_ghost', cid: E1cid, auth: pa }, { expect: 400 });
  await act('invite: cid unknown', 'invite', { t: 'invite', from: A, to: B, cid: 'c99999', auth: pa }, { expect: 404 });
  await act('invite: cid missing', 'invite', { t: 'invite', from: A, to: B, auth: pa }, { expect: 400 });
  await act('invite: cid is a post (not an event) passes the door', 'invite', { t: 'invite', from: A, to: B, cid: P1cid, auth: pa }, { expect: 200 });
  await act('invite: PIN wrong', 'invite', { t: 'invite', from: A, to: B, cid: E1cid, auth: 'x' }, { expect: 401 });
  // rsvp
  await act('rsvp: valid free event', 'rsvp', { t: 'rsvp', from: B, cid: E1cid, on: true, auth: pb }, { expect: 200 });
  await act('rsvp: valid free event, no on field', 'rsvp', { t: 'rsvp', from: C, cid: E1cid, auth: pc }, { expect: 200 });
  await act('rsvp: valid withdraw', 'rsvp', { t: 'rsvp', from: C, cid: E1cid, on: false, auth: pc }, { expect: 200 });
  await act('rsvp: valid paid (5 ABC to host)', 'rsvp', { t: 'rsvp', from: B, cid: E2cid, on: true, amt: 5, cur: 'ABC', to: A, auth: pb }, { expect: 200 });
  await act('rsvp: on not boolean', 'rsvp', { t: 'rsvp', from: B, cid: E1cid, on: 1, auth: pb }, { expect: 400 });
  await act('rsvp: cid unknown', 'rsvp', { t: 'rsvp', from: B, cid: 'c99999', auth: pb }, { expect: 404 });
  await act('rsvp: cid missing', 'rsvp', { t: 'rsvp', from: B, auth: pb }, { expect: 400 });
  await act('rsvp: cid is a post, not an event', 'rsvp', { t: 'rsvp', from: B, cid: P1cid, auth: pb }, { expect: 400 });
  await act('rsvp: amt negative', 'rsvp', { t: 'rsvp', from: B, cid: E2cid, amt: -1, cur: 'ABC', to: A, auth: pb }, { expect: 400 });
  await act('rsvp: amt with bad cur', 'rsvp', { t: 'rsvp', from: B, cid: E2cid, amt: 5, cur: 'abc', to: A, auth: pb }, { expect: 400 });
  await act('rsvp: amt without to', 'rsvp', { t: 'rsvp', from: B, cid: E2cid, amt: 5, cur: 'ABC', auth: pb }, { expect: 400 });
  await act('rsvp: paid by unsecured handle → needs a PIN', 'rsvp', { t: 'rsvp', from: O, cid: E2cid, amt: 5, cur: 'ABC', to: A }, { expect: 401 });
  await act('rsvp: price moved (amt mismatch)', 'rsvp', { t: 'rsvp', from: C, cid: E2cid, amt: 4, cur: 'ABC', to: A, auth: pc }, { expect: 409 });
  await act('rsvp: paying the wrong host', 'rsvp', { t: 'rsvp', from: C, cid: E2cid, amt: 5, cur: 'ABC', to: B, auth: pc }, { expect: 409 });
  await act('rsvp: free answer to a paid event (fee not attached)', 'rsvp', { t: 'rsvp', from: C, cid: E2cid, on: true, auth: pc }, { expect: 409, note: 'tokenActError: cur/amt/to do not match the event → "the price moved"' });
  await act('rsvp: insufficient balance', 'rsvp', { t: 'rsvp', from: A, cid: E4cid, amt: 1, cur: 'PEER', to: B, auth: pa }, { expect: 400 });
  await act('rsvp: host answering own event', 'rsvp', { t: 'rsvp', from: A, cid: E1cid, auth: pa }, { expect: 400 });
  await act('rsvp: event already happened', 'rsvp', { t: 'rsvp', from: B, cid: E3cid, auth: pb }, { expect: 400 });
  await act('rsvp: withdrawing from a past event is allowed', 'rsvp', { t: 'rsvp', from: B, cid: E3cid, on: false, auth: pb }, { expect: 200 });
  await act('rsvp: zero energy → tokenActError not enough energy', 'rsvp', { t: 'rsvp', from: K, cid: E1cid, auth: pk }, { expect: 402 });
  await act('rsvp: PIN missing', 'rsvp', { t: 'rsvp', from: B, cid: E1cid }, { expect: 401 });
  await v1('rsvp (v1): valid free', 'rsvp', 'rsvp', { as: C, pin: pc, target: E1cid }, { expect: 200 });
  await v1('rsvp (v1): valid paid, fee attached by the wrapper', 'rsvp', 'rsvp', { as: C, pin: pc, target: E2cid }, { expect: 200 });
  await v1('rsvp (v1): going false', 'rsvp', 'rsvp', { as: C, pin: pc, target: E2cid, going: false }, { expect: 200 });
  await v1('rsvp (v1): target missing', 'rsvp', 'rsvp', { as: C, pin: pc }, { expect: 400 });
  await v1('rsvp (v1): target unknown', 'rsvp', 'rsvp', { as: C, pin: pc, target: 'c99999' }, { expect: 404 });
  await v1('rsvpEvent (v1, legacy alias): valid', 'rsvp', 'rsvpEvent', { as: B, pin: pb, cid: E1cid }, { expect: 200, note: 'always sends amt/cur/to (0/""/"") — cur:"" and to:"" persist' });
  await v1('rsvpEvent (v1, legacy alias): cid missing', 'rsvp', 'rsvpEvent', { as: B, pin: pb }, { expect: 400 });
  // full event: cap 3 on E2 — bravo paid, charlie paid; make it full
  await act('rsvp: capacity check (third paid entrant fills cap 3)', 'rsvp', { t: 'rsvp', from: A, cid: E2cid, amt: 5, cur: 'ABC', to: A, auth: pa }, { note: 'host answering own event is refused before capacity' });

  // ── dm / call / stream ────────────────────────────────────────────────────
  await act('dm: valid', 'dm', { t: 'dm', from: A, to: B, text: 'hello bravo', auth: pa }, { expect: 200 });
  await act('dm: valid to seed actor', 'dm', { t: 'dm', from: A, to: 'bob', text: 'hello bob', auth: pa }, { expect: 200 });
  await act('dm: valid 500 chars', 'dm', { t: 'dm', from: A, to: B, text: 'd'.repeat(500), auth: pa }, { expect: 200 });
  await act('dm: to self is allowed', 'dm', { t: 'dm', from: A, to: A, text: 'note to self', auth: pa }, { expect: 200 });
  await act('dm: text too long (501)', 'dm', { t: 'dm', from: A, to: B, text: 'd'.repeat(501), auth: pa }, { expect: 400 });
  await act('dm: text missing', 'dm', { t: 'dm', from: A, to: B, auth: pa }, { expect: 400 });
  await act('dm: to missing → "no such recipient: undefined"', 'dm', { t: 'dm', from: A, text: 'x', auth: pa }, { expect: 400 });
  await act('dm: to unknown', 'dm', { t: 'dm', from: A, to: 'u_ghost', text: 'x', auth: pa }, { expect: 400 });
  await act('dm: from unknown', 'dm', { t: 'dm', from: 'u_ghost', to: A, text: 'x' }, { expect: 400 });
  await act('dm: PIN wrong', 'dm', { t: 'dm', from: A, to: B, text: 'x', auth: 'x' }, { expect: 401 });
  await act('dm: W1 gate', 'dm', { t: 'dm', from: K, to: A, text: 'x', auth: pk }, { expect: 402 });
  await v1('message (v1): valid', 'dm', 'message', { as: A, pin: pa, to: B, text: ' bot dm ' }, { expect: 200 });
  await v1('message (v1): to missing', 'dm', 'message', { as: A, pin: pa, text: 'x' }, { expect: 400 });
  await v1('message (v1): text missing', 'dm', 'message', { as: A, pin: pa, to: B }, { expect: 400 });
  await v1('message (v1): to unknown', 'dm', 'message', { as: A, pin: pa, to: 'u_ghost', text: 'x' }, { expect: 400 });
  await act('call: valid completed', 'call', { t: 'call', from: A, to: B, outcome: 'completed', dur: 125, auth: pa }, { expect: 200 });
  await act('call: valid missed, no dur', 'call', { t: 'call', from: A, to: B, outcome: 'missed', auth: pa }, { expect: 200 });
  await act('call: valid declined dur 0', 'call', { t: 'call', from: A, to: B, outcome: 'declined', dur: 0, auth: pa }, { expect: 200 });
  await act('call: valid failed dur 86400', 'call', { t: 'call', from: A, to: B, outcome: 'failed', dur: 86400, auth: pa }, { expect: 200 });
  await act('call: to unregistered passes the door', 'call', { t: 'call', from: A, to: 'u_ghost', outcome: 'missed', auth: pa }, { expect: 200, note: 'validate(call) checks the shape of `to` only; replay skips it' });
  await act('call: self', 'call', { t: 'call', from: A, to: A, outcome: 'completed', auth: pa }, { expect: 400 });
  await act('call: bad outcome', 'call', { t: 'call', from: A, to: B, outcome: 'ok', auth: pa }, { expect: 400 });
  await act('call: outcome missing', 'call', { t: 'call', from: A, to: B, auth: pa }, { expect: 400 });
  await act('call: dur negative', 'call', { t: 'call', from: A, to: B, outcome: 'completed', dur: -1, auth: pa }, { expect: 400 });
  await act('call: dur non-integer', 'call', { t: 'call', from: A, to: B, outcome: 'completed', dur: 1.5, auth: pa }, { expect: 400 });
  await act('call: dur 86401', 'call', { t: 'call', from: A, to: B, outcome: 'completed', dur: 86401, auth: pa }, { expect: 400 });
  await act('call: dur string', 'call', { t: 'call', from: A, to: B, outcome: 'completed', dur: '5', auth: pa }, { expect: 400 });
  await act('call: W1 gate', 'call', { t: 'call', from: K, to: A, outcome: 'completed', auth: pk }, { expect: 402 });
  await act('call: PIN missing', 'call', { t: 'call', from: A, to: B, outcome: 'completed' }, { expect: 401 });
  await act('stream: valid', 'stream', { t: 'stream', author: A, text: 'going live', a: 0.5, auth: pa }, { expect: 200 });
  await act('stream: valid 200 chars', 'stream', { t: 'stream', author: A, text: 's'.repeat(200), a: 0.5, auth: pa }, { expect: 200 });
  await act('stream: text too long (201)', 'stream', { t: 'stream', author: A, text: 's'.repeat(201), a: 0.5, auth: pa }, { expect: 400 });
  await act('stream: a out of range', 'stream', { t: 'stream', author: A, text: 'x', a: 3, auth: pa }, { expect: 400 });
  await act('stream: a missing', 'stream', { t: 'stream', author: A, text: 'x', auth: pa }, { expect: 400 });
  await act('stream: text missing', 'stream', { t: 'stream', author: A, a: 0.5, auth: pa }, { expect: 400 });
  await act('stream: W1 gate', 'stream', { t: 'stream', author: K, text: 'x', a: 0.5, auth: pk }, { expect: 402 });
  await act('stream: PIN wrong', 'stream', { t: 'stream', author: A, text: 'x', a: 0.5, auth: 'x' }, { expect: 401 });

  // ── closeEpoch (communal) → PEER distribution ─────────────────────────────
  await act('closeEpoch: valid (no auth needed)', 'closeEpoch', { t: 'closeEpoch', epoch: 1 }, { expect: 200 });
  await act('closeEpoch: valid, epoch is any finite number (2.5)', 'closeEpoch', { t: 'closeEpoch', epoch: 2.5 }, { expect: 200 });
  await act('closeEpoch: valid, epoch negative', 'closeEpoch', { t: 'closeEpoch', epoch: -1 }, { expect: 200 });
  await act('closeEpoch: extra fields stripped (author/auth ignored)', 'closeEpoch', { t: 'closeEpoch', epoch: 3, author: 'u_ghost', auth: 'x', note: 'x' }, { expect: 200, note: 'AUTHORLESS: the unregistered author is stripped by sanitize and never checked' });
  await act('closeEpoch: epoch missing', 'closeEpoch', { t: 'closeEpoch' }, { expect: 400 });
  await act('closeEpoch: epoch string', 'closeEpoch', { t: 'closeEpoch', epoch: '1' }, { expect: 400 });
  await act('closeEpoch: epoch null', 'closeEpoch', { t: 'closeEpoch', epoch: null }, { expect: 400 });
  await raw('closeEpoch: epoch 1e999', 'closeEpoch', '{"t":"closeEpoch","epoch":1e999}', { expect: 400 });
  // give the async chain sealer a moment; it writes chain/ files, never acts.jsonl
  await new Promise((r) => setTimeout(r, 300));

  // ── advert / adStop (needs PEER from the epoch distribution) ─────────────
  const tok = await get('/api/v1/tokens?as=' + A);
  const peerBal = tok && tok.balances && tok.balances.PEER || 0;
  const AD1 = await act('advert: valid 1 day', 'advert', { t: 'advert', author: A, text: 'buy alpha coin', url: 'https://example.org/ad', days: 1, auth: pa }, { note: 'PEER balance before: ' + peerBal });
  if (AD1.status !== 200) gaps.push('advert valid case: PEER balance was ' + peerBal + ' (needs 10/day) — status ' + AD1.status);
  await act('advert: valid with targeting lists', 'advert', { t: 'advert', author: A, text: 'targeted', url: 'http://example.org/', days: 2.9, placement: ['feed'], tags: ['streetart'], people: [B], posts: [P1cid], regions: ['EU'], auth: pa }, { note: 'days is floored by replay (2.9 → 2 days) but persisted as sent' });
  await act('advert: days 0', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 0, auth: pa }, { expect: 400 });
  await act('advert: days 91', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 91, auth: pa }, { expect: 400 });
  await raw('advert: days 1e999', 'advert', '{"t":"advert","author":"u_alpha","text":"x","url":"https://example.org/","days":1e999,"auth":"1234"}', { expect: 400 });
  await act('advert: days string', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: '1', auth: pa }, { expect: 400 });
  await act('advert: text missing', 'advert', { t: 'advert', author: A, url: 'https://example.org/', days: 1, auth: pa }, { expect: 400 });
  await act('advert: text too long (281)', 'advert', { t: 'advert', author: A, text: 'a'.repeat(281), url: 'https://example.org/', days: 1, auth: pa }, { expect: 400 });
  await act('advert: url bad', 'advert', { t: 'advert', author: A, text: 'x', url: 'javascript:alert(1)', days: 1, auth: pa }, { expect: 400 });
  await act('advert: url missing', 'advert', { t: 'advert', author: A, text: 'x', days: 1, auth: pa }, { expect: 400 });
  await act('advert: placement not a list', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 1, placement: 'feed', auth: pa }, { expect: 400 });
  await act('advert: tags 13 entries', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 1, tags: Array.from({ length: 13 }, (_, i) => 't' + i), auth: pa }, { expect: 400 });
  await act('advert: people entry too long', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 1, people: ['p'.repeat(41)], auth: pa }, { expect: 400 });
  await act('advert: posts entry not a string', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 1, posts: [5], auth: pa }, { expect: 400 });
  await act('advert: insufficient PEER (90 days)', 'advert', { t: 'advert', author: A, text: 'x', url: 'https://example.org/', days: 90, auth: pa }, { note: 'costs 900 PEER' });
  await act('advert: no PEER at all', 'advert', { t: 'advert', author: C, text: 'x', url: 'https://example.org/', days: 1, auth: pc }, { expect: 400 });
  await act('advert: zero energy', 'advert', { t: 'advert', author: K, text: 'x', url: 'https://example.org/', days: 1, auth: pk }, { expect: 402 });
  await act('adStop: valid own advert', 'adStop', { t: 'adStop', author: A, ad: 'ad1', auth: pa }, { note: 'ad ids are ad1, ad2… in replay order' });
  await act('adStop: unknown advert', 'adStop', { t: 'adStop', author: A, ad: 'ad999', auth: pa }, { expect: 400 });
  await act('adStop: someone else’s advert', 'adStop', { t: 'adStop', author: C, ad: 'ad2', auth: pc }, { note: 'NOT_YOURS unless no adverts exist' });
  await act('adStop: someone else’s advert with operator:true (client-settable, whitelisted)', 'adStop', { t: 'adStop', author: C, ad: 'ad2', operator: true, auth: pc }, { note: 'DEFECT: `operator` is in ACT_FIELDS.adStop and tokenActError trusts it; any client can stop any advert' });
  await act('adStop: ad missing', 'adStop', { t: 'adStop', author: A, auth: pa }, { expect: 400 });
  await act('adStop: ad not a string', 'adStop', { t: 'adStop', author: A, ad: 1, auth: pa }, { expect: 400 });

  // ── markets ───────────────────────────────────────────────────────────────
  const M1 = await act('market: valid (cur ABC, 1 seat)', 'market', { t: 'market', author: A, text: 'will it rain?', opts: ['Yes', 'No'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 200 });
  const M1cid = await nodeOf(M1.actIndex);
  await act('market: valid with mods and 7 opts, cur PEER, 5 seats', 'market', { t: 'market', author: A, text: 'seven answers', opts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], cur: 'PEER', at: FUTURE, seats: 5, bond: 0.5, feeBp: 0, mods: [B, C], auth: pa }, { expect: 200 });
  await act('market: valid, mods empty list', 'market', { t: 'market', author: A, text: 'no mods', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 3, bond: 1, feeBp: 500, mods: [], auth: pa }, { expect: 200 });
  await act('market: text too long', 'market', { t: 'market', author: A, text: 'm'.repeat(281), opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: opts not a list', 'market', { t: 'market', author: A, text: 'q', opts: 'yes,no', cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: opts missing', 'market', { t: 'market', author: A, text: 'q', cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: opt too long (61)', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'o'.repeat(61)], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: opt empty', 'market', { t: 'market', author: A, text: 'q', opts: ['x', ''], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: opt not a string', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 1], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: duplicate opts (case/space-insensitive)', 'market', { t: 'market', author: A, text: 'q', opts: ['Yes', ' yes '], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: one opt', 'market', { t: 'market', author: A, text: 'q', opts: ['only'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: eight opts', 'market', { t: 'market', author: A, text: 'q', opts: ['1', '2', '3', '4', '5', '6', '7', '8'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: at in the past', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: 1000, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: at missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: at more than a year ahead', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: Date.now() + 366 * 86400_000, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: mods too many (9)', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, mods: Array(9).fill(B), auth: pa }, { expect: 400 });
  await act('market: mods unknown handle', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, mods: ['u_ghost'], auth: pa }, { expect: 400 });
  await act('market: mods not a list', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, mods: B, auth: pa }, { expect: 400 });
  await act('market: mods entry not a string', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, mods: [5], auth: pa }, { expect: 400 });
  await act('market: cur unknown', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'QQQ', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: cur missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: seats 2', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 2, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: seats missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, bond: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: bond 0', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 0, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: bond missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: bond > 1e9', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1e9 + 1, feeBp: 100, auth: pa }, { expect: 400 });
  await act('market: feeBp 501', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 501, auth: pa }, { expect: 400 });
  await act('market: feeBp negative', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: -1, auth: pa }, { expect: 400 });
  await act('market: feeBp missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, auth: pa }, { expect: 400 });
  await act('market: W1 gate', 'market', { t: 'market', author: K, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100, auth: pk }, { expect: 402 });
  await act('market: PIN missing', 'market', { t: 'market', author: A, text: 'q', opts: ['x', 'y'], cur: 'ABC', at: FUTURE, seats: 1, bond: 1, feeBp: 100 }, { expect: 401 });
  // bets on M1
  await act('bet: valid', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 10, auth: pb }, { expect: 200 });
  await act('bet: valid fractional stake', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 1, amt: 0.5, auth: pb }, { expect: 200 });
  await act('bet: amt not a number', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: '10', auth: pb }, { expect: 400 });
  await act('bet: amt missing', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, auth: pb }, { expect: 400 });
  await raw('bet: amt 1e999', 'bet', '{"t":"bet","author":"u_bravo","cid":"' + M1cid + '","opt":0,"amt":1e999,"auth":"2222"}', { expect: 400 });
  await act('bet: opt missing', 'bet', { t: 'bet', author: B, cid: M1cid, amt: 1, auth: pb }, { expect: 400 });
  await act('bet: opt out of range', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 5, amt: 1, auth: pb }, { expect: 400 });
  await act('bet: opt non-integer', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0.5, amt: 1, auth: pb }, { expect: 400 });
  await act('bet: amt 0', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 0, auth: pb }, { expect: 400 });
  await act('bet: amt negative', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: -1, auth: pb }, { expect: 400 });
  await act('bet: amt below the micro-token', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 1e-7, auth: pb }, { expect: 400 });
  await act('bet: insufficient balance', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 1e6, auth: pb }, { expect: 400 });
  await act('bet: by the author', 'bet', { t: 'bet', author: A, cid: M1cid, opt: 0, amt: 1, auth: pa }, { expect: 400 });
  await act('bet: unsecured handle → needs a PIN', 'bet', { t: 'bet', author: O, cid: M1cid, opt: 0, amt: 1 }, { expect: 401 });
  await act('bet: cid is a post, not a market', 'bet', { t: 'bet', author: B, cid: P1cid, opt: 0, amt: 1, auth: pb }, { expect: 404 });
  await act('bet: cid unknown', 'bet', { t: 'bet', author: B, cid: 'c99999', opt: 0, amt: 1, auth: pb }, { expect: 404 });
  await act('bet: cid missing', 'bet', { t: 'bet', author: B, opt: 0, amt: 1, auth: pb }, { expect: 400 });
  await act('bet: PIN wrong', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 1, auth: 'x' }, { expect: 401 });
  await act('bet: zero energy (PIN’d, no reserve)', 'bet', { t: 'bet', author: K, cid: M1cid, opt: 0, amt: 1, auth: pk }, { expect: 402 });
  // modStand / modVote on M1
  await act('modStand: valid (charlie stands)', 'modStand', { t: 'modStand', author: C, cid: M1cid, auth: pc }, { expect: 200 });
  await act('modStand: already standing', 'modStand', { t: 'modStand', author: C, cid: M1cid, on: true, auth: pc }, { expect: 400 });
  await act('modStand: valid stand down', 'modStand', { t: 'modStand', author: C, cid: M1cid, on: false, auth: pc }, { expect: 200 });
  await act('modStand: stand again', 'modStand', { t: 'modStand', author: C, cid: M1cid, on: true, auth: pc }, { expect: 200 });
  await act('modStand: not standing, on:false', 'modStand', { t: 'modStand', author: A, cid: M1cid, on: false, auth: pa }, { expect: 400 });
  await act('modStand: by the author', 'modStand', { t: 'modStand', author: A, cid: M1cid, auth: pa }, { expect: 400 });
  await act('modStand: by a bettor', 'modStand', { t: 'modStand', author: B, cid: M1cid, auth: pb }, { expect: 400 });
  await act('modStand: unsecured handle', 'modStand', { t: 'modStand', author: O, cid: M1cid }, { expect: 401 });
  await act('modStand: unsecured handle standing DOWN needs no PIN', 'modStand', { t: 'modStand', author: O, cid: M1cid, on: false }, { expect: 400, note: 'passes the PIN gate (on:false) and fails at "you are not standing"' });
  await act('modStand: on not boolean', 'modStand', { t: 'modStand', author: C, cid: M1cid, on: 'yes', auth: pc }, { expect: 400 });
  await act('modStand: cannot afford the bond', 'modStand', { t: 'modStand', author: 'u_delta', cid: M1cid }, { note: 'u_delta has no PIN → PIN_REQUIRED sentence, before the bond' });
  await act('modStand: cid unknown', 'modStand', { t: 'modStand', author: C, cid: 'c99999', auth: pc }, { expect: 404 });
  await act('modVote: valid', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [C], auth: pb }, { expect: 200 });
  await act('modVote: valid empty ballot', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [], auth: pb }, { expect: 200 });
  await act('modVote: ballot not a list', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: C, auth: pb }, { expect: 400 });
  await act('modVote: ballot missing', 'modVote', { t: 'modVote', author: B, cid: M1cid, auth: pb }, { expect: 400 });
  await act('modVote: ballot entry not a string', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [5], auth: pb }, { expect: 400 });
  await act('modVote: too many names for the seats', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [C, A], auth: pb }, { expect: 400 });
  await act('modVote: votes for self', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [B], auth: pb }, { expect: 400 });
  await act('modVote: candidate not standing', 'modVote', { t: 'modVote', author: B, cid: M1cid, for: [A], auth: pb }, { expect: 400 });
  await act('modVote: voter has destroyed nothing', 'modVote', { t: 'modVote', author: K, cid: M1cid, for: [C], auth: pk }, { expect: 402, note: 'θ check in marketActError comes first for a zero-energy voter' });
  await act('modVote: voter with energy but no burn (u_delta, unsecured)', 'modVote', { t: 'modVote', author: 'u_delta', cid: M1cid, for: [C] }, { note: 'u_delta opened at zero, so "not enough energy" precedes the satoshi rule' });
  await act('attest: still open', 'attest', { t: 'attest', author: C, cid: M1cid, opt: 0, auth: pc }, { expect: 400 });
  await act('attest: opt missing', 'attest', { t: 'attest', author: C, cid: M1cid, auth: pc }, { expect: 400 });
  await act('attest: cid is a post', 'attest', { t: 'attest', author: C, cid: P1cid, opt: 0, auth: pc }, { expect: 404 });
  await act('marketVoid: before the deadline', 'marketVoid', { t: 'marketVoid', author: A, cid: M1cid, auth: pa }, { expect: 400 });
  await act('marketVoid: cid is a post', 'marketVoid', { t: 'marketVoid', author: A, cid: P1cid, auth: pa }, { expect: 404 });
  await act('marketVoid: cid missing', 'marketVoid', { t: 'marketVoid', author: A, auth: pa }, { expect: 400 });
  // M2: closes in ~3s so attest/closed cases can be recorded
  const SOON = Date.now() + 3000;
  const M2 = await act('market: valid, closes in 3s (for the closed-market cases)', 'market', { t: 'market', author: A, text: 'quick question', opts: ['Up', 'Down'], cur: 'ABC', at: SOON, seats: 1, bond: 1, feeBp: 100, auth: pa }, { expect: 200 });
  const M2cid = await nodeOf(M2.actIndex);
  await act('bet: valid on the short market', 'bet', { t: 'bet', author: B, cid: M2cid, opt: 0, amt: 2, auth: pb }, { expect: 200 });
  await act('modStand: valid on the short market', 'modStand', { t: 'modStand', author: C, cid: M2cid, auth: pc }, { expect: 200 });
  await act('modVote: valid on the short market', 'modVote', { t: 'modVote', author: B, cid: M2cid, for: [C], auth: pb }, { expect: 200 });
  const wait = SOON + 150 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await act('bet: market closed', 'bet', { t: 'bet', author: B, cid: M2cid, opt: 0, amt: 1, auth: pb }, { expect: 400, note: 'sentence embeds toLocaleString() — locale-dependent' });
  await act('modStand: after close', 'modStand', { t: 'modStand', author: A, cid: M2cid, auth: pa }, { expect: 400 });
  await act('modVote: after close', 'modVote', { t: 'modVote', author: B, cid: M2cid, for: [C], auth: pb }, { expect: 400 });
  await act('attest: by a non-seat', 'attest', { t: 'attest', author: B, cid: M2cid, opt: 0, auth: pb }, { expect: 400 });
  await act('attest: opt out of range', 'attest', { t: 'attest', author: C, cid: M2cid, opt: 9, auth: pc }, { expect: 400 });
  await act('attest: opt -0.5', 'attest', { t: 'attest', author: C, cid: M2cid, opt: -0.5, auth: pc }, { expect: 400 });
  await act('attest: valid (seated, resolves the 1-seat jury)', 'attest', { t: 'attest', author: C, cid: M2cid, opt: 0, auth: pc }, { expect: 200 });
  await act('attest: already certified / market resolved', 'attest', { t: 'attest', author: C, cid: M2cid, opt: 0, auth: pc }, { expect: 400 });
  await act('bet: on a resolved market (host closed check first)', 'bet', { t: 'bet', author: B, cid: M2cid, opt: 0, amt: 1, auth: pb }, { expect: 400 });
  await act('marketVoid: resolved market, before deadline', 'marketVoid', { t: 'marketVoid', author: A, cid: M2cid, auth: pa }, { expect: 400 });
  gaps.push('marketVoid valid case: needs Date.now() >= market.at + resolveMs (7 days, from replay marketLimits) — not reachable in a run');
  gaps.push('attest with opt -1 (void vote) valid case: would need a second closable market; the resolved refusal is captured instead');

  // ── setPin ────────────────────────────────────────────────────────────────
  const fresh1 = sha(F, '4321');
  await act('setPin: valid first PIN on a handle with no history', 'setPin', { t: 'setPin', id: F, pinHash: fresh1 }, { expect: 200 });
  await act('setPin: change without old PIN', 'setPin', { t: 'setPin', id: F, pinHash: sha(F, '5555') }, { expect: 401 });
  await act('setPin: change with wrong old PIN', 'setPin', { t: 'setPin', id: F, pinHash: sha(F, '5555'), auth: 'nope' }, { expect: 401 });
  await act('setPin: change with correct old PIN (legacy → upgrade appended too)', 'setPin', { t: 'setPin', id: F, pinHash: pbk('5555', SALT_H), auth: '4321' }, { expect: 200, note: 'the correct legacy PIN also queues an upgrade: alsoPersisted carries a second setPin' });
  await act('setPin: valid, pbkdf2 → pbkdf2', 'setPin', { t: 'setPin', id: F, pinHash: pbk('6789', SALT_A), auth: '5555' }, { expect: 200 });
  await act('setPin: stranger claiming a handle that has posted', 'setPin', { t: 'setPin', id: O, pinHash: sha(O, '9999') }, { expect: 401 });
  await act('setPin: operator sets a first PIN on a claimed handle', 'setPin', { t: 'setPin', id: O, pinHash: sha(O, '1111'), auth: OPERATOR }, { expect: 200, note: 'byOperator is set on the COPY authError receives, so it is NOT persisted' });
  await act('setPin: operator resets an existing PIN', 'setPin', { t: 'setPin', id: O, pinHash: sha(O, '1212'), auth: OPERATOR }, { expect: 200 });
  await act('setPin: client-supplied byOperator persists (whitelisted field)', 'setPin', { t: 'setPin', id: O, pinHash: sha(O, '1313'), byOperator: true, byRecovery: 'yes', auth: '1212' }, { expect: 200, note: 'DEFECT: byOperator/byRecovery are whitelisted and unchecked, so a client can stamp them' });
  await act('setPin: bad pinHash', 'setPin', { t: 'setPin', id: F, pinHash: 'zzz', auth: '6789' }, { expect: 400 });
  await act('setPin: pinHash missing', 'setPin', { t: 'setPin', id: F, auth: '6789' }, { expect: 400 });
  await act('setPin: id missing', 'setPin', { t: 'setPin', pinHash: fresh1 }, { expect: 400 });
  await act('setPin: id unknown', 'setPin', { t: 'setPin', id: 'u_ghost', pinHash: sha('u_ghost', '1') }, { expect: 400 });
  await act('setPin: not W1-gated (broke handle changes PIN)', 'setPin', { t: 'setPin', id: K, pinHash: pbk(pk, SALT_B), auth: pk }, { expect: 200 });
  // recovery: /api/auth/recover mints a setPin with byRecovery:true
  await run('recover (aux): valid code → setPin byRecovery', 'setPin', 'aux', { path: '/api/auth/recover', body: { as: A, code: RCODE, pinHash: pbk(pa, SALT_A) } }, { aux: true, expect: 200 });
  await run('recover (aux): wrong code', 'setPin', 'aux', { path: '/api/auth/recover', body: { as: A, code: 'nope', pinHash: pbk(pa, SALT_A) } }, { aux: true, expect: 401 });
  await run('recover (aux): bad new hash', 'setPin', 'aux', { path: '/api/auth/recover', body: { as: A, code: RCODE, pinHash: 'zzz' } }, { aux: true, expect: 400 });
  // PIN attempts limiter: 12 failures then the 13th from ONE address is 429
  const LIMIP = '10.99.99.99';
  for (let i = 0; i < 12; i++) await http('POST', '/api/act', { body: { t: 'post', author: A, text: 'x', a: 0.5, auth: 'wrong' + i }, ip: LIMIP });
  await act('post: 13th wrong PIN from one address → PIN_ATTEMPTS 429', 'post', { t: 'post', author: A, text: 'x', a: 0.5, auth: 'wrong12' }, { ip: LIMIP, expect: 429, note: '12 prior failures from this IP were sent unrecorded' });
  await act('post: correct PIN from the locked address still succeeds', 'post', { t: 'post', author: A, text: 'not locked out with the right pin', a: 0.5, auth: pa }, { ip: LIMIP, expect: 200, note: 'pinFailLimiter is consulted only when authError already failed' });
  await act('deleteAccount: unsecured handle refused from the locked address is 429 not 401', 'deleteAccount', { t: 'deleteAccount', id: 'u_delta' }, { ip: LIMIP, expect: 429, note: 'ANY authError from a locked IP becomes 429, including PIN_REQUIRED' });

  // ── setKey + passkeys ─────────────────────────────────────────────────────
  const KEY = makeKey();
  await act('setKey: valid on a PIN-secured handle', 'setKey', { t: 'setKey', id: A, credId: 'alpha-key-1', cose: KEY.cose, label: 'phone', auth: pa }, { expect: 200 });
  await act('setKey: valid without label', 'setKey', { t: 'setKey', id: A, credId: 'alpha-key-2', cose: [[1, 2]], auth: pa }, { expect: 200 });
  await act('setKey: signCount is not whitelisted (stripped)', 'setKey', { t: 'setKey', id: A, credId: 'alpha-key-3', cose: [[1, 2]], signCount: 99, auth: pa }, { expect: 200 });
  await act('setKey: cose not a list', 'setKey', { t: 'setKey', id: A, credId: 'k', cose: 'x', auth: pa }, { expect: 400 });
  await act('setKey: cose too long (17)', 'setKey', { t: 'setKey', id: A, credId: 'k', cose: Array(17).fill([1, 2]), auth: pa }, { expect: 400 });
  await act('setKey: credId too long (513)', 'setKey', { t: 'setKey', id: A, credId: 'c'.repeat(513), cose: [[1, 2]], auth: pa }, { expect: 400 });
  await act('setKey: credId missing', 'setKey', { t: 'setKey', id: A, cose: [[1, 2]], auth: pa }, { expect: 400 });
  await act('setKey: credId empty', 'setKey', { t: 'setKey', id: A, credId: '', cose: [[1, 2]], auth: pa }, { expect: 400 });
  await act('setKey: id missing', 'setKey', { t: 'setKey', credId: 'k', cose: [[1, 2]] }, { expect: 400 });
  await act('setKey: PIN wrong', 'setKey', { t: 'setKey', id: A, credId: 'k', cose: [[1, 2]], auth: 'x' }, { expect: 401 });
  await act('setKey: valid removal of all keys (credId null)', 'setKey', { t: 'setKey', id: A, credId: null, auth: pa }, { expect: 200 });
  const G = 'u_golf';
  await act('setKey: unsecured handle attaches its first passkey (no auth needed)', 'setKey', { t: 'setKey', id: G, credId: 'golf-key-1', cose: KEY.cose, label: 'golf phone' }, { expect: 200 });
  await act('profile: passkey-only handle with a PIN string → PASSKEY_REQUIRED', 'profile', { t: 'profile', id: G, bio: 'x', auth: '1234' }, { expect: 401 });
  await act('profile: passkey-only handle with no auth', 'profile', { t: 'profile', id: G, bio: 'x' }, { expect: 401 });
  await act('profile: assertion with unknown credId', 'profile', { t: 'profile', id: G, bio: 'x', auth: { credId: 'nope', challenge: 'x' } }, { expect: 401 });
  await act('profile: assertion with a bogus challenge', 'profile', { t: 'profile', id: G, bio: 'x', auth: { credId: 'golf-key-1', challenge: 'not-issued', ...assertWith(KEY.privateKey, 'not-issued') } }, { expect: 401 });
  {
    const ch = await challengeFor(G);
    const other = makeKey();
    await act('profile: assertion signed by the wrong key', 'profile', { t: 'profile', id: G, bio: 'x', auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(other.privateKey, ch) } }, { expect: 401 });
  }
  {
    const ch = await challengeFor(G);
    await act('profile: assertion for a different rpId', 'profile', { t: 'profile', id: G, bio: 'x', auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { rpId: 'evil.example' }) } }, { expect: 401 });
  }
  {
    const ch = await challengeFor(G);
    const a1 = assertWith(KEY.privateKey, ch, { counter: 5 });
    await act('profile: valid passkey assertion (rpId localhost, no origin pin)', 'profile', { t: 'profile', id: G, bio: 'signed in with a passkey', auth: { credId: 'golf-key-1', challenge: ch, signCount: 5, ...a1 } }, { expect: 200, note: 'auth is stripped; nothing about the assertion persists' });
    await act('profile: the same challenge replayed', 'profile', { t: 'profile', id: G, bio: 'replay', auth: { credId: 'golf-key-1', challenge: ch, signCount: 6, ...a1 } }, { expect: 401 });
  }
  {
    const ch = await challengeFor(G);
    await act('bindAddress: passkey-only handle may bind (PIN_REQUIRED accepts a passkey)', 'bindAddress', { t: 'bindAddress', id: G, addr: '0x' + '5'.repeat(40), auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { counter: 7 }) } }, { expect: 200 });
  }
  {
    const ch = await challengeFor(G);
    await v1('profile (v1): passkey assertion under `auth`', 'profile', 'profile', { as: G, auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { counter: 8 }) }, bio: 'bot with passkey' }, { expect: 200 });
  }
  {
    const ch = await challengeFor(G);
    await v1('profile (v1): passkey assertion under `pin`', 'profile', 'profile', { as: G, pin: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { counter: 9 }) }, bio: 'bot with passkey in pin' }, { expect: 200 });
  }
  {
    const ch = await challengeFor(G);
    await act('post: valid passkey but zero energy → 402 (auth precedes W1)', 'post', { t: 'post', author: G, text: 'x', a: 0.5, auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { counter: 10 }) } }, { expect: 402 });
  }
  {
    const ch = await challengeFor(G);
    await act('setKey: passkey-only handle removes its key with a passkey', 'setKey', { t: 'setKey', id: G, credId: null, auth: { credId: 'golf-key-1', challenge: ch, ...assertWith(KEY.privateKey, ch, { counter: 11 }) } }, { expect: 200 });
  }
  await act('profile: after removal the handle is unsecured again', 'profile', { t: 'profile', id: G, bio: 'open again' }, { expect: 200 });

  // ── deletePost ────────────────────────────────────────────────────────────
  const DP = await act('post: (to be deleted)', 'post', { t: 'post', author: A, text: 'DOOMED PAYLOAD with @Bravo', a: 0.5, media: [{ h: HP, m: 'image/png' }], auth: pa }, { expect: 200 });
  const DPR = await act('post: (revision of the doomed post)', 'post', { t: 'post', author: A, text: 'DOOMED PAYLOAD revised', a: 0.5, target: DP.actIndex, auth: pa }, { expect: 200 });
  await act('deletePost: target non-integer', 'deletePost', { t: 'deletePost', author: A, target: 'c1', auth: pa }, { expect: 400 });
  await act('deletePost: target missing', 'deletePost', { t: 'deletePost', author: A, auth: pa }, { expect: 400 });
  await act('deletePost: target not a post (register act)', 'deletePost', { t: 'deletePost', author: A, target: 1, auth: pa }, { expect: 400 });
  await act('deletePost: target out of range', 'deletePost', { t: 'deletePost', author: A, target: 99999, auth: pa }, { expect: 400 });
  await act('deletePost: someone else’s post', 'deletePost', { t: 'deletePost', author: B, target: DP.actIndex, auth: pb }, { expect: 400 });
  await act('deletePost: unsecured handle → PIN_REQUIRED', 'deletePost', { t: 'deletePost', author: 'u_delta', target: DP.actIndex }, { expect: 401 });
  await act('deletePost: PIN missing', 'deletePost', { t: 'deletePost', author: A, target: DP.actIndex }, { expect: 401 });
  await act('deletePost: PIN wrong', 'deletePost', { t: 'deletePost', author: A, target: DP.actIndex, auth: 'x' }, { expect: 401 });
  await act('deletePost: valid, naming the REVISION (tombstone rewritten to the mint index)', 'deletePost', { t: 'deletePost', author: A, target: DPR.actIndex, auth: pa }, { expect: 200, note: 'validate mutates act.target = mintIndexOf(target); redaction rewrites the mint AND revision lines in place (text "", media dropped, rmen stamped, redacted:true)' });
  await act('deletePost: already deleted', 'deletePost', { t: 'deletePost', author: A, target: DP.actIndex, auth: pa }, { expect: 400 });
  await act('post: revising a deleted post', 'post', { t: 'post', author: A, text: 'necromancy', a: 0.5, target: DP.actIndex, auth: pa }, { expect: 400 });
  await act('deletePost: valid on an event (place blanked)', 'deletePost', { t: 'deletePost', author: A, target: E2.actIndex, auth: pa }, { expect: 200 });
  await act('rsvp: to a deleted event', 'rsvp', { t: 'rsvp', from: C, cid: E2cid, on: true, amt: 5, cur: 'ABC', to: A, auth: pc }, { expect: 400 });
  await act('deletePost: valid on a market (opts blanked, count kept)', 'deletePost', { t: 'deletePost', author: A, target: M1.actIndex, auth: pa }, { expect: 200 });
  await act('bet: on a deleted market', 'bet', { t: 'bet', author: B, cid: M1cid, opt: 0, amt: 1, auth: pb }, { expect: 400 });
  await act('deletePost: a review act is not deletable this way', 'deletePost', { t: 'deletePost', author: B, target: R1.actIndex, auth: pb }, { expect: 400 });
  await act('deletePost: not W1-gated (broke handle deletes own post? has none → not-a-post)', 'deletePost', { t: 'deletePost', author: K, target: DP.actIndex, auth: pk }, { expect: 400 });
  await act('review: revising a deleted comment? (comment on the deleted post still revisable)', 'review', { t: 'review', author: B, target: P1cid, e: 0.1, f: 0.1, text: 'still here', upd: R1.actIndex, auth: pb }, { expect: 200 });

  // ── retired doors ─────────────────────────────────────────────────────────
  await act('burn: faucet closed', 'burn', { t: 'burn', id: A, amt: 1, auth: pa }, { expect: 400 });
  await act('burn: unknown id is refused as no such handle first', 'burn', { t: 'burn', id: 'u_ghost', amt: 1 }, { expect: 400 });
  await act('btcBurn: host-only', 'btcBurn', { t: 'btcBurn', id: A, txid: TX(9), sats: 1000, addr: 'bc1qdead', ts: 1, auth: pa }, { expect: 400 });
  await act('peerBurn: host-only', 'peerBurn', { t: 'peerBurn', id: A, txid: '0x' + 'a'.repeat(64), from: '0x' + '1'.repeat(40), amtRaw: '1000', factory: '0x' + '2'.repeat(40), pool: 0, startsAt: 1, endsAt: 2, refHash: '0x' + 'b'.repeat(64), blocks: [1, 2], resPeerRaw: '1', resBtcRaw: '1', twapMs: 1000, obs: 2, sats: 1, creditsSats: 1, reserve: 0.01, addr: '0x' + '3'.repeat(40), blockMs: 1, ts: 1, auth: pa }, { expect: 400 });
  await act('resetTokens: operator-only', 'resetTokens', { t: 'resetTokens', id: A, ts: 1, auth: pa }, { expect: 400 });
  await act('editPost: retired', 'editPost', { t: 'editPost', author: A, target: P1.actIndex, text: 'x', auth: pa }, { expect: 400 });
  await act('editPost: retired, even unauthenticated', 'editPost', { t: 'editPost', author: A, target: P1.actIndex, text: 'x' }, { expect: 400, note: 'validate refuses before authError' });
  await act('btcClaim: retired', 'btcClaim', { t: 'btcClaim', author: A, auth: pa }, { expect: 400 });
  await act('deposit: Layer 0 retired', 'deposit', { t: 'deposit', id: A, amt: 1, auth: pa }, { expect: 400 });
  await act('burnL0: Layer 0 retired', 'burnL0', { t: 'burnL0', id: A, x: 1, auth: pa }, { expect: 400 });
  await act('redeem: Layer 0 retired', 'redeem', { t: 'redeem', id: A, x: 1, auth: pa }, { expect: 400 });
  await act('transferL0: Layer 0 retired', 'transferL0', { t: 'transferL0', from: A, to: B, x: 1, cls: 'live', auth: pa }, { expect: 400 });
  await act('closeCycle: Layer 0 retired (authorless)', 'closeCycle', { t: 'closeCycle' }, { expect: 400 });
  await act('closeCycle: extra fields, still refused', 'closeCycle', { t: 'closeCycle', id: 'u_ghost', auth: 'x' }, { expect: 400 });
  await act('deposit: unknown id → no such handle precedes the retirement notice', 'deposit', { t: 'deposit', id: 'u_ghost', amt: 1 }, { expect: 400 });

  // ── deleteAccount (last: it redacts everything bravo wrote) ──────────────
  await act('deleteAccount: unsecured handle → PIN_REQUIRED', 'deleteAccount', { t: 'deleteAccount', id: 'u_delta' }, { expect: 401 });
  await act('deleteAccount: unknown handle', 'deleteAccount', { t: 'deleteAccount', id: 'u_ghost' }, { expect: 400 });
  await act('deleteAccount: seed actor (registered but no register act)', 'deleteAccount', { t: 'deleteAccount', id: 'alice' }, { expect: 400, note: 'isRegistered passes; validate then finds no register act → "unknown handle"' });
  await act('deleteAccount: id missing', 'deleteAccount', { t: 'deleteAccount' }, { expect: 400 });
  await act('deleteAccount: PIN wrong', 'deleteAccount', { t: 'deleteAccount', id: B, auth: 'x' }, { expect: 401 });
  await act('deleteAccount: someone else’s handle with own PIN', 'deleteAccount', { t: 'deleteAccount', id: B, auth: pa }, { expect: 401 });
  await act('deleteAccount: valid (bravo; posts/events/markets redacted, review/dm text blanked)', 'deleteAccount', { t: 'deleteAccount', id: B, auth: pb }, { expect: 200 });
  await act('deleteAccount: already deleted', 'deleteAccount', { t: 'deleteAccount', id: B, auth: pb }, { expect: 400 });
  await act('post: by a deleted account', 'post', { t: 'post', author: B, text: 'from beyond', a: 0.5, auth: pb }, { expect: 410 });
  await act('dm: to a deleted account', 'dm', { t: 'dm', from: A, to: B, text: 'anyone there?', auth: pa }, { expect: 410 });
  await act('follow: a deleted account', 'follow', { t: 'follow', from: A, to: B, auth: pa }, { expect: 410 });
  await act('register: a deleted id cannot be re-registered', 'register', { t: 'register', id: B, handle: 'Bravo2', seed: 1, epoch: 0 }, { expect: 400 });
  await act('opinion: vouching a deleted account still passes the door', 'opinion', { t: 'opinion', author: A, target: 'prof_' + B, p: 0.5, r: 0.5, auth: pa }, { expect: 200, note: 'act.to is unset for opinion, so the deleted-recipient check does not fire' });
  await v1('post (v1): as a deleted account', 'post', 'post', { as: B, pin: pb, text: 'ghost bot' }, { expect: 410 });
  await v1('message (v1): to a deleted account', 'dm', 'message', { as: A, pin: pa, to: B, text: 'x' }, { expect: 410 });

  // ── W1 sweep: every gated kind from the broke handle, in one place ────────
  await act('W1 sweep: stream', 'stream', { t: 'stream', author: K, text: 'x', a: 0.5, auth: pk }, { expect: 402 });
  await act('W1 sweep: energy exactly at threshold is enough (alpha still rich)', 'post', { t: 'post', author: A, text: 'still solvent', a: 0.5, auth: pa }, { expect: 200 });
  const who = await get('/api/v1/whoami?as=' + K);
  cases.push({ name: 'W1 sweep: whoami of the broke handle', kind: 'door', via: 'v1', request: { method: 'GET', path: '/api/v1/whoami?as=' + K }, status: 200, response: who, persisted: null, note: 'energy 0, canAct false: the state behind every 402 above; θ = ' + THETA });
} finally {
  killHost();
  await new Promise((r) => setTimeout(r, 200));
}

// ── Write ───────────────────────────────────────────────────────────────────
const finalLog = readLog();
const kindsExercised = new Set(cases.map((c) => c.kind));
const kindsAccepted = new Set(cases.filter((c) => c.status === 200 && c.persisted && ACT_KINDS.includes(c.kind)).map((c) => c.kind));
const kindsNoValid = ACT_KINDS.filter((k) => !kindsAccepted.has(k));
const missing = ACT_KINDS.filter((k) => !kindsExercised.has(k));
const unexpected = cases.filter((c) => c.unexpectedStatus);

const out = {
  generator: 'webapp/tools/gen-door-vectors.mjs',
  generatedAt: new Date().toISOString(),
  serverSha256: sha256hex(src),
  theta: cases.length ? undefined : undefined,
  note: 'Golden vectors for the act door of webapp/server.mjs, captured from a real host on a throwaway data dir. `persisted` is the exact acts.jsonl line the host appended (utf-8, no trailing newline); `rewritten` lists lines the same request changed in place (redaction). Fields ts (Date.now), pbkdf2 salts, passkey bytes and toLocaleString() sentences are non-deterministic across runs. `ip` is the spoofed CF-Connecting-IP each request used so the per-IP limiters never interfere (one case exercises the PIN limiter deliberately). Cases with via "aux" (auxCases) exercise doors other than /api/act and /api/v1/* that also write acts (recover) or that the door depends on (media).',
  seed: { pins: PIN, operatorToken: OPERATOR, acts: seedLines },
  actKinds: ACT_KINDS,
  actFields: ACT_FIELDS,
  cases,
  auxCases,
  finalLog,
  summary: {
    cases: cases.length,
    auxCases: auxCases.length,
    perKind: kindCounts,
    kindsWithAcceptedVector: [...kindsAccepted].sort(),
    kindsWithoutAcceptedVector: kindsNoValid,
    kindsNotExercised: missing,
    unexpectedStatuses: unexpected.map((c) => ({ name: c.name, ...c.unexpectedStatus })),
    gaps,
  },
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');

// Cleanup the throwaway dir (best effort; Windows may hold a handle briefly).
for (let i = 0; i < 5; i++) {
  try { rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
}

console.log('wrote ' + OUT);
console.log('cases: ' + cases.length + ' (+' + auxCases.length + ' aux), final log lines: ' + finalLog.length);
console.log('per kind: ' + JSON.stringify(kindCounts));
console.log('kinds without an accepted vector: ' + JSON.stringify(kindsNoValid));
console.log('kinds not exercised: ' + JSON.stringify(missing));
if (unexpected.length) {
  console.log('UNEXPECTED STATUSES (' + unexpected.length + '):');
  for (const c of unexpected) console.log('  - ' + c.name + ': expected ' + c.unexpectedStatus.expected + ' got ' + c.unexpectedStatus.got + ' — ' + JSON.stringify(c.response && (c.response.error || c.response)).slice(0, 200));
}
if (gaps.length) { console.log('gaps:'); for (const g of gaps) console.log('  - ' + g); }
if (stderrBuf.trim()) console.log('host stderr (tail):\n' + stderrBuf.slice(-2000));

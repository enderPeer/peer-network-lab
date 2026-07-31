// Minimal shared host for the Peer social sandbox (roadmap Phase-3 lite).
// Owns the append-only act log; every client replays it deterministically.
//   GET  /            → the assembled sandbox page
//   GET  /api/acts    → { acts } (optionally ?since=N for the tail)
//   POST /api/act     → append one validated act, returns the full log
// Persistence: server-data/acts.jsonl (one JSON act per line).
// Run: node server.mjs [port]   (default 5210)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, 'public/peer-social-preview.html');
const DATA_DIR = resolve(here, 'server-data');
const LOG = resolve(DATA_DIR, 'acts.jsonl');
const PORT = Number(process.argv[2] ?? 5210);

const ACT_KINDS = new Set(['register', 'burn', 'post', 'opinion', 'review', 'tag', 'closeEpoch']);
const MAX_ACT_BYTES = 4096;
const MAX_ACTS = 50000;

mkdirSync(DATA_DIR, { recursive: true });
const acts = [{ t: 'seedWorld' }];
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { acts.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
}

function persist(act) {
  appendFileSync(LOG, JSON.stringify(act) + '\n', 'utf8');
}

function json(res, code, body) {
  const buf = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
  const actor = act.t === 'register' ? null : (act.author ?? (act.t === 'burn' ? act.id : null));
  if (!actor) return null; // closeEpoch is communal; register is checked for uniqueness only
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
  }
  return null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/acts') {
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    json(res, 200, { acts: acts.slice(since), total: acts.length });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_ACT_BYTES * 2) req.destroy(); });
    req.on('end', () => {
      let act;
      try { act = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
      const err = validate(act);
      if (err) { json(res, err === 'handle already registered' ? 409 : 400, { error: err }); return; }
      const aerr = authError(act);
      if (aerr) { json(res, 401, { error: aerr }); return; }
      delete act.auth; // the raw PIN must never enter the public log
      acts.push(act);
      persist(act);
      if (act.t === 'register' && act.pinHash) pinIndex.set(act.id, act.pinHash);
      json(res, 200, { acts, total: acts.length });
    });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const page = readFileSync(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' + page.toString() + '</body></html>');
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

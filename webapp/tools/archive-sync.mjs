#!/usr/bin/env node
// The record, replicating itself: pull the act log, chain and media from
// whichever published host answers, verify the chain against the log, and
// refresh the static archive — the copy every reader falls back to when no
// host is up, and the copy any future host can be rebuilt from.
//
// Why this exists. publish-site.ps1 -Archive does the same thing FROM the
// primary's own disk, which means the archive is only as fresh as the last
// time the author's machine ran it. This runs on GitHub's machines on a
// schedule (.github/workflows/archive.yml), so the published archive tracks
// the live network even when every machine of the author's is asleep — and
// when the network dies for good, the archive holds its last verified state.
//
// What it will never do: publish a record it could not verify. A chain that
// does not check out against the log it came with is not published, and —
// review-hardened — neither is a chain signed by a DIFFERENT producer key
// than the one already published: an internally consistent forgery from a
// hostile host must not become the canonical fallback. Rotating the key is
// a human act (publish once with publish-site.ps1, which writes the new
// producer into the manifest this script pins against). It also never
// writes a media blob that does not hash to its own name, and it deletes
// archived blobs the log no longer references — redaction a mirror ignores
// is not redaction.
//
// Fetch order matters: chain first, acts second. An epoch sealing between
// the two fetches then leaves the log AHEAD of the chain, which verifies
// with a warning; the reverse order would hard-fail on a block the fetched
// log cannot close yet.
//
// Zero dependencies, node stdlib only, like everything else here.
//
//   node tools/archive-sync.mjs --site <gh-pages checkout> [--dry-run]
//
// Exit codes: 0 = archive refreshed, nothing to do, or a transient
// mid-fetch skew (host down is NOT an error); 1 = the fetched record FAILED
// verification, the producer key changed, or an I/O fault.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const SITE = resolve(arg('--site', '.'));
const DRY = flag('--dry-run');
const TIMEOUT = Math.max(5000, Number(arg('--timeout', '20000')));
const MAX_BLOB = 32 * 1024 * 1024;       // the host caps uploads well below this
const MAX_LOG_BYTES = 64 * 1024 * 1024;  // a 64 MB act log is not this network

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const isHttp = (u) => /^https?:\/\/[^\s]+$/i.test(u);

async function fetchRaw(url, accept) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'user-agent': 'peer-archive-sync/1', ...(accept ? { accept } : {}) },
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_LOG_BYTES) throw new Error('response exceeds ' + MAX_LOG_BYTES + ' bytes');
  return { buf, type: r.headers.get('content-type') || '' };
}
// JSON with a gunzip RETRY only — never applied to media blobs, whose bytes
// must reach the hash check exactly as served.
async function fetchJson(url) {
  const { buf } = await fetchRaw(url, 'application/json');
  try { return JSON.parse(buf.toString('utf8')); }
  catch {
    const un = gunzipSync(buf); // throws if it was not gzip — and then so does the caller
    return JSON.parse(un.toString('utf8'));
  }
}

// ── 1. Find a live host through the published address book ────────────────
const hostPath = join(SITE, 'host.json');
if (!existsSync(hostPath)) { console.error('no host.json at ' + hostPath); process.exit(1); }
const cfg = JSON.parse(readFileSync(hostPath, 'utf8'));
const candidates = [...new Set([
  cfg.url,
  ...(Array.isArray(cfg.urls) ? cfg.urls : []),
  ...(Array.isArray(cfg.candidates) ? cfg.candidates : []),
].map(clean).filter(isHttp))];

let source = null;
for (const u of candidates) {
  try {
    const st = await fetchJson(u + '/api/v1/state');
    if (typeof st.actors !== 'number') throw new Error('not a peer host');
    source = u;
    console.log('live host: ' + u + ' (' + st.actors + ' actors, cursor ' + st.cursor + ')');
    break;
  } catch (e) {
    console.log('down: ' + u + ' — ' + String(e.message || e).slice(0, 120));
  }
}
if (!source) {
  console.log('No published host answered. The archive keeps its last verified state — that is its job.');
  process.exit(0);
}

const archDir = join(SITE, 'archive');
const oldManifest = existsSync(join(archDir, 'manifest.json'))
  ? JSON.parse(readFileSync(join(archDir, 'manifest.json'), 'utf8')) : null;

// ── 2. The chain, exactly as the host publishes it — fetched BEFORE the
// log (see the ordering note above). No chain is a legal state (a young
// host before its first seal); a chain that fails to verify is not. ────────
let blocksBuf = null, headBuf = null, headInfo = null;
try {
  headBuf = (await fetchRaw(source + '/api/chain/head', 'application/json')).buf;
  const head = JSON.parse(headBuf.toString('utf8'));
  headInfo = { height: Number(head.height) || 0, hash: head.hash || null, producer: head.producer || null };
  blocksBuf = (await fetchRaw(source + '/api/chain', 'application/x-ndjson')).buf;
  if (blocksBuf[0] === 0x1f && blocksBuf[1] === 0x8b) blocksBuf = gunzipSync(blocksBuf); // a proxy relabeled it
  if (blocksBuf[0] !== 0x7b) throw new Error('chain endpoint returned something that is not a block file'); // '{'
  const lines = blocksBuf.toString('utf8').split('\n').filter((l) => l.trim());
  const tip = JSON.parse(lines[lines.length - 1]);
  if (Number(tip.height) !== headInfo.height) {
    console.log('chain advanced between fetches (head ' + headInfo.height + ' vs blocks ' + tip.height + ') — a later run will catch up');
    process.exit(0);
  }
} catch (e) {
  if (e.status === 404) { console.log('host has sealed no chain yet — publishing the log without one'); blocksBuf = null; headBuf = null; headInfo = null; }
  else { console.error('could not fetch the chain: ' + (e.message || e)); process.exit(1); }
}

// The producer pin: the record's continuity is the KEY, not the host. A
// fetched chain signed by a different producer than the published archive's
// is refused outright, however well it verifies against itself.
const pinnedProducer = oldManifest?.chain?.producer || null;
if (pinnedProducer && headInfo && headInfo.producer && headInfo.producer !== pinnedProducer) {
  console.error('REFUSED: the fetched chain is signed by producer ' + String(headInfo.producer).slice(0, 16)
    + '… but the published archive pins ' + String(pinnedProducer).slice(0, 16)
    + '…. If this is a deliberate key rotation, publish once by hand (publish-site.ps1 -Archive) to move the pin.');
  process.exit(1);
}

// ── 3. The log. /api/acts serves the in-memory array whose [0] is a
// synthetic seedWorld that never reaches the persisted file; every mirror
// filters it and so do we. parse→stringify is byte-stable for this log
// (verified against the primary's own file), so these lines match what the
// host persists. ───────────────────────────────────────────────────────────
const actsReply = await fetchJson(source + '/api/acts');
if (!Array.isArray(actsReply.acts)) { console.error('no acts array from ' + source); process.exit(1); }
const acts = actsReply.acts.filter((a) => a && a.t !== 'seedWorld');
if (acts.length < 1) { console.error('empty log from ' + source + ' — refusing to replace the archive with nothing'); process.exit(1); }
const logText = acts.map((a) => JSON.stringify(a)).join('\n') + '\n';
const logBuf = Buffer.from(logText, 'utf8');
const logSha = sha256(logBuf);

if (oldManifest && typeof oldManifest.acts === 'number' && acts.length < oldManifest.acts) {
  // A shrink is legal (redaction rewrites, account deletion) but worth saying
  // out loud — the chain verification below is what decides if it stands.
  console.log('NOTE: fetched log has ' + acts.length + ' acts, published archive had ' + oldManifest.acts + ' — a rewrite happened upstream.');
}

// ── 4. Verify BEFORE touching the site. The verifier replays the whole log
// and checks every root and signature — pinned to the published producer
// key, so exit 0 means "the same author's record, intact", not merely
// "internally consistent". ─────────────────────────────────────────────────
const tmp = join(tmpdir(), 'peer-archive-' + process.pid);
mkdirSync(join(tmp, 'chain'), { recursive: true });
writeFileSync(join(tmp, 'acts.jsonl'), logBuf);
if (blocksBuf) {
  writeFileSync(join(tmp, 'chain', 'blocks.jsonl'), blocksBuf);
  const vArgs = [join(webappDir, 'chain', 'verify.mjs'),
    '--acts', join(tmp, 'acts.jsonl'), '--chain', join(tmp, 'chain', 'blocks.jsonl')];
  if (pinnedProducer) vArgs.push('--producer', pinnedProducer);
  const v = spawnSync(process.execPath, vArgs, { encoding: 'utf8', timeout: 300_000 });
  process.stdout.write(v.stdout || '');
  process.stderr.write(v.stderr || '');
  if (v.status !== 0) {
    console.error('VERIFICATION FAILED — this record will not be published. The archive keeps its previous verified state.');
    process.exit(1);
  }
} else {
  console.log('no chain to verify; log passed structural checks (' + acts.length + ' parseable acts)');
}

// ── 5. Media: fetch what the log references and we lack, verify every blob
// hashes to its own name, and delete what the log no longer references. ────
function mediaRefsOf(a) { // mirror of server.mjs mediaRefsOf, exactly
  const out = [];
  if (!a) return out;
  if (Array.isArray(a.media)) for (const m of a.media) if (m && m.h) out.push(m);
  if (a.t === 'profile' && typeof a.pic === 'string' && a.pic) out.push({ h: a.pic, m: 'image/jpeg' });
  return out;
}
const referenced = new Map(); // hash -> mime hint from the act
for (const a of acts) for (const m of mediaRefsOf(a)) {
  if (/^[a-f0-9]{64}$/.test(m.h) && !referenced.has(m.h)) referenced.set(m.h, typeof m.m === 'string' ? m.m : 'application/octet-stream');
}
const mediaDir = join(archDir, 'media');
const have = new Set(existsSync(mediaDir) ? readdirSync(mediaDir).filter((f) => /^[a-f0-9]{64}$/.test(f)) : []);
let fetched = 0, deleted = 0, failed = 0;
if (!DRY) mkdirSync(mediaDir, { recursive: true });
for (const [h, hint] of referenced) {
  if (have.has(h)) continue;
  try {
    const { buf, type } = await fetchRaw(source + '/api/media/' + h);
    if (buf.length > MAX_BLOB) throw new Error('blob exceeds ' + MAX_BLOB + ' bytes');
    if (sha256(buf) !== h) throw new Error('does not hash to its own name — refused');
    // The served content-type is what the host's own meta recorded at
    // upload; the act's hint is the fallback (notably profile pics, where
    // the act does not carry a mime at all).
    const mime = (type && !/^text\/html/i.test(type)) ? type.split(';')[0].trim() : hint;
    if (!DRY) {
      writeFileSync(join(mediaDir, h), buf);
      writeFileSync(join(mediaDir, h + '.meta'), JSON.stringify({ mime, size: buf.length }));
    }
    fetched++;
  } catch (e) {
    failed++;
    console.log('media ' + h.slice(0, 12) + '… not fetched: ' + String(e.message || e).slice(0, 120));
  }
}
for (const h of have) {
  if (referenced.has(h)) continue;
  if (!DRY) {
    try { unlinkSync(join(mediaDir, h)); } catch { /* best effort */ }
    try { unlinkSync(join(mediaDir, h + '.meta')); } catch { /* absent is fine */ }
  }
  deleted++;
}
const mediaCount = referenced.size - failed;

// ── 6. Write the archive: log, chain, manifest — same shape publish-site.ps1
// produces, so the app cannot tell who published last. The chain files are
// the exact bytes verified in step 4; nothing is re-fetched after the
// verdict. ─────────────────────────────────────────────────────────────────
const changed = !oldManifest || oldManifest.sha256 !== logSha
  || (headInfo && (!oldManifest.chain || oldManifest.chain.hash !== headInfo.hash))
  || fetched > 0 || deleted > 0;
if (!changed) {
  console.log('archive already matches the live record (' + acts.length + ' acts, chain ' + (headInfo ? headInfo.height : 'none') + ') — nothing to write');
  process.exit(0);
}
if (DRY) {
  console.log('[dry-run] would publish: ' + acts.length + ' acts, sha ' + logSha.slice(0, 16) + '…, chain '
    + (headInfo ? headInfo.height : 'none') + ', media +' + fetched + ' −' + deleted + (failed ? ' (' + failed + ' failed)' : ''));
  process.exit(0);
}
mkdirSync(join(archDir, 'chain'), { recursive: true });
writeFileSync(join(archDir, 'acts.jsonl'), logBuf);
if (blocksBuf) {
  writeFileSync(join(archDir, 'chain', 'blocks.jsonl'), blocksBuf);
  writeFileSync(join(archDir, 'chain', 'HEAD.json'), headBuf);
}
const manifest = {
  acts: acts.length,
  sha256: logSha,
  at: Date.now(),
  host: source,
  media: mediaCount > 0,
  note: 'A snapshot of the act log. Replay it with webapp/social/replay.cjs and you get the same standings, feeds and balances the live host computes - that is what makes this a verifiable copy rather than a backup you have to trust.',
  chain: headInfo ? { height: headInfo.height, hash: headInfo.hash, producer: headInfo.producer } : null,
};
writeFileSync(join(archDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');

// A one-line summary for the committing workflow to reuse verbatim.
const summary = 'Archive: ' + acts.length + ' acts, sha256 ' + logSha.slice(0, 8)
  + (headInfo ? ', chain ' + headInfo.height : ', no chain')
  + (fetched || deleted ? ', media +' + fetched + ' -' + deleted : '')
  + ' - verified against ' + source;
writeFileSync(join(SITE, '.archive-summary'), summary + '\n');
console.log(summary);

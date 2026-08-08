#!/usr/bin/env node
// A writing instance for a machine that is nobody's.
//
// The desktop writer dies with the desktop. This boots the same server on an
// EPHEMERAL box — a free-tier container that forgets its disk, a VM, anything
// with node and git — and closes the two gaps such a box has:
//
//   arriving empty   → adopt the last verified record: first from the journal
//                      branch (seconds old), else from the published archive
//                      (verified against its manifest and chain before a
//                      single byte is served — a snapshot that fails
//                      verification is refused, not repaired).
//   forgetting       → journal every accepted act to a git branch within
//                      seconds of it landing, so the instance can die at any
//                      moment and its successor picks up where it stopped.
//
// The chain: the producer key STAYS HOME by default. Without it this writer
// runs PEER_SEAL=off — acts append, the chain pauses at its last sealed
// height, and the desktop seals the backlog when it returns. Providing
// PEER_PRODUCER_PEM (the platform's secret store) keeps sealing continuous
// instead; that is the operator's custody call, not this script's.
//
// One writer at a time still holds: the server is started with PEER_SITE_URL,
// so the election sees the published roster, and a returning desktop and this
// instance rank each other instead of splitting the log (chain/reconcile.mjs
// heals the overlap window deterministically).
//
//   node tools/cloud-writer-boot.mjs
//
// env: PORT                  (default 5210 — platforms inject their own)
//      PEER_DATA_DIR         (default ../server-data; a container should
//                             point this at its writable dir, e.g. /data)
//      PEER_PERSIST_REPO     e.g. github.com/enderPeer/peer-network-lab
//                            (empty = no journal: fine on a VM with a real
//                             disk, reckless on an ephemeral box)
//      PEER_PERSIST_BRANCH   (default writer-log)
//      GIT_TOKEN             fine-grained PAT, contents:write on that repo
//      PEER_ARCHIVE_URL      (default the published GitHub Pages archive)
//      PEER_SITE_URL         (default the published site — feeds the election)
//      PEER_PRODUCER_PEM     optional PEM; presence turns sealing back on
//      PEER_PERSIST_INTERVAL journal cadence ms (default 10000, floor 3000)
//
// Zero dependencies, node stdlib + the git CLI, like everything else here.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');
const env = process.env;

const PORT = Number(env.PORT || 5210);
const DATA = resolve(env.PEER_DATA_DIR || join(webappDir, 'server-data'));
const ARCHIVE = (env.PEER_ARCHIVE_URL || 'https://enderpeer.github.io/peer-network-lab/archive').replace(/\/+$/, '');
const SITE = (env.PEER_SITE_URL || 'https://enderpeer.github.io/peer-network-lab').replace(/\/+$/, '');
const REPO = (env.PEER_PERSIST_REPO || '').trim();
const BRANCH = (env.PEER_PERSIST_BRANCH || 'writer-log').trim();
const TOKEN = (env.GIT_TOKEN || '').trim();
const INTERVAL = Math.max(3000, Number(env.PEER_PERSIST_INTERVAL) || 10_000);

const log = (m) => console.log('[cloud-writer] ' + m);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// The token must never reach a log line — git bakes the remote URL into its
// error messages, so every error we surface goes through this first.
const scrub = (s) => String(s || '').replace(/x-access-token:[^@\s]+@/g, '…@');

function remoteUrl() {
  if (!REPO) return null;
  if (/^file:/i.test(REPO) || /^\/|^[A-Za-z]:[\\/]/.test(REPO)) return REPO; // a local path: the test rig
  const bare = REPO.replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
  return 'https://' + (TOKEN ? 'x-access-token:' + TOKEN + '@' : '') + bare + '.git';
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error('git ' + args[0] + ': ' + scrub((e.stderr || e.message || '').toString()).trim().split('\n').slice(-2).join(' '));
  }
}

// ── The journal branch: clone it if it exists, create it if not ────────────
function setupPersistence() {
  const url = remoteUrl();
  if (!url) { log('no PEER_PERSIST_REPO — the log lives only on this disk'); return false; }
  if (!existsSync(join(DATA, '.git'))) {
    const probe = spawnSync('git', ['ls-remote', '--heads', url, BRANCH], { encoding: 'utf8' });
    if (probe.status !== 0) throw new Error('cannot reach the journal repo: ' + scrub(probe.stderr).trim().split('\n')[0]);
    if (probe.stdout.trim()) {
      log('adopting journal branch ' + BRANCH + ' (seconds-fresh beats the archive)');
      git(['clone', '--depth', '1', '-b', BRANCH, url, DATA]);
    } else {
      log('journal branch ' + BRANCH + ' does not exist yet — starting it');
      mkdirSync(DATA, { recursive: true });
      git(['init', '-b', BRANCH], DATA);
      git(['remote', 'add', 'origin', url], DATA);
    }
  }
  git(['config', 'user.name', 'peer-cloud-writer'], DATA);
  git(['config', 'user.email', 'writer@peer-network.invalid'], DATA);
  // An ALLOWLIST, because the denylist version of this was a credential leak.
  //
  // It used to name the things not to publish — logs, backups, the producer
  // key, the key bag — and that is exactly backwards for a directory the
  // operator keeps adding files to. server-data/ had since gained
  // operator-token.txt and rotated-pins.json (the fresh PINs for 34 accounts),
  // and both sat outside the denylist, so the first journal push would have
  // put the admin credential and thirty-four people's PINs on a public branch.
  //
  // So: ignore everything, then name the four things a successor actually
  // needs to resume — the log, the media it references, and the sealed chain.
  // Anything added to this directory in future is excluded until somebody
  // deliberately adds it here, which is the only safe default for a folder
  // whose whole purpose is holding secrets next to data.
  writeFileSync(join(DATA, '.gitignore'), [
    '# Allowlist. Everything is secret until named here — see cloud-writer-boot.mjs.',
    '*',
    '!acts.jsonl',
    '!media/',
    '!media/**',
    '!chain/',
    '!chain/blocks.jsonl',
    '!chain/HEAD.json',
    '',
  ].join('\n'));
  return true;
}

// ── Arriving empty: adopt the published archive, verified or not at all ────
async function fetchBuf(u) {
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok) { const e = new Error(u + ' -> ' + r.status); e.status = r.status; throw e; }
  return Buffer.from(await r.arrayBuffer());
}

async function bootstrapFromArchive() {
  log('no local log — adopting the published archive at ' + ARCHIVE);
  const man = JSON.parse((await fetchBuf(ARCHIVE + '/manifest.json')).toString('utf8'));
  if (!man || typeof man.acts !== 'number' || man.acts < 1) throw new Error('archive manifest unusable');
  const logBuf = await fetchBuf(ARCHIVE + '/acts.jsonl');
  if (sha256(logBuf) !== man.sha256) throw new Error('acts.jsonl does not hash to the manifest sha256 — refusing');
  const lines = logBuf.toString('utf8').split('\n').filter((l) => l.trim());
  if (lines.length !== man.acts) throw new Error('act count ' + lines.length + ' does not match manifest ' + man.acts);

  let blocksBuf = null, headBuf = null;
  if (man.chain && Number(man.chain.height) > 0) {
    blocksBuf = await fetchBuf(ARCHIVE + '/chain/blocks.jsonl');
    headBuf = await fetchBuf(ARCHIVE + '/chain/HEAD.json');
    const tmp = join(tmpdir(), 'peer-boot-' + process.pid);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'acts.jsonl'), logBuf);
    writeFileSync(join(tmp, 'blocks.jsonl'), blocksBuf);
    const vArgs = [join(webappDir, 'chain', 'verify.mjs'), '--acts', join(tmp, 'acts.jsonl'), '--chain', join(tmp, 'blocks.jsonl')];
    if (man.chain.producer) vArgs.push('--producer', man.chain.producer);
    const v = spawnSync(process.execPath, vArgs, { encoding: 'utf8', timeout: 300_000 });
    if (v.status !== 0) throw new Error('archive FAILED verification — refusing to serve it:\n' + (v.stdout + v.stderr).slice(-600));
    log('archive verified: ' + man.chain.height + ' block(s), producer ' + String(man.chain.producer || '').slice(0, 16) + '…');
  } else {
    log('archive carries no chain — adopting the log as-is');
  }

  // Media: every blob the log references, each checked against its own name.
  const hashes = new Set();
  for (const l of lines) {
    try { for (const m of (JSON.parse(l).media || [])) if (/^[a-f0-9]{64}$/.test(m.h || '')) hashes.add(m.h); } catch { /* a redacted line */ }
  }
  const mediaDir = join(DATA, 'media');
  mkdirSync(mediaDir, { recursive: true });
  let got = 0, missing = 0;
  for (const h of hashes) {
    if (existsSync(join(mediaDir, h))) { got++; continue; }
    try {
      const b = await fetchBuf(ARCHIVE + '/media/' + h);
      if (sha256(b) !== h) throw new Error('bytes do not hash to their name');
      writeFileSync(join(mediaDir, h), b);
      try { writeFileSync(join(mediaDir, h + '.meta'), await fetchBuf(ARCHIVE + '/media/' + h + '.meta')); }
      catch { writeFileSync(join(mediaDir, h + '.meta'), JSON.stringify({ mime: 'application/octet-stream', size: b.length })); }
      got++;
    } catch (e) { missing++; log('media ' + h.slice(0, 12) + '… not adopted: ' + e.message); }
  }
  if (hashes.size) log('media: ' + got + ' blob(s) adopted, ' + missing + ' missing (a missing blob fails visibly, never silently)');

  mkdirSync(join(DATA, 'chain'), { recursive: true });
  writeFileSync(join(DATA, 'acts.jsonl'), logBuf);
  if (blocksBuf) {
    writeFileSync(join(DATA, 'chain', 'blocks.jsonl'), blocksBuf);
    writeFileSync(join(DATA, 'chain', 'HEAD.json'), headBuf);
  }
  log('adopted ' + man.acts + ' act(s) from the published archive');
}

// ── The server itself, restarted forever: this file is also the watchdog ───
let child = null;
function startServer() {
  const senv = { ...env, PEER_DATA_DIR: DATA, PEER_SITE_URL: SITE };
  if (env.PEER_PRODUCER_PEM) {
    mkdirSync(join(DATA, 'chain'), { recursive: true });
    writeFileSync(join(DATA, 'chain', 'producer.pem'), env.PEER_PRODUCER_PEM, { mode: 0o600 });
    log('producer key provided — chain sealing stays continuous');
  } else {
    senv.PEER_SEAL = 'off';
    log('keyless writer — the chain pauses at its last sealed height until the key-holder returns');
  }
  // The server has no business holding these.
  delete senv.GIT_TOKEN;
  delete senv.PEER_PRODUCER_PEM;
  child = spawn(process.execPath, [join(webappDir, 'server.mjs'), String(PORT)], { env: senv, stdio: 'inherit' });
  child.on('exit', (code) => {
    log('server exited (' + code + ') — restarting in 5s');
    setTimeout(startServer, 5000);
  });
}

// ── Forgetting, prevented: the journal tick ────────────────────────────────
// A cheap change mark, then real git work only when something moved. A push
// rejection is NOT healed automatically: a non-fast-forward means ANOTHER
// writer instance pushed to this branch, which is the two-writer alarm — it
// stays loud in the logs until a human looks, and the local file stays whole.
let lastMark = '', persisting = false;
function snapshotMark() {
  let m = '';
  try { const s = statSync(join(DATA, 'acts.jsonl')); m += s.size + ':' + s.mtimeMs; } catch { /* not born yet */ }
  try { m += '|' + readdirSync(join(DATA, 'media')).length; } catch { /* no media yet */ }
  try { const s = statSync(join(DATA, 'chain', 'blocks.jsonl')); m += '|' + s.size; } catch { /* no chain yet */ }
  return m;
}
function persistTick() {
  if (!persisting) return;
  const mark = snapshotMark();
  if (mark === lastMark) return;
  try {
    git(['add', '-A'], DATA);
    if (!git(['status', '--porcelain'], DATA).trim()) { lastMark = mark; return; }
    let n = 0;
    try { n = readFileSync(join(DATA, 'acts.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* counted as 0 */ }
    git(['commit', '-m', 'journal: ' + n + ' act(s)'], DATA);
    git(['push', 'origin', 'HEAD:' + BRANCH], DATA);
    lastMark = mark;
  } catch (e) {
    log('journal push failed (log kept locally, retrying): ' + scrub(e.message));
  }
}

// ── Boot order: journal first (it may hold a fresher log than the archive),
// archive second, server third, journal tick last. ─────────────────────────
(async () => {
  try {
    persisting = setupPersistence();
  } catch (e) {
    // A broken journal is not a reason to stay dark — serve, complain loudly.
    log('PERSISTENCE DISABLED — ' + scrub(e.message));
    persisting = false;
  }
  mkdirSync(DATA, { recursive: true });
  if (!existsSync(join(DATA, 'acts.jsonl'))) {
    try {
      await bootstrapFromArchive();
    } catch (e) {
      // Refusing to serve an unverifiable record is the point; an EMPTY world
      // is at least honestly empty. Say exactly which it is.
      log('BOOTSTRAP FAILED — starting with an empty log: ' + scrub(e.message));
    }
  } else {
    let n = 0;
    try { n = readFileSync(join(DATA, 'acts.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* unreadable counts as 0 */ }
    log('local log present (' + n + ' act(s)) — no bootstrap needed');
  }
  startServer();
  if (persisting) { setInterval(persistTick, INTERVAL); log('journalling to ' + REPO + ' (' + BRANCH + ') every ' + Math.round(INTERVAL / 1000) + 's'); }
})();

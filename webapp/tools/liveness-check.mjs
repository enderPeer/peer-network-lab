#!/usr/bin/env node
// The address book keeper: probe every host the site knows about, and point
// the published host.json at one that is actually answering.
//
// Why this exists. The app reads host.json from a permanent address and
// probes the hosts named there. That file is written by whichever machine
// published last — so when that machine goes away, the file keeps naming a
// corpse, and every visitor waits out a timeout before falling back to the
// archive. The watchdog on the host cannot fix this: it dies with the host.
// So this runs somewhere else entirely (GitHub Actions, on a schedule), and
// it is the one piece of infrastructure that assumes NOTHING about the
// author's machines being on.
//
// What it will not do: it never invents a host, never changes the record,
// and never picks a WRITER. Which host may accept acts is decided by the
// hosts themselves (chain/election.mjs) from evidence they can produce;
// this only reports where to knock. When nothing answers it writes an empty
// url on purpose — an honest "no host" sends the app straight to the
// published archive, which is a working read-only network, while a stale
// address sends it to a spinner.
//
// Zero dependencies, like everything else here: node stdlib only.
//
//   node tools/liveness-check.mjs --dir <gh-pages checkout> [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const DIR = resolve(arg('--dir', '.'));
const TIMEOUT = Math.max(2000, Number(arg('--timeout', '8000')));

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const isHttp = (u) => /^https?:\/\/[^\s]+$/i.test(u);

async function get(url, path) {
  const r = await fetch(url + path, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'peer-liveness/1' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.length > 4_000_000) throw new Error('response too large');
  return JSON.parse(text);
}

/** Is this host answering, and what does it say it is? */
async function probe(url) {
  const out = { url, live: false, acts: null, role: null, writer: false, chainHeight: null, error: null };
  try {
    const acts = await get(url, '/api/acts?since=999999');
    if (typeof acts.total !== 'number') throw new Error('no act count in reply');
    out.live = true;
    out.acts = acts.total;
    out.role = acts.mirror ? 'mirror' : 'primary';
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
    return out;
  }
  // The election door is optional: hosts older than the election feature
  // answer 404 here and are still perfectly good read hosts.
  try {
    const e = await get(url, '/api/election');
    out.chainHeight = Number(e.chainHeight) || 0;
    out.writer = !e.primary && !e.quarantine;
    out.role = e.primary ? 'mirror' : (e.quarantine ? 'checking' : 'primary');
  } catch { out.writer = out.role === 'primary'; }
  return out;
}

const hostPath = join(DIR, 'host.json');
if (!existsSync(hostPath)) { console.error('no host.json at ' + hostPath); process.exit(1); }
const cfg = JSON.parse(readFileSync(hostPath, 'utf8'));

// Everything this file has ever named, so an all-down day cannot erase the
// addresses that would let the network be found again when a host returns.
const candidates = [...new Set([
  ...(Array.isArray(cfg.candidates) ? cfg.candidates : []),
  ...(Array.isArray(cfg.urls) ? cfg.urls : []),
  cfg.url,
].map(clean).filter(isHttp))];

if (!candidates.length) {
  console.log('host.json names no hosts — nothing to probe, nothing to change.');
  process.exit(0);
}

const results = await Promise.all(candidates.map(probe));
for (const r of results) {
  console.log((r.live ? 'LIVE ' : 'down ') + r.url
    + (r.live ? '  ' + r.acts + ' acts, ' + r.role + (r.chainHeight !== null ? ', chain ' + r.chainHeight : '') : '  ' + r.error));
}

// Order the probe list the way the app should walk it: a host that accepts
// acts first (writes work there), then live read-only mirrors, then the
// rest. Among writers, the longest record — the same ordering the hosts use
// among themselves, so the address book and the election cannot disagree
// about who is worth trying first.
const live = results.filter((r) => r.live);
const rank = (a, b) => (b.writer - a.writer) || ((b.chainHeight || 0) - (a.chainHeight || 0)) || ((b.acts || 0) - (a.acts || 0));
const ordered = live.slice().sort(rank).map((r) => r.url);

const before = JSON.stringify({ url: cfg.url, urls: cfg.urls });
const next = { ...cfg };
next.url = ordered[0] || '';
if (ordered.length > 1) next.urls = ordered; else delete next.urls;
next.candidates = candidates;
next.checked = new Date().toISOString();
next.checkedBy = 'liveness workflow (.github/workflows/liveness.yml)';
if (!ordered.length) {
  next.note = 'No published host answered at the last check, so this file names none: the app loads the archive published beside it and runs the network read-only, rather than waiting on a dead address. The addresses are kept in `candidates` and restored automatically when one answers again.';
}

const status = {
  checked: next.checked,
  anyLive: ordered.length > 0,
  writer: live.find((r) => r.writer)?.url || null,
  hosts: results,
  note: 'Written every 15 minutes by a scheduled GitHub Action. It probes the hosts named in host.json and repoints that file; it never touches the act log.',
};

if (flag('--dry-run')) {
  console.log(JSON.stringify({ host: next, status }, null, 2));
  process.exit(0);
}

writeFileSync(join(DIR, 'status.json'), JSON.stringify(status, null, 2) + '\n');
const changed = before !== JSON.stringify({ url: next.url, urls: next.urls });
if (changed) {
  writeFileSync(hostPath, JSON.stringify(next, null, 4) + '\n');
  console.log('host.json repointed -> ' + (next.url || '(none: the app reads the published archive)'));
} else {
  // Still refresh the timestamp fields so "when was this last checked" is
  // answerable from the file itself, but say plainly that nothing moved.
  writeFileSync(hostPath, JSON.stringify(next, null, 4) + '\n');
  console.log('host.json unchanged (' + (next.url || 'still no host answering') + ')');
}

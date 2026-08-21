/**
 * A mirror is a witness, not a backup — G6.
 *
 * mirrorAdoptSafely protects only what a mirror itself saw: a mirror booted
 * from an empty data dir holds nothing, checks nothing, and (before this fix)
 * adopted whatever pre-history its primary served. This became a public
 * commitment on the network (acts 232-233: "fetch the chain head, run
 * forkChainMergeable before adopt, refuse on mismatch"), so the tests here
 * hold exactly that:
 *
 * 1. A fresh mirror adopts an honest record AND keeps the sealed chain it
 *    verified, serving it at /api/chain.
 * 2. A primary that rewrites sealed history (a different chain) is refused:
 *    the mirror keeps serving its last verified record and says why at
 *    /api/election.
 * 3. A primary that serves the RIGHT chain over a TAMPERED log (payload
 *    changed with no redaction stamp) is refused the same way.
 * 4. When the honest record comes back, the mirror adopts again and the
 *    refusal clears — a refusal is a held breath, not an outage.
 *
 * The primary here is a stub HTTP server, because the case under test is
 * precisely "the primary lies", and a real server.mjs cannot be made to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, newKey, blockMod, canonicalMod, type Block } from './helpers/chain';
import { seed } from './helpers/world';

const SPORT = 5361; // stub "primary"
const MPORT = 5362; // the mirror under test (a real server.mjs)
const SBASE = `http://127.0.0.1:${SPORT}`;
const MBASE = `http://127.0.0.1:${MPORT}`;
const ROOT = resolve(__dirname, '..');

type Act = Record<string, unknown>;

/** File acts (no seedWorld): registered actors with proven burns. */
function actors(...names: string[]): Act[] {
  const acts = seed(...names).slice(1) as Act[];
  for (const n of names) {
    const txid = (n + ':mirror').split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('').slice(0, 64).padEnd(64, 'd');
    acts.push({ t: 'btcBurn', id: 'u_' + n, txid, sats: 1000, addr: 'bc1qdead' });
  }
  return acts;
}
const post = (who: string, text: string) => ({ t: 'post', author: 'u_' + who, text, a: 0.8, rmen: [] });
const close = (epoch: number) => ({ t: 'closeEpoch', epoch, ts: 1700000000000 + epoch });

// ── the histories ────────────────────────────────────────────────────────────
// A: the honest record — one sealed epoch plus an unsealed tail act, so a
//    tampered variant can be made SHORTER (dropping the tail) to force the
//    mirror down the full-sync path without touching sealed structure.
const keyA = newKey();
const fileA: Act[] = [...actors('al', 'bo'), post('al', 'the sealed original'), close(1), post('bo', 'unsealed tail')];
const chainA: Block[] = build(fileA, keyA).blocks;

// B: a rewritten pre-history — different acts, different producer, own chain.
//    Shorter than A so the mirror's `total < acts.length` rewrite detector fires.
const keyB = newKey();
const fileB: Act[] = [...actors('cx', 'dy'), post('cx', 'a rewritten past'), close(1)];
const chainB: Block[] = build(fileB, keyB).blocks;

// A': the right chain over a tampered log — sealed payload changed, no
//     redaction stamp, tail dropped (shorter → full sync).
const fileTampered: Act[] = fileA.slice(0, -1).map((a) =>
  a.t === 'post' && a.text === 'the sealed original' ? { ...a, text: 'the sealed forgery' } : a);

// A'': the redaction-stamp substitution — the right chain, but the sealed post
//      carries NEW text under redacted:true (not the blanked residue). Structure
//      is untouched; only the tightened payload check stands in the way.
const fileRedactionForged: Act[] = fileA.slice(0, -1).map((a) =>
  a.t === 'post' && a.text === 'the sealed original'
    ? { ...a, text: 'substituted under the tombstone', redacted: true } : a);

/** What server.mjs serves at /api/acts: in-memory log with a seedWorld line. */
const mem = (fileActs: Act[]) => [{ t: 'seedWorld' }, ...fileActs];

// ── the stub primary ─────────────────────────────────────────────────────────
let served = { acts: mem(fileA), blocks: chainA };
let stub: Server;
let mirror: ChildProcess;
let mdir: string;

const mget = async (p: string) => (await fetch(MBASE + p)).json() as Promise<Record<string, any>>;

async function until(desc: string, cond: () => Promise<boolean>, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if (await cond()) return; } catch { /* mirror still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('gave up waiting for: ' + desc);
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', SBASE);
    if (url.pathname === '/api/acts') {
      const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acts: served.acts.slice(since), total: served.acts.length, mirror: null }));
      return;
    }
    if (url.pathname === '/api/chain') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(served.blocks.map((b) => canonicalMod.canonical(b)).join('\n') + '\n');
      return;
    }
    if (url.pathname === '/api/election') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodeId: 'stub-primary', chainHeight: served.blocks.length, acts: served.acts.length, active: 0, primary: null, quarantine: false }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not here' }));
  });
  await new Promise<void>((r) => stub.listen(SPORT, '127.0.0.1', r));

  mdir = mkdtempSync(join(tmpdir(), 'peer-mirror-verify-'));
  mkdirSync(join(mdir, 'server-data'), { recursive: true });
  writeFileSync(join(mdir, 'server-data', 'acts.jsonl'), '');
  mirror = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(MPORT)], {
    cwd: ROOT,
    env: {
      ...process.env, PEER_DATA_DIR: join(mdir, 'server-data'),
      PEER_MIRROR_OF: SBASE, PEER_MIRROR_INTERVAL: '300',
    },
    stdio: 'ignore',
  });
  await until('mirror comes up', async () => { await fetch(MBASE + '/api/election'); return true; });
}, 30000);

afterAll(async () => {
  mirror?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
  try { rmSync(mdir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a mirror verifies what it adopts against the sealed chain', () => {
  it('adopts an honest record from an empty disk and KEEPS the chain it verified', async () => {
    await until('honest adopt', async () => (await mget('/api/acts')).total === served.acts.length);
    const list = JSON.stringify((await mget('/api/acts')).acts);
    expect(list).toContain('the sealed original');
    expect(list).toContain('unsealed tail');
    // The verified chain is now this host's own, served at /api/chain.
    await until('chain kept', async () => (await fetch(MBASE + '/api/chain')).status === 200);
    const nd = await (await fetch(MBASE + '/api/chain')).text();
    const kept = nd.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) as Block[];
    expect(kept.length).toBe(1);
    expect(blockMod.blockHash(kept[0])).toBe(blockMod.blockHash(chainA[0]));
    expect((await mget('/api/election')).refusing).toBeNull();
  }, 30000);

  it('refuses a rewritten pre-history: serves the last verified record and says why', async () => {
    served = { acts: mem(fileB), blocks: chainB };
    await until('refusal reported', async () => !!(await mget('/api/election')).refusing);
    const e = await mget('/api/election');
    expect(String(e.refusing)).toMatch(/sealed history|does not extend/i);
    // The record served is still A — nothing of B leaked in.
    const list = JSON.stringify((await mget('/api/acts')).acts);
    expect(list).toContain('the sealed original');
    expect(list).not.toContain('a rewritten past');
  }, 30000);

  it('recovers when the honest record returns: adopts, refusal clears', async () => {
    served = { acts: mem(fileA), blocks: chainA };
    await until('refusal cleared', async () => (await mget('/api/election')).refusing === null);
    expect(JSON.stringify((await mget('/api/acts')).acts)).toContain('unsealed tail');
  }, 30000);

  it('refuses the right chain over a tampered log: a sealed payload cannot change quietly', async () => {
    served = { acts: mem(fileTampered), blocks: chainA };
    await until('tamper refused', async () => !!(await mget('/api/election')).refusing);
    expect(String((await mget('/api/election')).refusing)).toMatch(/not the log its own chain sealed/i);
    const list = JSON.stringify((await mget('/api/acts')).acts);
    expect(list).toContain('the sealed original');
    expect(list).not.toContain('the sealed forgery');

    // And back to honest once more — the refusal is a held breath, not a latch.
    served = { acts: mem(fileA), blocks: chainA };
    await until('refusal cleared again', async () => (await mget('/api/election')).refusing === null);
  }, 30000);

  it('refuses a redaction-stamp SUBSTITUTION: the stamp cannot license new content', async () => {
    served = { acts: mem(fileRedactionForged), blocks: chainA };
    await until('redaction forge refused', async () => !!(await mget('/api/election')).refusing);
    expect(String((await mget('/api/election')).refusing)).toMatch(/not the log its own chain sealed/i);
    expect(JSON.stringify((await mget('/api/acts')).acts)).not.toContain('substituted under the tombstone');
    served = { acts: mem(fileA), blocks: chainA };
    await until('cleared after redaction forge', async () => (await mget('/api/election')).refusing === null);
  }, 30000);
});

// A separate mirror, pinned to the producer via PEER_PRODUCER, against a
// primary that serves NO sealed chain — the downgrade attack. It must refuse,
// where an unpinned mirror would adopt-unverified.
describe('PEER_PRODUCER makes a chainless record a refusal, not a blind adopt', () => {
  const SPORT2 = 5363;
  const MPORT2 = 5364;
  const SBASE2 = `http://127.0.0.1:${SPORT2}`;
  const MBASE2 = `http://127.0.0.1:${MPORT2}`;
  let stub2: Server;
  let mirror2: ChildProcess;
  let mdir2: string;
  const producerKey = chainA[0].producer as string;

  beforeAll(async () => {
    stub2 = createServer((req, res) => {
      const url = new URL(req.url ?? '/', SBASE2);
      if (url.pathname === '/api/acts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acts: mem(fileA), total: mem(fileA).length, mirror: null }));
        return;
      }
      if (url.pathname === '/api/chain' || url.pathname === '/api/chain/head') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NO_CHAIN', error: 'nothing sealed here' }));
        return;
      }
      if (url.pathname === '/api/election') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodeId: 'stub2', chainHeight: 0, acts: mem(fileA).length, active: 0, primary: null, quarantine: false }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>((r) => stub2.listen(SPORT2, '127.0.0.1', r));
    mdir2 = mkdtempSync(join(tmpdir(), 'peer-mirror-pin-'));
    mkdirSync(join(mdir2, 'server-data'), { recursive: true });
    writeFileSync(join(mdir2, 'server-data', 'acts.jsonl'), '');
    mirror2 = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(MPORT2)], {
      cwd: ROOT,
      env: {
        ...process.env, PEER_DATA_DIR: join(mdir2, 'server-data'),
        PEER_MIRROR_OF: SBASE2, PEER_MIRROR_INTERVAL: '300', PEER_PRODUCER: producerKey,
      },
      stdio: 'ignore',
    });
    await until2('pinned mirror up', async () => { await fetch(MBASE2 + '/api/election'); return true; });
  }, 30000);

  afterAll(async () => {
    mirror2?.kill();
    await new Promise<void>((r) => stub2.close(() => r()));
    try { rmSync(mdir2, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const mget2 = async (p: string) => (await fetch(MBASE2 + p)).json() as Promise<Record<string, any>>;
  async function until2(desc: string, cond: () => Promise<boolean>, tries = 80) {
    for (let i = 0; i < tries; i++) {
      try { if (await cond()) return; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('gave up waiting for: ' + desc);
  }

  it('refuses to adopt a pinned record the primary serves no chain for, and adopts none of it', async () => {
    await until2('pinned refusal', async () => !!(await mget2('/api/election')).refusing);
    expect(String((await mget2('/api/election')).refusing)).toMatch(/PEER_PRODUCER is set/i);
    // It adopted nothing of the served record: the fresh mirror still holds only
    // its own in-memory seed, and none of fileA's content leaked in.
    const r = await mget2('/api/acts');
    expect((r.total as number)).toBeLessThan(mem(fileA).length);
    expect(JSON.stringify(r.acts)).not.toContain('the sealed original');
  }, 30000);
});

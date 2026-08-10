/**
 * The burn watcher.
 *
 * Burning used to be two steps where only the first one was real: the coins
 * left the wallet when the wallet signed, and the reserve appeared only if a
 * browser tab survived long enough to poll for confirmations and file the
 * claim. Two real burns sat on the dead address unclaimed for four days
 * because a tab was closed. That is what these tests are about.
 *
 * The block explorers are fakes here, on two separate base paths, because the
 * host requires two independent sources to agree — and because a test that
 * needed the real chain would be a test that only passes when Bitcoin is
 * having a good day. Everything else is the real server process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

// Ports the operating system hands out, not numbers written down here. A
// fixed port made this suite flaky in two different ways: it collided with
// security.test.ts's host, and — because these tests deliberately run for
// half a minute — its own host was still holding the port when the NEXT run
// started, which the host answers by exiting, exactly as it should. The
// server's refusal to be a second writer is correct; the test asking for a
// specific port was not.
let PORT = 0;
let EXPLORER_PORT = 0;
let BASE = '';

/** A port nothing is listening on, from the only authority on that. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const ROOT = resolve(__dirname, '..');
// The real dead address: it is only configuration, but it has to pass its own
// checksum, and inventing one that does is harder than using the real one.
const DEAD = 'bc1qrz05qq6tu7senu06nzgkdrhr4dsyn7pd8rrghec0t9h2ktsc27msqvznj2';
const WATCH_MS = 15_000;   // the floor the host clamps to

let child: ChildProcess;
let explorer: Server;
let dir: string;

const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');

/** The chain, as the fake explorers see it. Tests mutate this directly. */
type FakeTx = { txid: string; sats: number; from: string[]; confirmed: boolean; height: number; time: number };
const chain: {
  tip: number;
  txs: FakeTx[];
  /** txid -> the height explorer B reports instead, so the two can disagree. */
  disagreeHeight: Record<string, number | null>;
} = { tip: 900_100, txs: [], disagreeHeight: {} };

const txJson = (t: FakeTx, source: string) => {
  const h = source === 'b' && t.txid in chain.disagreeHeight ? chain.disagreeHeight[t.txid] : t.height;
  return {
    txid: t.txid,
    vin: t.from.map((a) => ({ prevout: { scriptpubkey_address: a } })),
    vout: [{ scriptpubkey_address: DEAD, value: t.sats },
      { scriptpubkey_address: 'bc1qk59gmep45z73wq6uzru6eg5fxg0v0rq5f5vfmw', value: 500 }],
    status: t.confirmed
      // block_height omitted entirely when the override is null: an explorer
      // that calls a transaction confirmed without saying where.
      ? (h == null
        ? { confirmed: true, block_time: Math.floor(t.time / 1000) }
        : { confirmed: true, block_height: h, block_time: Math.floor(t.time / 1000) })
      : { confirmed: false },
  };
};

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, never> };
}
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<Record<string, never>>;
const burnsOf = async (id: string) => {
  const { acts } = await get('/api/acts') as unknown as { acts: Record<string, string>[] };
  return acts.filter((a) => a.t === 'btcBurn' && a.id === id);
};

beforeAll(async () => {
  PORT = await freePort();
  EXPLORER_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // Two "independent" explorers: /a and /b on one process. Independence is
  // not what is under test here — the matching is.
  explorer = createServer((req, res) => {
    const source = (req.url || '')[1] || 'a';
    const path = (req.url || '').replace(/^\/[ab]/, '');
    res.setHeader('Content-Type', 'application/json');
    if (path === '/blocks/tip/height') { res.end(String(chain.tip)); return; }
    const tx = path.match(/^\/tx\/([a-f0-9]{64})$/);
    if (tx) {
      const hit = chain.txs.find((t) => t.txid === tx[1]);
      if (!hit) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify(txJson(hit, source)));
      return;
    }
    if (path === `/address/${DEAD}/txs`) {
      res.end(JSON.stringify(chain.txs.map((t) => txJson(t, source))));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => explorer.listen(EXPLORER_PORT, r));

  dir = mkdtempSync(join(tmpdir(), 'peer-burn-test-'));
  mkdirSync(join(dir, 'server-data'), { recursive: true });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), [
    { t: 'register', id: 'u_ender', handle: 'ender', seed: 1, epoch: 0, pinHash: hash('u_ender', '1234') },
    { t: 'register', id: 'u_other', handle: 'Other', seed: 1, epoch: 0, pinHash: hash('u_other', '9999') },
    // No PIN, on purpose: money must not be credited into a handle whose
    // ownership nobody can prove.
    { t: 'register', id: 'u_open', handle: 'Open', seed: 1, epoch: 0 },
  ].map((a) => JSON.stringify(a)).join('\n') + '\n');

  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PEER_DATA_DIR: join(dir, 'server-data'),
      PEER_ACT_RATE: '400',
      PEER_BURN_ADDRESS: DEAD,
      PEER_BURN_EXPLORERS: `http://127.0.0.1:${EXPLORER_PORT}/a,http://127.0.0.1:${EXPLORER_PORT}/b`,
      PEER_BURN_MIN_CONF: '2',
      PEER_BURN_WATCH_INTERVAL: String(WATCH_MS),
      // The public read door memoises the explorer for 20s in production, to
      // stop an anonymous caller in a loop turning this host into a request
      // amplifier. Off here: these tests move the chain and read the result
      // in the same breath, and a cache would only be testing itself.
      PEER_BURN_TX_CACHE_MS: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // If the host refuses to start, say why here rather than leaving fifteen
  // tests to fail one by one against a port nothing is listening on.
  let died = '';
  child.stderr?.on('data', (d) => { died += String(d); });

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/acts'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up on ' + PORT + (died ? ': ' + died.trim() : ''));
}, 20000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => explorer.close(() => r()));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('filing an intent', () => {
  it('refuses one without the PIN', async () => {
    const r = await post('/api/burn/intent', { id: 'u_ender', sats: 2000 });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PIN_REQUIRED');
  });

  it('refuses one that would match anybody', async () => {
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BURN_INTENT_VAGUE');
  });

  it('refuses a sending address that fails its own checksum', async () => {
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', from: 'bc1qnotanaddressatall' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_ADDRESS');
  });

  it('refuses a handle that does not exist', async () => {
    const r = await post('/api/burn/intent', { id: 'u_nobody', auth: '1234', sats: 1000 });
    expect(r.status).toBe(404);
  });
});

describe('a burn already on the chain', () => {
  it('is credited the moment its owner claims it, with no browser involved', async () => {
    chain.txs.push({
      txid: 'a'.repeat(64), sats: 2000, from: ['bc1q42wyhyhjuhmcxhe7j5pnhcx5av5qzeqxnhz4pt'],
      confirmed: true, height: 900_090, time: Date.now() - 4 * 86_400_000,   // four days ago
    });
    const r = await post('/api/burn/intent', {
      id: 'u_ender', auth: '1234', sats: 2000, from: 'bc1q42wyhyhjuhmcxhe7j5pnhcx5av5qzeqxnhz4pt',
    });
    expect(r.status).toBe(200);
    expect(r.body.credited).toBeTruthy();
    const burns = await burnsOf('u_ender');
    expect(burns).toHaveLength(1);
    expect(burns[0].sats).toBe(2000);
    expect(burns[0].txid).toBe('a'.repeat(64));
  });

  it('gives the reserve to the account, at 100 satoshi per unit', async () => {
    const me = await get('/api/v1/whoami?as=u_ender') as unknown as { energy: number; canAct: boolean };
    expect(me.energy).toBeCloseTo(20, 6);
    expect(me.canAct).toBe(true);
  });

  it('is never credited twice', async () => {
    await post('/api/burn/intent', {
      id: 'u_ender', auth: '1234', sats: 2000, from: 'bc1q42wyhyhjuhmcxhe7j5pnhcx5av5qzeqxnhz4pt',
    });
    expect(await burnsOf('u_ender')).toHaveLength(1);
  });
});

describe('pointing at a burn by its txid', () => {
  it('takes one that is already deep enough, immediately', async () => {
    chain.txs.push({
      txid: '1'.repeat(64), sats: 5000, from: ['bc1qsomeoneelseentirelyxxxxxxxxxxxxxxxxxxxxxx'],
      confirmed: true, height: chain.tip - 5, time: Date.now() - 3600_000,
    });
    // No amount, no sending address — just "that one". This is the button in
    // the burn panel, and the sending wallet is deliberately not one of ours:
    // naming a transaction is the claim, and the log carries the txid so the
    // claim is checkable by anyone.
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', txid: '1'.repeat(64) });
    expect(r.status).toBe(200);
    expect(r.body.credited).toBeTruthy();
    const burns = await burnsOf('u_ender');
    expect(burns.some((b) => b.txid === '1'.repeat(64) && Number(b.sats) === 5000)).toBe(true);
  });

  it('does not stack a second intent for the same transaction', async () => {
    chain.txs.push({
      txid: '2'.repeat(64), sats: 6000, from: ['bc1qsomeoneelseentirelyxxxxxxxxxxxxxxxxxxxxxx'],
      confirmed: true, height: chain.tip, time: Date.now(),          // one deep: not yet
    });
    await post('/api/burn/intent', { id: 'u_ender', auth: '1234', txid: '2'.repeat(64) });
    await post('/api/burn/intent', { id: 'u_ender', auth: '1234', txid: '2'.repeat(64) });
    const p = await get('/api/burn/pending') as unknown as { open: { txid: string | null }[] };
    expect(p.open.filter((o) => o.txid === '2'.repeat(64))).toHaveLength(1);
  });
});

describe("what the watcher will not do", () => {
  it("leaves a stranger's burn alone, however long it sits there", async () => {
    chain.txs.push({
      txid: 'b'.repeat(64), sats: 550, from: ['bc1qvmk5ewqwlf8y42pevgujrnn9ntatawxhv34c8x'],
      confirmed: true, height: 900_050, time: Date.now() - 2 * 86_400_000,
    });
    // Somebody else files an intent for a different amount; the tick that runs
    // sees the 550-sat burn and must not touch it.
    await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 7777 });
    const all = (await get('/api/acts') as unknown as { acts: Record<string, string>[] }).acts;
    expect(all.some((a) => a.txid === 'b'.repeat(64))).toBe(false);
    const pending = await get('/api/burn/pending') as unknown as { unclaimed: { txid: string }[] };
    expect(pending.unclaimed.some((t) => t.txid === 'b'.repeat(64))).toBe(true);
  });

  it('will not reach further back than the lookback window for an amount', async () => {
    chain.txs.push({
      txid: 'c'.repeat(64), sats: 3333, from: ['bc1qu3e7szfdvkvr8029c5r0thv8kyaeh7eqrh86m8'],
      confirmed: true, height: 900_000, time: Date.now() - 30 * 86_400_000,   // a month ago
    });
    const r = await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 3333 });
    expect(r.status).toBe(200);
    expect(r.body.credited).toBeNull();
    expect(await burnsOf('u_other')).toHaveLength(0);
  });

  it('will not credit a burn that is only one block deep', async () => {
    chain.txs.push({
      txid: 'd'.repeat(64), sats: 4444, from: ['bc1q42wyhyhjuhmcxhe7j5pnhcx5av5qzeqxnhz4pt'],
      confirmed: true, height: chain.tip, time: Date.now(),     // mined into the tip itself
    });
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', sats: 4444 });
    expect(r.status).toBe(200);
    expect(r.body.credited).toBeNull();
    const burns = await burnsOf('u_ender');
    expect(burns.some((b) => b.txid === 'd'.repeat(64))).toBe(false);
  });
});

describe('nobody is watching', () => {
  it('credits the burn from the next tick, with every page closed', async () => {
    // The intent from the previous test is still open and its transaction is
    // now two blocks deep. Nothing else happens: no request, no page, no tab.
    chain.tip += 1;
    await new Promise((r) => setTimeout(r, WATCH_MS + 4000));
    const burns = await burnsOf('u_ender');
    const d = burns.find((b) => b.txid === 'd'.repeat(64));
    expect(d).toBeTruthy();
    expect(Number(d!.sats)).toBe(4444);
    // The one that was a single block deep a moment ago is in too, for the
    // same reason and with nobody present for either of them.
    expect(burns.some((b) => b.txid === '2'.repeat(64))).toBe(true);
  }, 40_000);

  it('reports what it is still waiting for', async () => {
    const p = await get('/api/burn/pending') as unknown as {
      address: string; watching: number; open: { id: string; sats: number }[];
    };
    expect(p.address).toBe(DEAD);
    // What is left open: u_other's 7777 and 3333, which never matched
    // anything, and u_ender's original 2000 intent, whose transaction was
    // already claimed. The 4444 intent is gone because it was satisfied —
    // and it, not the older 2000-from-the-same-wallet intent, is the one that
    // took that burn.
    expect(p.open.map((o) => o.sats).sort((a, b) => a - b)).toEqual([2000, 3333, 7777]);
    expect(p.watching).toBe(3);
  });
});

describe('an unconfirmed burn', () => {
  it('waits in the mempool and is credited once it is mined deep enough', async () => {
    chain.txs.push({
      txid: 'e'.repeat(64), sats: 7777, from: ['bc1qvmk5ewqwlf8y42pevgujrnn9ntatawxhv34c8x'],
      confirmed: false, height: 0, time: 0,
    });
    // A tick now: the intent for 7777 is open, the transaction exists, and it
    // must NOT be credited while it can still be replaced.
    await post('/api/burn/intent', { id: 'u_ender', auth: '1234', sats: 1 });
    expect(await burnsOf('u_other')).toHaveLength(0);

    const tx = chain.txs.find((t) => t.txid === 'e'.repeat(64))!;
    tx.confirmed = true; tx.height = chain.tip - 1; tx.time = Date.now();
    await new Promise((r) => setTimeout(r, WATCH_MS + 4000));
    const burns = await burnsOf('u_other');
    expect(burns).toHaveLength(1);
    expect(burns[0].sats).toBe(7777);
  }, 40_000);
});

describe('who a burn belongs to', () => {
  // Everything an intent can state is public once the burn is on the chain —
  // this host publishes the txid, the amount and the paying wallet itself at
  // /api/burn/pending. The only thing a bystander cannot copy is having said
  // it first, so that is what decides.
  const VICTIM = 'bc1qu3e7szfdvkvr8029c5r0thv8kyaeh7eqrh86m8';

  it('goes to whoever described it before it was mined, not to whoever names the txid after', async () => {
    // 1. The burner says what they are about to do.
    const mine = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', sats: 9100, from: VICTIM });
    expect(mine.status).toBe(200);
    // 2. The burn lands, after that.
    chain.txs.push({
      txid: '3'.repeat(64), sats: 9100, from: [VICTIM],
      confirmed: true, height: chain.tip - 3, time: Date.now() + 1000,
    });
    // 3. A bystander reads the txid off the public pending list and claims it
    //    exactly. Filing it also runs a tick, so this is the race, not a
    //    simulation of one.
    const theirs = await post('/api/burn/intent', { id: 'u_other', auth: '9999', txid: '3'.repeat(64) });
    expect(theirs.status).toBe(200);
    expect(theirs.body.credited).toBeNull();
    expect((await burnsOf('u_ender')).some((b) => b.txid === '3'.repeat(64))).toBe(true);
    expect((await burnsOf('u_other')).some((b) => b.txid === '3'.repeat(64))).toBe(false);
  });

  it('retires the other intents that described the same burn', async () => {
    // The app files the same burn more than once by design: the amount before
    // the send, again when the local page opens, then the txid afterwards.
    // Only one can be credited — and a survivor left open is an intent that
    // adopts the NEXT burn of that size, which is somebody else's.
    const open = (await get('/api/burn/pending') as unknown as { open: { id: string; sats: number | null }[] }).open;
    expect(open.filter((o) => o.id === 'u_ender' && o.sats === 9100)).toHaveLength(0);
  });

  it('does not let a stale intent adopt a stranger\'s burn of the same size', async () => {
    // u_ender's 9100 intent is spent. u_other now burns 9100 of their own and
    // says so; it must land on u_other.
    const theirs = await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 9100 });
    expect(theirs.status).toBe(200);
    chain.txs.push({
      txid: '4'.repeat(64), sats: 9100, from: ['bc1qstrangerstrangerstrangerstranger'],
      confirmed: true, height: chain.tip - 3, time: Date.now() + 2000,
    });
    await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 1 });   // any request runs a tick
    expect((await burnsOf('u_other')).some((b) => b.txid === '4'.repeat(64))).toBe(true);
    expect((await burnsOf('u_ender')).some((b) => b.txid === '4'.repeat(64))).toBe(false);
  });

  it('still matches when the amount is right and the named wallet is not', async () => {
    // Naming your wallet as well as your amount must never score BELOW naming
    // the amount alone: change wallets between filing and sending and the
    // burn still finds you.
    await post('/api/burn/intent', { id: 'u_ender', auth: '1234', sats: 9200, from: VICTIM });
    chain.txs.push({
      txid: '5'.repeat(64), sats: 9200, from: ['bc1qadifferentwalletentirelyxxxxxxxx'],
      confirmed: true, height: chain.tip - 3, time: Date.now() + 3000,
    });
    await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 2 });
    expect((await burnsOf('u_ender')).some((b) => b.txid === '5'.repeat(64))).toBe(true);
  });

  it('matches a sending address given in upper case, as a QR payload gives it', async () => {
    await post('/api/burn/intent', { id: 'u_ender', auth: '1234', from: VICTIM.toUpperCase() });
    chain.txs.push({
      txid: '6'.repeat(64), sats: 9300, from: [VICTIM],
      confirmed: true, height: chain.tip - 3, time: Date.now() + 4000,
    });
    await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 3 });
    expect((await burnsOf('u_ender')).some((b) => b.txid === '6'.repeat(64))).toBe(true);
  });
});

describe('what the explorers have to agree on', () => {
  it('refuses when they disagree about which block the burn is in', async () => {
    chain.txs.push({
      txid: '7'.repeat(64), sats: 9400, from: ['bc1qwhatever'],
      confirmed: true, height: chain.tip - 4, time: Date.now() + 5000,
    });
    chain.disagreeHeight['7'.repeat(64)] = chain.tip - 40;
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', txid: '7'.repeat(64) });
    expect(r.status).toBe(200);
    expect(r.body.credited).toBeNull();
    expect((await burnsOf('u_ender')).some((b) => b.txid === '7'.repeat(64))).toBe(false);
  });

  it('refuses when one calls it confirmed without saying where', async () => {
    chain.txs.push({
      txid: '8'.repeat(64), sats: 9500, from: ['bc1qwhatever'],
      confirmed: true, height: chain.tip - 4, time: Date.now() + 6000,
    });
    chain.disagreeHeight['8'.repeat(64)] = null;    // explorer B omits block_height
    const r = await post('/api/burn/intent', { id: 'u_ender', auth: '1234', txid: '8'.repeat(64) });
    expect(r.body.credited).toBeNull();
    expect((await burnsOf('u_ender')).some((b) => b.txid === '8'.repeat(64))).toBe(false);
  });

  it('credits it once they agree', async () => {
    delete chain.disagreeHeight['7'.repeat(64)];
    await post('/api/burn/intent', { id: 'u_other', auth: '9999', sats: 4 });   // runs a tick
    expect((await burnsOf('u_ender')).some((b) => b.txid === '7'.repeat(64))).toBe(true);
  });
});

describe('the doors themselves', () => {
  it('survives a four-byte anonymous POST', async () => {
    // `null` is valid JSON with no fields. Reading one anyway threw inside a
    // request handler, and an uncaught throw takes the whole host — and the
    // whole network — down, from anyone, with no account and no PIN. This was
    // reproduced against the live host, which died.
    for (const path of ['/api/burn/intent', '/api/burn/claim', '/api/act']) {
      const r = await fetch(BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
      });
      expect(r.status).toBe(400);
    }
    // Still answering afterwards, which is the whole point.
    const acts = await get('/api/acts');
    expect(acts.total).toBeGreaterThan(0);
  });

  it('will not stand ready to credit money into a handle with no PIN', async () => {
    const r = await post('/api/burn/intent', { id: 'u_open', auth: '', sats: 5000 });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PIN_REQUIRED');
  });
});

/**
 * The host half of the PEER door: the price oracle and the verification.
 *
 * peer-burn.test.ts holds down the ENGINE's half — that replay is still a pure
 * function of the log, that a recorded price is recomputed rather than
 * believed, that the ceiling and the floors bite on every host. This file
 * holds down the half that touches the world: what the host will and will not
 * accept as evidence that PEER was destroyed, and where the number it prices
 * that destruction at comes from.
 *
 * What is being defended here:
 *
 * 1. AN ACT IS NEVER FILED FOR A TRANSFER NOBODY SAW. Wrong amount, wrong
 *    recipient, wrong token, not deep enough, already claimed, sent from an
 *    address nobody bound — each is a way to be credited for a destruction
 *    that did not happen or is not yours, and each is refused by name.
 * 2. THE PRICE IS TIME-WEIGHTED, AND SAYS WHICH READINGS IT USED. The quote
 *    carries every observation with its block and timestamp, and the test
 *    recomputes the average from exactly that list. "Time-weighted" is a
 *    claim; a claim with its evidence attached is a checkable one.
 * 3. A THIN POOL IS REFUSED IN WORDS. Below the depth floor there is no
 *    price, only a last trade, and pricing a burn off one would mint the
 *    right to speak out of somebody's rounding error.
 * 4. UNCONFIGURED, EVERY ROUTE DEGRADES HONESTLY. That is the shipped state:
 *    no factory is deployed and no PEER/cbBTC pool exists, so there is no
 *    price — and a host that guessed one would be inventing the rate at
 *    which speech is sold.
 *
 * The chain is a fake JSON-RPC endpoint on localhost, and everything else is
 * the real server process. A test that needed Base would be a test that only
 * passes when somebody else's endpoint is having a good day — and the one
 * piece of code that decides whether value was destroyed would be the one
 * piece no test could reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { replay } from './helpers/world';

const ROOT = resolve(__dirname, '..');
/**
 * The engine's own sampling rule, asked of the engine.
 *
 * The host must read the pool at exactly the blocks replay will insist on, or
 * it files acts the network throws away while telling the burner the price was
 * fine. Reimplementing the rule here would test this file against itself.
 */
const engineGrid = replay([{ t: 'seedWorld' }]).peerBurnGrid;
/** The sink, in the spelling a wallet shows. Replay folds case; a person does not. */
const DEAD = '0x000000000000000000000000000000000000dEaD';
const TOKEN = '0x5d63786095d09210011fd382c0710a7a1bc90e6f';   // the deployed PEER
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const FACTORY = '0x4444444444444444444444444444444444444444';
const POOL_ID = 3;
const ENDER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
/** An address nobody binds until AFTER a burn has already left it. */
const LATEBIND = '0x5555555555555555555555555555555555555555';
const OTHER_TOKEN = '0x9999999999999999999999999999999999999999';
const MIN_CONF = 30;
/** The engine's floors, restated so a test fails if one of them moves. */
const SATS_PER_RESERVE = 100;
const RESERVE_PER_EPOCH = 100;
const MIN_POOL_SATS = 1_000_000;

const E18 = 10n ** 18n;
const hex = (n: bigint) => '0x' + n.toString(16);
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * A block's timestamp, and it is a function of the BLOCK, never of where the
 * head happens to be.
 *
 * That is not pedantry: the host holds its readings keyed by block number, so
 * a stub whose timestamps slid every time the head moved would hand the same
 * block two different times in one test run — and the window built from them
 * would fall apart for a reason no real chain could produce. A block's time
 * is a fact about that block, fixed the moment it is mined.
 */
const T0 = Date.now();
const BLOCK0 = 30_000_000;
const blockMs = (n: number) => T0 + (n - BLOCK0) * 2000;
/**
 * A block's HASH, which is the seed the sampling grid is derived from.
 *
 * A real chain's hash is unpredictable, and that unpredictability is the whole
 * defence: it is why an attacker cannot know in advance which blocks inside the
 * averaging window will be read, and therefore cannot pump exactly those. What
 * a stub needs is only that it is a stable 32-byte function of the block —
 * stable because the host records it in the act and replay re-derives the same
 * sample list from it, so a hash that changed between two reads of one block
 * would fail for a reason no real chain could produce.
 */
const blockHash = (n: number) => '0x' + createHash('sha256').update('block:' + n).digest('hex');
/**
 * When the seed bindings were filed: a day before any block in this file.
 *
 * A burn is credited only to a handle that had bound the sending address
 * BEFORE the block that destroyed the coins. That rule is what stops the
 * uncredited list from being a shopping list, and it means every fixture
 * binding has to carry a time and that time has to be old.
 */
const BOUND_AT = T0 - 24 * 3600_000;

/**
 * The chain, as the fake endpoint sees it. Tests mutate this directly.
 *
 * Blocks are two seconds apart and the first head's timestamp is NOW, so the
 * host's staleness check sees a live chain. `pool` is read at whatever block
 * is asked for — the observations the host holds are keyed by block, so
 * mining a whole window of blocks is how a test changes the price it sees.
 */
type FakeTx = {
  txid: string; from: string; to: string; token: string; amt: bigint; block: number; status?: string;
};
type Reserves = { peer: bigint; btc: bigint };
const chain: {
  head: number; pool: Reserves; history: (Reserves & { from: number })[];
  txs: FakeTx[]; serveHistory: boolean; calls: string[];
} = {
  head: BLOCK0,
  // 1,000,000 PEER against 0.1 cbBTC — ten million satoshis, a hundred times
  // the depth floor, so nothing below is refused for being thin by accident.
  pool: { peer: 1_000_000n * E18, btc: 10_000_000n },
  // Reserves that came into effect at a block. This is what makes it possible
  // to ask the question that matters most about the oracle: does a burn get
  // the price that stood when it was made, or the price that stands when
  // somebody gets around to claiming it?
  history: [],
  txs: [],
  serveHistory: true,
  calls: [],
};
const poolAt = (block: number): Reserves => {
  let hit: Reserves = chain.pool;
  for (const h of chain.history) if (block >= h.from) hit = h;
  return hit;
};
/**
 * Mine a transaction into a NEW block and bury it.
 *
 * The claim door works off a receipt and does not care where in history a
 * transaction sits, but the watcher finds burns by walking the token's logs
 * forward and remembering how far it got — so a transaction backdated into
 * blocks the scan already walked is one no real chain could produce and one
 * the watcher will never see. Tests that exercise the watcher have to mine.
 */
function mine(tx: Omit<FakeTx, 'block'>, bury = MIN_CONF + 5) {
  const at = chain.head + 1;
  chain.head = at + bury;
  chain.txs.push({ ...tx, block: at });
  return at;
}

let rpc: Server;
let RPC_PORT = 0;
let PORT = 0;
let OFF_PORT = 0;
let BASE = '';
let OFF = '';
let child: ChildProcess;
let offChild: ChildProcess;
let dir: string;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** The 5 static words poolInfo returns: name, resPeer, resBtc, totalShares, creator. */
const poolInfoReturn = (block: number) => {
  const r = poolAt(block);
  return '0x' + Buffer.from('official').toString('hex').padEnd(64, '0')
    + word(r.peer) + word(r.btc) + word(1000n) + addrWord(ENDER);
};

function handleRpc(body: { method: string; params?: unknown[]; id: number }) {
  const { method, params = [] } = body;
  chain.calls.push(method);
  if (method === 'eth_chainId') return '0x2105';                       // 8453
  if (method === 'eth_blockNumber') return hex(BigInt(chain.head));
  if (method === 'eth_getBlockByNumber') {
    const tag = String(params[0]);
    const n = tag === 'latest' ? chain.head : Number(BigInt(tag));
    if (n > chain.head || n < 0) return null;
    // Headers are served whatever `serveHistory` says, because that is what a
    // real pruning node does: it drops historical STATE, not the chain. The
    // distinction matters here — the host reads a block header to learn when a
    // burn happened, and conflating the two would make 'this node keeps no old
    // state' come back as 'this host cannot tell when your coins were
    // destroyed', which is a sentence about the wrong thing.
    return { number: hex(BigInt(n)), hash: blockHash(n), timestamp: hex(BigInt(Math.floor(blockMs(n) / 1000))) };
  }
  if (method === 'eth_call') {
    const p = params[0] as { to: string; data: string };
    const to = String(p.to).toLowerCase();
    const data = String(p.data).toLowerCase();
    const tag = String(params[1] ?? 'latest');
    // An endpoint that keeps no old state answers nothing for old blocks.
    // That is a real class of public RPC and the host must say so rather
    // than fall back to a spot read — the fallback is the attack.
    if (!chain.serveHistory && tag !== 'latest' && Number(BigInt(tag)) < chain.head) {
      throw new Error('missing trie node — this node keeps no historical state');
    }
    if (to === FACTORY.toLowerCase()) {
      if (data.startsWith('0x11cda415')) return '0x' + addrWord(TOKEN);      // peer()
      if (data.startsWith('0xa28d57d8')) return '0x' + addrWord(CBBTC);      // btc()
      if (data.startsWith('0x1526fe27')) {                                    // poolInfo(uint256)
        const id = Number(BigInt('0x' + data.slice(10)));
        const at = tag === 'latest' ? chain.head : Number(BigInt(tag));
        return id === POOL_ID ? poolInfoReturn(at) : '0x';
      }
    }
    if (data.startsWith('0x313ce567')) return '0x' + word(to === CBBTC ? 8n : 18n);   // decimals()
    return '0x';
  }
  if (method === 'eth_getTransactionReceipt') {
    const id = String(params[0]).toLowerCase();
    const tx = chain.txs.find((t) => t.txid === id);
    if (!tx) return null;
    return {
      transactionHash: tx.txid,
      blockNumber: hex(BigInt(tx.block)),
      status: tx.status ?? '0x1',
      logs: [{
        address: tx.token,
        topics: [TOPIC_TRANSFER, '0x' + addrWord(tx.from), '0x' + addrWord(tx.to)],
        data: '0x' + word(tx.amt),
        blockNumber: hex(BigInt(tx.block)),
        logIndex: '0x0',
      }],
    };
  }
  if (method === 'eth_getLogs') {
    const f = params[0] as { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string };
    const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock));
    const wantTo = f.topics[2] ? String(f.topics[2]).toLowerCase() : null;
    return chain.txs
      .filter((t) => t.block >= lo && t.block <= hi
        && t.token.toLowerCase() === String(f.address).toLowerCase()
        && (t.status ?? '0x1') === '0x1'
        && (!wantTo || '0x' + addrWord(t.to) === wantTo))
      .map((t) => ({
        address: t.token,
        topics: [TOPIC_TRANSFER, '0x' + addrWord(t.from), '0x' + addrWord(t.to)],
        data: '0x' + word(t.amt),
        blockNumber: hex(BigInt(t.block)),
        logIndex: '0x0',
        transactionHash: t.txid,
      }));
  }
  return null;
}

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, never> };
};
const get = async (base: string, path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as Record<string, never> };
};
const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
const txid = (c: string) => '0x' + c.repeat(64).slice(0, 64);

/** Every peerBurn act in the log, straight from the public act stream. */
async function peerBurns(id?: string) {
  const { body } = await get(BASE, '/api/acts');
  const all = (body as unknown as { acts: Record<string, string>[] }).acts;
  return all.filter((a) => a.t === 'peerBurn' && (!id || a.id === id));
}

async function boot(port: number, env: Record<string, string>) {
  const proc = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(port)], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let died = '';
  proc.stderr?.on('data', (d) => { died += String(d); });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/acts`); return proc; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up on ' + port + (died ? ': ' + died.trim() : ''));
}

beforeAll(async () => {
  RPC_PORT = await freePort();
  PORT = await freePort();
  OFF_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  OFF = `http://127.0.0.1:${OFF_PORT}`;

  rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      let parsed: { method: string; params?: unknown[]; id: number };
      try { parsed = JSON.parse(body); } catch { res.end('{}'); return; }
      try {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: handleRpc(parsed) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { message: String((e as Error).message) } }));
      }
    });
  });
  await new Promise<void>((r) => rpc.listen(RPC_PORT, r));

  dir = mkdtempSync(join(tmpdir(), 'peerburn-host-'));
  const seed = [
    { t: 'register', id: 'u_ender', handle: 'ender', seed: 1, epoch: 0, pinHash: hash('u_ender', '1234') },
    { t: 'register', id: 'u_other', handle: 'Other', seed: 1, epoch: 0, pinHash: hash('u_other', '9999') },
    { t: 'register', id: 'u_bare', handle: 'Bare', seed: 1, epoch: 0, pinHash: hash('u_bare', '5555') },
    // The bindings are the whole ownership story on this door: a transfer
    // names its sender, and these say whose that sender is — but only when
    // exactly ONE handle has said it, and only when it was said BEFORE the
    // coins were destroyed. Both halves are carried here: one handle each, and
    // a timestamp a day older than any block in this file. u_bare binds
    // nothing, on purpose.
    { t: 'bindAddress', id: 'u_ender', addr: ENDER, ts: BOUND_AT },
    { t: 'bindAddress', id: 'u_other', addr: OTHER, ts: BOUND_AT },
  ];
  for (const d of [join(dir, 'on'), join(dir, 'off')]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'acts.jsonl'), seed.map((a) => JSON.stringify(a)).join('\n') + '\n');
  }

  const common = {
    PEER_ACT_RATE: '600',
    PEER_L2_RPC: `http://127.0.0.1:${RPC_PORT}`,
    PEER_L2_CHAIN_ID: '8453',
    PEER_TOKEN_ADDR: TOKEN,
    PEER_BTC_ADDR: CBBTC,
    // The bitcoin door and the pool list stay out of this host entirely: this
    // file is about the PEER door, and a second watcher polling explorers
    // would only add flakiness.
    PEER_BURN_ADDRESS: '',
    PEER_POOLS_ADDR: '',
  };
  [child, offChild] = await Promise.all([
    boot(PORT, {
      ...common,
      PEER_DATA_DIR: join(dir, 'on'),
      PEER_PEERBURN_FACTORY: FACTORY,
      PEER_PEERBURN_POOL_ID: String(POOL_ID),
      PEER_PEERBURN_FROM_BLOCK: String(chain.head - 5000),
      PEER_PEERBURN_MIN_CONF: String(MIN_CONF),
      // Effectively never on its own. The watcher is exercised deliberately
      // below through GET /api/peerburn/pending, which ticks before it
      // answers — a background tick firing between a test's push and its
      // claim would make the suite flaky about which door did the crediting,
      // and the point of the watcher test is that the credit happens with
      // nobody claiming at all, not that it happens on a timer.
      PEER_PEERBURN_WATCH_INTERVAL: '3000000',
      // The pending door memoises its tick for ten seconds in production, so
      // that an anonymous caller in a loop cannot spend the operator's chain
      // quota. Off here: these tests mine a block and read the result in the
      // same breath, and a memo would only be testing itself.
      PEER_PEERBURN_TICK_MEMO_MS: '0',
      // And the quote is memoised for fifteen seconds in production, for the
      // same reason and with the same tradeoff — a window half an hour long
      // is not meaningfully different fifteen seconds later. Off here for the
      // same reason as above: these tests change the pool and read the price
      // in the same breath.
      PEER_PEERBURN_QUOTE_MEMO_MS: '0',
    }),
    // The same host with no pool configured — the shipped state.
    boot(OFF_PORT, { ...common, PEER_DATA_DIR: join(dir, 'off') }),
  ]);
}, 40_000);

afterAll(async () => {
  child?.kill();
  offChild?.kill();
  await new Promise<void>((r) => rpc.close(() => r()));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('with nothing configured', () => {
  it('refuses to quote a price, and says why instead of guessing one', async () => {
    const { status, body } = await get(OFF, '/api/peerburn');
    expect(status).toBe(404);
    expect(body.code).toBe('PEERBURN_OFF');
    expect(body.accepting).toBe(false);
    expect(String(body.why)).toMatch(/PEER_PEERBURN_FACTORY/);
    // The point of the refusal: no invented rate anywhere in the body.
    expect(JSON.stringify(body)).not.toMatch(/"sats":\s*\d/);
    expect(body.missing).toContain('PEER_PEERBURN_POOL_ID');
  });

  it('refuses a claim rather than half-accepting it', async () => {
    const r = await post(OFF, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('a') });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PEERBURN_OFF');
  });

  it('says the pending list is off too, rather than showing an empty one', async () => {
    const { status, body } = await get(OFF, '/api/peerburn/pending');
    expect(status).toBe(404);
    expect(body.code).toBe('PEERBURN_OFF');
  });

  it('points at the door that needs no price at all', async () => {
    const { body } = await get(OFF, '/api/peerburn');
    expect(String(body.bitcoinDoor)).toMatch(/\/api\/burn/);
  });
});

describe('the price', () => {
  it('is time-weighted over the window, from the readings it names', async () => {
    const { status, body } = await get(BASE, '/api/peerburn?peer=1000');
    expect(status).toBe(200);
    expect(body.accepting).toBe(true);
    const q = body.quote as unknown as {
      available: boolean; resPeerRaw: string; resBtcRaw: string; twapMs: number; observations: number;
      samples: { block: number; ms: number; resPeerRaw: string; resBtcRaw: string }[];
      startsAt: number; endsAt: number; refHash: string; grid: number; blocks: number[];
      sats: number; reserve: number; amtRaw: string;
    };
    expect(q.available).toBe(true);
    // The engine's floors, enforced by the host before it will price anything.
    expect(q.observations).toBeGreaterThanOrEqual(12);
    expect(q.twapMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(q.samples.length).toBe(q.observations);

    // …and the blocks it read are the ones the ENGINE's rule selects from the
    // reference block's hash — not a grid this host chose for itself. That is
    // the difference between a window and a decoration: a fixed arithmetic
    // grid is public, so an attacker who picks the block of their own burn
    // knows every block that will be read and pumps exactly those, holding a
    // false price for 1.4% of the window instead of all of it.
    expect(q.refHash).toBe(blockHash(q.endsAt));
    expect(q.blocks).toEqual(engineGrid(q.startsAt, q.endsAt, q.refHash, q.grid).slice(0, q.blocks.length));
    expect(q.blocks).toEqual(q.samples.map((s) => s.block));
    for (const b of q.blocks) { expect(b).toBeGreaterThanOrEqual(q.startsAt); expect(b).toBeLessThan(q.endsAt); }

    // Recompute the average from exactly the samples the answer published:
    // each reading stands until the next, the last stands to the head. If the
    // host quoted a number these samples do not produce, "time-weighted"
    // would be a word rather than a method.
    const s = q.samples;
    const end = s[s.length - 1].ms + (q.twapMs - (s[s.length - 1].ms - s[0].ms));
    let wPeer = 0n, wBtc = 0n, total = 0n;
    for (let i = 0; i < s.length; i++) {
      const until = i + 1 < s.length ? s[i + 1].ms : end;
      const dur = BigInt(Math.max(0, Math.round(until - s[i].ms)));
      wPeer += BigInt(s[i].resPeerRaw) * dur;
      wBtc += BigInt(s[i].resBtcRaw) * dur;
      total += dur;
    }
    expect(q.resPeerRaw).toBe(((wPeer + total - 1n) / total).toString());   // ceil, against the burner
    expect(q.resBtcRaw).toBe((wBtc / total).toString());                    // floor, against the burner

    // And the quote itself is the constant-product OUTPUT of those reserves,
    // not the marginal ratio — the price a burn this size could actually get.
    const amt = BigInt(q.amtRaw);
    const sats = Number((amt * BigInt(q.resBtcRaw)) / (BigInt(q.resPeerRaw) + amt));
    expect(q.sats).toBe(sats);
    expect(q.reserve).toBe(sats / SATS_PER_RESERVE);
  }, 20_000);

  it('names the pool by factory and id, and says a name is not an identity', async () => {
    const { body } = await get(BASE, '/api/peerburn');
    const pool = body.pool as unknown as { poolId: number; factory: string; creator: string; nameNote: string };
    expect(pool.poolId).toBe(POOL_ID);
    expect(pool.factory).toBe(FACTORY.toLowerCase());
    expect(String(pool.nameNote)).toMatch(/per-creator label/i);
    expect(pool.creator).toBe(ENDER.toLowerCase());
  });

  it('states the difference between the two doors rather than implying they are equal', async () => {
    const { body } = await get(BASE, '/api/peerburn');
    expect(String(body.provenance)).toMatch(/unspendable by arithmetic/i);
    expect(String(body.provenance)).toMatch(/nobody knows a key/i);
    expect(String(body.address)).toBe(DEAD);
    expect(String(body.priceMayMove)).toMatch(/quote, not an offer/i);
  });

  it('tells a handle how much of this epoch’s ceiling is left', async () => {
    const { body } = await get(BASE, '/api/peerburn?as=u_ender');
    const you = body.you as unknown as {
      boundAddress: string; reserveLeftThisEpoch: number;
      burnsFromItAreYours: boolean; bindersOfThatAddress: number; note: string;
    };
    expect(you.boundAddress).toBe(ENDER.toLowerCase());
    expect(you.reserveLeftThisEpoch).toBe(RESERVE_PER_EPOCH);
    // …and whether a burn from that address would actually be credited, which
    // is NOT the same question as whether it is bound.
    expect(you.burnsFromItAreYours).toBe(true);
    expect(you.bindersOfThatAddress).toBe(1);
  });

  it('tells a handle with nothing bound to bind BEFORE burning, not after', async () => {
    // The order is the whole protection, so it is said before anybody spends
    // anything rather than in the refusal afterwards.
    const { body } = await get(BASE, '/api/peerburn?as=u_bare');
    const you = body.you as unknown as { boundAddress: string | null; burnsFromItAreYours: boolean; note: string };
    expect(you.boundAddress).toBe(null);
    expect(you.burnsFromItAreYours).toBe(false);
    expect(String(you.note)).toMatch(/before burning/i);
  });
});

describe('verification refuses', () => {
  it('a transfer that pays some other address', async () => {
    chain.txs.push({ txid: txid('b'), from: ENDER, to: STRANGER, token: TOKEN, amt: 10n * E18, block: chain.head - 100 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('b') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEERBURN_UNVERIFIED');
    expect(String(r.body.error)).toMatch(/moves no PEER/i);
    expect(await peerBurns()).toHaveLength(0);
  });

  it('a transfer of some other token to the right address', async () => {
    chain.txs.push({ txid: txid('c'), from: ENDER, to: DEAD, token: OTHER_TOKEN, amt: 10n * E18, block: chain.head - 100 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('c') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEERBURN_UNVERIFIED');
    // Anyone can deploy a token, mint a trillion and destroy it for gas.
    expect(String(r.body.error)).toMatch(new RegExp(OTHER_TOKEN, 'i'));
    expect(await peerBurns()).toHaveLength(0);
  });

  it('a burn that is not buried deeply enough yet', async () => {
    chain.txs.push({ txid: txid('d'), from: ENDER, to: DEAD, token: TOKEN, amt: 10n * E18, block: chain.head - 5 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('d') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEERBURN_UNCONFIRMED');
    expect(r.body.needed).toBe(MIN_CONF);
    expect(Number(r.body.depth)).toBe(6);
  });

  it('a transaction that reverted, however real its logs look', async () => {
    chain.txs.push({ txid: txid('e'), from: ENDER, to: DEAD, token: TOKEN, amt: 10n * E18, block: chain.head - 100, status: '0x0' });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('e') });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/FAILED|reverted/i);
  });

  it('somebody else’s burn, claimed by the wrong handle', async () => {
    chain.txs.push({ txid: txid('f'), from: OTHER, to: DEAD, token: TOKEN, amt: 5n * E18, block: chain.head - 200 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('f') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEERBURN_UNOWNED');
    expect(String(r.body.error)).toMatch(/bound to u_other/i);
  });

  it('a handle with no address bound to it at all', async () => {
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_bare', auth: '5555', txid: txid('f') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEERBURN_NO_BINDING');
  });

  it('a claim without the PIN', async () => {
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', txid: txid('f') });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PIN_REQUIRED');
  });

  it('a hash that is not a Base transaction hash', async () => {
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: 'deadbeef' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_TXID');
  });
});

describe('a burn that really happened', () => {
  const AMT = 1000n * E18;

  it('is credited at the pool’s price, from the chain’s amount and not the claimant’s', async () => {
    chain.txs.push({ txid: txid('1'), from: ENDER, to: DEAD, token: TOKEN, amt: AMT, block: chain.head - 300 });
    // The claim names an amount a hundred times larger. It is not a field the
    // host reads — the amount comes from the transfer — and this asserts that
    // rather than trusting it.
    const r = await post(BASE, '/api/peerburn/claim', {
      id: 'u_ender', auth: '1234', txid: txid('1'), amtRaw: String(AMT * 100n), sats: 999_999,
    });
    expect(r.status).toBe(200);
    expect(r.body.peerBurnedRaw).toBe(String(AMT));
    const priced = r.body.pricedAt as unknown as { resPeerRaw: string; resBtcRaw: string };
    const expected = Number((AMT * BigInt(priced.resBtcRaw)) / (BigInt(priced.resPeerRaw) + AMT));
    expect(r.body.sats).toBe(expected);
    expect(r.body.reserve).toBe(expected / SATS_PER_RESERVE);
    expect(r.body.address).toBe(DEAD);
  }, 20_000);

  it('writes an act that carries its own proof — the hash, the reserves, the window', async () => {
    const [act] = await peerBurns('u_ender');
    expect(act).toBeTruthy();
    expect(act.txid).toBe(txid('1'));
    expect(act.pool).toBe(POOL_ID as unknown as string);
    // Raw amounts are STRINGS. An 18-decimal number that went through JSON as
    // a number is already rounded, and two honest hosts would then price the
    // same burn differently.
    expect(typeof act.amtRaw).toBe('string');
    expect(typeof act.resPeerRaw).toBe('string');
    expect(typeof act.resBtcRaw).toBe('string');
    expect(Number(act.twapMs)).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(Number(act.obs)).toBeGreaterThanOrEqual(12);
    expect(String(act.addr).toLowerCase()).toBe(DEAD.toLowerCase());
    // The recorded value is exactly what its own recorded reserves produce —
    // the property replay re-checks and refuses on.
    const amt = BigInt(act.amtRaw);
    expect(Number(act.sats)).toBe(Number((amt * BigInt(act.resBtcRaw)) / (BigInt(act.resPeerRaw) + amt)));
    expect(Number(act.reserve)).toBe(Number(act.sats) / SATS_PER_RESERVE);
  });

  it('records WHOSE burn it was, WHICH pool priced it, and WHERE the window sat', async () => {
    // Three things were missing, and each one turned a checkable number back
    // into an assertion. `from` is the address the coins left — ownership is
    // decided from the bindings in the log and cannot be decided at all if the
    // act does not say whose transfer this was. `factory` is the other half of
    // the pool's identity: two factories both have a pool 3, and the act used
    // to record only the number. The window fields are what let a reader
    // re-fetch the pool at the same blocks instead of checking the recorded
    // reserves against themselves.
    const [act] = await peerBurns('u_ender');
    expect(String(act.from).toLowerCase()).toBe(ENDER.toLowerCase());
    expect(String(act.factory).toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(Number(act.blockMs)).toBeGreaterThan(0);
    const startsAt = Number(act.startsAt), endsAt = Number(act.endsAt);
    expect(endsAt).toBeGreaterThan(startsAt);
    expect(act.refHash).toBe(blockHash(endsAt));
    const blocks = act.blocks as unknown as number[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBe(Number(act.obs));
    // …and those blocks are exactly the ones the engine's rule derives from
    // the recorded seed. This is the check replay itself performs, and it is
    // why the window cannot be sampled wherever a host finds convenient.
    const grid = engineGrid(startsAt, endsAt, String(act.refHash), 16);
    for (const b of blocks) expect(grid).toContain(b);
    // The whole burn was credited: nothing here is near the ceiling.
    expect(Number(act.creditsSats)).toBe(Number(act.sats));
  });

  it('gives the burner reserve — the right to speak — and nothing else', async () => {
    const [act] = await peerBurns('u_ender');
    const { body } = await get(BASE, '/api/v1/whoami?as=u_ender');
    expect(Number(body.energy)).toBeCloseTo(Number(act.reserve), 6);
    expect(body.canAct).toBe(true);
  });

  it('is never credited twice, whoever presents it', async () => {
    const mine = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('1') });
    expect(mine.status).toBe(409);
    expect(mine.body.code).toBe('PEERBURN_ALREADY_CLAIMED');
    const theirs = await post(BASE, '/api/peerburn/claim', { id: 'u_other', auth: '9999', txid: txid('1') });
    expect(theirs.body.code).toBe('PEERBURN_ALREADY_CLAIMED');
    expect(await peerBurns()).toHaveLength(1);
  });
});

describe('the watcher', () => {
  it('credits a burn with nobody watching — the tab can be closed', async () => {
    mine({ txid: txid('2'), from: OTHER, to: DEAD, token: TOKEN, amt: 500n * E18 });
    // No claim call, no PIN, nobody naming the transaction. The host scans the
    // dead address itself and matches the sender against the bindings in the
    // log — which is why this door needs no intents at all: a transfer names
    // the address it came from, and a bindAddress act says whose that is.
    await get(BASE, '/api/peerburn/pending');
    const found = await peerBurns('u_other');
    expect(found).toHaveLength(1);
    expect(found[0].txid).toBe(txid('2'));
  }, 30_000);

  it('leaves a stranger’s burn alone, and says why it is uncredited', async () => {
    mine({ txid: txid('3'), from: STRANGER, to: DEAD, token: TOKEN, amt: 700n * E18 });
    const { body: pending } = await get(BASE, '/api/peerburn/pending');
    const seen = (pending.uncredited as unknown as { txid: string; from: string }[]) || [];
    expect(seen.some((u) => u.txid === txid('3'))).toBe(true);
    expect((await peerBurns()).some((a) => a.txid === txid('3'))).toBe(false);
    // And it says WHY, per burn, rather than leaving somebody whose PEER is
    // gone to guess: nobody has bound the address it came from.
    const why = (pending.lastTickSaw as unknown as { txid: string; why: string }[])
      .find((u) => u.txid === txid('3'));
    expect(String(why?.why)).toMatch(/no handle had bound the address/i);
    expect(String(pending.howItIsDecided)).toMatch(/address bindings in the public act log/i);
    // …and it does NOT tell the reader to go and bind that address. It used
    // to — 'bind the address you sent from and it is credited on the next
    // tick' — which turned this public list into a shopping list: anyone could
    // bind a stranger's sending address, claim their burn, and lock the real
    // burner out of it forever, on every host.
    expect(String(pending.howItIsDecided)).toMatch(/PREDATE the burn/);
    expect(String(pending.howItIsDecided)).toMatch(/will not reach it/i);
  }, 20_000);

  it('will not credit a burn to whoever binds that address afterwards', async () => {
    // The theft, end to end, against the real server process. Under the old
    // rule this returned 200 with reserve, and the person who actually
    // destroyed the coins then got PEERBURN_ALREADY_CLAIMED for ever — on
    // every host, because the dedupe is by transaction hash.
    //
    // The burn sits at a block BELOW this file's zero, which is the only way
    // to get a block whose timestamp is genuinely older than a binding filed
    // during the test: this stub mines instantly, so its head runs ahead of
    // the wall clock rather than alongside it as a real chain's does.
    chain.txs.push({ txid: txid('9'), from: LATEBIND, to: DEAD, token: TOKEN, amt: 40n * E18, block: BLOCK0 - 400 });
    const bindLate = await post(BASE, '/api/v1/bind', { as: 'u_bare', pin: '5555', address: LATEBIND });
    expect(bindLate.status).toBe(200);
    const grab = await post(BASE, '/api/peerburn/claim', { id: 'u_bare', auth: '5555', txid: txid('9') });
    expect(grab.status).toBe(400);
    expect(grab.body.code).toBe('PEERBURN_BOUND_AFTER_BURN');
    expect(String(grab.body.error)).toMatch(/Bind first, then burn/i);
    expect((await peerBurns()).some((a) => a.txid === txid('9'))).toBe(false);
    // …and the binding itself is untouched: epoch earnings still go there. It
    // is only this door that a late binding cannot open.
    const { body } = await get(BASE, '/api/peerburn?as=u_bare');
    expect((body.you as unknown as { boundAddress: string }).boundAddress).toBe(LATEBIND.toLowerCase());
  }, 30_000);
});

describe('when the price is fixed', () => {
  it('is the window ending at the burn’s own block, not the one standing at claim time', async () => {
    // The burn lands while the pool holds 0.1 cbBTC.
    const at = mine({ txid: txid('7'), from: OTHER, to: DEAD, token: TOKEN, amt: 10n * E18 });
    // Then PEER triples against bitcoin, and a whole window of chain goes by.
    // Priced at claim time this burn would be worth three times as much — and
    // that is the free option this anchoring removes: burn from an address
    // nobody has bound, watch, then bind and claim on a good day.
    chain.history.push({ from: at + 1, peer: 1_000_000n * E18, btc: 30_000_000n });
    chain.head += 1500;
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_other', auth: '9999', txid: txid('7') });
    expect(r.status).toBe(200);
    const priced = r.body.pricedAt as unknown as { resBtcRaw: string };
    expect(priced.resBtcRaw).toBe('10000000');       // what the pool held then
    expect(priced.resBtcRaw).not.toBe('30000000');   // not what it holds now
    // And the quote, which is about now rather than about a burn, does move.
    const { body } = await get(BASE, '/api/peerburn?peer=10');
    expect((body.quote as unknown as { resBtcRaw: string }).resBtcRaw).toBe('30000000');
  }, 20_000);
});

describe('the ceiling', () => {
  it('credits the slice that fits and says what is left, instead of forfeiting the burn', async () => {
    // 100,000 PEER against this pool is ~909,000 sat — some 9,000 reserve,
    // ninety times one epoch's allowance.
    //
    // This used to be refused WHOLE, with the sentence 'claim the rest next
    // epoch'. That sentence was false: the ceiling test was `used + reserve >
    // ceiling` and `used` resets each epoch, so a burn worth more than one
    // whole allowance failed it in EVERY epoch that will ever exist. The PEER
    // was destroyed on Base and credited nothing, permanently, on every host,
    // and against this pool the line is crossed at about 1,101 PEER.
    //
    // Now the act states the slice it credits. The remainder is still on the
    // chain, still that handle's, and claimed an epoch at a time.
    chain.txs.push({ txid: txid('4'), from: OTHER, to: DEAD, token: TOKEN, amt: 100_000n * E18, block: chain.head - 600 });
    const before = await get(BASE, '/api/peerburn?as=u_other');
    const left = Number((before.body.you as unknown as { reserveLeftThisEpoch: number }).reserveLeftThisEpoch);
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_other', auth: '9999', txid: txid('4') });
    expect(r.status).toBe(200);
    // Worth thousands; credited exactly the headroom that was left.
    expect(Number(r.body.reserve)).toBeGreaterThan(1000);
    expect(Number(r.body.credited)).toBeCloseTo(left, 6);
    expect(Number(r.body.remainingSats)).toBe(Number(r.body.sats) - Number(r.body.creditedSats));
    expect(Number(r.body.remainingSats)).toBeGreaterThan(0);
    const [act] = (await peerBurns()).filter((a) => a.txid === txid('4'));
    expect(act).toBeTruthy();
    expect(Number(act.creditsSats)).toBeLessThan(Number(act.sats));
    // The allowance is now spent to the satoshi, and asking again says so
    // rather than pretending there is more to take.
    const after = await get(BASE, '/api/peerburn?as=u_other');
    expect(Number((after.body.you as unknown as { reserveLeftThisEpoch: number }).reserveLeftThisEpoch)).toBe(0);
    const again = await post(BASE, '/api/peerburn/claim', { id: 'u_other', auth: '9999', txid: txid('4') });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('PEER_BURN_CAP');
    expect(String(again.body.error)).toMatch(/claimable after the next epoch closes/i);
  }, 20_000);
});

describe('a pool too thin to have a price', () => {
  it('is refused in words rather than priced badly', async () => {
    // The pool loses its bitcoin side, and the head moves a whole window on
    // so that every reading the host holds falls out of it. Nothing here is
    // cached into looking healthy.
    chain.history = [];
    chain.pool = { peer: 1_000_000n * E18, btc: BigInt(MIN_POOL_SATS) - 1n };
    chain.head += 1500;
    chain.txs.push({ txid: txid('5'), from: ENDER, to: DEAD, token: TOKEN, amt: 10n * E18, block: chain.head - 700 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('5') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEER_BURN_THIN_POOL');
    expect(String(r.body.error)).toMatch(/no price, only a last trade|floor/i);
    expect((await peerBurns()).some((a) => a.txid === txid('5'))).toBe(false);
  }, 20_000);

  it('says so on the quote too, instead of showing a number', async () => {
    const { body } = await get(BASE, '/api/peerburn?peer=10');
    const q = body.quote as unknown as { available: boolean; code: string; why: string };
    expect(q.available).toBe(false);
    expect(q.code).toBe('PEER_BURN_THIN_POOL');
    expect(body.accepting).toBe(true);            // the door is on; the pool is not usable
  }, 20_000);
});

describe('an endpoint that keeps no history', () => {
  it('refuses to price a burn off a spot read', async () => {
    chain.pool = { peer: 1_000_000n * E18, btc: 10_000_000n };   // healthy again
    chain.serveHistory = false;
    chain.head += 1500;                                          // every held reading falls out of the window
    chain.txs.push({ txid: txid('6'), from: ENDER, to: DEAD, token: TOKEN, amt: 10n * E18, block: chain.head - 800 });
    const r = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('6') });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PEER_BURN_STALE_PRICE');
    // The refusal names what it could not get, rather than blaming the burner.
    expect(String(r.body.error)).toMatch(/observation|reading|spot price/i);
    expect((await peerBurns()).some((a) => a.txid === txid('6'))).toBe(false);
  }, 20_000);
});

/**
 * LAST, because it permanently ambiguates ENDER's address for this host.
 *
 * That is the point of the rule and the reason it is worth a test of its own:
 * a second binding does not TAKE anything, it closes the door for that address.
 * Every other rule considered here ends in a theft — newest-wins is the hole
 * that was demonstrated, first-binder-wins makes pre-binding a stranger's
 * address a silent capture — so ambiguity refuses.
 */
describe('an address two handles have bound', () => {
  it('credits neither of them, and takes nothing from either', async () => {
    chain.serveHistory = true;
    chain.pool = { peer: 1_000_000n * E18, btc: 10_000_000n };
    chain.history = [];
    const burnBlock = mine({ txid: txid('8'), from: ENDER, to: DEAD, token: TOKEN, amt: 250n * E18 });
    expect(burnBlock).toBeGreaterThan(0);
    // u_bare binds an address that is already u_ender's. It costs a PIN u_bare
    // already has, and nothing anywhere can check that the address is theirs.
    const r = await post(BASE, '/api/v1/bind', { as: 'u_bare', pin: '5555', address: ENDER });
    expect(r.status).toBe(200);
    const thief = await post(BASE, '/api/peerburn/claim', { id: 'u_bare', auth: '5555', txid: txid('8') });
    expect(thief.body.code).toBe('PEERBURN_UNOWNED');
    const owner = await post(BASE, '/api/peerburn/claim', { id: 'u_ender', auth: '1234', txid: txid('8') });
    expect(owner.body.code).toBe('PEERBURN_UNOWNED');
    expect(String(owner.body.error)).toMatch(/more than one handle has bound/i);
    expect((await peerBurns()).some((a) => a.txid === txid('8'))).toBe(false);
    // The watcher agrees with the door, which it did not before: the ambiguity
    // check lived only in the tick, so it denied the honest automatic path
    // while leaving the manual one open to whoever asked.
    await get(BASE, '/api/peerburn/pending');
    expect((await peerBurns()).some((a) => a.txid === txid('8'))).toBe(false);
    // And every burn already credited to u_ender stays credited. An ambiguous
    // address shuts a door; it does not reach backwards.
    const mine1 = await peerBurns('u_ender');
    expect(mine1.some((a) => a.txid === txid('1'))).toBe(true);
  }, 30_000);
});

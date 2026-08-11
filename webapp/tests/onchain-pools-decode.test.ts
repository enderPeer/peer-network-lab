/**
 * The namedPools path in chain-l2/onchain.mjs, exercised without a chain:
 * global fetch is replaced by a dispatcher answering exactly the JSON-RPC
 * calls tokenState() is expected to make, from canned hex. What is asserted
 * is the decoding and the DISCOVERY, because those are the parts with room
 * to be wrong quietly:
 *
 * - pools are found from PoolCreated logs, never by walking ids 0,1,2… The
 *   walk was censorable for pocket change: 256 dust pools occupy the ids a
 *   reader was willing to visit and the operator's real pool disappears from
 *   this host forever. That exact attack is staged below, and the real pool
 *   must come back FIRST, because the list is ranked by bitcoin depth and
 *   depth is the one thing dust cannot fake;
 * - the scan is CHUNKED and it remembers. One eth_getLogs from the deploy
 *   block to 'latest' is refused the moment the range passes 10,000 blocks,
 *   which on Base's two-second blocks is 5h33m after deployment — so a host
 *   that worked all afternoon threw on every refresh from then on, forever.
 *   Windows stay under the cap, a refused window keeps what was already
 *   found and says which window it was, and the cursor persisted in the data
 *   directory means the second refresh walks the new tail rather than the
 *   whole chain again;
 * - depth means depth NOW. The pre-filter that chooses which pools are worth
 *   an eth_call once ranked candidates by the opening deposit in the log —
 *   a number an attacker deposits and withdraws in the same block. Sixty-four
 *   pools opened rich and drained bought the same burial the id walk did.
 *   Both the ranking and the pre-filter read current reserves now, and the
 *   staged whale below must lose to a smaller pool that still holds coins;
 * - every cap is visible — total, discovered, returned, skipped, unread,
 *   truncated — since a cap you cannot see is indistinguishable from the
 *   censorship this path exists to defeat;
 * - poolInfo answers FIVE words now (name, resPeer, resBtc, totalShares,
 *   creator) and a four-word answer is counted as unread rather than
 *   half-decoded;
 * - bytes32 names come back as the utf-8 someone typed, with Solidity's
 *   right-padding NULs stripped — and the raw 32-byte word travels
 *   alongside, because the padding is not content but the exact bytes ARE
 *   the pool's on-chain identity;
 * - reserves and shares stay raw integer strings end to end, including
 *   values past Number.MAX_SAFE_INTEGER where a float would already have
 *   rounded — floats are display-only and never appear here;
 * - decimals come from the FACTORY's own peer()/btc(), not from this host's
 *   env, and a disagreement between the two is reported naming both rather
 *   than silently resolved;
 * - no exported reader answers off the wrong chain — not tokenState, not
 *   balanceOf, not sharesOf.
 *
 * The last block runs a real host process against a fake JSON-RPC endpoint,
 * because the 30-second cache and the ?of= composition only exist in the
 * request path: a burst of cold-cache requests must cost ONE round of RPC
 * calls, and a refused chain must not attach a balance underneath its own
 * refusal.
 *
 * The selectors here are hardcoded with their signatures like everywhere
 * else in the repo; pools-onchain.test.ts already proves they agree with the
 * compiler's methodIdentifiers table in PeerPools.build.json.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOKEN = '0x' + '11'.repeat(20);
const POOLS = '0x' + '22'.repeat(20);
const BTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // cbBTC on Base
const WHO = '0x' + 'ab'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20);
const BOB = '0x' + 'b0'.repeat(20);

// Env must be in place BEFORE the module loads: onchain.mjs reads it once
// at import time, which is why this import is dynamic and sits below.
//
// PEER_DATA_DIR is set to a throwaway for the same reason server.mjs has the
// variable at all: the scan now persists its cursor and the ids it has seen,
// and a test suite that wrote that into the developer's real server-data
// would be editing the live host's memory to make its own assertions pass.
const DATA_TMP = mkdtempSync(join(tmpdir(), 'peer-onchain-scan-'));
const SCAN_FILE = join(DATA_TMP, 'pools-scan.json');
process.env.PEER_DATA_DIR = DATA_TMP;
process.env.PEER_TOKEN_ADDR = TOKEN;
process.env.PEER_BTC_ADDR = BTC;
process.env.PEER_POOLS_ADDR = POOLS;
delete process.env.PEER_POOL_ADDR; // no v2 pair here — namedPools only
delete process.env.PEER_L2_RPC; // default RPC; fetch is stubbed, nothing leaves
delete process.env.PEER_L2_CHAIN_ID;
delete process.env.PEER_POOLS_FROM_BLOCK;

const m = await import('../chain-l2/onchain.mjs');

afterAll(() => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ERC-20 and PeerPools selectors, signatures in the comments.
const SEL_DECIMALS = '0x313ce567'; //     decimals()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SEL_BALANCE_OF = '0x70a08231'; //   balanceOf(address)
const SEL_POOL_COUNT = '0xf525cb68'; //   poolCount()
const SEL_POOL_INFO = '0x1526fe27'; //    poolInfo(uint256)
const SEL_SHARES_OF = '0xe78307ca'; //    sharesOf(uint256,address)
const SEL_PEER = '0x11cda415'; //         peer()
const SEL_BTC = '0xa28d57d8'; //          btc()

/**
 * The PoolCreated topic0, written out here independently of the module so
 * that the two have to agree — this is the constant that decides whether the
 * host sees any pools at all, and a copy of it that is merely imported from
 * the code under test would assert nothing.
 *
 *   PoolCreated(uint256,bytes32,address,uint256,uint256)
 *
 * (`indexed` is not part of the hashed string.) Checked two ways when it was
 * written: a from-scratch Keccak-256 that also reproduces the canonical
 * ERC-20 Transfer topic and all eleven selectors in PeerPools.build.json,
 * and the compiled PeerPools bytecode itself under @ethereumjs/vm, whose
 * createPool log carries exactly this word in topics[0].
 */
const TOPIC_POOL_CREATED = '0xdbc17b6ce8216b142cb8dab25e6228bd0965d99cb4a9f8f2e45cd8e7df33df81';

/** One uint256 as a 32-byte hex word. */
const uint = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
/** An address as a 32-byte left-padded word. */
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** A utf-8 name as bytes32: hex pairs, right-padded with NULs like Solidity. */
const name32 = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');

// Reserves chosen past Number.MAX_SAFE_INTEGER on purpose: if anything on
// the path went through a float, these exact digit strings could not come
// back out.
const P0 = 123_456_789_012_345_678_901_234_567_890n;
const B0 = 5_000_000_123n;
const S0 = 785_674_201_318_331_045_678n;
const SUPPLY = 18_250_000n * 10n ** 18n;

type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };
/** A PoolCreated log as an endpoint would serve it: id and creator indexed,
 *  name and both opening amounts in the data words. */
const poolLog = (id: number, creator: string, nm: string, openPeer: bigint, openBtc: bigint): Log => ({
  address: POOLS,
  topics: [TOPIC_POOL_CREATED, '0x' + uint(id), '0x' + addrWord(creator)],
  data: '0x' + name32(nm) + uint(openPeer) + uint(openBtc),
  transactionHash: '0x' + uint(id).slice(0, 63) + 'f',
  blockNumber: '0x' + (1000 + id).toString(16),
});
/** The five static words poolInfo promises, in the contract's own order. */
const info5 = (nm: string, resPeer: bigint, resBtc: bigint, shares: bigint, creator: string) =>
  '0x' + name32(nm) + uint(resPeer) + uint(resBtc) + uint(shares) + addrWord(creator);

// The canned chain: exact (to, calldata) -> return hex, plus the log list
// eth_getLogs serves. Tests edit these to stage their scenario; the
// dispatcher refuses calls it has no answer for, so an unexpected eth_call
// fails the test instead of passing quietly.
let routes: Map<string, string>;
let logs: Log[] | Error;
let chainIdHex: string;
let seen: Array<{ to: string; data: string }>;
let logQueries: Array<Record<string, unknown>>;
/** The chain's head. eth_blockNumber answers it and the scan windows end at
 *  it, so a test stages a span simply by moving it. */
let headBlock: bigint;
/** Refuse any window starting at or past this block — how a mid-scan failure
 *  is staged without breaking the windows before it. */
let failLogsFrom: bigint | null;
const HEAD_DEFAULT = 2000n; // comfortably past every staged log below
const route = (to: string, data: string, result: string) =>
  routes.set(to.toLowerCase() + '|' + data.toLowerCase(), result);
/** A block number as the quantity an RPC speaks. */
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);

beforeEach(() => {
  routes = new Map();
  seen = [];
  logQueries = [];
  headBlock = HEAD_DEFAULT;
  failLogsFrom = null;
  // The scan's memory is per host, not per test: left in place it would let
  // one test's discoveries decide the next one's ranking. Every test that
  // wants persistence stages it explicitly, by calling tokenState twice.
  try { rmSync(SCAN_FILE, { force: true }); } catch { /* never existed */ }
  chainIdHex = '0x2105'; // 8453 — Base, the default the module expects
  route(TOKEN, SEL_DECIMALS, '0x' + uint(18));
  route(TOKEN, SEL_TOTAL_SUPPLY, '0x' + uint(SUPPLY));
  route(BTC, SEL_DECIMALS, '0x' + uint(8));
  route(POOLS, SEL_POOL_COUNT, '0x' + uint(2));
  // The factory names its own two tokens, and they agree with this host's env.
  route(POOLS, SEL_PEER, '0x' + addrWord(TOKEN));
  route(POOLS, SEL_BTC, '0x' + addrWord(BTC));
  route(POOLS, SEL_POOL_INFO + uint(0), info5('ember', P0, B0, S0, ALICE));
  route(POOLS, SEL_POOL_INFO + uint(1), info5('first pool', 2n * P0, 3n * B0, 5n * S0, BOB));
  logs = [poolLog(0, ALICE, 'ember', P0, B0), poolLog(1, BOB, 'first pool', 2n * P0, 3n * B0)];
});

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
  // The spawned host in the last describe block is a real process on
  // loopback; only the module-under-test's RPC calls are canned.
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url as string, init as RequestInit);
  const body = JSON.parse(init.body);
  let result: unknown;
  if (body.method === 'eth_chainId') {
    result = chainIdHex;
  } else if (body.method === 'eth_blockNumber') {
    result = hex(headBlock);
  } else if (body.method === 'eth_getLogs') {
    const q = body.params[0] as { fromBlock: string; toBlock: string };
    logQueries.push(q);
    if (logs instanceof Error) throw logs;
    if (failLogsFrom !== null && BigInt(q.fromBlock) >= failLogsFrom) throw new Error('this window was refused');
    // Serve only the logs inside the window asked for. An endpoint that
    // returned everything regardless of range would let a broken chunker
    // pass: the windows would be wrong and the results still complete.
    const from = BigInt(q.fromBlock), to = BigInt(q.toBlock);
    result = (logs as Log[]).filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
  } else if (body.method === 'eth_call') {
    const { to, data } = body.params[0];
    seen.push({ to, data });
    const hit = routes.get(String(to).toLowerCase() + '|' + String(data).toLowerCase());
    if (hit === undefined) throw new Error('unexpected eth_call: ' + to + ' ' + data);
    result = hit;
  } else {
    throw new Error('unexpected rpc method: ' + body.method);
  }
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
});

const poolInfoCalls = () => seen.filter((c) => c.data.startsWith(SEL_POOL_INFO));

describe('namedPools in tokenState()', () => {
  it('decodes both pools — five words including the creator, amounts as exact strings, deepest first', async () => {
    const st = await m.tokenState();
    expect(st.chainIdMatches).toBe(true);
    expect(st.totalSupplyRaw).toBe(SUPPLY.toString());
    const np = st.namedPools;
    expect(np.factory).toBe(POOLS);
    expect(np.total).toBe(2);
    expect(np.discovered).toBe(2);
    expect(np.returned).toBe(2);
    expect(np.truncated).toBe(false);
    expect(np.skipped).toBe(0);
    expect(np.unread).toBe(0);
    expect(np.peerDecimals).toBe(18);
    expect(np.btcDecimals).toBe(8);
    expect(np.pools).toHaveLength(2);
    // Ranked by BTC depth, so the SECOND pool created is the first listed.
    // Creation order is not a claim about anything and is not used as one.
    expect(np.pools.map((p: { id: number }) => p.id)).toEqual([1, 0]);
    expect(np.pools[1]).toEqual({
      id: 0,
      name: 'ember',
      nameRaw: '0x' + name32('ember'),
      resPeerRaw: P0.toString(),
      resBtcRaw: B0.toString(),
      totalSharesRaw: S0.toString(),
      creator: ALICE,
      openTx: poolLog(0, ALICE, 'ember', P0, B0).transactionHash,
    });
    expect(np.pools[0]).toEqual({
      id: 1,
      name: 'first pool', // utf-8 with a space — bytes32 does not care and neither may we
      nameRaw: '0x' + name32('first pool'),
      resPeerRaw: (2n * P0).toString(),
      resBtcRaw: (3n * B0).toString(),
      totalSharesRaw: (5n * S0).toString(),
      creator: BOB,
      openTx: poolLog(1, BOB, 'first pool', 2n * P0, 3n * B0).transactionHash,
    });
    // The padding NULs were stripped from the name and kept in the raw word.
    expect(np.pools[1].name.includes(' ')).toBe(false);
    expect(np.pools[1].nameRaw.endsWith('00')).toBe(true);
    expect(np.pools[1].nameRaw).toHaveLength(66);
  });

  it('asks eth_getLogs for exactly the factory and exactly the PoolCreated topic, in one window from block 0 by default', async () => {
    await m.tokenState();
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]).toEqual({
      address: POOLS,
      topics: [TOPIC_POOL_CREATED],
      fromBlock: '0x0',
      toBlock: hex(HEAD_DEFAULT),
    });
    // Never 'latest'. The head is pinned to a number once, up front, because
    // a moving toBlock means the blocks that arrive between two windows fall
    // into the gap between them and are scanned by neither.
    expect(logQueries.every((q) => q.toBlock !== 'latest')).toBe(true);
    // And poolInfo was read for the discovered ids only.
    expect(poolInfoCalls().map((c) => c.data)).toEqual([SEL_POOL_INFO + uint(0), SEL_POOL_INFO + uint(1)]);
  });

  it('a name using the full 32 bytes survives whole — no truncation, no phantom terminator', async () => {
    const full = 'the-full-thirty-two-byte-name-xx';
    expect(new TextEncoder().encode(full)).toHaveLength(32); // the premise of the test
    route(POOLS, SEL_POOL_COUNT, '0x' + uint(1));
    route(POOLS, SEL_POOL_INFO + uint(0), info5(full, P0, B0, S0, ALICE));
    logs = [poolLog(0, ALICE, full, P0, B0)];
    const st = await m.tokenState();
    expect(st.namedPools.pools).toHaveLength(1);
    expect(st.namedPools.pools[0].name).toBe(full);
    expect(st.namedPools.pools[0].nameRaw).toBe('0x' + name32(full));
  });

  it('falls back to btcDecimals 8 when the BTC side will not answer', async () => {
    route(BTC, SEL_DECIMALS, '0x'); // nothing there — word() reads null
    const st = await m.tokenState();
    expect(st.namedPools.btcDecimals).toBe(8);
    expect(st.namedPools.total).toBe(2); // and the pools still decoded
    expect(st.namedPools.pools).toHaveLength(2);
  });

  it('a factory that will not answer degrades to an error note and leaves the token report standing', async () => {
    routes.delete(POOLS.toLowerCase() + '|' + SEL_POOL_COUNT); // the dispatcher now refuses poolCount
    const st = await m.tokenState();
    expect(st.totalSupplyRaw).toBe(SUPPLY.toString()); // the token half is untouched
    expect(st.namedPools.factory).toBe(POOLS);
    expect(st.namedPools.error).toMatch(/could not read the pools factory/);
    expect(st.namedPools.pools).toBeUndefined();
  });
});

describe('discovery cannot be squatted — the 256-dust-pool attack', () => {
  /**
   * The hole this replaces, priced: createPool costs gas and a dust deposit,
   * so 256 of them is a few dollars on Base. Against a reader that walked
   * ids 0..255 that bought a permanent veto over what this host displays —
   * the operator's real pool opens at id 256 and is never listed again, with
   * no privileged function anywhere in PeerPools to undo it.
   */
  const DUST = 256;
  const REAL = DUST; // the operator's pool, opened after the flood
  const REAL_BTC = 900_000_000n; // 9 cbBTC against the squatters' 1 raw unit

  beforeEach(() => {
    route(POOLS, SEL_POOL_COUNT, '0x' + uint(DUST + 1));
    logs = [];
    for (let id = 0; id < DUST; id++) {
      (logs as Log[]).push(poolLog(id, BOB, 'squat' + id, 1000n, 1n));
      route(POOLS, SEL_POOL_INFO + uint(id), info5('squat' + id, 1000n, 1n, 31n, BOB));
    }
    (logs as Log[]).push(poolLog(REAL, ALICE, 'main', P0, REAL_BTC));
    route(POOLS, SEL_POOL_INFO + uint(REAL), info5('main', P0, REAL_BTC, S0, ALICE));
  });

  it('returns the operator’s pool FIRST although 256 dust pools hold every id in front of it', async () => {
    const st = await m.tokenState();
    const np = st.namedPools;
    expect(np.pools[0].id).toBe(REAL);
    expect(np.pools[0].name).toBe('main');
    expect(np.pools[0].creator).toBe(ALICE);
    expect(np.pools[0].resBtcRaw).toBe(REAL_BTC.toString());
    // Everything else in the list is a squatter, and they are all below it.
    expect(np.pools.slice(1).every((p: { resBtcRaw: string }) => BigInt(p.resBtcRaw) < REAL_BTC)).toBe(true);
  });

  it('says out loud that it is showing 32 of 257, and how the rest went missing', async () => {
    const st = await m.tokenState();
    const np = st.namedPools;
    expect(np.total).toBe(DUST + 1); // the factory's own poolCount(), never a guess
    expect(np.discovered).toBe(DUST + 1); // every one was SEEN
    expect(np.returned).toBe(32); // LIST_CAP — a list nobody scrolls is not a feature
    expect(np.pools).toHaveLength(32);
    expect(np.truncated).toBe(true);
    expect(np.unread).toBe(DUST + 1 - 64); // READ_CAP: 193 seen but not read this round
    expect(np.skipped).toBe(0);
    expect(np.note).toMatch(/showing 32 of 257/);
    expect(np.note).toMatch(/193 were seen but not read/);
  });

  it('spends at most READ_CAP eth_calls doing it — the cap is real, not aspirational', async () => {
    await m.tokenState();
    expect(poolInfoCalls()).toHaveLength(64);
    // And the read budget did not go to ids 0..63. On a cold host nothing
    // has been measured yet, so the pre-filter falls back to most-recently
    // opened — which cannot be forged retroactively, whatever the squatters
    // spent — and the operator's pool, opened last, is inside the budget.
    expect(poolInfoCalls().some((c) => c.data === SEL_POOL_INFO + uint(REAL))).toBe(true);
    expect(poolInfoCalls().some((c) => c.data === SEL_POOL_INFO + uint(0))).toBe(false);
  });
});

describe('what the reader will not pretend to know', () => {
  it('counts a four-word poolInfo as unread rather than half-decoding it', async () => {
    // The pre-creator shape. Anything answering it is not the factory this
    // reader was written against, and a silent `continue` here is how a
    // partial list becomes an authoritative-looking one.
    route(POOLS, SEL_POOL_INFO + uint(1), '0x' + name32('old') + uint(P0) + uint(B0) + uint(S0));
    const st = await m.tokenState();
    const np = st.namedPools;
    expect(np.pools).toHaveLength(1);
    expect(np.pools[0].id).toBe(0);
    expect(np.skipped).toBe(1);
    expect(np.total).toBe(2);
    expect(np.returned).toBe(1);
    expect(np.truncated).toBe(true);
    expect(np.note).toMatch(/1 would not answer poolInfo/);
  });

  it('reports creator null when the fifth word is not a left-padded address', async () => {
    // Slicing the low 20 bytes off whatever came back would invent an
    // account that is not there and print it as provenance.
    route(POOLS, SEL_POOL_INFO + uint(0), '0x' + name32('ember') + uint(P0) + uint(B0) + uint(S0) + 'f'.repeat(64));
    const st = await m.tokenState();
    const p = st.namedPools.pools.find((x: { id: number }) => x.id === 0);
    expect(p.creator).toBe(null);
    expect(p.resPeerRaw).toBe(P0.toString()); // the reserves are still real
  });

  it('does not report an address that answers nothing as an empty factory', async () => {
    // An empty factory invites a first deposit; a wrong address must not.
    // The old shape turned a `0x` answer into count 0 and an empty list,
    // which is the same JSON a live, unused factory produces.
    route(POOLS, SEL_POOL_COUNT, '0x');
    const np = (await m.tokenState()).namedPools;
    expect(np.error).toMatch(/not a PeerPools factory/);
    expect(np.pools).toBeUndefined();
    expect(np.total).toBeUndefined();
  });

  it('says when the factory would not name its own tokens, instead of letting env pass for confirmed', async () => {
    route(POOLS, SEL_PEER, '0x');
    route(POOLS, SEL_BTC, '0x');
    const np = (await m.tokenState()).namedPools;
    expect(np.tokens).toEqual({ peer: null, btc: null });
    expect(np.tokensNote).toMatch(/nothing to check them against/);
    expect(np.mismatch).toBeUndefined(); // nothing to compare, so nothing is claimed
    expect(np.peerDecimals).toBe(18); // the env addresses, stated as such
    expect(np.btcDecimals).toBe(8);
    expect(np.pools).toHaveLength(2);
  });

  it('refuses to fall back to the id walk when every window is rejected, and names the fix', async () => {
    // An endpoint that refuses outright, with nothing remembered from a
    // previous refresh to fall back on. The tempting fallback is exactly the
    // censorable path this replaced, so there is none — and an empty list is
    // not offered in its place either.
    logs = new Error('endpoint refused');
    const st = await m.tokenState();
    const np = st.namedPools;
    expect(np.error).toMatch(/PEER_POOLS_FROM_BLOCK/);
    expect(np.error).toMatch(/will not fall back to walking pool ids/);
    // And it no longer blames a range width it has stopped asking for.
    expect(np.error).toMatch(/asks in 9999-block windows/);
    expect(np.total).toBe(2); // still reported: there ARE pools, unseen from here
    expect(np.pools).toBeUndefined();
    expect(poolInfoCalls()).toHaveLength(0);
  });

  it('scans from PEER_POOLS_FROM_BLOCK when set, and says so when the value is unusable', async () => {
    headBlock = 1_240_000n; // a head the configured from-block is actually behind
    process.env.PEER_POOLS_FROM_BLOCK = '1234567';
    vi.resetModules();
    const m2 = await import('../chain-l2/onchain.mjs');
    const st = await m2.tokenState();
    expect(logQueries[0]!.fromBlock).toBe('0x12d687'); // decimal in, quantity out
    expect(st.namedPools.fromBlock).toBe('0x12d687');

    process.env.PEER_POOLS_FROM_BLOCK = 'the block before last';
    vi.resetModules();
    const m3 = await import('../chain-l2/onchain.mjs');
    const st3 = await m3.tokenState();
    expect(st3.namedPools.fromBlockIgnored).toBe('the block before last');
    expect(st3.namedPools.fromBlock).toBe('0x0'); // guessed at, never
    // From block 0 to this head is 124 windows and the refresh budget is 24,
    // so it stops and SAYS it stopped rather than looking finished.
    expect(st3.namedPools.scan.windows).toBe(24);
    expect(st3.namedPools.scan.complete).toBe(false);
    expect(st3.namedPools.scan.backfill).toMatch(/blocks of history are still unwalked/);
    delete process.env.PEER_POOLS_FROM_BLOCK;
    vi.resetModules();
  });
});

/**
 * The scan, chunked and remembering.
 *
 * The bug this replaces had a clock on it. namedPools issued ONE eth_getLogs
 * from the deploy block to 'latest', and mainnet.base.org answers a span of
 * 9,999 blocks and refuses 10,000 outright. Base makes a block every two
 * seconds, so an operator who set PEER_POOLS_FROM_BLOCK correctly watched the
 * list render, and 5h34m later every refresh threw — with an error telling
 * them to set the variable they had already set, and whose only other remedy,
 * moving the from-block forward, permanently hides pools opened before it.
 */
describe('the log scan is chunked, and it remembers', () => {
  it('walks a 25,000-block span in three windows, none of them wider than 9,999', async () => {
    headBlock = 25_000n;
    const np = (await m.tokenState()).namedPools;
    expect(logQueries).toHaveLength(3);
    for (const q of logQueries) {
      const span = BigInt(q.toBlock as string) - BigInt(q.fromBlock as string) + 1n;
      expect(span <= 9999n).toBe(true);
    }
    // Contiguous and gapless: each window starts exactly where the last ended.
    expect(logQueries.map((q) => q.fromBlock)).toEqual([hex(0), hex(9999), hex(19998)]);
    expect(logQueries[2]!.toBlock).toBe(hex(25_000));
    expect(np.scan.windowSpan).toBe(9999);
    expect(np.scan.windows).toBe(3);
    expect(np.scan.complete).toBe(true);
    // And the pools inside the FIRST window are still all there: the chunking
    // is not just a shape, it has to actually find things.
    expect(np.discovered).toBe(2);
    expect(np.pools).toHaveLength(2);
  });

  it('keeps the ids a refused window did not cost it, and says which window was refused', async () => {
    headBlock = 25_000n;
    failLogsFrom = 9999n; // the second window and everything after it
    const np = (await m.tokenState()).namedPools;
    // The two pools found before the refusal are still listed. Throwing them
    // away — which is what one unchunked query did on any failure — is how a
    // live factory renders as an empty network.
    expect(np.error).toBeUndefined();
    expect(np.pools.map((p: { id: number }) => p.id)).toEqual([1, 0]);
    expect(np.scan.windows).toBe(1);
    expect(np.scan.failed).toBe(1);
    expect(np.scan.failedAt).toBe(hex(9999) + '..' + hex(19_997));
    expect(np.scan.failedWhy).toMatch(/refused/);
    expect(np.scan.complete).toBe(false);
    expect(np.scan.behind).toBe(15_002);
    // Partial, and it says so where a UI will read it.
    expect(np.note).toMatch(/was refused/);

    // The cursor stopped at the end of the last GOOD window, so the next
    // refresh retries the refused one rather than skipping past it — a
    // skipped window is a hole no later scan would ever revisit.
    logQueries = [];
    failLogsFrom = null;
    const np2 = (await m.tokenState()).namedPools;
    expect(logQueries[0]!.fromBlock).toBe(hex(9998n - 64n + 1n));
    expect(np2.scan.failed).toBe(0);
    expect(np2.scan.complete).toBe(true);
    expect(np2.pools).toHaveLength(2);
  });

  it('scans only the new tail on the second refresh, and keeps what the first one found', async () => {
    headBlock = 25_000n;
    const first = (await m.tokenState()).namedPools;
    expect(logQueries).toHaveLength(3);
    expect(first.scan.cursor).toBe(hex(25_000));
    expect(first.scan.remembering).toBe(2);

    // A hundred blocks later. Without the persisted cursor this is three
    // windows again, and four the hour after that, and so on without bound.
    logQueries = [];
    headBlock = 25_100n;
    const np = (await m.tokenState()).namedPools;
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]!.fromBlock).toBe(hex(25_000n - 64n + 1n)); // one reorg rewind back
    expect(logQueries[0]!.toBlock).toBe(hex(25_100));
    expect(np.scan.complete).toBe(true);
    // That tail window contains no PoolCreated logs at all, and both pools
    // are still here — they came out of the scan's memory, not the endpoint.
    expect(np.discovered).toBe(2);
    expect(np.pools).toHaveLength(2);
    expect(np.pools[0].name).toBe('first pool');
  });
});

/**
 * Depth means depth NOW.
 *
 * The pre-filter that chooses which pools are worth an eth_call used to rank
 * candidates by the opening deposit carried in the PoolCreated log. That is a
 * number an attacker deposits and withdraws inside one block: open sixty-four
 * pools rich, drain them, and the log says forever that you hold the deepest
 * liquidity on the factory. It bought the same burial the id walk did — the
 * exact property this module advertises, inverted — for the price of the gas.
 */
describe('the rank key cannot be wash-traded', () => {
  it('puts a smaller live pool above a whale that was opened rich and drained', async () => {
    logs = [
      poolLog(0, ALICE, 'whale', P0, 90n * 10n ** 8n), // opened with 90 cbBTC
      poolLog(1, BOB, 'small', 1000n, 500n),           // opened with 500 raw units
    ];
    route(POOLS, SEL_POOL_INFO + uint(0), info5('whale', 0n, 1n, S0, ALICE));   // since drained
    route(POOLS, SEL_POOL_INFO + uint(1), info5('small', 1000n, 500n, S0, BOB)); // still holds
    const np = (await m.tokenState()).namedPools;
    expect(np.pools.map((p: { id: number }) => p.id)).toEqual([1, 0]);
    expect(np.pools[0].resBtcRaw).toBe('500');
    expect(np.rankedBy).toMatch(/right now/);
  });

  describe('300 pools opened rich and drained, in front of one real one', () => {
    const WHALES = 300;
    const REAL_ID = WHALES;
    const REAL_BTC = 900_000_000n;
    const OPENED_BIG = 500n * 10n ** 8n;

    beforeEach(() => {
      route(POOLS, SEL_POOL_COUNT, '0x' + uint(WHALES + 1));
      logs = [];
      for (let id = 0; id < WHALES; id++) {
        (logs as Log[]).push(poolLog(id, BOB, 'whale' + id, P0, OPENED_BIG));
        route(POOLS, SEL_POOL_INFO + uint(id), info5('whale' + id, 0n, 1n, 31n, BOB));
      }
      // The operator's pool opens with almost nothing and then holds it.
      (logs as Log[]).push(poolLog(REAL_ID, ALICE, 'main', P0, 1n));
      route(POOLS, SEL_POOL_INFO + uint(REAL_ID), info5('main', P0, REAL_BTC, S0, ALICE));
    });

    it('does not spend the read budget on the biggest openers, and lists the real pool first', async () => {
      const np = (await m.tokenState()).namedPools;
      expect(poolInfoCalls()).toHaveLength(64);
      expect(poolInfoCalls().some((c) => c.data === SEL_POOL_INFO + uint(REAL_ID))).toBe(true);
      // Under the old key every one of the 300 whales outranked the real
      // pool, so ids 0..63 took the whole budget and 'main' was never read.
      expect(poolInfoCalls().some((c) => c.data === SEL_POOL_INFO + uint(0))).toBe(false);
      expect(np.pools[0].id).toBe(REAL_ID);
      expect(np.pools[0].name).toBe('main');
      expect(np.pools[0].creator).toBe(ALICE);
      expect(np.unread).toBe(WHALES + 1 - 64);
      expect(np.preFilteredBy).toMatch(/most-recently-opened/);
      expect(np.preFilteredBy).toMatch(/Opening amounts are not consulted/);
    });

    it('keeps a pool that was MEASURED deep even when 64 newer pools arrive on top of it', async () => {
      // The first refresh measures the real pool. Most-recently-opened alone
      // would lose it the moment a flood of newer ids shows up — this is the
      // half of the pre-filter an attacker cannot buy, and the reason a cap
      // on reads is survivable at all.
      await m.tokenState();
      const fresh = 64;
      for (let k = 1; k <= fresh; k++) {
        const id = WHALES + k;
        (logs as Log[]).push({ ...poolLog(id, BOB, 'flood' + id, P0, OPENED_BIG), blockNumber: hex(2001 + id) });
        route(POOLS, SEL_POOL_INFO + uint(id), info5('flood' + id, 0n, 1n, 31n, BOB));
      }
      route(POOLS, SEL_POOL_COUNT, '0x' + uint(WHALES + 1 + fresh));
      headBlock = 2500n;
      seen = [];
      const np = (await m.tokenState()).namedPools;
      expect(poolInfoCalls().some((c) => c.data === SEL_POOL_INFO + uint(REAL_ID))).toBe(true);
      expect(np.pools[0].id).toBe(REAL_ID);
      expect(np.pools[0].resBtcRaw).toBe(REAL_BTC.toString());
      expect(np.preFilteredBy).toMatch(/bitcoin reserve each was last measured at/);
    });
  });
});

describe('the factory’s tokens are the factory’s to name', () => {
  const OTHER_PEER = '0x' + 'de'.repeat(20);
  const OTHER_BTC = '0x' + 'ad'.repeat(20);

  it('reports a mismatch naming both addresses, and scales by the factory’s', async () => {
    // The failure that looks like success: a host configured for one pair,
    // pointed at a factory trading another. Every amount displayed would be
    // scaled by the wrong decimals while nothing anywhere said so.
    route(POOLS, SEL_PEER, '0x' + addrWord(OTHER_PEER));
    route(POOLS, SEL_BTC, '0x' + addrWord(OTHER_BTC));
    route(OTHER_PEER, SEL_DECIMALS, '0x' + uint(6));
    route(OTHER_BTC, SEL_DECIMALS, '0x' + uint(18));
    const np = (await m.tokenState()).namedPools;
    expect(np.tokens).toEqual({ peer: OTHER_PEER, btc: OTHER_BTC });
    expect(np.mismatch.pairs).toEqual([
      { side: 'peer', factory: OTHER_PEER, configured: TOKEN },
      { side: 'btc', factory: OTHER_BTC, configured: BTC },
    ]);
    expect(np.mismatch.error).toMatch(/PEER_TOKEN_ADDR/);
    // Neither address wins by default; the one the signed trade actually
    // moves coins in wins, and the field above says which that was.
    expect(np.peerDecimals).toBe(6);
    expect(np.btcDecimals).toBe(18);
    expect(np.pools).toHaveLength(2); // and the pools are still listed
  });

  it('says nothing about a mismatch when the factory agrees with the env', async () => {
    const np = (await m.tokenState()).namedPools;
    expect(np.mismatch).toBeUndefined();
    expect(np.tokens).toEqual({ peer: TOKEN, btc: BTC });
    // The factory names the same PEER, so its decimals are not asked twice.
    expect(seen.filter((c) => c.to.toLowerCase() === TOKEN && c.data === SEL_DECIMALS)).toHaveLength(1);
  });
});

describe('nothing answers off the wrong chain', () => {
  beforeEach(() => {
    chainIdHex = '0x1'; // ethereum mainnet, not the Base this host claims
  });

  it('tokenState refuses before it reads a single number', async () => {
    const st = await m.tokenState();
    expect(st.chainIdMatches).toBe(false);
    expect(st.error).toMatch(/refusing to report its numbers/);
    expect(st.totalSupplyRaw).toBeUndefined();
    expect(st.namedPools).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('balanceOf returns the refusal instead of a balance, and does not call the token', async () => {
    // The bug: one body said "refusing to report its numbers as this
    // network's" and carried an account balance read off that same endpoint.
    // A refusal with a number under it is not a refusal.
    const r = await m.balanceOf(WHO);
    expect(r.chainIdMatches).toBe(false);
    expect(r.chainIdSeen).toBe(1);
    expect(r.error).toMatch(/refusing to report its numbers/);
    expect(r.raw).toBeUndefined();
    expect(r.amount).toBeUndefined();
    expect(seen.filter((c) => c.data.startsWith(SEL_BALANCE_OF))).toHaveLength(0);
  });

  it('sharesOf refuses on the same terms', async () => {
    const r = await m.sharesOf(1, WHO);
    expect(r.chainIdMatches).toBe(false);
    expect(r.error).toMatch(/refusing to report its numbers/);
    expect(r.raw).toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

describe('balanceOf and sharesOf on the right chain', () => {
  it('sends selector + uint256 word + padded address, and returns the raw share count as a string', async () => {
    const shares = 40_000_000_000_000_000_123n; // past 2^53, like everything else here
    route(POOLS, SEL_SHARES_OF + uint(1) + addrWord(WHO), '0x' + uint(shares));
    const r = await m.sharesOf(1, WHO);
    expect(r).toEqual({ poolId: 1, address: WHO, raw: shares.toString() });
    // The wire bytes, verbatim — with no ABI library the encoding is the
    // whole contract with the chain, so it is asserted literally.
    const sent = seen.find((c) => c.data.startsWith(SEL_SHARES_OF));
    expect(sent?.to).toBe(POOLS);
    expect(sent?.data).toBe(SEL_SHARES_OF + uint(1) + addrWord(WHO));
  });

  it('refuses garbage without touching the chain: bad address, fractional or negative id', async () => {
    expect(await m.sharesOf(0, 'not-an-address')).toBe(null);
    expect(await m.sharesOf(1.5, WHO)).toBe(null);
    expect(await m.sharesOf(-1, WHO)).toBe(null);
    expect(seen).toHaveLength(0);
  });

  it('reads a PEER balance with its decimals', async () => {
    route(TOKEN, SEL_BALANCE_OF + addrWord(WHO), '0x' + uint(42n * 10n ** 18n));
    const r = await m.balanceOf(WHO);
    expect(r).toEqual({ address: WHO, raw: (42n * 10n ** 18n).toString(), amount: 42, decimals: 18 });
  });
});

/**
 * The last two properties live in the request path, not in the reader, so
 * they are exercised against a real host process talking to a fake JSON-RPC
 * endpoint that counts what it is asked.
 */
describe('GET /api/token/onchain — one refresh however many tabs', () => {
  const PORT = 5327;
  const RPC_PORT = 5328;
  const WRONG_PORT = 5329;
  const ROOT = resolve(__dirname, '..');
  const BASE = `http://127.0.0.1:${PORT}`;
  const WRONG = `http://127.0.0.1:${WRONG_PORT}`;

  let rpc: Server;
  let host: ChildProcess;
  let wrongHost: ChildProcess;
  let dir: string;
  let calls: string[] = [];

  /** The same canned chain as above, served over real HTTP to a real host. */
  const answer = (method: string, params: any[]): unknown => {
    if (method === 'eth_chainId') return '0x2105';
    // A head just past the staged log, so the whole history is one window and
    // "one refresh" stays a countable number of eth_getLogs.
    if (method === 'eth_blockNumber') return hex(1500);
    if (method === 'eth_getLogs') return [poolLog(0, ALICE, 'ember', P0, B0)];
    if (method === 'eth_call') {
      const to = String(params[0].to).toLowerCase();
      const data = String(params[0].data).toLowerCase();
      if (to === TOKEN && data === SEL_DECIMALS) return '0x' + uint(18);
      if (to === TOKEN && data === SEL_TOTAL_SUPPLY) return '0x' + uint(SUPPLY);
      if (to === TOKEN && data.startsWith(SEL_BALANCE_OF)) return '0x' + uint(7n * 10n ** 18n);
      if (to === BTC && data === SEL_DECIMALS) return '0x' + uint(8);
      if (to === POOLS && data === SEL_POOL_COUNT) return '0x' + uint(1);
      if (to === POOLS && data === SEL_PEER) return '0x' + addrWord(TOKEN);
      if (to === POOLS && data === SEL_BTC) return '0x' + addrWord(BTC);
      if (to === POOLS && data === SEL_POOL_INFO + uint(0)) return info5('ember', P0, B0, S0, ALICE);
    }
    throw new Error('unexpected ' + method + ' ' + JSON.stringify(params));
  };

  const spawnHost = (port: number, extraEnv: Record<string, string>) =>
    spawn(process.execPath, [join(ROOT, 'server.mjs'), String(port)], {
      cwd: ROOT,
      env: {
        ...process.env,
        PEER_DATA_DIR: join(dir, 'server-data'),
        PEER_L2_RPC: `http://127.0.0.1:${RPC_PORT}`,
        PEER_TOKEN_ADDR: TOKEN,
        PEER_BTC_ADDR: BTC,
        PEER_POOLS_ADDR: POOLS,
        ...extraEnv,
      },
      stdio: 'ignore',
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-onchain-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    writeFileSync(
      join(dir, 'server-data', 'acts.jsonl'),
      JSON.stringify({ t: 'register', id: 'u_a', handle: 'A', seed: 1, epoch: 0 }) + '\n',
    );
    rpc = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        calls.push(body.method);
        let out: Record<string, unknown>;
        try {
          out = { jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) };
        } catch (e) {
          out = { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: String((e as Error).message) } };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => rpc.listen(RPC_PORT, '127.0.0.1', r));
    host = spawnHost(PORT, {});
    // The same fake chain, but this host insists it is on chain 1. Its own
    // process because the 30-second cache is per host and a refusal must be
    // observed cold.
    wrongHost = spawnHost(WRONG_PORT, { PEER_L2_CHAIN_ID: '1' });
    for (const base of [BASE, WRONG]) {
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        try { await realFetch(base + '/api/acts'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      if (!up) throw new Error('host did not come up: ' + base);
    }
    calls = [];
  }, 30_000);

  afterAll(async () => {
    host?.kill();
    wrongHost?.kill();
    await new Promise<void>((r) => rpc.close(() => r()));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('collapses a cold-cache burst into a single round of RPC calls', async () => {
    // Twenty tabs opening at once used to be twenty full rounds — a pool
    // scan each — because every one of them checked the cache before any of
    // them had filled it. eth_chainId is asked exactly once per refresh, so
    // counting it counts refreshes.
    const rs = await Promise.all(Array.from({ length: 20 }, () => realFetch(BASE + '/api/token/onchain')));
    const bodies = await Promise.all(rs.map((r) => r.json() as Promise<Record<string, any>>));
    for (const b of bodies) {
      expect(b.deployed).toBe(true);
      expect(b.namedPools.pools[0].name).toBe('ember');
      expect(b.namedPools.pools[0].creator).toBe(ALICE);
    }
    expect(calls.filter((c) => c === 'eth_chainId')).toHaveLength(1);
    expect(calls.filter((c) => c === 'eth_getLogs')).toHaveLength(1);

    // And the next request inside the window costs nothing at all.
    const before = calls.length;
    await realFetch(BASE + '/api/token/onchain');
    expect(calls.length).toBe(before);
  }, 20_000);

  it('does not attach an account balance underneath its own wrong-chain refusal', async () => {
    calls = [];
    const r = await realFetch(WRONG + '/api/token/onchain?of=' + WHO);
    const b = (await r.json()) as Record<string, any>;
    expect(b.chainIdMatches).toBe(false);
    expect(b.error).toMatch(/refusing to report its numbers/);
    expect(b.account.read).toBe(false);
    expect(b.account.error).toMatch(/not read/);
    // The point of the whole fix: no number anywhere in the body.
    expect(b.account.raw).toBeUndefined();
    expect(b.account.amount).toBeUndefined();
    expect(b.totalSupplyRaw).toBeUndefined();
    // And the refused endpoint was never asked for a balance.
    expect(calls.filter((c) => c === 'eth_call')).toHaveLength(0);
  }, 20_000);
});

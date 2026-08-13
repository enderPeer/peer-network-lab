/**
 * The pool path in chain-l2/onchain.mjs, exercised without a chain: global
 * fetch is replaced by a dispatcher answering exactly the JSON-RPC calls
 * tokenState() is expected to make, from canned hex.
 *
 * This file replaces a much longer one, and what it stopped testing is the
 * point of the change. There used to be a FACTORY holding many named pools,
 * and this suite held down the defences that required: pools discovered from
 * PoolCreated logs rather than by walking ids (walking them was censorable for
 * pocket change — 256 dust pools and the operator's real pool is never listed
 * again); a chunked, resumable, cursor-persisting log scan, because one
 * eth_getLogs from a deploy block dies the moment the range passes 10,000
 * blocks; a pre-filter ranking candidates by measured depth, because ranking
 * by the opening deposit in the log is forgeable by depositing and withdrawing
 * in the same block; and four counters (total, discovered, returned, unread)
 * disclosing every cap, because a cap you cannot see is indistinguishable from
 * censorship.
 *
 * ONE pool at ONE address needs none of it, and the first test below asserts
 * exactly that: the reader issues no eth_getLogs at all. That is the whole
 * claim of the redesign expressed as a number, and it is the assertion most
 * likely to catch the machinery quietly coming back.
 *
 * What is still worth defending, and is:
 *
 * - reserves() answers THREE static words — resPeer, resBtc, totalShares —
 *   cut by offset, and a short answer is reported as a pool this host could
 *   not read rather than half-decoded;
 * - THE PAIR THE AMOUNTS ARE SCALED BY IS THE POOL'S OWN. The card signs
 *   against peer() and btc() read off the pool, so the decimals have to come
 *   from those same two contracts and not from this host's configuration. The
 *   deleted factory suite pinned exactly this and it was never the factory's
 *   property; for one release the check was gone and the card displayed one
 *   market while signing against another. The devnet cannot surface it — it
 *   points PEER_BTC_ADDR at the very token the pool was deployed against — so
 *   this is the only place a DISAGREEING pair is ever put in front of the
 *   reader;
 * - a pool whose bitcoin side is not this host's cbBTC is refused a price even
 *   when it answers 8 decimals, because "8 decimals" identifies no coin: the
 *   contract has no imports and anybody may deploy their own over the real
 *   PEER and a token they minted themselves;
 * - the code at the pool address is compared against PeerPool.build.json, with
 *   the ten immutable words masked and the metadata trailer stripped, so
 *   "the address IS the identity" is checkable rather than asserted;
 * - "nothing answered" and "nobody has seeded it" are different sentences. A
 *   live unseeded pool invites the first deposit, which is the deposit that
 *   sets the opening price; a wrong address must never say the same thing;
 * - reserves and shares stay raw integer strings end to end, including values
 *   past Number.MAX_SAFE_INTEGER where a float would already have rounded;
 * - no exported reader answers off the wrong chain — not tokenState, not
 *   balanceOf, not sharesOf;
 * - sharesOf takes an address and nothing else. The pool id that used to sit
 *   in front of it in the calldata is gone with the factory, and the wire
 *   bytes are asserted literally because with no ABI library the encoding IS
 *   the contract with the chain.
 *
 * The last block runs a real host process against a fake JSON-RPC endpoint,
 * because the 30-second cache and the ?of= composition only exist in the
 * request path: a burst of cold-cache requests must cost ONE round of RPC
 * calls, a refused chain must not attach a balance underneath its own
 * refusal, and one viewer's share count must never enter the shared cache.
 *
 * The selectors here are hardcoded with their signatures like everywhere else
 * in the repo; one-pool.test.ts already proves they agree with the compiler's
 * methodIdentifiers table in PeerPool.build.json.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOKEN = '0x' + '11'.repeat(20);
const POOL = '0x' + '22'.repeat(20);
const BTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // cbBTC on Base
const WHO = '0x' + 'ab'.repeat(20);
/** Somebody else's 8-decimal token. Nothing about it is malformed. */
const IMPOSTOR_BTC = '0x' + '77'.repeat(20);

// The compiled pool, because the reader now compares eth_getCode against it.
const poolBuild = JSON.parse(readFileSync(new URL('../chain-l2/PeerPool.build.json', import.meta.url), 'utf8'));

/**
 * The runtime code a REAL deployment answers with: the artifact, but with the
 * ten immutable words filled in — solc leaves them zero and the constructor
 * writes them. Filled here with a value that is not an address and not zero,
 * on purpose: the check must be passing because it MASKS those ranges, not
 * because the test happened to write the bytes it expected.
 */
function deployedCode(fill = 'ab') {
  const chars = poolBuild.deployed.object.replace(/^0x/, '').split('');
  for (const r of poolBuild.deployed.immutables) {
    for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) chars[i] = fill[(i - r.start * 2) % fill.length];
  }
  return '0x' + chars.join('');
}

// Env must be in place BEFORE the module loads: onchain.mjs reads it once at
// import time, which is why this import is dynamic and sits below.
//
// PEER_DATA_DIR is a throwaway even though the pool writes no scan file at
// all — the epoch and burn scans still do, and a suite that wrote into the
// developer's real server-data would be editing the live host's memory to
// make its own assertions pass.
const DATA_TMP = mkdtempSync(join(tmpdir(), 'peer-onchain-pool-'));
process.env.PEER_DATA_DIR = DATA_TMP;
process.env.PEER_TOKEN_ADDR = TOKEN;
process.env.PEER_BTC_ADDR = BTC;
process.env.PEER_POOL_ADDR = POOL;
delete process.env.PEER_L2_RPC; // default RPC; fetch is stubbed, nothing leaves
delete process.env.PEER_L2_CHAIN_ID;
delete process.env.PEER_ANCHOR_ADDR;
delete process.env.PEER_CLAIM_ADDR;

const m = await import('../chain-l2/onchain.mjs');

afterAll(() => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ERC-20 and PeerPool selectors, signatures in the comments.
const SEL_DECIMALS = '0x313ce567'; //     decimals()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SEL_BALANCE_OF = '0x70a08231'; //   balanceOf(address)
const SEL_RESERVES = '0x75172a8b'; //     reserves()
const SEL_SHARES_OF = '0xf5eb42dc'; //    sharesOf(address)
const SEL_POOL_PEER = '0x11cda415'; //    peer()
const SEL_POOL_BTC = '0xa28d57d8'; //     btc()

/** One uint256 as a 32-byte hex word. */
const uint = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
/** An address as a 32-byte left-padded word. */
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// Reserves chosen past Number.MAX_SAFE_INTEGER on purpose: if anything on the
// path went through a float, these exact digit strings could not come back.
const P0 = 123_456_789_012_345_678_901_234_567_890n;
const B0 = 5_000_000_123n;
const S0 = 785_674_201_318_331_045_678n;
const SUPPLY = 18_250_000n * 10n ** 18n;

/** The three static words reserves() promises, in the contract's own order. */
const reserves3 = (resPeer: bigint, resBtc: bigint, shares: bigint) =>
  '0x' + uint(resPeer) + uint(resBtc) + uint(shares);

// The canned chain: exact (to, calldata) -> return hex. Tests edit this to
// stage their scenario; the dispatcher refuses calls it has no answer for, so
// an unexpected eth_call fails the test instead of passing quietly.
let routes: Map<string, string>;
let chainIdHex: string;
let seen: Array<{ to: string; data: string }>;
/** eth_getCode answers, by address. The reader asks once, for the pool. */
let codeAt: Map<string, string>;
/** Every JSON-RPC method the reader asked for, in order. The first test reads
 *  this rather than a call count: what matters is that certain methods are
 *  never sent at all. */
let methods: string[];
const route = (to: string, data: string, result: string) =>
  routes.set(to.toLowerCase() + '|' + data.toLowerCase(), result);

/** The honest world: the pool names the configured pair and carries this
 *  repository's code. Tests that are about a DISAGREEING pair edit it. */
beforeEach(() => {
  routes = new Map();
  codeAt = new Map();
  seen = [];
  methods = [];
  chainIdHex = '0x2105'; // 8453 — Base, the default the module expects
  route(TOKEN, SEL_DECIMALS, '0x' + uint(18));
  route(TOKEN, SEL_TOTAL_SUPPLY, '0x' + uint(SUPPLY));
  route(BTC, SEL_DECIMALS, '0x' + uint(8));
  route(POOL, SEL_RESERVES, reserves3(P0, B0, S0));
  route(POOL, SEL_POOL_PEER, '0x' + addrWord(TOKEN));
  route(POOL, SEL_POOL_BTC, '0x' + addrWord(BTC));
  codeAt.set(POOL, deployedCode());
});

/**
 * A fresh module instance, because checkPair MEMOISES: the pool's two tokens
 * are immutable on the contract, so asking again four times a minute would
 * spend the host's endpoint quota re-confirming something that cannot change.
 * A test staging a different pair therefore has to stage it before the first
 * question is asked, which means before the module exists.
 */
async function freshModule() {
  vi.resetModules();
  return import('../chain-l2/onchain.mjs');
}

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
  // The spawned host in the last describe block is a real process on
  // loopback; only the module-under-test's RPC calls are canned.
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url as string, init as RequestInit);
  const body = JSON.parse(init.body);
  methods.push(body.method);
  let result: unknown;
  if (body.method === 'eth_chainId') {
    result = chainIdHex;
  } else if (body.method === 'eth_getCode') {
    result = codeAt.get(String(body.params[0]).toLowerCase()) ?? '0x';
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

describe('the pool in tokenState()', () => {
  it('reads it with ONE eth_call and no log scan whatsoever', async () => {
    const st = await m.tokenState();
    expect(st.chainIdMatches).toBe(true);
    // The whole claim of one pool, as a number. Discovery cost a chunked,
    // resumable eth_getLogs walk with a persisted cursor and a per-refresh
    // window budget; an address costs one call. If eth_getLogs ever appears
    // here again, some form of enumeration has come back with it.
    expect(methods.filter((x) => x === 'eth_getLogs')).toHaveLength(0);
    // And no eth_blockNumber either: a scan needs a head to walk towards, a
    // single 'latest' call does not.
    expect(methods.filter((x) => x === 'eth_blockNumber')).toHaveLength(0);
    expect(seen.filter((c) => c.data === SEL_RESERVES)).toHaveLength(1);
    expect(seen.find((c) => c.data === SEL_RESERVES)?.to).toBe(POOL);
  });

  it('decodes three words as exact strings, and says it is seeded', async () => {
    const st = await m.tokenState();
    expect(st.totalSupplyRaw).toBe(SUPPLY.toString());
    expect(st.pool).toEqual({
      address: POOL,
      resPeerRaw: P0.toString(),
      resBtcRaw: B0.toString(),
      totalSharesRaw: S0.toString(),
      seeded: true,
      // The pool's OWN pair, named, so a reader of the endpoint can see which
      // two coins these reserves are counted in without trusting the host's
      // configuration to be the same thing.
      tokens: { peer: TOKEN, btc: BTC },
      decimals: { peer: 18, btc: 8 },
    });
    // Strings, not numbers: P0 is past 2^53 and a float would already have
    // rounded it before this assertion could run.
    expect(typeof st.pool.resPeerRaw).toBe('string');
    expect(st.pool.resPeerRaw).toBe('123456789012345678901234567890');
  });

  it('reports an unseeded pool as a real state, not as an error and not as zeros', async () => {
    // Three zero words is exactly what a freshly deployed PeerPool answers.
    // It is the one state from which the next deposit invents the opening
    // price, so it has to read as an invitation rather than as a fault.
    route(POOL, SEL_RESERVES, reserves3(0n, 0n, 0n));
    const st = await m.tokenState();
    expect(st.pool.error).toBeUndefined();
    expect(st.pool.seeded).toBe(false);
    expect(st.pool.resPeerRaw).toBe('0');
    expect(String(st.pool.note)).toMatch(/FIRST add sets the opening price/i);
    expect(String(st.pool.note)).toMatch(/every add after that is proportional/i);
  });

  it('does not report an address that answers nothing as an empty pool', async () => {
    // An empty pool invites a first deposit; a wrong address must not. These
    // are the two sentences the whole `seeded` flag exists to keep apart.
    route(POOL, SEL_RESERVES, '0x');
    const st = await m.tokenState();
    expect(st.totalSupplyRaw).toBe(SUPPLY.toString()); // the token half is untouched
    expect(st.pool.error).toMatch(/not a PeerPool/);
    expect(st.pool.error).toMatch(/not a pool with nothing in it/);
    expect(st.pool.seeded).toBeUndefined();
    expect(st.pool.resPeerRaw).toBeUndefined();
  });

  it('counts a two-word answer as unreadable rather than half-decoding it', async () => {
    route(POOL, SEL_RESERVES, '0x' + uint(P0) + uint(B0));
    const st = await m.tokenState();
    expect(st.pool.error).toMatch(/not a PeerPool/);
    expect(st.pool.totalSharesRaw).toBeUndefined();
  });

  it('says in words when no pool is configured, instead of leaving the key out', async () => {
    delete process.env.PEER_POOL_ADDR;
    vi.resetModules();
    const m2 = await import('../chain-l2/onchain.mjs');
    const st = await m2.tokenState();
    expect(st.pool.configured).toBe(false);
    expect(String(st.pool.why)).toMatch(/PEER_POOL_ADDR is unset/);
    // "this host reads no pool" and "the pool is empty" are opposite claims,
    // and an absent key would let an interface render either as the other.
    expect(st.pool.resPeerRaw).toBeUndefined();
    expect(seen.filter((c) => c.data === SEL_RESERVES)).toHaveLength(0);
    // …and the PEER door is off with it, because there is nothing to price
    // against. One address answers both questions.
    expect(m2.PEERBURN_ON).toBe(false);
    expect(m2.peerBurnConfig().missing).toEqual(['PEER_POOL_ADDR']);
    process.env.PEER_POOL_ADDR = POOL;
    vi.resetModules();
  });
});

/**
 * The check that went out with the factory and was never the factory's.
 *
 * Every approve, add and swap on the pools card targets peer() and btc() read
 * off the POOL. If the decimals come from anywhere else, the card scales its
 * amounts by one token's decimals and moves another's — off by a hundred
 * million between an 18-decimal coin and an 8-decimal one, while looking
 * perfectly ordinary. So the reader asks the pool, and says so when the answer
 * is not what this host was configured with.
 */
describe('the amounts are scaled by the POOL’s own pair', () => {
  it('takes the decimals from the pool’s tokens, not from PEER_BTC_ADDR', async () => {
    // A pool over the right PEER and somebody else's bitcoin stand-in, which
    // carries 18 decimals. Scaled by the CONFIGURED cbBTC this reads as 8 and
    // every bitcoin figure on the card is out by 10^10.
    route(POOL, SEL_POOL_BTC, '0x' + addrWord(IMPOSTOR_BTC));
    route(IMPOSTOR_BTC, SEL_DECIMALS, '0x' + uint(18));
    const m2 = await freshModule();
    const st = await m2.tokenState();
    expect(st.pool.tokens).toEqual({ peer: TOKEN, btc: IMPOSTOR_BTC });
    expect(st.pool.decimals).toEqual({ peer: 18, btc: 18 });
    // And it names both addresses rather than picking one: this module cannot
    // know which of the two the operator got wrong.
    expect(st.pool.mismatch.pairs).toEqual([{ side: 'btc', pool: IMPOSTOR_BTC, configured: BTC }]);
    expect(String(st.pool.mismatch.error)).toMatch(/scaled by the POOL’s tokens/);
    expect(String(st.pool.mismatch.error)).toMatch(/One of the two is wrong/);
  });

  it('refuses to price a burn against a wrong-but-8-decimal bitcoin side', async () => {
    // The whole answer to "with one pool and no factory, can the app be made to
    // read a different contract as the pool?". PeerPool.sol has no imports and
    // no owner: anybody may deploy their own over the REAL PEER and a token
    // they minted themselves, seed it at any ratio, and it will answer peer(),
    // btc(), reserves() and decimals() exactly as an honest pool does. The
    // decimals gate alone let it through, because "8 decimals" identifies no
    // coin.
    route(POOL, SEL_POOL_BTC, '0x' + addrWord(IMPOSTOR_BTC));
    route(IMPOSTOR_BTC, SEL_DECIMALS, '0x' + uint(8));
    const m2 = await freshModule();
    const p = await m2.officialPool();
    expect(p.error).toMatch(/is a different coin/);
    expect(p.error).toContain(IMPOSTOR_BTC);
    expect(p.error).toContain(BTC);
    // Refused, not quoted: no reserves under the refusal.
    expect(p.resBtcRaw).toBeUndefined();
    expect(p.seeded).toBeUndefined();
    // The pool is still DRAWN, with its own pair named — it is a real market
    // and this host simply will not price speech against it.
    const st = await m2.tokenState();
    expect(st.pool.resBtcRaw).toBe(B0.toString());
    expect(st.pool.mismatch.pairs[0].side).toBe('btc');
  });

  it('says the same about a wrong PEER side, and both at once', async () => {
    const otherPeer = '0x' + '99'.repeat(20);
    route(POOL, SEL_POOL_PEER, '0x' + addrWord(otherPeer));
    route(POOL, SEL_POOL_BTC, '0x' + addrWord(IMPOSTOR_BTC));
    route(otherPeer, SEL_DECIMALS, '0x' + uint(6));
    route(IMPOSTOR_BTC, SEL_DECIMALS, '0x' + uint(8));
    const m2 = await freshModule();
    const st = await m2.tokenState();
    expect(st.pool.decimals).toEqual({ peer: 6, btc: 8 });
    expect(st.pool.mismatch.pairs.map((x: { side: string }) => x.side)).toEqual(['peer', 'btc']);
    expect((await m2.officialPool()).error).toMatch(/different coin with the same name/);
  });

  it('with PEER_BTC_ADDR unset, says which fence is doing the work — and it is only the decimals', async () => {
    // PEERBURN_ON asks for the token and the pool, not for the BTC address, so
    // this is a legal configuration. It is also the one where the address
    // comparison cannot run, and the decimals gate is all that is left.
    delete process.env.PEER_BTC_ADDR;
    route(POOL, SEL_POOL_BTC, '0x' + addrWord(IMPOSTOR_BTC));
    route(IMPOSTOR_BTC, SEL_DECIMALS, '0x' + uint(8));
    const m2 = await freshModule();
    const st = await m2.tokenState();
    expect(st.pool.mismatch).toBeUndefined();     // nothing to compare against
    expect(st.pool.decimals.btc).toBe(8);
    expect((await m2.officialPool()).error).toBeUndefined();
    process.env.PEER_BTC_ADDR = BTC;
  });

  it('when the pool will not name its pair, says the scaling was never checked', async () => {
    routes.delete(POOL.toLowerCase() + '|' + SEL_POOL_PEER);
    routes.delete(POOL.toLowerCase() + '|' + SEL_POOL_BTC);
    route(POOL, SEL_POOL_PEER, '0x');
    route(POOL, SEL_POOL_BTC, '0x');
    const m2 = await freshModule();
    const st = await m2.tokenState();
    expect(st.pool.tokens).toEqual({ peer: null, btc: null });
    // Falls back to the configured pair, and DISCLOSES that it did. The
    // difference between "checked and agreed" and "never checked" is the whole
    // reason this key exists.
    expect(st.pool.decimals).toEqual({ peer: 18, btc: 8 });
    expect(String(st.pool.tokensNote)).toMatch(/nothing to check it against/);
    expect(st.pool.mismatch).toBeUndefined();
  });
});

/**
 * "The address IS the identity" is the whole argument for one pool, and it was
 * an assertion until eth_getCode was compared against the artifact. Three
 * things have to hold at once: a real deployment PASSES though its immutables
 * are not the artifact's zeros, a comment-only rebuild PASSES though its
 * metadata hash moved, and a different contract FAILS.
 */
describe('the code at the pool address is this repository’s', () => {
  it('accepts a deployment whose immutable words are filled in', async () => {
    codeAt.set(POOL, deployedCode('c0ffee'));
    const m2 = await freshModule();
    expect((await m2.officialPool()).error).toBeUndefined();
    expect(methods.filter((x) => x === 'eth_getCode')).toHaveLength(1);
  });

  it('accepts code whose metadata trailer differs — a comment is not an instruction', async () => {
    // solc appends a hash of the SOURCE. Editing a sentence in PeerPool.sol
    // moves it while moving no opcode, and a live host that started refusing
    // burns over that would be a worse failure than the one this catches.
    const body = deployedCode().replace(/^0x/, '');
    const cut = body.length - poolBuild.deployed.metaLen * 2;
    codeAt.set(POOL, '0x' + body.slice(0, cut) + 'ff'.repeat(poolBuild.deployed.metaLen));
    const m2 = await freshModule();
    expect((await m2.officialPool()).error).toBeUndefined();
  });

  it('refuses a contract that answers everything correctly and is not PeerPool', async () => {
    // The one this exists for: an owner, a pause, and a reserves() returning
    // whatever its author decided. It passes peer(), btc() and decimals().
    codeAt.set(POOL, '0x60806040523480156100');
    const m2 = await freshModule();
    const p = await m2.officialPool();
    expect(p.error).toMatch(/is not PeerPool/);
    expect(p.error).toMatch(/whatever its author decided to return/);
    expect(p.resBtcRaw).toBeUndefined();
  });

  it('refuses code that differs by ONE byte outside the masked ranges', async () => {
    const body = deployedCode().replace(/^0x/, '');
    // Byte 0 is the first opcode and no immutable reaches it.
    codeAt.set(POOL, '0x' + (body[0] === 'a' ? 'b' : 'a') + body.slice(1));
    const m2 = await freshModule();
    expect((await m2.officialPool()).error).toMatch(/is not PeerPool/);
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
    expect(st.pool).toBeUndefined();
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
    expect(seen.filter((c) => c.data.startsWith(SEL_BALANCE_OF))).toHaveLength(0);
  });

  it('sharesOf refuses on the same terms', async () => {
    const r = await m.sharesOf(WHO);
    expect(r.chainIdMatches).toBe(false);
    expect(r.error).toMatch(/refusing to report its numbers/);
    expect(r.raw).toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

describe('balanceOf and sharesOf on the right chain', () => {
  it('sends selector + one padded address, and returns the raw share count as a string', async () => {
    const shares = 40_000_000_000_000_000_123n; // past 2^53, like everything else here
    route(POOL, SEL_SHARES_OF + addrWord(WHO), '0x' + uint(shares));
    const r = await m.sharesOf(WHO);
    expect(r).toEqual({ pool: POOL, address: WHO, raw: shares.toString() });
    // The wire bytes, verbatim. Note what is NOT in them: the uint256 pool id
    // that used to precede the address when shares lived in a factory.
    const sent = seen.find((c) => c.data.startsWith(SEL_SHARES_OF));
    expect(sent?.to).toBe(POOL);
    expect(sent?.data).toBe(SEL_SHARES_OF + addrWord(WHO));
    expect(sent?.data).toHaveLength(10 + 64);
  });

  it('refuses a bad address without touching the chain', async () => {
    expect(await m.sharesOf('not-an-address')).toBe(null);
    expect(await m.sharesOf('')).toBe(null);
    expect(seen).toHaveLength(0);
  });

  it('reads a PEER balance with its decimals', async () => {
    route(TOKEN, SEL_BALANCE_OF + addrWord(WHO), '0x' + uint(42n * 10n ** 18n));
    const r = await m.balanceOf(WHO);
    expect(r).toEqual({ address: WHO, raw: (42n * 10n ** 18n).toString(), amount: 42, decimals: 18 });
  });
});

/**
 * The last properties live in the request path, not in the reader, so they are
 * exercised against a real host process talking to a fake JSON-RPC endpoint
 * that counts what it is asked.
 */
describe('GET /api/token/onchain — one refresh however many tabs', () => {
  const PORT = 5327;
  const RPC_PORT = 5328;
  const WRONG_PORT = 5329;
  const ROOT = resolve(__dirname, '..');
  const BASE = `http://127.0.0.1:${PORT}`;
  const WRONG = `http://127.0.0.1:${WRONG_PORT}`;
  // Past 2^53, and deliberately sharing no digit run with the pool's own
  // reserves above: the last assertion looks for this exact string ANYWHERE
  // in the shared body, and a substring of resPeerRaw would fail it for a
  // reason that has nothing to do with caching.
  const SHARES = 40_760_400_073_099_099_707n;

  let rpc: Server;
  let host: ChildProcess;
  let wrongHost: ChildProcess;
  let dir: string;
  let calls: string[] = [];

  /** The same canned chain as above, served over real HTTP to a real host.
   *
   *  It answers eth_blockNumber and eth_getLogs as well, which the reader
   *  never asks for: a host with a pool configured also has the PEER-burn
   *  door on, and that door's watcher walks the TOKEN's Transfer logs looking
   *  for burns nobody claimed. That scan is a different feature over a
   *  different contract, and the assertions below are written so it cannot be
   *  mistaken for pool discovery coming back. */
  const answer = (method: string, params: any[]): unknown => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_blockNumber') return '0x5dc';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_call') {
      const to = String(params[0].to).toLowerCase();
      const data = String(params[0].data).toLowerCase();
      if (to === TOKEN && data === SEL_DECIMALS) return '0x' + uint(18);
      if (to === TOKEN && data === SEL_TOTAL_SUPPLY) return '0x' + uint(SUPPLY);
      if (to === TOKEN && data.startsWith(SEL_BALANCE_OF)) return '0x' + uint(7n * 10n ** 18n);
      if (to === BTC && data === SEL_DECIMALS) return '0x' + uint(8);
      if (to === POOL && data === SEL_RESERVES) return reserves3(P0, B0, S0);
      if (to === POOL && data.startsWith(SEL_SHARES_OF)) return '0x' + uint(SHARES);
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
        PEER_POOL_ADDR: POOL,
        // The bitcoin watcher polls public explorers; it has nothing to do
        // with this file and would only add flakiness.
        PEER_BURN_ADDRESS: '',
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
        // Two extra tags, so an assertion can name the POOL specifically
        // rather than counting whatever else shares this endpoint.
        if (body.method === 'eth_call' && String(body.params[0].data).toLowerCase().startsWith(SEL_RESERVES)) {
          calls.push('pool:reserves');
        }
        if (body.method === 'eth_getLogs' && String(body.params[0].address).toLowerCase() === POOL) {
          calls.push('pool:logs');
        }
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
    // Twenty tabs opening at once used to be twenty full rounds — a whole
    // pool-discovery scan each — because every one of them checked the cache
    // before any of them had filled it. The pool is read exactly once per
    // refresh, so counting that read counts refreshes. (eth_chainId would
    // count refreshes of two different features: the burn watcher checks the
    // chain id on its own tick, off its own clock.)
    const rs = await Promise.all(Array.from({ length: 20 }, () => realFetch(BASE + '/api/token/onchain')));
    const bodies = await Promise.all(rs.map((r) => r.json() as Promise<Record<string, any>>));
    for (const b of bodies) {
      expect(b.deployed).toBe(true);
      expect(b.pool.address).toBe(POOL);
      expect(b.pool.resBtcRaw).toBe(B0.toString());
      expect(b.pool.totalSharesRaw).toBe(S0.toString());
    }
    expect(calls.filter((c) => c === 'pool:reserves')).toHaveLength(1);
    // The host is reading a pool, not walking a chain for one. Whatever else
    // this endpoint is asked for logs about, it is never asked about the pool.
    expect(calls.filter((c) => c === 'pool:logs')).toHaveLength(0);

    // And the next request inside the window reads the pool no further.
    const before = calls.filter((c) => c === 'pool:reserves').length;
    await realFetch(BASE + '/api/token/onchain');
    expect(calls.filter((c) => c === 'pool:reserves').length).toBe(before);
  }, 20_000);

  it('answers one caller’s share count without putting it in the shared cache', async () => {
    const r = await realFetch(BASE + '/api/token/onchain?of=' + WHO);
    const b = (await r.json()) as Record<string, any>;
    expect(b.account.raw).toBe((7n * 10n ** 18n).toString());
    // Shares do not transfer and no ERC-20 reports them, so this reader is
    // the only way a liquidity provider sees their own position.
    expect(b.account.poolShares).toEqual({ pool: POOL, address: WHO, raw: SHARES.toString() });
    // The cached body — the one everybody else gets — carries the pool's
    // totals and nobody's slice of them.
    const plain = (await (await realFetch(BASE + '/api/token/onchain')).json()) as Record<string, any>;
    expect(plain.account).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain(SHARES.toString());
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
    expect(b.account.poolShares).toBeUndefined();
    expect(b.totalSupplyRaw).toBeUndefined();
    // And the refused endpoint was never asked for a balance, a share count
    // or the pool.
    expect(calls.filter((c) => c === 'pool:reserves')).toHaveLength(0);
    expect(calls.filter((c) => c === 'eth_call')).toHaveLength(0);
  }, 20_000);
});

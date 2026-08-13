/**
 * PeerPools, executed on a real EVM — not a model of the contract, the
 * compiled bytecode itself, running under @ethereumjs/vm.
 *
 * THE CONTRACT UNDER TEST HERE IS SUPERSEDED. The network runs ONE pool at one
 * address: PeerPool.sol, covered by tests/one-pool.test.ts, which is the file
 * to read for the live design. Nothing in the app calls anything asserted
 * below — chain-l2/onchain.mjs reads a single pool through reserves() and
 * knows nothing about a factory, and no page embeds this bytecode.
 *
 * It is kept, and kept passing, for one reason: a PeerPools was deployed once
 * and a deployment is immutable. Somebody reading that address off a block
 * explorer needs the source, the artifact and the selectors in this repository
 * to agree with what is actually out there. See the SUPERSEDED header on
 * chain-l2/PeerPools.sol for which address that is, why it is dead, and why
 * its build.json no longer reproduces the deployed metadata byte for byte.
 *
 * What must hold:
 *
 * 1. The on-chain pool math is the in-log pool math. replay.cjs applies
 *    eff = amt·0.997 in floats; the contract applies amtIn·997 over
 *    resIn·1000 + amtIn·997 in integers — the same formula with the
 *    division deferred, asserted here to the exact raw unit. If the two
 *    AMMs ever disagreed, "the token works the same on-chain" would be a
 *    marketing sentence rather than a checkable one.
 * 2. Rounding always favors the pool: minted shares floor, pulled deposits
 *    ceil, removal payouts floor. Nobody extracts dust from the other
 *    shareholders by choosing clever amounts.
 * 3. Nothing is privileged and nothing is partial: any leg failing (a
 *    token refusing a transfer, a guard tripping) rolls back the whole
 *    act, including the pool's name claim.
 * 4. A name is claimed per CREATOR, not globally. Two strangers may both
 *    call their pool `main`; you may not call two of your own that. This
 *    is the anti-front-running property, and it is asserted here rather
 *    than trusted, because the failure it prevents is silent and permanent.
 * 5. The caller's own guards bite: a stale deadline, a minShares that the
 *    ratio no longer clears, a minPeer/minBtc the reserves no longer cover.
 *
 * The two ERC-20s here are PeerToken deployed twice — its build.json
 * bytecode, byte for byte — standing in for PEER and cbBTC. Both stand-ins
 * carry 18 decimals where real cbBTC has 8; the contract never reads
 * decimals() and moves raw integers only, so the difference is invisible to
 * the contract. It is NOT invisible to a user, so one describe block below
 * works entirely in cbBTC-realistic magnitudes (0.001 BTC = 100000 raw
 * units) and checks the numbers a 8-decimal reserve actually produces —
 * including the trade sizes that buy nothing at all. Display scaling is the
 * UI's job; granularity is nobody's job and shows up here.
 *
 * House rule note: no ABI encoder and no keccak library in this file. The
 * 4-byte selectors come from the compiler's own methodIdentifiers table in
 * PeerPools.build.json (which doubles as a test that the table is complete),
 * ERC-20 selectors are the hardcoded constants the repo already uses, and
 * arguments are hand-padded 32-byte words — the same encoder onchain.mjs
 * uses, because that is the whole encoder anyone needs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, hexToBytes, bytesToHex, type Address } from '@ethereumjs/util';

const tokenBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerToken.build.json', import.meta.url), 'utf8'));
const poolsBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerPools.build.json', import.meta.url), 'utf8'));

// ERC-20 selectors, hardcoded with their signatures like everywhere else in
// the repo: approve(address,uint256), transfer(address,uint256),
// balanceOf(address).
const SEL_APPROVE = '0x095ea7b3';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_BALANCE_OF = '0x70a08231';

const E18 = 10n ** 18n;
const MAX = (1n << 256n) - 1n;

/**
 * The chain's clock for every call in this file. Deadlines only mean
 * something against a real timestamp, and @ethereumjs's default block sits
 * at 0 — a world where nothing can ever be late. So every call here runs
 * inside one block with a plain wall-clock timestamp, and the tests pass
 * SOON when they intend the guard to be satisfied and PAST when they intend
 * it to bite.
 */
const NOW = 1_800_000_000n;
const SOON = NOW + 300n;
const PAST = NOW - 1n;
const BLOCK = createBlock({ header: { number: 1n, timestamp: NOW } });

/** One uint256 (or bool, or bytes32 already in hex) as a 32-byte word. */
const uint = (v: bigint) => v.toString(16).padStart(64, '0');
const addrWord = (a: Address) => a.toString().slice(2).padStart(64, '0');
/** A short ASCII name as bytes32: utf8, right-padded with NULs. */
const name32 = (s: string) => bytesToHex(new TextEncoder().encode(s)).slice(2).padEnd(64, '0');
/** The i-th 32-byte return word as a BigInt. */
const word = (ret: Uint8Array, i = 0) => BigInt('0x' + (bytesToHex(ret).slice(2).slice(64 * i, 64 * (i + 1)) || '0'));
/** An address as the BigInt its word decodes to, for comparing the two. */
const asWord = (a: Address) => BigInt(a.toString());

/** Floor integer sqrt — independent of the contract's Babylonian loop, so
 *  the two implementations check each other. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (y + n / y) / 2n; }
  return x;
}
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
/** The swap formula, integer-exact: replay.cjs's eff = amt·0.997 with the
 *  division deferred. This is the number the chain must produce. */
const swapOut = (resIn: bigint, resOut: bigint, amtIn: bigint) =>
  (resOut * amtIn * 997n) / (resIn * 1000n + amtIn * 997n);

/** Decode a Solidity Error(string) revert payload into its message. */
function reason(ret: Uint8Array): string {
  const hex = bytesToHex(ret);
  if (!hex.startsWith('0x08c379a0')) return hex;
  const len = Number(BigInt('0x' + hex.slice(10 + 64, 10 + 128)));
  return new TextDecoder().decode(hexToBytes(`0x${hex.slice(10 + 128, 10 + 128 + len * 2)}`));
}

type CallResult = {
  ok: boolean;
  ret: Uint8Array;
  revert: string;
  logs: [Uint8Array, Uint8Array[], Uint8Array][];
};

async function makeWorld() {
  const vm = await createVM();
  const evm = vm.evm;
  const alice = createAddressFromString('0x' + 'a11ce'.padStart(40, '1'));
  const bob = createAddressFromString('0x' + 'b0b'.padStart(40, '2'));

  const run = async (from: Address, to: Address | undefined, dataHex: string): Promise<CallResult> => {
    const r = await evm.runCall({
      caller: from,
      origin: from,
      to,
      block: BLOCK,
      data: hexToBytes(dataHex.startsWith('0x') ? (dataHex as `0x${string}`) : `0x${dataHex}`),
      gasLimit: 50_000_000n,
    });
    const err = r.execResult.exceptionError;
    return {
      ok: !err,
      ret: r.execResult.returnValue,
      revert: err && err.error === 'revert' ? reason(r.execResult.returnValue) : err ? String(err.error) : '',
      logs: (r.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][],
      ...(to === undefined ? { created: r.createdAddress } : {}),
    } as CallResult & { created?: Address };
  };

  const deploy = async (bytecode: string, argsHex: string): Promise<Address> => {
    const r = (await run(alice, undefined, bytecode + argsHex)) as CallResult & { created?: Address };
    if (!r.ok || !r.created) throw new Error('deploy failed: ' + r.revert);
    return r.created;
  };

  // PEER and the BTC stand-in: PeerToken twice, full supply to alice.
  const peer = await deploy(tokenBuild.bytecode, uint(18_250_000n));
  const btc = await deploy(tokenBuild.bytecode, uint(21_000_000n));
  // PeerPools over exactly that pair.
  const pools = await deploy(poolsBuild.bytecode, addrWord(peer) + addrWord(btc));

  // alice lets the pool contract pull from both sides; bob deliberately
  // approves nothing until a test says otherwise.
  for (const t of [peer, btc]) {
    const a = await run(alice, t, SEL_APPROVE + addrWord(pools) + uint(MAX));
    if (!a.ok) throw new Error('approve failed');
  }

  /** A PeerPools act or view, selector looked up in the compiler's own table. */
  const act = (from: Address, sig: string, argsHex = '') => {
    const sel = poolsBuild.hashes[sig];
    if (!sel) throw new Error('no selector for ' + sig + ' in PeerPools.build.json');
    return run(from, pools, '0x' + sel + argsHex);
  };
  const balance = async (token: Address, who: Address) =>
    word((await run(alice, token, SEL_BALANCE_OF + addrWord(who))).ret);
  const poolInfo = async (id: bigint) => {
    const r = await act(alice, 'poolInfo(uint256)', uint(id));
    if (!r.ok) throw new Error('poolInfo reverted: ' + r.revert);
    // Word order is the contract's own comment: name, resPeer, resBtc,
    // totalShares, creator — creator last so these offsets never moved.
    return {
      raw: r.ret,
      name: word(r.ret, 0),
      resPeer: word(r.ret, 1),
      resBtc: word(r.ret, 2),
      totalShares: word(r.ret, 3),
      creator: word(r.ret, 4),
    };
  };
  const sharesOf = async (id: bigint, who: Address) =>
    word((await act(alice, 'sharesOf(uint256,address)', uint(id) + addrWord(who))).ret);
  const poolCount = async () => word((await act(alice, 'poolCount()')).ret);
  /** The name-claim mapping's own getter: taken(creator, name). */
  const taken = async (who: Address, nm: string) =>
    word((await act(alice, 'taken(address,bytes32)', addrWord(who) + nm)).ret);
  /** Fund an address from alice's supply and let the pool pull from it. */
  const fund = async (who: Address, amtPeer: bigint, amtBtc: bigint) => {
    await run(alice, peer, SEL_TRANSFER + addrWord(who) + uint(amtPeer));
    await run(alice, btc, SEL_TRANSFER + addrWord(who) + uint(amtBtc));
    await run(who, peer, SEL_APPROVE + addrWord(pools) + uint(MAX));
    await run(who, btc, SEL_APPROVE + addrWord(pools) + uint(MAX));
  };
  /** The logs a call emitted from the POOL contract (token Transfers filtered out). */
  const poolLogs = (r: CallResult) => r.logs.filter((l) => bytesToHex(l[0]) === pools.toString());

  return { run, act, balance, poolInfo, sharesOf, poolCount, taken, fund, poolLogs, alice, bob, peer, btc, pools };
}

// The standard opening deposit used by most tests: 1,000,000 PEER against
// 50 BTC-units, both at 18 decimals — an invented price, like DEPLOY.md says.
const P0 = 1_000_000n * E18;
const B0 = 50n * E18;
const S0 = isqrt(P0 * B0);
const MIN_LIQ = 1000n;

async function withMainPool() {
  const w = await makeWorld();
  const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
  expect(r.ok).toBe(true);
  return w;
}

describe('the artifact — what the rest of the pipeline hardcodes', () => {
  it('carries a selector for every function in the shared spec', () => {
    for (const sig of [
      'createPool(bytes32,uint256,uint256)',
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      'swap(uint256,bool,uint256,uint256,uint256)',
      'poolCount()',
      'poolInfo(uint256)',
      'sharesOf(uint256,address)',
      'taken(address,bytes32)',
    ]) {
      expect(poolsBuild.hashes[sig], sig).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(poolsBuild.bytecode).toMatch(/^0x[0-9a-f]+$/);
  });

  it('keeps its read selectors stable, even though poolInfo grew a word', () => {
    // A selector is keccak of the name and the INPUT types only. poolInfo
    // answers five words instead of four and its selector did not move, which
    // is the whole reason `creator` was appended rather than inserted.
    //
    // Nothing in the app hardcodes these any more: chain-l2/onchain.mjs reads
    // ONE PeerPool through reserves() and knows nothing about a factory. They
    // are pinned here because this contract is deployed and immutable — a
    // reader written against it later, by anyone, needs the artifact and the
    // signature to agree, and this is where that is checked.
    expect(poolsBuild.hashes['poolInfo(uint256)']).toBe('1526fe27');
    expect(poolsBuild.hashes['poolCount()']).toBe('f525cb68');
    expect(poolsBuild.hashes['sharesOf(uint256,address)']).toBe('e78307ca');
    expect(poolsBuild.hashes['createPool(bytes32,uint256,uint256)']).toBe('b3a2199d');
  });

  it('exposes no privileged function of any kind', () => {
    // The pitch is that reading the contract settles every question; this
    // asserts the compiler agrees there is no owner, no pause, no mint.
    const names = poolsBuild.abi.filter((e: { type: string }) => e.type === 'function').map((e: { name: string }) => e.name);
    for (const forbidden of ['owner', 'transferOwnership', 'pause', 'unpause', 'mint', 'upgradeTo', 'setFee', 'skim', 'sync']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('declares the four events exactly as the spec writes them', () => {
    const ev = (n: string) =>
      poolsBuild.abi
        .find((e: { type: string; name?: string }) => e.type === 'event' && e.name === n)
        ?.inputs.map((i: { type: string; name: string; indexed: boolean }) => [i.type, i.name, i.indexed]);
    expect(ev('PoolCreated')).toEqual([
      ['uint256', 'id', true], ['bytes32', 'name', false], ['address', 'by', true], ['uint256', 'amtPeer', false], ['uint256', 'amtBtc', false],
    ]);
    expect(ev('LiquidityAdded')).toEqual([
      ['uint256', 'id', true], ['address', 'by', true], ['uint256', 'usedPeer', false], ['uint256', 'usedBtc', false], ['uint256', 'minted', false],
    ]);
    expect(ev('LiquidityRemoved')).toEqual([
      ['uint256', 'id', true], ['address', 'by', true], ['uint256', 'outPeer', false], ['uint256', 'outBtc', false], ['uint256', 'shareAmt', false],
    ]);
    expect(ev('Swapped')).toEqual([
      ['uint256', 'id', true], ['address', 'by', true], ['bool', 'sellPeer', false], ['uint256', 'amtIn', false], ['uint256', 'amtOut', false],
    ]);
  });
});

describe('createPool', () => {
  it('opens pool 0: sqrt shares, MIN_LIQ locked at address(0), tokens actually moved', async () => {
    const w = await makeWorld();
    const before = await w.balance(w.peer, w.alice);
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(0n); // returned id
    expect(await w.poolCount()).toBe(1n);
    const p = await w.poolInfo(0n);
    expect(p.name).toBe(BigInt('0x' + name32('main')));
    expect(p.resPeer).toBe(P0);
    expect(p.resBtc).toBe(B0);
    expect(p.totalShares).toBe(S0);
    expect(p.creator).toBe(asWord(w.alice));
    // The creator holds sqrt(P·B) − 1000; the locked 1000 sit at address(0),
    // an address nobody can ever call from.
    expect(await w.sharesOf(0n, w.alice)).toBe(S0 - MIN_LIQ);
    expect(await w.sharesOf(0n, createAddressFromString('0x' + '0'.repeat(40)))).toBe(MIN_LIQ);
    // Reserves are not just bookkeeping: the coins are in the contract.
    expect(await w.balance(w.peer, w.pools)).toBe(P0);
    expect(await w.balance(w.btc, w.pools)).toBe(B0);
    expect(before - (await w.balance(w.peer, w.alice))).toBe(P0);
  });

  it('emits PoolCreated with indexed id and creator, and the deposit in the data words', async () => {
    const w = await makeWorld();
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    const own = w.poolLogs(r);
    expect(own).toHaveLength(1); // the other logs are the two token Transfers
    const [, topics, data] = own[0]!;
    expect(topics).toHaveLength(3); // signature, id, by
    expect(word(topics[1]!)).toBe(0n);
    expect(word(topics[2]!)).toBe(asWord(w.alice));
    expect(word(data, 0)).toBe(BigInt('0x' + name32('main')));
    expect(word(data, 1)).toBe(P0);
    expect(word(data, 2)).toBe(B0);
  });

  it('refuses the empty name', async () => {
    const w = await makeWorld();
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', uint(0n) + uint(P0) + uint(B0));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('a pool needs a name');
  });

  it('refuses zero amounts on either side', async () => {
    const w = await makeWorld();
    for (const [p, b] of [[0n, B0], [P0, 0n], [0n, 0n]] as const) {
      const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('x') + uint(p) + uint(b));
      expect(r.ok).toBe(false);
      expect(r.revert).toBe('both starting amounts must be positive');
    }
  });

  it('refuses a seed whose sqrt does not clear the locked 1000', async () => {
    const w = await makeWorld();
    // sqrt(1000·1000) = 1000 exactly — not strictly greater, so the creator
    // would be left holding zero shares. Refused.
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('dust') + uint(1000n) + uint(1000n));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('starting liquidity too small');
  });

  it('opens a second pool over the SAME pair under a new name — fragmentation is chosen, not accidental', async () => {
    const w = await withMainPool();
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('side') + uint(2_000n * E18) + uint(1n * E18));
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(1n);
    expect(await w.poolCount()).toBe(2n);
    const p = await w.poolInfo(1n);
    expect(p.resPeer).toBe(2_000n * E18); // its own reserves, its own price
    expect((await w.poolInfo(0n)).resPeer).toBe(P0); // untouched neighbour
  });

  it('rolls the name claim back with everything else when the token pull fails', async () => {
    const w = await makeWorld();
    // bob approved nothing, so PeerToken itself refuses the transferFrom —
    // and its revert message must surface through the pool unchanged.
    const r = await w.act(w.bob, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('allowance exceeded');
    expect(await w.poolCount()).toBe(0n);
    expect(await w.taken(w.bob, name32('main'))).toBe(0n);
    // bob's own name was not burned by his failed attempt: once funded he
    // takes it cleanly, which is the claim being rolled back and not merely
    // someone else's claim succeeding.
    await w.fund(w.bob, P0, B0);
    const r2 = await w.act(w.bob, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    expect(r2.ok).toBe(true);
  });
});

describe('a name belongs to its creator, not to whoever pays the higher fee', () => {
  it('lets two different creators each have a pool called `main`', async () => {
    // The front-running fix, stated as a test: on a public mempool anyone
    // could see the operator's createPool("main", ...) and copy the name. If
    // names were global that copy would cost the attacker a fee and cost the
    // operator the name forever. Here it costs the attacker a fee and buys
    // them nothing.
    const w = await withMainPool();
    await w.fund(w.bob, 10_000n * E18, 1n * E18);
    const r = await w.act(w.bob, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(10_000n * E18) + uint(1n * E18));
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(1n); // a different id — the id is the identity
    expect(await w.poolCount()).toBe(2n);

    const a = await w.poolInfo(0n);
    const b = await w.poolInfo(1n);
    expect(a.name).toBe(b.name);            // the same label
    expect(a.creator).toBe(asWord(w.alice)); // different provenance
    expect(b.creator).toBe(asWord(w.bob));
    expect(a.creator === b.creator).toBe(false);
    // Neither pool touched the other's reserves.
    expect(a.resPeer).toBe(P0);
    expect(b.resPeer).toBe(10_000n * E18);
  });

  it('refuses a name the SAME creator already used', async () => {
    const w = await withMainPool();
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('you already have a pool with that name');
  });

  it('keeps the claim per creator in the public mapping', async () => {
    const w = await withMainPool();
    expect(await w.taken(w.alice, name32('main'))).toBe(1n);
    expect(await w.taken(w.bob, name32('main'))).toBe(0n); // bob's `main` is still free
    expect(await w.taken(w.alice, name32('side'))).toBe(0n);
  });

  it('holds the claim even after the pool is drained to its locked floor', async () => {
    const w = await withMainPool();
    const r = await w.act(w.alice, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(S0 - MIN_LIQ) + uint(0n) + uint(0n));
    expect(r.ok).toBe(true);
    // A drained pool keeps its name: a name people point at must not
    // quietly change referent, not even back to the same creator.
    const r2 = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('main') + uint(P0) + uint(B0));
    expect(r2.revert).toBe('you already have a pool with that name');
  });

  it('reports the creator through poolInfo, in the fifth word, without moving the first four', async () => {
    const w = await withMainPool();
    const p = await w.poolInfo(0n);
    expect(p.raw.length).toBe(160); // five static words now
    expect(p.name).toBe(BigInt('0x' + name32('main')));
    expect(p.resPeer).toBe(P0);
    expect(p.resBtc).toBe(B0);
    expect(p.totalShares).toBe(S0);
    expect(p.creator).toBe(asWord(w.alice));
    // An address is 20 bytes left-padded into its word: the top 12 bytes
    // must be zero, or a hand-decoding reader would be reading garbage.
    expect(bytesToHex(p.raw).slice(2).slice(64 * 4, 64 * 4 + 24)).toBe('0'.repeat(24));
  });
});

describe('addLiquidity', () => {
  it('pulls ONLY the used proportional amounts — the excess side never leaves the wallet', async () => {
    const w = await withMainPool();
    // Offer 10,000 PEER against 1 BTC-unit. At the pool's 20,000:1 ratio the
    // PEER side binds; only ~0.5 of the offered BTC is needed.
    const amtPeer = 10_000n * E18;
    const amtBtc = 1n * E18;
    const minted = (amtPeer * S0) / P0; // the binding side, floored — replay's min-ratio in integers
    const usedPeer = ceilDiv(minted * P0, S0);
    const usedBtc = ceilDiv(minted * B0, S0);
    expect(usedPeer <= amtPeer && usedBtc <= amtBtc).toBe(true); // ceilings hold even after the round-up
    const beforePeer = await w.balance(w.peer, w.alice);
    const beforeBtc = await w.balance(w.btc, w.alice);
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(amtPeer) + uint(amtBtc) + uint(minted) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(minted);
    expect(beforePeer - (await w.balance(w.peer, w.alice))).toBe(usedPeer);
    expect(beforeBtc - (await w.balance(w.btc, w.alice))).toBe(usedBtc);
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(P0 + usedPeer);
    expect(p.resBtc).toBe(B0 + usedBtc);
    expect(p.totalShares).toBe(S0 + minted);
    expect(await w.sharesOf(0n, w.alice)).toBe(S0 - MIN_LIQ + minted);
    // The event reports what was USED, not what was offered.
    const [, topics, data] = w.poolLogs(r)[0]!;
    expect(word(topics[1]!)).toBe(0n);
    expect(word(data, 0)).toBe(usedPeer);
    expect(word(data, 1)).toBe(usedBtc);
    expect(word(data, 2)).toBe(minted);
  });

  it('rounds the pulled amounts UP where flooring would shortchange the pool', async () => {
    const w = await makeWorld();
    // Prime-ish reserves make the divisions inexact on purpose.
    // sqrt(1000003 · 333337) = 577354 total shares. Offering 1000/1000:
    //   minted   = floor(1000·577354/1000003) = 577      (the PEER side binds)
    //   usedPeer = ceil(577·1000003/577354)   = 1000     (999.39 floored would be 999)
    //   usedBtc  = ceil(577·333337/577354)    = 334      (333.13 — floor would hand the LP the 0.87)
    const r0 = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('prime') + uint(1_000_003n) + uint(333_337n));
    expect(r0.ok).toBe(true);
    const beforePeer = await w.balance(w.peer, w.alice);
    const beforeBtc = await w.balance(w.btc, w.alice);
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(1000n) + uint(1000n) + uint(0n) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(577n);
    expect(beforePeer - (await w.balance(w.peer, w.alice))).toBe(1000n);
    expect(beforeBtc - (await w.balance(w.btc, w.alice))).toBe(334n);
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(1_000_003n + 1000n);
    expect(p.resBtc).toBe(333_337n + 334n);
    expect(p.totalShares).toBe(577_354n + 577n);
  });

  it('lets a second LP in and pays them back out, both at the pool ratio', async () => {
    const w = await withMainPool();
    await w.fund(w.bob, 50_000n * E18, 5n * E18);
    const r = await w.act(
      w.bob,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(40_000n * E18) + uint(2n * E18) + uint(0n) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    const minted = word(r.ret);
    expect(await w.sharesOf(0n, w.bob)).toBe(minted);
    // Round-trip: burning every share bob holds pays the proportional slice
    // of both reserves, floored.
    const p = await w.poolInfo(0n);
    const outPeer = (minted * p.resPeer) / p.totalShares;
    const outBtc = (minted * p.resBtc) / p.totalShares;
    const beforePeer = await w.balance(w.peer, w.bob);
    const r2 = await w.act(
      w.bob,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(minted) + uint(outPeer) + uint(outBtc),
    );
    expect(r2.ok).toBe(true);
    expect(word(r2.ret, 0)).toBe(outPeer);
    expect(word(r2.ret, 1)).toBe(outBtc);
    expect((await w.balance(w.peer, w.bob)) - beforePeer).toBe(outPeer);
    expect(await w.sharesOf(0n, w.bob)).toBe(0n);
  });

  it('refuses zero amounts and unknown pools', async () => {
    const w = await withMainPool();
    const r1 = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(0n) + uint(1n * E18) + uint(0n) + uint(SOON),
    );
    expect(r1.revert).toBe('both amounts must be positive');
    const r2 = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(7n) + uint(E18) + uint(E18) + uint(0n) + uint(SOON),
    );
    expect(r2.revert).toBe('no such pool');
  });
});

describe("the caller's own guards", () => {
  it('refuses a swap whose deadline has passed, and changes nothing', async () => {
    const w = await withMainPool();
    const before = await w.balance(w.peer, w.alice);
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(1_000n * E18) + uint(0n) + uint(PAST),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('too late');
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(P0);
    expect(p.resBtc).toBe(B0);
    expect(await w.balance(w.peer, w.alice)).toBe(before);
  });

  it('accepts a swap whose deadline is exactly this second — <=, not <', async () => {
    const w = await withMainPool();
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(1_000n * E18) + uint(0n) + uint(NOW),
    );
    expect(r.ok).toBe(true);
  });

  it('refuses an addLiquidity whose deadline has passed, before it looks at anything else', async () => {
    const w = await withMainPool();
    // Note the pool id is nonsense too: the time check is first, so this
    // says "too late" rather than "no such pool". Cheapest failure first.
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(7n) + uint(E18) + uint(E18) + uint(0n) + uint(PAST),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('too late');
  });

  it('trips minShares when someone moves the ratio in front of a deposit', async () => {
    const w = await withMainPool();
    const amtPeer = 10_000n * E18;
    const amtBtc = 1n * E18;
    const wouldMint = (amtPeer * S0) / P0; // what alice was quoted
    // A swap lands first and sells 100,000 PEER in. The PEER reserve is now
    // bigger, so the same 10,000 PEER is a smaller fraction of the pool and
    // the binding side mints fewer shares for it than alice was quoted.
    const r0 = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(100_000n * E18) + uint(0n) + uint(SOON),
    );
    expect(r0.ok).toBe(true);
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(amtPeer) + uint(amtBtc) + uint(wouldMint) + uint(SOON),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('fewer shares than your minimum - the ratio moved');
    // 0 means no guard, and the very same call then goes through.
    const r2 = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(amtPeer) + uint(amtBtc) + uint(0n) + uint(SOON),
    );
    expect(r2.ok).toBe(true);
    expect(word(r2.ret) < wouldMint).toBe(true); // it really did mint less
  });

  it('trips minPeer or minBtc on the way out, whichever side was drained', async () => {
    const w = await withMainPool();
    const half = (S0 - MIN_LIQ) / 2n;
    const quotedPeer = (half * P0) / S0;
    const quotedBtc = (half * B0) / S0;
    // Asking for one raw unit more than the reserves can pay: refused.
    const r1 = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(half) + uint(quotedPeer + 1n) + uint(0n),
    );
    expect(r1.revert).toBe('below your minimum - the pool moved');
    const r2 = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(half) + uint(0n) + uint(quotedBtc + 1n),
    );
    expect(r2.revert).toBe('below your minimum - the pool moved');
    // A swap ahead of the withdrawal changes what the slice is MADE OF: it
    // sells PEER in, so the BTC side of every slice shrinks. The PEER
    // minimum still clears; the BTC minimum is the one that bites.
    const r3 = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(50_000n * E18) + uint(0n) + uint(SOON),
    );
    expect(r3.ok).toBe(true);
    const r4 = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(half) + uint(quotedPeer) + uint(quotedBtc),
    );
    expect(r4.revert).toBe('below your minimum - the pool moved');
    // Same call with the BTC guard dropped: the PEER side alone is fine.
    const r5 = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(half) + uint(quotedPeer) + uint(0n),
    );
    expect(r5.ok).toBe(true);
    expect(word(r5.ret, 1) < quotedBtc).toBe(true); // the BTC really did shrink
  });

  it('lets both minimums through at exactly the quoted numbers — >=, not >', async () => {
    const w = await withMainPool();
    const half = (S0 - MIN_LIQ) / 2n;
    const outPeer = (half * P0) / S0;
    const outBtc = (half * B0) / S0;
    const r = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(half) + uint(outPeer) + uint(outBtc),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret, 0)).toBe(outPeer);
    expect(word(r.ret, 1)).toBe(outBtc);
  });
});

describe('swap', () => {
  it('sells PEER at exactly the replay.cjs number: 0.3% stays in the pool, k grows', async () => {
    const w = await withMainPool();
    const amtIn = 1_000n * E18;
    const expected = swapOut(P0, B0, amtIn);
    const beforeBtc = await w.balance(w.btc, w.alice);
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(amtIn) + uint(expected) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(expected);
    expect((await w.balance(w.btc, w.alice)) - beforeBtc).toBe(expected);
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(P0 + amtIn);
    expect(p.resBtc).toBe(B0 - expected);
    // The fee is the growth of k — that is how LPs get paid, with no fee
    // balance anywhere to administer.
    expect(p.resPeer * p.resBtc > P0 * B0).toBe(true);
    const [, topics, data] = w.poolLogs(r)[0]!;
    expect(word(topics[2]!)).toBe(asWord(w.alice));
    expect(word(data, 0)).toBe(1n); // sellPeer = true
    expect(word(data, 1)).toBe(amtIn);
    expect(word(data, 2)).toBe(expected);
  });

  it('sells BTC through the same formula mirrored', async () => {
    const w = await withMainPool();
    const amtIn = 1n * E18;
    const expected = swapOut(B0, P0, amtIn);
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(0n) + uint(amtIn) + uint(0n) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(expected);
    const p = await w.poolInfo(0n);
    expect(p.resBtc).toBe(B0 + amtIn);
    expect(p.resPeer).toBe(P0 - expected);
  });

  it('reverts below minOut and leaves every number untouched', async () => {
    const w = await withMainPool();
    const amtIn = 1_000n * E18;
    const expected = swapOut(P0, B0, amtIn);
    const before = await w.balance(w.peer, w.alice);
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(amtIn) + uint(expected + 1n) + uint(SOON),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('below your minimum - the price moved');
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(P0);
    expect(p.resBtc).toBe(B0);
    expect(await w.balance(w.peer, w.alice)).toBe(before);
  });

  it('refuses zero input, unknown pools, and trades too small to buy one raw unit', async () => {
    const w = await withMainPool();
    expect((await w.act(w.alice, 'swap(uint256,bool,uint256,uint256,uint256)', uint(0n) + uint(1n) + uint(0n) + uint(0n) + uint(SOON))).revert)
      .toBe('amount in must be positive');
    expect((await w.act(w.alice, 'swap(uint256,bool,uint256,uint256,uint256)', uint(9n) + uint(1n) + uint(E18) + uint(0n) + uint(SOON))).revert)
      .toBe('no such pool');
    // Selling 1 raw PEER against a 20,000:1 pool prices out below one raw
    // BTC unit; the pool refuses to accept coins for nothing.
    expect((await w.act(w.alice, 'swap(uint256,bool,uint256,uint256,uint256)', uint(0n) + uint(1n) + uint(1n) + uint(0n) + uint(SOON))).revert)
      .toBe('too small a trade to buy anything');
  });
});

describe('a pool at cbBTC magnitudes — 8 decimals against 18', () => {
  /**
   * Everything above trades 18 decimals against 18, which is a comfortable
   * lie: real cbBTC has 8, so a "BTC reserve" is a small integer and the
   * granularity is coarse enough to see. This pool is 1000 PEER (1000e18)
   * against 0.001 cbBTC (100000 raw units) — the kind of number the first
   * real pool will actually hold.
   *
   * Hand arithmetic, no library:
   *   s0    = sqrt(1e21 · 1e5) = sqrt(1e26)          = 1e13 shares
   *   sell 1 PEER (1e18):
   *     amtInWithFee = 1e18 · 997                    = 9.97e20
   *     out = 1e5 · 9.97e20 / (1e21·1000 + 9.97e20)
   *         = 9.97e25 / 1.000997e24                  = 99.60…  -> 99 raw
   *     i.e. 0.00000099 cbBTC for one PEER, and the 0.60 of a raw unit the
   *     floor drops stays in the pool where it belongs.
   */
  const RP = 1000n * E18;
  const RB = 100_000n;
  const RS = 10n ** 13n;

  async function withBtcPool() {
    const w = await makeWorld();
    const r = await w.act(w.alice, 'createPool(bytes32,uint256,uint256)', name32('sats') + uint(RP) + uint(RB));
    expect(r.ok).toBe(true);
    return w;
  }

  it('opens with the geometric-mean share count the hand arithmetic predicts', async () => {
    const w = await withBtcPool();
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(RP);
    expect(p.resBtc).toBe(RB);
    expect(p.totalShares).toBe(RS);
    expect(RS).toBe(isqrt(RP * RB)); // the independent sqrt agrees
    expect(await w.sharesOf(0n, w.alice)).toBe(RS - MIN_LIQ);
  });

  it('sells one PEER for exactly 99 raw cbBTC units', async () => {
    const w = await withBtcPool();
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(E18) + uint(99n) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(99n);          // the hand-computed number, flat
    expect(word(r.ret)).toBe(swapOut(RP, RB, E18)); // and the formula agrees
    const p = await w.poolInfo(0n);
    expect(p.resBtc).toBe(RB - 99n);
    expect(p.resPeer).toBe(RP + E18);
    expect(p.resPeer * p.resBtc > RP * RB).toBe(true); // k still grew
  });

  it('buys PEER with 1000 raw units (0.00001 cbBTC) at the mirrored number', async () => {
    const w = await withBtcPool();
    // out = 1e21 · (1000·997) / (1e5·1000 + 1000·997)
    //     = 9.97e26 / 100997000 = 9871580343970612988 raw PEER (9.87 PEER)
    const expected = 9_871_580_343_970_612_988n;
    expect(expected).toBe(swapOut(RB, RP, 1000n));
    const r = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(0n) + uint(1000n) + uint(expected) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(expected);
  });

  it('refuses a trade too small to move one satoshi-scale unit — the 8-decimal floor is real', async () => {
    const w = await withBtcPool();
    // 0.01 PEER: out = 1e5·(1e16·997)/(1e21·1000 + 1e16·997) = 0.997 -> 0.
    // The contract will not take coins for nothing, so this reverts rather
    // than quietly donating to the pool. A UI that offers a 0.01 PEER trade
    // against this pool is offering a failed transaction.
    const tiny = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(10n ** 16n) + uint(0n) + uint(SOON),
    );
    expect(tiny.revert).toBe('too small a trade to buy anything');
    expect(swapOut(RP, RB, 10n ** 16n)).toBe(0n);
    // 0.011 PEER clears the floor by exactly one raw unit.
    expect(swapOut(RP, RB, 11n * 10n ** 15n)).toBe(1n);
    const ok = await w.act(
      w.alice,
      'swap(uint256,bool,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(11n * 10n ** 15n) + uint(1n) + uint(SOON),
    );
    expect(ok.ok).toBe(true);
    expect(word(ok.ret)).toBe(1n);
  });

  it('mints nothing for a deposit too small to register against an 8-decimal side', async () => {
    const w = await withBtcPool();
    // 1 raw BTC unit is 1/100000th of the reserve, so it binds at
    // floor(1·1e13/1e5) = 1e8 shares — fine. But offering 1 raw unit of BTC
    // with a PEER side of 1 raw unit binds on PEER: floor(1·1e13/1e21) = 0.
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(1n) + uint(1n) + uint(0n) + uint(SOON),
    );
    expect(r.revert).toBe('deposit too small to mint a share');
  });

  it('adds liquidity at the 8-decimal ratio with the pulled amounts rounded UP', async () => {
    const w = await withBtcPool();
    // Offer 100 PEER against 100 raw BTC units. Shares by each side:
    //   byPeer = floor(100e18 · 1e13 / 1e21) = 1e12
    //   byBtc  = floor(100    · 1e13 / 1e5 ) = 1e10   <- binds
    // used = ceil(1e10·1e21/1e13) = 1e18 PEER, ceil(1e10·1e5/1e13) = 100 BTC
    const amtPeer = 100n * E18;
    const amtBtc = 100n;
    const minted = (amtBtc * RS) / RB;
    expect(minted).toBe(10n ** 10n);
    const usedPeer = ceilDiv(minted * RP, RS);
    const usedBtc = ceilDiv(minted * RB, RS);
    expect(usedPeer).toBe(E18); // one PEER, not the hundred offered
    expect(usedBtc).toBe(100n);
    const beforePeer = await w.balance(w.peer, w.alice);
    const r = await w.act(
      w.alice,
      'addLiquidity(uint256,uint256,uint256,uint256,uint256)',
      uint(0n) + uint(amtPeer) + uint(amtBtc) + uint(minted) + uint(SOON),
    );
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(minted);
    expect(beforePeer - (await w.balance(w.peer, w.alice))).toBe(usedPeer);
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(RP + usedPeer);
    expect(p.resBtc).toBe(RB + usedBtc);
    expect(p.totalShares).toBe(RS + minted);
  });
});

describe('removeLiquidity', () => {
  it('pays the proportional slice of both reserves, rounded down', async () => {
    const w = await withMainPool();
    const half = (S0 - MIN_LIQ) / 2n;
    const outPeer = (half * P0) / S0;
    const outBtc = (half * B0) / S0;
    const beforePeer = await w.balance(w.peer, w.alice);
    const beforeBtc = await w.balance(w.btc, w.alice);
    const r = await w.act(w.alice, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(half) + uint(0n) + uint(0n));
    expect(r.ok).toBe(true);
    expect(word(r.ret, 0)).toBe(outPeer);
    expect(word(r.ret, 1)).toBe(outBtc);
    expect((await w.balance(w.peer, w.alice)) - beforePeer).toBe(outPeer);
    expect((await w.balance(w.btc, w.alice)) - beforeBtc).toBe(outBtc);
    const p = await w.poolInfo(0n);
    expect(p.resPeer).toBe(P0 - outPeer);
    expect(p.resBtc).toBe(B0 - outBtc);
    expect(p.totalShares).toBe(S0 - half);
    expect(await w.sharesOf(0n, w.alice)).toBe(S0 - MIN_LIQ - half);
  });

  it('refuses more shares than held — including by one', async () => {
    const w = await withMainPool();
    const r = await w.act(
      w.alice,
      'removeLiquidity(uint256,uint256,uint256,uint256)',
      uint(0n) + uint(S0 - MIN_LIQ + 1n) + uint(0n) + uint(0n),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('more shares than you hold');
    // bob holds nothing at all.
    const r2 = await w.act(w.bob, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(1n) + uint(0n) + uint(0n));
    expect(r2.revert).toBe('more shares than you hold');
  });

  it('refuses zero shares', async () => {
    const w = await withMainPool();
    const r = await w.act(w.alice, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(0n) + uint(0n) + uint(0n));
    expect(r.revert).toBe('shares to remove must be positive');
  });

  it('cannot close a pool: the locked MIN_LIQ stays behind with its slice of the reserves', async () => {
    const w = await withMainPool();
    const all = S0 - MIN_LIQ;
    const r = await w.act(w.alice, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(all) + uint(0n) + uint(0n));
    expect(r.ok).toBe(true);
    const p = await w.poolInfo(0n);
    expect(p.totalShares).toBe(MIN_LIQ); // forever
    expect(p.resPeer > 0n && p.resBtc > 0n).toBe(true);
    // Alice cannot come back for the remainder.
    const r2 = await w.act(w.alice, 'removeLiquidity(uint256,uint256,uint256,uint256)', uint(0n) + uint(1n) + uint(0n) + uint(0n));
    expect(r2.revert).toBe('more shares than you hold');
  });
});

describe('the views', () => {
  it('poolInfo answers in exactly five static words — hand-decodable with curl', async () => {
    const w = await withMainPool();
    const p = await w.poolInfo(0n);
    expect(p.raw.length).toBe(160);
  });

  it('poolInfo names the failure for an id that does not exist', async () => {
    const w = await makeWorld();
    const r = await w.act(w.alice, 'poolInfo(uint256)', uint(0n));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('no such pool');
  });

  it('sharesOf an unknown pool is plain zero — a mapping read, not an invention', async () => {
    const w = await makeWorld();
    expect(await w.sharesOf(42n, w.alice)).toBe(0n);
  });
});

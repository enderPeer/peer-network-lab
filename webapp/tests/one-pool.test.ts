/**
 * PeerPool — THE pool, executed on a real EVM. Not a model of the contract,
 * the compiled bytecode itself, running under @ethereumjs/vm.
 *
 * What must hold:
 *
 * 1. THE OPERATOR'S REQUIREMENT: the pool can be seeded at ANY size. 1 PEER
 *    against 1 satoshi opens it and mints a billion shares. MIN_LIQ = 1000 is
 *    a floor on sqrt(amtPeer·amtBtc), not a minimum investment, and the only
 *    thing it actually refuses is 1 wei against 1 satoshi — a pool nobody
 *    could add to or trade against. Both rows are asserted here because both
 *    are claims the contract header makes in numbers.
 * 2. Every later add is proportional at the current ratio: the binding side is
 *    the smaller of the two offers measured in shares, only the used amounts
 *    are pulled, and the excess never leaves the caller's wallet.
 * 3. The on-chain pool math is the in-log pool math. replay.cjs applies
 *    eff = amt·0.997 in floats; the contract applies amtIn·997 over
 *    resIn·1000 + amtIn·997 in integers — the same formula with the division
 *    deferred, asserted here to the exact raw unit.
 * 4. Rounding always favors the pool: minted shares floor, pulled deposits
 *    ceil, removal payouts floor.
 * 5. The caller's own guards bite: minShares, minOut, minPeer, minBtc, and a
 *    deadline that has passed.
 * 6. Nothing is privileged. The ABI is eight functions and there is no ninth.
 * 7. Reentrancy is refused, proved with a token that actually re-enters.
 * 8. THE ATTACK THAT MATTERS: first-depositor share inflation. Open at the
 *    floor, donate straight to the contract, then let a second party in — and
 *    show they do not get zero shares and cannot be robbed.
 * 9. THE ATTACK THE CONTRACT CANNOT DEFEAT ALONE: the race for the seeding
 *    call. This pool lives at a published address before it holds anything and
 *    the seeding branch runs once ever, so a stranger who gets there first
 *    sets the only price this network will have. Run end to end: a 1-satoshi
 *    seed, an unguarded 10,000-satoshi opening deposit that SUCCEEDS in the
 *    proportional branch, and one swap that takes 9,901 satoshis back out —
 *    then the same deposit with minShares = sqrt(amtPeer·amtBtc) - MIN_LIQ,
 *    which reverts, and which the honest unseeded case satisfies exactly.
 * 10. The artifact carries the DEPLOYED code, its immutable ranges and its
 *    metadata length, and a real deployment differs from it at exactly those
 *    ranges — which is what lets onchain.mjs check eth_getCode at the pool.
 *
 * The two ERC-20s here are PeerToken deployed twice — its build.json bytecode,
 * byte for byte — standing in for PEER and cbBTC. Both stand-ins carry 18
 * decimals where real cbBTC has 8; the contract never reads decimals() and
 * moves raw integers only, so the difference is invisible to it. It is NOT
 * invisible to a user, so every BTC-side number in this file is written in RAW
 * SATOSHIS (1_000_000 = 0.01 BTC) and the PEER side in wei, which is the pair
 * of magnitudes the real deployment will see.
 *
 * House rule note: no ABI encoder and no keccak library in this file. The
 * 4-byte selectors come from the compiler's own methodIdentifiers table in
 * PeerPool.build.json (which doubles as a test that the table is complete),
 * ERC-20 selectors are the hardcoded constants the repo already uses, and
 * arguments are hand-padded 32-byte words — the same encoder onchain.mjs uses,
 * because that is the whole encoder anyone needs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, hexToBytes, bytesToHex, type Address } from '@ethereumjs/util';

const tokenBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerToken.build.json', import.meta.url), 'utf8'));
const poolBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerPool.build.json', import.meta.url), 'utf8'));

// ERC-20 selectors, hardcoded with their signatures like everywhere else in
// the repo: approve(address,uint256), transfer(address,uint256),
// balanceOf(address).
const SEL_APPROVE = '0x095ea7b3';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_BALANCE_OF = '0x70a08231';

const E18 = 10n ** 18n;
const MAX = (1n << 256n) - 1n;
const MIN_LIQ = 1000n;
const ZERO = createAddressFromString('0x' + '0'.repeat(40));

/**
 * The chain's clock for every call in this file. Deadlines only mean something
 * against a real timestamp, and @ethereumjs's default block sits at 0 — a
 * world where nothing can ever be late. So every call here runs inside one
 * block with a plain wall-clock timestamp, and the tests pass SOON when they
 * intend the guard to be satisfied and PAST when they intend it to bite.
 */
const NOW = 1_800_000_000n;
const SOON = NOW + 300n;
const PAST = NOW - 1n;
const BLOCK = createBlock({ header: { number: 1n, timestamp: NOW } });

/** One uint256 (or bool) as a 32-byte word. */
const uint = (v: bigint) => v.toString(16).padStart(64, '0');
const bool = (v: boolean) => uint(v ? 1n : 0n);
const addrWord = (a: Address) => a.toString().slice(2).padStart(64, '0');
/** The i-th 32-byte return word as a BigInt. */
const word = (ret: Uint8Array, i = 0) => BigInt('0x' + (bytesToHex(ret).slice(2).slice(64 * i, 64 * (i + 1)) || '0'));
/** An address as the BigInt its word decodes to, for comparing the two. */
const asWord = (a: Address) => BigInt(a.toString());

/** Floor integer sqrt — independent of the contract's Babylonian loop, so the
 *  two implementations check each other. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (y + n / y) / 2n; }
  return x;
}
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
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

/**
 * A token that RE-ENTERS. Hand-written EVM bytecode rather than a second .sol
 * file, for the same reason the rest of this repo hand-pads its calldata: the
 * test should not need a compiler at runtime, and 110 bytes of opcodes with
 * their mnemonics beside them are readable by anyone who can read the contract
 * they are attacking.
 *
 * What it does, on any call:
 *   selector 0x00000001  — "arm": set storage slot 0, return nothing.
 *   anything else        — if armed, CALL back into msg.sender (which, when
 *                          the pool is pulling or pushing this token, IS the
 *                          pool) with add(1, 1, 0, type(uint256).max). If that
 *                          re-entry reverts, bubble its revert data verbatim
 *                          so the outer failure carries the pool's own reason
 *                          rather than a generic one. Then answer `true`, so
 *                          an unarmed run behaves like a perfectly ordinary
 *                          ERC-20 and the pool can be seeded normally first.
 *
 * The deadline in the re-entrant call is uint256 max ON PURPOSE. If it were
 * zero the call would revert on "too late" whether or not a reentrancy guard
 * existed, and this test would pass against a contract with no guard at all.
 */
function hostileTokenInitCode(addSelector: string): { init: string; runtime: string } {
  const ARM = 0x21;
  const FIRE = 0x2d;
  const OK = 0x63;
  const runtime =
    // ── dispatch ──────────────────────────────────────────────────────────
    '6000' + // PUSH1 0x00
    '35' + //   CALLDATALOAD
    '60e0' + // PUSH1 0xe0
    '1c' + //   SHR              -> the 4-byte selector
    '80' + //   DUP1
    '6300000001' + // PUSH4 0x00000001   ("arm")
    '14' + //   EQ
    '6021' + // PUSH1 ARM
    '57' + //   JUMPI
    '50' + //   POP              (drop the selector copy)
    '6000' + // PUSH1 0x00
    '54' + //   SLOAD            -> armed?
    '602d' + // PUSH1 FIRE
    '57' + //   JUMPI
    // ── not armed: answer `true` like any other ERC-20 ────────────────────
    '6001' + '6000' + '52' + // MSTORE(0, 1)
    '6020' + '6000' + 'f3' + // RETURN(0, 32)
    // ── arm ───────────────────────────────────────────────────────────────
    '5b' + //   JUMPDEST (0x21)
    '50' + //   POP
    '6001' + '6000' + '55' + // SSTORE(0, 1)
    '6000' + '6000' + 'f3' + // RETURN(0, 0)
    // ── fire: re-enter the caller ─────────────────────────────────────────
    '5b' + //   JUMPDEST (0x2d)
    '63' + addSelector + // PUSH4 add(uint256,uint256,uint256,uint256)
    '60e0' + '1b' + //     SHL 224
    '6000' + '52' + //     MSTORE(0, sel<<224)
    '6001' + '6004' + '52' + // MSTORE(4,  1)    amtPeer
    '6001' + '6024' + '52' + // MSTORE(36, 1)    amtBtc
    //                         minShares stays 0 — memory is zero-initialised
    '6000' + '19' + '6064' + '52' + // MSTORE(100, ~0) deadline = uint256 max
    '6000' + //  PUSH1 0x00   retLength
    '6000' + //  PUSH1 0x00   retOffset
    '6084' + //  PUSH1 0x84   argsLength = 4 + 4·32
    '6000' + //  PUSH1 0x00   argsOffset
    '6000' + //  PUSH1 0x00   value
    '33' + //    CALLER       the pool
    '5a' + //    GAS
    'f1' + //    CALL
    '6063' + // PUSH1 OK
    '57' + //   JUMPI
    // the re-entry reverted: bubble its data unchanged
    '3d' + '6000' + '6000' + '3e' + // RETURNDATACOPY(0, 0, size)
    '3d' + '6000' + 'fd' + //         REVERT(0, size)
    // ── the re-entry somehow succeeded: still answer `true` ────────────────
    '5b' + //   JUMPDEST (0x63)
    '6001' + '6000' + '52' + // MSTORE(0, 1)
    '6020' + '6000' + 'f3'; //  RETURN(0, 32)

  // Self-check: every jump above must land on a JUMPDEST, or the contract
  // would fail in a way that looks exactly like the pool refusing it.
  for (const dest of [ARM, FIRE, OK]) {
    if (runtime.slice(dest * 2, dest * 2 + 2) !== '5b') throw new Error('hostile token: jump ' + dest + ' is not a JUMPDEST');
  }
  const len = runtime.length / 2;
  // Standard constructor: copy the runtime out of the init code and return it.
  const init =
    '60' + len.toString(16).padStart(2, '0') + // PUSH1 len   (size)
    '600c' + //                                    PUSH1 0x0c  (offset of runtime)
    '6000' + //                                    PUSH1 0x00  (dest)
    '39' + //                                      CODECOPY
    '60' + len.toString(16).padStart(2, '0') + // PUSH1 len
    '6000' + //                                    PUSH1 0x00
    'f3'; //                                       RETURN
  return { init: init + runtime, runtime };
}

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
  const pool = await deploy(poolBuild.bytecode, addrWord(peer) + addrWord(btc));

  // alice lets the pool pull from both sides; bob deliberately approves
  // nothing until a test funds him.
  for (const t of [peer, btc]) {
    const a = await run(alice, t, SEL_APPROVE + addrWord(pool) + uint(MAX));
    if (!a.ok) throw new Error('approve failed');
  }

  /** A PeerPool act or view, selector looked up in the compiler's own table. */
  const act = (from: Address, sig: string, argsHex = '') => {
    const sel = poolBuild.hashes[sig];
    if (!sel) throw new Error('no selector for ' + sig + ' in PeerPool.build.json');
    return run(from, pool, '0x' + sel + argsHex);
  };
  const balance = async (token: Address, who: Address) =>
    word((await run(alice, token, SEL_BALANCE_OF + addrWord(who))).ret);
  /** reserves(): three static words, in the order the contract's comment fixes. */
  const reserves = async () => {
    const r = await act(alice, 'reserves()');
    if (!r.ok) throw new Error('reserves reverted: ' + r.revert);
    return { raw: r.ret, resPeer: word(r.ret, 0), resBtc: word(r.ret, 1), totalShares: word(r.ret, 2) };
  };
  const sharesOf = async (who: Address) => word((await act(alice, 'sharesOf(address)', addrWord(who))).ret);
  const add = (from: Address, amtPeer: bigint, amtBtc: bigint, minShares = 0n, deadline = SOON) =>
    act(from, 'add(uint256,uint256,uint256,uint256)', uint(amtPeer) + uint(amtBtc) + uint(minShares) + uint(deadline));
  const remove = (from: Address, shareAmt: bigint, minPeer = 0n, minBtc = 0n) =>
    act(from, 'remove(uint256,uint256,uint256)', uint(shareAmt) + uint(minPeer) + uint(minBtc));
  const swap = (from: Address, sellPeer: boolean, amtIn: bigint, minOut = 0n, deadline = SOON) =>
    act(from, 'swap(bool,uint256,uint256,uint256)', bool(sellPeer) + uint(amtIn) + uint(minOut) + uint(deadline));
  /** Fund an address from alice's supply and let the pool pull from it. */
  const fund = async (who: Address, amtPeer: bigint, amtBtc: bigint) => {
    await run(alice, peer, SEL_TRANSFER + addrWord(who) + uint(amtPeer));
    await run(alice, btc, SEL_TRANSFER + addrWord(who) + uint(amtBtc));
    await run(who, peer, SEL_APPROVE + addrWord(pool) + uint(MAX));
    await run(who, btc, SEL_APPROVE + addrWord(pool) + uint(MAX));
  };
  /** The logs a call emitted from the POOL (token Transfers filtered out). */
  const poolLogs = (r: CallResult) => r.logs.filter((l) => bytesToHex(l[0]) === pool.toString());
  /** Every balance a test wants to watch, in one shot. */
  const snapshot = async (who: Address) => ({ peer: await balance(peer, who), btc: await balance(btc, who) });

  /** The runtime code actually installed at an address, which is what
   *  eth_getCode answers on a real chain. */
  const codeAt = async (who: Address) => bytesToHex(await vm.stateManager.getCode(who));

  return { run, deploy, act, balance, reserves, sharesOf, add, remove, swap, fund, poolLogs, snapshot, codeAt, alice, bob, peer, btc, pool };
}

// The standard pool used by most tests: 100,000 PEER against 1,000,000
// satoshis (0.01 BTC) — an invented opening price, and exactly the depth the
// network's PEER-burn door requires before it will price anything at all.
const P0 = 100_000n * E18;
const B0 = 1_000_000n;
const S0 = isqrt(P0 * B0);

async function withPool() {
  const w = await makeWorld();
  const r = await w.add(w.alice, P0, B0);
  expect(r.ok).toBe(true);
  return w;
}

describe('the artifact — what the rest of the pipeline hardcodes', () => {
  it('carries a selector for every function in the surface, and no others', () => {
    // The whole ABI, asserted as a set rather than as a blacklist: a blacklist
    // only catches the privileged functions somebody thought to name, and the
    // pitch of this contract is that reading it settles every question.
    expect(Object.keys(poolBuild.hashes).sort()).toEqual([
      'MIN_LIQ()',
      'add(uint256,uint256,uint256,uint256)',
      'btc()',
      'peer()',
      'remove(uint256,uint256,uint256)',
      'reserves()',
      'sharesOf(address)',
      'swap(bool,uint256,uint256,uint256)',
    ]);
    expect(poolBuild.bytecode).toMatch(/^0x[0-9a-f]+$/);
  });

  it('carries the deployed runtime code, its immutable ranges and its metadata length', async () => {
    // onchain.mjs compares eth_getCode at the pool against this, so that "the
    // address IS the identity" is checkable rather than asserted. The
    // comparison has to mask two things it cannot predict, and both are
    // written down here rather than derived on the reading side.
    const d = poolBuild.deployed;
    expect(d.object).toMatch(/^0x[0-9a-f]+$/);
    expect(d.metaLen).toBeGreaterThan(2);
    // Ten words: peer and btc, five references each. The count is asserted
    // because a masked range is a range NOBODY is checking — if this grows,
    // somebody added an immutable and the check got weaker without saying so.
    expect(d.immutables).toHaveLength(10);
    for (const r of d.immutables) expect(r.length).toBe(32);

    // And the artifact is the truth about a real deployment. solc leaves the
    // immutable slots zero; the constructor writes the two token addresses
    // into them, so the code on chain differs from the artifact at exactly
    // those ranges and nowhere else. That is the property the mask rests on,
    // and here it is against the EVM rather than against a comment.
    const w = await makeWorld();
    const live = (await w.codeAt(w.pool)).replace(/^0x/, '');
    const want = d.object.replace(/^0x/, '');
    expect(live).toHaveLength(want.length);
    const mask = (hex: string) => {
      const c = hex.split('');
      for (const r of d.immutables) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) c[i] = '0';
      return c.join('');
    };
    expect(mask(live)).toBe(mask(want));
    expect(live).not.toBe(want);              // the immutables really are filled in
    // Both token addresses are in there, which is what the mask is masking.
    expect(live).toContain(w.peer.toString().slice(2));
    expect(live).toContain(w.btc.toString().slice(2));
  });

  it('pins the selector table the pages and onchain.mjs will hardcode', () => {
    // Straight from solc's methodIdentifiers. If any of these change, every
    // hand-encoded call site in the repo is pointing at nothing and must be
    // updated in the same commit.
    expect(poolBuild.hashes).toMatchObject({
      'add(uint256,uint256,uint256,uint256)': 'e022d77c',
      'remove(uint256,uint256,uint256)': '7ed72fda',
      'swap(bool,uint256,uint256,uint256)': '59542ca9',
      'reserves()': '75172a8b',
      'sharesOf(address)': 'f5eb42dc',
      'peer()': '11cda415',
      'btc()': 'a28d57d8',
      'MIN_LIQ()': '5731bb0a',
    });
  });

  it('exposes no owner, no mint, no pause, no upgrade — and no way to grow one', () => {
    const names = poolBuild.abi.filter((e: { type: string }) => e.type === 'function').map((e: { name: string }) => e.name);
    for (const forbidden of [
      'owner', 'transferOwnership', 'renounceOwnership', 'pause', 'unpause', 'mint', 'burn',
      'upgradeTo', 'upgradeToAndCall', 'setFee', 'setOwner', 'initialize', 'skim', 'sync', 'rescue', 'sweep',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    // peer, btc and MIN_LIQ are immutable/constant: solc renders them as view
    // getters and there is no setter anywhere to pair with them.
    for (const n of ['peer', 'btc', 'MIN_LIQ']) {
      expect(poolBuild.abi.find((e: { name?: string }) => e.name === n).stateMutability).toBe('view');
    }
    // The constructor takes the pair and nothing else. No fee recipient, no
    // admin, no registry to report into.
    const ctor = poolBuild.abi.find((e: { type: string }) => e.type === 'constructor');
    expect(ctor.inputs.map((i: { type: string; name: string }) => [i.type, i.name])).toEqual([
      ['address', 'peer_'], ['address', 'btc_'],
    ]);
  });

  it('has no name, no id and no factory anywhere in its ABI', () => {
    // The point of the redesign, asserted rather than described: there is no
    // bytes32 to squat, no pool id to mistype, and no enumeration to censor.
    const inputs = poolBuild.abi.flatMap((e: { inputs?: { type: string; name: string }[] }) => e.inputs ?? []);
    expect(inputs.some((i: { type: string }) => i.type === 'bytes32')).toBe(false);
    expect(inputs.some((i: { name: string }) => /^(name|id|poolId)$/.test(i.name))).toBe(false);
    const names = poolBuild.abi.filter((e: { type: string }) => e.type === 'function').map((e: { name: string }) => e.name);
    for (const gone of ['createPool', 'poolCount', 'poolInfo', 'taken', 'addLiquidity', 'removeLiquidity']) {
      expect(names, gone).not.toContain(gone);
    }
  });

  it('declares the three events exactly as the spec writes them, with the actor indexed', () => {
    const ev = (n: string) =>
      poolBuild.abi
        .find((e: { type: string; name?: string }) => e.type === 'event' && e.name === n)
        ?.inputs.map((i: { type: string; name: string; indexed: boolean }) => [i.type, i.name, i.indexed]);
    expect(ev('Added')).toEqual([
      ['address', 'by', true], ['uint256', 'usedPeer', false], ['uint256', 'usedBtc', false], ['uint256', 'minted', false],
    ]);
    expect(ev('Removed')).toEqual([
      ['address', 'by', true], ['uint256', 'outPeer', false], ['uint256', 'outBtc', false], ['uint256', 'burned', false],
    ]);
    expect(ev('Swapped')).toEqual([
      ['address', 'by', true], ['bool', 'sellPeer', false], ['uint256', 'amtIn', false], ['uint256', 'amtOut', false],
    ]);
    expect(poolBuild.abi.filter((e: { type: string }) => e.type === 'event')).toHaveLength(3);
  });
});

describe('the first add seeds the pool — at ANY size', () => {
  it('starts as three zeros: an unseeded pool is a real state, not an error', async () => {
    const w = await makeWorld();
    const r = await w.reserves();
    expect([r.resPeer, r.resBtc, r.totalShares]).toEqual([0n, 0n, 0n]);
    expect(bytesToHex(r.raw)).toHaveLength(2 + 3 * 64);
    expect(await w.sharesOf(w.alice)).toBe(0n);
  });

  it('opens on 1 PEER against 1 SATOSHI and mints a billion shares', async () => {
    // The operator's requirement, in the smallest units the real pair has:
    // one whole PEER (1e18 wei) against one satoshi (1 raw cbBTC unit).
    // sqrt(1e18 · 1) = 1e9, six orders of magnitude clear of the 1000 floor.
    const w = await makeWorld();
    const before = await w.snapshot(w.alice);
    const r = await w.add(w.alice, E18, 1n);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(1_000_000_000n - MIN_LIQ); // the caller's own shares

    const res = await w.reserves();
    expect(res.resPeer).toBe(E18);
    expect(res.resBtc).toBe(1n);
    expect(res.totalShares).toBe(1_000_000_000n);
    expect(await w.sharesOf(w.alice)).toBe(1_000_000_000n - MIN_LIQ);
    expect(await w.sharesOf(ZERO)).toBe(MIN_LIQ);

    // Reserves are not just bookkeeping: the coins are in the contract.
    expect(await w.balance(w.peer, w.pool)).toBe(E18);
    expect(await w.balance(w.btc, w.pool)).toBe(1n);
    const after = await w.snapshot(w.alice);
    expect(before.peer - after.peer).toBe(E18);
    expect(before.btc - after.btc).toBe(1n);
  });

  it('opens on 0.001 PEER against 1 satoshi too — the header\'s middle row, to the unit', async () => {
    // sqrt(1e15 · 1) = 31,622,776.6…, floored. Still allowed, and this is the
    // row that proves the floor is not a minimum investment: a tenth of a US
    // cent of PEER opens the pool.
    const w = await makeWorld();
    const r = await w.add(w.alice, 10n ** 15n, 1n);
    expect(r.ok).toBe(true);
    expect((await w.reserves()).totalShares).toBe(31_622_776n);
    expect(isqrt(10n ** 15n)).toBe(31_622_776n); // the two sqrt implementations agree
  });

  it('refuses 1 wei against 1 satoshi — the ONLY thing the floor actually blocks', async () => {
    const w = await makeWorld();
    const r = await w.add(w.alice, 1n, 1n);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('opening deposit too small');
    expect((await w.reserves()).totalShares).toBe(0n);
    // Nothing moved: a refused opening is not a partial opening.
    expect(await w.balance(w.peer, w.pool)).toBe(0n);
  });

  it('refuses a seed whose sqrt lands exactly ON the floor, not just under it', async () => {
    // sqrt(1000·1000) = 1000 — not strictly greater, so the seeder would walk
    // away holding zero shares of a pool holding their money. Refused.
    const w = await makeWorld();
    const r = await w.add(w.alice, 1000n, 1000n);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('opening deposit too small');
    const ok = await w.add(w.alice, 1001n, 1001n); // one unit more on each side
    expect(ok.ok).toBe(true);
    expect(await w.sharesOf(w.alice)).toBe(1n);
  });

  it('refuses zero on either side', async () => {
    const w = await makeWorld();
    for (const [p, b] of [[0n, B0], [P0, 0n], [0n, 0n]] as const) {
      const r = await w.add(w.alice, p, b);
      expect(r.ok).toBe(false);
      expect(r.revert).toBe('both amounts must be positive');
    }
  });

  it('checks the deadline on the seeding call too — one rule, no exception to remember', async () => {
    const w = await makeWorld();
    const r = await w.add(w.alice, P0, B0, 0n, PAST);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('too late');
    expect((await w.reserves()).totalShares).toBe(0n);
  });

  it('rolls the whole act back when the token pull fails', async () => {
    const w = await makeWorld();
    // bob approved nothing, so PeerToken itself refuses the transferFrom —
    // and its revert message must surface through the pool unchanged.
    const r = await w.add(w.bob, P0, B0);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('allowance exceeded');
    expect((await w.reserves()).totalShares).toBe(0n);
    expect(await w.sharesOf(ZERO)).toBe(0n); // not even the lock was written
  });

  it('emits Added with the actor indexed and the used amounts in the data', async () => {
    const w = await makeWorld();
    const r = await w.add(w.alice, E18, 1n);
    const own = w.poolLogs(r);
    expect(own).toHaveLength(1); // the other logs are the two token Transfers
    const [, topics, data] = own[0]!;
    expect(topics).toHaveLength(2); // signature, by
    expect(word(topics[1]!)).toBe(asWord(w.alice));
    expect(word(data, 0)).toBe(E18);
    expect(word(data, 1)).toBe(1n);
    expect(word(data, 2)).toBe(1_000_000_000n - MIN_LIQ);
  });

  it('cannot be re-seeded: the opening branch runs exactly once, ever', async () => {
    // This is what the locked MIN_LIQ actually buys. Drain the pool to its
    // floor and add again: the second add is PROPORTIONAL to the dust that is
    // left, not a fresh opening price. Nobody can empty this address and
    // re-open it at a number of their own invention while everyone's
    // bookmarks still point here.
    const w = await withPool();
    const mine = await w.sharesOf(w.alice);
    expect((await w.remove(w.alice, mine)).ok).toBe(true);
    const drained = await w.reserves();
    expect(drained.totalShares).toBe(MIN_LIQ);
    expect(drained.resPeer).toBeGreaterThan(0n);
    expect(drained.resBtc).toBeGreaterThan(0n);

    // A "re-seed" at a wildly different price does not set a price: it buys
    // shares at the ratio the dust already has, to the raw unit.
    const r = await w.add(w.alice, 1n * E18, 1_000_000n);
    expect(r.ok).toBe(true);
    const minted = min(
      (1n * E18 * MIN_LIQ) / drained.resPeer,
      (1_000_000n * MIN_LIQ) / drained.resBtc,
    );
    expect(word(r.ret)).toBe(minted);
    const after = await w.reserves();
    expect(after.totalShares).toBe(MIN_LIQ + minted);
    expect(after.resPeer).toBe(drained.resPeer + ceilDiv(minted * drained.resPeer, MIN_LIQ));
    expect(after.resBtc).toBe(drained.resBtc + ceilDiv(minted * drained.resBtc, MIN_LIQ));
    // And the anti-claim, which is the whole point: the reserves are NOT the
    // amounts just offered. A re-seed would have made them exactly that.
    expect(after.resPeer).not.toBe(1n * E18);
    expect(after.resBtc).not.toBe(1_000_000n);
  });

  it('says so plainly when a swap arrives before anyone has seeded it', async () => {
    const w = await makeWorld();
    const r = await w.swap(w.alice, true, E18);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('nobody has seeded this pool yet');
  });
});

describe('every later add is proportional, and pulls only what it uses', () => {
  it('mints proportionally at the current ratio and pulls exactly the two used sides', async () => {
    const w = await withPool();
    await w.fund(w.bob, 10_000n * E18, 100_000n);
    const before = await w.snapshot(w.bob);

    // Exactly 10% of each reserve — both sides bind equally.
    const r = await w.add(w.bob, P0 / 10n, B0 / 10n);
    expect(r.ok).toBe(true);
    const minted = min((P0 / 10n) * S0 / P0, (B0 / 10n) * S0 / B0);
    expect(word(r.ret)).toBe(minted);
    expect(await w.sharesOf(w.bob)).toBe(minted);

    const usedPeer = ceilDiv(minted * P0, S0);
    const usedBtc = ceilDiv(minted * B0, S0);
    const after = await w.snapshot(w.bob);
    expect(before.peer - after.peer).toBe(usedPeer);
    expect(before.btc - after.btc).toBe(usedBtc);
    const res = await w.reserves();
    expect(res.resPeer).toBe(P0 + usedPeer);
    expect(res.resBtc).toBe(B0 + usedBtc);
    expect(res.totalShares).toBe(S0 + minted);
  });

  it('at a WRONG ratio the binding side decides, and the excess never leaves the wallet', async () => {
    const w = await withPool();
    // bob offers 10% of the PEER side but 50% of the BTC side. PEER binds; he
    // should end up having spent 10% of each and still be holding 400,000 of
    // the 500,000 satoshis he was willing to put in.
    await w.fund(w.bob, 10_000n * E18, 500_000n);
    const before = await w.snapshot(w.bob);
    const r = await w.add(w.bob, 10_000n * E18, 500_000n);
    expect(r.ok).toBe(true);

    const byPeer = (10_000n * E18 * S0) / P0;
    const byBtc = (500_000n * S0) / B0;
    expect(byPeer).toBeLessThan(byBtc); // PEER is the binding side
    const minted = byPeer;
    expect(word(r.ret)).toBe(minted);

    const usedBtc = ceilDiv(minted * B0, S0);
    const after = await w.snapshot(w.bob);
    expect(before.peer - after.peer).toBe(ceilDiv(minted * P0, S0));
    expect(before.btc - after.btc).toBe(usedBtc);
    expect(usedBtc).toBeLessThan(500_000n);
    // The refund that does not exist because it never had to: 400,000-odd
    // satoshis are still bob's, in bob's wallet, never having been pulled.
    expect(after.btc).toBe(500_000n - usedBtc);
    expect(after.btc).toBeGreaterThan(390_000n);
  });

  it('rounds the pulled amounts UP where flooring would shortchange the pool', async () => {
    // Small primes chosen so the ceiling actually bites on one side. Seed
    // 1,000,003 wei against 1,000,007 sat: sqrt = 1,000,004. bob then offers
    // 7 and 7; the BTC side needs 7 where the floor would have taken 6.
    const w = await makeWorld();
    expect((await w.add(w.alice, 1_000_003n, 1_000_007n)).ok).toBe(true);
    const t = isqrt(1_000_003n * 1_000_007n);
    expect(t).toBe(1_000_004n);
    expect((await w.reserves()).totalShares).toBe(t);

    await w.fund(w.bob, 100n, 100n);
    const before = await w.snapshot(w.bob);
    const r = await w.add(w.bob, 7n, 7n);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(6n); // min(7, 6)

    const usedPeer = ceilDiv(6n * 1_000_003n, t);
    const usedBtc = ceilDiv(6n * 1_000_007n, t);
    expect([usedPeer, usedBtc]).toEqual([6n, 7n]);
    // The round-up is real: flooring would have taken 6 satoshis for shares
    // priced at 6.000018 of them, and the difference would have come out of
    // every other shareholder.
    expect(usedBtc).toBeGreaterThan((6n * 1_000_007n) / t);
    const after = await w.snapshot(w.bob);
    expect(before.peer - after.peer).toBe(6n);
    expect(before.btc - after.btc).toBe(7n);
  });

  it('refuses a deposit too small to mint a single share, and takes nothing for it', async () => {
    const w = await withPool();
    await w.fund(w.bob, E18, 100n);
    const before = await w.snapshot(w.bob);
    const r = await w.add(w.bob, 1n, 1n);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('deposit too small to mint a share');
    expect(await w.snapshot(w.bob)).toEqual(before);
    expect(await w.sharesOf(w.bob)).toBe(0n);
  });

  it('refuses zero on either side after the pool is open', async () => {
    const w = await withPool();
    const r = await w.add(w.alice, 0n, B0);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('both amounts must be positive');
  });
});

describe("the caller's own guards", () => {
  it('trips minShares when someone moves the ratio in front of a deposit', async () => {
    const w = await withPool();
    await w.fund(w.bob, 20_000n * E18, 200_000n);
    // What bob would get at the ratio he can see right now.
    const quoted = min((10_000n * E18 * S0) / P0, (100_000n * S0) / B0);

    // alice sells PEER in ahead of him: the PEER side gets heavier, so bob's
    // PEER offer buys proportionally less.
    expect((await w.swap(w.alice, true, 20_000n * E18)).ok).toBe(true);
    const r = await w.add(w.bob, 10_000n * E18, 100_000n, quoted);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('fewer shares than your minimum - the ratio moved');
    expect(await w.sharesOf(w.bob)).toBe(0n);

    // Without the guard the same deposit goes through, at the worse number —
    // which is the point: the revert was a choice bob made, not a failure.
    const r2 = await w.add(w.bob, 10_000n * E18, 100_000n);
    expect(r2.ok).toBe(true);
    expect(word(r2.ret)).toBeLessThan(quoted);
  });

  it('lets minShares through at exactly the quoted number — >=, not >', async () => {
    const w = await withPool();
    await w.fund(w.bob, 10_000n * E18, 100_000n);
    const quoted = min((10_000n * E18 * S0) / P0, (100_000n * S0) / B0);
    const r = await w.add(w.bob, 10_000n * E18, 100_000n, quoted);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(quoted);
  });

  it('trips minPeer or minBtc on the way out, whichever side was drained', async () => {
    const w = await withPool();
    const mine = await w.sharesOf(w.alice);
    const half = mine / 2n;
    // Quote the slice at today's reserves, then move the pool underneath it.
    const quotedPeer = (half * P0) / S0;
    const quotedBtc = (half * B0) / S0;

    await w.fund(w.bob, 50_000n * E18, 0n);
    expect((await w.swap(w.bob, true, 50_000n * E18)).ok).toBe(true); // BTC side thins

    const rb = await w.remove(w.alice, half, 0n, quotedBtc);
    expect(rb.ok).toBe(false);
    expect(rb.revert).toBe('below your minimum - the pool moved');
    // The PEER side got heavier, so a PEER minimum from before still clears.
    const rp = await w.remove(w.alice, half, quotedPeer, 0n);
    expect(rp.ok).toBe(true);
  });

  it('lets both withdrawal minimums through at exactly the quoted numbers — >=, not >', async () => {
    const w = await withPool();
    const half = (await w.sharesOf(w.alice)) / 2n;
    const r = await w.remove(w.alice, half, (half * P0) / S0, (half * B0) / S0);
    expect(r.ok).toBe(true);
  });

  it('trips minOut when the price moves in front of a swap', async () => {
    const w = await withPool();
    await w.fund(w.bob, 2_000n * E18, 0n);
    const quoted = swapOut(P0, B0, 1_000n * E18);
    expect((await w.swap(w.alice, true, 5_000n * E18)).ok).toBe(true); // front-run
    const before = await w.reserves();
    const r = await w.swap(w.bob, true, 1_000n * E18, quoted);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('below your minimum - the price moved');
    expect(await w.reserves()).toMatchObject({ resPeer: before.resPeer, resBtc: before.resBtc });
  });

  it('refuses an add and a swap whose deadline has passed, and changes nothing', async () => {
    const w = await withPool();
    const before = await w.reserves();
    const a = await w.add(w.alice, 1_000n * E18, 10_000n, 0n, PAST);
    expect(a.ok).toBe(false);
    expect(a.revert).toBe('too late');
    const s = await w.swap(w.alice, true, 1_000n * E18, 0n, PAST);
    expect(s.ok).toBe(false);
    expect(s.revert).toBe('too late');
    expect(await w.reserves()).toMatchObject({ resPeer: before.resPeer, resBtc: before.resBtc, totalShares: before.totalShares });
  });

  it('accepts a deadline of exactly this second — <=, not <', async () => {
    const w = await withPool();
    expect((await w.swap(w.alice, true, E18, 0n, NOW)).ok).toBe(true);
    expect((await w.add(w.alice, E18, 100n, 0n, NOW)).ok).toBe(true);
  });
});

describe('swap', () => {
  it('sells PEER at exactly the replay.cjs number: 0.3% stays in the pool, k grows, the price moves', async () => {
    const w = await withPool();
    const amtIn = 1_000n * E18;
    const expected = swapOut(P0, B0, amtIn);
    const before = await w.snapshot(w.alice);

    const r = await w.swap(w.alice, true, amtIn);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(expected);

    const res = await w.reserves();
    expect(res.resPeer).toBe(P0 + amtIn);
    expect(res.resBtc).toBe(B0 - expected);
    // Total shares untouched by a trade, so k growing IS the fee accruing to
    // every existing shareholder pro rata. No fee balance exists to steal.
    expect(res.totalShares).toBe(S0);
    expect(res.resPeer * res.resBtc).toBeGreaterThan(P0 * B0);
    // The fee is retained, not forwarded: a zero-fee pool would have paid more.
    expect(expected).toBeLessThan((B0 * amtIn) / (P0 + amtIn));
    // The price moved: PEER per satoshi is strictly higher than it was.
    expect(res.resPeer * B0).toBeGreaterThan(res.resBtc * P0);

    const after = await w.snapshot(w.alice);
    expect(before.peer - after.peer).toBe(amtIn);
    expect(after.btc - before.btc).toBe(expected);

    const [, topics, data] = w.poolLogs(r)[0]!;
    expect(word(topics[1]!)).toBe(asWord(w.alice));
    expect(word(data, 0)).toBe(1n); // sellPeer
    expect(word(data, 1)).toBe(amtIn);
    expect(word(data, 2)).toBe(expected);
  });

  it('sells BTC through the same formula mirrored', async () => {
    const w = await withPool();
    const amtIn = 10_000n; // 0.0001 BTC
    const expected = swapOut(B0, P0, amtIn);
    const r = await w.swap(w.alice, false, amtIn);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(expected);
    const res = await w.reserves();
    expect(res.resBtc).toBe(B0 + amtIn);
    expect(res.resPeer).toBe(P0 - expected);
    expect(res.resPeer * res.resBtc).toBeGreaterThan(P0 * B0);
  });

  it('refuses zero in, and a trade too small to buy one raw satoshi', async () => {
    const w = await withPool();
    const z = await w.swap(w.alice, true, 0n);
    expect(z.ok).toBe(false);
    expect(z.revert).toBe('amount in must be positive');
    // The BTC side has 8 decimals: at this price a trade under ~1e14 wei of
    // PEER buys strictly less than one satoshi, and the pool refuses to take
    // payment for nothing rather than rounding it away.
    const dust = await w.swap(w.alice, true, 10n ** 13n);
    expect(swapOut(P0, B0, 10n ** 13n)).toBe(0n);
    expect(dust.ok).toBe(false);
    expect(dust.revert).toBe('too small a trade to buy anything');
  });

  it('can thin a reserve but never empty it, however large the trade', async () => {
    const w = await withPool();
    await w.fund(w.bob, 10_000_000n * E18, 0n);
    const r = await w.swap(w.bob, true, 10_000_000n * E18); // 100x the reserve
    expect(r.ok).toBe(true);
    const res = await w.reserves();
    expect(res.resBtc).toBeGreaterThan(0n);
    expect(res.resBtc).toBeLessThan(B0 / 100n);
  });
});

describe('remove', () => {
  it('pays the proportional slice of both reserves, rounded down, and burns the shares', async () => {
    const w = await withPool();
    const mine = await w.sharesOf(w.alice);
    const take = mine / 3n;
    const before = await w.snapshot(w.alice);

    const r = await w.remove(w.alice, take);
    expect(r.ok).toBe(true);
    const outPeer = (take * P0) / S0;
    const outBtc = (take * B0) / S0;
    expect(word(r.ret, 0)).toBe(outPeer);
    expect(word(r.ret, 1)).toBe(outBtc);

    const after = await w.snapshot(w.alice);
    expect(after.peer - before.peer).toBe(outPeer);
    expect(after.btc - before.btc).toBe(outBtc);
    expect(await w.sharesOf(w.alice)).toBe(mine - take);
    const res = await w.reserves();
    expect(res.totalShares).toBe(S0 - take);
    expect(res.resPeer).toBe(P0 - outPeer);
    expect(res.resBtc).toBe(B0 - outBtc);

    const [, topics, data] = w.poolLogs(r)[0]!;
    expect(word(topics[1]!)).toBe(asWord(w.alice));
    expect([word(data, 0), word(data, 1), word(data, 2)]).toEqual([outPeer, outBtc, take]);
  });

  it('refuses more shares than held — including by exactly one', async () => {
    const w = await withPool();
    const mine = await w.sharesOf(w.alice);
    const r = await w.remove(w.alice, mine + 1n);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('more shares than you hold');
    const z = await w.remove(w.alice, 0n);
    expect(z.revert).toBe('shares to remove must be positive');
    // bob holds nothing at all and is told the same thing.
    const b = await w.remove(w.bob, 1n);
    expect(b.revert).toBe('more shares than you hold');
  });

  it('never lets the locked MIN_LIQ out — the pool thins to a floor and stops', async () => {
    const w = await withPool();
    const mine = await w.sharesOf(w.alice);
    expect((await w.remove(w.alice, mine)).ok).toBe(true);
    const res = await w.reserves();
    expect(res.totalShares).toBe(MIN_LIQ);
    expect(await w.sharesOf(ZERO)).toBe(MIN_LIQ);
    expect(await w.sharesOf(w.alice)).toBe(0n);
    // Reserves are still positive: the floor's slice stayed behind, and it is
    // real money that nobody who can sign a transaction is entitled to.
    expect(res.resPeer).toBeGreaterThan(0n);
    expect(res.resBtc).toBeGreaterThan(0n);
    expect(await w.balance(w.peer, w.pool)).toBe(res.resPeer);
    // Anyone asking for them is refused by share accounting, not by a special
    // case: they simply do not hold them.
    expect((await w.remove(w.alice, 1n)).revert).toBe('more shares than you hold');
    expect((await w.remove(w.bob, MIN_LIQ)).revert).toBe('more shares than you hold');
  });

  it('holds even against an impersonated address(0) — two independent locks, checked', async () => {
    // Stated plainly rather than implied, because it is the one guarantee
    // here that does not rest on this contract's own code.
    //
    // Lock one is secp256k1: nothing in PeerPool treats address(0) specially,
    // and it is unreachable only because no private key produces it. That is
    // a fact about the signature scheme, and an EVM harness is not bound by
    // it — so this test does what the real chain cannot, and calls remove()
    // AS address(0).
    //
    // Lock two is the token, and it holds anyway: PeerToken._transfer refuses
    // `to == address(0)` outright (its burn story lives on Bitcoin, so it has
    // no zero-address sink), and remove() pushes the PEER leg FIRST. So even
    // with the impossible signature in hand, the withdrawal reverts on PEER's
    // own rule — a rule that lives in this repository and can never change,
    // rather than in cbBTC's upgradeable proxy where it would be Coinbase's
    // to alter. The order of the two pushes is what makes that true, and it
    // is asserted here so a later reordering cannot quietly remove the lock.
    const w = await withPool();
    const before = await w.reserves();
    const r = await w.remove(ZERO, MIN_LIQ);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('transfer to the zero address');
    expect(await w.reserves()).toMatchObject({ totalShares: before.totalShares, resPeer: before.resPeer, resBtc: before.resBtc });
    expect(await w.sharesOf(ZERO)).toBe(MIN_LIQ);
  });
});

describe('reentrancy is refused, against a token that actually re-enters', () => {
  /** A pool whose BTC side is the hostile token, seeded while it is dormant. */
  async function withHostilePool() {
    const w = await makeWorld();
    const { init } = hostileTokenInitCode(poolBuild.hashes['add(uint256,uint256,uint256,uint256)']);
    const hostile = await w.deploy('0x' + init, '');
    const pool2 = await w.deploy(poolBuild.bytecode, addrWord(w.peer) + addrWord(hostile));
    await w.run(w.alice, w.peer, SEL_APPROVE + addrWord(pool2) + uint(MAX));
    const call = (sig: string, argsHex: string) => w.run(w.alice, pool2, '0x' + poolBuild.hashes[sig] + argsHex);
    // Dormant, it behaves like any ERC-20 that answers `true`, so the pool
    // opens normally. Then we arm it.
    const seed = await call('add(uint256,uint256,uint256,uint256)', uint(P0) + uint(B0) + uint(0n) + uint(SOON));
    expect(seed.ok).toBe(true);
    const arm = await w.run(w.alice, hostile, '0x00000001');
    expect(arm.ok).toBe(true);
    return { w, call, pool2, hostile };
  }

  it('refuses an add that re-enters through the token pull', async () => {
    const { call } = await withHostilePool();
    const r = await call('add(uint256,uint256,uint256,uint256)', uint(E18) + uint(10_000n) + uint(0n) + uint(SOON));
    expect(r.ok).toBe(false);
    // The pool's own reason, bubbled up through the token that raised it.
    expect(r.revert).toBe('reentered');
  });

  it('refuses a swap that re-enters through the token PUSH, not just the pull', async () => {
    // Selling PEER in means the hostile token goes OUT — a transfer, not a
    // transferFrom, and state is already written by then. The guard has to
    // cover that leg too or the write-before-call ordering is the only thing
    // standing between the pool and a drain.
    const { call } = await withHostilePool();
    const r = await call('swap(bool,uint256,uint256,uint256)', bool(true) + uint(E18) + uint(0n) + uint(SOON));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('reentered');
  });

  it('refuses a remove that re-enters, and leaves every number where it was', async () => {
    const { w, call, pool2 } = await withHostilePool();
    const shares = word((await w.run(w.alice, pool2, '0x' + poolBuild.hashes['sharesOf(address)'] + addrWord(w.alice))).ret);
    const r = await call('remove(uint256,uint256,uint256)', uint(shares / 2n) + uint(0n) + uint(0n));
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('reentered');
    const after = word((await w.run(w.alice, pool2, '0x' + poolBuild.hashes['sharesOf(address)'] + addrWord(w.alice))).ret);
    expect(after).toBe(shares);
  });

  it('is a real re-entry and not a broken token: dormant, the same calls all succeed', async () => {
    // Without this the three tests above would pass against a token that just
    // reverts, and would prove nothing about the guard.
    const w = await makeWorld();
    const { init } = hostileTokenInitCode(poolBuild.hashes['add(uint256,uint256,uint256,uint256)']);
    const hostile = await w.deploy('0x' + init, '');
    const pool2 = await w.deploy(poolBuild.bytecode, addrWord(w.peer) + addrWord(hostile));
    await w.run(w.alice, w.peer, SEL_APPROVE + addrWord(pool2) + uint(MAX));
    const call = (sig: string, argsHex: string) => w.run(w.alice, pool2, '0x' + poolBuild.hashes[sig] + argsHex);
    expect((await call('add(uint256,uint256,uint256,uint256)', uint(P0) + uint(B0) + uint(0n) + uint(SOON))).ok).toBe(true);
    expect((await call('add(uint256,uint256,uint256,uint256)', uint(E18) + uint(10_000n) + uint(0n) + uint(SOON))).ok).toBe(true);
    expect((await call('swap(bool,uint256,uint256,uint256)', bool(true) + uint(E18) + uint(0n) + uint(SOON))).ok).toBe(true);
    expect((await call('remove(uint256,uint256,uint256)', uint(1000n) + uint(0n) + uint(0n))).ok).toBe(true);
  });
});

describe('THE ATTACK: first-depositor share inflation, run end to end', () => {
  /**
   * The classic robbery, in full:
   *
   *   1. the attacker opens the pool with the smallest deposit that clears
   *      MIN_LIQ, so the pool has a handful of shares;
   *   2. the attacker DONATES tokens straight to the contract address, which
   *      in a balanceOf()-based AMM raises the value of one share enormously
   *      without minting any;
   *   3. the victim deposits. Their share count is deposit·totalShares/reserve
   *      — which now rounds to ZERO — and in the vulnerable design the pool
   *      keeps their coins and gives them nothing, and the attacker withdraws
   *      the lot.
   *
   * This contract has two independent locks on it and the test exercises
   * both, because either one alone would be enough and neither is a reason to
   * drop the other.
   */
  const SEED_PEER = 1_002_001n; // sqrt(1002001 · 1) = 1001, one share over the floor
  const DONATE_PEER = 1_000n * E18;
  const DONATE_BTC = 100_000n;
  /** The attacker is nobody special: a funded stranger, so their profit and
   *  loss can be read straight off their own balance. */
  const MALLORY = createAddressFromString('0x' + 'dead'.padStart(40, '3'));

  async function attacked() {
    const w = await makeWorld();
    await w.fund(MALLORY, 2n * DONATE_PEER, 2n * DONATE_BTC);
    const opened = await w.snapshot(MALLORY);
    // 1. open at the very floor.
    expect((await w.add(MALLORY, SEED_PEER, 1n)).ok).toBe(true);
    expect(await w.sharesOf(MALLORY)).toBe(1n);
    expect((await w.reserves()).totalShares).toBe(1001n);
    // 2. donate straight to the contract.
    await w.run(MALLORY, w.peer, SEL_TRANSFER + addrWord(w.pool) + uint(DONATE_PEER));
    await w.run(MALLORY, w.btc, SEL_TRANSFER + addrWord(w.pool) + uint(DONATE_BTC));
    return { w, opened };
  }

  it('lock one: the donation does not count, because nothing here reads its own balance', async () => {
    const { w } = await attacked();
    const res = await w.reserves();
    expect(res.resPeer).toBe(SEED_PEER); // not SEED_PEER + 1000e18
    expect(res.resBtc).toBe(1n);
    expect(res.totalShares).toBe(1001n);
    // The coins are really there — they are just not the pool's idea of its
    // own reserves, and no share entitles anyone to them.
    expect(await w.balance(w.peer, w.pool)).toBe(SEED_PEER + DONATE_PEER);
    expect(await w.balance(w.btc, w.pool)).toBe(1n + DONATE_BTC);
  });

  it('the victim does NOT get zero shares, and is made whole to the wei on the way out', async () => {
    const { w } = await attacked();
    await w.fund(w.bob, E18, 1_000n);
    const before = await w.snapshot(w.bob);

    const r = await w.add(w.bob, E18, 1_000n);
    expect(r.ok).toBe(true);
    // Not zero. The BTC side binds: 1000 satoshis against a 1-satoshi reserve
    // of 1001 shares mints 1,001,000 shares.
    expect(word(r.ret)).toBe(1_001_000n);
    expect(await w.sharesOf(w.bob)).toBe(1_001_000n);

    // Only the proportional amounts were pulled. The pool's ratio is absurd
    // (1,002,001 wei of PEER per satoshi), so bob could not put much PEER in
    // even though he offered a whole one — and the rest never left his wallet.
    const mid = await w.snapshot(w.bob);
    expect(before.peer - mid.peer).toBe(1_002_001_000n);
    expect(before.btc - mid.btc).toBe(1_000n);
    expect(mid.peer).toBeGreaterThan(E18 - 2_000_000_000n);

    // And out again: exactly what went in, to the wei and to the satoshi.
    const out = await w.remove(w.bob, 1_001_000n);
    expect(out.ok).toBe(true);
    expect(word(out.ret, 0)).toBe(1_002_001_000n);
    expect(word(out.ret, 1)).toBe(1_000n);
    expect(await w.snapshot(w.bob)).toEqual(before);
  });

  it('the attacker ends the episode POORER, measured on their own balance', async () => {
    const { w, opened } = await attacked();
    await w.fund(w.bob, E18, 1_000n);
    expect((await w.add(w.bob, E18, 1_000n)).ok).toBe(true);
    expect((await w.remove(w.bob, 1_001_000n)).ok).toBe(true);

    // Now the attacker takes everything they are entitled to: one share.
    const out = await w.remove(MALLORY, 1n);
    expect(out.ok).toBe(true);
    expect(word(out.ret, 0)).toBe(1_001n); // out of 1,002,001 wei seeded
    expect(word(out.ret, 1)).toBe(0n);

    // The whole episode, netted against the balance they started with. They
    // are down the donation plus almost all of the seed: the seed went to the
    // locked shares, the donation went nowhere at all, and the victim kept
    // every unit they deposited. There is no arrangement of these calls that
    // turns that into a profit.
    const closed = await w.snapshot(MALLORY);
    expect(closed.peer).toBeLessThan(opened.peer);
    expect(opened.peer - closed.peer).toBe(DONATE_PEER + SEED_PEER - 1_001n);
    expect(opened.btc - closed.btc).toBe(DONATE_BTC + 1n);

    const res = await w.reserves();
    expect(res.totalShares).toBe(MIN_LIQ);
    // The donation is stranded where it landed: still in the contract, in
    // nobody's reserves, owed to nobody.
    expect((await w.balance(w.peer, w.pool)) - res.resPeer).toBe(DONATE_PEER);
    expect((await w.balance(w.btc, w.pool)) - res.resBtc).toBe(DONATE_BTC);
  });

  it('lock two: a deposit that WOULD round to zero shares reverts instead of being kept', async () => {
    // This is the exact moment the classic attack collects its money — the
    // victim's shares round down to nothing while their coins stay in the
    // pool. Here the arithmetic is the same and the outcome is not: minted ==
    // 0 is refused outright, so the worst a mispriced pool can do to you is
    // waste your gas.
    const { w } = await attacked();
    await w.fund(w.bob, E18, 1_000n);
    const before = await w.snapshot(w.bob);
    const r = await w.add(w.bob, 1n, 1n); // one wei, one satoshi
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('deposit too small to mint a share');
    expect(await w.snapshot(w.bob)).toEqual(before);
    expect(await w.sharesOf(w.bob)).toBe(0n);
  });

  it('and the floor itself blocks the degenerate opening the attack starts from', async () => {

    // The cheapest version of the attack wants ONE share unit in the pool, so
    // that a donation moves the share price by the largest possible factor.
    // MIN_LIQ refuses that opening outright: the smallest pool this contract
    // will accept already has 1001 shares in it, 1000 of them unremovable.
    const w = await makeWorld();
    expect((await w.add(w.alice, 1n, 1n)).revert).toBe('opening deposit too small');
    expect((await w.add(w.alice, 1_000_000n, 1n)).revert).toBe('opening deposit too small'); // sqrt = 1000
    expect((await w.add(w.alice, 1_002_001n, 1n)).ok).toBe(true); // sqrt = 1001
    expect(await w.sharesOf(w.alice)).toBe(1n);
    expect(await w.sharesOf(ZERO)).toBe(MIN_LIQ);
  });
});

/**
 * THE OTHER ATTACK, and the one this design actually exposes: whoever seeds
 * first sets the only price this network will ever have.
 *
 * The donation attack above is defeated by the contract itself. This one is
 * not, and cannot be: the pool exists at a PUBLISHED address before it holds
 * anything — the runbook has the operator curl reserves() at it and the app
 * renders it to every visitor — the seeding branch runs once ever, and there
 * is no second market to arbitrage the difference against, that freedom having
 * been deliberately given up. The only thing standing between the intended
 * opening deposit and a stranger's is the caller's own minShares, and the
 * contract used to recommend 0 for exactly this call.
 *
 * Every figure below is the EVM's, not this file's arithmetic about it.
 */
describe('THE RACE: front-running the one seeding call there will ever be', () => {
  /** sqrt(1,100,000 · 1) = 1048 — one unit clear of MIN_LIQ, at a price of a
   *  trillion PEER to the bitcoin. The whole outlay is one satoshi and a
   *  millionth of a millionth of a PEER. */
  const SEED_PEER = 1_100_000n;
  /** 0.0000011 PEER, which is what it costs to take the money back out. */
  const SWAP_IN = 1_100_000_000_000n;
  /** The deposit the operator meant to open the pool with: 100,000 PEER
   *  against 10,000 satoshis, which is DEPLOY.md's own worked example. */
  const WANT_PEER = 100_000n * E18;
  const WANT_BTC = 10_000n;
  const MALLORY = createAddressFromString('0x' + 'dead'.padStart(40, '4'));

  async function frontRun() {
    const w = await makeWorld();
    await w.fund(MALLORY, SEED_PEER + SWAP_IN, 1n);
    const opened = await w.snapshot(MALLORY);
    expect((await w.add(MALLORY, SEED_PEER, 1n)).ok).toBe(true);
    expect((await w.reserves()).totalShares).toBe(1048n);
    expect(await w.sharesOf(MALLORY)).toBe(48n);
    return { w, opened };
  }

  it('an opening deposit with minShares = 0 quietly becomes a proportional one, and SUCCEEDS', async () => {
    const { w } = await frontRun();
    const before = await w.snapshot(w.alice);
    const r = await w.add(w.alice, WANT_PEER, WANT_BTC, 0n);
    expect(r.ok).toBe(true);

    // The bitcoin side binds, so ALL 10,000 satoshis go in — against eleven
    // billion wei, which is 0.000000011 of the 100,000 PEER that was offered.
    expect(word(r.ret)).toBe(10_480_000n);
    const after = await w.snapshot(w.alice);
    expect(before.btc - after.btc).toBe(10_000n);
    expect(before.peer - after.peer).toBe(11_000_000_000n);
    expect(await w.reserves()).toMatchObject({ resPeer: 11_001_100_000n, resBtc: 10_001n });

    // What made this succeed is that the caller named no minimum at all. The
    // shares minted are six orders of magnitude under what the same two
    // amounts would have minted on an unseeded pool, so any honest guard would
    // have refused it — which is the whole reason the next test's number is
    // the right one and 0 is never it.
    expect(word(r.ret) * 1_000_000n).toBeLessThan(isqrt(WANT_PEER * WANT_BTC) - MIN_LIQ);
  });

  it('and one swap takes 9,901 of those 10,000 satoshis straight back out', async () => {
    const { w, opened } = await frontRun();
    expect((await w.add(w.alice, WANT_PEER, WANT_BTC, 0n)).ok).toBe(true);

    const r = await w.swap(MALLORY, true, SWAP_IN);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(9_901n);

    // Netted against what the attacker started with. They are up 9,900
    // satoshis — the one they seeded with came back too — having spent
    // 1,101,100,000,000 wei of PEER in total, which is a millionth of a PEER.
    const closed = await w.snapshot(MALLORY);
    expect(closed.btc - opened.btc).toBe(9_900n);
    expect(opened.peer - closed.peer).toBe(SEED_PEER + SWAP_IN);
    // The operator, meanwhile, holds 10,480,000 share units of a pool with 100
    // satoshis left in it.
    expect((await w.reserves()).resBtc).toBe(100n);
  });

  it('minShares = sqrt(amtPeer·amtBtc) - MIN_LIQ reverts instead — the whole fix, in one number', async () => {
    const { w } = await frontRun();
    const before = await w.snapshot(w.alice);
    const guard = isqrt(WANT_PEER * WANT_BTC) - MIN_LIQ;
    expect(guard).toBe(31_622_776_600_683n); // the figure DEPLOY.md prints

    const r = await w.add(w.alice, WANT_PEER, WANT_BTC, guard);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('fewer shares than your minimum - the ratio moved');
    // Nothing moved. A refused opening is not a partial one, and this is the
    // difference between losing 9,901 satoshis and losing some gas.
    expect(await w.snapshot(w.alice)).toEqual(before);
    expect(await w.sharesOf(w.alice)).toBe(0n);
  });

  it('the same guard is exactly satisfied when the pool really is unseeded — >=, not >', async () => {
    // It has to be, or the fix would be a rule nobody could follow: the value
    // that refuses every front-run is also precisely what the seeding branch
    // mints, so the honest caller who names it is never refused by it.
    const w = await makeWorld();
    const guard = isqrt(WANT_PEER * WANT_BTC) - MIN_LIQ;
    const r = await w.add(w.alice, WANT_PEER, WANT_BTC, guard);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(guard);
    expect((await w.reserves()).totalShares).toBe(guard + MIN_LIQ);
    // One unit more is refused, which is what makes it the TIGHTEST honest
    // guard rather than merely a working one.
    const w2 = await makeWorld();
    const r2 = await w2.add(w2.alice, WANT_PEER, WANT_BTC, guard + 1n);
    expect(r2.ok).toBe(false);
    expect(r2.revert).toBe('fewer shares than your minimum - the ratio moved');
  });

  it('a front-runner who matches the intended ratio exactly gains nothing by it', async () => {
    // The guard is not "nobody may seed before you"; it is "nobody may seed
    // before you at a ratio other than yours". Somebody who opens at exactly
    // the price you were going to open at has done you no harm, and the
    // deposit goes through — at their ratio, which is yours.
    const w = await makeWorld();
    await w.fund(MALLORY, WANT_PEER, WANT_BTC);
    expect((await w.add(MALLORY, WANT_PEER / 10n, WANT_BTC / 10n)).ok).toBe(true);
    const guard = isqrt(WANT_PEER * WANT_BTC) - MIN_LIQ;
    const r = await w.add(w.alice, WANT_PEER, WANT_BTC, guard);
    expect(r.ok).toBe(true);
    // Ten times the pool at the same ratio mints ten times its shares, and the
    // only shortfall against sqrt(P·B) is the MIN_LIQ the front-runner's own
    // opening locked — which is exactly the slack the guard leaves.
    expect(word(r.ret)).toBeGreaterThanOrEqual(guard);
  });
});

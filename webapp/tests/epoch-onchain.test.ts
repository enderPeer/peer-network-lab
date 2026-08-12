/**
 * PeerAnchor and PeerClaim, executed on a real EVM — not a model of the
 * contracts, the compiled bytecode itself, running under @ethereumjs/vm.
 *
 * What must hold:
 *
 * 1. THE MERKLE PARITY, which is why this file exists at all. The earnings
 *    tree is built in JS by chain/merkle.mjs and read back in Solidity by
 *    PeerClaim. There is exactly one tree format in this project and these
 *    tests are what keeps it that way: a root computed by merkleRoot() over
 *    real (address, amount) leaves is opened on-chain, and every proof
 *    generated against it is verified BY THE CONTRACT. If the two hashings
 *    ever disagreed, every claim in production would revert and nothing else
 *    in the repo would notice — the JS side would keep producing a root it
 *    was perfectly happy with.
 * 2. An anchor cannot be revised. One row per (poster, epoch), a second
 *    attempt reverts, and a different poster's row is untouched by either.
 * 3. An epoch is funded before it is claimable: openEpoch pulls the whole
 *    total up front, once, and only the steward can call it.
 * 4. A claim pays exactly the leaf amount, exactly once, only inside the
 *    window, and only to the address the leaf commits to. Every near-miss —
 *    wrong amount, wrong claimant, another epoch's proof, a truncated proof,
 *    a proof with the sibling on the wrong side — reverts.
 * 5. The remainder returns to the steward after the deadline and not one
 *    second before. An unbound handle has no leaf, so its share is part of
 *    that remainder: asserted here, because "it stays with the operator" is a
 *    claim about money and deserves a test rather than a sentence.
 *
 * The PEER stand-in is PeerToken deployed from its own build.json bytecode,
 * byte for byte — the token that will actually be on the other end.
 *
 * House rule note: no ABI encoder and no keccak library in this file. The
 * 4-byte selectors come from the compilers' own methodIdentifiers tables in
 * the two build.json files (which doubles as a test that those tables are
 * complete), ERC-20 selectors are the hardcoded constants the repo already
 * uses, and arguments are hand-padded 32-byte words — including the dynamic
 * bytes32[] proof, whose offset/length header is written out by hand.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, hexToBytes, bytesToHex, type Address } from '@ethereumjs/util';

const tokenBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerToken.build.json', import.meta.url), 'utf8'));
const anchorBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerAnchor.build.json', import.meta.url), 'utf8'));
const claimBuild = JSON.parse(fs.readFileSync(new URL('../chain-l2/PeerClaim.build.json', import.meta.url), 'utf8'));

/**
 * The chain modules are plain .mjs and are imported by absolute file URL and
 * typed once here — the same seam tests/helpers/chain.ts uses. merkleRoot is
 * imported rather than reimplemented ON PURPOSE: a test that re-derived the
 * root from its own copy of the algorithm would prove the contract agrees
 * with the test, which is not the question anybody has.
 */
const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(join(here, '..', 'chain', f)).href);
const { merkleRoot } = (await load('merkle.mjs')) as { merkleRoot(leaves: string[]): string };
const { sha256hex } = (await load('canonical.mjs')) as { sha256hex(data: string): string };

// ERC-20 selectors, hardcoded with their signatures like everywhere else in
// the repo: approve(address,uint256), transfer(address,uint256),
// balanceOf(address).
const SEL_APPROVE = '0x095ea7b3';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_BALANCE_OF = '0x70a08231';

const E18 = 10n ** 18n;
const MAX = (1n << 256n) - 1n;

/**
 * The chain's clock. Deadlines only mean something against a real timestamp,
 * and @ethereumjs's default block sits at 0 — a world where nothing is ever
 * late. Every call runs inside one of these three blocks: NOW while the
 * window is open, DEADLINE for the boundary second itself (a claim is still
 * in time, a sweep is not), and LATE for after.
 *
 * The window is 30 days because the contract now refuses anything shorter
 * than MIN_WINDOW (7 days) or longer than MAX_WINDOW (365 days) — see
 * openEpoch. It used to be one day, which the contract would now reject.
 */
const MIN_WINDOW = 7n * 86_400n;
const MAX_WINDOW = 365n * 86_400n;
const NOW = 1_800_000_000n;
const DEADLINE = NOW + 30n * 86_400n;
const BLOCK = createBlock({ header: { number: 1n, timestamp: NOW } });
const BLOCK_AT_DEADLINE = createBlock({ header: { number: 2n, timestamp: DEADLINE } });
const BLOCK_LATE = createBlock({ header: { number: 3n, timestamp: DEADLINE + 1n } });

/** One uint256 (or bool) as a 32-byte word. */
const uint = (v: bigint) => v.toString(16).padStart(64, '0');
const addrWord = (a: Address) => a.toString().slice(2).toLowerCase().padStart(64, '0');
/** A 64-char hex hash (no 0x) as a word — already exactly one. */
const hashWord = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** The i-th 32-byte return word as a BigInt. */
const word = (ret: Uint8Array, i = 0) => BigInt('0x' + (bytesToHex(ret).slice(2).slice(64 * i, 64 * (i + 1)) || '0'));
/** The i-th return word as a bare 64-char hex string, for hash comparisons. */
const wordHex = (ret: Uint8Array, i = 0) => bytesToHex(ret).slice(2).slice(64 * i, 64 * (i + 1));
/** An address as the BigInt its word decodes to. */
const asWord = (a: Address) => BigInt(a.toString());

/** Decode a Solidity Error(string) revert payload into its message. */
function reason(ret: Uint8Array): string {
  const hex = bytesToHex(ret);
  if (!hex.startsWith('0x08c379a0')) return hex;
  const len = Number(BigInt('0x' + hex.slice(10 + 64, 10 + 128)));
  return new TextDecoder().decode(hexToBytes(`0x${hex.slice(10 + 128, 10 + 128 + len * 2)}`));
}

// ── the earnings tree, JS side ────────────────────────────────────────────
//
// The leaf string is the contract's documented preimage: 40 lowercase hex
// chars of the address, then 64 of the amount. merkleRoot() then applies the
// 'L' pass, the 'N' pairing and the carry rule — none of which is repeated
// here, because that is the code under test.

const leafHex = (who: Address, amount: bigint) =>
  who.toString().slice(2).toLowerCase().padStart(40, '0') + amount.toString(16).padStart(64, '0');

/**
 * The sibling path from one leaf up to the root, in the shape PeerClaim
 * reads: a path word whose i-th bit says the i-th sibling was the LEFT input,
 * then the siblings bottom-first. This walks merkle.mjs's own loop — a level
 * with an odd tail carries that node up and contributes NO sibling, which is
 * exactly why the directions are a bitmask over siblings rather than the
 * leaf's index in binary.
 */
function proofFor(leaves: string[], index: number): { path: bigint; sibs: string[] } {
  let level = leaves.map((h) => sha256hex('L' + h));
  let idx = index;
  const sibs: string[] = [];
  let path = 0n;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256hex('N' + level[i]! + level[i + 1]!) : level[i]!);
    }
    if (idx % 2 === 1) {
      path |= 1n << BigInt(sibs.length);
      sibs.push(level[idx - 1]!);
    } else if (idx + 1 < level.length) {
      sibs.push(level[idx + 1]!);
    }
    idx = idx >> 1;
    level = next;
  }
  return { path, sibs };
}

/**
 * Fold a proof back up in JS, the way the contract does. This is here so a
 * failure can be attributed: if this agrees with merkleRoot() and the chain
 * does not, the disagreement is Solidity's; if this disagrees too, the proof
 * builder above is the broken one. Three implementations, one answer.
 */
function foldProof(who: Address, amount: bigint, path: bigint, sibs: string[]): string {
  let node = sha256hex('L' + leafHex(who, amount));
  for (let i = 0; i < sibs.length; i++) {
    node = ((path >> BigInt(i)) & 1n) === 1n
      ? sha256hex('N' + sibs[i]! + node)
      : sha256hex('N' + node + sibs[i]!);
  }
  return node;
}

/** The bytes32[] tail: length word, then the items. The head holds the offset. */
const arrTail = (words: string[]) => uint(BigInt(words.length)) + words.join('');
/** A proof as calldata words: the path word first, then the siblings. */
const proofWords = (p: { path: bigint; sibs: string[] }) => [uint(p.path), ...p.sibs.map(hashWord)];

type CallResult = { ok: boolean; ret: Uint8Array; revert: string; logs: [Uint8Array, Uint8Array[], Uint8Array][] };

async function makeWorld() {
  const vm = await createVM();
  const evm = vm.evm;
  // The steward is also the deployer, so it holds the whole PEER supply —
  // which is the real arrangement: epoch payouts come out of the operator's
  // own holdings because the token has no mint.
  const steward = createAddressFromString('0x' + '5'.padStart(40, '5'));
  const stranger = createAddressFromString('0x' + 'b0b'.padStart(40, '2'));

  const run = async (from: Address, to: Address | undefined, dataHex: string, block = BLOCK): Promise<CallResult> => {
    const r = await evm.runCall({
      caller: from,
      origin: from,
      to,
      block,
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
    const r = (await run(steward, undefined, bytecode + argsHex)) as CallResult & { created?: Address };
    if (!r.ok || !r.created) throw new Error('deploy failed: ' + r.revert);
    return r.created;
  };

  const peer = await deploy(tokenBuild.bytecode, uint(18_250_000n));
  const anchorC = await deploy(anchorBuild.bytecode, '');
  const claimC = await deploy(claimBuild.bytecode, addrWord(peer) + addrWord(steward));

  const call = (build: { hashes: Record<string, string> }, to: Address) =>
    (from: Address, sig: string, argsHex = '', block = BLOCK) => {
      const sel = build.hashes[sig];
      if (!sel) throw new Error('no selector for ' + sig);
      return run(from, to, '0x' + sel + argsHex, block);
    };
  const anchor = call(anchorBuild, anchorC);
  const claim = call(claimBuild, claimC);

  const balance = async (who: Address) => word((await run(steward, peer, SEL_BALANCE_OF + addrWord(who))).ret);
  const approve = async (from: Address, amount: bigint) =>
    run(from, peer, SEL_APPROVE + addrWord(claimC) + uint(amount));
  const fund = async (who: Address, amount: bigint) => run(steward, peer, SEL_TRANSFER + addrWord(who) + uint(amount));
  /** The logs a call emitted from one of our own contracts (token Transfers filtered out). */
  const ownLogs = (r: CallResult, c: Address) => r.logs.filter((l) => bytesToHex(l[0]) === c.toString());

  return { run, anchor, claim, balance, approve, fund, ownLogs, steward, stranger, peer, anchorC, claimC };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

// Two believable 32-byte commitments. Their content is opaque to the
// contract — a block id and an earnings root are just words to it.
const BLOCK_ID = sha256hex('block 12');
const EARNINGS_ROOT = sha256hex('earnings 12');
/** chain/merkle.mjs's empty tree: a real, non-zero, anchorable root. */
const EMPTY_TREE = sha256hex('peer-merkle-empty');

// Claimant addresses chosen to exercise the hex conversion the leaf preimage
// needs: one with leading zeros, one that is all f's, one full of a–f digits.
const A_LOW = createAddressFromString('0x' + '5'.padStart(40, '0'));
const A_HIGH = createAddressFromString('0x' + 'f'.repeat(40));
const A_MIXED = createAddressFromString('0x' + 'deadbeef'.repeat(5));
const A_ORDINARY = createAddressFromString('0x' + '1234567890abcdef'.padStart(40, '9'));
const A_UNBOUND = createAddressFromString('0x' + '7'.repeat(40));

describe('the artifacts — what the rest of the pipeline hardcodes', () => {
  it('carries a selector for every function in the shared spec', () => {
    for (const sig of ['anchor(uint256,bytes32,bytes32)', 'anchorOf(address,uint256)']) {
      expect(anchorBuild.hashes[sig], sig).toMatch(/^[0-9a-f]{8}$/);
    }
    for (const sig of [
      'openEpoch(uint256,bytes32,uint256,uint64)',
      'claim(uint256,uint256,bytes32[])',
      'sweep(uint256)',
      'claimed(uint256,address)',
      'epochInfo(uint256)',
      'leafOf(address,uint256)',
      'checkClaim(uint256,address,uint256,bytes32[])',
      'token()',
      'steward()',
      'MIN_WINDOW()',
      'MAX_WINDOW()',
    ]) {
      expect(claimBuild.hashes[sig], sig).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(anchorBuild.bytecode).toMatch(/^0x[0-9a-f]+$/);
    expect(claimBuild.bytecode).toMatch(/^0x[0-9a-f]+$/);
  });

  it('gives PeerAnchor no privileged function of any kind', () => {
    const names = anchorBuild.abi.filter((e: { type: string }) => e.type === 'function').map((e: { name: string }) => e.name);
    expect(names.sort()).toEqual(['anchor', 'anchorOf']);
  });

  it('gives PeerClaim exactly one privileged role and no way to move or extend it', () => {
    const names: string[] = claimBuild.abi
      .filter((e: { type: string }) => e.type === 'function')
      .map((e: { name: string }) => e.name);
    // The steward is readable and immutable. Everything a reader would look
    // for to widen it is absent, and the header promises exactly that.
    expect(names).toContain('steward');
    for (const forbidden of [
      'owner', 'transferOwnership', 'setSteward', 'pause', 'unpause', 'mint',
      'upgradeTo', 'setRoot', 'closeEpoch', 'withdraw', 'rescue', 'setToken',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    // token and steward are immutable: solc renders them as view getters and
    // there is no setter to pair with either.
    const view = (n: string) => claimBuild.abi.find((e: { name?: string }) => e.name === n);
    expect(view('token').stateMutability).toBe('view');
    expect(view('steward').stateMutability).toBe('view');
  });

  it('declares the events exactly as the spec writes them', () => {
    const ev = (build: { abi: { type: string; name?: string; inputs: { type: string; name: string; indexed: boolean }[] }[] }, n: string) =>
      build.abi
        .find((e) => e.type === 'event' && e.name === n)
        ?.inputs.map((i) => [i.type, i.name, i.indexed]);
    expect(ev(anchorBuild, 'Anchored')).toEqual([
      ['address', 'by', true], ['uint256', 'epoch', true], ['bytes32', 'blockId', false],
      ['bytes32', 'earningsRoot', false], ['uint64', 'at', false],
    ]);
    expect(ev(claimBuild, 'EpochOpened')).toEqual([
      ['uint256', 'epoch', true], ['bytes32', 'root', false], ['uint256', 'total', false], ['uint64', 'claimUntil', false],
    ]);
    expect(ev(claimBuild, 'Claimed')).toEqual([
      ['uint256', 'epoch', true], ['address', 'who', true], ['uint256', 'amount', false],
    ]);
    expect(ev(claimBuild, 'Swept')).toEqual([['uint256', 'epoch', true], ['uint256', 'amount', false]]);
  });
});

describe('PeerAnchor — a timestamp that cannot be revised', () => {
  const args = (epoch: bigint, blockId: string, root: string) => uint(epoch) + hashWord(blockId) + hashWord(root);
  const anchorOf = async (w: World, poster: Address, epoch: bigint) => {
    const r = await w.anchor(w.steward, 'anchorOf(address,uint256)', addrWord(poster) + uint(epoch));
    expect(r.ok).toBe(true);
    return { blockId: wordHex(r.ret, 0), earningsRoot: wordHex(r.ret, 1), at: word(r.ret, 2), raw: r.ret };
  };

  it('records the two words under the poster, with the chain\'s own timestamp', async () => {
    const w = await makeWorld();
    const r = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, BLOCK_ID, EARNINGS_ROOT));
    expect(r.ok).toBe(true);
    const a = await anchorOf(w, w.steward, 12n);
    expect(a.blockId).toBe(BLOCK_ID);
    expect(a.earningsRoot).toBe(EARNINGS_ROOT);
    expect(a.at).toBe(NOW); // the block's, not the poster's — nobody supplied it
    expect(a.raw.length).toBe(96); // three static words, hand-decodable
  });

  it('emits Anchored with the poster and epoch indexed', async () => {
    const w = await makeWorld();
    const r = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, BLOCK_ID, EARNINGS_ROOT));
    const own = w.ownLogs(r, w.anchorC);
    expect(own).toHaveLength(1);
    const [, topics, data] = own[0]!;
    expect(topics).toHaveLength(3); // signature, by, epoch
    expect(word(topics[1]!)).toBe(asWord(w.steward));
    expect(word(topics[2]!)).toBe(12n);
    expect(wordHex(data, 0)).toBe(BLOCK_ID);
    expect(wordHex(data, 1)).toBe(EARNINGS_ROOT);
    expect(word(data, 2)).toBe(NOW);
  });

  it('refuses a second anchor for the same (poster, epoch) and keeps the first', async () => {
    const w = await makeWorld();
    expect((await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, BLOCK_ID, EARNINGS_ROOT))).ok).toBe(true);
    // The whole value of the record is that this cannot succeed — not even
    // with the identical words, and least of all with different ones.
    const rewrite = sha256hex('block 12, rewritten');
    const r = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, rewrite, EARNINGS_ROOT), BLOCK_LATE);
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('you already anchored this epoch');
    const same = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, BLOCK_ID, EARNINGS_ROOT));
    expect(same.revert).toBe('you already anchored this epoch');
    const a = await anchorOf(w, w.steward, 12n);
    expect(a.blockId).toBe(BLOCK_ID); // untouched, and still stamped at NOW
    expect(a.at).toBe(NOW);
  });

  it('lets a DIFFERENT poster anchor the same epoch, in their own row', async () => {
    // Anyone may post: the contract grants no authority, and readers decide
    // whose anchors mean anything by choosing whose address to read.
    const w = await makeWorld();
    const mine = sha256hex('block 12, as the producer sealed it');
    const theirs = sha256hex('block 12, as a stranger claims it');
    expect((await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, mine, EARNINGS_ROOT))).ok).toBe(true);
    const r = await w.anchor(w.stranger, 'anchor(uint256,bytes32,bytes32)', args(12n, theirs, EARNINGS_ROOT), BLOCK_LATE);
    expect(r.ok).toBe(true);
    const a = await anchorOf(w, w.steward, 12n);
    const b = await anchorOf(w, w.stranger, 12n);
    expect(a.blockId).toBe(mine);
    expect(b.blockId).toBe(theirs);
    expect(a.at).toBe(NOW);
    expect(b.at).toBe(DEADLINE + 1n); // each row carries its own moment
  });

  it('lets the same poster anchor a different epoch', async () => {
    const w = await makeWorld();
    expect((await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(12n, BLOCK_ID, EARNINGS_ROOT))).ok).toBe(true);
    const next = sha256hex('block 13');
    expect((await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(13n, next, EARNINGS_ROOT))).ok).toBe(true);
    expect((await anchorOf(w, w.steward, 13n)).blockId).toBe(next);
  });

  it('refuses a zero word on either side — that is a dropped argument, not a hash', async () => {
    const w = await makeWorld();
    const r1 = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', uint(1n) + uint(0n) + hashWord(EARNINGS_ROOT));
    expect(r1.revert).toBe('blockId is zero');
    const r2 = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', uint(1n) + hashWord(BLOCK_ID) + uint(0n));
    expect(r2.revert).toBe('earningsRoot is zero');
    // And nothing was recorded by either attempt.
    expect((await anchorOf(w, w.steward, 1n)).at).toBe(0n);
  });

  it('anchors an epoch whose earnings tree is empty — that root is a real hash', async () => {
    // "Nobody earned anything this epoch" is anchorable: merkle.mjs gives the
    // empty tree sha256("peer-merkle-empty"), an ordinary non-zero hash.
    const w = await makeWorld();
    expect(EMPTY_TREE).toBe(merkleRoot([]));
    expect(BigInt('0x' + EMPTY_TREE) === 0n).toBe(false);
    const r = await w.anchor(w.steward, 'anchor(uint256,bytes32,bytes32)', args(9n, BLOCK_ID, EMPTY_TREE));
    expect(r.ok).toBe(true);
    expect((await anchorOf(w, w.steward, 9n)).earningsRoot).toBe(EMPTY_TREE);
  });

  it('reads an unanchored row as three plain zeros — a mapping read, not an invention', async () => {
    const w = await makeWorld();
    const a = await anchorOf(w, w.stranger, 999n);
    expect(a.blockId).toBe('0'.repeat(64));
    expect(a.earningsRoot).toBe('0'.repeat(64));
    expect(a.at).toBe(0n); // the emptiness test a caller must not skip
  });
});

// ── the earnings tree the claim tests are built on ────────────────────────
//
// Five leaves, so the carry rule bites at more than one level: level 0 has 5
// nodes (the 5th carries), level 1 has 3 (the 3rd carries), level 2 has 2,
// level 3 is the root. Amounts are deliberately awkward — small enough to
// have leading zeros in hex, large enough to run through the a–f digits.
const EARNERS: [Address, bigint][] = [
  [A_LOW, 1n],
  [A_HIGH, 250n * E18],
  [A_MIXED, 1_337n * E18 + 424_242n],
  [A_ORDINARY, 42n],
  [createAddressFromString('0x' + 'c0ffee'.padStart(40, '3')), 9_999n * E18],
];
const LEAVES = EARNERS.map(([a, amt]) => leafHex(a, amt));
const ROOT = merkleRoot(LEAVES);
const SUM = EARNERS.reduce((s, [, amt]) => s + amt, 0n);

/** Open epoch 12 over that tree, funded with `total` (default: exactly the sum). */
async function withEpoch(total = SUM, root = ROOT) {
  const w = await makeWorld();
  await w.approve(w.steward, MAX);
  const r = await w.claim(
    w.steward,
    'openEpoch(uint256,bytes32,uint256,uint64)',
    uint(12n) + hashWord(root) + uint(total) + uint(DEADLINE),
  );
  expect(r.ok, r.revert).toBe(true);
  return w;
}
const claimArgs = (epoch: bigint, amount: bigint, p: { path: bigint; sibs: string[] }) =>
  uint(epoch) + uint(amount) + uint(0x60n) + arrTail(proofWords(p));
const epochInfo = async (w: World, epoch: bigint) => {
  const r = await w.claim(w.steward, 'epochInfo(uint256)', uint(epoch));
  expect(r.ok).toBe(true);
  return {
    raw: r.ret,
    root: wordHex(r.ret, 0),
    total: word(r.ret, 1),
    paid: word(r.ret, 2),
    claimUntil: word(r.ret, 3),
    open: word(r.ret, 4),
  };
};
const hasClaimed = async (w: World, epoch: bigint, who: Address) =>
  word((await w.claim(w.steward, 'claimed(uint256,address)', uint(epoch) + addrWord(who))).ret);

describe('THE MERKLE PARITY — one tree format, checked from both ends', () => {
  it('hashes the leaf exactly as merkle.mjs does: sha256("L" ++ addr40 ++ amount64)', async () => {
    const w = await makeWorld();
    for (const [who, amount] of EARNERS) {
      const r = await w.claim(w.steward, 'leafOf(address,uint256)', addrWord(who) + uint(amount));
      expect(r.ok).toBe(true);
      // The JS side of the preimage, spelled out here rather than imported,
      // so the two agree on the STRING and not merely on each other's code.
      expect(wordHex(r.ret)).toBe(sha256hex('L' + leafHex(who, amount)));
    }
  });

  it('pays every leaf of a merkleRoot() tree through an on-chain proof', async () => {
    // The test this file exists for. The root came out of chain/merkle.mjs
    // unchanged; the proofs walk its own loop; the verification is the
    // compiled contract's. A disagreement anywhere would revert here instead
    // of in production, where it would take every claim of every epoch with it.
    const w = await withEpoch();
    let expectedPaid = 0n;
    for (let i = 0; i < EARNERS.length; i++) {
      const [who, amount] = EARNERS[i]!;
      const p = proofFor(LEAVES, i);
      // Triangulation: the JS fold of this proof must land on the same root
      // merkleRoot() produced, or the proof builder is what is broken.
      expect(foldProof(who, amount, p.path, p.sibs)).toBe(ROOT);
      const before = await w.balance(who);
      const r = await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, p));
      expect(r.ok, `leaf ${i}: ${r.revert}`).toBe(true);
      expect((await w.balance(who)) - before).toBe(amount); // exactly the leaf
      expectedPaid += amount;
      expect((await epochInfo(w, 12n)).paid).toBe(expectedPaid);
    }
    expect(expectedPaid).toBe(SUM);
    expect(await w.balance(w.claimC)).toBe(0n); // the deposit is fully distributed
  });

  it('carries an odd node up unchanged — the 5th leaf proves it twice over', async () => {
    // Leaf 4 of 5 is carried at level 0 (no partner) and again at level 1,
    // so its proof is SHORTER than the tree is deep. If the contract assumed
    // a perfect binary tree it would fail exactly here.
    const p = proofFor(LEAVES, 4);
    expect(p.sibs.length).toBe(1); // three levels of pairing, one real sibling
    expect(p.path).toBe(1n); // and that sibling is on the left
    const w = await withEpoch();
    const [who, amount] = EARNERS[4]!;
    const r = await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, p));
    expect(r.ok, r.revert).toBe(true);
    expect(await w.balance(who)).toBe(amount);
  });

  it('handles the one-leaf tree, where the root IS the leaf and the proof is one word', async () => {
    // A real case: an epoch in which exactly one handle has a bound address.
    const only: [Address, bigint][] = [[A_ORDINARY, 7n * E18]];
    const leaves = only.map(([a, amt]) => leafHex(a, amt));
    const root = merkleRoot(leaves);
    expect(root).toBe(sha256hex('L' + leaves[0]!)); // no pairing ever happened
    const w = await withEpoch(7n * E18, root);
    const p = proofFor(leaves, 0);
    expect(p.sibs).toEqual([]);
    expect(p.path).toBe(0n);
    const r = await w.claim(A_ORDINARY, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 7n * E18, p));
    expect(r.ok, r.revert).toBe(true);
    expect(await w.balance(A_ORDINARY)).toBe(7n * E18);
  });

  it('handles a two-leaf tree, and cares which side each sibling was on', async () => {
    const two: [Address, bigint][] = [[A_LOW, 3n], [A_HIGH, 5n]];
    const leaves = two.map(([a, amt]) => leafHex(a, amt));
    const root = merkleRoot(leaves);
    const w = await withEpoch(8n, root);
    const p0 = proofFor(leaves, 0);
    const p1 = proofFor(leaves, 1);
    expect(p0.path).toBe(0n); // leaf 0's sibling is on the right
    expect(p1.path).toBe(1n); // leaf 1's sibling is on the left
    // Flip the direction bit and the same sibling hashes to something else:
    // 'N' ++ left ++ right is not 'N' ++ right ++ left, and the contract is
    // not quietly sorting the pair.
    const flipped = await w.claim(A_LOW, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 3n, { path: 1n, sibs: p0.sibs }));
    expect(flipped.revert).toBe("proof does not match this epoch's root");
    expect((await w.claim(A_LOW, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 3n, p0))).ok).toBe(true);
    expect((await w.claim(A_HIGH, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 5n, p1))).ok).toBe(true);
  });

  it('refuses a path word with meaningless high bits set — one claim, one encoding', async () => {
    const w = await withEpoch();
    const [who, amount] = EARNERS[0]!;
    const p = proofFor(LEAVES, 0);
    const junk = { path: p.path | (1n << BigInt(p.sibs.length)), sibs: p.sibs };
    const r = await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, junk));
    expect(r.revert).toBe("proof does not match this epoch's root");
    // The same proof with the junk bit cleared is fine.
    expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, p))).ok).toBe(true);
  });

  it('answers checkClaim before anyone spends gas on a revert', async () => {
    const w = await withEpoch();
    const [who, amount] = EARNERS[1]!;
    const p = proofFor(LEAVES, 1);
    const ask = (a: Address, amt: bigint, pr: typeof p, block = BLOCK) =>
      w.claim(w.steward, 'checkClaim(uint256,address,uint256,bytes32[])',
        uint(12n) + addrWord(a) + uint(amt) + uint(0x80n) + arrTail(proofWords(pr)), block);
    expect(word((await ask(who, amount, p)).ret)).toBe(1n);
    expect(word((await ask(who, amount + 1n, p)).ret)).toBe(0n); // wrong amount
    expect(word((await ask(A_UNBOUND, amount, p)).ret)).toBe(0n); // wrong claimant
    expect(word((await ask(who, amount, p, BLOCK_LATE)).ret)).toBe(0n); // window shut
    // And once the claim lands, the dry run flips to false.
    expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, p))).ok).toBe(true);
    expect(word((await ask(who, amount, p)).ret)).toBe(0n);
  });
});

describe('openEpoch — funded up front, once, by the steward alone', () => {
  it('pulls exactly the total and publishes the root', async () => {
    const w = await makeWorld();
    await w.approve(w.steward, SUM); // exactly, not MAX
    const before = await w.balance(w.steward);
    const r = await w.claim(
      w.steward,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(12n) + hashWord(ROOT) + uint(SUM) + uint(DEADLINE),
    );
    expect(r.ok, r.revert).toBe(true);
    expect(before - (await w.balance(w.steward))).toBe(SUM);
    expect(await w.balance(w.claimC)).toBe(SUM); // the coins are really here
    const e = await epochInfo(w, 12n);
    expect(e.root).toBe(ROOT);
    expect(e.total).toBe(SUM);
    expect(e.paid).toBe(0n);
    expect(e.claimUntil).toBe(DEADLINE);
    expect(e.open).toBe(1n);
    expect(e.raw.length).toBe(160); // five static words
    const [, topics, data] = w.ownLogs(r, w.claimC)[0]!;
    expect(word(topics[1]!)).toBe(12n);
    expect(wordHex(data, 0)).toBe(ROOT);
    expect(word(data, 1)).toBe(SUM);
    expect(word(data, 2)).toBe(DEADLINE);
  });

  it('cannot be opened twice, with the same root or a different one', async () => {
    const w = await withEpoch();
    const held = await w.balance(w.claimC);
    for (const root of [ROOT, sha256hex('a root that pays me everything')]) {
      const r = await w.claim(
        w.steward,
        'openEpoch(uint256,bytes32,uint256,uint64)',
        uint(12n) + hashWord(root) + uint(SUM) + uint(DEADLINE),
      );
      expect(r.ok).toBe(false);
      expect(r.revert).toBe('this epoch is already open');
    }
    expect((await epochInfo(w, 12n)).root).toBe(ROOT); // unchanged
    expect(await w.balance(w.claimC)).toBe(held); // and nothing extra was pulled
  });

  it('refuses everyone but the steward — including an address holding PEER', async () => {
    const w = await makeWorld();
    await w.fund(w.stranger, SUM);
    await w.approve(w.stranger, MAX);
    const r = await w.claim(
      w.stranger,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(12n) + hashWord(ROOT) + uint(SUM) + uint(DEADLINE),
    );
    expect(r.revert).toBe('only the steward opens an epoch');
    expect((await epochInfo(w, 12n)).root).toBe('0'.repeat(64));
  });

  it('refuses a zero root and a zero total', async () => {
    const w = await makeWorld();
    await w.approve(w.steward, MAX);
    const open = (root: string, total: bigint, until: bigint) =>
      w.claim(w.steward, 'openEpoch(uint256,bytes32,uint256,uint64)', uint(12n) + hashWord(root) + uint(total) + uint(until));
    expect((await open('0'.repeat(64), SUM, DEADLINE)).revert).toBe('root is zero');
    expect((await open(ROOT, 0n, DEADLINE)).revert).toBe('total must be positive');
    expect(await w.balance(w.claimC)).toBe(0n);
  });

  it('publishes the window bounds as constants a claimant can read', async () => {
    // Both are in the ABI on purpose: "the steward cannot sweep early" is a
    // promise about a number, and the number should come off the chain rather
    // than out of a comment.
    const w = await makeWorld();
    expect(word((await w.claim(w.steward, 'MIN_WINDOW()')).ret)).toBe(MIN_WINDOW);
    expect(word((await w.claim(w.steward, 'MAX_WINDOW()')).ret)).toBe(MAX_WINDOW);
  });

  it('refuses a window shorter than MIN_WINDOW — otherwise "cannot sweep early" says nothing', async () => {
    // The hole this closes, demonstrated rather than described: the old check
    // was `claimUntil > block.timestamp`, so NOW + 1 was a legal epoch. Base
    // makes a block every two seconds, so the steward could open an epoch and
    // sweep the entire deposit back in the very next one, while every valid
    // claim reverted as too late. A deadline is only a promise if it is far
    // enough away to be one.
    const w = await makeWorld();
    await w.approve(w.steward, MAX);
    const open = (until: bigint) =>
      w.claim(w.steward, 'openEpoch(uint256,bytes32,uint256,uint64)', uint(12n) + hashWord(ROOT) + uint(SUM) + uint(until));
    const short = 'a claim window must be at least MIN_WINDOW long';
    expect((await open(NOW - 1n)).revert).toBe(short); // already past
    expect((await open(NOW)).revert).toBe(short);      // now is not a window
    expect((await open(NOW + 1n)).revert).toBe(short); // the sweep-in-the-next-block epoch
    expect((await open(NOW + MIN_WINDOW - 1n)).revert).toBe(short);
    // And the boundary itself is accepted: >=, not >.
    expect((await open(NOW + MIN_WINDOW)).ok).toBe(true);
    expect((await epochInfo(w, 12n)).claimUntil).toBe(NOW + MIN_WINDOW);
    expect(await w.balance(w.claimC)).toBe(SUM);
  });

  it('refuses a window longer than MAX_WINDOW — a mistyped deadline locks the steward\'s own PEER', async () => {
    // This one costs claimants nothing and protects the steward: openEpoch
    // cannot be re-run, the deposit is locked until the deadline, and there is
    // no rescue function anywhere. A millisecond timestamp or a uint64 max
    // would strand the money with no way back for anybody.
    const w = await makeWorld();
    await w.approve(w.steward, MAX);
    const open = (until: bigint) =>
      w.claim(w.steward, 'openEpoch(uint256,bytes32,uint256,uint64)', uint(12n) + hashWord(ROOT) + uint(SUM) + uint(until));
    const long = 'a claim window must be at most MAX_WINDOW long';
    expect((await open((1n << 64n) - 1n)).revert).toBe(long);
    expect((await open(NOW * 1000n)).revert).toBe(long); // milliseconds, the classic
    expect((await open(NOW + MAX_WINDOW + 1n)).revert).toBe(long);
    expect((await open(NOW + MAX_WINDOW)).ok).toBe(true); // the boundary is in
    expect(await w.balance(w.claimC)).toBe(SUM);
  });

  it('opens nothing at all when the steward has not approved the pull', async () => {
    // The token itself refuses, and its message surfaces unchanged — so a
    // half-opened epoch (a published root with no deposit behind it) is not a
    // state this contract can be left in.
    const w = await makeWorld();
    const r = await w.claim(
      w.steward,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(12n) + hashWord(ROOT) + uint(SUM) + uint(DEADLINE),
    );
    expect(r.ok).toBe(false);
    expect(r.revert).toBe('allowance exceeded');
    expect((await epochInfo(w, 12n)).root).toBe('0'.repeat(64));
  });
});

describe('claim — the near misses that must all revert', () => {
  const good = () => proofFor(LEAVES, 1);
  const [WHO, AMOUNT] = EARNERS[1]!;

  it('refuses a wrong amount against a correct proof', async () => {
    const w = await withEpoch();
    for (const amt of [AMOUNT + 1n, AMOUNT - 1n, 1n]) {
      const r = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amt, good()));
      expect(r.revert).toBe("proof does not match this epoch's root");
    }
    expect(await w.balance(WHO)).toBe(0n);
    expect((await epochInfo(w, 12n)).paid).toBe(0n);
  });

  it('refuses a wrong claimant holding somebody else\'s proof', async () => {
    // The proof is verified over msg.sender, so a stolen proof is worth
    // nothing to anyone but its owner — there is no beneficiary argument to
    // redirect.
    const w = await withEpoch();
    const r = await w.claim(A_UNBOUND, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()));
    expect(r.revert).toBe("proof does not match this epoch's root");
    expect(await w.balance(A_UNBOUND)).toBe(0n);
  });

  it('refuses a proof built against another epoch\'s tree', async () => {
    const w = await withEpoch();
    // Epoch 13 pays the same people different amounts — a different tree, a
    // different root, and the two must not be interchangeable.
    const other: [Address, bigint][] = [[WHO, 1n * E18], [A_ORDINARY, 2n * E18]];
    const otherLeaves = other.map(([a, amt]) => leafHex(a, amt));
    const otherRoot = merkleRoot(otherLeaves);
    const r0 = await w.claim(
      w.steward,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(13n) + hashWord(otherRoot) + uint(3n * E18) + uint(DEADLINE),
    );
    expect(r0.ok, r0.revert).toBe(true);
    // Epoch 12's proof, presented to epoch 13.
    const cross = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(13n, AMOUNT, good()));
    expect(cross.revert).toBe("proof does not match this epoch's root");
    // And epoch 13's proof, presented to epoch 12.
    const back = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 1n * E18, proofFor(otherLeaves, 0)));
    expect(back.revert).toBe("proof does not match this epoch's root");
    // Each still works against its own epoch, so nothing above was broken for
    // an uninteresting reason.
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(13n, 1n * E18, proofFor(otherLeaves, 0)))).ok).toBe(true);
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()))).ok).toBe(true);
  });

  it('refuses a truncated proof, and an empty one', async () => {
    const w = await withEpoch();
    const p = good();
    expect(p.sibs.length).toBeGreaterThan(1);
    const short = { path: p.path, sibs: p.sibs.slice(0, -1) };
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, short))).revert)
      .toBe("proof does not match this epoch's root");
    const beheaded = { path: p.path, sibs: p.sibs.slice(1) };
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, beheaded))).revert)
      .toBe("proof does not match this epoch's root");
    // No path word at all: an empty bytes32[]. The array is well-formed, so
    // this is the contract's own check speaking, not the decoder's.
    const empty = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', uint(12n) + uint(AMOUNT) + uint(0x60n) + arrTail([]));
    expect(empty.revert).toBe("proof does not match this epoch's root");
    expect((await epochInfo(w, 12n)).paid).toBe(0n);
  });

  it('refuses a second claim from the same address, even with a perfect proof', async () => {
    const w = await withEpoch();
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()))).ok).toBe(true);
    expect(await hasClaimed(w, 12n, WHO)).toBe(1n);
    const again = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()));
    expect(again.revert).toBe('already claimed');
    expect(await w.balance(WHO)).toBe(AMOUNT); // paid once, and once only
    expect((await epochInfo(w, 12n)).paid).toBe(AMOUNT);
  });

  it('refuses zero amounts, unknown epochs, and claims after the deadline', async () => {
    const w = await withEpoch();
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, 0n, good()))).revert)
      .toBe('amount must be positive');
    expect((await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(99n, AMOUNT, good()))).revert)
      .toBe('no such epoch');
    const late = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()), BLOCK_LATE);
    expect(late.revert).toBe("too late - this epoch's claim window has closed");
    expect(await w.balance(WHO)).toBe(0n);
    expect(await hasClaimed(w, 12n, WHO)).toBe(0n);
  });

  it('accepts a claim in the deadline\'s own second — <=, not <', async () => {
    const w = await withEpoch();
    const r = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()), BLOCK_AT_DEADLINE);
    expect(r.ok, r.revert).toBe(true);
    expect(await w.balance(WHO)).toBe(AMOUNT);
    // ...and epochInfo agrees the window is still open at that second.
    const e = await w.claim(w.steward, 'epochInfo(uint256)', uint(12n), BLOCK_AT_DEADLINE);
    expect(word(e.ret, 4)).toBe(1n);
  });

  it('emits Claimed with the epoch and claimant indexed', async () => {
    const w = await withEpoch();
    const r = await w.claim(WHO, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, AMOUNT, good()));
    const own = w.ownLogs(r, w.claimC);
    expect(own).toHaveLength(1); // the other log is the token's Transfer
    const [, topics, data] = own[0]!;
    expect(word(topics[1]!)).toBe(12n);
    expect(word(topics[2]!)).toBe(asWord(WHO));
    expect(word(data, 0)).toBe(AMOUNT);
  });

  it('cannot reach another epoch\'s deposit with an oversummed root', async () => {
    // The guard that keeps epochs apart. Nothing on-chain can add a tree's
    // leaves up, so a root promising more than its deposit is possible — and
    // when it happens the overflow must hit that epoch's own claimants, never
    // the neighbour's money.
    const greedy: [Address, bigint][] = [[A_LOW, 10n * E18], [A_HIGH, 10n * E18]];
    const greedyLeaves = greedy.map(([a, amt]) => leafHex(a, amt));
    const w = await withEpoch(); // epoch 12, funded with SUM
    const r0 = await w.claim(
      w.steward,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(13n) + hashWord(merkleRoot(greedyLeaves)) + uint(15n * E18) + uint(DEADLINE),
    );
    expect(r0.ok, r0.revert).toBe(true);
    const held = await w.balance(w.claimC);
    // The first claimant is paid in full out of epoch 13's own deposit.
    expect((await w.claim(A_LOW, 'claim(uint256,uint256,bytes32[])', claimArgs(13n, 10n * E18, proofFor(greedyLeaves, 0)))).ok).toBe(true);
    // The second would need 5 PEER that epoch 13 never had. Epoch 12's
    // deposit is sitting right there in the same balance, and is not touched.
    const over = await w.claim(A_HIGH, 'claim(uint256,uint256,bytes32[])', claimArgs(13n, 10n * E18, proofFor(greedyLeaves, 1)));
    expect(over.revert).toBe("this epoch cannot pay that - the root oversums its deposit");
    expect(await w.balance(w.claimC)).toBe(held - 10n * E18);
    expect((await epochInfo(w, 12n)).paid).toBe(0n);
    expect((await epochInfo(w, 12n)).total).toBe(SUM);
    // Epoch 12's own claimants are unaffected.
    expect((await w.claim(EARNERS[1]![0], 'claim(uint256,uint256,bytes32[])', claimArgs(12n, EARNERS[1]![1], proofFor(LEAVES, 1)))).ok).toBe(true);
  });

  it('lets the steward censor an epoch with a self-leaf — the header says so, and this is why', async () => {
    // Not a bug report: a test that the contract's stated CAN list is the
    // truthful one. The header used to promise the steward "cannot stop,
    // censor, or delay a valid claim" and that there is "no state in which
    // this contract shows people a claimable root it cannot pay". Both were
    // false, in one transaction and with no timing luck, because the steward
    // writes the root and nothing on-chain can add a tree's leaves up.
    //
    // The epoch below is funded for exactly what one earner is owed, and its
    // root commits to TWO leaves of that size — the steward's own, and the
    // earner's. checkClaim tells the earner yes. Then the steward takes the
    // deposit through its own leaf and the earner's perfectly valid claim
    // reverts. Nothing here is off the documented path.
    const w = await makeWorld();
    await w.approve(w.steward, MAX);
    const pot = 100n * E18;
    const victim = A_ORDINARY;
    // Sorted so the steward's leaf and the victim's are both real leaves of
    // one two-leaf tree; which is index 0 does not matter to the outcome.
    const rigged: [Address, bigint][] = [[w.steward, pot], [victim, pot]];
    const riggedLeaves = rigged.map(([a, amt]) => leafHex(a, amt));
    const r0 = await w.claim(
      w.steward,
      'openEpoch(uint256,bytes32,uint256,uint64)',
      uint(21n) + hashWord(merkleRoot(riggedLeaves)) + uint(pot) + uint(DEADLINE),
    );
    expect(r0.ok, r0.revert).toBe(true); // ACCEPTED: nothing checks the sum

    // The victim is told yes by the contract's own dry run — a UI reading
    // checkClaim would offer this transaction.
    const ask = (a: Address, amt: bigint, i: number) =>
      w.claim(w.steward, 'checkClaim(uint256,address,uint256,bytes32[])',
        uint(21n) + addrWord(a) + uint(amt) + uint(0x80n) + arrTail(proofWords(proofFor(riggedLeaves, i))));
    expect(word((await ask(victim, pot, 1)).ret)).toBe(1n);

    // One transaction, and the epoch is empty.
    const before = await w.balance(w.steward);
    expect((await w.claim(w.steward, 'claim(uint256,uint256,bytes32[])', claimArgs(21n, pot, proofFor(riggedLeaves, 0)))).ok).toBe(true);
    expect((await w.balance(w.steward)) - before).toBe(pot);

    // The earner's claim: right address, right amount, valid proof, inside the
    // window — and refused, because the money is gone.
    const denied = await w.claim(victim, 'claim(uint256,uint256,bytes32[])', claimArgs(21n, pot, proofFor(riggedLeaves, 1)));
    expect(denied.revert).toBe('this epoch cannot pay that - the root oversums its deposit');
    expect(await w.balance(victim)).toBe(0n);
    expect(word((await ask(victim, pot, 1)).ret)).toBe(0n); // and now the dry run agrees
    // Nothing is left for a sweep to return, either: the round trip is closed.
    expect(word((await w.claim(w.stranger, 'sweep(uint256)', uint(21n), BLOCK_LATE)).ret)).toBe(0n);
    // The only defence is off-chain and it is arithmetic anyone can do: the
    // leaves sum to twice what the epoch was funded with, and that is visible
    // before the first claim, from the leaf list this repo publishes beside
    // every root.
    expect(rigged.reduce((s, [, amt]) => s + amt, 0n)).toBeGreaterThan(pot);
  });
});

describe('sweep — the remainder goes back, and not one second early', () => {
  it('returns exactly total - paid to the steward, after the deadline', async () => {
    const w = await withEpoch();
    const [who, amount] = EARNERS[0]!;
    expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, proofFor(LEAVES, 0)))).ok).toBe(true);
    const before = await w.balance(w.steward);
    const r = await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE);
    expect(r.ok, r.revert).toBe(true);
    expect(word(r.ret)).toBe(SUM - amount);
    expect((await w.balance(w.steward)) - before).toBe(SUM - amount);
    expect(await w.balance(w.claimC)).toBe(0n); // the contract holds nothing after
    const e = await w.claim(w.steward, 'epochInfo(uint256)', uint(12n), BLOCK_LATE);
    expect(word(e.ret, 2)).toBe(amount); // paid, still on the record
    expect(word(e.ret, 4)).toBe(0n); // no longer open
    const [, topics, data] = w.ownLogs(r, w.claimC)[0]!;
    expect(word(topics[1]!)).toBe(12n);
    expect(word(data, 0)).toBe(SUM - amount);
  });

  it('returns an unbound handle\'s whole share — it was never in the tree', async () => {
    // The binding problem's honest consequence, as money. This epoch was
    // funded for SUM + 500 PEER because one earner had no bound address, so
    // there is no leaf for them; their share is not redistributed, not held
    // in escrow, and comes back to the steward at sweep.
    const unclaimedShare = 500n * E18;
    const w = await withEpoch(SUM + unclaimedShare);
    for (let i = 0; i < EARNERS.length; i++) {
      const [who, amount] = EARNERS[i]!;
      expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, proofFor(LEAVES, i)))).ok).toBe(true);
    }
    // The unbound address can prove nothing, because nothing about it was
    // committed to.
    const nothing = await w.claim(A_UNBOUND, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, unclaimedShare, proofFor(LEAVES, 0)));
    expect(nothing.revert).toBe("proof does not match this epoch's root");
    const before = await w.balance(w.steward);
    const r = await w.claim(w.stranger, 'sweep(uint256)', uint(12n), BLOCK_LATE);
    expect(r.ok, r.revert).toBe(true);
    expect(word(r.ret)).toBe(unclaimedShare);
    expect((await w.balance(w.steward)) - before).toBe(unclaimedShare);
  });

  it('refuses to sweep before the deadline, and in the deadline\'s own second', async () => {
    const w = await withEpoch();
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(12n))).revert)
      .toBe('too early - the claim window is still open');
    // The boundary: claim accepts this second, so sweep must not — otherwise
    // the last second of an epoch is a race.
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_AT_DEADLINE)).revert)
      .toBe('too early - the claim window is still open');
    expect(await w.balance(w.claimC)).toBe(SUM);
  });

  it('sweeps once, and refuses an unknown epoch', async () => {
    const w = await withEpoch();
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE)).ok).toBe(true);
    const again = await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE);
    expect(again.revert).toBe('already swept');
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(77n), BLOCK_LATE)).revert).toBe('no such epoch');
  });

  it('sweeps a fully-claimed epoch to zero without moving a token', async () => {
    const w = await withEpoch();
    for (let i = 0; i < EARNERS.length; i++) {
      const [who, amount] = EARNERS[i]!;
      expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, proofFor(LEAVES, i)))).ok).toBe(true);
    }
    const r = await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE);
    expect(r.ok).toBe(true);
    expect(word(r.ret)).toBe(0n);
    // The epoch still closes — flag and event — but no transfer was made for
    // nothing: the only log is the contract's own Swept.
    expect(r.logs).toHaveLength(1);
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE)).revert).toBe('already swept');
  });

  it('leaves a claim that landed before the sweep alone', async () => {
    const w = await withEpoch();
    const [who, amount] = EARNERS[2]!;
    expect((await w.claim(who, 'claim(uint256,uint256,bytes32[])', claimArgs(12n, amount, proofFor(LEAVES, 2)))).ok).toBe(true);
    expect((await w.claim(w.steward, 'sweep(uint256)', uint(12n), BLOCK_LATE)).ok).toBe(true);
    // Paid is paid: the sweep took the remainder, not the payment.
    expect(await w.balance(who)).toBe(amount);
    expect(await hasClaimed(w, 12n, who)).toBe(1n);
  });
});

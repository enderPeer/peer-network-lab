/**
 * The crossing: a closed epoch's token distribution turned into something a
 * chain can pay.
 *
 * Everything upstream of here is a number in a log. Everything downstream is
 * money. So these tests are about the properties that decide whether the two
 * halves can ever disagree:
 *
 * 1. DETERMINISM. Two builders holding the same log must produce the same
 *    root, or the root published on Base commits to a tree nobody else can
 *    reproduce. Ordering is asserted explicitly rather than assumed from a
 *    happy accident of object key order.
 * 2. THE PROOF ACTUALLY PROVES. Every proof is folded back up here by an
 *    implementation written out longhand in this file — not by the module's
 *    own folder, which would only prove the module agrees with itself. The
 *    Solidity side of the same question lives in epoch-onchain.test.ts, where
 *    the compiled contract verifies these proofs on a real EVM.
 * 3. AN UNBOUND HANDLE IS EXCLUDED AND SAID SO. "Their share stays with the
 *    operator" is a claim about somebody's money and gets a test, not a
 *    sentence: no leaf, not in the total, named in `unbound`, and the missing
 *    amount accounted for down to the raw unit.
 * 4. REBINDING IS FORWARD ONLY. A root published for epoch 12 must not move
 *    because somebody rebound in epoch 13. This is the property the whole
 *    per-epoch snapshot exists for, and it is tested by rebuilding an old
 *    epoch from today's map and watching the root change — which is exactly
 *    what must never happen in production.
 *
 * The host half at the bottom runs against a real server process on a
 * throwaway data directory, because the PIN gate, the refusal codes and the
 * claim endpoint exist only in the request path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { replay, seed } from './helpers/world';

// The chain modules are plain .mjs, imported by absolute file URL and typed
// once here — the same seam helpers/chain.ts and epoch-onchain.test.ts use.
const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(join(here, '..', 'chain', f)).href);

interface Leaf { index: number; address: string; amount: bigint; peer: number; handles: string[]; hex: string }
interface Proof { path: bigint; siblings: string[]; words: string[] }
interface Tree {
  epoch: number; root: string; total: bigint; totalPeer: number;
  leaves: Leaf[]; proofs: Record<string, Proof>;
  unbound: { handles: Array<{ id: string; amount: bigint; peer: number }>; total: bigint; totalPeer: number };
  zero: Array<{ id: string; address: string }>; minted: number | null; decimals: number;
}
const earnings = (await load('earnings.mjs')) as {
  earningsTree(dist: unknown, bindings: Record<string, string>): Tree;
  verifyProof(root: string, address: string, raw: bigint, words: string[]): boolean;
  leafHex(address: string, raw: bigint): string;
  toRaw(peer: number): bigint;
  toPeer(raw: bigint): number;
  cleanAddress(a: unknown): string;
  EMPTY_ROOT: string;
  PEER_DECIMALS: number;
};
const { merkleRoot } = (await load('merkle.mjs')) as { merkleRoot(leaves: string[]): string };
const { sha256hex } = (await load('canonical.mjs')) as { sha256hex(data: string): string };

// ── fixtures ───────────────────────────────────────────────────────────────
//
// Addresses whose byte order deliberately disagrees with the handle order, so
// a test that passes cannot be passing because the two happened to coincide.
const ADDR = {
  al: '0x' + 'f'.repeat(40),                       // sorts LAST, handle sorts first
  bo: '0x' + '1'.repeat(40),                       // sorts first
  cy: '0x' + '8'.repeat(40),                       // sorts between them
  other: '0x' + 'deadbeef'.repeat(5),
};
const post = (who: string, text: string) => ({ t: 'post', author: 'u_' + who, text, a: 0.8, rmen: [] });
const like = (who: string, cid: string) => ({ t: 'opinion', author: 'u_' + who, target: cid, p: 0.8, r: 0.8 });
const close = (n = 1) => ({ t: 'closeEpoch', epoch: n });
const bind = (who: string, addr: string) => ({ t: 'bindAddress', id: 'u_' + who, addr });

/** Three earners, each drawing one reaction, so every share is equal and the
 *  ordering under test cannot be ordering by amount in disguise. */
function threeEarners(binds: Array<Record<string, unknown>> = []) {
  return [
    ...seed('al', 'bo', 'cy'),
    ...binds,
    post('al', 'A'), post('bo', 'B'), post('cy', 'C'),   // c1, c2, c3
    like('cy', 'c1'), like('al', 'c2'), like('bo', 'c3'),
    close(),
  ];
}
const state = (acts: unknown[]) => replay(acts) as unknown as {
  tokens: { dist: Array<{ epoch: number; minted: number; to: Record<string, number> }>; epochN: number };
  addresses: Record<string, string>;
  addressesAt: Record<number, Record<string, string>>;
  payloads: Record<string, string>;
  g: { nodes: Map<string, unknown> };
};

/**
 * Fold a proof back up to a root, written out here rather than imported.
 *
 * A test that called the module's own foldProof would establish that the
 * module agrees with itself, which nobody doubts. This is the second
 * implementation; PeerClaim._verify is the third, and epoch-onchain.test.ts
 * runs it on real bytecode.
 */
function foldByHand(address: string, raw: bigint, words: string[]): string {
  const path = BigInt(words[0]!);
  let node = sha256hex('L' + address.slice(2).toLowerCase().padStart(40, '0') + raw.toString(16).padStart(64, '0'));
  for (let i = 1; i < words.length; i++) {
    const sib = words[i]!.replace(/^0x/, '');
    node = ((path >> BigInt(i - 1)) & 1n) === 1n ? sha256hex('N' + sib + node) : sha256hex('N' + node + sib);
  }
  return node;
}

describe('the leaf, and the units under it', () => {
  it('writes the preimage PeerClaim reads back: 40 hex of address, 64 of amount', () => {
    // Spelled out rather than imported, so the two sides agree on the STRING
    // and not merely on each other's code.
    expect(earnings.leafHex(ADDR.other, 1n)).toBe('deadbeef'.repeat(5) + '0'.repeat(63) + '1');
    expect(earnings.leafHex(ADDR.al, 0n)).toBe('f'.repeat(40) + '0'.repeat(64));
    expect(earnings.leafHex(ADDR.al, 1n).length).toBe(104);
  });

  it('converts the log\'s 1e-6 grid to 18 decimals exactly, and refuses anything off it', () => {
    expect(earnings.toRaw(5000)).toBe(5000n * 10n ** 18n);
    expect(earnings.toRaw(0.000001)).toBe(10n ** 12n);
    expect(earnings.toRaw(1666.666666)).toBe(1666666666n * 10n ** 12n);
    expect(earnings.toPeer(1666666666n * 10n ** 12n)).toBeCloseTo(1666.666666, 6);
    // Half a micro-token is not a number this log can produce, so it is a
    // signal that the input is not a tokenDist entry — refused, never rounded.
    expect(() => earnings.toRaw(0.0000005)).toThrow(/grid/);
    expect(() => earnings.toRaw(NaN)).toThrow(/finite/);
    expect(() => earnings.toRaw(-1)).toThrow(/negative/);
    // Nothing above the token's whole fixed supply is a real earning, and
    // above ~4.5e9 PEER one ULP exceeds a micro-token, so the grid test would
    // stop being able to tell grid points apart. Refused rather than guessed.
    expect(() => earnings.toRaw(18_250_001)).toThrow(/out of range/);
  });

  it('accepts LARGE on-grid amounts — the ones the float multiply used to refuse', () => {
    // The bug this test exists for. toRaw multiplied by 1e6 and compared the
    // product to its own rounding against a fixed 1e-6 tolerance, reasoning
    // about the SIZE of the result when the error that matters is the ULP of
    // the PRODUCT. Above 2^34 micro-tokens — 16,384 PEER — one ULP is already
    // four times that tolerance, so amounts replay.cjs itself produces were
    // called off-grid. 16532.065613 × 1e6 is 16532065612.999998 in a double.
    //
    // It took the whole epoch with it, not one leaf: earningsTree throws on
    // the first bad amount, so no root could be computed for anybody and
    // nothing could be anchored or opened on Base. Ordinary to reach, too —
    // an unengaged epoch carries its entire pool forward, so three or four of
    // them put one dominant earner over the line.
    expect(earnings.toRaw(16532.065613)).toBe(16532065613n * 10n ** 12n);
    expect(earnings.toRaw(16384.000003)).toBe(16384000003n * 10n ** 12n);
    expect(earnings.toRaw(18249999.999999)).toBe(18249999999999n * 10n ** 12n);
    expect(earnings.toRaw(12345678.910111)).toBe(12345678910111n * 10n ** 12n);
    // Every on-grid amount across the whole supply, not a handful of samples:
    // 20,000 draws over the range the old check failed 2–3% of the time.
    for (let i = 0; i < 20_000; i++) {
      const micro = Math.floor(Math.random() * 1.825e13);
      expect(earnings.toRaw(micro / 1e6), String(micro)).toBe(BigInt(micro) * 10n ** 12n);
    }
    // …and it is still exact rather than merely tolerant: genuinely off-grid
    // input is refused at every size.
    expect(() => earnings.toRaw(16532.0656135)).toThrow(/grid/);
    expect(() => earnings.toRaw(0.1 + 0.2)).toThrow(/grid/);
    expect(() => earnings.toRaw(1.23456789)).toThrow(/grid/);
  });

  it('builds a whole tree over amounts past the old threshold', () => {
    // The blast radius, as a tree rather than a unit: one large earner used to
    // make earningsTree throw and take every other claimant of that epoch with
    // it, permanently, because it is a pure function of the log.
    const dist = { epoch: 7, minted: 33064.131226, to: { u_al: 16532.065613, u_bo: 16532.065613 } };
    const tree = earnings.earningsTree(dist, { u_al: ADDR.al, u_bo: ADDR.bo });
    expect(tree.leaves).toHaveLength(2);
    expect(tree.total).toBe(2n * 16532065613n * 10n ** 12n);
    expect(tree.root).toBe(merkleRoot(tree.leaves.map((l) => l.hex)));
    for (const leaf of tree.leaves) {
      expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, tree.proofs[leaf.address]!.words)).toBe(true);
    }
  });

  it('refuses the zero address and anything that is not 20 bytes', () => {
    expect(earnings.cleanAddress('0x' + '0'.repeat(40))).toBe('');
    expect(earnings.cleanAddress('0x123')).toBe('');
    expect(earnings.cleanAddress('0x' + 'g'.repeat(40))).toBe('');
    // A checksummed address is the same twenty bytes and is folded, not refused.
    expect(earnings.cleanAddress('0x' + 'F'.repeat(40))).toBe('0x' + 'f'.repeat(40));
  });

  it('gives an epoch nobody could be paid for the empty tree, which is a real hash', () => {
    const tree = earnings.earningsTree({ epoch: 9, minted: 0, to: {} }, {});
    expect(tree.root).toBe(sha256hex('peer-merkle-empty'));
    expect(tree.root).toBe(earnings.EMPTY_ROOT);
    expect(tree.total).toBe(0n);
    expect(tree.leaves).toHaveLength(0);
    // Non-zero, so PeerAnchor accepts it: "nobody earned anything" is a
    // publishable fact, and only a missing argument is not.
    expect(tree.root).not.toBe('0'.repeat(64));
  });
});

describe('ordering and root stability', () => {
  it('orders leaves by address, ascending — not by handle, not by amount', () => {
    const st = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo), bind('cy', ADDR.cy)]));
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.leaves.map((l) => l.address)).toEqual([ADDR.bo, ADDR.cy, ADDR.al]);
    // …which is NOT the handle order, and the amounts are all equal, so
    // neither could have produced this sequence by accident.
    expect(tree.leaves.map((l) => l.handles[0])).toEqual(['u_bo', 'u_cy', 'u_al']);
    expect(new Set(tree.leaves.map((l) => String(l.amount))).size).toBe(1);
  });

  it('produces the same root from the same log, every time and in any key order', () => {
    const acts = threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo), bind('cy', ADDR.cy)]);
    const a = earnings.earningsTree(state(acts).tokens.dist[0]!, state(acts).addressesAt[1]!);
    const b = earnings.earningsTree(state(acts).tokens.dist[0]!, state(acts).addressesAt[1]!);
    expect(b.root).toBe(a.root);
    expect(b.leaves.map((l) => l.hex)).toEqual(a.leaves.map((l) => l.hex));

    // Same distribution, keys handed over in the opposite order and bindings
    // in a different order again. The tree commits to a SET, so the root must
    // not depend on how the map was walked.
    const dist = state(acts).tokens.dist[0]!;
    const flipped = { epoch: dist.epoch, minted: dist.minted, to: {} as Record<string, number> };
    for (const id of Object.keys(dist.to).reverse()) flipped.to[id] = dist.to[id]!;
    const c = earnings.earningsTree(flipped, { u_cy: ADDR.cy, u_al: ADDR.al, u_bo: ADDR.bo });
    expect(c.root).toBe(a.root);
  });

  it('is exactly chain/merkle.mjs over the leaf strings — one implementation, checked', () => {
    const st = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo), bind('cy', ADDR.cy)]));
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.root).toBe(merkleRoot(tree.leaves.map((l) => l.hex)));
  });

  it('mints no content node and shifts no content id', () => {
    // Ids are minted by a replay counter and later acts name them, so an act
    // that quietly ticked it would repoint every reference after it.
    const without = state(threeEarners());
    const with_ = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo)]));
    expect(Object.keys(with_.payloads).sort()).toEqual(Object.keys(without.payloads).sort());
    expect(with_.g.nodes.size).toBe(without.g.nodes.size);
    expect(with_.tokens.dist[0]!.to).toEqual(without.tokens.dist[0]!.to);
  });
});

describe('proofs', () => {
  it('every leaf gets a proof that folds back to the root', () => {
    const st = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo), bind('cy', ADDR.cy)]));
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.leaves).toHaveLength(3);
    for (const leaf of tree.leaves) {
      const proof = tree.proofs[leaf.address]!;
      expect(foldByHand(leaf.address, leaf.amount, proof.words)).toBe(tree.root);
      expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, proof.words)).toBe(true);
      // Every word is a bytes32 the way a wallet would pass it.
      for (const w of proof.words) expect(w).toMatch(/^0x[0-9a-f]{64}$/);
    }
    // Three leaves: level 0 pairs the first two and carries the third, so the
    // carried leaf's proof has ONE sibling and the paired ones have two. That
    // is why directions are a bitmask over siblings rather than a leaf index.
    expect(tree.proofs[tree.leaves[2]!.address]!.words.length).toBe(2);
    expect(tree.proofs[tree.leaves[0]!.address]!.words.length).toBe(3);
  });

  it('refuses the near misses: wrong amount, wrong claimant, a truncated proof, a flipped side', () => {
    const st = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo), bind('cy', ADDR.cy)]));
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    const leaf = tree.leaves[0]!;
    const p = tree.proofs[leaf.address]!;
    expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount + 1n, p.words)).toBe(false);
    expect(earnings.verifyProof(tree.root, ADDR.other, leaf.amount, p.words)).toBe(false);
    expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, p.words.slice(0, -1))).toBe(false);
    expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, [])).toBe(false);
    // The path word with its bits inverted: same siblings, wrong sides.
    const flipped = ['0x' + (p.path ^ ((1n << BigInt(p.words.length - 1)) - 1n)).toString(16).padStart(64, '0'), ...p.words.slice(1)];
    expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, flipped)).toBe(false);
    // Bits above the sibling count must be zero: one claim, one encoding.
    const padded = ['0x' + ((1n << 200n) | p.path).toString(16).padStart(64, '0'), ...p.words.slice(1)];
    expect(earnings.verifyProof(tree.root, leaf.address, leaf.amount, padded)).toBe(false);
  });

  it('a single-leaf tree is the root itself, proved by one empty path word', () => {
    const st = state([...seed('al', 'bo'), bind('al', ADDR.al), post('al', 'A'), like('bo', 'c1'), close()]);
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.leaves).toHaveLength(1);
    const p = tree.proofs[ADDR.al]!;
    expect(p.words).toEqual(['0x' + '0'.repeat(64)]);
    expect(tree.root).toBe(sha256hex('L' + tree.leaves[0]!.hex));
    expect(earnings.verifyProof(tree.root, ADDR.al, tree.leaves[0]!.amount, p.words)).toBe(true);
  });
});

describe('what is NOT in the tree', () => {
  it('excludes an unbound handle, reports it, and accounts for every raw unit', () => {
    const st = state(threeEarners([bind('al', ADDR.al), bind('bo', ADDR.bo)]));   // cy binds nothing
    const dist = st.tokens.dist[0]!;
    const tree = earnings.earningsTree(dist, st.addressesAt[1]!);

    expect(tree.leaves).toHaveLength(2);
    expect(tree.leaves.map((l) => l.address).includes(ADDR.cy)).toBe(false);
    expect(tree.unbound.handles.map((u) => u.id)).toEqual(['u_cy']);
    expect(tree.unbound.total).toBe(earnings.toRaw(dist.to.u_cy!));
    expect(tree.unbound.total).toBeGreaterThan(0n);

    // The whole distribution is accounted for: what the tree can pay, plus
    // what nobody can claim, is what the epoch credited. Nothing was silently
    // redistributed to the two who did bind — their leaves are unchanged.
    let credited = 0n;
    for (const id of Object.keys(dist.to)) credited += earnings.toRaw(dist.to[id]!);
    expect(tree.total + tree.unbound.total).toBe(credited);
    const all = earnings.earningsTree(dist, { u_al: ADDR.al, u_bo: ADDR.bo, u_cy: ADDR.cy });
    for (const leaf of tree.leaves) {
      expect(all.leaves.find((l) => l.address === leaf.address)!.amount).toBe(leaf.amount);
    }
    // …and the roots differ, which is the honest consequence: who is bound is
    // part of what the epoch commits to.
    expect(all.root).not.toBe(tree.root);
  });

  it('gives handles that share one address a single merged leaf', () => {
    // PeerClaim records claimed[epoch][msg.sender] — one flag per address per
    // epoch — so a second leaf for the same address would be unclaimable
    // forever. Merging is not a convenience, it is the only correct shape.
    const st = state(threeEarners([bind('al', ADDR.other), bind('bo', ADDR.other), bind('cy', ADDR.cy)]));
    const dist = st.tokens.dist[0]!;
    const tree = earnings.earningsTree(dist, st.addressesAt[1]!);
    expect(tree.leaves).toHaveLength(2);
    const merged = tree.leaves.find((l) => l.address === ADDR.other)!;
    expect(merged.handles).toEqual(['u_al', 'u_bo']);
    expect(merged.amount).toBe(earnings.toRaw(dist.to.u_al!) + earnings.toRaw(dist.to.u_bo!));
    expect(earnings.verifyProof(tree.root, merged.address, merged.amount, tree.proofs[merged.address]!.words)).toBe(true);
  });

  it('keeps a binding through the deletion of the account that made it', () => {
    // Deletion removes payload. A binding is not payload — it is where money
    // goes — and the distribution already keeps a departed account's tokens,
    // so dropping the address would strand earnings the log still owes.
    const acts = [...seed('al', 'bo'), bind('al', ADDR.al), post('al', 'A'), like('bo', 'c1'), close(),
      { t: 'deleteAccount', id: 'u_al' }];
    const st = state(acts);
    expect(st.addresses.u_al).toBe(ADDR.al);
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.leaves[0]!.address).toBe(ADDR.al);
    expect(tree.unbound.handles).toHaveLength(0);
  });

  it('ignores a malformed or zero address in the log rather than minting a leaf for it', () => {
    // Shape is checked at the host door AND here, because this file is what a
    // foreign or hand-edited log passes through.
    const st = state([...seed('al', 'bo'),
      { t: 'bindAddress', id: 'u_al', addr: '0xnothex' },
      { t: 'bindAddress', id: 'u_bo', addr: '0x' + '0'.repeat(40) },
      post('al', 'A'), like('bo', 'c1'), close()]);
    expect(st.addresses.u_al).toBeUndefined();
    expect(st.addresses.u_bo).toBeUndefined();
    const tree = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(tree.leaves).toHaveLength(0);
    expect(tree.unbound.handles.map((u) => u.id)).toEqual(['u_al']);
    expect(tree.root).toBe(earnings.EMPTY_ROOT);
  });
});

describe('rebinding is forward only', () => {
  // One post, engaged with in both epochs by different people — so al earns
  // twice without a second post. (Content ids are minted by a replay counter
  // that also ticks for hyperedge legs, so a second post is NOT c2; the repo's
  // standing advice is to read ids rather than derive them, and the cheapest
  // way to obey it in a fixture is to need only the first one.)
  const acts = [
    ...seed('al', 'bo', 'cy'),
    bind('al', ADDR.al),
    post('al', 'A'), like('bo', 'c1'), close(1),      // epoch 1 pays ADDR.al
    bind('al', ADDR.other),                            // …then al moves wallets
    like('cy', 'c1'), close(2),                        // epoch 2 pays ADDR.other
  ];

  it('pays each epoch to the address bound when THAT epoch closed', () => {
    const st = state(acts);
    expect(st.addresses.u_al).toBe(ADDR.other);              // newest wins, now
    expect(st.addressesAt[1]!.u_al).toBe(ADDR.al);           // frozen at close
    expect(st.addressesAt[2]!.u_al).toBe(ADDR.other);

    const e1 = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    const e2 = earnings.earningsTree(st.tokens.dist[1]!, st.addressesAt[2]!);
    expect(e1.leaves[0]!.address).toBe(ADDR.al);
    expect(e2.leaves[0]!.address).toBe(ADDR.other);
    expect(e1.root).not.toBe(e2.root);
  });

  it('would move a published root if today\'s map were used — which is why it is not', () => {
    const st = state(acts);
    const asPublished = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    const asToday = earnings.earningsTree(st.tokens.dist[0]!, st.addresses);
    expect(asToday.root).not.toBe(asPublished.root);
    expect(asToday.leaves[0]!.address).toBe(ADDR.other);
    // Same money either way — only the destination moved. That is precisely
    // why the snapshot exists: nothing about the epoch changed, so nothing
    // about its root may.
    expect(asToday.total).toBe(asPublished.total);
  });

  it('leaves an epoch that closed before any binding existed with no leaves at all', () => {
    const st = state([...seed('al', 'bo', 'cy'), post('al', 'A'), like('bo', 'c1'), close(1),
      bind('al', ADDR.al), like('cy', 'c1'), close(2)]);
    expect(Object.keys(st.addressesAt[1]!)).toHaveLength(0);
    const e1 = earnings.earningsTree(st.tokens.dist[0]!, st.addressesAt[1]!);
    expect(e1.leaves).toHaveLength(0);
    expect(e1.root).toBe(earnings.EMPTY_ROOT);
    expect(e1.unbound.handles.map((u) => u.id)).toEqual(['u_al']);
    // Binding later does not reach back for it, and does not have to: the
    // share was never in a tree, so it never left the operator.
    expect(earnings.earningsTree(st.tokens.dist[1]!, st.addressesAt[2]!).leaves).toHaveLength(1);
  });
});

// ── the door ───────────────────────────────────────────────────────────────

const PORT = 5341;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
const PIN = '1234';
const hash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');
const HOST_ADDR = '0x' + 'a5'.repeat(20);

let child: ChildProcess;
let dir: string;

// ── one passkey, for real ──────────────────────────────────────────────────
//
// The handle secured by a passkey and NOTHING else is the case that was
// locked out of binding entirely: "is this handle secured?" was answered from
// the PIN index alone, so the strongest credential in this codebase read as no
// credential at all and the refusal told its owner to go and set a weaker one.
// Nothing here is mocked — a real P-256 key signs a real challenge, and the
// host's own webauthn.mjs decides.
const CRED_ID = 'cred-for-binding';
let pkPrivate: KeyObject;
let pkCose: unknown[];
function makePasskey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  pkPrivate = privateKey;
  pkCose = [[1, 2], [3, -7], [-1, 1], [-2, jwk.x], [-3, jwk.y]];
}
/** Sign a challenge the way the browser would, and shape it the way authError reads it. */
function assertion(challenge: string, counter = 7) {
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: BASE }));
  const authData = Buffer.concat([
    // RP_ID is unset on this host, so it defaults to 'localhost'.
    createHash('sha256').update('localhost').digest(),
    Buffer.from([0x05]),                       // user present + user verified
    Buffer.from([0, 0, 0, counter]),
  ]);
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  const der = createSign('SHA256').update(signed).sign(pkPrivate);
  const rl = der[3]!;
  const sl = der[4 + rl + 1]!;
  const pad = (b: Buffer) => Buffer.concat([Buffer.alloc(Math.max(0, 32 - b.length)), b.subarray(Math.max(0, b.length - 32))]);
  const raw = Buffer.concat([pad(der.subarray(4, 4 + rl)), pad(der.subarray(4 + rl + 2, 4 + rl + 2 + sl))]);
  return {
    credId: CRED_ID,
    challenge,
    signCount: counter,
    clientDataJSON: clientData.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: raw.toString('base64url'),
  };
}
const freshChallenge = async (as: string) => (await post_('/api/auth/challenge', { as })).body.challenge as string;

async function post_(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function get_(path: string) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

describe('the host: binding, and the claim endpoint', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-earn-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    // A log that already has a closed epoch with one bound earner, so the read
    // side has something real to answer with. Written as file lines rather
    // than posted, because these acts are not what is under test here.
    const log: Record<string, unknown>[] = [];
    for (const id of ['u_earn', 'u_fan']) {
      log.push({ t: 'register', id, handle: id.slice(2), seed: 1, epoch: 0, pinHash: hash(id, PIN) });
      log.push({ t: 'btcBurn', id, sats: 30000, addr: 'bc1qdead', txid: id.padEnd(64, '9') });
    }
    // No PIN at all — the handle the door must refuse outright.
    log.push({ t: 'register', id: 'u_open', handle: 'open', seed: 1, epoch: 0 });
    // A passkey and no PIN: a credential, and a stronger one than a PIN.
    makePasskey();
    log.push({ t: 'register', id: 'u_pk', handle: 'pk', seed: 1, epoch: 0 });
    log.push({ t: 'setKey', id: 'u_pk', credId: CRED_ID, cose: pkCose, label: 'a real key' });
    log.push({ t: 'bindAddress', id: 'u_earn', addr: HOST_ADDR });
    log.push({ t: 'post', author: 'u_earn', text: 'hello', a: 0.8, rmen: [] });
    log.push({ t: 'opinion', author: 'u_fan', target: 'c1', p: 0.8, r: 0.8 });
    log.push({ t: 'closeEpoch', epoch: 1 });
    writeFileSync(join(dir, 'server-data', 'acts.jsonl'), log.map((a) => JSON.stringify(a)).join('\n') + '\n');

    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      cwd: ROOT,
      env: { ...process.env, PEER_ACT_RATE: '400', PEER_DATA_DIR: join(dir, 'server-data') },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try {
        // Wait for the replay to be loaded, not merely for the socket: the
        // claim endpoint reads world state and answers 503 until it is warm.
        const probe = await get_('/api/v1/epoch/1/claim');
        if (probe.status === 200) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('host did not come up');
  }, 20000);

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('answers a closed epoch with a root, a total in raw units, and every leaf', async () => {
    const { status, body } = await get_('/api/v1/epoch/1/claim');
    expect(status).toBe(200);
    expect(body.root).toMatch(/^[0-9a-f]{64}$/);
    expect(body.root0x).toBe('0x' + body.root);
    expect(body.decimals).toBe(18);
    expect(body.leafCount).toBe(1);
    expect(body.leaves[0].address).toBe(HOST_ADDR);
    // 5000 PEER for the sole engaged creator, in raw 18-decimal units, as a
    // STRING — a uint256 does not survive JSON's number type.
    expect(body.total).toBe('5000000000000000000000');
    expect(body.totalPeer).toBe(5000);
    expect(body.claimant).toBe(null);
    // The leaves are enough to rebuild the root without trusting the host,
    // which is the entire reason they are all returned.
    expect(merkleRoot(body.leaves.map((l: Record<string, string>) => l.leaf))).toBe(body.root);
  });

  it('hands a named claimant the amount and the proof PeerClaim takes', async () => {
    const { body } = await get_('/api/v1/epoch/1/claim?as=u_earn');
    expect(body.claimant.address).toBe(HOST_ADDR);
    expect(body.claimant.amount).toBe('5000000000000000000000');
    expect(body.claimant.handles).toEqual(['u_earn']);
    expect(foldByHand(HOST_ADDR, BigInt(body.claimant.amount), body.claimant.proof)).toBe(body.root);
    // …and by address, which is what the contract actually pays.
    const byAddr = await get_('/api/v1/epoch/1/claim?address=' + HOST_ADDR.toUpperCase());
    expect(byAddr.body.claimant.proof).toEqual(body.claimant.proof);
  });

  it('says plainly when a claimant has nothing here, and refuses a junk address', async () => {
    const unknown = await get_('/api/v1/epoch/1/claim?as=u_fan');
    expect(unknown.body.claimant).toBe(null);
    expect(unknown.body.claimantNote).toMatch(/no address bound/i);
    const junk = await get_('/api/v1/epoch/1/claim?address=0xnope');
    expect(junk.status).toBe(400);
    expect(junk.body.code).toBe('BAD_ADDRESS');
    expect(junk.body.why).toMatch(/zero address/i);      // the catalogue answered
  });

  it('refuses an epoch that has not closed, with the reason and the next step', async () => {
    const { status, body } = await get_('/api/v1/epoch/7/claim');
    expect(status).toBe(404);
    expect(body.code).toBe('EPOCH_NOT_CLOSED');
    expect(body.why).toMatch(/closed/i);
    expect(body.fix).toMatch(/epochsClosed/);
  });

  it('refuses a binding with no credential on the handle, and one with the wrong PIN', async () => {
    const open = await post_('/api/v1/bind', { as: 'u_open', address: HOST_ADDR });
    expect(open.status).toBe(401);
    expect(open.body.error).toMatch(/no PIN/i);
    expect(open.body.code).toBe('PIN_REQUIRED');
    const wrong = await post_('/api/v1/bind', { as: 'u_earn', pin: '9999', address: HOST_ADDR });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/PIN-secured/i);
  });

  it('lets a PASSKEY-secured handle bind — the strongest credential here, not the excluded one', async () => {
    // What this used to do: refuse, every time, on every path. authError read
    // pinIndex alone, so "no PIN hash" meant "no credential", the PIN_REQUIRED
    // gate fired before the assertion check was ever reached, and the handle
    // was told to set a PIN — a weaker secret — or leave its epoch share
    // unbound forever, which returns it to the steward at every sweep.
    const bad = await post_('/api/v1/bind', { as: 'u_pk', pin: '1234', address: HOST_ADDR });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('PASSKEY_REQUIRED');
    expect(bad.body.error).toMatch(/secured with a passkey/i);
    expect(bad.body.error).not.toMatch(/set one before/i);   // and not the old advice

    const ok = await post_('/api/v1/bind', { as: 'u_pk', auth: assertion(await freshChallenge('u_pk')), address: HOST_ADDR });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.address).toBe(HOST_ADDR);

    // The signature is genuinely checked, not merely present: the same
    // challenge cannot be spent twice, and a challenge issued for one handle
    // does not open another.
    const ch = await freshChallenge('u_pk');
    expect((await post_('/api/v1/bind', { as: 'u_pk', auth: assertion(ch, 8), address: HOST_ADDR })).status).toBe(200);
    const replayed = await post_('/api/v1/bind', { as: 'u_pk', auth: assertion(ch, 9), address: HOST_ADDR });
    expect(replayed.status).toBe(401);
    expect(replayed.body.error).toMatch(/expired or was already used/i);
  });

  it('will not let a stranger set a PIN on a passkey-secured handle', async () => {
    // The same early return had this second edge: with pinIndex empty nothing
    // verified the assertion for ordinary acts either, and hasHistory is false
    // until a handle posts — so a stranger could setPin on a passkey-only
    // handle and hold a credential to it from then on, binding included.
    const r = await fetch(BASE + '/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'setPin', id: 'u_pk', pinHash: hash('u_pk', 'stolen') }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as Record<string, string>).error).toMatch(/secured with a passkey/i);
    // And the handle still answers to its passkey afterwards.
    const still = await post_('/api/v1/bind', { as: 'u_pk', auth: assertion(await freshChallenge('u_pk'), 10), address: HOST_ADDR });
    expect(still.status).toBe(200);
  });

  it('carries a passkey assertion through /api/act, the main write door', async () => {
    // The object used to be dropped at the door — `typeof act.auth === 'string'
    // ? act.auth : ''` — so authError's assertion branch was unreachable from
    // the one endpoint every act goes through.
    const r = await fetch(BASE + '/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'profile', id: 'u_pk', bio: 'signed for', link: '', pic: '', auth: assertion(await freshChallenge('u_pk'), 11) }),
    });
    expect(r.status).toBe(200);
    const acts = (await get_('/api/acts')).body.acts as Array<Record<string, unknown>>;
    const mine = acts.filter((a) => a.t === 'profile' && a.id === 'u_pk');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.auth).toBeUndefined();    // never persisted, PIN or passkey
  });

  it('refuses an address that is not 20 bytes, and the zero address', async () => {
    const short = await post_('/api/v1/bind', { as: 'u_earn', pin: PIN, address: '0x1234' });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('BAD_ADDRESS');
    expect(short.body.fix).toMatch(/paste/i);
    const zero = await post_('/api/v1/bind', { as: 'u_earn', pin: PIN, address: '0x' + '0'.repeat(40) });
    expect(zero.status).toBe(400);
    expect(zero.body.error).toMatch(/zero address/i);
    const none = await post_('/api/v1/bind', { as: 'u_earn', pin: PIN });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('BAD_ADDRESS');
  });

  it('accepts a checksummed address, stores it folded, and does not touch a published epoch', async () => {
    const next = '0x' + 'C0FFEE'.padStart(40, 'B');
    const r = await post_('/api/v1/bind', { as: 'u_earn', pin: PIN, address: next });
    expect(r.status).toBe(200);
    expect(r.body.address).toBe(next.toLowerCase());
    expect(r.body.effectiveFrom).toBe(2);
    expect(r.body.note).toMatch(/cannot be recomputed/i);

    // The act in the public log carries the canonical form, never the input's
    // case: the leaf preimage is lowercase and the log is what everyone hashes.
    const acts = (await get_('/api/acts')).body.acts as Array<Record<string, unknown>>;
    const bound = acts.filter((a) => a.t === 'bindAddress');
    expect(bound[bound.length - 1]!.addr).toBe(next.toLowerCase());
    expect(bound[bound.length - 1]!.auth).toBeUndefined();   // the PIN never lands in the log

    // And epoch 1 still pays the address that was bound when it closed. This
    // is the promise the whole snapshot exists for, checked through the door.
    const after = await get_('/api/v1/epoch/1/claim?as=u_earn');
    expect(after.body.claimant.address).toBe(HOST_ADDR);
  });

  it('says that nothing here is payable, because no claim contract is configured', async () => {
    // The endpoint used to hand out a root, an amount, a proof and "call:
    // PeerClaim.claim(…)" without ever asking whether a claim contract exists
    // — and PEER_CLAIM_ADDR unset is the SHIPPED state, so it was presenting a
    // claim against a contract that is not there. onchain.mjs refuses to do
    // that two files away; the endpoint where somebody decides to open their
    // wallet owes the same sentence.
    const { body } = await get_('/api/v1/epoch/1/claim?as=u_earn');
    expect(body.onchain.configured).toBe(false);
    expect(body.onchain.why).toMatch(/PEER_CLAIM_ADDR is unset/);
    expect(body.onchain.why).toMatch(/deployed and funded/);
    expect(body.onchainIs).toMatch(/no mint/i);
    // The proof is still correct and still returned — it is arithmetic over
    // the log. What changed is that it no longer reads as an instruction.
    expect(body.claimant.proof.length).toBeGreaterThan(0);
    expect(body.claimant.payable).toBe(false);
    expect(body.claimant.call).toMatch(/NOT payable right now/);
    expect(body.claimant.call).toMatch(/would revert/i);
    // And the caller is told to check the sum themselves, because no contract
    // can: a root that oversums its deposit pays first-come and then reverts.
    expect(body.how).toMatch(/oversums its deposit/);
  });

  it('describes binding as what it is, not as a promise of money', async () => {
    const doc = (await get_('/api/v1')).body;
    const bind = (doc.endpoints as Array<Record<string, string>>).find((e) => e.path === '/api/v1/bind')!;
    expect(bind.purpose).toMatch(/earnings tree/i);
    expect(bind.purpose).toMatch(/no mint/i);
    expect(bind.purpose).toMatch(/steward/i);
    // The old wording promised the outcome: "so your epoch earnings become
    // claimable on Base". Nothing about a binding makes that true.
    expect(bind.purpose).not.toMatch(/become claimable on Base/i);
  });

  it('lists both endpoints in the self-describing API document', async () => {
    const doc = (await get_('/api/v1')).body;
    const paths = (doc.endpoints as Array<Record<string, string>>).map((e) => e.method + ' ' + e.path);
    expect(paths.some((s) => s.startsWith('POST /api/v1/bind'))).toBe(true);
    expect(paths.some((s) => s.includes('/api/v1/epoch/N/claim'))).toBe(true);
  });
});

// ── the same endpoint, with a claim contract configured ────────────────────
//
// The unconfigured answer above is the shipped state and the one that used to
// be wrong. This block is the other half: when PEER_CLAIM_ADDR IS set, the
// endpoint must say what the chain says about that epoch number, and the
// difference between "there is a proof" and "there is money" has to survive
// every case — not opened, opened with a different root, window closed, and
// actually payable.
//
// The chain is a twelve-line JSON-RPC stub answering eth_chainId and the one
// eth_call this path makes. No network, no keys, and the encoding it returns
// is PeerClaim.epochInfo's documented five static words, written out by hand.

const RPC_PORT = 5343;
const CHAIN_PORT = 5344;
const CLAIM_CONTRACT = '0x' + 'c1'.repeat(20);

describe('the claim endpoint, with a claim contract configured', () => {
  let stub: import('node:http').Server;
  let child2: ChildProcess;
  let dir2: string;
  // The five words epochInfo answers with, swapped between cases.
  let info = { root: '0'.repeat(64), total: 0n, paid: 0n, until: 0n, open: 0n };
  const CHAIN_BASE = `http://127.0.0.1:${CHAIN_PORT}`;
  const w = (v: bigint) => v.toString(16).padStart(64, '0');

  beforeAll(async () => {
    const http = await import('node:http');
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = JSON.parse(body || '{}');
        let result = '0x';
        if (m.method === 'eth_chainId') result = '0x2105';                    // 8453
        else if (m.method === 'eth_call' && String(m.params?.[0]?.data).startsWith('0x3894228e')) {
          result = '0x' + info.root + w(info.total) + w(info.paid) + w(info.until) + w(info.open);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
    });
    await new Promise<void>((r) => stub.listen(RPC_PORT, '127.0.0.1', r));

    dir2 = mkdtempSync(join(tmpdir(), 'peer-earn-chain-'));
    mkdirSync(join(dir2, 'server-data'), { recursive: true });
    const log: Record<string, unknown>[] = [
      { t: 'register', id: 'u_earn', handle: 'earn', seed: 1, epoch: 0, pinHash: hash('u_earn', PIN) },
      { t: 'btcBurn', id: 'u_earn', sats: 30000, addr: 'bc1qdead', txid: 'u_earn'.padEnd(64, '9') },
      { t: 'register', id: 'u_fan', handle: 'fan', seed: 1, epoch: 0, pinHash: hash('u_fan', PIN) },
      { t: 'btcBurn', id: 'u_fan', sats: 30000, addr: 'bc1qdead', txid: 'u_fan'.padEnd(64, '9') },
      { t: 'bindAddress', id: 'u_earn', addr: HOST_ADDR },
      { t: 'post', author: 'u_earn', text: 'hello', a: 0.8, rmen: [] },
      { t: 'opinion', author: 'u_fan', target: 'c1', p: 0.8, r: 0.8 },
      { t: 'closeEpoch', epoch: 1 },
    ];
    writeFileSync(join(dir2, 'server-data', 'acts.jsonl'), log.map((a) => JSON.stringify(a)).join('\n') + '\n');
    child2 = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(CHAIN_PORT)], {
      cwd: ROOT,
      env: {
        ...process.env, PEER_ACT_RATE: '400', PEER_DATA_DIR: join(dir2, 'server-data'),
        PEER_CLAIM_ADDR: CLAIM_CONTRACT, PEER_L2_RPC: `http://127.0.0.1:${RPC_PORT}`, PEER_L2_CHAIN_ID: '8453',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(CHAIN_BASE + '/api/v1/epoch/1/claim');
        if (r.status === 200) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('host did not come up');
  }, 20000);

  afterAll(async () => {
    child2?.kill();
    await new Promise<void>((r) => stub.close(() => r()));
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const ask = async () =>
    (await (await fetch(CHAIN_BASE + '/api/v1/epoch/1/claim?as=u_earn')).json()) as Record<string, any>;

  it('names the contract and says the epoch was never opened, rather than implying it was', async () => {
    info = { root: '0'.repeat(64), total: 0n, paid: 0n, until: 0n, open: 0n };
    const b = await ask();
    expect(b.onchain.configured).toBe(true);
    expect(b.onchain.contract).toBe(CLAIM_CONTRACT);
    expect(b.onchain.opened).toBe(false);
    expect(b.onchain.why).toMatch(/has not been opened/);
    expect(b.onchain.why).toMatch(/no mint/);
    expect(b.claimant.payable).toBe(false);
    expect(b.claimant.call).toMatch(/NOT payable right now/);
  });

  it('reports an opened, funded, still-open epoch as payable, and names where to send it', async () => {
    const root = (await ask()).root as string;
    info = { root, total: 5000n * 10n ** 18n, paid: 0n, until: 4_000_000_000n, open: 1n };
    const b = await ask();
    expect(b.onchain.opened).toBe(true);
    expect(b.onchain.open).toBe(true);
    expect(b.onchain.rootMatches).toBe(true);
    expect(b.onchain.totalRaw).toBe('5000000000000000000000');
    expect(b.onchain.remainingRaw).toBe('5000000000000000000000');
    expect(b.claimant.payable).toBe(true);
    expect(b.claimant.call).toContain(CLAIM_CONTRACT);
    expect(b.claimant.call).toMatch(/from THIS address/);
    // The oversum check is the reader's, and the endpoint says so with the
    // numbers needed to do it: leaves against the epoch's on-chain total.
    const leaves = b.leaves as Array<{ amount: string }>;
    expect(leaves.reduce((s, l) => s + BigInt(l.amount), 0n)).toBe(BigInt(b.onchain.totalRaw));
  });

  it('refuses to call a proof payable when the chain commits to a DIFFERENT root', async () => {
    // The loudest fact available: the published root came from another log, or
    // another binding snapshot, and every proof below it would revert.
    info = { root: 'a'.repeat(64), total: 5000n * 10n ** 18n, paid: 0n, until: 4_000_000_000n, open: 1n };
    const b = await ask();
    expect(b.onchain.opened).toBe(true);
    expect(b.onchain.rootMatches).toBe(false);
    expect(b.onchain.rootMismatch).toMatch(/NOT the root this host computes/);
    expect(b.claimant.payable).toBe(false);
  });

  it('refuses to call it payable once the window has closed', async () => {
    const root = (await ask()).root as string;
    info = { root, total: 5000n * 10n ** 18n, paid: 0n, until: 1n, open: 0n };
    const b = await ask();
    expect(b.onchain.opened).toBe(true);
    expect(b.onchain.open).toBe(false);
    expect(b.onchain.rootMatches).toBe(true);   // the commitment is still true
    expect(b.claimant.payable).toBe(false);     // and the money is no longer reachable
  });
});

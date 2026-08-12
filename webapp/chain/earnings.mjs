// The earnings tree: one closed epoch's token distribution, made claimable.
//
// replay.cjs closes an epoch and writes tokenDist — { epoch, minted, carried,
// to: { u_ender: 2341.5, … } }. Every number in it is real inside the log and
// worth nothing outside it: the `to` keys are NETWORK IDENTITIES, and no chain
// has ever heard of u_ender. This module is the crossing. It takes that
// mapping plus the address bindings the log itself carries, and produces the
// four things a payout needs: an ordered leaf list, the merkle root that
// commits to it, a proof per claimant, and an honest account of what is NOT in
// the tree.
//
// ── ONE MERKLE IMPLEMENTATION ──────────────────────────────────────────────
// The root comes from merkleRoot() in ./merkle.mjs, unchanged and unwrapped.
// This file adds the leaf STRING (which merkle.mjs neither knows nor cares
// about) and the proof walk, and then checks its own work: every proof built
// here is folded back up and compared against merkleRoot()'s answer before
// this function returns. A proof that does not fold to the root is a claim
// that reverts on Base, so it dies here instead — see buildProofs.
//
// The leaf preimage is PeerClaim.sol's, byte for byte:
//
//   h = <40 lowercase hex chars: the address, no "0x">
//    ++ <64 lowercase hex chars: the amount in raw PEER units, zero-padded>
//
// and then merkle.mjs's own rules apply on top: sha256("L" ++ h) for a leaf,
// sha256("N" ++ hex(left) ++ hex(right)) for an interior node, an odd node
// carried up unchanged, sha256("peer-merkle-empty") for an empty tree.
//
// ── THE BINDING, AND WHAT IT DOES NOT DO ───────────────────────────────────
// A handle's address arrives as a signed 'bindAddress' act under that handle's
// own credential (server.mjs validate/authError, replay.cjs's apply branch).
// Nothing here checks a signature — by the time a binding reaches this module
// it is a fact of the log, and the log is what anybody replays. What this
// module does with it is narrow and worth stating:
//
//   A HANDLE WITH NO BOUND ADDRESS HAS NO LEAF THAT EPOCH. Its share is not
//   redistributed to the other earners, not held in escrow, and not paid to
//   anybody on its behalf. It is reported in `unbound`, it is absent from
//   `total`, and on-chain it stays in the epoch's remainder and returns to the
//   steward when the claim window closes. Nobody is robbed and nobody is
//   quietly enriched; the money simply never left the operator.
//
//   REBINDING TAKES EFFECT FOR FUTURE EPOCHS ONLY. This function is a pure
//   function of the bindings it is HANDED, and the caller is expected to hand
//   it the map as it stood when that epoch closed (replay.cjs snapshots one
//   per close, state.addressesAt[epoch]). Feeding it today's map for last
//   month's epoch would recompute a root that has already been published,
//   which is the one thing publishing a root exists to prevent.
//
// ── IS THE BINDING COMMITTED BY THE EPOCH BLOCK? YES, AND INDIRECTLY ───────
// Nothing about addresses is in the state package (chain/package.mjs), and
// adding it would be a mistake rather than an improvement: the package's hash
// is sealed into every block already published, so a new field would change
// every historical state root and read as the log having been rewritten. It is
// also unnecessary. A block commits structurally to the ORDERED ACT RANGE it
// observed, and a 'bindAddress' act is one of those acts — so the bindings an
// epoch was closed under are already inside the block's commitment, exactly as
// firmly as the posts that earned the tokens. This module derives; it does not
// need a second copy of the same fact.
//
// ── ONE LEAF PER ADDRESS, NOT PER HANDLE ───────────────────────────────────
// Two handles may bind the SAME address — one person, two identities, one
// wallet — and that is allowed, because binding requires each handle's own
// credential and nobody can bind a handle they cannot act as. But PeerClaim
// records `claimed[epoch][msg.sender]`, one flag per address per epoch, so a
// second leaf for the same address would be permanently unclaimable: the
// claimant would take the first, and the contract would refuse the rest
// forever. So amounts are SUMMED per address and the tree carries one leaf for
// them. The handles that fed a leaf are reported beside it (`handles`) and are
// not in the preimage — the chain pays addresses and has no opinion about
// names.

import { merkleRoot } from './merkle.mjs';
import { sha256hex } from './canonical.mjs';

/** PEER's decimals on Base. Fixed at deployment and not configurable here. */
export const PEER_DECIMALS = 18;

/**
 * The log keeps PEER on a 1e-6 grid (replay.cjs floors every share to a
 * micro-token, deliberately, so rounding can only under-distribute). One
 * micro-token is 1e12 raw units at 18 decimals, and that conversion is exact
 * integer arithmetic — no float ever touches a leaf.
 */
const RAW_PER_MICRO = 10n ** 12n;

/** merkle.mjs's empty tree: a real, non-zero, anchorable hash. */
export const EMPTY_ROOT = sha256hex('peer-merkle-empty');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

/**
 * The one canonical form of an address in this project: lowercase, 0x-prefixed.
 *
 * NOT EIP-55 checksummed, and the reason is a house rule rather than an
 * oversight: the checksum is defined over keccak-256, this repo imports no
 * hashing library, and node's crypto has sha3-256 (a different function) but
 * not keccak. So a checksummed address is accepted — it is the same twenty
 * bytes, and every wallet displays that form — and stored folded to lowercase,
 * which is also exactly the byte string PeerClaim._hex writes when it rebuilds
 * the leaf. The honest consequence: a MISTYPED address cannot be caught here.
 * That is why binding is rebindable, and why a rebinding lands in the next
 * epoch rather than the last one.
 */
export function cleanAddress(a) {
  const s = String(a ?? '').trim().toLowerCase();
  if (!ADDRESS_RE.test(s)) return '';
  // The zero address is refused everywhere in this pipeline. It is not a
  // wallet: a leaf paying it is PEER destroyed, and PeerClaim would pay it out
  // to whoever could produce a signature from 0x0, which is nobody.
  if (s === ZERO_ADDRESS) return '';
  return s;
}

/**
 * A PEER amount from the log to raw 18-decimal units.
 *
 * Refuses anything not on the log's own 1e-6 grid rather than rounding it
 * away. An off-grid amount means the input did not come from tokenDist, and
 * silently rounding somebody's earnings — in either direction — is exactly the
 * class of quiet arithmetic this codebase writes tests against.
 *
 * THE CONVERSION GOES THROUGH THE DECIMAL STRING, and it did not always: the
 * first version multiplied by 1e6 and compared the product to its own rounding
 * against a fixed 1e-6 tolerance. That reasoned about the SIZE of the result
 * ("at most 1.825e13, inside the 2^53 a double holds exactly") when the error
 * that matters is the ULP of the PRODUCT. At 1.6e10 micro-tokens — 16,384 PEER
 * — one ULP is already 3.8e-6, four times the tolerance, so 16532.065613
 * multiplied out to 16532065612.999998 and was REFUSED as off-grid, an amount
 * replay.cjs itself produces (`Math.floor(pool*w/total*1e6)/1e6`). One such
 * amount took the whole epoch with it, because earningsTree throws on the
 * first bad leaf and no root could then be computed for anybody. Widening the
 * tolerance would have stopped the throw and started rounding real earnings,
 * which is the failure this function exists to prevent.
 *
 * `toFixed(6)` renders the double's own value rounded to six decimals, and
 * `Number(s) === peer` asks the exact question that matters: IS this double
 * the one a six-decimal amount parses to? Nothing else can round-trip, so
 * nothing off-grid is accepted and nothing on-grid is refused — no tolerance
 * anywhere, and the digits are then read as an integer rather than divided.
 *
 * The upper bound is the token's own fixed supply, and it is load-bearing
 * rather than decorative: above roughly 4.5e9 PEER one ULP exceeds a
 * micro-token, the round-trip test stops distinguishing grid points, and this
 * function would start silently accepting amounts that are not on the grid at
 * all. PeerToken's supply is 18.25M forever — it has no mint — so no honest
 * amount comes near, and anything that does is a bug upstream, named here.
 */
const MAX_PEER = 18_250_000;
export function toRaw(peer) {
  if (typeof peer !== 'number' || !Number.isFinite(peer)) throw new Error('earnings: amount is not a finite number');
  if (peer < 0) throw new Error('earnings: negative amount');
  if (peer > MAX_PEER) throw new Error('earnings: amount ' + peer + ' is out of range — PEER\'s whole supply is ' + MAX_PEER);
  const s = peer.toFixed(6);
  if (Number(s) !== peer) throw new Error('earnings: amount ' + peer + ' is not on the log\'s 1e-6 grid');
  const [whole, frac] = s.split('.');
  return BigInt(whole + frac) * RAW_PER_MICRO;
}

/** Raw units back to PEER, for display only. Never fed to a leaf. */
export function toPeer(raw) {
  return Number(raw / RAW_PER_MICRO) / 1e6;
}

/**
 * The leaf STRING: 40 hex of address ++ 64 hex of amount, both lowercase, no
 * separator and no 0x. merkle.mjs hashes it under 'L'; PeerClaim._leaf builds
 * the identical 104 characters from a uint160 and a uint256.
 */
export function leafHex(address, raw) {
  const a = cleanAddress(address);
  if (!a) throw new Error('earnings: bad address ' + String(address));
  if (typeof raw !== 'bigint' || raw < 0n) throw new Error('earnings: amount must be a non-negative bigint');
  if (raw >= 1n << 256n) throw new Error('earnings: amount does not fit a uint256');
  return a.slice(2) + raw.toString(16).padStart(64, '0');
}

/** A 32-byte word as the 0x-prefixed hex a wallet passes for a bytes32. */
const word = (h) => '0x' + String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * Every claimant's sibling path, built in ONE pass over the tree.
 *
 * The shape is PeerClaim's: proof[0] is a PATH WORD whose i-th bit is 1 when
 * the i-th sibling was the LEFT input, then the siblings bottom-first. Levels
 * where a node was carried up unchanged contribute NO sibling — which is why
 * the directions are a bitmask over siblings and not the leaf's index in
 * binary, and why a one-leaf tree's proof is a single zero word with nothing
 * after it.
 *
 * This walks merkle.mjs's loop rather than calling it, because a proof needs
 * the intermediate levels that merkleRoot() throws away. That duplication is
 * the reason earningsTree() folds every proof back up and compares it to
 * merkleRoot()'s own answer before returning: the authoritative root is always
 * merkle.mjs's, and this walk is checked against it on every single build. If
 * the two ever disagree, the build throws here, where it costs a stack trace —
 * rather than on Base, where it would cost every claim of that epoch.
 */
function buildProofs(leaves) {
  const n = leaves.length;
  const paths = new Array(n).fill(0n);
  const sibs = Array.from({ length: n }, () => []);
  // Which original leaf indices sit under each node of the current level.
  let owners = leaves.map((_, i) => [i]);
  let level = leaves.map((h) => sha256hex('L' + h));
  while (level.length > 1) {
    const nextLevel = [];
    const nextOwners = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(sha256hex('N' + level[i] + level[i + 1]));
        nextOwners.push(owners[i].concat(owners[i + 1]));
        // Everyone under the left node takes the right node as their sibling,
        // and vice versa — one bit and one hash each, per level.
        for (const k of owners[i]) { sibs[k].push(level[i + 1]); }
        for (const k of owners[i + 1]) { paths[k] |= 1n << BigInt(sibs[k].length); sibs[k].push(level[i]); }
      } else {
        // Carried up unchanged: no sibling, no bit, no hash in anybody's proof.
        nextLevel.push(level[i]);
        nextOwners.push(owners[i]);
      }
    }
    level = nextLevel;
    owners = nextOwners;
  }
  return leaves.map((_, i) => ({
    path: paths[i],
    siblings: sibs[i],
    words: [word(paths[i].toString(16)), ...sibs[i].map(word)],
  }));
}

/**
 * Fold a proof from a leaf back up to a root — the reader's half, in JS.
 *
 * Takes the bytes32[] a claimant would actually hand the contract, so what is
 * verified here is the argument itself and not a friendlier structure beside
 * it. The high-bit rule is PeerClaim's and is enforced for the same reason:
 * bits above the sibling count carry no meaning, so leaving them free would
 * give one claim 2^k valid encodings and let "the proof that was published"
 * differ from "the proof that was used" without either being wrong.
 *
 * Returns the root it lands on, or null if the proof is malformed.
 */
export function foldProof(address, raw, proofWords) {
  if (!Array.isArray(proofWords) || proofWords.length === 0) return null;
  let path;
  try { path = BigInt(word(proofWords[0])); } catch { return null; }
  const steps = proofWords.length - 1;
  if ((path >> BigInt(steps)) !== 0n) return null;
  let node;
  try { node = sha256hex('L' + leafHex(address, raw)); } catch { return null; }
  for (let i = 0; i < steps; i++) {
    const sib = word(proofWords[i + 1]).slice(2);
    if (!/^[0-9a-f]{64}$/.test(sib)) return null;
    node = ((path >> BigInt(i)) & 1n) === 1n ? sha256hex('N' + sib + node) : sha256hex('N' + node + sib);
  }
  return node;
}

/** True when this proof pays this address this amount under this root. */
export function verifyProof(root, address, raw, proofWords) {
  const got = foldProof(address, raw, proofWords);
  return got !== null && got === String(root).replace(/^0x/, '').toLowerCase();
}

/**
 * Turn one epoch's distribution into a publishable tree.
 *
 * @param dist     a tokenDist entry: { epoch, minted, carried, to: {id: PEER} }
 * @param bindings handle -> address, AS IT STOOD WHEN THAT EPOCH CLOSED
 * @returns { epoch, root, total, leaves, proofs, unbound, … }
 *
 * ORDERING, because a root is worthless if two builders disagree about it:
 * leaves are sorted by ADDRESS, ascending, as lowercase hex text. Since the
 * text is lowercase and fixed-width, that string order is exactly ascending
 * byte order of the twenty bytes — one total order, no ties (addresses are
 * merged before sorting, so each appears once), and no locale anywhere near
 * it. Sorting by handle was the obvious alternative and is worse: handles are
 * a fact about this network's naming, invisible on-chain, so a stranger
 * holding only the (address, amount) set — which is all the tree commits to —
 * could not reproduce the order. Sorting by amount would tie constantly.
 *
 * WHAT IS LEFT OUT, and reported rather than hidden:
 *   - a handle with no bound address (`unbound`), and
 *   - an amount that rounds to zero raw units, which is skipped because
 *     PeerClaim requires amount > 0: a zero leaf would spend the claimant's
 *     one claim for that epoch on a transfer of nothing.
 * Both stay with the operator. `total` is the sum of the LEAVES and nothing
 * else — it is what openEpoch must be funded with, so it must never include a
 * share nobody can claim.
 */
export function earningsTree(dist, bindings) {
  if (!dist || typeof dist !== 'object') throw new Error('earnings: no distribution given');
  const to = dist.to && typeof dist.to === 'object' ? dist.to : {};
  const binds = bindings && typeof bindings === 'object' ? bindings : {};

  // Merge by address, in one pass. Handle ids are sorted first so that the
  // `handles` list beside a shared leaf is itself deterministic — it is
  // reported, so it has to be reproducible too.
  const byAddress = new Map();
  const unboundHandles = [];
  const zeroHandles = [];
  let unboundTotal = 0n;
  for (const id of Object.keys(to).sort()) {
    const raw = toRaw(to[id]);
    const addr = cleanAddress(binds[id]);
    if (!addr) {
      // No address, or one this pipeline refuses (malformed, or the zero
      // address). Either way there is nothing to pay, and it is named.
      unboundHandles.push({ id, amount: raw, peer: toPeer(raw) });
      unboundTotal += raw;
      continue;
    }
    if (raw === 0n) { zeroHandles.push({ id, address: addr }); continue; }
    const row = byAddress.get(addr);
    if (row) { row.amount += raw; row.handles.push(id); }
    else byAddress.set(addr, { address: addr, amount: raw, handles: [id] });
  }

  const rows = [...byAddress.values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const hexes = rows.map((r) => leafHex(r.address, r.amount));
  const root = merkleRoot(hexes);
  const proofs = {};
  const built = hexes.length ? buildProofs(hexes) : [];
  for (let i = 0; i < rows.length; i++) {
    // The self-check named at the top of this file. Cheap (one extra sha256
    // per proof step) and absolute: a tree whose own proofs do not reproduce
    // merkle.mjs's root never leaves this function.
    if (!verifyProof(root, rows[i].address, rows[i].amount, built[i].words)) {
      throw new Error('earnings: proof for ' + rows[i].address + ' does not fold to the root — refusing to publish this tree');
    }
    proofs[rows[i].address] = built[i];
  }

  let total = 0n;
  for (const r of rows) total += r.amount;

  return {
    epoch: dist.epoch,
    root,
    total,
    totalPeer: toPeer(total),
    leaves: rows.map((r, i) => ({
      index: i,
      address: r.address,
      amount: r.amount,
      peer: toPeer(r.amount),
      handles: r.handles.slice(),
      hex: hexes[i],
    })),
    proofs,
    unbound: {
      handles: unboundHandles,
      total: unboundTotal,
      totalPeer: toPeer(unboundTotal),
    },
    // Amounts too small to survive the conversion to raw units. Empty in
    // practice (replay.cjs already drops shares that floor to zero) and
    // reported anyway, because "your epoch paid you nothing and nobody
    // mentioned it" is the failure this field exists to make impossible.
    zero: zeroHandles,
    // The epoch's own credited figure, for cross-checking: total + unbound
    // should equal it, and a gap is dust the log floored away.
    minted: typeof dist.minted === 'number' ? dist.minted : null,
    decimals: PEER_DECIMALS,
  };
}

// The epoch block: one signed, hash-linked certificate per closed epoch.
//
// What a block claims, and no more:
//   "At epoch close N, the producer named here observed this ordered act
//    range, computed this state package from it with these constants and
//    these formula editions, and signs that publication."
//
// What a block does NOT do — by the spec's Public-Object Replay postulate:
// select among valid histories, substitute for replay, or make a hash
// normative. Any participant who disagrees with a block does not argue with
// its signature; they replay the log and publish the discrepancy. The chain
// makes silent rewriting DETECTABLE and publication ATTRIBUTABLE; replay
// keeps deciding what is true.
//
// The constant set and the formula-edition hashes are sealed into every
// block — the no-silent-change rule (Appendix I, invariant 7): a constant
// change, or any edit to the engine or replay source, breaks the chain
// loudly instead of shifting every number quietly.

import { canonical, sha256hex } from './canonical.mjs';
import { signDigest, verifyDigest } from './keys.mjs';

export const CHAIN_VERSION = 1;
export const NET_ID = 'peernetwork-sandbox/v0.24.1-dev';

/** Digest a block's signable content (everything but the signature). */
export function blockDigest(block) {
  const { sig, ...unsigned } = block;
  return sha256hex(canonical(unsigned));
}

/** The block's own id: the hash of the whole sealed block, signature included. */
export function blockHash(block) {
  return sha256hex(canonical(block));
}

export function sealBlock(fields, privateKey) {
  const unsigned = { v: CHAIN_VERSION, net: NET_ID, ...fields };
  const sig = signDigest(privateKey, sha256hex(canonical(unsigned)));
  return { ...unsigned, sig };
}

export function verifyBlockSignature(block) {
  return verifyDigest(block.producer, blockDigest(block), block.sig);
}

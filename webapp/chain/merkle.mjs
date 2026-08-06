// Merkle root over an ordered list of hex hashes.
//
// Per the spec's Public-Object Replay postulate, this root carries NO
// normative meaning — it selects nothing and validates nothing by itself.
// It exists so that a block is a small fixed-size commitment to an ordered
// act range, checkable leaf by leaf, and so the whole record can travel
// over content-addressed transport without anyone re-downloading what they
// already hold. Truth stays with replay.
//
// Leaves and interior nodes are domain-separated ('L' / 'N') so no interior
// node can be presented as a leaf. An odd node is carried up unchanged —
// with domain separation and the leaf count sealed in the block beside the
// root, duplication attacks have nothing to grab.

import { sha256hex } from './canonical.mjs';

export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('peer-merkle-empty');
  let level = leaves.map((h) => sha256hex('L' + h));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256hex('N' + level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

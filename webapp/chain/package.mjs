// The epoch package: the canonical publication of everything the economic
// layer computed at an epoch close.
//
// This is the spec's conserved-standing package plus the sandbox economy,
// under the canonical-publication postulate: declared ordering (arrays
// sorted by id; object keys sort inside the canonical encoding), declared
// representation (shortest round-trip decimal), declared rounding (every
// inexact value quantised to STATE_QUANTUM before hashing, and the quantum
// travels in the block).
//
// Only REDACTION-INVARIANT quantities are committed. Removal is
// scoring-neutral by design — deleting a post or an account takes payload
// and visibility, never a ledger entry, a standing, a minted token or a
// pool reserve. Everything here therefore reproduces from the log as it
// stands today AND as it will stand after any future lawful deletion.
// Payload-bearing state (post text, display handles, adverts) is exactly
// what does NOT belong in a state root.

import { hashCanonical, quantize } from './canonical.mjs';

function quantizeMap(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = quantize(obj[k]);
  return out;
}

/**
 * Build the package for the epoch whose closeEpoch act ends this replay
 * prefix. `st` is the replay state over [seedWorld, acts[0..closeIdx]].
 */
export function epochPackage(st, epochNo) {
  const cert = st.epochHistory[st.epochHistory.length - 1];
  if (!cert || cert.epoch !== epochNo) {
    throw new Error('epochPackage: replay prefix does not end at epoch ' + epochNo
      + ' (last certificate: ' + (cert ? cert.epoch : 'none') + ')');
  }

  const ledgers = st.ledgers
    .map((l) => ({ id: l.id, burnBal: quantize(l.burnBal), actCount: l.actCount }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bal = {};
  for (const sym of Object.keys(st.tokens.bal)) bal[sym] = quantizeMap(st.tokens.bal[sym]);

  const pools = {};
  for (const pid of Object.keys(st.pools)) {
    const p = st.pools[pid];
    pools[pid] = {
      a: p.a, b: p.b,
      resA: quantize(p.resA), resB: quantize(p.resB),
      totalShares: quantize(p.totalShares),
      shares: quantizeMap(p.shares),
      swaps: p.swaps, volA: quantize(p.volA), volB: quantize(p.volB),
    };
  }

  const dist = st.tokens.dist
    .filter((d) => d.epoch === epochNo)
    .map((d) => ({ epoch: d.epoch, minted: quantize(d.minted), carried: quantize(d.carried), to: quantizeMap(d.to) }));

  return {
    epoch: epochNo,
    ledgers,
    standing: quantizeMap(st.xById),
    certificate: {
      epoch: cert.epoch,
      acts: cert.acts,
      // reading these settles the deferred solve — the certificate is priced
      // to whoever seals or verifies, exactly as replay.cjs intends
      stamp: quantize(cert.stamp),
      headroom: quantize(cert.headroom),
      pass: !!cert.pass,
    },
    tokens: {
      supply: quantizeMap(st.tokens.supply),
      bal,
      carry: quantize(st.tokens.carry),
      epochN: st.tokens.epochN,
      claimed: Object.keys(st.tokens.claimed).sort(),
      dist,
      assets: st.tokens.meta,
    },
    pools,
  };
}

export function stateRoot(pkg) {
  return hashCanonical(pkg);
}

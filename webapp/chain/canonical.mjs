// Canonical encoding: one byte sequence per value, or an error.
//
// The spec's canonical-publication postulate (Appendix I) demands a declared
// ordering, a declared representation for every rational quantity, and a
// declared rounding disclosure — so that replay is DECIDABLE: two verifiers
// either match bits or can attribute the discrepancy, with no third outcome.
// This file is that encoding for the sandbox chain:
//
//   - object keys sorted by UTF-16 code unit (no locale anywhere near this);
//   - numbers printed by ECMA-262 Number::toString — the shortest round-trip
//     form, fully specified, identical on every conforming engine;
//   - NaN and the infinities REFUSED, not nulled. JSON.stringify would write
//     `null` and two different corruptions would hash alike;
//   - getters read once, like JSON.stringify would — the deferred epoch
//     certificates in replay.cjs settle the moment they are encoded.
//
// What this does NOT promise: that Math.exp on two different engines lands on
// the same double. That risk is why quantize() exists — state packages round
// every inexact value to a published quantum before hashing, and the quantum
// is written into the block that carries the hash.

import { createHash } from 'node:crypto';

export function canonical(v, seen) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonical: non-finite number');
    return JSON.stringify(v);
  }
  if (t === 'string') return JSON.stringify(v);
  if (t !== 'object') throw new Error('canonical: cannot encode ' + t);
  seen = seen || new Set();
  if (seen.has(v)) throw new Error('canonical: cycle');
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = '[' + v.map((x) => {
      if (x === undefined) throw new Error('canonical: undefined in array');
      return canonical(x, seen);
    }).join(',') + ']';
  } else {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      const x = v[k]; // reading the property settles any getter
      if (x === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonical(x, seen));
    }
    out = '{' + parts.join(',') + '}';
  }
  seen.delete(v);
  return out;
}

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function hashCanonical(v) {
  return sha256hex(canonical(v));
}

// The published rounding quantum: 1e-9. Fine enough that no protocol quantity
// loses meaning (token amounts already live on a 1e-6 grid; standing is read
// to far fewer places than nine), coarse enough to absorb the low-bit
// disagreement transcendental math could produce on a foreign engine.
export const STATE_QUANTUM = 1e-9;

export function quantize(x) {
  if (!Number.isFinite(x)) throw new Error('quantize: non-finite number');
  const r = Math.round(x / STATE_QUANTUM) * STATE_QUANTUM;
  return Object.is(r, -0) ? 0 : r;
}

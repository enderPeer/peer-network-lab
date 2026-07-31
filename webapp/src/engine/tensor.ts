import { ETA, HALF_FLOOR } from './constants';
import { fpl, fpm, coherence, boltzmann } from './kernels';

/** Bilinear mask (a00, a01, a10, a11) applied to the upper-left 2×2 block only. */
export type Mask = readonly [number, number, number, number];

export type Domain =
  | 'Tribal'
  | 'Identity'
  | 'Epistemic'
  | 'Economic'
  | 'Relational'
  | 'Minimal';

export const DOMAIN_MASKS: Record<Domain, Mask> = {
  Tribal: [1, 1, 1, 1],
  Identity: [1, 0, 0, 1],
  Epistemic: [0, 1, 0, 1],
  Economic: [0, 0, 1, 1],
  Relational: [0, 0, 1, 1],
  Minimal: [0, 0, 0, 1],
};

/** Routing tier: power of the path-view s00 coefficient (1, √η, η). */
export type Tier = 'full' | 'half' | 'marginal';

export type Mat3 = number[][];
export type Mat2 = number[][];

/**
 * Stored 3×3 sentiment slice Ψ_e. Mask zeroes bilinear entries only;
 * marginals (row 2 / col 2) and the 0.8 baseline are always active.
 */
export function sentimentSlice(pd: number, pi: number, mask: Mask): Mat3 {
  const [a00, a01, a10, a11] = mask;
  const apd = Math.abs(pd);
  const api = Math.abs(pi);
  return [
    [a00 * fpm(pi * pd), a01 * fpm(pi * apd), fpm(pi)],
    [a10 * fpm(api * pd), a11 * fpl(api * apd), fpl(api)],
    [fpm(pd), fpl(apd), fpl(1)],
  ];
}

export function frobenius(m: number[][]): number {
  let s = 0;
  for (const row of m) for (const v of row) s += v * v;
  return Math.sqrt(s);
}

/**
 * η-softened 2×2 path view. Full/marginal tiers soften the mask
 * (s = a + (1−a)·η); the half tier attenuates a full stored block by √η on
 * every entry except the polarization corner s11 = 1.
 */
export function pathView(pd: number, pi: number, mask: Mask, tier: Tier): Mat2 {
  let s: [number, number, number, number];
  if (tier === 'half') {
    s = [HALF_FLOOR, HALF_FLOOR, HALF_FLOOR, 1];
  } else {
    const [a00, a01, a10, a11] = mask;
    s = [
      a00 + (1 - a00) * ETA,
      a01 + (1 - a01) * ETA,
      a10 + (1 - a10) * ETA,
      a11 + (1 - a11) * ETA,
    ];
  }
  const apd = Math.abs(pd);
  const api = Math.abs(pi);
  return [
    [s[0] * fpm(pi * pd), s[1] * fpm(pi * apd)],
    [s[2] * fpm(api * pd), s[3] * fpl(api * apd)],
  ];
}

export function det2(m: Mat2): number {
  const r0 = m[0]!;
  const r1 = m[1]!;
  return r0[0]! * r1[1]! - r0[1]! * r1[0]!;
}

/** Directional coherence magnitude √|det PV| = √(σ1·σ2). */
export function detScore(pv: Mat2): number {
  return Math.sqrt(Math.abs(det2(pv)));
}

/** Orientation ε = sgn(det PV) ∈ {+1, −1}; caller applies family sign forcing. */
export function detSign(pv: Mat2): number {
  return det2(pv) >= 0 ? 1 : -1;
}

/** Singular values of a 2×2 matrix (closed form), σ1 ≥ σ2 ≥ 0. */
export function singularValues2(m: Mat2): [number, number] {
  const [a, b] = m[0]! as [number, number];
  const [c, d] = m[1]! as [number, number];
  const e = (a * a + b * b + c * c + d * d) / 2;
  const f = Math.sqrt(Math.max(0, e * e - det2(m) ** 2));
  return [Math.sqrt(Math.max(0, e + f)), Math.sqrt(Math.max(0, e - f))];
}

/**
 * Boundary-observed damped edge weight:
 * det_score · √(1+τ²) · e^(−β·H(τ)).  Applied once at observation;
 * shared verbatim by feed ranking, signed double-cover, and bridge.
 */
export function dampedWeight(score: number, tau: number): number {
  return score * coherence(tau) * boltzmann(tau);
}

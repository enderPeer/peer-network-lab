import {
  ACT_EXPONENT,
  BETA,
  DEPTH_MASS,
  ETA,
  HOP_MAX,
  KAPPA_SELF,
  NU,
  PART_FLOOR,
  SAFE_FLOOR,
  THETA,
  TILT_SHAPE,
} from './constants';
import { sigmoid } from './kernels';

/** Per-actor ledger pair (residual balance, action count). */
export interface Ledger {
  id: string;
  burnBal: number;
  actCount: number;
}

/** One fold cell: an accepted act resolved to a person recipient (or self). */
export interface FoldCell {
  src: string;
  rcp: string;
  /** c(ξ) ∈ [0,1]: geometric mean of magnitudes of mandatory folded coordinates. */
  coeff: number;
}

/** Reduced commitment rate x = (burn/N)/ν with the count guard. */
export function refRate(l: Ledger): number {
  return l.burnBal / Math.max(l.actCount, 1) / NU;
}

/** Source emission fraction = min(1, refrate/safefloor); 1 for solvent history. */
export function emission(l: Ledger): number {
  return Math.min(1, refRate(l) / SAFE_FLOOR);
}

/** Möbius state coordinate p(x) = x/(1+x). */
export function mobius(x: number): number {
  return x / (1 + x);
}

/** Non-temporal deployed vouch core Q(p) = sigmoid(β·p)·√(tanh p·(1−η²·tanh p)). */
export function Q(p: number): number {
  const t = Math.tanh(p);
  return sigmoid(BETA * p) * Math.sqrt(t * (1 - ETA * ETA * t));
}

const Q1 = Q(1);

/** Normalized projected vouch activation V(p(x))^(1/4), strictly increasing, < 1. */
export function vouchAct(x: number): number {
  if (x <= 0) return 0;
  return Math.pow(Q(mobius(x)) / Q1, ACT_EXPONENT);
}

/** Safety-wall clamp: constant below the wall, continuous at it. */
export function wallAct(x: number): number {
  return vouchAct(Math.max(x, SAFE_FLOOR));
}

/**
 * Base allocation matrix over an ordered actor index:
 * κ_self on the diagonal plus domain-weighted fold-cell coefficients.
 * The sole standing-relevant reading of the epoch's acts.
 */
export function baseScoreMatrix(ids: string[], cells: FoldCell[]): number[][] {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const base: number[][] = Array.from({ length: n }, (_, u) =>
    Array.from({ length: n }, (_, j) => (u === j ? KAPPA_SELF : 0)),
  );
  for (const cell of cells) {
    const u = idx.get(cell.src);
    if (u === undefined) continue;
    // Universal act weighing: a dangling/unanchored recipient resolves to the
    // author's self-retention channel, never out of the allocation.
    const j = idx.get(cell.rcp) ?? u;
    base[u]![j]! += cell.coeff; // ω_D = 1 uniform reference
  }
  return base;
}

/** Hop-r allocation matrix Λ_r(x): tilt on off-diagonal targets, self unmodulated, row-normalized. */
function hopMatrix(base: number[][], x: number[], hop: number, tilt: number): number[][] {
  const n = base.length;
  const lam: number[][] = [];
  const exp = tilt * TILT_SHAPE[hop - 1]!;
  for (let u = 0; u < n; u++) {
    const row = new Array<number>(n);
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const s = u === j ? base[u]![j]! : base[u]![j]! * Math.pow(wallAct(x[j]!), exp);
      row[j] = s;
      sum += s;
    }
    for (let j = 0; j < n; j++) row[j]! /= sum;
    lam.push(row);
  }
  return lam;
}

function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i]![k]!;
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) out[i]![j]! += aik * b[k]![j]!;
    }
  }
  return out;
}

/**
 * Finite-depth conserved transport
 * Π(x) = E · Σ_m mfrak(m)·(Λ_1···Λ_m) + (I − E); row-stochastic identically.
 */
export function transport(
  base: number[][],
  x: number[],
  emissions: number[],
  tilt: number,
): number[][] {
  const n = base.length;
  const mix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let product: number[][] | null = null;
  for (let m = 1; m <= HOP_MAX; m++) {
    const lam = hopMatrix(base, x, m, tilt);
    product = product ? matMul(product, lam) : lam;
    const mass = DEPTH_MASS[m - 1]!;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) mix[i]![j]! += mass * product[i]![j]!;
  }
  const pi: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let u = 0; u < n; u++) {
    for (let j = 0; j < n; j++) pi[u]![j] = emissions[u]! * mix[u]![j]!;
    pi[u]![u]! += 1 - emissions[u]!;
  }
  return pi;
}

export interface SolveResult {
  ids: string[];
  /** Final reduced standing x*_i. */
  x: number[];
  /** Conserved transport Π at the fixed point. */
  pi: number[][];
  iterations: number;
  /** Max |Δx| at the last pass. */
  residual: number;
  /** Per-pass iterates (for visualization). */
  trace: number[][];
}

/**
 * Conserved standing map: exact balance/count mediant over transported pairs,
 * F_i(x) = Σ_u Π[u][i]·N_u·refrate_u / Σ_u Π[u][i]·N_u, iterated from the
 * source-rate vector to the unique certified fixed point.
 */
export function solveStanding(
  ledgers: Ledger[],
  cells: FoldCell[],
  opts: { tilt?: number; maxIter?: number; tol?: number } = {},
): SolveResult {
  const { tilt = 1, maxIter = 200, tol = 1e-13 } = opts;
  const ids = ledgers.map((l) => l.id);
  const base = baseScoreMatrix(ids, cells);
  const rates = ledgers.map(refRate);
  const counts = ledgers.map((l) => Math.max(l.actCount, 1));
  const emis = ledgers.map(emission);

  let x = rates.slice();
  const trace: number[][] = [x.slice()];
  let residual = Infinity;
  let iter = 0;
  let pi = transport(base, x, emis, tilt);
  while (iter < maxIter) {
    pi = transport(base, x, emis, tilt);
    const next = new Array<number>(ids.length);
    for (let i = 0; i < ids.length; i++) {
      let num = 0;
      let den = 0;
      for (let u = 0; u < ids.length; u++) {
        const m = pi[u]![i]! * counts[u]!;
        num += m * rates[u]!;
        den += m;
      }
      next[i] = den > 0 ? num / den : rates[i]!;
    }
    residual = Math.max(...next.map((v, i) => Math.abs(v - x[i]!)));
    x = next;
    trace.push(x.slice());
    iter++;
    if (residual < tol) break;
  }
  return { ids, x, pi, iterations: iter, residual, trace };
}

// ── Epoch gates ────────────────────────────────────────────────────────

export interface GateReport {
  /** W1: every proposing author ends the epoch with a non-negative balance. */
  w1: { id: string; burnBal: number; pass: boolean }[];
  /** W2a: every act stamp (author's final reduced standing) clears the wall. */
  w2a: { id: string; stamp: number; pass: boolean }[];
  /** W2b: act-weighted epoch stamp clears the participation floor. */
  epochStamp: number;
  headroom: number;
  w2bPass: boolean;
  allPass: boolean;
}

/**
 * Two-gate write rule over a proposed epoch, given the solved x* and each
 * author's Δ act count this epoch. Stamps are measurements, never debited.
 */
export function evaluateGates(
  ledgers: Ledger[],
  x: number[],
  deltaActs: Map<string, number>,
): GateReport {
  const w1 = ledgers.map((l) => ({ id: l.id, burnBal: l.burnBal, pass: l.burnBal >= 0 }));
  const w2a = ledgers
    .map((l, i) => ({ id: l.id, stamp: x[i]!, delta: deltaActs.get(l.id) ?? 0 }))
    .filter((e) => e.delta > 0)
    .map((e) => ({ id: e.id, stamp: e.stamp, pass: e.stamp >= SAFE_FLOOR }));
  let mSum = 0;
  let stampSum = 0;
  let headroom = 0;
  ledgers.forEach((l, i) => {
    const m = deltaActs.get(l.id) ?? 0;
    if (m <= 0) return;
    mSum += m;
    stampSum += m * x[i]!;
    headroom += m * (x[i]! - PART_FLOOR);
  });
  const epochStamp = mSum > 0 ? stampSum / mSum : 0;
  const w2bPass = mSum === 0 || epochStamp >= PART_FLOOR;
  const allPass = w1.every((e) => e.pass) && w2a.every((e) => e.pass) && w2bPass;
  return { w1, w2a, epochStamp, headroom, w2bPass, allPass };
}

/** Apply the θ-debit for one accepted act (W1 side effect). */
export function debitAct(l: Ledger): Ledger {
  return { ...l, burnBal: l.burnBal - THETA, actCount: l.actCount + 1 };
}

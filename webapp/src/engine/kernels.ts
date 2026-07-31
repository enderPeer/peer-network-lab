import { BETA } from './constants';

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * ψ⁺ clamp f_pl(x) = sigmoid(β·x). Callers pass non-negative arguments
 * (the slice formula applies |·| at each call site). f_pl(1) = 4/5 exactly.
 */
export function fpl(x: number): number {
  return sigmoid(BETA * x);
}

/** Signed clamp f_pm(x) = sigmoid(β·|x|)·tanh(x), range (−1, 1). */
export function fpm(x: number): number {
  return sigmoid(BETA * Math.abs(x)) * Math.tanh(x);
}

/** Binary Shannon entropy in nats; H(0) = H(1) = 0. */
export function binaryEntropy(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return -t * Math.log(t) - (1 - t) * Math.log(1 - t);
}

/** Boltzmann maturity damping e^(−β·H(τ)); 0.383 at maximum entropy τ = ½. */
export function boltzmann(tau: number): number {
  return Math.exp(-BETA * binaryEntropy(tau));
}

/** Coherence amplifier √(1+τ²) ∈ [1, √2). */
export function coherence(tau: number): number {
  return Math.sqrt(1 + tau * tau);
}

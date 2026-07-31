/**
 * Compositional Attribution Network (AttrView only — raw Frobenius norms,
 * no τ, no damping). Transmission saturates in the mean child norm; the
 * dependency mix is a convex combination, so attribution decays with depth.
 */

export interface CanNode {
  /** Frobenius norms of the contributing (child) edges. */
  childNorms: number[];
  /** CAN values of the corresponding child nodes/edges. */
  childValues: number[];
}

/** Transmission factor m/(1+m) with m the mean child-edge norm. */
export function transmission(childNorms: number[]): number {
  if (childNorms.length === 0) return 0;
  const m = childNorms.reduce((a, b) => a + b, 0) / childNorms.length;
  return m / (1 + m);
}

/** Convex dependency weights ‖Ψ_i‖_F / Σ‖Ψ_j‖_F. */
export function dependencyWeights(childNorms: number[]): number[] {
  const sum = childNorms.reduce((a, b) => a + b, 0);
  return childNorms.map((n) => (sum > 0 ? n / sum : 0));
}

/** canval = transmission · Σ depweight_i · canval(child_i); strictly below max child. */
export function canValue(node: CanNode): number {
  const t = transmission(node.childNorms);
  const w = dependencyWeights(node.childNorms);
  let mix = 0;
  for (let i = 0; i < w.length; i++) mix += w[i]! * (node.childValues[i] ?? 0);
  return t * mix;
}

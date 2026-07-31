// Chartered/published Layer-1 constants (spec table tbl:verification:constants).
// epoch_len and snapbuf are explicitly "illustrative, not locked".

/** Inverse temperature β = 2 ln 2 — scales both sentiment clamps and Boltzmann damping. */
export const BETA = 2 * Math.log(2);

/** Cross-dimensional bleed η — softens masked path-view entries (det never 0). */
export const ETA = 0.05;

/** Half-tier path-view floor = √η (one-knob ladder {1, √η, η}). */
export const HALF_FLOOR = Math.sqrt(ETA);

/** Numéraire ν — the unit standing is expressed against. */
export const NU = 0.1;

/** Safety threshold θ (reserve debited per accepted act), chartered interim value. */
export const THETA = 0.0528066;

/** Safety wall for W2a in reduced coordinates: θ/ν. */
export const SAFE_FLOOR = THETA / NU;

/** Host policy floor ρ_pol (canonical default). */
export const POL_FLOOR = 1;

/** Effective participation floor = max(ρ_pol, θ/ν) — equals ρ_pol on a valid certificate. */
export const PART_FLOOR = Math.max(POL_FLOOR, SAFE_FLOOR);

/** Max standing-transport hops and raw feed BFS depth. */
export const HOP_MAX = 4;
export const FEED_DEPTH = 4;

/** Chartered activation exponent (NOT derived from HOP_MAX — numeric coincidence). */
export const ACT_EXPONENT = 0.25;

/** Chartered hop tilt profile (profile B): halving per hop. */
export const TILT_SHAPE = [1, 0.5, 0.25, 0.125] as const;

/** Chartered depth-mass distribution (D2) over transport depths 1..4; sums to 1. */
export const DEPTH_MASS = [0.5, 0.25, 0.125, 0.125] as const;

/** Self-retention base κ_self (reference value, pending calibration lock). */
export const KAPPA_SELF = 1;

/** Uniform reference domain weight ω_D. */
export const OMEGA_DOMAIN = 1;

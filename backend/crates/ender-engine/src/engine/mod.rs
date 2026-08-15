//! The consumed engine surface — exactly what replay.cjs reaches through `E`
//! (port-notes/engine-api.md "Consumed surface"): THETA, NU, RawGraph,
//! solveStanding, evaluateGates. AttestationLedger is constructed by the JS
//! fold but never mutated and never read into packages — omitted entirely.
//!
//! Source of truth: webapp/src/engine/constants.ts, graph.ts, standing.ts.

pub mod graph;
pub mod standing;

use std::sync::OnceLock;

// constants.ts — the defining EXPRESSIONS are law (engine-internals.md §1).
pub const ETA: f64 = 0.05;
pub const NU: f64 = 0.1;
pub const THETA: f64 = 0.0528066;
/// `THETA / NU` — one f64 division of the two literals. Do NOT replace with
/// a 0.528066 literal; the division's rounding is part of the value.
pub const SAFE_FLOOR: f64 = THETA / NU;
/// `Math.max(POL_FLOOR = 1, SAFE_FLOOR)` — exactly 1.0 (SAFE_FLOOR < 1).
pub const PART_FLOOR: f64 = 1.0;
/// Chartered literal (NOT derived from HOP_MAX).
pub const ACT_EXPONENT: f64 = 0.25;
pub const KAPPA_SELF: f64 = 1.0;
pub const HOP_MAX: usize = 4;
pub const TILT_SHAPE: [f64; 4] = [1.0, 0.5, 0.25, 0.125];
pub const DEPTH_MASS: [f64; 4] = [0.5, 0.25, 0.125, 0.125];

/// `BETA = 2 * Math.log(2)` — computed with the V8-parity log, then one
/// exact-in-f64 doubling. Module-load-once in JS; OnceLock here.
pub fn beta() -> f64 {
    static B: OnceLock<f64> = OnceLock::new();
    *B.get_or_init(|| 2.0 * ender_jsmath::js_log(2.0))
}

//! The JS float semantics kernel.
//!
//! Every transcendental the fold evaluates (Math.pow, Math.exp, Math.tanh,
//! Math.log) and JS Math.round route through this crate. Correctness is
//! defined by tests/…/transcendentals.json — 19k+ (arg, result) pairs
//! recorded bit-exactly from V8 during real replays plus a seeded sweep.
//! The backend is a vendored translation of V8's fdlibm-derived ieee754.cc
//! (mod fdlibm); platform libm never touches fold arithmetic.
//!
//! f64::round, f64::powf, f64::exp, f64::ln etc. must never be called in
//! fold code.

pub mod fdlibm;

/// ECMA-262 Math.round: closest integer, ties toward +∞, sign of zero
/// preserved (Math.round of (-0.5, 0] is -0).
pub fn js_round(y: f64) -> f64 {
    if !y.is_finite() {
        return y;
    }
    let f = y.floor();
    let r = if y - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && y.is_sign_negative() {
        -0.0
    } else {
        r
    }
}

/// Math.pow(x, y) as V8 computes it.
pub fn js_pow(x: f64, y: f64) -> f64 {
    fdlibm::pow(x, y)
}

/// Math.exp(x) as V8 computes it.
pub fn js_exp(x: f64) -> f64 {
    fdlibm::exp(x)
}

/// Math.tanh(x) as V8 computes it.
pub fn js_tanh(x: f64) -> f64 {
    fdlibm::tanh(x)
}

/// Math.log(x) as V8 computes it.
pub fn js_log(x: f64) -> f64 {
    fdlibm::log(x)
}

/// Math.expm1 — used internally by tanh; exposed for completeness.
pub fn js_expm1(x: f64) -> f64 {
    fdlibm::expm1(x)
}

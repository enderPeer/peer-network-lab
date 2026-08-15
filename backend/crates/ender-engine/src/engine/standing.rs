//! standing.ts — the epoch solve and the gate check (port map:
//! engine-api.md §8, engine-internals.md §8). Only solveStanding and
//! evaluateGates are consumed by the fold; the scalar kernels (refRate,
//! emission, mobius, Q, vouchAct, wallAct), baseScoreMatrix, hopMatrix,
//! matMul and transport are implementation details behind them — keep
//! their accumulation orders verbatim, including the module-level
//! `Q1 = Q(1)` computed once.

use std::sync::OnceLock;

use indexmap::IndexMap;

use crate::engine::{
    beta, ACT_EXPONENT, DEPTH_MASS, ETA, HOP_MAX, KAPPA_SELF, NU, PART_FLOOR, SAFE_FLOOR,
    TILT_SHAPE,
};
use crate::fold::state::{js_max, js_min};
use ender_jsmath::{js_exp, js_pow, js_tanh};

/// standing.ts `Ledger` — the SOLVE-INPUT shape ({id, burnBal, actCount}).
/// The fold's richer ledger record (with its `deleted` flag) lives in
/// fold::state; snapshots convert into this (actCount is a JS number, so
/// f64 here; fold counts convert exactly).
#[derive(Debug, Clone)]
pub struct Ledger {
    pub id: String,
    pub burn_bal: f64,
    pub act_count: f64,
}

/// standing.ts `FoldCell`.
#[derive(Debug, Clone)]
pub struct FoldCell {
    pub src: String,
    pub rcp: String,
    pub coeff: f64,
}

/// solveStanding opts — defaults `{ tilt: 1, maxIter: 200, tol: 1e-13 }`.
/// replay.cjs always passes `{ tilt: 1 }`.
#[derive(Debug, Clone)]
pub struct SolveOpts {
    pub tilt: f64,
    pub max_iter: u32,
    pub tol: f64,
}

impl Default for SolveOpts {
    fn default() -> Self {
        SolveOpts { tilt: 1.0, max_iter: 200, tol: 1e-13 }
    }
}

/// standing.ts `SolveResult`.
#[derive(Debug, Clone)]
pub struct SolveResult {
    pub ids: Vec<String>,
    pub x: Vec<f64>,
    pub pi: Vec<Vec<f64>>,
    pub iterations: u32,
    pub residual: f64,
    /// x⁰ plus every iterate.
    pub trace: Vec<Vec<f64>>,
}

#[derive(Debug, Clone)]
pub struct GateW1 {
    pub id: String,
    pub burn_bal: f64,
    pub pass: bool,
}

#[derive(Debug, Clone)]
pub struct GateW2a {
    pub id: String,
    pub stamp: f64,
    pub pass: bool,
}

/// standing.ts `GateReport`.
#[derive(Debug, Clone)]
pub struct GateReport {
    pub w1: Vec<GateW1>,
    pub w2a: Vec<GateW2a>,
    pub epoch_stamp: f64,
    pub headroom: f64,
    pub w2b_pass: bool,
    pub all_pass: bool,
}

// kernels.ts 4-6 (sigmoid) — 1 / (1 + Math.exp(-x)).
fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + js_exp(-x))
}

// standing.ts 32-34
fn ref_rate(l: &Ledger) -> f64 {
    l.burn_bal / js_max(l.act_count, 1.0) / NU
}

// standing.ts 37-39
fn emission(l: &Ledger) -> f64 {
    js_min(1.0, ref_rate(l) / SAFE_FLOOR)
}

// standing.ts 42-44
fn mobius(x: f64) -> f64 {
    x / (1.0 + x)
}

// standing.ts 47-50
fn q(p: f64) -> f64 {
    let t = js_tanh(p);
    sigmoid(beta() * p) * (t * (1.0 - ETA * ETA * t)).sqrt()
}

// standing.ts 52 — module-level `const Q1 = Q(1)`, computed once.
fn q1() -> f64 {
    static Q1: OnceLock<f64> = OnceLock::new();
    *Q1.get_or_init(|| q(1.0))
}

// standing.ts 55-58
fn vouch_act(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    js_pow(q(mobius(x)) / q1(), ACT_EXPONENT)
}

// standing.ts 61-63
fn wall_act(x: f64) -> f64 {
    vouch_act(js_max(x, SAFE_FLOOR))
}

// standing.ts 70-85
fn base_score_matrix(ids: &[String], cells: &[FoldCell]) -> Vec<Vec<f64>> {
    // new Map(ids.map((id, i) => [id, i])) — duplicate ids: LAST index wins.
    let mut idx: IndexMap<&str, usize> = IndexMap::new();
    for (i, id) in ids.iter().enumerate() {
        idx.insert(id.as_str(), i);
    }
    let n = ids.len();
    let mut base: Vec<Vec<f64>> = (0..n)
        .map(|u| (0..n).map(|j| if u == j { KAPPA_SELF } else { 0.0 }).collect())
        .collect();
    for cell in cells {
        let u = match idx.get(cell.src.as_str()) {
            Some(&u) => u,
            None => continue,
        };
        let j = idx.get(cell.rcp.as_str()).copied().unwrap_or(u);
        base[u][j] += cell.coeff;
    }
    base
}

// standing.ts 88-104
fn hop_matrix(base: &[Vec<f64>], x: &[f64], hop: usize, tilt: f64) -> Vec<Vec<f64>> {
    let n = base.len();
    let mut lam: Vec<Vec<f64>> = Vec::with_capacity(n);
    let exp = tilt * TILT_SHAPE[hop - 1];
    for u in 0..n {
        let mut row = vec![0.0f64; n];
        let mut sum = 0.0f64;
        for j in 0..n {
            let s = if u == j { base[u][j] } else { base[u][j] * js_pow(wall_act(x[j]), exp) };
            row[j] = s;
            sum += s;
        }
        for v in row.iter_mut() {
            *v /= sum;
        }
        lam.push(row);
    }
    lam
}

// standing.ts 106-117 — i-k-j loop order with the aik === 0 skip.
fn mat_mul(a: &[Vec<f64>], b: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = a.len();
    let mut out: Vec<Vec<f64>> = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for k in 0..n {
            let aik = a[i][k];
            if aik == 0.0 {
                continue;
            }
            for j in 0..n {
                out[i][j] += aik * b[k][j];
            }
        }
    }
    out
}

// standing.ts 123-145 — product LEFT-ASSOCIATED ((Λ1·Λ2)·Λ3)·Λ4; m=1 uses
// lam directly.
fn transport(base: &[Vec<f64>], x: &[f64], emissions: &[f64], tilt: f64) -> Vec<Vec<f64>> {
    let n = base.len();
    let mut mix: Vec<Vec<f64>> = vec![vec![0.0f64; n]; n];
    let mut product: Option<Vec<Vec<f64>>> = None;
    for m in 1..=HOP_MAX {
        let lam = hop_matrix(base, x, m, tilt);
        let p = match product {
            Some(prev) => mat_mul(&prev, &lam),
            None => lam,
        };
        let mass = DEPTH_MASS[m - 1];
        for i in 0..n {
            for j in 0..n {
                mix[i][j] += mass * p[i][j];
            }
        }
        product = Some(p);
    }
    let mut pi: Vec<Vec<f64>> = vec![vec![0.0f64; n]; n];
    for u in 0..n {
        for j in 0..n {
            pi[u][j] = emissions[u] * mix[u][j];
        }
        pi[u][u] += 1.0 - emissions[u];
    }
    pi
}

/// standing.ts solveStanding — plain Picard iteration of the mediant map;
/// pi recomputed at loop TOP every pass (the returned pi is at the x-input
/// of the last pass); residual via max |Δx|, STRICT `< tol` tested after
/// updating x/trace/iter. u-ascending accumulation orders are law.
// standing.ts 165-202
pub fn solve_standing(ledgers: &[Ledger], cells: &[FoldCell], opts: &SolveOpts) -> SolveResult {
    let tilt = opts.tilt;
    let max_iter = opts.max_iter;
    let tol = opts.tol;
    let ids: Vec<String> = ledgers.iter().map(|l| l.id.clone()).collect();
    let base = base_score_matrix(&ids, cells);
    let rates: Vec<f64> = ledgers.iter().map(ref_rate).collect();
    let counts: Vec<f64> = ledgers.iter().map(|l| js_max(l.act_count, 1.0)).collect();
    let emis: Vec<f64> = ledgers.iter().map(emission).collect();

    let mut x: Vec<f64> = rates.clone();
    let mut trace: Vec<Vec<f64>> = vec![x.clone()];
    let mut residual = f64::INFINITY;
    let mut iter: u32 = 0;
    let mut pi = transport(&base, &x, &emis, tilt);
    while iter < max_iter {
        pi = transport(&base, &x, &emis, tilt);
        let mut next = vec![0.0f64; ids.len()];
        for i in 0..ids.len() {
            let mut num = 0.0f64;
            let mut den = 0.0f64;
            for u in 0..ids.len() {
                let m = pi[u][i] * counts[u];
                num += m * rates[u];
                den += m;
            }
            next[i] = if den > 0.0 { num / den } else { rates[i] };
        }
        // Math.max(...next.map((v, i) => Math.abs(v - x[i]))) — spread max
        // fold; empty → -Infinity.
        residual = next
            .iter()
            .enumerate()
            .fold(f64::NEG_INFINITY, |acc, (i, v)| js_max(acc, (v - x[i]).abs()));
        x = next;
        trace.push(x.clone());
        iter += 1;
        if residual < tol {
            break;
        }
    }
    SolveResult { ids, x, pi, iterations: iter, residual, trace }
}

/// standing.ts evaluateGates. `delta_acts` is the JS Map snapshot —
/// insertion-ordered; lookups by ledger id, `?? 0` for absent. x is indexed
/// by ledger position (caller must pass the solve's ledger order).
// standing.ts 222-246
pub fn evaluate_gates(
    ledgers: &[Ledger],
    x: &[f64],
    delta_acts: &IndexMap<String, u64>,
) -> GateReport {
    let w1: Vec<GateW1> = ledgers
        .iter()
        .map(|l| GateW1 { id: l.id.clone(), burn_bal: l.burn_bal, pass: l.burn_bal >= 0.0 })
        .collect();
    let w2a: Vec<GateW2a> = ledgers
        .iter()
        .enumerate()
        .filter(|(_, l)| delta_acts.get(&l.id).copied().unwrap_or(0) > 0)
        .map(|(i, l)| GateW2a { id: l.id.clone(), stamp: x[i], pass: x[i] >= SAFE_FLOOR })
        .collect();
    let mut m_sum = 0.0f64;
    let mut stamp_sum = 0.0f64;
    let mut headroom = 0.0f64;
    for (i, l) in ledgers.iter().enumerate() {
        let m = delta_acts.get(&l.id).copied().unwrap_or(0) as f64;
        if m <= 0.0 {
            continue;
        }
        m_sum += m;
        stamp_sum += m * x[i];
        headroom += m * (x[i] - PART_FLOOR);
    }
    let epoch_stamp = if m_sum > 0.0 { stamp_sum / m_sum } else { 0.0 };
    let w2b_pass = m_sum == 0.0 || epoch_stamp >= PART_FLOOR;
    let all_pass =
        w1.iter().all(|e| e.pass) && w2a.iter().all(|e| e.pass) && w2b_pass;
    GateReport { w1, w2a, epoch_stamp, headroom, w2b_pass, all_pass }
}

#[cfg(test)]
mod tests {
    use super::*;

    // fixtures.ts REFERENCE_EPOCH (engine-internals.md §13) — certified
    // equilibrium probe for solveStanding + evaluateGates (expected values
    // rounded for display).
    #[test]
    fn reference_epoch_probe() {
        let ledgers = [
            ("alice", 1.2944, 12.0),
            ("bob", 1.2472, 11.0),
            ("carol", 1.1472, 10.0),
            ("dave", 0.2, 2.0),
            ("eve", 0.9, 8.0),
        ]
        .map(|(id, b, c)| Ledger { id: id.to_string(), burn_bal: b, act_count: c })
        .to_vec();
        let cells = [
            ("alice", "bob", 0.8638),
            ("alice", "carol", 0.635),
            ("alice", "eve", 0.3969),
            ("bob", "carol", 0.7742),
            ("bob", "dave", 0.6841),
            ("bob", "eve", 0.5062),
            ("carol", "dave", 0.8085),
            ("carol", "eve", 0.7329),
            ("dave", "eve", 0.772),
        ]
        .map(|(s, r, c)| FoldCell { src: s.to_string(), rcp: r.to_string(), coeff: c })
        .to_vec();
        let sv = solve_standing(&ledgers, &cells, &SolveOpts::default());
        // BIT patterns from running the live JS (public/peer-engine.mjs
        // solveStanding on REFERENCE_EPOCH, {tilt:1}) — writeDoubleBE hex.
        let expected_bits: [u64; 5] = [
            0x3ff14237fa89e60f,
            0x3ff1aeded5572da6,
            0x3ff1ec369557b5c4,
            0x3ff1db0964085e9e,
            0x3ff1dfffea0a72e2,
        ];
        for (i, e) in expected_bits.iter().enumerate() {
            assert_eq!(sv.x[i].to_bits(), *e, "x[{i}] = {:.17}", sv.x[i]);
        }
        assert_eq!(sv.iterations, 5);
        assert_eq!(sv.residual.to_bits(), 0x3d15c00000000000);
        assert_eq!(sv.trace.len(), 6);
        let pi0_bits: [u64; 5] = [
            0x3fccc1def2b19ba9,
            0x3fcba8fe944f8ab2,
            0x3fc9cc9925e2356b,
            0x3fb4f13118a6b8d5,
            0x3fd1a7f86364a3e8,
        ];
        for (j, e) in pi0_bits.iter().enumerate() {
            assert_eq!(sv.pi[0][j].to_bits(), *e, "pi[0][{j}]");
        }
        for j in 0..5 {
            assert_eq!(sv.pi[4][j].to_bits(), if j == 4 { 0x3ff0000000000000 } else { 0 });
        }
        let mut dmap: IndexMap<String, u64> = IndexMap::new();
        for (id, n) in [("alice", 2u64), ("bob", 1), ("carol", 1), ("dave", 2), ("eve", 0)] {
            dmap.insert(id.to_string(), n);
        }
        let g = evaluate_gates(&ledgers, &sv.x, &dmap);
        assert_eq!(g.epoch_stamp.to_bits(), 0x3ff1a3995bf89221, "epochStamp {}", g.epoch_stamp);
        assert_eq!(g.headroom.to_bits(), 0x3fe3ab304fa6d988, "headroom {}", g.headroom);
        assert!(g.w2b_pass);
        assert!(g.all_pass);
        assert_eq!(g.w2a.len(), 4); // eve's delta is 0 — filtered out
    }
}

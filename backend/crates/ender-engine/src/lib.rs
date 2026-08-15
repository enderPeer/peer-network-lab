//! Bit-exact Rust port of the deterministic fold (social/replay.cjs) and
//! the engine bundle (src/engine).
//!
//! Definition of done: canonical(epochPackage) reproduces the JS bytes for
//! every close in tests/vectors/packages-live.json and
//! packages-genesis0.json. Porting rules: ../port-notes/CONVENTIONS.md.

pub mod engine; // src/engine consumed surface: RawGraph, solveStanding, evaluateGates
pub mod fold; // replay.cjs: state contract, act dispatch, closeEpoch, finalization
pub mod jsval;
pub mod package; // chain/package.mjs: epochPackage + stateRoot

pub use fold::replay;

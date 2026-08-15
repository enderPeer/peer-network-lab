//! Byte-parity harness: the definition of done for the engine port.
//!
//! (a) For every closeEpoch in each corpus, replay the prefix
//!     [seedWorld, acts[0..=closeIdx]] exactly as the JS harness does
//!     (R.replay([SEED_ACT, ...fileActs.slice(0, idx+1)])), build
//!     epoch_package, and require BYTE equality of canonical() against the
//!     recorded JS bytes (and the stateRoot).
//! (b) For every prefix length, compare trace_digest() against
//!     traces.json — the first diverging index names the exact act to
//!     debug.
//!
//! These tests are EXPECTED to fail at runtime while branch bodies are
//! todo!() stubs; they must always compile.

use serde_json::Value;

use ender_canonical::{canonical, sha256hex};
use ender_engine::fold::replay;
use ender_engine::package::epoch_package;

#[derive(serde::Deserialize)]
struct Corpus {
    acts: String,
    packages: Vec<Pkg>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pkg {
    close_idx: usize,
    epoch: f64,
    state_root: String,
    canonical: String,
}

#[derive(serde::Deserialize)]
struct Traces {
    live: Vec<String>,
    genesis0: Vec<String>,
}

fn vectors_path(name: &str) -> String {
    format!("{}/tests/vectors/{}", env!("CARGO_MANIFEST_DIR"), name)
}

fn load_corpus(name: &str) -> Corpus {
    let raw = std::fs::read_to_string(vectors_path(name))
        .unwrap_or_else(|e| panic!("read {name}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

fn parse_acts(jsonl: &str) -> Vec<Value> {
    jsonl
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("acts jsonl line"))
        .collect()
}

fn seed_act() -> Value {
    serde_json::json!({ "t": "seedWorld" })
}

/// Byte offset (on a char boundary) of the first differing char.
fn first_divergence(a: &str, b: &str) -> usize {
    let mut off = 0usize;
    for (ca, cb) in a.chars().zip(b.chars()) {
        if ca != cb {
            return off;
        }
        off += ca.len_utf8();
    }
    a.len().min(b.len())
}

fn snippet(s: &str, from: usize) -> String {
    s[from.min(s.len())..].chars().take(200).collect()
}

fn check_packages(label: &str, file: &str) {
    let corpus = load_corpus(file);
    let acts = parse_acts(&corpus.acts);
    for p in &corpus.packages {
        // Mirror the JS harness: R.replay([SEED_ACT, ...fileActs.slice(0, idx+1)])
        let mut prefix = Vec::with_capacity(p.close_idx + 2);
        prefix.push(seed_act());
        prefix.extend(acts[..=p.close_idx].iter().cloned());
        let st = replay(&prefix);
        let pkg = epoch_package(&st, p.epoch)
            .unwrap_or_else(|e| panic!("{label} epoch {}: epoch_package failed: {e}", p.epoch));
        let canon = canonical(&pkg)
            .unwrap_or_else(|e| panic!("{label} epoch {}: canonical failed: {e}", p.epoch));
        if canon != p.canonical {
            let d = first_divergence(&canon, &p.canonical);
            panic!(
                "{label} epoch {} (closeIdx {}): canonical package diverges at byte {d}\n  rust: {}\n    js: {}",
                p.epoch,
                p.close_idx,
                snippet(&canon, d),
                snippet(&p.canonical, d),
            );
        }
        let root = sha256hex(&canon);
        assert_eq!(
            root, p.state_root,
            "{label} epoch {}: canonical bytes match but stateRoot differs",
            p.epoch
        );
    }
}

fn check_trace(label: &str, packages_file: &str, digests: &[String]) {
    let corpus = load_corpus(packages_file);
    let acts = parse_acts(&corpus.acts);
    assert_eq!(
        digests.len(),
        acts.len() + 1,
        "{label}: traces.json has {} digests for {} acts (want acts+1)",
        digests.len(),
        acts.len()
    );
    for i in 0..=acts.len() {
        let mut prefix = Vec::with_capacity(i + 1);
        prefix.push(seed_act());
        prefix.extend(acts[..i].iter().cloned());
        let st = replay(&prefix);
        let got = st.trace_digest();
        if got != digests[i] {
            let act_json = if i == 0 {
                "(seed world only — no file acts)".to_string()
            } else {
                serde_json::to_string(&acts[i - 1]).unwrap()
            };
            panic!(
                "{label}: trace digest FIRST diverges at prefix {i} (file act index {})\n  act: {act_json}\n  rust: {got}\n    js: {}",
                i as i64 - 1,
                digests[i],
            );
        }
    }
}

#[test]
fn packages_live_byte_parity() {
    check_packages("live", "packages-live.json");
}

#[test]
fn packages_genesis0_byte_parity() {
    check_packages("genesis0", "packages-genesis0.json");
}

#[test]
fn trace_live_bisector() {
    let raw = std::fs::read_to_string(vectors_path("traces.json")).expect("read traces.json");
    let traces: Traces = serde_json::from_str(&raw).expect("parse traces.json");
    check_trace("live", "packages-live.json", &traces.live);
}

/// The act-level bisector over all 894 genesis-0 prefixes: O(n²) replays,
/// minutes in a debug build. It is a DEBUGGING tool for when a package test
/// diverges, not a routine gate — the per-close package tests above already
/// cover every sealed epoch. Run explicitly with:
///   cargo test -p ender-engine -- --ignored trace_genesis0
#[test]
#[ignore = "O(n^2) bisector; run on demand when a package test diverges"]
fn trace_genesis0_bisector() {
    let raw = std::fs::read_to_string(vectors_path("traces.json")).expect("read traces.json");
    let traces: Traces = serde_json::from_str(&raw).expect("parse traces.json");
    check_trace("genesis0", "packages-genesis0.json", &traces.genesis0);
}

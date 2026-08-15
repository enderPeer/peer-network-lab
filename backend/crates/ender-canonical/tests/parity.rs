//! Cross-language parity: every vector in vectors.json was produced by the
//! real JS chain code (backend/parity/gen-vectors.mjs). The Rust port is
//! correct exactly when every byte matches.

use ender_canonical::*;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    state_quantum: f64,
    values: Vec<ValueVec>,
    merkle: Vec<MerkleVec>,
    quantize: Vec<QuantVec>,
    acts: Vec<ValueVec>,
    blocks: Vec<BlockVec>,
}

#[derive(Deserialize)]
struct ValueVec {
    json: String,
    canonical: String,
    sha256: String,
}

#[derive(Deserialize)]
struct MerkleVec {
    leaves: Vec<String>,
    root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuantVec {
    input_bits: String,
    output_bits: String,
    output_canonical: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockVec {
    json: String,
    digest: String,
    hash: String,
    sig_valid: bool,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors.json")).expect("vectors.json parses")
}

fn bits_to_f64(hex_be: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(hex_be, 16).expect("valid f64 bits"))
}

#[test]
fn state_quantum_matches() {
    assert_eq!(vectors().state_quantum, STATE_QUANTUM);
}

#[test]
fn canonical_value_battery() {
    for (i, v) in vectors().values.iter().enumerate() {
        let parsed: Value = serde_json::from_str(&v.json).expect("vector json parses");
        let got = canonical(&parsed).expect("canonical succeeds");
        assert_eq!(got, v.canonical, "canonical bytes diverge on vector {i}: {}", v.json);
        assert_eq!(hash_canonical(&parsed).unwrap(), v.sha256, "hash diverges on vector {i}");
    }
}

#[test]
fn merkle_battery() {
    for (i, m) in vectors().merkle.iter().enumerate() {
        assert_eq!(merkle_root(&m.leaves), m.root, "merkle root diverges on vector {i}");
    }
}

#[test]
fn quantize_battery() {
    for (i, q) in vectors().quantize.iter().enumerate() {
        let x = bits_to_f64(&q.input_bits);
        let got = quantize(x).expect("quantize succeeds");
        assert_eq!(
            got.to_bits(),
            bits_to_f64(&q.output_bits).to_bits(),
            "quantize bits diverge on vector {i} (input bits {})",
            q.input_bits
        );
        let canon = canonical(&serde_json::Number::from_f64(got).map(Value::Number).expect("finite"))
            .expect("canonical of quantized value");
        assert_eq!(canon, q.output_canonical, "canonical form diverges on quantize vector {i}");
    }
}

#[test]
fn real_act_log_parity() {
    let v = vectors();
    assert!(!v.acts.is_empty(), "act vectors present");
    for (i, a) in v.acts.iter().enumerate() {
        let parsed: Value = serde_json::from_str(&a.json).expect("act line parses");
        assert_eq!(canonical(&parsed).unwrap(), a.canonical, "act {i} canonical bytes diverge");
        assert_eq!(hash_canonical(&parsed).unwrap(), a.sha256, "act {i} hash diverges");
    }
}

#[test]
fn real_signed_blocks_parity() {
    let v = vectors();
    assert!(!v.blocks.is_empty(), "block vectors present");
    for (i, b) in v.blocks.iter().enumerate() {
        let parsed: Value = serde_json::from_str(&b.json).expect("block line parses");
        assert_eq!(block_digest(&parsed).unwrap(), b.digest, "block {i} digest diverges");
        assert_eq!(block_hash(&parsed).unwrap(), b.hash, "block {i} hash diverges");
        assert!(b.sig_valid, "generator verified the real signature");
        assert!(
            verify_block_signature(&parsed),
            "block {i} Ed25519 signature must verify in Rust"
        );
    }
}

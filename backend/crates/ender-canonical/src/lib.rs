//! Bit-exact Rust port of the chain's canonical layer (webapp/chain/):
//! canonical.mjs, merkle.mjs, and the verification side of block.mjs /
//! keys.mjs.
//!
//! Correctness is defined by tests/vectors.json, generated from the JS
//! originals by backend/parity/gen-vectors.mjs over an adversarial value
//! battery plus the live act log and real signed blocks — never by this
//! file alone. Two verifiers either match bits or the discrepancy is
//! attributable; there is no third outcome.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt::Write as _;

/// canonical.mjs STATE_QUANTUM: the published rounding quantum.
pub const STATE_QUANTUM: f64 = 1e-9;
/// block.mjs CHAIN_VERSION.
pub const CHAIN_VERSION: u64 = 1;
/// block.mjs NET_ID — frozen; part of every block's signed preimage.
pub const NET_ID: &str = "peernetwork-sandbox/v0.24.1-dev";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalError {
    /// canonical.mjs refuses NaN and the infinities rather than nulling them.
    NonFiniteNumber,
    /// A block operation was handed a non-object value.
    NotAnObject,
}

impl std::fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CanonicalError::NonFiniteNumber => write!(f, "canonical: non-finite number"),
            CanonicalError::NotAnObject => write!(f, "canonical: expected an object"),
        }
    }
}

impl std::error::Error for CanonicalError {}

/// One byte sequence per value, or an error — the exact bytes
/// webapp/chain/canonical.mjs produces for the same parsed JSON value.
pub fn canonical(v: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_canonical(v, &mut out)?;
    Ok(out)
}

fn write_canonical(v: &Value, out: &mut String) -> Result<(), CanonicalError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // JS holds every JSON number as an f64 before re-serializing;
            // widening any integer representation here reproduces JSON.parse,
            // and ryu-js reproduces ECMA-262 Number::toString exactly.
            let x = n.as_f64().ok_or(CanonicalError::NonFiniteNumber)?;
            if !x.is_finite() {
                return Err(CanonicalError::NonFiniteNumber);
            }
            let mut buf = ryu_js::Buffer::new();
            out.push_str(buf.format(x));
        }
        Value::String(s) => write_quoted(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // canonical.mjs sorts with Array.prototype.sort() — UTF-16
            // code-unit order, which diverges from Rust's scalar-value
            // order for astral-plane keys.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_quoted(k, out);
                out.push(':');
                write_canonical(&map[k.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// ECMA-262 QuoteJSONString, the escaping JSON.stringify applies: the two
/// quoting characters, the five short escapes, remaining C0 controls as
/// lowercase \u00xx, everything else literal (including U+2028/U+2029).
/// Lone surrogates cannot reach here: serde_json refuses them at parse,
/// which surfaces as a loud error rather than a silent hash divergence.
fn write_quoted(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// ECMA-262 Number::toString(10) — what String(x), JSON.stringify(x) and
/// template literals produce for a finite double.
pub fn js_number_to_string(x: f64) -> String {
    let mut buf = ryu_js::Buffer::new();
    buf.format(x).to_string()
}

pub fn sha256hex(data: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(data.as_ref()))
}

pub fn hash_canonical(v: &Value) -> Result<String, CanonicalError> {
    Ok(sha256hex(canonical(v)?))
}

/// ECMA-262 Math.round: the closest integer, ties toward +∞, sign of zero
/// preserved. Differs from f64::round (ties away from zero) on negative
/// halves, and from floor(x + 0.5) on 0.49999999999999994. `y - floor(y)`
/// is exact for every double where the tie decision is reachable, so the
/// comparison below decides ties correctly.
pub fn js_math_round(y: f64) -> f64 {
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

/// canonical.mjs quantize: round to the published 1e-9 grid, normalizing
/// -0 to 0, refusing non-finite input.
pub fn quantize(x: f64) -> Result<f64, CanonicalError> {
    if !x.is_finite() {
        return Err(CanonicalError::NonFiniteNumber);
    }
    let r = js_math_round(x / STATE_QUANTUM) * STATE_QUANTUM;
    // JS writes `Object.is(r, -0) ? 0 : r`; +0 and -0 both land on +0 here,
    // which is the same observable behavior.
    Ok(if r == 0.0 { 0.0 } else { r })
}

/// merkle.mjs: domain-separated ('L'/'N') root over ordered hex leaves,
/// odd node carried up unchanged, empty list pinned to a published constant.
pub fn merkle_root(leaves: &[String]) -> String {
    if leaves.is_empty() {
        return sha256hex("peer-merkle-empty");
    }
    let mut level: Vec<String> = leaves.iter().map(|h| sha256hex(format!("L{h}"))).collect();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(sha256hex(format!("N{}{}", level[i], level[i + 1])));
            } else {
                next.push(level[i].clone());
            }
            i += 2;
        }
        level = next;
    }
    level.pop().unwrap()
}

/// block.mjs blockDigest: hash of the block minus its signature.
pub fn block_digest(block: &Value) -> Result<String, CanonicalError> {
    let map = block.as_object().ok_or(CanonicalError::NotAnObject)?;
    let mut unsigned = map.clone();
    unsigned.remove("sig");
    hash_canonical(&Value::Object(unsigned))
}

/// block.mjs blockHash: the hash of the whole sealed block, signature included.
pub fn block_hash(block: &Value) -> Result<String, CanonicalError> {
    hash_canonical(block)
}

/// keys.mjs verifyDigest: Ed25519 over the RAW 32 digest bytes; the public
/// key is the raw 32-byte point base64url (no padding), the signature
/// base64url. False on any malformed input, like the JS try/catch.
pub fn verify_digest(pub_b64u: &str, hex_digest: &str, sig_b64u: &str) -> bool {
    let Ok(pk_bytes) = URL_SAFE_NO_PAD.decode(pub_b64u) else {
        return false;
    };
    let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let Ok(msg) = hex::decode(hex_digest) else {
        return false;
    };
    let Ok(sig_bytes) = URL_SAFE_NO_PAD.decode(sig_b64u) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    vk.verify(&msg, &sig).is_ok()
}

/// block.mjs verifyBlockSignature.
pub fn verify_block_signature(block: &Value) -> bool {
    let Some(map) = block.as_object() else {
        return false;
    };
    let (Some(producer), Some(sig)) = (
        map.get("producer").and_then(Value::as_str),
        map.get("sig").and_then(Value::as_str),
    ) else {
        return false;
    };
    let Ok(digest_hex) = block_digest(block) else {
        return false;
    };
    verify_digest(producer, &digest_hex, sig)
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn ryu_js_matches_ecma_number_tostring() {
        let mut b = ryu_js::Buffer::new();
        assert_eq!(b.format(-0.0f64), "0");
        assert_eq!(b.format(1e21f64), "1e+21");
        assert_eq!(b.format(1e-7f64), "1e-7");
        assert_eq!(b.format(0.000001f64), "0.000001");
        assert_eq!(b.format(1.0f64), "1");
        assert_eq!(b.format(5e-324f64), "5e-324");
    }

    #[test]
    fn math_round_edges() {
        assert_eq!(js_math_round(2.5), 3.0);
        assert_eq!(js_math_round(-2.5), -2.0);
        assert_eq!(js_math_round(0.49999999999999994), 0.0);
        assert!(!js_math_round(0.49999999999999994).is_sign_negative());
        let neg = js_math_round(-0.49999999999999994);
        assert_eq!(neg, 0.0);
        assert!(neg.is_sign_negative(), "Math.round in (-0.5, 0) returns -0");
    }

    #[test]
    fn utf16_order_diverges_from_scalar_order() {
        // U+10000 encodes as surrogates D800 DC00 in UTF-16: below U+E000.
        assert_eq!(utf16_cmp("\u{10000}", "\u{e000}"), Ordering::Less);
        // Rust scalar order says the opposite.
        assert!("\u{10000}" > "\u{e000}");
    }
}

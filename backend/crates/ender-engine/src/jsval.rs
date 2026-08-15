//! JS-semantics helpers over serde_json::Value — the shared vocabulary of
//! the fold port. Acts arrive as parsed JSON; a missing field is JS
//! `undefined`, which is distinct from null and from ''.

use serde_json::Value;
use std::cmp::Ordering;

/// JS ToBoolean of a JSON value ('undefined' = None).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            x != 0.0 && !x.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Field as &str when it is a string.
pub fn js_str<'a>(act: &'a Value, field: &str) -> Option<&'a str> {
    act.get(field).and_then(Value::as_str)
}

/// Field as f64 when it is a number (JS numbers are always doubles).
pub fn js_num(act: &Value, field: &str) -> Option<f64> {
    act.get(field).and_then(Value::as_f64)
}

/// JS ToInt32 (the `| 0` coercion): modular, not saturating.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc() % 4294967296.0;
    let u = if m < 0.0 { m + 4294967296.0 } else { m } as u64 as u32;
    u as i32
}

/// JS string `<` / sort(): UTF-16 code-unit order.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `Object.keys(m).sort()` order for key lists.
pub fn utf16_sorted(mut keys: Vec<String>) -> Vec<String> {
    keys.sort_by(|a, b| utf16_cmp(a, b));
    keys
}

/// Guard for the JS for-in enumeration exception: integer-like keys would
/// iterate first in JS but not in IndexMap. Live ids/symbols never are;
/// this keeps that assumption loud.
pub fn key_is_integer_like(k: &str) -> bool {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) {
        return false;
    }
    k.bytes().all(|b| b.is_ascii_digit()) && k.parse::<u32>().map_or(false, |n| n < u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int32_coercion_wraps_like_js() {
        assert_eq!(to_int32(4294967296.0), 0);
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn integer_like_keys_flagged() {
        assert!(key_is_integer_like("0"));
        assert!(key_is_integer_like("42"));
        assert!(!key_is_integer_like("042"));
        assert!(!key_is_integer_like("u_bob"));
        assert!(!key_is_integer_like(""));
    }
}

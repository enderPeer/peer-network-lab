//! Bit-parity of the transcendental backend against V8: every vector was
//! recorded from the real engine's Math calls during real replays, plus a
//! seeded sweep. Zero mismatches or the backend is wrong.

use ender_jsmath::{js_exp, js_log, js_pow, js_tanh};
use serde::Deserialize;

#[derive(Deserialize)]
struct File {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    fn_name: Option<String>,
    #[serde(rename = "fn")]
    fnf: String,
    a: String,
    b: Option<String>,
    r: String,
}

fn bits(hex: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(hex, 16).expect("valid bits"))
}

#[test]
fn v8_transcendental_parity() {
    let file: File = serde_json::from_str(include_str!(
        "../../ender-engine/tests/vectors/transcendentals.json"
    ))
    .expect("vectors parse");
    let mut mismatches: std::collections::BTreeMap<&str, (u64, u64, Option<String>)> =
        Default::default();
    for v in &file.vectors {
        let _ = &v.fn_name;
        let a = bits(&v.a);
        let want = bits(&v.r);
        let got = match (v.fnf.as_str(), &v.b) {
            ("pow", Some(b)) => js_pow(a, bits(b)),
            ("exp", None) => js_exp(a),
            ("tanh", None) => js_tanh(a),
            ("log", None) => js_log(a),
            other => panic!("unexpected vector shape: {other:?}"),
        };
        let entry = mismatches.entry(match v.fnf.as_str() {
            "pow" => "pow",
            "exp" => "exp",
            "tanh" => "tanh",
            _ => "log",
        });
        let e = entry.or_insert((0, 0, None));
        e.1 += 1;
        if got.to_bits() != want.to_bits() {
            e.0 += 1;
            if e.2.is_none() {
                e.2 = Some(format!(
                    "first mismatch: {}({}{}) -> got {:016x}, V8 {:016x}",
                    v.fnf,
                    a,
                    v.b.as_ref().map(|b| format!(", {}", bits(b))).unwrap_or_default(),
                    got.to_bits(),
                    want.to_bits()
                ));
            }
        }
    }
    let mut report = String::new();
    let mut total_bad = 0;
    for (f, (bad, total, first)) in &mismatches {
        report.push_str(&format!("{f}: {bad}/{total} mismatched\n"));
        if let Some(m) = first {
            report.push_str(&format!("  {m}\n"));
        }
        total_bad += bad;
    }
    assert_eq!(total_bad, 0, "\n{report}");
}

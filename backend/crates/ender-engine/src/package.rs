//! REAL port of webapp/chain/package.mjs — epochPackage + stateRoot over
//! the fold State. Only redaction-invariant quantities are committed;
//! every inexact value is quantized to STATE_QUANTUM before hashing;
//! arrays sorted by id in UTF-16 order; object key order is irrelevant
//! (the canonical encoding sorts keys itself).

use serde_json::{Map, Number, Value};

use ender_canonical::{hash_canonical, js_number_to_string, quantize, CanonicalError};
use indexmap::IndexMap;

use crate::fold::state::State;
use crate::jsval::utf16_cmp;

fn num(x: f64) -> Result<Value, String> {
    Number::from_f64(x)
        .map(Value::Number)
        .ok_or_else(|| "canonical: non-finite number".to_string())
}

fn qnum(x: f64) -> Result<Value, String> {
    num(quantize(x).map_err(|e| e.to_string())?)
}

// package.mjs 21-25 — quantizeMap: every value quantized; key order is the
// map's insertion order (canonical re-sorts on encode).
fn quantize_map(m: &IndexMap<String, f64>) -> Result<Value, String> {
    let mut out = Map::new();
    for (k, v) in m {
        out.insert(k.clone(), qnum(*v)?);
    }
    Ok(Value::Object(out))
}

/// package.mjs 31-85 — epochPackage(st, epochNo). The replay prefix must
/// end at the closeEpoch for `epoch_no`; anything else is the JS throw,
/// surfaced here as Err with the same message.
pub fn epoch_package(st: &State, epoch_no: f64) -> Result<Value, String> {
    let cert = match st.epoch_history.last() {
        Some(c) if c.epoch == epoch_no => c,
        other => {
            let last = other
                .map(|c| js_number_to_string(c.epoch))
                .unwrap_or_else(|| "none".to_string());
            return Err(format!(
                "epochPackage: replay prefix does not end at epoch {} (last certificate: {})",
                js_number_to_string(epoch_no),
                last
            ));
        }
    };

    // ledgers: {id, burnBal quantized, actCount}, sorted by id (JS string <).
    let mut ordered: Vec<&crate::fold::state::Ledger> = st.ledgers.iter().collect();
    ordered.sort_by(|a, b| utf16_cmp(&a.id, &b.id)); // stable, like Array.sort
    let mut ledgers = Vec::with_capacity(ordered.len());
    for l in ordered {
        let mut m = Map::new();
        m.insert("id".to_string(), Value::String(l.id.clone()));
        m.insert("burnBal".to_string(), qnum(l.burn_bal)?);
        m.insert("actCount".to_string(), Value::from(l.act_count));
        ledgers.push(Value::Object(m));
    }

    // tokens.bal: sym → quantized actor map.
    let mut bal = Map::new();
    for (sym, inner) in &st.token_bal {
        bal.insert(sym.clone(), quantize_map(inner)?);
    }

    // pools.
    let mut pools = Map::new();
    for (pid, p) in &st.pools {
        let mut pm = Map::new();
        pm.insert("a".to_string(), Value::String(p.a.clone()));
        pm.insert("b".to_string(), Value::String(p.b.clone()));
        pm.insert("resA".to_string(), qnum(p.res_a)?);
        pm.insert("resB".to_string(), qnum(p.res_b)?);
        pm.insert("totalShares".to_string(), qnum(p.total_shares)?);
        pm.insert("shares".to_string(), quantize_map(&p.shares)?);
        pm.insert("swaps".to_string(), Value::from(p.swaps));
        pm.insert("volA".to_string(), qnum(p.vol_a)?);
        pm.insert("volB".to_string(), qnum(p.vol_b)?);
        pools.insert(pid.clone(), Value::Object(pm));
    }

    // tokens.dist: only the epoch that just closed.
    let mut dist = Vec::new();
    for d in &st.token_dist {
        if (d.epoch as f64) == epoch_no {
            let mut dm = Map::new();
            dm.insert("epoch".to_string(), Value::from(d.epoch));
            dm.insert("minted".to_string(), qnum(d.minted)?);
            dm.insert("carried".to_string(), qnum(d.carried)?);
            dm.insert("to".to_string(), quantize_map(&d.to)?);
            dist.push(Value::Object(dm));
        }
    }

    // certificate: reading stamp/headroom/pass settles the deferred solve —
    // the certificate is priced to whoever seals or verifies.
    let mut certificate = Map::new();
    certificate.insert("epoch".to_string(), num(cert.epoch)?);
    certificate.insert("acts".to_string(), Value::from(cert.acts));
    certificate.insert("stamp".to_string(), qnum(cert.stamp())?);
    certificate.insert("headroom".to_string(), qnum(cert.headroom())?);
    certificate.insert("pass".to_string(), Value::Bool(cert.pass()));

    // tokens wrapper.
    let mut tokens = Map::new();
    tokens.insert("supply".to_string(), quantize_map(&st.token_supply)?);
    tokens.insert("bal".to_string(), Value::Object(bal));
    tokens.insert("carry".to_string(), qnum(st.token_carry)?);
    tokens.insert("epochN".to_string(), Value::from(st.tok_epoch_n));
    // claimed: Object.keys(...).sort() — UTF-16 order.
    let mut claimed: Vec<String> = st.btc_claimed.keys().cloned().collect();
    claimed.sort_by(|a, b| utf16_cmp(a, b));
    tokens.insert(
        "claimed".to_string(),
        Value::Array(claimed.into_iter().map(Value::String).collect()),
    );
    tokens.insert("dist".to_string(), Value::Array(dist));
    // assets: the live tokenMeta map — {name, creator} with null creators.
    let mut assets = Map::new();
    for (sym, meta) in &st.token_meta {
        let mut am = Map::new();
        am.insert("name".to_string(), Value::String(meta.name.clone()));
        am.insert(
            "creator".to_string(),
            meta.creator.clone().map(Value::String).unwrap_or(Value::Null),
        );
        assets.insert(sym.clone(), Value::Object(am));
    }
    tokens.insert("assets".to_string(), Value::Object(assets));

    let mut pkg = Map::new();
    pkg.insert("epoch".to_string(), num(epoch_no)?);
    pkg.insert("ledgers".to_string(), Value::Array(ledgers));
    pkg.insert("standing".to_string(), quantize_map(&st.x_by_id)?);
    pkg.insert("certificate".to_string(), Value::Object(certificate));
    pkg.insert("tokens".to_string(), Value::Object(tokens));
    pkg.insert("pools".to_string(), Value::Object(pools));
    Ok(Value::Object(pkg))
}

/// package.mjs 87-89 — stateRoot(pkg) = hashCanonical(pkg).
pub fn state_root(pkg: &Value) -> Result<String, CanonicalError> {
    hash_canonical(pkg)
}

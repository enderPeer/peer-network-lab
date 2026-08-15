//! PEER-burn door and address binding — replay.cjs 1566-1626 (peerBurn),
//! 2025-2081 (bindAddress), and peerBurnActError (376-590). Map:
//! port-notes/replay-branches.md "peerBurn", "bindAddress",
//! "peerBurnActError" (the 24 ordered checks). Refusal-message strings are
//! API: byte-for-byte. BigInt paths (amtRaw accumulation, pricing) use
//! BigUint via state::peer_burn_sats / the peer_burned_raw string ledger.

#![allow(unused_variables, dead_code)]

use indexmap::IndexMap;
use num_bigint::BigUint;
use serde_json::Value;

use ender_canonical::js_number_to_string;

use super::state::{
    bindable_address, js_prop_key, js_tonum, peer_burn_grid, peer_burn_sats, peer_text, Binder,
    ChronEntry, ChronLine, State, WhoField, PEER_BURN_ADDR, PEER_BURN_CAP_FROM_EPOCH,
    PEER_BURN_GRID, PEER_BURN_MIN_POOL_SATS, PEER_BURN_RESERVE_PER_EPOCH,
    PEER_BURN_SATS_PER_EPOCH, PEER_BURN_TWAP_MS, PEER_BURN_TWAP_OBS, SATS_PER_RESERVE,
};
use crate::jsval::truthy;

/// JS Number.isInteger(v): Some(value) only when the field is a number with
/// no fractional part.
fn int_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => {
            let x = n.as_f64()?;
            if x.is_finite() && x.fract() == 0.0 {
                Some(x)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Field as f64 only when it is a JSON number (JS `typeof x === 'number'`).
fn plain_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

// /^0x[0-9a-fA-F]{64}$/
fn is_hex_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

// /^0x[0-9a-fA-F]{40}$/
fn is_hex_addr(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

// /^0x[0-9a-f]{40}$/ (applied to an already-lowercased string)
fn is_hex_addr_lower(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s.as_bytes()[2..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// JS Number.prototype.toFixed(digits) for finite |x| < 1e21: n is the
/// integer with n / 10^digits closest to x, ties picking the LARGER n
/// (toward +infinity). Exact via the f64's binary decomposition.
pub(crate) fn js_to_fixed(x: f64, digits: u32) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    let neg = x < 0.0; // -0 formats without a sign
    let ax = x.abs();
    let bits = ax.to_bits();
    let exp_bits = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp_bits == 0 { (frac, -1074i64) } else { (frac | (1u64 << 52), exp_bits - 1075) };
    let scaled = BigUint::from(m) * BigUint::from(10u32).pow(digits);
    let n = if e >= 0 {
        scaled << (e as usize)
    } else {
        let den = BigUint::from(1u8) << ((-e) as usize);
        let q = &scaled / &den;
        let r = &scaled % &den;
        let twice = r << 1usize;
        // Larger n on a tie: round the magnitude up for positive x, down
        // for negative x.
        if twice > den || (twice == den && !neg) {
            q + 1u8
        } else {
            q
        }
    };
    let mut s = n.to_string();
    let need = (digits + 1) as usize;
    while s.len() < need {
        s.insert(0, '0');
    }
    let point = s.len() - digits as usize;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&s[..point]);
    if digits > 0 {
        out.push('.');
        out.push_str(&s[point..]);
    }
    out
}

// replay.cjs 1566-1626 — peerBurn: known + peerBurnActError gate (refusal
// chron payload-guarded), then tx/epoch/pool use tables, BigInt
// peerBurnedRaw accumulation, burnBal += creditsSats/SATS_PER_RESERVE.
// burnedSats deliberately NOT touched. No debit.
pub(crate) fn peer_burn(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    // replay.cjs 1566-1626
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return;
    }
    if let Some(pb_why) = peer_burn_act_error(st, a, st.certs_so_far) {
        if !payload_gone {
            st.chron.push(ChronEntry {
                who: WhoField::Id(id),
                line: ChronLine::Text(format!("a PEER burn was refused by replay — {pb_why}")),
                to: None,
                refs: None,
            });
        }
        return;
    }
    // Every field below was validated by the checker: txid is a 0x-hash
    // string, amtRaw a RAW_INT string, creditsSats/sats integer numbers,
    // factory a 0x-address string, pool a non-negative integer number.
    let pb_tx = js_prop_key(a.get("txid")).to_lowercase(); // one spelling; see the checker
    let credits = plain_number(a.get("creditsSats")).expect("checker validated creditsSats");
    let credits_u = credits as u64;
    st.peer_burn_tx_by.insert(pb_tx.clone(), id.clone());
    *st.peer_burn_tx_sats.entry(pb_tx.clone()).or_insert(0) += credits_u;
    let amt_raw = a.get("amtRaw").and_then(Value::as_str).expect("checker validated amtRaw");
    let prev = st.peer_burned_raw.get(&id).map(String::as_str).unwrap_or("0");
    let sum = BigUint::parse_bytes(prev.as_bytes(), 10).expect("stored decimal string")
        + BigUint::parse_bytes(amt_raw.as_bytes(), 10).expect("checker validated RAW_INT");
    st.peer_burned_raw.insert(id.clone(), sum.to_string());
    let pb_key = format!("{id}@{}", st.certs_so_far);
    *st.peer_burn_epoch_use.entry(pb_key).or_insert(0) += credits_u;
    let pb_pool = format!(
        "{}#{}@{}",
        js_prop_key(a.get("factory")).to_lowercase(),
        js_prop_key(a.get("pool")),
        st.certs_so_far
    );
    *st.peer_burn_pool_use.entry(pb_pool).or_insert(0) += credits_u;
    let pb_gained = credits / SATS_PER_RESERVE;
    let ix = st.ledger_by_id[&id];
    st.ledgers[ix].burn_bal += pb_gained;
    if !payload_gone {
        let a_sats = plain_number(a.get("sats")).expect("checker validated sats");
        let pb_part = if credits < a_sats {
            format!(
                " ({} of the burn’s {} sat — the rest after the next epoch closes)",
                js_number_to_string(credits),
                js_number_to_string(a_sats)
            )
        } else {
            String::new()
        };
        st.chron.push(ChronEntry {
            who: WhoField::Id(id),
            line: ChronLine::Text(format!(
                "burned {} PEER → {} sat → +{} reserve{} · tx {}… (priced by the pool, dead-address burn — unspendable because no key is known for it, not provably unspendable like the bitcoin burn beside it)",
                peer_text(amt_raw),
                js_number_to_string(a_sats),
                js_to_fixed(pb_gained, 4),
                pb_part,
                &pb_tx[..12]
            )),
            to: None,
            refs: None,
        });
    }
}

// replay.cjs 2025-2081 — bindAddress: bindableAddress gate, addrOf newest
// wins, binder first-bind bookkeeping (n/id/ts/seen), never debited,
// recorded unconditionally (survives deletion); chron payload-guarded.
pub(crate) fn bind_address(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    // replay.cjs 2025-2081
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return;
    }
    let bound_to = bindable_address(a.get("addr"));
    if bound_to.is_empty() {
        return;
    }
    st.addr_of.insert(id.clone(), bound_to.clone()); // newest wins, forward only
    let bnd = st.addr_binders.entry(bound_to.clone()).or_insert_with(|| Binder {
        n: 0,
        id: None,
        ts: None,
        seen: IndexMap::new(),
    });
    if !bnd.seen.contains_key(&id) {
        // typeof a.ts === 'number' && isFinite(a.ts) — serde numbers are
        // always finite.
        let ts = plain_number(a.get("ts"));
        bnd.seen.insert(id.clone(), ts);
        bnd.n += 1;
        bnd.id = if bnd.n == 1 { Some(id.clone()) } else { None };
        bnd.ts = if bnd.n == 1 { ts } else { None };
    }
    if !payload_gone {
        st.chron.push(ChronEntry {
            who: WhoField::Id(id),
            line: ChronLine::Text(format!(
                "bound epoch earnings to {}…{} on Base — takes effect at the NEXT epoch close; roots already published cannot change",
                &bound_to[..10],
                &bound_to[bound_to.len() - 6..]
            )),
            to: None,
            refs: None,
        });
    }
}

/// replay.cjs 376-590 — peerBurnActError(a, epoch): the 24 checks IN ORDER
/// (txid shape, sink, source address, ownership, block time, binding
/// precedence, pool identity, BigInt pricing, recomputed sats/reserve,
/// pool floor, TWAP window/observations, block range, refHash, grid
/// subsequence, creditsSats, tx ceiling, per-account ceiling, per-pool
/// ceiling). None = allowed; Some(sentence) = exact refusal. `epoch` is
/// certsSoFar at call time.
pub(crate) fn peer_burn_act_error(st: &State, a: &Value, epoch: u64) -> Option<String> {
    // replay.cjs 376-590
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return Some("unknown actor".to_string());
    }
    let txid_ok = matches!(a.get("txid"), Some(Value::String(s)) if is_hex_hash(s));
    if !txid_ok {
        return Some(
            "a PEER burn is identified by its Base transaction hash, and this one is not a transaction hash"
                .to_string(),
        );
    }
    // ONE SPELLING, decided here and used for every table below.
    let txk = a.get("txid").and_then(Value::as_str).unwrap().to_lowercase();
    let addr = if truthy(a.get("addr")) { js_prop_key(a.get("addr")) } else { String::new() };
    if addr.to_lowercase() != PEER_BURN_ADDR {
        return Some(format!(
            "a PEER burn must pay {PEER_BURN_ADDR} — the deployed token refuses address(0) on purpose, so the sink is a dead-but-nonzero address and nothing else counts"
        ));
    }
    // ── Whose burn this is ───────────────────────────────────────────────
    let src = match a.get("from") {
        None | Some(Value::Null) => String::new(),
        other => js_prop_key(other),
    }
    .to_lowercase();
    if !is_hex_addr_lower(&src) {
        return Some(
            "a PEER burn must record the address the coins were sent from, and this one does not"
                .to_string(),
        );
    }
    let own = match st.addr_binders.get(&src) {
        Some(o) if o.n != 0 => o,
        _ => {
            return Some(format!(
                "no handle had bound {src} when those coins were destroyed, so this burn belongs to nobody — a burn is credited by a binding that was already in the log, never by one filed afterwards"
            ));
        }
    };
    if own.n > 1 {
        return Some(format!(
            "more than one handle has bound {src}, so whose burn this is cannot be decided from the log — an ambiguous address closes this door rather than guessing which handle to pay"
        ));
    }
    if own.id.as_deref() != Some(id.as_str()) {
        return Some(format!(
            "{src} is bound to {} and this act credits {id} — a burn is credited to whoever destroyed the coins, and the log says who that was",
            own.id.as_deref().unwrap_or("null")
        ));
    }
    let block_ms = match int_number(a.get("blockMs")) {
        Some(v) if v > 0.0 => v,
        _ => {
            return Some(
                "a PEER burn must record the timestamp of the block that destroyed the coins, and this one does not"
                    .to_string(),
            );
        }
    };
    if !matches!(own.ts, Some(t) if t <= block_ms) {
        return Some(if own.ts.is_none() {
            format!(
                "{src} was bound by an act that carries no time, so nothing here can say the binding came before the burn"
            )
        } else {
            format!(
                "{src} was bound after those coins were destroyed, so the binding cannot reach them — bind the address first, then burn from it"
            )
        });
    }
    // ── Which pool these reserves came out of ────────────────────────────
    let pool_ok = matches!(int_number(a.get("pool")), Some(v) if !(v < 0.0));
    if !pool_ok {
        return Some("a PEER burn must name the pool it was priced against".to_string());
    }
    let factory_ok = matches!(a.get("factory"), Some(Value::String(s)) if is_hex_addr(s));
    if !factory_ok {
        return Some(format!(
            "a PEER burn must name the factory contract the pool lives in — a pool id with no factory behind it is not an identity, because two factories both have a pool {}",
            js_prop_key(a.get("pool"))
        ));
    }
    let sats = match peer_burn_sats(a.get("amtRaw"), a.get("resPeerRaw"), a.get("resBtcRaw")) {
        Some(s) => s,
        None => {
            return Some(
                "the recorded amount and pool reserves are not three positive whole numbers, so there is no price to check"
                    .to_string(),
            );
        }
    };
    // ── The two cross-checks that make the act self-proving ──────────────
    if plain_number(a.get("sats")) != Some(sats) {
        return Some(format!(
            "this act records {} sat but its own reserves price the burn at {} sat — a host that disagrees with itself is not evidence of anything",
            js_prop_key(a.get("sats")),
            js_number_to_string(sats)
        ));
    }
    if plain_number(a.get("reserve")) != Some(sats / SATS_PER_RESERVE) {
        return Some(format!(
            "this act records {} reserve for {} sat, and the rate is {} sat per unit for BOTH doors",
            js_prop_key(a.get("reserve")),
            js_number_to_string(sats),
            js_number_to_string(SATS_PER_RESERVE)
        ));
    }
    // ── The anti-manipulation floors, checked against what was recorded ───
    let res_btc_raw = a.get("resBtcRaw").and_then(Value::as_str).unwrap();
    let res_btc_big = BigUint::parse_bytes(res_btc_raw.as_bytes(), 10).unwrap();
    if res_btc_big < BigUint::from(PEER_BURN_MIN_POOL_SATS) {
        return Some(format!(
            "the pool held {res_btc_raw} sat of bitcoin and a burn needs at least {PEER_BURN_MIN_POOL_SATS} — below that a pool has no price, only a last trade"
        ));
    }
    if !(js_tonum(a.get("twapMs")) >= PEER_BURN_TWAP_MS) {
        return Some(format!(
            "the price was averaged over {} ms and at least {} is required — a spot price is whatever the last trade left behind",
            js_prop_key(a.get("twapMs")),
            js_number_to_string(PEER_BURN_TWAP_MS)
        ));
    }
    let obs_num = js_tonum(a.get("obs"));
    if !(obs_num >= PEER_BURN_TWAP_OBS) {
        return Some(format!(
            "the price came from {} observation(s) and at least {} are required",
            js_prop_key(a.get("obs")),
            js_number_to_string(PEER_BURN_TWAP_OBS)
        ));
    }
    // Where the window sat, and which blocks inside it were actually read.
    let starts_at = int_number(a.get("startsAt"));
    let ends_at = int_number(a.get("endsAt"));
    let range_ok = matches!((starts_at, ends_at), (Some(s), Some(e)) if !(s < 0.0) && e > s);
    if !range_ok {
        return Some(
            "a PEER burn must record the block range its price was averaged over, and this one does not"
                .to_string(),
        );
    }
    let ref_hash = match a.get("refHash") {
        Some(Value::String(s)) if is_hex_hash(s) => s.as_str(),
        _ => {
            return Some(
                "a PEER burn must record the hash of the block its window ends at — that hash is what decides which blocks were sampled, and without it the sampling is unauditable"
                    .to_string(),
            );
        }
    };
    let blocks = match a.get("blocks") {
        Some(Value::Array(items)) if items.len() as f64 == obs_num => items,
        _ => {
            return Some(
                "a PEER burn must list the blocks its price was read at, one per observation it claims"
                    .to_string(),
            );
        }
    };
    let grid = peer_burn_grid(
        starts_at.unwrap() as i64,
        ends_at.unwrap() as i64,
        ref_hash,
        PEER_BURN_GRID,
    );
    let mut gi = 0usize;
    for item in blocks {
        let bb = match int_number(Some(item)) {
            Some(v) => v,
            None => {
                return Some(
                    "a PEER burn lists a sampled block that is not a whole number".to_string(),
                );
            }
        };
        while gi < grid.len() && (grid[gi] as f64) < bb {
            gi += 1;
        }
        if gi >= grid.len() || (grid[gi] as f64) != bb {
            return Some(format!(
                "block {} is not one the recorded window and block hash select, so these readings were not sampled by the rule this network uses",
                js_number_to_string(bb)
            ));
        }
        gi += 1;
    }
    // ── The ceilings ─────────────────────────────────────────────────────
    let credits = match int_number(a.get("creditsSats")) {
        Some(v) if v > 0.0 && v <= sats => v,
        _ => {
            return Some(format!(
                "a PEER burn must state how many of its own satoshis this act converts to reserve, between 1 and {}",
                js_number_to_string(sats)
            ));
        }
    };
    // 1. ONE TRANSACTION, CREDITED UP TO ITS OWN VALUE AND NEVER PAST IT.
    let done_sats = st.peer_burn_tx_sats.get(&txk).copied().unwrap_or(0);
    if done_sats > 0 && st.peer_burn_tx_by.get(&txk).map(String::as_str) != Some(id.as_str()) {
        return Some(format!(
            "that transaction has already been claimed, by {} — a burn is claimed once, ever",
            st.peer_burn_tx_by.get(&txk).map(String::as_str).unwrap_or("undefined")
        ));
    }
    if done_sats as f64 + credits > sats {
        return Some(format!(
            "that transaction is worth {} sat and {done_sats} of it has already been credited, so this act cannot credit another {} — a burn is claimed once, ever, up to its own value",
            js_number_to_string(sats),
            js_number_to_string(credits)
        ));
    }
    // 2. THE PER-ACCOUNT PER-EPOCH CEILING.
    if epoch >= PEER_BURN_CAP_FROM_EPOCH {
        let used = st.peer_burn_epoch_use.get(&format!("{id}@{epoch}")).copied().unwrap_or(0);
        if used as f64 + credits > PEER_BURN_SATS_PER_EPOCH {
            let left_r = (PEER_BURN_SATS_PER_EPOCH - used as f64) / SATS_PER_RESERVE;
            return Some(format!(
                "burning PEER creates at most {} reserve per account per epoch and this handle has {} left — the burn stays valid and what is left of it is claimable after the next epoch closes",
                js_number_to_string(PEER_BURN_RESERVE_PER_EPOCH),
                js_number_to_string(left_r)
            ));
        }
        // 3. THE PER-POOL PER-EPOCH AGGREGATE.
        let factory_lower = js_prop_key(a.get("factory")).to_lowercase();
        let pk = format!("{factory_lower}#{}@{epoch}", js_prop_key(a.get("pool")));
        let pool_used = st.peer_burn_pool_use.get(&pk).copied().unwrap_or(0);
        // poolCap = Number(BigInt(a.resBtcRaw)); Number.isSafeInteger gate —
        // any BigUint > 2^53-1 converts to a double ≥ 2^53, which is unsafe.
        if res_btc_big > BigUint::from((1u64 << 53) - 1) {
            return Some("the pool records more satoshis than will ever exist".to_string());
        }
        let pool_cap = u64::try_from(&res_btc_big).unwrap() as f64;
        if pool_used as f64 + credits > pool_cap {
            return Some(format!(
                "pool {} at {factory_lower} held {res_btc_raw} sat and has already created {} reserve this epoch — one pool cannot create more reserve in an epoch than it holds bitcoin, so the rest of this burn is claimable after the next epoch closes",
                js_prop_key(a.get("pool")),
                js_number_to_string(pool_used as f64 / SATS_PER_RESERVE)
            ));
        }
    }
    None
}

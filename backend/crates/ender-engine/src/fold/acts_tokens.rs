//! Token-economy act branches — replay.cjs 1500-1565 (burn/btcBurn),
//! 1627-1635 (resetTokens), 2127-2220 (the tokenActError-gated group), and
//! tokenActError itself (969-1096). Map: port-notes/replay-branches.md
//! "burn", "btcBurn", "resetTokens", "Token group", "tokenActError".
//! Refusal-message strings are API: byte-for-byte.

#![allow(unused_variables, dead_code)]

use indexmap::IndexMap;
use num_bigint::BigUint;
use serde_json::Value;

use crate::engine::THETA;
use crate::jsval::truthy;

use super::state::{
    js_min, js_prop_key, js_tonum, fmt_amt, pool_id, round6, AdAim, Advert, ChronEntry, ChronLine,
    ChronRef, Pool, State, TokenMeta, WhoField, AD_PEER_PER_DAY, FAUCET_CAP_FROM_EPOCH,
    FAUCET_PER_EPOCH, SATS_PER_RESERVE, TBTC_CLAIM, TOK_MINLIQ,
};

// ---------------------------------------------------------------------------
// Local JS-semantics helpers (string formatting only — no state).

fn num_str(x: f64) -> String {
    ender_canonical::js_number_to_string(x)
}

/// JS strict equality between a raw act field and a state string:
/// true iff the raw value IS a string equal to `s`.
fn raw_eq_str(v: Option<&Value>, s: &str) -> bool {
    v.and_then(Value::as_str) == Some(s)
}

/// JS strict equality between two raw act fields (undefined === undefined is
/// true; mixed types false; objects/arrays are reference-distinct → false).
fn js_strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => {
            x.as_f64().unwrap_or(f64::NAN) == y.as_f64().unwrap_or(f64::NAN)
        }
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// ECMA WhiteSpace ∪ LineTerminator (what String.prototype.trim and /\s/
/// strip): TAB VT FF SP NBSP ZWNBSP + Zs + LF CR LS PS. NOT U+0085.
fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `String(x).slice(0, end)` — UTF-16 code-unit slice from 0.
fn js_slice_units(s: &str, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

/// replay.cjs 1020: /^https?:\/\/[^\s]{3,300}$/i — 3..=300 UTF-16 units
/// after the scheme, none of them JS whitespace.
fn url_ok(u: &str) -> bool {
    let rest = match u.get(..4) {
        Some(p) if p.eq_ignore_ascii_case("http") => &u[4..],
        _ => return false,
    };
    let rest = match rest.as_bytes().first() {
        Some(b) if b | 0x20 == b's' => &rest[1..],
        _ => rest,
    };
    let rest = match rest.strip_prefix("://") {
        Some(r) => r,
        None => return false,
    };
    let n = rest.encode_utf16().count();
    (3..=300).contains(&n) && !rest.chars().any(is_js_ws)
}

/// replay.cjs 1046: /^[A-Z][A-Z0-9]{2,7}$/.test(sym)
fn sym_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=8).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// JS `(x || 0)` over a stored number: 0, -0, NaN, absent → +0.
fn or0(v: Option<f64>) -> f64 {
    match v {
        Some(x) if x != 0.0 && !x.is_nan() => x,
        _ => 0.0,
    }
}

/// Number.prototype.toFixed(f) — exact per ES spec: sign stripped first,
/// |x| ≥ 1e21 falls back to ToString, else n minimizes |n/10^f − x| with
/// ties to the LARGER n (round half up on the exact double value).
fn js_to_fixed(x: f64, f: u32) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    let (sign, x) = if x < 0.0 { ("-", -x) } else { ("", x) };
    if x >= 1e21 {
        return format!("{sign}{}", num_str(x));
    }
    let bits = x.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & 0xf_ffff_ffff_ffff;
    let (m, e) = if exp == 0 { (frac, -1074i64) } else { (frac | (1 << 52), exp - 1075) };
    let mut pow10 = BigUint::from(1u8);
    for _ in 0..f {
        pow10 *= 10u8;
    }
    let n = BigUint::from(m) * pow10;
    let n = if e >= 0 {
        n << (e as usize)
    } else {
        let k = (-e) as usize;
        // floor(q + 1/2) with q = n / 2^k, exactly.
        ((&n << 1usize) + (BigUint::from(1u8) << k)) >> (k + 1)
    };
    let mut digits = n.to_string();
    if f == 0 {
        return format!("{sign}{digits}");
    }
    let fu = f as usize;
    while digits.len() <= fu {
        digits.insert(0, '0');
    }
    let split = digits.len() - fu;
    format!("{sign}{}.{}", &digits[..split], &digits[split..])
}

fn arr(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn push_chron(st: &mut State, who: WhoField, line: String, refs: Option<Vec<ChronRef>>) {
    st.chron.push(ChronEntry { who, line: ChronLine::Text(line), to: None, refs });
}

// ---------------------------------------------------------------------------

// replay.cjs 1500-1524 — retired faucet: credits NOTHING; chron only
// (payload-guarded). faucetCount is never incremented anywhere.
pub(crate) fn faucet_burn(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return;
    }
    if !payload_gone {
        push_chron(
            st,
            WhoField::Id(id),
            "a faucet burn, from before the restart — credits nothing".to_string(),
            None,
        );
    }
}

// replay.cjs 1525-1565 — btcBurn: once-ever tx dedupe, burnedSats +=,
// burnBal += sats/SATS_PER_RESERVE. No debit, no edge, no deltaActs.
pub(crate) fn btc_burn(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return;
    }
    // String(a.txid == null ? '' : a.txid).toLowerCase()
    let btc_tx = match a.get("txid") {
        None | Some(Value::Null) => String::new(),
        other => js_prop_key(other),
    }
    .to_lowercase();
    if st.burned_tx.get(&btc_tx).map_or(false, |v| !v.is_empty()) {
        return; // a burn is claimed once, ever
    }
    st.burned_tx.insert(btc_tx, id.clone());
    let sats = js_tonum(a.get("sats"));
    let prev = or0(st.burned_sats.get(&id).copied());
    st.burned_sats.insert(id.clone(), prev + sats);
    let gained = sats / SATS_PER_RESERVE;
    let ix = st.ledger_by_id[&id];
    st.ledgers[ix].burn_bal += gained;
    if !payload_gone {
        let line = format!(
            "burned {} sat to the dead address → +{} reserve · tx {}… (irreversible, verifiable by anyone)",
            js_prop_key(a.get("sats")),
            js_to_fixed(gained, 4),
            js_slice_units(&js_prop_key(a.get("txid")), 12),
        );
        push_chron(st, WhoField::Id(id), line, None);
    }
}

// replay.cjs 1627-1635 — resetTokens: tokenEpoch0 = certsSoFar, every
// tokenBal symbol reset to an empty map (symbol insertion order kept),
// chron who: a.id || null.
pub(crate) fn reset_tokens(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    st.token_epoch0 = st.certs_so_far;
    for (_sym, m) in st.token_bal.iter_mut() {
        *m = IndexMap::new();
    }
    if !payload_gone {
        let who = if truthy(a.get("id")) {
            WhoField::Id(js_prop_key(a.get("id")))
        } else {
            WhoField::Null
        };
        let line = format!(
            "the token ledger was reset to zero at epoch {} — free-minted balances stop here",
            st.certs_so_far
        );
        push_chron(st, who, line, None);
    }
}

// replay.cjs 2127-2220 — the gated group: if tokenActError(a) === null then
// debit(a.author) and run the per-kind sub-branch. A refused act does
// nothing — no chron. All sub-branch chrons are payload-guarded.
pub(crate) fn token_act(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if token_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    st.debit(&author); // θ down, N up — no edge, no vouch, no weighing

    match a.get("t").and_then(Value::as_str) {
        // replay.cjs 2137-2156
        Some("advert") => {
            st.ad_seq += 1;
            let ad_days = js_tonum(a.get("days")).floor();
            let ad_cost = round6(AD_PEER_PER_DAY * ad_days);
            st.tok_debit("PEER", &author, ad_cost);
            let peer = st.token_supply["PEER"];
            st.token_supply.insert("PEER".to_string(), round6(peer - ad_cost)); // burned, not moved
            let at = if truthy(a.get("ts")) { js_tonum(a.get("ts")) } else { 0.0 };
            st.adverts.push(Advert {
                id: format!("ad{}", st.ad_seq),
                by: author.clone(),
                text: js_trim(a.get("text").and_then(Value::as_str).unwrap_or("")).to_string(),
                url: a.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
                days: ad_days as u64,
                paid: ad_cost,
                at,
                until: at + ad_days * 86400000.0,
                aim: AdAim {
                    placement: arr(a.get("placement")),
                    tags: arr(a.get("tags")),
                    people: arr(a.get("people")),
                    posts: arr(a.get("posts")),
                    regions: arr(a.get("regions")),
                },
                stopped: false,
            });
            if !payload_gone {
                let line = format!(
                    "bought a placement for {} day(s) · burned {} tBTC · it holds no standing and ranks nothing",
                    num_str(ad_days),
                    num_str(ad_cost),
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2157-2159
        Some("adStop") => {
            for adv in st.adverts.iter_mut() {
                if raw_eq_str(a.get("ad"), &adv.id) {
                    adv.stopped = true;
                }
            }
            if !payload_gone {
                let line = format!("stopped advert {}", js_prop_key(a.get("ad")));
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2160-2164 — dead code: btcClaim is permanently refused
        // by tokenActError, so this arm can never run. Ported for fidelity.
        Some("btcClaim") => {
            st.btc_claimed.insert(author.clone(), true);
            st.tok_credit("tBTC", &author, TBTC_CLAIM);
            let s = st.token_supply["tBTC"];
            st.token_supply.insert("tBTC".to_string(), round6(s + TBTC_CLAIM));
            if !payload_gone {
                let line = format!(
                    "claimed {} tBTC — sandbox value, one claim per account",
                    num_str(TBTC_CLAIM)
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2165-2169
        Some("assetCreate") => {
            let sym = js_prop_key(a.get("sym"));
            let name_t = js_trim(a.get("name").and_then(Value::as_str).unwrap_or("")).to_string();
            st.token_meta.insert(
                sym.clone(),
                TokenMeta { name: name_t.clone(), creator: Some(author.clone()) },
            );
            let supply = js_tonum(a.get("supply"));
            st.token_supply.insert(sym.clone(), supply);
            st.tok_credit(&sym, &author, supply);
            if !payload_gone {
                let line = format!(
                    "minted {} {} — “{}” — a fun asset, worth what a pool says it is",
                    js_prop_key(a.get("supply")),
                    js_prop_key(a.get("sym")),
                    name_t,
                );
                let refs =
                    vec![ChronRef { label: st.disp_name(&author), id: author.clone() }];
                push_chron(st, WhoField::Id(author), line, Some(refs));
            }
        }
        // replay.cjs 2170-2173
        Some("tokenSend") => {
            let sym = js_prop_key(a.get("sym"));
            let to = js_prop_key(a.get("to"));
            let amt = js_tonum(a.get("amt"));
            st.tok_debit(&sym, &author, amt);
            st.tok_credit(&sym, &to, amt);
            if !payload_gone {
                let line = format!(
                    "sent {} {} to {}",
                    js_prop_key(a.get("amt")),
                    js_prop_key(a.get("sym")),
                    st.disp_name(&to),
                );
                let refs = vec![ChronRef { label: st.disp_name(&to), id: to }];
                push_chron(st, WhoField::Id(author), line, Some(refs));
            }
        }
        // replay.cjs 2174-2183
        Some("poolCreate") => {
            let sym_a = js_prop_key(a.get("symA"));
            let sym_b = js_prop_key(a.get("symB"));
            let pid = pool_id(&sym_a, &sym_b);
            let mut parts = pid.splitn(2, '/');
            let pa = parts.next().unwrap_or("").to_string();
            let pb = parts.next().unwrap_or("").to_string();
            let amt_a = js_tonum(a.get("amtA"));
            let amt_b = js_tonum(a.get("amtB"));
            let a_is_sym_a = raw_eq_str(a.get("symA"), &pa);
            let dep_a = if a_is_sym_a { amt_a } else { amt_b };
            let dep_b = if a_is_sym_a { amt_b } else { amt_a };
            st.tok_debit(&pa, &author, dep_a);
            st.tok_debit(&pb, &author, dep_b);
            let s0 = (dep_a * dep_b).sqrt();
            let mut sh = IndexMap::new();
            sh.insert(author.clone(), s0 - TOK_MINLIQ);
            sh.insert("_locked".to_string(), TOK_MINLIQ);
            st.pools.insert(
                pid.clone(),
                Pool {
                    a: pa.clone(),
                    b: pb.clone(),
                    res_a: dep_a,
                    res_b: dep_b,
                    total_shares: s0,
                    shares: sh,
                    swaps: 0,
                    vol_a: 0.0,
                    vol_b: 0.0,
                },
            );
            if !payload_gone {
                let line = format!(
                    "opened the {} pool with {} {} + {} {}",
                    pid,
                    num_str(round6(dep_a)),
                    pa,
                    num_str(round6(dep_b)),
                    pb,
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2184-2193
        Some("poolAdd") => {
            let pool_key = js_prop_key(a.get("pool"));
            let (pa, pb, res_a, res_b, total) = {
                let pl = &st.pools[&pool_key];
                (pl.a.clone(), pl.b.clone(), pl.res_a, pl.res_b, pl.total_shares)
            };
            let amt_a = js_tonum(a.get("amtA"));
            let amt_b = js_tonum(a.get("amtB"));
            let r = js_min(amt_a / res_a, amt_b / res_b);
            let use_a = r * res_a;
            let use_b = r * res_b;
            st.tok_debit(&pa, &author, use_a);
            st.tok_debit(&pb, &author, use_b);
            let minted = r * total;
            {
                let pl = st.pools.get_mut(&pool_key).unwrap();
                pl.res_a += use_a;
                pl.res_b += use_b;
                pl.total_shares += minted;
                let base = or0(pl.shares.get(&author).copied());
                pl.shares.insert(author.clone(), base + minted);
            }
            if !payload_gone {
                let line = format!(
                    "added liquidity to {} ({} {} + {} {})",
                    js_prop_key(a.get("pool")),
                    num_str(round6(use_a)),
                    pa,
                    num_str(round6(use_b)),
                    pb,
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2194-2202
        Some("poolRemove") => {
            let pool_key = js_prop_key(a.get("pool"));
            let (pa, pb, res_a, res_b, total) = {
                let pl = &st.pools[&pool_key];
                (pl.a.clone(), pl.b.clone(), pl.res_a, pl.res_b, pl.total_shares)
            };
            let shares_amt = js_tonum(a.get("shares"));
            let frac = shares_amt / total;
            let out_a = frac * res_a;
            let out_b = frac * res_b;
            {
                let pl = st.pools.get_mut(&pool_key).unwrap();
                // JS `shares[author] -= a.shares`: absent → undefined - x = NaN.
                if let Some(v) = pl.shares.get_mut(&author) {
                    *v -= shares_amt;
                } else {
                    pl.shares.insert(author.clone(), f64::NAN);
                }
                pl.total_shares -= shares_amt;
                pl.res_a -= out_a;
                pl.res_b -= out_b;
            }
            st.tok_credit(&pa, &author, out_a);
            st.tok_credit(&pb, &author, out_b);
            if !payload_gone {
                let line = format!(
                    "withdrew from {} ({} {} + {} {})",
                    js_prop_key(a.get("pool")),
                    num_str(round6(out_a)),
                    pa,
                    num_str(round6(out_b)),
                    pb,
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        // replay.cjs 2203-2218
        Some("poolSwap") => {
            let pool_key = js_prop_key(a.get("pool"));
            let (pa, pb, res_a, res_b) = {
                let pl = &st.pools[&pool_key];
                (pl.a.clone(), pl.b.clone(), pl.res_a, pl.res_b)
            };
            let amt = js_tonum(a.get("amt"));
            let in_a = raw_eq_str(a.get("sell"), &pa);
            let rin = if in_a { res_a } else { res_b };
            let rout = if in_a { res_b } else { res_a };
            let eff = amt * 0.997;
            let out = rout * eff / (rin + eff);
            let sell_key = js_prop_key(a.get("sell"));
            st.tok_debit(&sell_key, &author, amt);
            {
                let pl = st.pools.get_mut(&pool_key).unwrap();
                if in_a {
                    pl.res_a += amt;
                    pl.res_b -= out;
                } else {
                    pl.res_b += amt;
                    pl.res_a -= out;
                }
            }
            let buy_sym = if in_a { pb } else { pa };
            st.tok_credit(&buy_sym, &author, out);
            {
                let pl = st.pools.get_mut(&pool_key).unwrap();
                pl.swaps += 1;
                if in_a {
                    pl.vol_a += amt;
                } else {
                    pl.vol_b += amt;
                }
            }
            if !payload_gone {
                let line = format!(
                    "swapped {} {} → {} {} in {}",
                    num_str(round6(amt)),
                    js_prop_key(a.get("sell")),
                    num_str(round6(out)),
                    buy_sym,
                    js_prop_key(a.get("pool")),
                );
                push_chron(st, WhoField::Id(author), line, None);
            }
        }
        _ => {}
    }
}

/// replay.cjs 969-1096 — tokenActError. None = act allowed; Some(sentence)
/// = the exact refusal string. Common gates: 'unknown actor', 'not enough
/// energy' (never gated on deletedActors). Also called by rsvp with a
/// synthesized act, and exported on the final state.
pub(crate) fn token_act_error(st: &State, a: &Value) -> Option<String> {
    let who = js_prop_key(a.get("author"));
    let Some(&lix) = st.ledger_by_id.get(&who) else {
        return Some("unknown actor".to_string());
    };
    if st.ledgers[lix].burn_bal < THETA {
        return Some("not enough energy".to_string());
    }
    let t = a.get("t").and_then(Value::as_str).unwrap_or("");
    if t == "burn" {
        if st.certs_so_far < FAUCET_CAP_FROM_EPOCH {
            return None;
        }
        let used = st
            .faucet_count
            .get(&format!("{who}@{}", st.certs_so_far))
            .copied()
            .unwrap_or(0);
        if used >= FAUCET_PER_EPOCH {
            return Some(format!(
                "the faucet gives {FAUCET_PER_EPOCH} per epoch and this handle has taken them all — burn live units through Layer 0 instead, or wait for the next epoch"
            ));
        }
        return None;
    }
    if t == "rsvp" {
        let cid = js_prop_key(a.get("cid"));
        let Some(rev) = st.events.get(&cid) else {
            return Some("no such event".to_string());
        };
        if raw_eq_str(a.get("author"), &rev.host) {
            return Some("the host is already at their own event".to_string());
        }
        let going = |st: &State| {
            st.event_going.get(&cid).and_then(|m| m.get(&who)).copied().unwrap_or(false)
        };
        if rev.cap > 0 && st.count_going(&cid) as u64 >= rev.cap && !going(st) {
            return Some(format!("this event is full — {} places, all taken", rev.cap));
        }
        if !(rev.fee > 0.0) {
            return None; // free entry, nothing to move
        }
        if !raw_eq_str(a.get("cur"), &rev.cur)
            || round6(js_tonum(a.get("amt"))) != round6(rev.fee)
            || !raw_eq_str(a.get("to"), &rev.host)
        {
            return Some(format!(
                "this event now asks {} {} — the price moved",
                fmt_amt(rev.fee),
                rev.cur
            ));
        }
        if st.bal_of(&rev.cur, &who) < rev.fee {
            return Some(format!(
                "you hold {} {} and entry is {}",
                fmt_amt(st.bal_of(&rev.cur, &who)),
                rev.cur,
                fmt_amt(rev.fee)
            ));
        }
        if rev.cap > 0 && st.count_going(&cid) as u64 >= rev.cap && !going(st) {
            return Some(format!("this event is full — {} places, all taken", rev.cap));
        }
        return None;
    }
    if t == "advert" {
        let days = js_tonum(a.get("days")).floor();
        if !(days >= 1.0 && days <= 90.0) {
            return Some("an advert runs between 1 and 90 days".to_string());
        }
        match a.get("text").and_then(Value::as_str) {
            Some(text) if !js_trim(text).is_empty() => {
                let tlen = text.encode_utf16().count();
                if tlen > 280 {
                    return Some(format!("advert text is {tlen} characters; the limit is 280"));
                }
            }
            _ => return Some("the advert needs text".to_string()),
        }
        if !a.get("url").and_then(Value::as_str).map_or(false, url_ok) {
            return Some("url must be a plain http(s) link".to_string());
        }
        let cost = round6(AD_PEER_PER_DAY * days);
        if st.bal_of("PEER", &who) < cost {
            return Some(format!(
                "this advert costs {} PEER for {} day(s) and you hold {}. This PEER is the epoch token in this log: it is earned by drawing engagement, or bought in a pool inside this log. The PEER on Base is a different token that shares the name and cannot pay for a placement.",
                num_str(cost),
                num_str(days),
                num_str(round6(st.bal_of("PEER", &who))),
            ));
        }
        return None;
    }
    if t == "adStop" {
        let mut ad: Option<&Advert> = None;
        for adv in &st.adverts {
            if raw_eq_str(a.get("ad"), &adv.id) {
                ad = Some(adv);
            }
        }
        let Some(ad) = ad else {
            return Some(format!("no advert with id {}", js_prop_key(a.get("ad"))));
        };
        if !raw_eq_str(a.get("author"), &ad.by) && !truthy(a.get("operator")) {
            return Some("only the advertiser can stop their own advert".to_string());
        }
        return None;
    }
    if t == "btcClaim" {
        return Some(
            "tBTC is retired — it was never bitcoin. Value here comes from a verified Bitcoin burn (GET /api/burn) and from nothing else."
                .to_string(),
        );
    }
    if t == "assetCreate" {
        let sym_tested = if truthy(a.get("sym")) { js_prop_key(a.get("sym")) } else { String::new() };
        if !sym_ok(&sym_tested) {
            return Some(
                "symbol must be 3-8 characters, A-Z and digits, starting with a letter".to_string(),
            );
        }
        if st.token_meta.contains_key(&js_prop_key(a.get("sym"))) {
            return Some(format!("symbol {} is taken", js_prop_key(a.get("sym"))));
        }
        let supply = js_tonum(a.get("supply"));
        if !(supply > 0.0) || supply > 1e9 {
            return Some("supply must be between 0 and 1,000,000,000".to_string());
        }
        match a.get("name").and_then(Value::as_str) {
            Some(n) if !js_trim(n).is_empty() && n.encode_utf16().count() <= 60 => {}
            _ => return Some("the asset needs a name, at most 60 characters".to_string()),
        }
        return None;
    }
    if t == "tokenSend" {
        let sym_key = js_prop_key(a.get("sym"));
        if !st.token_meta.contains_key(&sym_key) {
            return Some(format!("no such asset: {}", js_prop_key(a.get("sym"))));
        }
        let amt = js_tonum(a.get("amt"));
        if !(amt > 0.0) {
            return Some("amount must be positive".to_string());
        }
        if !st.ledger_by_id.contains_key(&js_prop_key(a.get("to"))) {
            return Some("unknown recipient".to_string());
        }
        if js_strict_eq(a.get("to"), a.get("author")) {
            return Some("sending to yourself moves nothing".to_string());
        }
        if st.bal_of(&sym_key, &who) < amt {
            return Some(format!(
                "balance is {} {}, tried to send {}",
                num_str(round6(st.bal_of(&sym_key, &who))),
                js_prop_key(a.get("sym")),
                js_prop_key(a.get("amt")),
            ));
        }
        return None;
    }
    if t == "poolCreate" {
        let sym_a = js_prop_key(a.get("symA"));
        let sym_b = js_prop_key(a.get("symB"));
        if !st.token_meta.contains_key(&sym_a) || !st.token_meta.contains_key(&sym_b) {
            return Some("both assets must exist".to_string());
        }
        if js_strict_eq(a.get("symA"), a.get("symB")) {
            return Some("a pool needs two different assets".to_string());
        }
        let pid = pool_id(&sym_a, &sym_b);
        if st.pools.contains_key(&pid) {
            return Some(format!(
                "the {pid} pool already exists — add liquidity to it instead"
            ));
        }
        let amt_a = js_tonum(a.get("amtA"));
        let amt_b = js_tonum(a.get("amtB"));
        if !(amt_a > 0.0) || !(amt_b > 0.0) {
            return Some("both starting amounts must be positive".to_string());
        }
        if st.bal_of(&sym_a, &who) < amt_a {
            return Some(format!(
                "balance is {} {}, tried to deposit {}",
                num_str(round6(st.bal_of(&sym_a, &who))),
                js_prop_key(a.get("symA")),
                js_prop_key(a.get("amtA")),
            ));
        }
        if st.bal_of(&sym_b, &who) < amt_b {
            return Some(format!(
                "balance is {} {}, tried to deposit {}",
                num_str(round6(st.bal_of(&sym_b, &who))),
                js_prop_key(a.get("symB")),
                js_prop_key(a.get("amtB")),
            ));
        }
        if (amt_a * amt_b).sqrt() <= TOK_MINLIQ * 10.0 {
            return Some("starting liquidity too small".to_string());
        }
        return None;
    }
    // replay.cjs 1070: var pl = pools[a.pool]; — shared by the three below.
    let pl = st.pools.get(&js_prop_key(a.get("pool")));
    if t == "poolAdd" {
        let Some(pl) = pl else {
            return Some(format!("no such pool: {}", js_prop_key(a.get("pool"))));
        };
        let amt_a = js_tonum(a.get("amtA"));
        let amt_b = js_tonum(a.get("amtB"));
        if !(amt_a > 0.0) || !(amt_b > 0.0) {
            return Some("both amounts must be positive".to_string());
        }
        let r = js_min(amt_a / pl.res_a, amt_b / pl.res_b);
        if st.bal_of(&pl.a, &who) < r * pl.res_a || st.bal_of(&pl.b, &who) < r * pl.res_b {
            return Some("not enough balance for that deposit".to_string());
        }
        return None;
    }
    if t == "poolRemove" {
        let Some(pl) = pl else {
            return Some(format!("no such pool: {}", js_prop_key(a.get("pool"))));
        };
        let own = or0(pl.shares.get(&who).copied());
        let shares = js_tonum(a.get("shares"));
        if !(shares > 0.0) || shares > own + 1e-12 {
            return Some(format!(
                "you hold {} shares of {}, tried to remove {}",
                num_str(round6(own)),
                js_prop_key(a.get("pool")),
                js_prop_key(a.get("shares")),
            ));
        }
        return None;
    }
    if t == "poolSwap" {
        let Some(pl) = pl else {
            return Some(format!("no such pool: {}", js_prop_key(a.get("pool"))));
        };
        if !raw_eq_str(a.get("sell"), &pl.a) && !raw_eq_str(a.get("sell"), &pl.b) {
            return Some(format!(
                "{} does not trade {}",
                js_prop_key(a.get("pool")),
                js_prop_key(a.get("sell")),
            ));
        }
        let amt = js_tonum(a.get("amt"));
        if !(amt > 0.0) {
            return Some("amount must be positive".to_string());
        }
        let sell_key = js_prop_key(a.get("sell"));
        if st.bal_of(&sell_key, &who) < amt {
            return Some(format!(
                "balance is {} {}, tried to sell {}",
                num_str(round6(st.bal_of(&sell_key, &who))),
                js_prop_key(a.get("sell")),
                js_prop_key(a.get("amt")),
            ));
        }
        let in_a = raw_eq_str(a.get("sell"), &pl.a);
        let rin = if in_a { pl.res_a } else { pl.res_b };
        let rout = if in_a { pl.res_b } else { pl.res_a };
        let out = rout * (amt * 0.997) / (rin + amt * 0.997);
        if a.get("minOut").is_some() && out < js_tonum(a.get("minOut")) {
            return Some(format!(
                "that trade would return {}, below your minimum of {} — the price moved",
                num_str(round6(out)),
                js_prop_key(a.get("minOut")),
            ));
        }
        return None;
    }
    Some("unknown token act".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(js_to_fixed(0.05, 4), "0.0500");
        assert_eq!(js_to_fixed(123.456, 4), "123.4560");
        assert_eq!(js_to_fixed(0.0, 4), "0.0000");
        assert_eq!(js_to_fixed(1.005, 2), "1.00"); // 1.005 is 1.00499… as a double
        assert_eq!(js_to_fixed(0.5, 0), "1"); // tie → larger n
        assert_eq!(js_to_fixed(f64::NAN, 4), "NaN");
        assert_eq!(js_to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(js_to_fixed(100.0, 4), "100.0000");
    }

    #[test]
    fn url_regex_matches_js() {
        assert!(url_ok("http://abc"));
        assert!(url_ok("HTTPS://x.y"));
        assert!(!url_ok("http://ab")); // under 3 units after scheme
        assert!(!url_ok("ftp://abc"));
        assert!(!url_ok("http://a b"));
        assert!(!url_ok("https://"));
    }

    #[test]
    fn sym_regex_matches_js() {
        assert!(sym_ok("ABC"));
        assert!(sym_ok("A1234567"));
        assert!(!sym_ok("AB"));
        assert!(!sym_ok("1ABC"));
        assert!(!sym_ok("ABCDEFGHI"));
        assert!(!sym_ok("abc"));
    }
}

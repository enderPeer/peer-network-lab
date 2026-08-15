//! Market act branches — replay.cjs 2221-2364 (market/bet/modStand/
//! modVote/attest/marketVoid) plus marketActError (1170-1266), mktSeats
//! (1128-1156), mktVerdict (1395-1404) and mktSettle (1291-1392).
//! Map: port-notes/replay-branches.md "market"…"marketVoid",
//! "marketActError", helpers mktSeats/mktVerdict/mktSettle.
//! Refusal-message strings are API: byte-for-byte.

#![allow(unused_variables, dead_code)]

use std::cmp::Ordering;

use indexmap::IndexMap;
use serde_json::Value;

use super::state::{
    fmt_amt, js_prop_key, js_tonum, mkt_amt, mkt_seats_has, round6, Ballot, ChronEntry, ChronLine,
    Market, PostFlag, PostMeta, State, WhoField, MKT_FEE_MAX_BP, MKT_MAX_OPTS, MKT_MIN_OPTS,
};
use crate::engine::graph::{EdgeInput, NodeInfo, NodeKind};
use crate::engine::THETA;
use crate::jsval::{key_is_integer_like, utf16_cmp, utf16_sorted};
use ender_canonical::js_number_to_string;

// JS String.prototype.slice(0, end) — UTF-16 code units. A cut through a
// surrogate pair keeps the lone high surrogate in JS; Rust strings cannot
// hold one, so that (astral char exactly at the boundary) is lossy — gap.
fn js_slice(s: &str, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= end {
        return s.to_string();
    }
    String::from_utf16_lossy(&units[..end])
}

// JS `===` over act fields (undefined = None). Primitives by value; JSON
// parse nodes are never reference-equal, so objects/arrays compare false
// against everything but themselves (handled at the indexOf site).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
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

// JS arr.indexOf(arr[i]) — strict equality; an object/array element only
// matches itself (reference identity).
fn js_index_of(arr: &[Value], target_idx: usize) -> i64 {
    let target = &arr[target_idx];
    for (j, e) in arr.iter().enumerate() {
        let eq = match e {
            Value::Array(_) | Value::Object(_) => j == target_idx,
            _ => strict_eq(Some(e), Some(target)),
        };
        if eq {
            return j as i64;
        }
    }
    -1
}

// `x || 0` over a stored number: falsy (0, -0, NaN, absent) → +0.
fn or0(v: Option<f64>) -> f64 {
    match v {
        Some(x) if x != 0.0 && !x.is_nan() => x,
        _ => 0.0,
    }
}

// `opts[opt] || 'answer ' + (opt + 1)` — '' (redacted label) is falsy.
fn opt_label(opts: &[String], opt: i64) -> String {
    match opts.get(opt as usize) {
        Some(s) if !s.is_empty() => s.clone(),
        _ => format!("answer {}", opt + 1),
    }
}

// replay.cjs 2221-2274 — market: the node mints UNCONDITIONALLY (counter
// ticks even for a refused market); record built only when marketActError
// is None; chron carries the refusal sentence otherwise.
pub(crate) fn market(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let author_raw = a.get("author");
    let author = js_prop_key(author_raw);
    if !st.known(&author) {
        return;
    }
    // The JS synthesizes { t:'market', author, opts, cur, seats, bond,
    // feeBp } — every field marketActError reads on this path is copied
    // from `a` verbatim, so passing the act is equivalent.
    let m_err = market_act_error(st, a);
    st.counter += 1;
    let mcid = format!("c{}", st.counter);
    st.act_content.insert(i as u64, mcid.clone());
    st.content_author.insert(mcid.clone(), author.clone());
    if payload_gone {
        st.muted_content.insert(mcid.clone(), true);
    }
    st.g.add_node(NodeInfo {
        id: mcid.clone(),
        kind: NodeKind::Content,
        label: if payload_gone { "[deleted]".to_string() } else { format!("Bet {}", st.counter) },
    });
    st.g.append(EdgeInput {
        id: format!("pub{}", st.counter),
        family: "Publish".to_string(),
        src: author.clone(),
        tgt: mcid.clone(),
        pd: 0.8,
        pi: 1.0,
        epoch: Some(st.certs_so_far as f64),
        ..Default::default()
    });
    st.debit(&author);
    st.weigh_home(&author, 0.8, 1.0);
    if m_err.is_none() {
        // Validated: opts is an array of 2..=7 entries.
        let empty: Vec<Value> = Vec::new();
        let opts_arr = a.get("opts").and_then(Value::as_array).unwrap_or(&empty);
        let mut mopts: Vec<String> = Vec::with_capacity(opts_arr.len());
        let mut mstakes: Vec<IndexMap<String, f64>> = Vec::with_capacity(opts_arr.len());
        let mut mtotals: Vec<f64> = Vec::with_capacity(opts_arr.len());
        for o in opts_arr {
            mopts.push(if payload_gone {
                String::new()
            } else {
                js_slice(&js_prop_key(Some(o)), 60)
            });
            mstakes.push(IndexMap::new());
            mtotals.push(0.0);
        }
        let nominees: Vec<String> = a
            .get("mods")
            .and_then(Value::as_array)
            .map(|mods| {
                mods.iter()
                    .filter(|x| {
                        st.known(&js_prop_key(Some(*x))) && !strict_eq(Some(*x), author_raw)
                    })
                    .take(8)
                    .map(|x| js_prop_key(Some(x)))
                    .collect()
            })
            .unwrap_or_default();
        let n = mopts.len();
        st.markets.insert(
            mcid.clone(),
            Market {
                cid: mcid.clone(),
                by: author.clone(),
                cur: js_prop_key(a.get("cur")),
                n,
                opts: mopts,
                at: match a.get("at") {
                    Some(Value::Number(x)) => x.as_f64().unwrap_or(f64::NAN),
                    _ => 0.0,
                },
                // Validated: ToString(a.seats) is "1" | "3" | "5".
                seats: js_prop_key(a.get("seats")).parse::<u64>().unwrap_or(0),
                bond: round6(js_tonum(a.get("bond"))),
                fee_bp: js_tonum(a.get("feeBp")).floor() as u64,
                nominees,
                stakes: mstakes,
                totals: mtotals,
                pool: 0.0,
                by_bettor: IndexMap::new(),
                cands: IndexMap::new(),
                votes: IndexMap::new(),
                attests: IndexMap::new(),
                state: "open".to_string(),
                outcome: -1,
                paid: IndexMap::new(),
                refunded: IndexMap::new(),
                struck: IndexMap::new(),
                earned: IndexMap::new(),
                jury: Vec::new(),
                honest: Vec::new(),
                guilty: Vec::new(),
                fee_paid: 0.0,
                slashed_total: 0.0,
                idx: i as u64,
                closed_early: false,
            },
        );
    }
    if !payload_gone {
        st.creators.insert(mcid.clone(), author.clone());
        // JS `payloads[mcid] = a.text`: assigning undefined is
        // output-identical to absence (stringify drops it) — skip.
        if let Some(t) = a.get("text") {
            st.payloads.insert(
                mcid.clone(),
                match t {
                    Value::String(s) => s.clone(),
                    other => js_prop_key(Some(other)),
                },
            );
        }
        st.post_meta.insert(
            mcid.clone(),
            PostMeta {
                idx: i as u64,
                ts: a.get("ts").cloned(),
                edited: false,
                flag: Some(PostFlag::Market),
            },
        );
        let text60 = js_slice(&js_prop_key(a.get("text")), 60);
        let tail = match &m_err {
            Some(e) => format!(" — no market opened: {e}"),
            None => {
                let m = &st.markets[&mcid];
                format!(
                    " · {} answers · {}-seat jury · bond {} {}",
                    m.n,
                    m.seats,
                    fmt_amt(m.bond),
                    m.cur
                )
            }
        };
        st.chron.push(ChronEntry {
            who: WhoField::Id(author.clone()),
            line: ChronLine::Text(format!("asked a bet · {text60}{tail}")),
            to: Some(mcid.clone()),
            refs: None,
        });
    }
}

// replay.cjs 2275-2295 — bet: mktAmt floor-stake, round6 running fields,
// debit, paidTo. Chron prints the RAW a.amt.
pub(crate) fn bet(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    let (cur, by) = {
        let bm = &st.markets[&cid];
        (bm.cur.clone(), bm.by.clone())
    };
    // Validated: a.opt is an integer number in 0..n.
    let opt = js_tonum(a.get("opt")) as usize;
    let stake = mkt_amt(js_tonum(a.get("amt")));
    st.tok_debit(&cur, &author, stake);
    {
        let bm = st.markets.get_mut(&cid).expect("bet gate: market exists");
        let prev = or0(bm.stakes[opt].get(&author).copied());
        bm.stakes[opt].insert(author.clone(), round6(prev + stake));
        bm.totals[opt] = round6(bm.totals[opt] + stake);
        bm.pool = round6(bm.pool + stake);
        let prev_b = or0(bm.by_bettor.get(&author).copied());
        bm.by_bettor.insert(author.clone(), round6(prev_b + stake));
    }
    st.debit(&author);
    st.paid_to.insert(format!("{author}>{by}"), true);
    if !payload_gone {
        let bm = &st.markets[&cid];
        st.chron.push(ChronEntry {
            who: WhoField::Id(author.clone()),
            line: ChronLine::Text(format!(
                "staked {} {} on “{}” — escrowed, and in no score",
                fmt_amt(js_tonum(a.get("amt"))),
                bm.cur,
                opt_label(&bm.opts, opt as i64)
            )),
            to: Some(cid.clone()),
            refs: None,
        });
    }
}

// replay.cjs 2296-2317 — modStand: debit FIRST, stand-down returns bond in
// full, standing posts the bond.
pub(crate) fn mod_stand(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    st.debit(&author);
    if matches!(a.get("on"), Some(Value::Bool(false))) {
        // Validated: cands[author] exists on the stand-down path.
        let (cur, back_bond) = {
            let sm = st.markets.get_mut(&cid).expect("modStand gate: market exists");
            let back = sm.cands.shift_remove(&author).unwrap_or(0.0);
            (sm.cur.clone(), back)
        };
        st.tok_credit(&cur, &author, back_bond);
        if !payload_gone {
            st.chron.push(ChronEntry {
                who: WhoField::Id(author.clone()),
                line: ChronLine::Text(
                    "stood down from a jury — bond returned in full".to_string(),
                ),
                to: Some(cid.clone()),
                refs: None,
            });
        }
    } else {
        let (cur, bond) = {
            let sm = &st.markets[&cid];
            (sm.cur.clone(), sm.bond)
        };
        st.tok_debit(&cur, &author, bond);
        st.markets
            .get_mut(&cid)
            .expect("modStand gate: market exists")
            .cands
            .insert(author.clone(), bond);
        if !payload_gone {
            st.chron.push(ChronEntry {
                who: WhoField::Id(author.clone()),
                line: ChronLine::Text(format!(
                    "stood for a jury seat · bonded {} {} — forfeit if they certify against the jury",
                    fmt_amt(bond),
                    cur
                )),
                to: Some(cid.clone()),
                refs: None,
            });
        }
    }
}

// replay.cjs 2318-2337 — modVote: latest ballot wins, weight frozen at
// cast time from burnedSats; reassignment keeps the FIRST insertion slot.
pub(crate) fn mod_vote(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    let for_: Vec<String> = a
        .get("for")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(|e| js_prop_key(Some(e))).collect())
        .unwrap_or_default();
    let wt = or0(st.burned_sats.get(&author).copied());
    st.markets
        .get_mut(&cid)
        .expect("modVote gate: market exists")
        .votes
        .insert(author.clone(), Ballot { for_: for_.clone(), wt });
    st.debit(&author);
    if !payload_gone {
        let line = if !for_.is_empty() {
            let names: Vec<String> = for_.iter().map(|x| st.disp_name(x)).collect();
            format!(
                "voted for {} on a jury · weight {} sat destroyed",
                names.join(", "),
                js_number_to_string(or0(st.burned_sats.get(&author).copied()))
            )
        } else {
            "withdrew their jury ballot".to_string()
        };
        st.chron.push(ChronEntry {
            who: WhoField::Id(author.clone()),
            line: ChronLine::Text(line),
            to: Some(cid.clone()),
            refs: None,
        });
    }
}

// replay.cjs 2338-2357 — attest: record certification (may be -1), debit,
// then settlement-by-act via mktVerdict/mktSettle (byDeadline falsy); the
// settle chron has NO who key and is unconditional.
pub(crate) fn attest(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    // Validated: a.opt is the number -1 or an integer number in 0..n.
    let opt = js_tonum(a.get("opt")) as i64;
    st.markets
        .get_mut(&cid)
        .expect("attest gate: market exists")
        .attests
        .insert(author.clone(), opt);
    st.debit(&author);
    if !payload_gone {
        let am = &st.markets[&cid];
        let label = if opt == -1 {
            "no answer — void".to_string()
        } else {
            opt_label(&am.opts, opt)
        };
        st.chron.push(ChronEntry {
            who: WhoField::Id(author.clone()),
            line: ChronLine::Text(format!(
                "certified “{label}” on a bet · bond at risk until the jury agrees"
            )),
            to: Some(cid.clone()),
            refs: None,
        });
    }
    let verdict = mkt_verdict(&st.markets[&cid]);
    if let Some(v) = verdict {
        let out = mkt_settle(st, &cid, v, false);
        let am = &st.markets[&cid];
        let label = if v == -1 {
            "no answer — void, every stake returned".to_string()
        } else {
            opt_label(&am.opts, v)
        };
        let mut line = format!(
            "a bet resolved to “{}” · pool {} {} · fee {}",
            label,
            fmt_amt(am.pool),
            am.cur,
            fmt_amt(out.fee)
        );
        if out.slashed > 0.0 {
            line.push_str(&format!(
                " · {} bond(s) struck for {}",
                out.guilty.len(),
                fmt_amt(out.slashed)
            ));
        }
        st.chron.push(ChronEntry {
            who: WhoField::Absent,
            line: ChronLine::Text(line),
            to: Some(cid.clone()),
            refs: None,
        });
    }
}

// replay.cjs 2358-2364 — marketVoid: debit, mktSettle(zm, -1, true)
// (silence is struck), unconditional chron.
pub(crate) fn market_void(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    st.debit(&author);
    let zout = mkt_settle(st, &cid, -1, true);
    let mut line =
        "called time on a bet the jury never settled — every stake returned in full".to_string();
    if zout.slashed > 0.0 {
        line.push_str(&format!(
            ", {} silent seat(s) struck for {}",
            zout.guilty.len(),
            fmt_amt(zout.slashed)
        ));
    }
    st.chron.push(ChronEntry {
        who: WhoField::Id(author),
        line: ChronLine::Text(line),
        to: Some(cid),
        refs: None,
    });
}

// replay.cjs marketClose (after marketVoid): gate, debit, then move the
// closing time to the act's own stamp — only ever earlier, and only when
// the stamp is a positive number. Same predicate as the JS:
//   typeof a.ts === 'number' && a.ts > 0 && (!(cm.at > 0) || a.ts < cm.at)
// A ts that is not a JSON number (absent, string) leaves the market alone;
// the debit and the gate still happen, exactly as they do in the JS. `hist`
// (JS display state) is not ported — nothing in an epoch package reads it.
pub(crate) fn market_close(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    if market_act_error(st, a).is_some() {
        return;
    }
    let author = js_prop_key(a.get("author"));
    let cid = js_prop_key(a.get("cid"));
    st.debit(&author);
    let ts = match a.get("ts") {
        Some(Value::Number(x)) => x.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    let cm = st.markets.get_mut(&cid).expect("marketClose gate: market exists");
    // `!(cm.at > 0)` in JS is true for 0, negative and NaN alike.
    if ts > 0.0 && (!(cm.at > 0.0) || ts < cm.at) {
        cm.at = ts;
        cm.closed_early = true;
        st.chron.push(ChronEntry {
            who: WhoField::Id(author),
            line: ChronLine::Text(
                "closed betting early on their bet — no more stakes; the jury certifies from here"
                    .to_string(),
            ),
            to: Some(cid),
            refs: None,
        });
    }
    let _ = (i, payload_gone);
}

/// replay.cjs 1170-1266 — marketActError. None = allowed; Some(sentence) =
/// exact refusal. Exported on the final state (answers against final state).
pub(crate) fn market_act_error(st: &State, a: &Value) -> Option<String> {
    let who_raw = a.get("author");
    let who = js_prop_key(who_raw);
    let Some(&lix) = st.ledger_by_id.get(&who) else {
        return Some("unknown actor".to_string());
    };
    if st.ledgers[lix].burn_bal < THETA {
        return Some("not enough energy".to_string());
    }
    let t = a.get("t").and_then(Value::as_str).unwrap_or("");
    if t == "market" {
        let opts_len = a.get("opts").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0);
        if opts_len < MKT_MIN_OPTS || opts_len > MKT_MAX_OPTS {
            return Some(format!(
                "a bet needs between {MKT_MIN_OPTS} and {MKT_MAX_OPTS} answers; this one names {opts_len}"
            ));
        }
        let cur_key = js_prop_key(a.get("cur"));
        if !st.token_meta.contains_key(&cur_key) {
            return Some(format!("no such asset: {cur_key}"));
        }
        if !mkt_seats_has(&js_prop_key(a.get("seats"))) {
            return Some(
                "a jury is 1, 3 or 5 seats — an even jury cannot reach a majority".to_string(),
            );
        }
        let bond = js_tonum(a.get("bond"));
        if !(bond > 0.0) || bond > 1e9 {
            return Some(
                "a seat needs a bond: it is the only thing a corrupt certification can cost"
                    .to_string(),
            );
        }
        let fee_bp = js_tonum(a.get("feeBp"));
        if !(fee_bp >= 0.0) || fee_bp > MKT_FEE_MAX_BP {
            return Some(format!(
                "the resolution fee is at most {}% of the pool",
                js_number_to_string(MKT_FEE_MAX_BP / 100.0)
            ));
        }
        return None;
    }
    let cid = js_prop_key(a.get("cid"));
    let Some(m) = st.markets.get(&cid) else {
        return Some(format!("no such bet: {cid}"));
    };
    if m.state != "open" {
        return Some(if m.state == "void" {
            "that bet was voided — the stakes went back and nothing more moves".to_string()
        } else {
            "that bet is already resolved — the pool has been paid out".to_string()
        });
    }
    if t == "bet" {
        // `who === m.by` is STRICT: only a string author can equal it.
        if matches!(who_raw, Some(Value::String(s)) if *s == m.by) {
            return Some("the author of a bet does not hold a position on it — they are paid a fee whichever answer wins".to_string());
        }
        if m.cands.contains_key(&who) {
            return Some(
                "a moderator cannot back an answer they may be asked to certify".to_string(),
            );
        }
        let opt_num = js_tonum(a.get("opt"));
        let opt_is_int_number =
            matches!(a.get("opt"), Some(Value::Number(_))) && opt_num.floor() == opt_num;
        if !(opt_num >= 0.0) || opt_num >= m.n as f64 || !opt_is_int_number {
            return Some(format!("there is no answer {} on this bet", js_prop_key(a.get("opt"))));
        }
        let v = mkt_amt(js_tonum(a.get("amt")));
        if !(v > 0.0) {
            return Some(if js_tonum(a.get("amt")) > 0.0 {
                format!("the smallest stake this record can hold is 0.000001 {}", m.cur)
            } else {
                "a stake must be positive".to_string()
            });
        }
        if st.bal_of(&m.cur, &who) < v {
            return Some(format!(
                "balance is {} {}, tried to stake {}",
                js_number_to_string(round6(st.bal_of(&m.cur, &who))),
                m.cur,
                js_prop_key(a.get("amt"))
            ));
        }
        return None;
    }
    if t == "modStand" {
        if matches!(a.get("on"), Some(Value::Bool(false))) {
            if !m.cands.contains_key(&who) {
                return Some("you are not standing in this bet".to_string());
            }
            return None;
        }
        if matches!(who_raw, Some(Value::String(s)) if *s == m.by) {
            return Some("the author of a bet cannot also certify it".to_string());
        }
        if m.by_bettor.contains_key(&who) {
            return Some("you hold a position on this bet, so you cannot certify it".to_string());
        }
        if m.cands.contains_key(&who) {
            return Some("you are already standing, and the bond is already posted".to_string());
        }
        if st.bal_of(&m.cur, &who) < m.bond {
            return Some(format!(
                "the bond is {} {} and you hold {}",
                fmt_amt(m.bond),
                m.cur,
                fmt_amt(st.bal_of(&m.cur, &who))
            ));
        }
        return None;
    }
    if t == "modVote" {
        let empty: Vec<Value> = Vec::new();
        let ballot: &[Value] =
            a.get("for").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&empty);
        if ballot.len() as u64 > m.seats {
            return Some(format!(
                "this jury has {} seat(s); a ballot names at most that many",
                m.seats
            ));
        }
        for (bi, entry) in ballot.iter().enumerate() {
            if strict_eq(Some(entry), who_raw) {
                return Some("nobody votes themselves onto a jury".to_string());
            }
            if js_index_of(ballot, bi) != bi as i64 {
                return Some("that ballot names the same candidate twice".to_string());
            }
            if !m.cands.contains_key(&js_prop_key(Some(entry))) {
                return Some("nobody by that name is standing in this bet".to_string());
            }
        }
        if or0(st.burned_sats.get(&who).copied()) <= 0.0 {
            return Some("a vote weighs the satoshis you proved you destroyed, and this handle has destroyed none".to_string());
        }
        return None;
    }
    if t == "attest" {
        // `seated.indexOf(who)` is STRICT: only a string author can hold a seat.
        let seated = mkt_seats(m).seated;
        let is_seated =
            matches!(who_raw, Some(Value::String(s)) if seated.iter().any(|x| x == s));
        if !is_seated {
            return Some(
                "only a seated moderator certifies a bet, and this handle holds no seat"
                    .to_string(),
            );
        }
        if m.attests.contains_key(&who) {
            return Some("you have already certified this bet — a certification is final, which is what makes the bond mean anything".to_string());
        }
        let opt_raw = a.get("opt");
        let opt_num = js_tonum(opt_raw);
        // `a.opt !== -1` — strict: only the NUMBER -1 skips the range check.
        let is_neg1 = matches!(opt_raw, Some(Value::Number(_))) && opt_num == -1.0;
        if !is_neg1 {
            let opt_is_int_number =
                matches!(opt_raw, Some(Value::Number(_))) && opt_num.floor() == opt_num;
            if !(opt_num >= 0.0) || opt_num >= m.n as f64 || !opt_is_int_number {
                return Some(format!("there is no answer {} on this bet", js_prop_key(opt_raw)));
            }
        }
        return None;
    }
    if t == "marketVoid" {
        // The deadline is host-side only (replay.cjs 1254-1263).
        return None;
    }
    if t == "marketClose" {
        // replay.cjs marketClose gate: author only, and not twice. Whether
        // the clock already closed it is the host's question, not this one.
        if !matches!(who_raw, Some(Value::String(s)) if *s == m.by) {
            return Some("only the author of a bet closes betting on it early".to_string());
        }
        if m.closed_early {
            return Some("betting on this bet was already closed early".to_string());
        }
        return None;
    }
    Some("unknown market act".to_string())
}

/// mktSeats return shape: { order, weight, seated }.
pub(crate) struct MktSeats {
    pub order: Vec<String>,
    /// Zero-initialized over cands (insertion order = output order); float
    /// accumulation follows votes insertion order.
    pub weight: IndexMap<String, f64>,
    pub seated: Vec<String>,
}

/// replay.cjs 1128-1156 — mktSeats: weight desc, bond desc, id asc (JS
/// string <). Stale ballot names skipped by the cands-membership guard.
pub(crate) fn mkt_seats(m: &Market) -> MktSeats {
    let mut w: IndexMap<String, f64> = IndexMap::new();
    for id in m.cands.keys() {
        debug_assert!(!key_is_integer_like(id));
        w.insert(id.clone(), 0.0);
    }
    for ballot in m.votes.values() {
        // `ballot.wt || 0` then `if (wt <= 0) continue;`
        let wt = or0(Some(ballot.wt));
        if wt <= 0.0 {
            continue;
        }
        for name in &ballot.for_ {
            if let Some(e) = w.get_mut(name) {
                *e += wt;
            }
        }
    }
    let mut order: Vec<String> = m.cands.keys().cloned().collect();
    order.sort_by(|x, y| {
        let (wx, wy) = (w[x], w[y]);
        if wx != wy {
            // return w[y] - w[x]  (weight desc)
            return wy.partial_cmp(&wx).unwrap_or(Ordering::Equal);
        }
        let (bx, by) = (m.cands[x], m.cands[y]);
        if bx != by {
            // return m.cands[y] - m.cands[x]  (bond desc)
            return by.partial_cmp(&bx).unwrap_or(Ordering::Equal);
        }
        // x < y ? -1 : 1  (id asc, UTF-16; never 0)
        if utf16_cmp(x, y) == Ordering::Less {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    });
    let seated: Vec<String> = order.iter().take(m.seats as usize).cloned().collect();
    MktSeats { order, weight: w, seated }
}

/// replay.cjs 1395-1404 — mktVerdict: majority over seated certifications;
/// may return Some(-1) (void) or None (no majority yet).
pub(crate) fn mkt_verdict(m: &Market) -> Option<i64> {
    let seated = mkt_seats(m).seated;
    let need = seated.len() / 2 + 1;
    let mut tally: IndexMap<i64, usize> = IndexMap::new();
    for s in &seated {
        let Some(&said) = m.attests.get(s) else { continue };
        let e = tally.entry(said).or_insert(0);
        *e += 1;
        if *e >= need {
            return Some(said);
        }
    }
    None
}

/// mktSettle return shape.
pub(crate) struct SettleOut {
    pub fee: f64,
    pub slashed: f64,
    pub honest: Vec<String>,
    pub guilty: Vec<String>,
}

/// replay.cjs 1291-1392 — mktSettle: byDeadline falsy → dissenters struck,
/// silent seats keep bonds; byDeadline true → silent seats struck. All
/// Object.keys iterations sorted lexicographically (UTF-16); round6
/// running sums follow sorted order. Five-op fee chain
/// `Math.floor(pool * feeBp / 10000 * 1e6) / 1e6` verbatim.
pub(crate) fn mkt_settle(st: &mut State, cid: &str, outcome: i64, by_deadline: bool) -> SettleOut {
    // Work on a clone; insert-back keeps the market's slot (IndexMap).
    let mut m = st.markets.get(cid).cloned().expect("mktSettle: market exists (gated)");
    let seated = mkt_seats(&m).seated;
    let mut honest: Vec<String> = Vec::new();
    let mut guilty: Vec<String> = Vec::new();
    for s in &seated {
        match m.attests.get(s) {
            None => {
                if by_deadline {
                    guilty.push(s.clone());
                }
            }
            Some(&said) => {
                if by_deadline {
                    continue; // certified; the jury just never agreed
                }
                if said == outcome {
                    honest.push(s.clone());
                } else {
                    guilty.push(s.clone());
                }
            }
        }
    }
    // Bonds: everyone standing except the struck (sorted candidate order).
    let mut slashed = 0.0f64;
    let cands = utf16_sorted(m.cands.keys().cloned().collect());
    for c in &cands {
        let bond = m.cands[c];
        if guilty.contains(c) {
            slashed = round6(slashed + bond);
            m.struck.insert(c.clone(), bond);
        } else {
            st.tok_credit(&m.cur, c, bond);
        }
    }
    let mut fee = 0.0f64;
    let mut dust = 0.0f64;
    // winTotal = outcome >= 0 ? (m.totals[outcome] || 0) : 0
    let win_total = if outcome >= 0 {
        or0(m.totals.get(outcome as usize).copied())
    } else {
        0.0
    };
    if win_total > 0.0 {
        fee = (m.pool * m.fee_bp as f64 / 10000.0 * 1e6).floor() / 1e6;
        let pot = round6(m.pool - fee + slashed);
        let mut paid = 0.0f64;
        let backers = utf16_sorted(m.stakes[outcome as usize].keys().cloned().collect());
        for b in &backers {
            let got = (pot * m.stakes[outcome as usize][b] / win_total * 1e6).floor() / 1e6;
            if got > 0.0 {
                st.tok_credit(&m.cur, b, got);
                m.paid.insert(b.clone(), got);
                paid = round6(paid + got);
            }
        }
        dust = round6(pot - paid);
    } else {
        // Void, or winning answer had no backers: refund all stakes (per
        // option, sorted backers). NO fee.
        for iopt in 0..m.n {
            let back = utf16_sorted(m.stakes[iopt].keys().cloned().collect());
            for b in &back {
                let s = m.stakes[iopt][b];
                st.tok_credit(&m.cur, b, s);
                let prev = or0(m.refunded.get(b).copied());
                m.refunded.insert(b.clone(), round6(prev + s));
            }
        }
        if slashed > 0.0 && m.pool > 0.0 {
            let mut comp = 0.0f64;
            let all = utf16_sorted(m.by_bettor.keys().cloned().collect());
            for b in &all {
                let share = (slashed * m.by_bettor[b] / m.pool * 1e6).floor() / 1e6;
                if share > 0.0 {
                    st.tok_credit(&m.cur, b, share);
                    let prev = or0(m.paid.get(b).copied());
                    m.paid.insert(b.clone(), round6(prev + share));
                    comp = round6(comp + share);
                }
            }
            dust = round6(slashed - comp);
        } else if slashed > 0.0 {
            // No stakes at all: struck bonds go BACK (iterates seated order).
            for s in &seated {
                let Some(&bond) = m.struck.get(s) else { continue };
                st.tok_credit(&m.cur, s, bond);
                m.struck.shift_remove(s);
            }
            slashed = 0.0;
            guilty = Vec::new();
        }
    }
    // Fee split: half to moderators who called it right, half + dust to author.
    let mod_pot = (fee / 2.0 * 1e6).floor() / 1e6;
    let mut to_author = round6(fee - mod_pot + dust);
    if !honest.is_empty() && mod_pot > 0.0 {
        let each = (mod_pot / honest.len() as f64 * 1e6).floor() / 1e6;
        for h in &honest {
            if each > 0.0 {
                st.tok_credit(&m.cur, h, each);
                m.earned.insert(h.clone(), each);
            }
        }
        to_author = round6(to_author + (mod_pot - round6(each * honest.len() as f64)));
    } else {
        to_author = round6(to_author + mod_pot);
    }
    if to_author > 0.0 {
        st.tok_credit(&m.cur, &m.by, to_author);
        let prev = or0(m.earned.get(&m.by).copied());
        m.earned.insert(m.by.clone(), round6(prev + to_author));
    }
    m.state = if outcome >= 0 { "resolved".to_string() } else { "void".to_string() };
    m.outcome = outcome;
    m.jury = seated;
    m.honest = honest.clone();
    m.guilty = guilty.clone();
    m.fee_paid = fee;
    m.slashed_total = slashed;
    st.markets.insert(cid.to_string(), m);
    SettleOut { fee, slashed, honest, guilty }
}

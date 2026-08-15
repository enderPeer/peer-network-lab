//! Social act branches — replay.cjs 1449-2126 (excluding the token,
//! peer-burn and market groups). Map: port-notes/replay-branches.md
//! sections seedWorld…deleteAccount.
//!
//! chron is deferred to the host phase: no branch here writes chron — the
//! phase gate reads packages only.

use std::cmp::Ordering;

use serde_json::{Map, Value};

use super::state::{
    js_prop_key, js_tonum, parse_mentions, round6, CallInfo, Dm, Engage, EventRec, PostFlag,
    PostMeta, Profile, ReviewMeta, State,
};
use crate::engine::graph::{EdgeInput, NodeInfo, NodeKind};
use crate::engine::THETA;
use crate::jsval::{js_str, truthy, utf16_cmp};

// ---------------------------------------------------------------------------
// Local helpers (JS semantics shared by several branches below)

/// `Number.isInteger(x)` on an act field, yielding the act index it names
/// when it could ever match a loop index (JS then looks the key up by its
/// decimal string; negatives/huge values simply never hit a stored key).
fn int_act_index(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_f64()?;
    if !n.is_finite() || n.fract() != 0.0 {
        return None;
    }
    if n < 0.0 || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as u64)
}

/// `actContent[key]` by JS property-key coercion (editPost has no
/// Number.isInteger gate — any value whose ToString is a canonical decimal
/// can hit a stored act index).
fn act_content_by_key(st: &State, v: Option<&Value>) -> Option<String> {
    let key = js_prop_key(v);
    let n: u64 = key.parse().ok()?;
    if n.to_string() != key {
        return None;
    }
    st.act_content.get(&n).cloned()
}

/// JS String.prototype.slice(0, end) — UTF-16 code units. A cut through a
/// surrogate pair lossy-replaces the lone half (JS would keep it; real logs
/// never place an astral char at the boundary).
fn slice_utf16(s: &str, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

/// `a.media && a.media.length` — the value stored when both are truthy.
fn media_live(a: &Value) -> Option<Value> {
    let m = a.get("media")?;
    let len_truthy = match m {
        Value::Array(arr) => !arr.is_empty(),
        Value::String(s) => !s.is_empty(),
        // numbers/bools/objects: `.length` is undefined → falsy
        _ => false,
    };
    if truthy(Some(m)) && len_truthy {
        Some(m.clone())
    } else {
        None
    }
}

/// The ledger energy read used by dm/call/post-reference gates.
fn burn_bal(st: &State, id: &str) -> Option<f64> {
    st.ledger_by_id.get(id).map(|&ix| st.ledgers[ix].burn_bal)
}

// ---------------------------------------------------------------------------

// replay.cjs 1449-1473 — seedWorld: 4 actors, 4 nodes, 9 edges, seed
// creators/payloads/reviewMeta. No debit, no counter tick.
pub(crate) fn seed_world(st: &mut State) {
    st.add_actor("alice", "Alice", 3.0, 10, 0.0, None);
    st.add_actor("bob", "Bob", 2.0, 8, 0.0, None);
    st.add_actor("carol", "Carol", 4.0, 12, 0.0, None);
    st.add_actor("dave", "Dave", 1.0, 5, 0.0, None);
    st.g.add_node(NodeInfo { id: "photo".into(), kind: NodeKind::Content, label: "Photo".into() });
    st.g.add_node(NodeInfo {
        id: "comment".into(),
        kind: NodeKind::Comment,
        label: "Comment".into(),
    });
    st.g.add_node(NodeInfo {
        id: "streetart".into(),
        kind: NodeKind::Type,
        label: "#StreetArt".into(),
    });
    st.g.add_node(NodeInfo {
        id: "sneakers".into(),
        kind: NodeKind::Item,
        label: "Sneakers".into(),
    });
    let seed_edge = |id: &str, family: &str, src: &str, tgt: &str, pd: f64, pi: f64| EdgeInput {
        id: id.to_string(),
        family: family.to_string(),
        src: src.to_string(),
        tgt: tgt.to_string(),
        pd,
        pi,
        ..Default::default()
    };
    st.g.append(seed_edge("e1", "SelfDeclaration", "alice", "prof_alice", 1.0, 0.75));
    st.g.append(seed_edge("e1r", "SelfReputation", "prof_alice", "alice", 1.0, 0.75));
    st.g.append(seed_edge("e2", "Opinion", "alice", "photo", 0.9, 0.7));
    st.g.append(seed_edge("e3", "ReviewA", "bob", "photo", 0.7, 0.8));
    st.g.append(seed_edge("e4", "ReviewT", "photo", "comment", 0.8, 0.7));
    st.g.append(seed_edge("e5", "TagA", "carol", "comment", 0.8, 0.9));
    st.g.append(seed_edge("e6", "TagT", "comment", "streetart", 0.9, 0.8));
    st.g.append(seed_edge("e7", "Affinity", "alice", "streetart", 0.6, 0.8));
    st.g.append(seed_edge("e8", "Owner", "bob", "sneakers", 0.7, 1.0));
    st.creators.insert("photo".into(), "alice".into());
    st.creators.insert("comment".into(), "bob".into());
    st.creators.insert("sneakers".into(), "bob".into());
    st.creators.insert("streetart".into(), "carol".into());
    st.payloads.insert("photo".into(), super::state::SEED_POST_PHOTO.to_string());
    st.payloads.insert("comment".into(), super::state::SEED_POST_COMMENT.to_string());
    st.review_meta.insert("comment".into(), ReviewMeta { e: 0.7, f: 0.8 });
    // chron ×2 deferred to the host phase
}

// replay.cjs 1474-1499 — register: addActor(THETA, 0, a.epoch, twin/deleted
// label), pinHash, reg_ edge, debit + weighHome(1,1), deleted flag.
pub(crate) fn register(st: &mut State, a: &Value, _i: usize, payload_gone: bool) {
    let id = js_prop_key(a.get("id"));
    let handle = js_str(a, "handle").unwrap_or("").to_string();
    let twin = st.handle_twin.get(&id).copied().unwrap_or(false);
    let label = if payload_gone {
        "[deleted]".to_string()
    } else if twin {
        format!("{handle} ({id}, not the original)")
    } else {
        handle.clone()
    };
    let epoch = js_tonum(a.get("epoch"));
    st.add_actor(&id, &handle, THETA, 0, epoch, Some(&label));
    if truthy(a.get("pinHash")) {
        st.pin_hash.insert(id.clone(), js_prop_key(a.get("pinHash")));
    }
    st.g.append(EdgeInput {
        id: format!("reg_{id}"),
        family: "Registration".to_string(),
        src: id.clone(),
        tgt: format!("prof_{id}"),
        pd: 1.0,
        pi: 1.0,
        ..Default::default()
    });
    st.debit(&id);
    st.weigh_home(&id, 1.0, 1.0);
    if payload_gone {
        if let Some(&ix) = st.ledger_by_id.get(&id) {
            st.ledgers[ix].deleted = true;
        }
    }
    // else-arm chron deferred to the host phase
}

// replay.cjs 1680-1692 — setPin: requires ledger AND pinHash; newest wins.
pub(crate) fn set_pin(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let id = js_prop_key(a.get("id"));
    if st.known(&id) && truthy(a.get("pinHash")) {
        st.pin_hash.insert(id, js_prop_key(a.get("pinHash")));
        // chron deferred to the host phase
    }
}

// replay.cjs 1693-1710 — dm: chat/message nodes, SendA/SendT hyper,
// debit + weighHome(0.8, 0.8), payload-guarded dms push.
pub(crate) fn dm(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let from = js_prop_key(a.get("from"));
    let to = js_prop_key(a.get("to"));
    if !st.known(&from) || !st.known(&to) {
        return;
    }
    // 1695: `ledgerById[a.from] && ledgerById[a.to] &&` is redundant after
    // known(); the live gate is burnBal >= THETA (NaN fails it, like JS).
    let Some(bal) = burn_bal(st, &from) else { return };
    if !(bal >= THETA) {
        return;
    }
    // [a.from, a.to].sort() — JS default sort = UTF-16 code-unit order.
    let (p0, p1) = if utf16_cmp(&from, &to) == Ordering::Greater {
        (to.as_str(), from.as_str())
    } else {
        (from.as_str(), to.as_str())
    };
    let chat_id = format!("chat_{p0}_{p1}");
    if !st.g.nodes.contains_key(&chat_id) {
        st.g.add_node(NodeInfo { id: chat_id.clone(), kind: NodeKind::Chat, label: "Chat".into() });
    }
    st.counter += 1;
    let c = st.counter;
    let msg_id = format!("m{c}");
    st.g.add_node(NodeInfo { id: msg_id.clone(), kind: NodeKind::Message, label: "Message".into() });
    let ep = Some(st.certs_so_far as f64);
    st.g.append_hyper(
        EdgeInput {
            id: format!("snA{c}"),
            family: "SendA".to_string(),
            src: from.clone(),
            tgt: chat_id.clone(),
            pd: 0.8,
            pi: 0.8,
            epoch: ep,
            ..Default::default()
        },
        EdgeInput {
            id: format!("snT{c}"),
            family: "SendT".to_string(),
            src: chat_id,
            tgt: msg_id,
            pd: 0.8,
            pi: 0.8,
            epoch: ep,
            ..Default::default()
        },
    );
    st.debit(&from);
    st.weigh_home(&from, 0.8, 0.8);
    if !payload_gone {
        st.dms.push(Dm {
            from,
            to,
            text: js_str(a, "text").unwrap_or("").to_string(),
            call: None,
            idx: i as u64,
        });
    }
}

// replay.cjs 1722-1742 — stream: mint skeleton (counter++, actContent,
// contentAuthor, Publish pd=a.a), debit + weighHome(a.a, 1).
pub(crate) fn stream(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    st.counter += 1;
    let c = st.counter;
    let scid = format!("c{c}");
    st.act_content.insert(i as u64, scid.clone());
    st.content_author.insert(scid.clone(), author.clone());
    if payload_gone {
        st.muted_content.insert(scid.clone(), true);
    }
    st.g.add_node(NodeInfo {
        id: scid.clone(),
        kind: NodeKind::Content,
        label: if payload_gone { "[deleted]".to_string() } else { format!("Stream {c}") },
    });
    let aa = js_tonum(a.get("a"));
    st.g.append(EdgeInput {
        id: format!("pub{c}"),
        family: "Publish".to_string(),
        src: author.clone(),
        tgt: scid.clone(),
        pd: aa,
        pi: 1.0,
        epoch: Some(st.certs_so_far as f64),
        ..Default::default()
    });
    st.debit(&author);
    st.weigh_home(&author, aa, 1.0);
    if !payload_gone {
        st.creators.insert(scid.clone(), author.clone());
        st.payloads.insert(scid.clone(), js_str(a, "text").unwrap_or("").to_string());
        st.post_meta.insert(
            scid,
            PostMeta {
                idx: i as u64,
                ts: a.get("ts").cloned(),
                edited: false,
                flag: Some(PostFlag::Stream),
            },
        );
        // chron deferred to the host phase
    }
}

// replay.cjs 1743-1781 — event: stream skeleton at pd 0.8 + events record
// (place ≤120 UTF-16 units, fee round6, cap floor).
pub(crate) fn event(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    st.counter += 1;
    let c = st.counter;
    let ecid = format!("c{c}");
    st.act_content.insert(i as u64, ecid.clone());
    // unconditional: a departure must not re-cut a closed epoch (1760)
    st.content_author.insert(ecid.clone(), author.clone());
    if payload_gone {
        st.muted_content.insert(ecid.clone(), true);
    }
    st.g.add_node(NodeInfo {
        id: ecid.clone(),
        kind: NodeKind::Content,
        label: if payload_gone { "[deleted]".to_string() } else { format!("Event {c}") },
    });
    st.g.append(EdgeInput {
        id: format!("pub{c}"),
        family: "Publish".to_string(),
        src: author.clone(),
        tgt: ecid.clone(),
        pd: 0.8,
        pi: 1.0,
        epoch: Some(st.certs_so_far as f64),
        ..Default::default()
    });
    st.debit(&author);
    st.weigh_home(&author, 0.8, 1.0);
    let at = match a.get("at") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => 0.0,
    };
    let place = if payload_gone {
        String::new()
    } else {
        let src = if truthy(a.get("place")) { js_prop_key(a.get("place")) } else { String::new() };
        slice_utf16(&src, 120)
    };
    let feev = js_tonum(a.get("fee"));
    let fee = if feev > 0.0 { round6(feev) } else { 0.0 };
    let cur = if feev > 0.0 {
        if truthy(a.get("cur")) {
            js_prop_key(a.get("cur"))
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    let capv = js_tonum(a.get("cap"));
    let cap = if capv > 0.0 { capv.floor() as u64 } else { 0 };
    st.events.insert(
        ecid.clone(),
        EventRec { host: author.clone(), at, place, fee, cur, cap, idx: i as u64 },
    );
    if !payload_gone {
        st.creators.insert(ecid.clone(), author.clone());
        st.payloads.insert(ecid.clone(), js_str(a, "text").unwrap_or("").to_string());
        st.post_meta.insert(
            ecid,
            PostMeta {
                idx: i as u64,
                ts: a.get("ts").cloned(),
                edited: false,
                flag: Some(PostFlag::Event),
            },
        );
        // chron deferred to the host phase
    }
}

// replay.cjs 1782-1788 — invite: host-only, free, no debit.
pub(crate) fn invite(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let from = js_prop_key(a.get("from"));
    let to = js_prop_key(a.get("to"));
    if !st.known(&from) || !st.known(&to) {
        return;
    }
    let cid = js_prop_key(a.get("cid"));
    let Some(iev) = st.events.get(&cid) else { return };
    if iev.host != from || to == from {
        return;
    }
    st.event_invites.entry(cid).or_default().insert(to, true);
    // unconditional chron deferred to the host phase
}

// replay.cjs 1789-1813 — rsvp: tokenActError gate (withdraw ignores it),
// fee transfer + paidTo, NO debit anywhere.
pub(crate) fn rsvp(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let from = js_prop_key(a.get("from"));
    if !st.known(&from) {
        return;
    }
    let cid = js_prop_key(a.get("cid"));
    let Some(rev2) = st.events.get(&cid) else { return };
    let (fee, cur, host) = (rev2.fee, rev2.cur.clone(), rev2.host.clone());
    // 1793: tokenActError({ t:'rsvp', author, cid, amt, cur, to }) — the
    // synthesized act carries the raw field values (undefined ≡ absent).
    let mut synth = Map::new();
    synth.insert("t".to_string(), Value::String("rsvp".to_string()));
    for (dst, srcf) in
        [("author", "from"), ("cid", "cid"), ("amt", "amt"), ("cur", "cur"), ("to", "to")]
    {
        if let Some(v) = a.get(srcf) {
            synth.insert(dst.to_string(), v.clone());
        }
    }
    let rerr = super::acts_tokens::token_act_error(st, &Value::Object(synth));
    if matches!(a.get("on"), Some(Value::Bool(false))) {
        // withdraw IGNORES rerr, no refund, no debit
        let present =
            st.event_going.get(&cid).and_then(|m| m.get(&from)).copied().unwrap_or(false);
        if present {
            st.event_going.get_mut(&cid).unwrap().shift_remove(&from);
        }
        // chron deferred to the host phase
        return;
    }
    if rerr.is_some() {
        return;
    }
    if fee > 0.0 {
        st.tok_debit(&cur, &from, fee);
        st.tok_credit(&cur, &host, fee);
        st.paid_to.insert(format!("{from}>{host}"), true);
    }
    st.event_going.entry(cid).or_default().insert(from, true);
    // chron deferred to the host phase
}

// replay.cjs 1814-1896 — post: update path (pubu+i, delete/latest-wins) vs
// mint path (counter++), then quote-reference and up-to-3 mentions
// (person-vouch, no weighHome) on the mint path only.
pub(crate) fn post(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    let aa = js_tonum(a.get("a"));
    let ep = Some(st.certs_so_far as f64);
    // 1822: Number.isInteger(a.target) && actContent[a.target] !== undefined
    let upd = int_act_index(a.get("target")).filter(|n| st.act_content.contains_key(n));
    if let Some(n) = upd {
        let cid = st.act_content[&n].clone();
        // no counter++: the node already exists (1826-1828)
        st.g.append(EdgeInput {
            id: format!("pubu{i}"),
            family: "Publish".to_string(),
            src: author.clone(),
            tgt: cid.clone(),
            pd: aa,
            pi: 1.0,
            epoch: ep,
            ..Default::default()
        });
        st.debit(&author);
        st.weigh_home(&author, aa, 1.0);
        if payload_gone {
            st.muted_content.insert(cid.clone(), true);
            st.payloads.shift_remove(&cid);
            st.media_meta.shift_remove(&cid);
            if let Some(pn) = st.g.nodes.get_mut(&cid) {
                pn.label = "[deleted]".to_string();
            }
        } else if st.payloads.contains_key(&cid) {
            // log order gives latest-wins
            st.payloads.insert(cid.clone(), js_str(a, "text").unwrap_or("").to_string());
            if let Some(m) = media_live(a) {
                st.media_meta.insert(cid.clone(), m);
            }
            if let Some(pm) = st.post_meta.get_mut(&cid) {
                pm.edited = true;
            }
            // chron deferred to the host phase
        }
        return; // 1866: if (isUpdate) continue — references belong to the mint
    }
    // ---- mint path
    st.counter += 1;
    let c = st.counter;
    let cid = format!("c{c}");
    st.act_content.insert(i as u64, cid.clone());
    st.content_author.insert(cid.clone(), author.clone());
    if payload_gone {
        st.muted_content.insert(cid.clone(), true);
    }
    st.g.add_node(NodeInfo {
        id: cid.clone(),
        kind: NodeKind::Content,
        label: if payload_gone { "[deleted]".to_string() } else { format!("Post {c}") },
    });
    st.g.append(EdgeInput {
        id: format!("pub{c}"),
        family: "Publish".to_string(),
        src: author.clone(),
        tgt: cid.clone(),
        pd: aa,
        pi: 1.0,
        epoch: ep,
        ..Default::default()
    });
    st.debit(&author);
    st.weigh_home(&author, aa, 1.0);
    if !payload_gone {
        st.creators.insert(cid.clone(), author.clone());
        st.payloads.insert(cid.clone(), js_str(a, "text").unwrap_or("").to_string());
        if let Some(m) = media_live(a) {
            st.media_meta.insert(cid.clone(), m);
        }
        st.post_meta.insert(
            cid.clone(),
            PostMeta {
                idx: i as u64,
                ts: a.get("ts").cloned(),
                edited: truthy(a.get("edited")),
                flag: None,
            },
        );
        // chron deferred to the host phase
    }
    // ---- quote reference (1869-1877): its own θ-debit
    if truthy(a.get("ref")) {
        let rk = js_prop_key(a.get("ref"));
        let energetic = burn_bal(st, &author).map_or(false, |b| b >= THETA);
        if st.g.nodes.contains_key(&rk) && energetic {
            st.counter += 1;
            let rc = st.counter;
            st.g.append_hyper(
                EdgeInput {
                    id: format!("rfA{rc}"),
                    family: "ReferenceA".to_string(),
                    src: author.clone(),
                    tgt: cid.clone(),
                    pd: 0.8,
                    pi: 0.9,
                    epoch: ep,
                    ..Default::default()
                },
                EdgeInput {
                    id: format!("rfT{rc}"),
                    family: "ReferenceT".to_string(),
                    src: cid.clone(),
                    tgt: rk,
                    pd: 0.9,
                    pi: 0.8,
                    epoch: ep,
                    ..Default::default()
                },
            );
            st.debit(&author);
            st.weigh_home(&author, 0.8, 0.9);
            // chron deferred to the host phase
        }
    }
    // ---- @mentions (1881-1896): rmen (server-resolved) else legacy parse;
    // person-vouch, NO weighHome. Skip gate is `burnBal < THETA` (a NaN
    // balance does NOT skip, exactly like JS).
    let mentioned: Vec<String> = match a.get("rmen") {
        Some(v) => v
            .as_array()
            .map(|arr| arr.iter().map(|x| js_prop_key(Some(x))).collect())
            .unwrap_or_default(),
        None => parse_mentions(js_str(a, "text").unwrap_or(""), &st.handles),
    };
    for mid in &mentioned {
        let skip = *mid == author
            || match burn_bal(st, &author) {
                None => true,                // !ledgerById[a.author]
                Some(b) => b < THETA,        // NaN < θ is false → no skip
            };
        if skip {
            continue;
        }
        st.counter += 1;
        let mc = st.counter;
        st.g.append_hyper(
            EdgeInput {
                id: format!("rfA{mc}"),
                family: "ReferenceA".to_string(),
                src: author.clone(),
                tgt: cid.clone(),
                pd: 0.7,
                pi: 0.8,
                epoch: ep,
                ..Default::default()
            },
            EdgeInput {
                id: format!("rfT{mc}"),
                family: "ReferenceT".to_string(),
                src: cid.clone(),
                tgt: format!("prof_{mid}"),
                pd: 0.8,
                pi: 0.7,
                epoch: ep,
                ..Default::default()
            },
        );
        st.debit(&author);
        st.vouch(&author, mid, 0.7, 0.8);
        // chron deferred to the host phase
    }
}

// replay.cjs 1897-1926 — opinion: op edge (target NOT existence-checked),
// profile-vouch vs weighHome, epochEngage (paidTo-guarded), debit LAST.
pub(crate) fn opinion(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    st.counter += 1;
    let c = st.counter;
    let target = js_prop_key(a.get("target"));
    let p = js_tonum(a.get("p"));
    let r = js_tonum(a.get("r"));
    st.g.append(EdgeInput {
        id: format!("op{c}"),
        family: "Opinion".to_string(),
        src: author.clone(),
        tgt: target.clone(),
        pd: p,
        pi: r,
        epoch: Some(st.certs_so_far as f64),
        ..Default::default()
    });
    // 1905: owner = target.indexOf('prof_') === 0 ? target.slice(5) : null —
    // an empty slice ('prof_' exactly) is falsy in both gates below.
    let owner = target.strip_prefix("prof_").map(str::to_string);
    let owner_truthy = owner.as_deref().map_or(false, |o| !o.is_empty());
    if owner_truthy && owner.as_deref() != Some(author.as_str()) {
        let o = owner.clone().unwrap();
        st.vouch(&author, &o, p, r);
    } else {
        st.weigh_home(&author, p, r);
    }
    if !owner_truthy {
        if let Some(ca) = st.content_author.get(&target).cloned() {
            if !ca.is_empty()
                && ca != author
                && !st.paid_to.get(&format!("{author}>{ca}")).copied().unwrap_or(false)
            {
                st.epoch_engage.push(Engage {
                    actor: author.clone(),
                    creator: ca,
                    base: if p >= 0.0 { 1.0 } else { 0.3 },
                    cid: target.clone(),
                    kind: if p >= 0.0 { "reaction" } else { "dislike" },
                });
            }
        }
    }
    // chron (uses the appended record's tau/weight) deferred to the host phase
    st.debit(&author);
}

// replay.cjs 1927-1976 — review: comment-update path (rvAu/rvTu + i, no
// counter tick, no epochEngage) vs mint path (rvA/rvT + counter, epochEngage
// base 1.2), debit last on both.
pub(crate) fn review(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    let e = js_tonum(a.get("e"));
    let f = js_tonum(a.get("f"));
    let target = js_prop_key(a.get("target"));
    let ep = Some(st.certs_so_far as f64);
    // 1932: Number.isInteger(a.upd) && actContent[a.upd] !== undefined
    let upd = int_act_index(a.get("upd")).filter(|n| st.act_content.contains_key(n));
    if let Some(n) = upd {
        let cmid = st.act_content[&n].clone();
        st.g.append_hyper(
            EdgeInput {
                id: format!("rvAu{i}"),
                family: "ReviewA".to_string(),
                src: author.clone(),
                tgt: target.clone(),
                pd: e,
                pi: f,
                epoch: ep,
                ..Default::default()
            },
            EdgeInput {
                id: format!("rvTu{i}"),
                family: "ReviewT".to_string(),
                src: target,
                tgt: cmid.clone(),
                pd: f,
                pi: e,
                epoch: ep,
                ..Default::default()
            },
        );
        st.weigh_home(&author, e, f);
        if !payload_gone && st.payloads.contains_key(&cmid) {
            st.payloads.insert(cmid.clone(), js_str(a, "text").unwrap_or("").to_string());
            st.review_meta.insert(cmid.clone(), ReviewMeta { e, f });
            if let Some(pm) = st.post_meta.get_mut(&cmid) {
                pm.edited = true;
            }
            // chron deferred to the host phase
        }
        st.debit(&author);
        return;
    }
    // ---- mint path
    st.counter += 1;
    let c = st.counter;
    let cmid = format!("c{c}");
    st.act_content.insert(i as u64, cmid.clone());
    st.content_author.insert(cmid.clone(), author.clone());
    if payload_gone {
        st.muted_content.insert(cmid.clone(), true);
    }
    st.g.add_node(NodeInfo {
        id: cmid.clone(),
        kind: NodeKind::Comment,
        label: if payload_gone { "[deleted]".to_string() } else { format!("Review {c}") },
    });
    st.g.append_hyper(
        EdgeInput {
            id: format!("rvA{c}"),
            family: "ReviewA".to_string(),
            src: author.clone(),
            tgt: target.clone(),
            pd: e,
            pi: f,
            epoch: ep,
            ..Default::default()
        },
        EdgeInput {
            id: format!("rvT{c}"),
            family: "ReviewT".to_string(),
            src: target.clone(),
            tgt: cmid.clone(),
            pd: f,
            pi: e,
            epoch: ep,
            ..Default::default()
        },
    );
    st.weigh_home(&author, e, f);
    if let Some(ca) = st.content_author.get(&target).cloned() {
        if !ca.is_empty()
            && ca != author
            && !st.paid_to.get(&format!("{author}>{ca}")).copied().unwrap_or(false)
        {
            st.epoch_engage.push(Engage {
                actor: author.clone(),
                creator: ca,
                base: 1.2,
                cid: target.clone(),
                kind: "comment",
            });
        }
    }
    if !payload_gone {
        st.creators.insert(cmid.clone(), author.clone());
        st.payloads.insert(cmid.clone(), js_str(a, "text").unwrap_or("").to_string());
        st.review_meta.insert(cmid.clone(), ReviewMeta { e, f });
        st.post_meta.insert(
            cmid,
            PostMeta {
                idx: i as u64,
                ts: a.get("ts").cloned(),
                edited: false,
                flag: Some(PostFlag::Comment),
            },
        );
        // chron deferred to the host phase
    }
    st.debit(&author);
}

// replay.cjs 1977-2007 — follow: free (deliberately NO debit; a test pins
// it), inner sets created even on the unfollow arm.
pub(crate) fn follow(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let from = js_prop_key(a.get("from"));
    let to = js_prop_key(a.get("to"));
    if !(st.known(&from) && st.known(&to) && from != to) {
        return;
    }
    let off = matches!(a.get("on"), Some(Value::Bool(false)));
    let fset = st.follows.entry(from.clone()).or_default();
    if off {
        fset.shift_remove(&to);
    } else {
        fset.insert(to.clone(), true);
    }
    let bset = st.followers.entry(to).or_default();
    if off {
        bset.shift_remove(&from);
    } else {
        bset.insert(from, true);
    }
    // unconditional chron deferred to the host phase
}

// replay.cjs 2008-2024 — profile: whole record replaced, free.
pub(crate) fn profile(st: &mut State, a: &Value, i: usize, _payload_gone: bool) {
    let id = js_prop_key(a.get("id"));
    if !st.known(&id) {
        return;
    }
    st.profiles.insert(
        id,
        Profile {
            bio: js_str(a, "bio").unwrap_or("").to_string(),
            link: js_str(a, "link").unwrap_or("").to_string(),
            pic: js_str(a, "pic").unwrap_or("").to_string(),
            idx: i as u64,
        },
    );
    // chron deferred to the host phase
}

// replay.cjs 2082-2099 — tag: counter++, typeNode (may mint the Type node
// BEFORE the hyper legs), TagA/TagT, weighHome(a.r, a.c), debit last.
pub(crate) fn tag(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let author = js_prop_key(a.get("author"));
    if !st.known(&author) {
        return;
    }
    st.counter += 1;
    let c = st.counter;
    let name = js_str(a, "name").unwrap_or("").to_string();
    let tid = st.type_node(&name);
    let target = js_prop_key(a.get("target"));
    let r = js_tonum(a.get("r"));
    let cc = js_tonum(a.get("c"));
    let ep = Some(st.certs_so_far as f64);
    st.g.append_hyper(
        EdgeInput {
            id: format!("tgA{c}"),
            family: "TagA".to_string(),
            src: author.clone(),
            tgt: target.clone(),
            pd: r,
            pi: cc,
            epoch: ep,
            ..Default::default()
        },
        EdgeInput {
            id: format!("tgT{c}"),
            family: "TagT".to_string(),
            src: target,
            tgt: tid,
            pd: cc,
            pi: r,
            epoch: ep,
            ..Default::default()
        },
    );
    st.weigh_home(&author, r, cc);
    // chron deferred to the host phase
    st.debit(&author);
}

// replay.cjs 2100-2113 — call: debit only, payload-guarded dms push.
pub(crate) fn call(st: &mut State, a: &Value, i: usize, payload_gone: bool) {
    let from = js_prop_key(a.get("from"));
    let to = js_prop_key(a.get("to"));
    if !(st.known(&from) && st.known(&to)) {
        return;
    }
    let Some(bal) = burn_bal(st, &from) else { return };
    if !(bal >= THETA) {
        return;
    }
    st.debit(&from);
    if !payload_gone {
        // `a.dur || 0` — a falsy dur (0, NaN via missing, '') collapses to 0.
        let dur = if truthy(a.get("dur")) { js_tonum(a.get("dur")) } else { 0.0 };
        st.dms.push(Dm {
            from,
            to,
            text: String::new(),
            call: Some(CallInfo { outcome: a.get("outcome").cloned(), dur }),
            idx: i as u64,
        });
        // chron deferred to the host phase
    }
}

// replay.cjs 2114-2122 — editPost: NO known() guard; muted/payload gates;
// free, no edge.
pub(crate) fn edit_post(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    let Some(ecid) = act_content_by_key(st, a.get("target")) else { return };
    if ecid.is_empty() {
        return; // JS truthiness gate on the id string (never empty in practice)
    }
    if st.muted_content.get(&ecid).copied().unwrap_or(false) {
        return;
    }
    if !st.payloads.contains_key(&ecid) {
        return;
    }
    st.payloads.insert(ecid.clone(), js_str(a, "text").unwrap_or("").to_string());
    if let Some(pm) = st.post_meta.get_mut(&ecid) {
        pm.edited = true;
    }
    // chron deferred to the host phase
}

// replay.cjs 2123-2124 — deletePost: effects live in the pre-scan; the
// branch body is chron-only, deferred to the host phase.
pub(crate) fn delete_post(_st: &mut State, _a: &Value, _i: usize, _payload_gone: bool) {}

// replay.cjs 2125-2126 — deleteAccount: pre-scan did the work; chron-only
// body, deferred to the host phase.
pub(crate) fn delete_account(_st: &mut State, _a: &Value, _i: usize, _payload_gone: bool) {}

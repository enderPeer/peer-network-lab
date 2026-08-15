//! The fold entry — replay.cjs replayUncached (118-2633).
//!
//! Real here: the deletion pre-scan (153-162), the loop preamble
//! (edgeAct fill + payloadGone, 1430-1448) and the act dispatch chain
//! (1449-2495). Branch bodies live in the sibling modules as
//! pub(crate) stubs; the finalization block (2498-2536) is close::finalize.
//!
//! The fold never fails: unknown/invalid acts are skipped, never errors.

pub mod state;

pub(crate) mod acts_markets;
pub(crate) mod acts_peerburn;
pub(crate) mod acts_social;
pub(crate) mod acts_tokens;
pub(crate) mod close;

use serde_json::Value;

use crate::jsval::truthy;
use state::{js_prop_key, skel_value, State};

pub use state::State as FoldState;

/// replayUncached(acts). Acts arrive parsed; the caller prepends the seed
/// act itself (the JS harness always replays [SEED_ACT, ...fileActs]).
pub fn replay(acts: &[Value]) -> State {
    let mut st = State::new();

    // ---- deletion pre-scan — replay.cjs 153-162 (retroactive: removes
    // PAYLOAD only; edges, θ debits, weighing homes, vouches all stay).
    for pact in acts {
        match pact.get("t").and_then(Value::as_str) {
            Some("deleteAccount") => {
                st.deleted_actors.insert(js_prop_key(pact.get("id")), true);
            }
            Some("deletePost") => {
                // deletedPostIdx[pact.target] — membership is by property-key
                // string; only keys equal to a canonical u64 decimal can ever
                // match a loop index.
                let key = js_prop_key(pact.get("target"));
                if let Ok(n) = key.parse::<u64>() {
                    if n.to_string() == key {
                        st.deleted_post_idx.insert(n, true);
                    }
                }
            }
            Some("register") if truthy(pact.get("handle")) => {
                let sk = skel_value(pact.get("handle"));
                let id_key = js_prop_key(pact.get("id"));
                if !sk.is_empty() {
                    match st.seen_skel.get(&sk) {
                        // JS: a falsy stored value falls through to the
                        // overwrite arm (only '' is reachable here).
                        Some(prev) if prev.is_empty() => {
                            st.seen_skel.insert(sk, id_key);
                        }
                        Some(prev) if *prev != id_key => {
                            st.handle_twin.insert(id_key, true);
                        }
                        Some(_) => {
                            st.seen_skel.insert(sk, id_key); // same id: re-assign in place
                        }
                        None => {
                            st.seen_skel.insert(sk, id_key);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // ---- main dispatch loop — replay.cjs 1430-2495
    for i in 0..acts.len() {
        // Fill at TOP: the previous act's edges (replay.cjs 1430).
        while st.edge_act.len() < st.g.edges.len() {
            st.edge_act.push(i as i64 - 1);
        }
        let a = &acts[i];
        // replay.cjs 1432-1435: the act's own author-ish fields, or the act
        // itself deleted by index. Muting is never inherited from the target.
        let payload_gone = st.actor_deleted(a.get("author"))
            || st.actor_deleted(a.get("from"))
            || st.actor_deleted(a.get("id"))
            || st.deleted_post_idx.contains_key(&(i as u64));

        match a.get("t").and_then(Value::as_str) {
            Some("seedWorld") => acts_social::seed_world(&mut st),
            Some("register") => acts_social::register(&mut st, a, i, payload_gone),
            Some("burn") => acts_tokens::faucet_burn(&mut st, a, i, payload_gone),
            Some("btcBurn") => acts_tokens::btc_burn(&mut st, a, i, payload_gone),
            Some("peerBurn") => acts_peerburn::peer_burn(&mut st, a, i, payload_gone),
            Some("resetTokens") => acts_tokens::reset_tokens(&mut st, a, i, payload_gone),
            // Retired Layer-0 doors — matched by the else-if chain, bodies
            // comment-only: the acts parse and do NOTHING (replay.cjs
            // 1636-1721; no chron, no debit, no state change).
            Some("deposit") | Some("burnL0") | Some("redeem") | Some("transferL0")
            | Some("closeCycle") => {}
            Some("setPin") => acts_social::set_pin(&mut st, a, i, payload_gone),
            Some("dm") => acts_social::dm(&mut st, a, i, payload_gone),
            Some("stream") => acts_social::stream(&mut st, a, i, payload_gone),
            Some("event") => acts_social::event(&mut st, a, i, payload_gone),
            Some("invite") => acts_social::invite(&mut st, a, i, payload_gone),
            Some("rsvp") => acts_social::rsvp(&mut st, a, i, payload_gone),
            Some("post") => acts_social::post(&mut st, a, i, payload_gone),
            Some("opinion") => acts_social::opinion(&mut st, a, i, payload_gone),
            Some("review") => acts_social::review(&mut st, a, i, payload_gone),
            Some("follow") => acts_social::follow(&mut st, a, i, payload_gone),
            Some("profile") => acts_social::profile(&mut st, a, i, payload_gone),
            Some("bindAddress") => acts_peerburn::bind_address(&mut st, a, i, payload_gone),
            Some("tag") => acts_social::tag(&mut st, a, i, payload_gone),
            Some("call") => acts_social::call(&mut st, a, i, payload_gone),
            Some("editPost") => acts_social::edit_post(&mut st, a, i, payload_gone),
            Some("deletePost") => acts_social::delete_post(&mut st, a, i, payload_gone),
            Some("deleteAccount") => acts_social::delete_account(&mut st, a, i, payload_gone),
            // Token group: one tokenActError gate, then per-kind sub-branch
            // (replay.cjs 2127-2220).
            Some("btcClaim") | Some("assetCreate") | Some("tokenSend") | Some("poolCreate")
            | Some("poolAdd") | Some("poolRemove") | Some("poolSwap") | Some("advert")
            | Some("adStop") => acts_tokens::token_act(&mut st, a, i, payload_gone),
            Some("market") => acts_markets::market(&mut st, a, i, payload_gone),
            Some("bet") => acts_markets::bet(&mut st, a, i, payload_gone),
            Some("modStand") => acts_markets::mod_stand(&mut st, a, i, payload_gone),
            Some("modVote") => acts_markets::mod_vote(&mut st, a, i, payload_gone),
            Some("attest") => acts_markets::attest(&mut st, a, i, payload_gone),
            Some("marketVoid") => acts_markets::market_void(&mut st, a, i, payload_gone),
            Some("closeEpoch") => close::close_epoch(&mut st, a, i, payload_gone),
            // An act whose t matches no branch does nothing at all.
            _ => {}
        }
    }

    // ---- post-loop finalization — replay.cjs 2498-2536.
    close::finalize(&mut st, acts.len());

    st
}

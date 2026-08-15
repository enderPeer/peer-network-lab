//! closeEpoch and the post-loop finalization — replay.cjs 2365-2495
//! (closeEpoch), 50-80 (deferEpoch), 2498-2536 (finalization). Map:
//! port-notes/replay-branches.md "closeEpoch" (order-sensitivity notes 1-6)
//! and replay-state.md §3 (deferred certificate) / §7 (finalization order).

use indexmap::IndexMap;
use serde_json::Value;

use super::state::{
    compile_cells, js_max, js_min, js_tonum, round6, ChronEntry, ChronLine, EpochRecord, State,
    TokenDist, WhoField, WhyDetail, SATS_PER_RESERVE, TOK_CAP, TOK_DECAY, TOK_DIM, TOK_EPOCH,
    TOK_SAT_UNIT, TOK_YEAR,
};
use crate::engine::graph::EdgeInput;
use crate::engine::standing::{solve_standing, Ledger as EngineLedger, SolveOpts};
use crate::engine::NU;

/// replay.cjs 50-80 — deferEpoch: eager snapshots (ledger value copies
/// WITHOUT the deleted flag, compileCells output, deltaActs Map + total),
/// lazy memoized settle. Returns the epoch record and its chron entry
/// ({ who: null, line: lazy }).
pub(crate) fn defer_epoch(st: &State, epoch_no: f64) -> (EpochRecord, ChronEntry) {
    // replay.cjs 51-55
    let snap_ledgers: Vec<EngineLedger> = st
        .ledgers
        .iter()
        .map(|l| EngineLedger { id: l.id.clone(), burn_bal: l.burn_bal, act_count: l.act_count as f64 })
        .collect();
    let cells = compile_cells(&st.bundles, &st.self_cells);
    let snap_dmap: IndexMap<String, u64> = st.delta_acts.clone();
    let act_total: u64 = st.delta_acts.values().sum();
    let rec = EpochRecord::new(epoch_no, act_total, snap_ledgers, cells, snap_dmap);
    // The JS getters (replay.cjs 57-78) are a perf trick — settle eagerly
    // over the close-time snapshots; identical numbers.
    rec.settle();
    let chron = ChronEntry {
        who: WhoField::Null,
        line: ChronLine::EpochClose { epoch: epoch_no, record: st.epoch_history.len() },
        to: None,
        refs: None,
    };
    (rec, chron)
}

// replay.cjs 2365-2495 — closeEpoch, in order: deferEpoch push (snapshots
// BEFORE deltaActs reset), deltaActs = {}, certsSoFar++, tokEpochN++,
// addrAtEpoch snapshot, emission/decay, engagement weights (α̂-gated on
// burnedSats, pair damping, insertion-order float sums), reset-guard
// (certsSoFar <= tokenEpoch0 AFTER the increment), four-op floor
// distribution chain per creator in first-engagement order, round6 running
// `credited`, carry, tokenDist push (live tw/twDetail maps), mint chron
// only in the paying branch, epochEngage = [], paidTo = {}.
pub(crate) fn close_epoch(st: &mut State, a: &Value, _i: usize, _payload_gone: bool) {
    // replay.cjs 2380-2384
    let epoch_no = js_tonum(a.get("epoch"));
    let (rec, ep_chron) = defer_epoch(st, epoch_no);
    st.epoch_history.push(rec);
    st.chron.push(ep_chron);
    st.delta_acts = IndexMap::new();
    st.certs_so_far += 1;

    // ── PEER distribution for the epoch that just closed — 2387-2400 ──
    st.tok_epoch_n += 1;
    let addr_snap: IndexMap<String, String> = st.addr_of.clone();
    st.addr_at_epoch.insert(st.tok_epoch_n, addr_snap);
    let peer_supply = st.token_supply.get("PEER").copied().unwrap_or(f64::NAN);
    let emission = if peer_supply >= TOK_CAP {
        0.0
    } else {
        js_min(
            TOK_EPOCH
                * ender_jsmath::js_pow(
                    TOK_DECAY,
                    ((st.tok_epoch_n as f64 - 1.0) / TOK_YEAR).floor(),
                ),
            TOK_CAP - peer_supply,
        )
    };
    let tok_pool = round6(emission + st.token_carry);

    // Engagement weights — 2401-2453 (insertion-order float sums).
    let mut tw: IndexMap<String, f64> = IndexMap::new();
    let mut tw_total = 0.0f64;
    let mut pair_n: IndexMap<String, u64> = IndexMap::new();
    let mut tw_detail: IndexMap<String, Vec<WhyDetail>> = IndexMap::new();
    for ev in &st.epoch_engage {
        let Some(&lix) = st.ledger_by_id.get(&ev.actor) else {
            continue;
        };
        if st.ledgers[lix].act_count == 0 {
            continue;
        }
        // burnedSats[ev.actor] || 0
        let sats = match st.burned_sats.get(&ev.actor).copied() {
            Some(x) if x != 0.0 && !x.is_nan() => x,
            _ => 0.0,
        };
        if sats <= 0.0 {
            continue; // no real burn, no weight
        }
        let ahat = sats / TOK_SAT_UNIT;
        let pk = format!("{}>{}", ev.actor, ev.creator);
        let n = pair_n.entry(pk).or_insert(0);
        *n += 1;
        let nth = *n;
        let damp = 1.0 / (1.0 + TOK_DIM * (nth as f64 - 1.0));
        let lam = ahat; // linear, not saturating
        let w = ev.base * damp * lam;
        *tw.entry(ev.creator.clone()).or_insert(0.0) += w;
        tw_total += w;
        let det = tw_detail.entry(ev.creator.clone()).or_default();
        if det.len() < 40 {
            det.push(WhyDetail {
                actor: ev.actor.clone(),
                kind: ev.kind,
                cid: ev.cid.clone(),
                base: ev.base,
                damp: round6(damp),
                lambda: round6(lam),
                nth,
                weight: round6(w),
            });
        }
    }
    // 2458: reset-guard AFTER the certsSoFar increment.
    if st.certs_so_far <= st.token_epoch0 {
        tw_total = 0.0;
    }
    if tw_total > 0.0 && tok_pool > 0.0 {
        // 2459-2481
        let mut credited = 0.0f64;
        let mut dist_to: IndexMap<String, f64> = IndexMap::new();
        for (tk, &twv) in &tw {
            // FOUR-OP CHAIN, floor (2468).
            let amt = (tok_pool * twv / tw_total * 1e6).floor() / 1e6;
            if amt <= 0.0 {
                continue;
            }
            st.tok_credit("PEER", tk, amt);
            dist_to.insert(tk.clone(), amt);
            credited = round6(credited + amt);
        }
        let s = st.token_supply.get("PEER").copied().unwrap_or(f64::NAN);
        st.token_supply.insert("PEER".to_string(), round6(s + credited));
        st.token_carry = js_max(0.0, round6(tok_pool - credited));
        let creators_paid = dist_to.len();
        st.token_dist.push(TokenDist {
            epoch: st.tok_epoch_n,
            minted: credited,
            carried: st.token_carry,
            to: dist_to,
            pool: tok_pool,
            emission: round6(emission),
            total_weight: round6(tw_total),
            weights: tw,
            why: tw_detail,
            note: None,
        });
        st.chron.push(ChronEntry {
            who: WhoField::Absent,
            line: ChronLine::Text(format!(
                "epoch {} minted {} PEER across {} creator(s) — engagement-weighted, α̂-gated, never standing",
                st.tok_epoch_n,
                ender_canonical::js_number_to_string(credited),
                creators_paid
            )),
            to: None,
            refs: None,
        });
    } else {
        // 2482-2492: an epoch nobody engaged in mints for the next.
        st.token_carry = tok_pool;
        st.token_dist.push(TokenDist {
            epoch: st.tok_epoch_n,
            minted: 0.0,
            carried: st.token_carry,
            to: IndexMap::new(),
            pool: tok_pool,
            emission: round6(emission),
            total_weight: 0.0,
            weights: IndexMap::new(),
            why: IndexMap::new(),
            note: Some("no eligible engagement"),
        });
    }
    // 2493-2494
    st.epoch_engage = Vec::new();
    st.paid_to = IndexMap::new();
}

// replay.cjs 2498-2536 — post-loop finalization, in order:
//  1. edgeAct fill with acts.length - 1 (BEFORE the self edges — the
//     returned edgeAct stays shorter than g.edges on purpose);
//  2. cells_final = compileCells(bundles, selfCells);
//  3. solved = solveStanding(ledgers, cells, { tilt: 1 });
//  4. x_by_id build in solved.ids order;
//  5. epoch_now = epochHistory.length + 1;
//  6. self-edge loop over ledgerById insertion order, skipping ONLY
//     'alice': S = NU·x, bond = S/(NU+S), tenure = 1 − 1/(epochNow −
//     kReg + 1); dec_/rep_ edges appended when bond > 0;
//  7. disp_handles build in handles order ('[deleted]' substitution);
//  8. peer_burn_used_reserve build (sats / SATS_PER_RESERVE).
pub(crate) fn finalize(st: &mut State, acts_len: usize) {
    // 1. replay.cjs 2502
    while st.edge_act.len() < st.g.edges.len() {
        st.edge_act.push(acts_len as i64 - 1);
    }

    // 2-4. replay.cjs 2512-2515
    st.cells_final = compile_cells(&st.bundles, &st.self_cells);
    let engine_ledgers: Vec<EngineLedger> = st
        .ledgers
        .iter()
        .map(|l| EngineLedger { id: l.id.clone(), burn_bal: l.burn_bal, act_count: l.act_count as f64 })
        .collect();
    let solved = solve_standing(&engine_ledgers, &st.cells_final, &SolveOpts::default());
    let mut x_by_id: IndexMap<String, f64> = IndexMap::new();
    for (ix, id) in solved.ids.iter().enumerate() {
        x_by_id.insert(id.clone(), solved.x[ix]);
    }
    st.x_by_id = x_by_id;
    st.solved = Some(solved);

    // 5. replay.cjs 2517
    st.epoch_now = st.epoch_history.len() as u64 + 1;

    // 6. replay.cjs 2518-2527
    let ids: Vec<String> = st.ledger_by_id.keys().cloned().collect();
    for id2 in ids {
        if id2 == "alice" {
            continue;
        }
        // xById[id2] || 0
        let x = match st.x_by_id.get(&id2).copied() {
            Some(v) if v != 0.0 && !v.is_nan() => v,
            _ => 0.0,
        };
        let s = NU * x;
        let bond = s / (NU + s);
        let kreg = st.k_reg.get(&id2).copied().unwrap_or(f64::NAN);
        let tenure = 1.0 - 1.0 / (st.epoch_now as f64 - kreg + 1.0);
        if bond > 0.0 {
            st.g.append(EdgeInput {
                id: format!("dec_{id2}"),
                family: "SelfDeclaration".to_string(),
                src: id2.clone(),
                tgt: format!("prof_{id2}"),
                pd: 1.0,
                pi: bond,
                tau_override: Some(tenure),
                ..Default::default()
            });
            st.g.append(EdgeInput {
                id: format!("rep_{id2}"),
                family: "SelfReputation".to_string(),
                src: format!("prof_{id2}"),
                tgt: id2.clone(),
                pd: 1.0,
                pi: bond,
                tau_override: Some(tenure),
                ..Default::default()
            });
        }
    }

    // 7. replay.cjs 2529-2530
    let mut disp_handles: IndexMap<String, String> = IndexMap::new();
    for (hk, h) in &st.handles {
        let d = if st.deleted_actors.get(hk).copied().unwrap_or(false) {
            "[deleted]".to_string()
        } else {
            h.clone()
        };
        disp_handles.insert(hk.clone(), d);
    }
    st.disp_handles = disp_handles;

    // 8. replay.cjs 2535-2536
    let mut used_reserve: IndexMap<String, f64> = IndexMap::new();
    for (pbk, &sats) in &st.peer_burn_epoch_use {
        used_reserve.insert(pbk.clone(), sats as f64 / SATS_PER_RESERVE);
    }
    st.peer_burn_used_reserve = used_reserve;
}

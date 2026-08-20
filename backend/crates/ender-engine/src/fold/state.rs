//! THE CONTRACT: every state variable of replayUncached (replay.cjs
//! 118-2633) with the exact types port-notes/replay-state.md assigns, the
//! shared small helpers with verbatim arithmetic, and trace_digest() —
//! the mirror of backend/parity/gen-trace-vectors.mjs projection().
//!
//! Deviations from the JS object graph (all documented in the port report):
//! - ledgers are `Vec<Ledger>` + `ledger_by_id: IndexMap<String, usize>`
//!   (JS shares one record between the array and the map).
//! - the l0 AttestationLedger is OMITTED (constructed, never mutated,
//!   never read into packages).
//! - RawGraph::append returns an index; callers read `g.edges[idx]`.

use std::cell::OnceCell;
use std::collections::BTreeMap;

use indexmap::IndexMap;
use num_bigint::BigUint;
use serde_json::{Map, Number, Value};

use crate::engine::graph::{NodeInfo, NodeKind, RawGraph};
use crate::engine::standing::{
    evaluate_gates, solve_standing, FoldCell, Ledger as EngineLedger, SolveOpts, SolveResult,
};
use crate::engine::THETA;
use crate::jsval::{truthy, utf16_cmp};

// ---------------------------------------------------------------------------
// Constants — replay.cjs (line numbers per replay-state.md §1)

pub const SEED_POST_PHOTO: &str = "Street shot from the underpass — first light."; // 19-22
pub const SEED_POST_COMMENT: &str = "Grain placement is deliberate. This holds up."; // 19-22
pub const FAUCET_PER_EPOCH: u64 = 8; // 170
pub const FAUCET_CAP_FROM_EPOCH: u64 = 62; // 171
pub const TBTC_FAUCET_CLOSED_FROM: u64 = 62; // 174 (dead)
pub const TOK_EPOCH: f64 = 5000.0; // 624
pub const TOK_DECAY: f64 = 0.9; // 624
pub const TOK_YEAR: f64 = 365.0; // 624
pub const TOK_CAP: f64 = 18_250_000.0; // 624
pub const TOK_DIM: f64 = 0.3; // 625
pub const TOK_SAT_UNIT: f64 = 1000.0; // 630
pub const SATS_PER_RESERVE: f64 = 100.0; // 633
pub const PEER_BURN_TWAP_MS: f64 = 30.0 * 60.0 * 1000.0; // 689
pub const PEER_BURN_TWAP_OBS: f64 = 12.0; // 690
pub const PEER_BURN_GRID: i64 = 16; // 698
pub const PEER_BURN_MIN_POOL_SATS: u64 = 1_000_000; // 705
pub const PEER_BURN_RESERVE_PER_EPOCH: f64 = 100.0; // 717
pub const PEER_BURN_SATS_PER_EPOCH: f64 = PEER_BURN_RESERVE_PER_EPOCH * SATS_PER_RESERVE; // 723
pub const PEER_BURN_CAP_FROM_EPOCH: u64 = 0; // 747
pub const PEER_BURN_ADDR: &str = "0x000000000000000000000000000000000000dead"; // 764
pub const TBTC_CLAIM: f64 = 0.01; // 807
pub const TOK_MINLIQ: f64 = 1e-9; // 808
pub const AD_PEER_PER_DAY: f64 = 10.0; // 856
pub const MKT_MIN_OPTS: usize = 2; // 932
pub const MKT_MAX_OPTS: usize = 7; // 932
pub const MKT_FEE_MAX_BP: f64 = 500.0; // 933
pub const MKT_RESOLVE_MS: f64 = 604_800_000.0; // 940 (published only)

/// `MKT_SEATS = { 1: true, 3: true, 5: true }` (line 934) — JS indexes this
/// with `a.seats`, i.e. by ToString of the value; test with js_prop_key.
pub fn mkt_seats_has(key: &str) -> bool {
    matches!(key, "1" | "3" | "5")
}

// ---------------------------------------------------------------------------
// JS-semantics helpers shared by every branch

/// JS property-key coercion (ToString) for values used as object keys:
/// `obj[a.id]` with a.id undefined writes the literal key "undefined".
pub fn js_prop_key(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) =>

            ender_canonical::js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.toString = elements joined by ',' (null/undefined
        // slots empty); objects → "[object Object]". Pathological inputs
        // only — hosts never emit these as ids.
        Some(Value::Array(items)) => items
            .iter()
            .map(|it| match it {
                Value::Null => String::new(),
                other => js_prop_key(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS ToNumber for act fields entering arithmetic (`undefined` → NaN,
/// null → 0, '' → 0, numeric strings parsed). See gaps: exotic string
/// literals (hex over 128 bits, "inf") are approximated.
pub fn js_tonum(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return 0.0;
            }
            if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                return u128::from_str_radix(hex, 16).map(|v| v as f64).unwrap_or(f64::NAN);
            }
            if let Some(oct) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
                return u128::from_str_radix(oct, 8).map(|v| v as f64).unwrap_or(f64::NAN);
            }
            if let Some(bin) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
                return u128::from_str_radix(bin, 2).map(|v| v as f64).unwrap_or(f64::NAN);
            }
            match t {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => {
                    // Reject Rust-only spellings JS refuses.
                    let lower = t.to_ascii_lowercase();
                    if lower.contains("inf") || lower.contains("nan") {
                        f64::NAN
                    } else {
                        t.parse::<f64>().unwrap_or(f64::NAN)
                    }
                }
            }
        }
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => js_tonum(Some(&items[0])),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// JS Math.min — NaN-propagating, min(+0, -0) = -0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() {
            a
        } else {
            b
        }
    } else {
        a
    }
}

/// JS Math.max — NaN-propagating, max(+0, -0) = +0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() {
            a
        } else {
            b
        }
    } else {
        a
    }
}

// replay.cjs 847: Math.round(x * 1e6) / 1e6
pub fn round6(x: f64) -> f64 {
    ender_jsmath::js_round(x * 1e6) / 1e6
}

// replay.cjs 848: Math.floor(x * 1e6) / 1e6 — FLOOR, never round.
pub fn mkt_amt(x: f64) -> f64 {
    (x * 1e6).floor() / 1e6
}

// replay.cjs 849: (Math.round(x * 1e6) / 1e6).toString() — JS Number
// formatting (shortest round-trip decimal), never Rust `{}`.
pub fn fmt_amt(x: f64) -> String {
    ender_canonical::js_number_to_string(ender_jsmath::js_round(x * 1e6) / 1e6)
}

// replay.cjs 851: x < y ? x+'/'+y : y+'/'+x — JS string `<` is UTF-16 order.
pub fn pool_id(x: &str, y: &str) -> String {
    if utf16_cmp(x, y) == std::cmp::Ordering::Less {
        format!("{x}/{y}")
    } else {
        format!("{y}/{x}")
    }
}

/// replay.cjs 211-222 — confusable-fold skeleton. `prev` only updates on
/// KEPT chars ('ab-a' → 'aba', 'a-a' → 'a').
pub fn skel(hh: &str) -> String {
    let low = hh.to_lowercase();
    let mut out = String::new();
    let mut prev: Option<char> = None;
    for raw in low.chars() {
        let c = match raw {
            '0' => 'o',
            '1' | 'i' | 'l' => 'l',
            '5' => 's',
            '8' => 'b',
            '2' => 'z',
            other => other,
        };
        if !(c.is_ascii_lowercase() || c.is_ascii_digit()) || Some(c) == prev {
            continue;
        }
        out.push(c);
        prev = Some(c);
    }
    out
}

/// skel over a raw act field: JS `skel(hh)` receives the value and does
/// `String(hh || '')` internally.
pub fn skel_value(v: Option<&Value>) -> String {
    if truthy(v) {
        skel(&js_prop_key(v))
    } else {
        skel("")
    }
}

/// replay.cjs 894-899 bindableAddress — '' when unusable.
pub fn bindable_address(v: Option<&Value>) -> String {
    let s = match v {
        None | Some(Value::Null) => String::new(),
        other => js_prop_key(other),
    };
    let s = s.trim().to_lowercase();
    let ok = s.len() == 42
        && s.starts_with("0x")
        && s.as_bytes()[2..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b));
    if !ok || s == "0x0000000000000000000000000000000000000000" {
        return String::new();
    }
    s
}

fn raw_int_ok(s: &str) -> bool {
    // RAW_INT = /^[0-9]{1,48}$/ (replay.cjs 242)
    !s.is_empty() && s.len() <= 48 && s.bytes().all(|b| b.is_ascii_digit())
}

/// replay.cjs 282-295 peerBurnSats — BigInt pricing, floor division,
/// safe-integer gate. None = JS null.
pub fn peer_burn_sats(
    amt_raw: Option<&Value>,
    res_peer_raw: Option<&Value>,
    res_btc_raw: Option<&Value>,
) -> Option<f64> {
    let (a, rp, rb) = match (
        amt_raw.and_then(Value::as_str),
        res_peer_raw.and_then(Value::as_str),
        res_btc_raw.and_then(Value::as_str),
    ) {
        (Some(a), Some(rp), Some(rb)) => (a, rp, rb),
        _ => return None,
    };
    if !raw_int_ok(a) || !raw_int_ok(rp) || !raw_int_ok(rb) {
        return None;
    }
    let amt = BigUint::parse_bytes(a.as_bytes(), 10)?;
    let rp = BigUint::parse_bytes(rp.as_bytes(), 10)?;
    let rb = BigUint::parse_bytes(rb.as_bytes(), 10)?;
    let zero = BigUint::from(0u8);
    if amt <= zero || rp <= zero || rb <= zero {
        return None;
    }
    let n = (&amt * &rb) / (&rp + &amt);
    // Number.isSafeInteger gate: any value > 2^53-1 fails regardless of the
    // Number() rounding direction (replay-branches.md helper note).
    if n > BigUint::from((1u64 << 53) - 1) {
        return None;
    }
    Some(u64::try_from(&n).ok()? as f64)
}

/// replay.cjs 297-303 peerText — 18-decimal fixed point to display text.
pub fn peer_text(raw: &str) -> String {
    let mut s: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if s.is_empty() {
        s = "0".to_string();
    }
    while s.len() < 19 {
        s.insert(0, '0');
    }
    let split = s.len() - 18;
    let whole_raw = &s[..split];
    let trimmed = whole_raw.trim_start_matches('0');
    let whole = if trimmed.is_empty() { "0" } else { trimmed };
    let frac_full = &s[split..];
    let frac: String = frac_full.trim_end_matches('0').chars().take(6).collect();
    if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    }
}

/// replay.cjs 345-361 peerBurnGrid — hash-seeded bucket sampling; the
/// strictly-increasing filter can drop blocks (len ≤ n).
pub fn peer_burn_grid(starts_at: i64, ends_at: i64, ref_hash: &str, n: i64) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    let width = ends_at - starts_at;
    if width <= 0 || n <= 0 || n > 64 {
        return out;
    }
    let hex = ref_hash.strip_prefix("0x").unwrap_or(ref_hash).to_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return out;
    }
    for i in 0..n {
        // Math.floor((width * i) / n) — JS float math; exact under 2^53.
        let lo = starts_at + ((width as f64 * i as f64) / n as f64).floor() as i64;
        let mut hi = starts_at + ((width as f64 * (i + 1) as f64) / n as f64).floor() as i64;
        if hi <= lo {
            hi = lo + 1;
        }
        let at = ((i % 16) * 4) as usize;
        let r = u32::from_str_radix(&hex[at..at + 4], 16).unwrap() as i64;
        let b = lo + (r % (hi - lo));
        if out.last().map_or(true, |&last| b > last) {
            out.push(b);
        }
    }
    out
}

/// replay.cjs 24-36 parseMentions — max 3 distinct, first-come; slug
/// collisions resolve to the LAST-registered handle.
pub fn parse_mentions(text: &str, handles: &IndexMap<String, String>) -> Vec<String> {
    let mut slug_to_id: IndexMap<String, String> = IndexMap::new();
    for (id, h) in handles {
        let slug: String = h
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .collect();
        slug_to_id.insert(slug, id.clone());
    }
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && out.len() < 3 {
        if bytes[i] == b'@' {
            let mut j = i + 1;
            while j < bytes.len()
                && j - i - 1 < 16
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_')
            {
                j += 1;
            }
            if j > i + 1 {
                let slug: String = text[i + 1..j]
                    .to_ascii_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    .collect();
                if let Some(id2) = slug_to_id.get(&slug) {
                    if !out.contains(id2) {
                        out.push(id2.clone());
                    }
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// replay.cjs 82-95 compileCells — self cells FIRST, then bundles in
/// insertion order; clamp per component; mixed/negative bundles collapse to
/// a self-cell on the SOURCE.
pub fn compile_cells(bundles: &IndexMap<String, Bundle>, self_cells: &[FoldCell]) -> Vec<FoldCell> {
    let mut out: Vec<FoldCell> = self_cells.to_vec();
    for b in bundles.values() {
        let pd = js_max(-1.0, js_min(1.0, b.pd));
        let pi = js_max(-1.0, js_min(1.0, b.pi));
        if pd > 0.0 && pi > 0.0 {
            out.push(FoldCell { src: b.src.clone(), rcp: b.rcp.clone(), coeff: (pd * pi).sqrt() });
        } else {
            let c = (pd.abs() * pi.abs()).sqrt();
            if c > 0.0 {
                out.push(FoldCell { src: b.src.clone(), rcp: b.src.clone(), coeff: c });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Record types

/// The fold's ledger record (replay-state.md §2 `ledgers`). One record per
/// push; `ledger_by_id` maps id → index into `ledgers` (JS shares the
/// record itself). `deleted` is the register-payloadGone flag — NOT copied
/// into epoch snapshots.
#[derive(Debug, Clone)]
pub struct Ledger {
    pub id: String,
    pub burn_bal: f64,
    pub act_count: u64,
    pub deleted: bool,
}

/// Vouch bundle (replay-state.md `bundles`).
#[derive(Debug, Clone)]
pub struct Bundle {
    pub src: String,
    pub rcp: String,
    pub pd: f64,
    pub pi: f64,
}

/// `who` on a chron entry: absent key ≠ null key ≠ id (byte parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhoField {
    /// No `who` key at all (settle/mint lines).
    Absent,
    /// `who: null` (deferEpoch entry, resetTokens with no id).
    Null,
    Id(String),
}

/// The deferEpoch chron line is a lazy getter over the settled certificate;
/// everything else is plain text.
#[derive(Debug, Clone)]
pub enum ChronLine {
    Text(String),
    /// 'epoch N closed · stamp X.XXX · certificate accepted|wall/door
    /// failed' — rendered from epoch_history[record] on demand (forces
    /// settle, exactly like the JS enumerable getter).
    EpochClose { epoch: f64, record: usize },
}

#[derive(Debug, Clone)]
pub struct ChronRef {
    pub label: String,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct ChronEntry {
    pub who: WhoField,
    pub line: ChronLine,
    pub to: Option<String>,
    pub refs: Option<Vec<ChronRef>>,
}

/// The gate numbers a settled certificate exposes.
#[derive(Debug, Clone)]
pub struct SettledGates {
    pub stamp: f64,
    pub headroom: f64,
    pub pass: bool,
}

/// deferEpoch record (replay.cjs 50-80; replay-state.md §3): `{ epoch,
/// acts }` plus three lazy getters (stamp, headroom, pass) memoizing ONE
/// solve+gate over the close-time snapshots. Serialization property order:
/// epoch, acts, stamp, headroom, pass.
#[derive(Debug)]
pub struct EpochRecord {
    /// The closeEpoch act's OWN `epoch` field (not certsSoFar).
    pub epoch: f64,
    /// Sum of deltaActs at close.
    pub acts: u64,
    /// Value copies of {id, burnBal, actCount} at close (`deleted` not copied).
    pub snap_ledgers: Vec<EngineLedger>,
    /// compileCells output at close time — fresh objects.
    pub cells: Vec<FoldCell>,
    /// deltaActs snapshot, insertion order.
    pub snap_dmap: IndexMap<String, u64>,
    settled: OnceCell<SettledGates>,
}

impl EpochRecord {
    pub fn new(
        epoch: f64,
        acts: u64,
        snap_ledgers: Vec<EngineLedger>,
        cells: Vec<FoldCell>,
        snap_dmap: IndexMap<String, u64>,
    ) -> Self {
        EpochRecord { epoch, acts, snap_ledgers, cells, snap_dmap, settled: OnceCell::new() }
    }

    /// The memoized settle: solveStanding({tilt:1}) then evaluateGates.
    pub fn settle(&self) -> &SettledGates {
        self.settled.get_or_init(|| {
            let sv = solve_standing(&self.snap_ledgers, &self.cells, &SolveOpts::default());
            let g = evaluate_gates(&self.snap_ledgers, &sv.x, &self.snap_dmap);
            SettledGates { stamp: g.epoch_stamp, headroom: g.headroom, pass: g.all_pass }
        })
    }

    pub fn stamp(&self) -> f64 {
        self.settle().stamp
    }

    pub fn headroom(&self) -> f64 {
        self.settle().headroom
    }

    pub fn pass(&self) -> bool {
        self.settle().pass
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReviewMeta {
    pub e: f64,
    pub f: f64,
}

#[derive(Debug, Clone)]
pub struct CallInfo {
    /// `a.outcome` verbatim (None = the field was absent).
    pub outcome: Option<Value>,
    /// `a.dur || 0`.
    pub dur: f64,
}

#[derive(Debug, Clone)]
pub struct Dm {
    pub from: String,
    pub to: String,
    /// '' for calls.
    pub text: String,
    pub call: Option<CallInfo>,
    pub idx: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostFlag {
    Stream,
    Event,
    Comment,
    Market,
}

#[derive(Debug, Clone)]
pub struct PostMeta {
    pub idx: u64,
    /// `a.ts` verbatim (None = absent).
    pub ts: Option<Value>,
    pub edited: bool,
    /// stream:true | event:true | comment:true | market:true — None for a
    /// plain post.
    pub flag: Option<PostFlag>,
}

#[derive(Debug, Clone)]
pub struct EventRec {
    pub host: String,
    pub at: f64,
    /// ≤120 chars, '' when redacted.
    pub place: String,
    /// round6'd, 0 if not > 0.
    pub fee: f64,
    /// '' if free.
    pub cur: String,
    /// Math.floor, 0 if not > 0.
    pub cap: u64,
    pub idx: u64,
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub bio: String,
    pub link: String,
    pub pic: String,
    pub idx: u64,
}

#[derive(Debug, Clone)]
pub struct Binder {
    pub n: u32,
    pub id: Option<String>,
    pub ts: Option<f64>,
    /// id → first-bind ts (null when the act carried no finite ts).
    pub seen: IndexMap<String, Option<f64>>,
}

#[derive(Debug, Clone)]
pub struct TokenMeta {
    pub name: String,
    pub creator: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Pool {
    pub a: String,
    pub b: String,
    pub res_a: f64,
    pub res_b: f64,
    pub total_shares: f64,
    /// actor → shares, plus the '_locked' key.
    pub shares: IndexMap<String, f64>,
    pub swaps: u64,
    pub vol_a: f64,
    pub vol_b: f64,
}

#[derive(Debug, Clone)]
pub struct WhyDetail {
    pub actor: String,
    pub kind: &'static str,
    pub cid: String,
    pub base: f64,
    pub damp: f64,
    pub lambda: f64,
    pub nth: u64,
    pub weight: f64,
}

#[derive(Debug, Clone)]
pub struct TokenDist {
    pub epoch: u64,
    pub minted: f64,
    pub carried: f64,
    pub to: IndexMap<String, f64>,
    pub pool: f64,
    pub emission: f64,
    pub total_weight: f64,
    pub weights: IndexMap<String, f64>,
    pub why: IndexMap<String, Vec<WhyDetail>>,
    /// Some("no eligible engagement") on the non-paying branch.
    pub note: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub struct AdAim {
    pub placement: Vec<Value>,
    pub tags: Vec<Value>,
    pub people: Vec<Value>,
    pub posts: Vec<Value>,
    pub regions: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct Advert {
    pub id: String,
    pub by: String,
    pub text: String,
    pub url: String,
    pub days: u64,
    pub paid: f64,
    pub at: f64,
    pub until: f64,
    pub aim: AdAim,
    pub stopped: bool,
}

#[derive(Debug, Clone)]
pub struct Engage {
    pub actor: String,
    pub creator: String,
    /// 1.0 | 0.3 | 1.2
    pub base: f64,
    pub cid: String,
    /// 'reaction' | 'dislike' | 'comment'
    pub kind: &'static str,
}

#[derive(Debug, Clone)]
pub struct Ballot {
    pub for_: Vec<String>,
    /// Frozen at cast time from burnedSats.
    pub wt: f64,
}

/// Market record (replay-state.md §2 `markets`). Reassignment of
/// votes[author] keeps the FIRST insertion position (IndexMap::insert
/// matches).
#[derive(Debug, Clone)]
pub struct Market {
    pub cid: String,
    pub by: String,
    pub cur: String,
    /// Option count — structure, survives redaction.
    pub n: usize,
    /// Labels '' when redacted.
    pub opts: Vec<String>,
    pub at: f64,
    /// The closing time as first stated. `at` moves on an early close; this
    /// never does, and the host measures the jury window from the later of
    /// the two. Not read by any epoch package.
    pub stated_at: f64,
    pub seats: u64,
    /// round6'd.
    pub bond: f64,
    /// Math.floor(a.feeBp), validated 0..=500.
    pub fee_bp: u64,
    /// Filtered, max 8.
    pub nominees: Vec<String>,
    /// One map per option.
    pub stakes: Vec<IndexMap<String, f64>>,
    pub totals: Vec<f64>,
    pub pool: f64,
    pub by_bettor: IndexMap<String, f64>,
    /// candidate → bond posted.
    pub cands: IndexMap<String, f64>,
    pub votes: IndexMap<String, Ballot>,
    /// May hold -1 (void).
    pub attests: IndexMap<String, i64>,
    /// 'open' | 'resolved' | 'void'
    pub state: String,
    /// -1 initial / void.
    pub outcome: i64,
    pub paid: IndexMap<String, f64>,
    pub refunded: IndexMap<String, f64>,
    pub struck: IndexMap<String, f64>,
    pub earned: IndexMap<String, f64>,
    pub jury: Vec<String>,
    pub honest: Vec<String>,
    pub guilty: Vec<String>,
    pub fee_paid: f64,
    pub slashed_total: f64,
    pub idx: u64,
    /// True once the author closed betting early (replay.cjs marketClose):
    /// `at` then holds the stamp of that act. Display state; nothing in
    /// settlement reads it.
    pub closed_early: bool,
}

// ---------------------------------------------------------------------------
// State

/// Every state variable of replayUncached, plus the finalization outputs
/// the return object (§6) derives (solved, xById, dispHandles,
/// peerBurnUsedReserve, epochNow). The exported closures (tokenActError,
/// marketActError, peerBurnActError, mktSeats) live as functions in the
/// acts_* modules borrowing this struct.
#[derive(Debug, Default)]
pub struct State {
    // Graph & ledgers (replay.cjs 119-120)
    pub g: RawGraph,
    /// Registration/seed push order — the solve input order.
    pub ledgers: Vec<Ledger>,
    /// id → index into `ledgers`. Iteration order (insertion) decides the
    /// final self-edge append order — graph-material.
    pub ledger_by_id: IndexMap<String, usize>,
    /// id → REAL handle (even for twins/deleted).
    pub handles: IndexMap<String, String>,
    /// id → registration epoch.
    pub k_reg: IndexMap<String, f64>,
    /// contentId → author, payload-guarded.
    pub creators: IndexMap<String, String>,
    /// contentId → text; deleted on post-update-delete.
    pub payloads: IndexMap<String, String>,

    // Vouch compilation (121)
    /// key `author>target`.
    pub bundles: IndexMap<String, Bundle>,
    /// Cells appear BEFORE bundle cells in the compiled list.
    pub self_cells: Vec<FoldCell>,

    // Epoch machinery (121, 134)
    /// id → act count since the last close; reset (reassigned) at closeEpoch.
    pub delta_acts: IndexMap<String, u64>,
    pub epoch_history: Vec<EpochRecord>,
    pub chron: Vec<ChronEntry>,
    pub certs_so_far: u64,

    // Deletion pre-scan (151-162)
    pub deleted_actors: IndexMap<String, bool>,
    /// Act index → true (numeric keys; never iterated).
    pub deleted_post_idx: BTreeMap<u64, bool>,
    /// skeleton → first registrant id (pre-scan only).
    pub seen_skel: IndexMap<String, String>,
    /// id → true for later namesakes.
    pub handle_twin: IndexMap<String, bool>,

    // Content bookkeeping (128-133, 165-167)
    /// contentId → author, UNCONDITIONAL at mint (survives deletion).
    pub content_author: IndexMap<String, String>,
    pub review_meta: IndexMap<String, ReviewMeta>,
    /// contentId → the act's `media` array, opaque.
    pub media_meta: IndexMap<String, Value>,
    pub dms: Vec<Dm>,
    pub pin_hash: IndexMap<String, String>,
    pub counter: u64,
    /// contentId → true; read only by the editPost guard.
    pub muted_content: IndexMap<String, bool>,
    /// act index → contentId (mints only; ascending numeric key order).
    pub act_content: BTreeMap<u64, String>,
    pub post_meta: IndexMap<String, PostMeta>,

    // Events (175-181)
    /// `id@epoch` → count. Never written (faucet retired) — kept for fidelity.
    pub faucet_count: IndexMap<String, u64>,
    pub events: IndexMap<String, EventRec>,
    pub event_invites: IndexMap<String, IndexMap<String, bool>>,
    pub event_going: IndexMap<String, IndexMap<String, bool>>,
    /// `actor>creator` → true; reset (reassigned) at closeEpoch.
    pub paid_to: IndexMap<String, bool>,

    // Social / profile (185-187)
    pub follows: IndexMap<String, IndexMap<String, bool>>,
    pub followers: IndexMap<String, IndexMap<String, bool>>,
    pub profiles: IndexMap<String, Profile>,

    // (l0 AttestationLedger deliberately omitted — see module doc.)

    // PEER-burn door (777-806)
    /// lowercase Base tx → claiming id.
    pub peer_burn_tx_by: IndexMap<String, String>,
    /// lowercase tx → satoshis credited so far.
    pub peer_burn_tx_sats: IndexMap<String, u64>,
    /// `id@epoch` → sats converted this epoch.
    pub peer_burn_epoch_use: IndexMap<String, u64>,
    /// `factoryLower#pool@epoch` → sats.
    pub peer_burn_pool_use: IndexMap<String, u64>,
    /// id → raw PEER destroyed all-time, DECIMAL STRING (BigInt addition).
    pub peer_burned_raw: IndexMap<String, String>,
    /// lowercase address → binder record.
    pub addr_binders: IndexMap<String, Binder>,

    // Token economy (810-869)
    /// sym → actor → amount.
    pub token_bal: IndexMap<String, IndexMap<String, f64>>,
    pub token_meta: IndexMap<String, TokenMeta>,
    pub token_supply: IndexMap<String, f64>,
    /// Unreachable writer (btcClaim always refused) — kept for fidelity.
    pub btc_claimed: IndexMap<String, bool>,
    /// 'A/B' (alphabetical via pool_id) → pool.
    pub pools: IndexMap<String, Pool>,
    pub token_dist: Vec<TokenDist>,
    pub adverts: Vec<Advert>,
    pub ad_seq: u64,
    /// Declared, never written, never read. Dead — kept for fidelity.
    pub earned_burn: IndexMap<String, f64>,
    /// id → satoshis destroyed on Bitcoin. NOT returned; feeds mint weight
    /// and jury-vote weight.
    pub burned_sats: IndexMap<String, f64>,
    /// lowercase txid → id (dedupe).
    pub burned_tx: IndexMap<String, String>,
    pub token_epoch0: u64,
    pub token_carry: f64,
    pub tok_epoch_n: u64,
    /// Consumed + cleared at closeEpoch.
    pub epoch_engage: Vec<Engage>,

    // Address bindings (886-887)
    /// id → lowercase Base address, newest wins.
    pub addr_of: IndexMap<String, String>,
    /// epoch number (tokEpochN) → frozen copy of addr_of.
    pub addr_at_epoch: BTreeMap<u64, IndexMap<String, String>>,

    // Markets (941)
    pub markets: IndexMap<String, Market>,

    // Edge/act correlation (1429)
    /// append-index → act index; holds -1; SHORTER than g.edges at return
    /// (final self-edges are appended after the last fill) — on purpose.
    pub edge_act: Vec<i64>,

    // ---- Finalization outputs (replay.cjs 2498-2536, return §6) ----
    /// compileCells at return time — the SAME array passed to the final solve.
    pub cells_final: Vec<FoldCell>,
    /// Final solveStanding(ledgers, cells, {tilt:1}).
    pub solved: Option<SolveResult>,
    /// solved.ids[i] → solved.x[i], in solved.ids order.
    pub x_by_id: IndexMap<String, f64>,
    /// handles order; '[deleted]' for deleted actors.
    pub disp_handles: IndexMap<String, String>,
    /// epochHistory.length + 1.
    pub epoch_now: u64,
    /// peerBurnEpochUse key → sats / SATS_PER_RESERVE.
    pub peer_burn_used_reserve: IndexMap<String, f64>,
}

impl State {
    /// Fresh fold state — replay.cjs 118-190 initializers (tokenMeta and
    /// tokenSupply are pre-seeded with PEER and tBTC, in that order).
    pub fn new() -> Self {
        let mut st = State::default();
        st.token_meta.insert(
            "PEER".to_string(),
            TokenMeta { name: "Peer epoch token".to_string(), creator: None },
        );
        st.token_meta.insert(
            "tBTC".to_string(),
            TokenMeta {
                name: "retired — never real bitcoin, no supply, nothing mints it".to_string(),
                creator: None,
            },
        );
        st.token_supply.insert("PEER".to_string(), 0.0);
        st.token_supply.insert("tBTC".to_string(), 0.0);
        st
    }

    // replay.cjs 853: known(id) = !!ledgerById[id]
    pub fn known(&self, id: &str) -> bool {
        self.ledger_by_id.contains_key(id)
    }

    /// payloadGone lookup arm: `deletedActors[a.author]` etc — keyed by the
    /// JS property-key coercion of the raw field (undefined → "undefined").
    pub fn actor_deleted(&self, v: Option<&Value>) -> bool {
        self.deleted_actors.get(&js_prop_key(v)).copied().unwrap_or(false)
    }

    // replay.cjs 854-858: debit — burnBal -= THETA, actCount += 1,
    // deltaActs[id]++. Silently nothing for unknown ids.
    pub fn debit(&mut self, id: &str) {
        let Some(&ix) = self.ledger_by_id.get(id) else {
            return;
        };
        let l = &mut self.ledgers[ix];
        l.burn_bal -= THETA;
        l.act_count += 1;
        *self.delta_acts.entry(id.to_string()).or_insert(0) += 1;
    }

    // replay.cjs 850: balOf — `(tokenBal[sym] && tokenBal[sym][id]) || 0`;
    // note the JS `|| 0` collapses a stored -0 (and NaN) to +0.
    pub fn bal_of(&self, sym: &str, id: &str) -> f64 {
        match self.token_bal.get(sym).and_then(|m| m.get(id)).copied() {
            Some(x) if x != 0.0 && !x.is_nan() => x,
            _ => 0.0,
        }
    }

    // replay.cjs 873-877: tokCredit — refuses !(amt > 0).
    pub fn tok_credit(&mut self, sym: &str, id: &str, amt: f64) {
        if !(amt > 0.0) {
            return;
        }
        let m = self.token_bal.entry(sym.to_string()).or_default();
        let e = m.entry(id.to_string()).or_insert(0.0);
        *e += amt;
    }

    // replay.cjs 878-882: tokDebit — refuses !(amt > 0) (negative-debit
    // mint vector).
    pub fn tok_debit(&mut self, sym: &str, id: &str, amt: f64) {
        if !(amt > 0.0) {
            return;
        }
        let m = self.token_bal.entry(sym.to_string()).or_default();
        let e = m.entry(id.to_string()).or_insert(0.0);
        *e -= amt;
    }

    // replay.cjs 864-867: weighHome — c = sqrt(|pd|·|pi|), push a self cell
    // at min(1, c) when c > 0.
    pub fn weigh_home(&mut self, author: &str, pd: f64, pi: f64) {
        let c = (pd.abs() * pi.abs()).sqrt();
        if c > 0.0 {
            self.self_cells.push(FoldCell {
                src: author.to_string(),
                rcp: author.to_string(),
                coeff: js_min(1.0, c),
            });
        }
    }

    // replay.cjs 859-863: vouch — bundle accumulate on `author>target`.
    pub fn vouch(&mut self, author: &str, target: &str, p: f64, r: f64) {
        let key = format!("{author}>{target}");
        let b = self.bundles.entry(key).or_insert_with(|| Bundle {
            src: author.to_string(),
            rcp: target.to_string(),
            pd: 0.0,
            pi: 0.0,
        });
        b.pd += p;
        b.pi += r;
    }

    // replay.cjs 868-872: typeNode — derived id, lazily minted Type node
    // (node insert happens before the caller's hyper edges).
    pub fn type_node(&mut self, name: &str) -> String {
        let id = format!(
            "type_{}",
            name.to_lowercase()
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                .collect::<String>()
        );
        if !self.g.nodes.contains_key(&id) {
            self.g.add_node(NodeInfo {
                id: id.clone(),
                kind: NodeKind::Type,
                label: format!("#{name}"),
            });
        }
        id
    }

    // replay.cjs 852: countGoing = Object.keys(eventGoing[cid] || {}).length
    pub fn count_going(&self, cid: &str) -> usize {
        self.event_going.get(cid).map(|m| m.len()).unwrap_or(0)
    }

    // replay.cjs 223-229: dispName.
    pub fn disp_name(&self, id: &str) -> String {
        if self.deleted_actors.get(id).copied().unwrap_or(false) {
            return "[deleted]".to_string();
        }
        let hh = self.handles.get(id).map(String::as_str).unwrap_or(id);
        if self.handle_twin.get(id).copied().unwrap_or(false) {
            format!("{hh} ({id}, not the original)")
        } else {
            hh.to_string()
        }
    }

    // replay.cjs 197-203: addActor — Actor + Profile nodes, ledger push,
    // index, handle, kReg. `lab = label || handle` (falsy label → handle).
    pub fn add_actor(
        &mut self,
        id: &str,
        handle: &str,
        burn: f64,
        count: u64,
        epoch: f64,
        label: Option<&str>,
    ) {
        let lab = match label {
            Some(l) if !l.is_empty() => l,
            _ => handle,
        };
        self.g.add_node(NodeInfo {
            id: id.to_string(),
            kind: NodeKind::Actor,
            label: lab.to_string(),
        });
        self.g.add_node(NodeInfo {
            id: format!("prof_{id}"),
            kind: NodeKind::Profile,
            label: lab.to_string(),
        });
        self.ledgers.push(Ledger {
            id: id.to_string(),
            burn_bal: burn,
            act_count: count,
            deleted: false,
        });
        // Duplicate register: JS overwrites ledgerById (new record) while
        // both records stay in `ledgers`; IndexMap::insert keeps the
        // original key position.
        self.ledger_by_id.insert(id.to_string(), self.ledgers.len() - 1);
        self.handles.insert(id.to_string(), handle.to_string());
        self.k_reg.insert(id.to_string(), epoch);
    }

    /// EXACT mirror of backend/parity/gen-trace-vectors.mjs projection():
    /// sha256(canonical({ledgers, supply, bal, carry, epochN, epochs,
    /// pools, counterEdges})). Cheap — never settles a certificate.
    pub fn trace_digest(&self) -> String {
        fn vnum(x: f64) -> Value {
            Value::Number(Number::from_f64(x).expect("non-finite number in trace projection"))
        }
        let mut root = Map::new();

        let mut larr = Vec::with_capacity(self.ledgers.len());
        for l in &self.ledgers {
            let mut m = Map::new();
            m.insert("id".to_string(), Value::String(l.id.clone()));
            m.insert("burnBal".to_string(), vnum(l.burn_bal));
            m.insert("actCount".to_string(), Value::from(l.act_count));
            larr.push(Value::Object(m));
        }
        root.insert("ledgers".to_string(), Value::Array(larr));

        let mut supply = Map::new();
        for (k, v) in &self.token_supply {
            supply.insert(k.clone(), vnum(*v));
        }
        root.insert("supply".to_string(), Value::Object(supply));

        let mut bal = Map::new();
        for (sym, inner) in &self.token_bal {
            let mut im = Map::new();
            for (id, v) in inner {
                im.insert(id.clone(), vnum(*v));
            }
            bal.insert(sym.clone(), Value::Object(im));
        }
        root.insert("bal".to_string(), Value::Object(bal));

        root.insert("carry".to_string(), vnum(self.token_carry));
        root.insert("epochN".to_string(), Value::from(self.tok_epoch_n));
        root.insert("epochs".to_string(), Value::from(self.epoch_history.len() as u64));

        let mut pools = Map::new();
        for (pid, p) in &self.pools {
            let mut pm = Map::new();
            pm.insert("resA".to_string(), vnum(p.res_a));
            pm.insert("resB".to_string(), vnum(p.res_b));
            pm.insert("totalShares".to_string(), vnum(p.total_shares));
            pm.insert("swaps".to_string(), Value::from(p.swaps));
            pools.insert(pid.clone(), Value::Object(pm));
        }
        root.insert("pools".to_string(), Value::Object(pools));

        root.insert("counterEdges".to_string(), Value::from(self.g.edges.len() as u64));

        let v = Value::Object(root);
        ender_canonical::sha256hex(
            ender_canonical::canonical(&v).expect("trace projection must be finite"),
        )
    }
}

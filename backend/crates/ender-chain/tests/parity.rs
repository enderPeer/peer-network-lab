//! Cross-language parity for the act-commitment layer. Vectors come from the
//! REAL engine bundle + replay.cjs parseMentions and the live act log, via
//! backend/parity/gen-vectors.mjs.

use ender_chain::{act_commitments, parse_mentions, verify_chain, verify_chain_structure, Handles};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Vectors {
    mentions: Vec<MentionVec>,
    commitments: CommitmentVec,
    #[serde(rename = "chainVerify")]
    chain_verify: Option<ChainVerifyVec>,
}

#[derive(Deserialize)]
struct ChainVerifyVec {
    editions: EditionsVec,
    live: CorpusVerifyVec,
    genesis0: CorpusVerifyVec,
}

#[derive(Deserialize)]
struct EditionsVec {
    engine: String,
    replay: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusVerifyVec {
    act_lines: Vec<String>,
    block_lines: Vec<String>,
    ok: bool,
    height: usize,
    tombstoned: u64,
    warnings: usize,
    blocks: Vec<ChainVerifyBlock>,
}

#[derive(Deserialize)]
struct ChainVerifyBlock {
    height: u64,
    epoch: i64,
    ok: bool,
    tombstoned: u64,
    hash: String,
    notes: usize,
}

#[derive(Deserialize)]
struct MentionVec {
    text: String,
    handles: Vec<(String, String)>,
    out: Vec<String>,
}

#[derive(Deserialize)]
struct CommitmentVec {
    acts: Vec<String>,
    structural: Vec<String>,
    payload: Vec<String>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors.json")).expect("vectors.json parses")
}

#[test]
fn mention_battery() {
    for (i, m) in vectors().mentions.iter().enumerate() {
        let handles = Handles::from_pairs(m.handles.clone());
        assert_eq!(
            parse_mentions(&m.text, &handles),
            m.out,
            "mention resolution diverges on vector {i}: {:?}",
            m.text
        );
    }
}

#[test]
fn real_act_log_commitments() {
    let v = vectors();
    assert!(!v.commitments.acts.is_empty(), "commitment vectors present");
    let file_acts: Vec<Value> = v
        .commitments
        .acts
        .iter()
        .map(|l| serde_json::from_str(l).expect("act line parses"))
        .collect();
    let got = act_commitments(&file_acts).expect("commitments compute");
    assert_eq!(got.structural, v.commitments.structural, "structural hash sequence diverges");
    assert_eq!(got.payload, v.commitments.payload, "payload hash sequence diverges");
}

fn corpus_inputs(c: &CorpusVerifyVec) -> (Vec<Value>, Vec<Value>) {
    let acts = c.act_lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
    let blocks = c.block_lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
    (acts, blocks)
}

fn chain_inputs(v: &Vectors) -> (Vec<Value>, Vec<Value>) {
    corpus_inputs(&v.chain_verify.as_ref().expect("chainVerify vectors present").live)
}

fn assert_report_matches(report: &ender_chain::VerifyReport, want: &CorpusVerifyVec, label: &str) {
    assert_eq!(report.ok, want.ok, "{label}: verdict diverges: {:?}", report.errors);
    assert_eq!(report.height, want.height, "{label}: height");
    assert_eq!(report.tombstoned, want.tombstoned, "{label}: tombstoned");
    assert_eq!(report.warnings.len(), want.warnings, "{label}: warning count: {:?}", report.warnings);
    assert_eq!(report.blocks.len(), want.blocks.len(), "{label}: block count");
    for (got, w) in report.blocks.iter().zip(&want.blocks) {
        assert_eq!(got.height, w.height, "{label}: block height");
        assert_eq!(got.epoch, w.epoch, "{label}: block {} epoch", w.height);
        assert_eq!(got.ok, w.ok, "{label}: block {} ok: {:?}", w.height, got.notes);
        assert_eq!(got.tombstoned, w.tombstoned, "{label}: block {} tombstoned", w.height);
        assert_eq!(got.notes.len(), w.notes, "{label}: block {} note count: {:?}", w.height, got.notes);
        assert_eq!(got.hash, w.hash, "{label}: block {} hash", w.height);
    }
}

#[test]
fn real_chain_verifies_structurally() {
    let v = vectors();
    let cv = v.chain_verify.as_ref().expect("chainVerify vectors present");
    assert!(cv.live.ok, "generator's full verifyChain passed on the live chain");
    let (acts, blocks) = chain_inputs(&v);
    let report = verify_chain_structure(&acts, &blocks, None).expect("verifier runs");
    assert!(report.ok, "structural verification passes: {:?}", report.errors);
    assert_eq!(report.height, cv.live.height);
    assert_eq!(report.tombstoned, cv.live.tombstoned);
}

#[test]
fn full_verify_live_chain() {
    // The complete verifyChain, replay included: the live chain must verify
    // on the strict path — zero warnings, every package replays.
    let v = vectors();
    let cv = v.chain_verify.as_ref().expect("chainVerify vectors present");
    let (acts, blocks) = corpus_inputs(&cv.live);
    let report = verify_chain(
        &acts,
        &blocks,
        None,
        Some((&cv.editions.engine, &cv.editions.replay)),
    )
    .expect("verifier runs");
    assert_report_matches(&report, &cv.live, "live");
}

#[test]
fn full_verify_genesis0_chain_with_drift_attribution() {
    // genesis-0 blocks were sealed under older formula editions: the JS
    // verifier reports ok with one drift warning per block. The Rust
    // verifier must land on the identical verdict — including that its own
    // replayed packages DIFFER from the sealed ones in exactly the same way.
    let v = vectors();
    let cv = v.chain_verify.as_ref().expect("chainVerify vectors present");
    let (acts, blocks) = corpus_inputs(&cv.genesis0);
    let report = verify_chain(
        &acts,
        &blocks,
        None,
        Some((&cv.editions.engine, &cv.editions.replay)),
    )
    .expect("verifier runs");
    assert_report_matches(&report, &cv.genesis0, "genesis0");
}

#[test]
fn tampered_act_is_detected() {
    let v = vectors();
    let (mut acts, blocks) = chain_inputs(&v);
    // A structural field of an act inside block 1's sealed range.
    acts[0]
        .as_object_mut()
        .unwrap()
        .insert("t".to_string(), Value::String("forged".to_string()));
    let report = verify_chain_structure(&acts, &blocks, None).expect("verifier runs");
    assert!(!report.ok, "rewritten act must fail verification");
    assert!(
        report.errors.iter().any(|e| e.contains("structural hash mismatch")),
        "failure names the structural mismatch: {:?}",
        report.errors
    );
}

#[test]
fn tampered_signature_is_detected() {
    let v = vectors();
    let (acts, mut blocks) = chain_inputs(&v);
    let last = blocks.len() - 1;
    let sig = blocks[last]["sig"].as_str().unwrap().to_string();
    let flipped = if sig.starts_with('A') { format!("B{}", &sig[1..]) } else { format!("A{}", &sig[1..]) };
    blocks[last].as_object_mut().unwrap().insert("sig".to_string(), Value::String(flipped));
    let report = verify_chain_structure(&acts, &blocks, None).expect("verifier runs");
    assert!(!report.ok, "forged signature must fail verification");
    assert!(
        report.errors.iter().any(|e| e.contains("signature does not verify")),
        "failure names the signature: {:?}",
        report.errors
    );
}

#[test]
fn broken_link_is_detected() {
    let v = vectors();
    let (acts, mut blocks) = chain_inputs(&v);
    if blocks.len() < 2 {
        return; // needs at least two blocks to break a link
    }
    blocks[1]
        .as_object_mut()
        .unwrap()
        .insert("prev".to_string(), Value::String("00".repeat(32)));
    let report = verify_chain_structure(&acts, &blocks, None).expect("verifier runs");
    assert!(!report.ok, "broken hash link must fail verification");
    assert!(
        report.errors.iter().any(|e| e.contains("hash link") || e.contains("signature")),
        "failure names the link (and the edited block can no longer verify its signature): {:?}",
        report.errors
    );
}

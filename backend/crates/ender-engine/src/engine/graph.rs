//! RawGraph — webapp/src/engine/graph.ts (port map: engine-api.md §5,
//! engine-internals.md §5). Only the members replay.cjs touches carry
//! semantics here: addNode, append, appendHyper, nodes reads, edges reads.
//! degree() is the τ input; buildRecord internals (families/tensor pipeline)
//! are the implementer's work behind `append`.

use ender_jsmath::{js_exp, js_log, js_tanh};
use indexmap::IndexMap;

use super::{beta, ETA};

/// tensor.ts `Mask` — (a00, a01, a10, a11).
pub type Mask = [f64; 4];
/// 3×3 row-major sentiment slice.
pub type Mat3 = [[f64; 3]; 3];
/// 2×2 row-major path view.
pub type Mat2 = [[f64; 2]; 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Tribal,
    Identity,
    Epistemic,
    Economic,
    Relational,
    Minimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Full,
    Half,
    Marginal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Actor,
    Profile,
    Content,
    Comment,
    Type,
    Item,
    Chat,
    Offer,
    Message,
}

#[derive(Debug, Clone)]
pub struct NodeInfo {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
}

/// graph.ts `EdgeInput`. A missing JS field is `None`; note `tauOverride`
/// uses `??` in the source, so `Some(0.0)` IS honored as an override.
#[derive(Debug, Clone, Default)]
pub struct EdgeInput {
    pub id: String,
    pub family: String,
    pub src: String,
    pub tgt: String,
    pub pd: f64,
    pub pi: f64,
    pub domain: Option<Domain>,
    pub tier: Option<Tier>,
    pub tau_override: Option<f64>,
    pub epoch: Option<f64>,
}

/// graph.ts `EdgeRecord` — every field, including the ones only the wider
/// engine reads; the fold reads tau/weight (opinion chron), plus edges.len().
#[derive(Debug, Clone)]
pub struct EdgeRecord {
    pub id: String,
    pub family: String,
    pub src: String,
    pub tgt: String,
    pub pd: f64,
    pub pi: f64,
    pub domain: Domain,
    pub mask: Mask,
    pub tier: Tier,
    pub tau: f64,
    /// `input.epoch ?? 0` (JS number).
    pub epoch: f64,
    pub slice: Mat3,
    pub pv: Mat2,
    pub frob: f64,
    pub score: f64,
    /// 1.0 or -1.0 (detSign, or forced +1 for signForced families).
    pub sign: f64,
    pub weight: f64,
    /// Position in `edges` (pre-push length at build time).
    pub append_index: usize,
}

// ---------------------------------------------------------------------------
// kernels.ts — private copies (graph.rs is the only engine module that needs
// the sentiment kernels; standing.rs carries its own Q-side kernels).

// kernels.ts 3-5
fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + js_exp(-x))
}

// kernels.ts 11-13
fn fpl(x: f64) -> f64 {
    sigmoid(beta() * x)
}

// kernels.ts 16-18
fn fpm(x: f64) -> f64 {
    sigmoid(beta() * x.abs()) * js_tanh(x)
}

// kernels.ts 21-24
fn binary_entropy(t: f64) -> f64 {
    if t <= 0.0 || t >= 1.0 {
        return 0.0;
    }
    (-t * js_log(t)) - ((1.0 - t) * js_log(1.0 - t))
}

// kernels.ts 27-29 — argument is (-BETA) * H(tau).
fn boltzmann(tau: f64) -> f64 {
    js_exp(-beta() * binary_entropy(tau))
}

// kernels.ts 32-34
fn coherence(tau: f64) -> f64 {
    (1.0 + tau * tau).sqrt()
}

// ---------------------------------------------------------------------------
// tensor.ts — masks and the slice/path pipeline.

// tensor.ts 15-22 DOMAIN_MASKS
fn domain_mask(domain: Domain) -> Mask {
    match domain {
        Domain::Tribal => [1.0, 1.0, 1.0, 1.0],
        Domain::Identity => [1.0, 0.0, 0.0, 1.0],
        Domain::Epistemic => [0.0, 1.0, 0.0, 1.0],
        Domain::Economic => [0.0, 0.0, 1.0, 1.0],
        Domain::Relational => [0.0, 0.0, 1.0, 1.0],
        Domain::Minimal => [0.0, 0.0, 0.0, 1.0],
    }
}

// tensor.ts 34-43
fn sentiment_slice(pd: f64, pi: f64, mask: Mask) -> Mat3 {
    let [a00, a01, a10, a11] = mask;
    let apd = pd.abs();
    let api = pi.abs();
    [
        [a00 * fpm(pi * pd), a01 * fpm(pi * apd), fpm(pi)],
        [a10 * fpm(api * pd), a11 * fpl(api * apd), fpl(api)],
        [fpm(pd), fpl(apd), fpl(1.0)],
    ]
}

// tensor.ts 45-49 — row-major accumulation, sum then one sqrt.
fn frobenius(m: &Mat3) -> f64 {
    let mut s = 0.0;
    for row in m {
        for v in row {
            s += v * v;
        }
    }
    s.sqrt()
}

// tensor.ts 56-75 — half tier ignores the mask ([√η, √η, √η, 1]).
fn path_view(pd: f64, pi: f64, mask: Mask, tier: Tier) -> Mat2 {
    let s: [f64; 4] = if tier == Tier::Half {
        // constants.ts 11: HALF_FLOOR = Math.sqrt(ETA) — IEEE exact-rounded.
        let half_floor = ETA.sqrt();
        [half_floor, half_floor, half_floor, 1.0]
    } else {
        let [a00, a01, a10, a11] = mask;
        [
            a00 + (1.0 - a00) * ETA,
            a01 + (1.0 - a01) * ETA,
            a10 + (1.0 - a10) * ETA,
            a11 + (1.0 - a11) * ETA,
        ]
    };
    let apd = pd.abs();
    let api = pi.abs();
    [
        [s[0] * fpm(pi * pd), s[1] * fpm(pi * apd)],
        [s[2] * fpm(api * pd), s[3] * fpl(api * apd)],
    ]
}

// tensor.ts 77-81
fn det2(m: &Mat2) -> f64 {
    m[0][0] * m[1][1] - m[0][1] * m[1][0]
}

// tensor.ts 84-86
fn det_score(pv: &Mat2) -> f64 {
    det2(pv).abs().sqrt()
}

// tensor.ts 89-91 — −0 ≥ 0 is true → +1; NaN → −1 (matches JS `>=`).
fn det_sign(pv: &Mat2) -> f64 {
    if det2(pv) >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

// tensor.ts 107-109 — (score * coherence(tau)) * boltzmann(tau).
fn damped_weight(score: f64, tau: f64) -> f64 {
    score * coherence(tau) * boltzmann(tau)
}

// ---------------------------------------------------------------------------
// families.ts — the four spec fields buildRecord reads (families.ts 22-108;
// paramLabels/vouchCandidate are UI-only and never reach the fold).

struct FamilySpec {
    domain: Domain,
    promoted: bool,
    tier: Tier,
    sign_forced: bool,
}

fn family_spec(family: &str) -> Option<FamilySpec> {
    let (domain, promoted, tier, sign_forced) = match family {
        "Opinion" => (Domain::Tribal, false, Tier::Full, false),
        "Affinity" => (Domain::Epistemic, false, Tier::Marginal, false),
        "Owner" => (Domain::Economic, true, Tier::Full, false),
        "Publish" => (Domain::Economic, true, Tier::Full, false),
        "Participant" => (Domain::Relational, true, Tier::Full, false),
        "Registration" => (Domain::Identity, false, Tier::Full, true),
        "SelfDeclaration" => (Domain::Identity, false, Tier::Full, false),
        "SelfReputation" => (Domain::Identity, false, Tier::Full, false),
        "JoinRequest" => (Domain::Relational, true, Tier::Half, false),
        "Accept" => (Domain::Relational, true, Tier::Half, false),
        "Ratify" => (Domain::Relational, true, Tier::Half, false),
        "ReviewA" => (Domain::Tribal, false, Tier::Full, false),
        "ReviewT" => (Domain::Epistemic, false, Tier::Marginal, false),
        "SendA" => (Domain::Relational, true, Tier::Full, false),
        "SendT" => (Domain::Minimal, false, Tier::Marginal, false),
        "ReferenceA" => (Domain::Epistemic, false, Tier::Marginal, false),
        "ReferenceT" => (Domain::Tribal, false, Tier::Full, false),
        "TagA" => (Domain::Epistemic, false, Tier::Marginal, false),
        "TagT" => (Domain::Epistemic, false, Tier::Marginal, false),
        "Control" => (Domain::Minimal, false, Tier::Marginal, true),
        _ => return None,
    };
    Some(FamilySpec { domain, promoted, tier, sign_forced })
}

// graph.ts 59-63 — promoted ⇒ full (1,1,1,1) mask regardless of domain.
fn resolve_mask(family: &str, domain: Domain) -> Mask {
    if let Some(spec) = family_spec(family) {
        if spec.promoted {
            return domain_mask(Domain::Tribal);
        }
    }
    domain_mask(domain)
}

/// graph.ts `RawGraph`. Insertion order of `nodes` and append order of
/// `edges` are the master orders; nothing ever resets.
#[derive(Debug, Default)]
pub struct RawGraph {
    /// Re-adding an existing id REPLACES the value but keeps the original
    /// position — IndexMap::insert has exactly that semantic.
    pub nodes: IndexMap<String, NodeInfo>,
    pub edges: Vec<EdgeRecord>,
    /// Endpoint incidence counts (JS numbers), bumped AFTER τ is read.
    pre_deg: IndexMap<String, f64>,
}

impl RawGraph {
    pub fn new() -> Self {
        Self::default()
    }

    // graph.ts addNode — insert-or-update preserving position.
    pub fn add_node(&mut self, node: NodeInfo) {
        self.nodes.insert(node.id.clone(), node);
    }

    // graph.ts degree — `preDeg.get(id) ?? 0`.
    pub fn degree(&self, node_id: &str) -> f64 {
        self.pre_deg.get(node_id).copied().unwrap_or(0.0)
    }

    // graph.ts bump — `preDeg.set(id, (preDeg.get(id) ?? 0) + by)`.
    fn bump(&mut self, node_id: &str, by: f64) {
        let e = self.pre_deg.entry(node_id.to_string()).or_insert(0.0);
        *e += by;
    }

    // graph.ts 85-114 buildRecord — appendIndex is the PRE-push length.
    fn build_record(&self, input: &EdgeInput, tau: f64) -> EdgeRecord {
        let spec = family_spec(&input.family);
        let domain = input
            .domain
            .or_else(|| spec.as_ref().map(|s| s.domain))
            .unwrap_or(Domain::Tribal);
        let tier = input
            .tier
            .or_else(|| spec.as_ref().map(|s| s.tier))
            .unwrap_or(Tier::Full);
        let mask = resolve_mask(&input.family, domain);
        let slice = sentiment_slice(input.pd, input.pi, mask);
        let pv = path_view(input.pd, input.pi, mask, tier);
        let score = det_score(&pv);
        let sign = if spec.as_ref().is_some_and(|s| s.sign_forced) {
            1.0
        } else {
            det_sign(&pv)
        };
        EdgeRecord {
            id: input.id.clone(),
            family: input.family.clone(),
            src: input.src.clone(),
            tgt: input.tgt.clone(),
            pd: input.pd,
            pi: input.pi,
            domain,
            mask,
            tier,
            tau,
            epoch: input.epoch.unwrap_or(0.0),
            slice,
            pv,
            frob: frobenius(&slice),
            score,
            sign,
            weight: damped_weight(score, tau),
            append_index: self.edges.len(),
        }
    }

    // graph.ts 121-130 — τ from pre-state. Degrees are non-negative counts,
    // never NaN, so f64::max matches Math.max here.
    fn derive_tau(&self, input: &EdgeInput) -> f64 {
        match input.tau_override {
            Some(t) => t,
            None => 1.0 - 1.0 / (1.0 + self.degree(&input.src).max(self.degree(&input.tgt))),
        }
    }

    /// graph.ts append: τ from PRE-state (`tauOverride ?? 1 - 1/(1 +
    /// max(degree(src), degree(tgt)))`), buildRecord, push, bump(src),
    /// bump(tgt). Returns the index of the appended record (JS returns the
    /// record itself; callers read `g.edges[idx]`).
    pub fn append(&mut self, input: EdgeInput) -> usize {
        let tau = self.derive_tau(&input);
        let rec = self.build_record(&input, tau);
        let idx = rec.append_index;
        self.edges.push(rec);
        self.bump(&input.src, 1.0);
        self.bump(&input.tgt, 1.0);
        idx
    }

    /// graph.ts appendHyper: BOTH taus computed first from the same
    /// pre-state (tauA then tauT), then recA pushed, then recT pushed, then
    /// bumps in order aLeg.src, aLeg.tgt, tLeg.src, tLeg.tgt. Returns the
    /// two append indices (A leg, T leg).
    pub fn append_hyper(&mut self, a_leg: EdgeInput, t_leg: EdgeInput) -> (usize, usize) {
        let tau_a = self.derive_tau(&a_leg);
        let tau_t = self.derive_tau(&t_leg);
        let rec_a = self.build_record(&a_leg, tau_a);
        let idx_a = rec_a.append_index;
        self.edges.push(rec_a);
        let rec_t = self.build_record(&t_leg, tau_t);
        let idx_t = rec_t.append_index;
        self.edges.push(rec_t);
        self.bump(&a_leg.src, 1.0);
        self.bump(&a_leg.tgt, 1.0);
        self.bump(&t_leg.src, 1.0);
        self.bump(&t_leg.tgt, 1.0);
        (idx_a, idx_t)
    }
}

# Peer Network — Development Roadmap

Building a working system from the Layer-1 specification
(`PeerNetwork_PeerNetwork_v0.24.1-dev`). The spec's own deployment appendix
prescribes the phasing: a **centralized deployment phase** first (constants are
explicitly "illustrative, not locked" and carry calibration obligations), full
public replayability from day one, and decentralization only after the
constant set is locked. This roadmap follows that.

Two structural rules from the spec shape every phase:

1. **Two pipelines, never merged.** Raw-graph services (feed ranking, signed
   double-cover, bridge, CAN) consume per-edge damped weights. Standing never
   traverses raw edges — it compiles accepted acts into fold cells, builds a
   row-stochastic base allocation matrix, and solves one conserved fixed point
   per epoch. Code must keep these structurally separate.
2. **Replay determinism.** Every published quantity (standing, stamps, gates,
   title) must be recomputable by anyone from the ordered act sequence plus
   published constants. That makes the reference engine — not a database or an
   API — the heart of the system.

---

## Phase 0 — Spec tooling ✅ (done)

- Reproducible PDF build of the spec (TeX Live in WSL, `build.ps1`).
- Machine-readable digests of all 12 sections (`docs/spec-digests/`).
- Extracted numeric registry: 505 reference values (`webapp/tests/registry.json`)
  — constants, fixtures, and expected results from Appendix F.

## Phase 1 — Reference engine (v0) ⏳ (this iteration)

A pure-TypeScript, dependency-free library implementing Layer 1's mathematics
at the chartered constants, validated against Appendix F:

- **Kernels & tensors**: `f_pl` / `f_pm` clamps (β = 2 ln 2), 3×3 sentiment
  slice with the six domain masks, Frobenius norms, η-softened 2×2 path view
  with routing tiers (full / half = √η / marginal = η), det score & sign.
- **Temporal structure**: append-order replay, endpoint pre-degrees,
  maturity τ = 1 − 1/(1 + max pre-degree), binary-entropy Boltzmann damping,
  damped edge weight `det_score · √(1+τ²) · e^(−β·H(τ))`.
- **Raw traversal**: exact signed double-cover BFS (depth 4) with parity
  registers; feed relevance `S = W_BFS · (1 + standing/ν) · ‖T_content‖_F`.
- **Standing pipeline**: net-stance fold (sum-then-clip), recipient
  resolution, fold-cell coefficients (geometric mean of mandatory
  coordinates), base allocation matrix (κ_self = 1), vouch activation
  Q/V/wall-clamp, hop-faded tilt (shape 1, ½, ¼, ⅛), depth mass
  (½, ¼, ⅛, ⅛), source emission, conserved transport Π, mediant fixed-point
  solve.
- **Epoch machinery**: θ-debit ledger (W1), safety wall W2a
  (stamp ≥ 0.528066), policy door W2b (act-weighted epoch stamp ≥ 1,
  headroom), commitment rates.
- **CAN attribution**: transmission m/(1+m), dependency-weight convex
  recursion, Reputation-edge exclusion.
- **Acceptance**: unit tests reproduce the Appendix F reference graph
  (9 edges × 7 quantities), the 5-actor reference epoch equilibrium
  x* = (1.0786557, 1.1051839, 1.1201615, 1.1159692, 1.1171834), epoch stamp
  1.102, headroom 0.615, the wall-activation table, and the adversarial
  fixtures (spam edge 0.011, parity-blocked mixed stance, vouch-gated
  coherent negativity).

Not in v0 (per the spec's own deferral list): interval-arithmetic
certificates and tilt backoff (v0 runs the always-certifying anchor rung and
the pinned full-strength reference), emission for depleted sources beyond the
formula, handshake/commitment cryptography, Layer-0 integration.

## Phase 2 — Interactive explorer website (v0) ⏳ (this iteration)

Bring the protocol to life in the browser — fully client-side, which is
exactly the deployment invariant (client-reproducible ranking, device-local
depth-4 computation):

- Live graph canvas of the Appendix F reference network (actors, artifacts,
  edges weighted/colored by damped weight and sign).
- Edge inspector: stored 3×3 slice as a heatmap, path-view 2×2, the full
  weight chain (det score → coherence → Boltzmann → damped weight).
- Feed panel: pick a viewer, watch the double-cover BFS rank content with the
  relevance breakdown.
- Standing panel: the 5-actor reference epoch — ledger, live fixed-point
  iteration to x*, W1/W2a/W2b gate lights, epoch stamp and headroom.
- Author-an-act form: add Opinions/Affinities/Reviews with chosen parameters
  and watch τ, weights, feed order, and standing react. The protocol's
  incentives become tangible.

## Phase 3 — Persistent sandbox network

- Act formation done properly: acts (not edges) as the atomic records, with
  families, hyper-acts (two projections, one debit), dependency declarations,
  and the host-order Lamport replay from the spec's temporal section.
- A minimal host: append-only act log (single process, SQLite/flat JSONL),
  epoch closure at `epoch_len`, publication of the epoch package
  (ledger, base matrix, standing, stamps, gates) as JSON artifacts.
- A second, independent replay client that ingests the published package and
  reproduces every number bit-for-bit — the spec's 9-step replay procedure as
  a CI test. This is the credibility milestone: measurement, not promise.
- Multi-user simulation harness: scripted actor populations exercising spam,
  wrapper, ballast, and bootstrap scenarios from Appendix F at scale.

## Phase 4 — Layer-0 seam and integrity

- Peer Attestation stub: a burn ledger service (burn events → `burn_val`,
  residual balances) with the one-epoch snapshot rule; later replaceable by
  the real Layer-0 chain. Resolves the leverage-timing seam per charter.
- Admission handshake: payload commitments (hash + salt, binding/concealing),
  host salting, approval witnesses, fraud proofs — the 57 behavioral fixtures
  from Appendix F become the conformance suite.
- Payload lifecycle: full → reduced tombstoning with the invariance test
  (erase all payloads, assert bit-identical scores).

## Phase 5 — Centralized deployment (the spec's calibration phase)

- Hosted instance: the Phase 3 host behind a real web frontend (accounts
  bound to keypairs, act authoring, feeds); certificates and epoch packages
  published at stable URLs.
- Monitoring dashboards for the calibration obligations (G.2): floor
  calibration (ν, θ, ρ_pol), tilt/backoff rates, emission sag, epoch cadence,
  width envelopes — all certificate-derivable replays.
- Constant-transparency page: the seven published scoring constants with
  change history; no-silent-change rule enforced by signing the constant set
  into each epoch certificate.

## Phase 6 — Certification, guilds, decentralization

- Interval-arithmetic certificate evaluator (contraction fence, hull
  enclosures, Clarke intervals) and the tilt backoff grid — moving from the
  anchor rung to certified responsive tilt.
- Layer-2 guild readouts: reward pools over CAN attribution, bridge
  advertiser campaigns (affinity/endorsement/consent circuits), identity
  association — each as a separate consumer of published standing.
- Replace the single host with the decentralized substrate once constants
  lock (the five substrate postulates: public accessibility, record
  integrity, irrevocability, authoritative ordering, epoch edge-set
  provision).

---

**Current status**: Phase 0 complete; Phases 1–2 being built now in
`webapp/` (engine in `src/engine/`, UI in `src/ui/`, tests in `tests/`).
Two pieces of the later phases shipped early, scoped honestly
(`webapp/DECENTRALIZATION.md`): the **epoch chain** (`webapp/chain/`) —
Phase 5's constant-transparency rule as signed, hash-linked epoch
certificates over the act log, verified by replay — and the **IPFS pack**
(`webapp/publish-ipfs.ps1`) — the read side of Phase 6's substrate: app,
record and chain under one reproducible content address. Writes remain
single-host until the authored-act substrate (Phase 3/4) lands; the chain
makes that single writer accountable rather than pretending it away.

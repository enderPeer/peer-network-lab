# Peer Network Lab

Layer-1 reference implementation of the Peer Network protocol
(spec `PeerNetwork_PeerNetwork_v0.24.1-dev`) with an interactive browser
explorer. Phases 1–2 of [`../ROADMAP.md`](../ROADMAP.md).

## Run

```bash
npm install
npm run dev      # → http://localhost:5199 (or Vite's chosen port)
npm test         # 33 unit tests against the spec's Appendix F verification suite
```

## What's here

- `src/engine/` — pure, dependency-free protocol engine:
  - `kernels.ts` — sentiment clamps f_pl/f_pm (β = 2 ln 2), binary entropy, Boltzmann damping
  - `tensor.ts` — 3×3 sentiment slice, domain masks, η-softened 2×2 path view,
    routing tiers, det score/sign, damped edge weight
  - `graph.ts` — append-only projected graph, pre-degree maturity τ, hyper acts
  - `traversal.ts` — exact signed double-cover BFS (depth 4, parity registers)
  - `feed.ts` — relevance ranking S = W·(1 + standing/ν)·‖T‖F
  - `standing.ts` — fold cells → base allocation matrix → wall-clamped vouch
    activation → hop-faded tilt → conserved transport Π → mediant fixed point;
    W1/W2a/W2b epoch gates
  - `can.ts` — compositional attribution (AttrView)
  - `fixtures.ts` — the Appendix F reference graph and reference epoch
- `src/ui/` — the explorer (vanilla TS + SVG, no framework)
- `tests/` — spec-vector tests; `registry.json` holds 505 numeric values
  extracted from the spec's embedded value registry

## Validation

The engine reproduces, among others: the 9-edge reference table
(norms, det scores, τ, damped weights), parity blocking and vouch gating,
S(Bob, Photo) = 1.053, CAN transmission/decay, the wall-activation table, and
the certified 5-actor equilibrium
x* = (1.0786557, 1.1051839, 1.1201615, 1.1159692, 1.1171834) with epoch stamp
1.102 and headroom 0.615.

Known deliberate deviations (flagged in code comments):
- `feed.contentNorm` matches the Appendix F fixture (Frobenius of the mean
  Opinion slice, no maturity factor); the general node-fold table's τ̄ factor
  is a spec ambiguity to resolve.
- The reference fixture matures e3→e4 sequentially; normative hyper appends
  share pre-act state (`RawGraph.appendHyper`).
- v0 implements the chartered constants only; certificates, tilt backoff,
  and depleted-source emission paths are Phase 6 work.

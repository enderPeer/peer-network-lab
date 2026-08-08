# Peer Network Lab

Layer-1 reference implementation of the Peer Network protocol
(spec `PeerNetwork_PeerNetwork_v0.24.1-dev`): the pure engine, an
interactive explorer, the social sandbox app, the multi-user host with an
elected writer, and the signed epoch chain. Started as Phases 1–2 of
[`../ROADMAP.md`](../ROADMAP.md); several later-phase pieces have since
shipped early, scoped honestly in
[`DECENTRALIZATION.md`](DECENTRALIZATION.md).

## Run

```bash
npm install
npm test               # 340 tests, 20 suites: spec vectors, replay, host, chain, election
npm run dev            # protocol lab → http://localhost:5199 (or Vite's chosen port)
npm run build:social   # assemble the social app + PWA assets
node server.mjs        # shared-network host → http://localhost:5210
node chain/build.mjs   # seal every closed epoch into the signed chain
node chain/verify.mjs  # replay the chain: every root, every signature
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
  - `cogra.ts` — the CoGra Layer-2 feed ranking (see the top-level README)
  - `fixtures.ts` — the Appendix F reference graph and reference epoch
- `src/ui/` — the explorer (vanilla TS + SVG, no framework)
- `social/` — the social sandbox: `template.html` (the whole app, one file),
  `assemble.mjs` (the build, which parses before it emits), and `replay.cjs`
  — the **one** shared replay, inlined into the page and imported by the host
- `server.mjs` — the multi-user host: act log, refusals, mirrors, federation
  and the writer election. Runbook: [`HOSTING.md`](HOSTING.md)
- `chain/` — the epoch chain (`build.mjs`, `verify.mjs`) and the writer's
  office (`election.mjs`, `reconcile.mjs`, `merge.mjs`):
  [`DECENTRALIZATION.md`](DECENTRALIZATION.md)
- `tools/` — the off-machine jobs' working parts: liveness check, archive
  sync, the beacon resident ([`../BOTS.md`](../BOTS.md)), and a stress driver
- `examples/bot.mjs` — a working bot in a single file
- `tests/` — 20 suites; `registry.json` holds 505 numeric values
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

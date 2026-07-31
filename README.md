# Peer Network — Working System

A working implementation of the **Peer Network** Layer-1 protocol
(specification `PeerNetwork_PeerNetwork_v0.24.1-dev`, 248 pp.): a social
network in which influence is *transported commitment* rather than attention.
Every act burns reserve; every endorsement carries the endorser's own
commitment rate; feeds and standings are deterministic mathematics anyone can
replay.

## What's in this repository

| Piece | Where | What it is |
|---|---|---|
| Spec PDF build | [build.ps1](build.ps1) → `PeerNetwork_PeerNetwork_v0.24.1-dev.pdf` | Reproducible LuaLaTeX build of the spec (TeX Live in WSL) |
| Spec digests | [docs/spec-digests/](docs/spec-digests) | Machine-extracted per-section digests of all formulas, algorithms, and test vectors |
| Roadmap | [ROADMAP.md](ROADMAP.md) | Six phases from reference engine to decentralized deployment |
| Reference engine | [webapp/src/engine/](webapp/src/engine) | Pure TypeScript, dependency-free Layer-1 mathematics |
| Test suite | [webapp/tests/](webapp/tests) | 35 tests against the spec's Appendix F verification suite; `registry.json` holds 505 extracted reference values |
| Protocol lab | [webapp/](webapp) (`npm run dev`) | Engineer-facing explorer: reference graph, tensor inspector, feed, standing solve, gates |
| Social sandbox | [webapp/social/](webapp/social) (`npm run build:social`) | The tester-facing social app — published online (see below) |
| Coverage audit | [docs/COVERAGE.md](docs/COVERAGE.md) | Independent audit of the implementation against every spec section |

**Online tester build:** https://claude.ai/code/artifact/b196455b-b5a5-4b08-9dac-fd03b499e440
— create accounts, post, react, tag, review, vouch, close epochs. Each
visitor gets an independent copy of the network in their browser (the shared
multi-user host is roadmap Phase 3). Share the link from the page's share menu.

## Quickstart

```bash
cd webapp
npm install
npm test           # 35 spec-vector tests
npm run dev        # protocol lab → http://localhost:5199
npm run build:social   # social sandbox → public/peer-social-preview.html
node server.mjs    # shared-network host → http://localhost:5210
```

**Go public (shared test instance):** `webapp/serve-public.ps1` builds the
page, starts the host, and opens a Cloudflare quick tunnel on a throwaway
`*.trycloudflare.com` domain — one shared network that anyone with the link
can register into. The act log persists in `webapp/server-data/`; the tunnel
domain changes on every restart. The same page falls back to a private
per-browser sandbox when no host is present (that mode is also published at
https://claude.ai/code/artifact/b196455b-b5a5-4b08-9dac-fd03b499e440).

## The protocol in five sentences

1. **Burn is the only source.** Actors acquire reserve by burning value at
   Layer 0; each accepted act debits θ = 0.0528066 and increments the act
   count N, so an actor's *commitment rate* burn/N falls with every act and
   rises only by burning more.
2. **Standing is a transported mediant.** Positive person-vouches compile
   into a row-stochastic allocation; each actor's standing is the
   balance/count mediant of the (burn, N) pairs transported to it — vouching
   moves your own rate toward the target, and can lower theirs as easily as
   raise it. Nothing mints standing.
3. **Edges are tensors.** Every act stores a 3×3 sentiment slice; routing
   uses its 2×2 path view (det score × maturity coherence × Boltzmann
   damping), so young, incoherent, or spammy edges carry geometrically less
   weight.
4. **The feed is your own BFS.** Relevance = path weight from *you* ×
   creator-standing amplifier × content tensor norm, at depth 4, with signed
   parity blocking inverted paths — client-reproducible by construction.
5. **Epochs gate writing.** Per act: solvency (W1). Per author: final
   standing above the safety wall 0.528 (W2a). Per epoch: act-weighted mean
   standing above the participation door 1.0 (W2b) — then stamps and
   certificates are published for replay.

## Validation

`npm test` reproduces, from the spec's own verification appendix: the 9-edge
reference tensor table, the certified 5-actor equilibrium
x\* = (1.0786557, 1.1051839, 1.1201615, 1.1159692, 1.1171834) to 1e-4, epoch
stamp 1.102 / headroom 0.615, the wall-activation curve, parity blocking,
CAN attribution decay, spam quantification (w = 0.011), and the standing
invariances (equal-rate exactness, pair-mass conservation, rate-hull
confinement, artifact crowding).

## Coverage honestly stated

An 8-agent audit ([docs/COVERAGE.md](docs/COVERAGE.md)) compared the code
against every spec section: **87 mechanisms implemented, 55 partial, 76
missing, 9 deviations** (7 of them documented sandbox liberties or
fixture-matching choices; 1 — dangling recipients not weighed home — was
fixed on the spot and is now tested; the dense-transport materialization
remains an acknowledged scalability deviation, exact at sandbox scale).

Implemented and test-anchored: the complete per-edge tensor pipeline, signed
double-cover traversal, feed relevance, the conserved-standing solve with
wall-clamped tilt at the chartered constants, W1/W2a/W2b gates, CAN
attribution, and the edge-family registry for 16 families.

Knowingly absent (deliberate v0 deferrals, mapped to roadmap phases): the
authored-act substrate (act ids, Lamport keys, dependency ordering, payload
commitments — Phase 3/4), settlement & title transfer, membership folds,
Invitation/Bid/Send/Reference families, interval-arithmetic certificates and
tilt backoff (v0 runs the pinned full-strength reference rung; the spec
sanctions the t=0 anchor without certificates), depleted-source emission
scenarios, bridge campaigns, and all Layer-0/handshake cryptography.

## Repository scope

The public repository contains the **implementation** (engine, apps, tests,
roadmap). The specification itself — `PeerNetwork_PeerNetwork_v0.24.1-dev`
(LaTeX source and PDF), the extracted per-section digests, and the detailed
coverage audit — is the spec author's document and is deliberately **not**
included; those files live only in the local working copy until the author
okays publishing them. `webapp/tests/registry.json` (numeric reference
values needed to run the verification tests) is the one spec-derived data
file included.

## Layout

```
ToRuleThemAll/
├── README.md · ROADMAP.md · build.ps1
├── PeerNetwork_PeerNetwork_v0.24.1-dev_flat.tex   (spec source)
├── docs/
│   ├── COVERAGE.md            (audit)
│   └── spec-digests/          (12 extracted section digests)
└── webapp/
    ├── src/engine/            (the protocol: kernels, tensor, graph,
    │                           traversal, feed, standing, can, families)
    ├── src/ui/                (protocol lab)
    ├── social/                (social sandbox template + assembler)
    └── tests/                 (35 spec-vector tests + registry.json)
```

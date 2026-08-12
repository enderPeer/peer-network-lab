# Graph Report - graphsrc  (2026-08-12)

## Corpus Check
- 115 files · ~329,807 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1196 nodes · 2011 edges · 84 communities (83 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- chain.mjs
- server.mjs
- world.ts
- agent.mjs
- chain.ts
- devDependencies
- stream.mjs
- standing.ts
- main.ts
- server
- webauthn.mjs
- onchain.mjs
- Running the network on your own machine
- archive-sync.mjs
- cogra.ts
- stream.test.ts
- cloud-writer-boot.mjs
- stress.mjs
- demoteTo
- AttestationLedger
- compilerOptions
- graph.ts
- pools-onchain.test.ts
- liveness-check.mjs
- repoint-log-2026-08-03.mjs
- admin.test.ts
- applyActInner
- make-icons.mjs
- RawGraph
- engine.test.ts
- feed.ts
- agent/package.json
- Sending in changes
- handleBotApi
- Putting PEER on a real chain — the runbook
- Decentralization: the chain, the CAR, and what each one actually claims
- onchain-pools-decode.test.ts
- beacon.mjs
- media.test.ts
- Peer Network — Working System
- validate
- burn-watch.test.ts
- markets-host.test.ts
- Bots: the network's other residents
- mirrorSync
- host.test.ts
- Peer Network — Development Roadmap
- The cloud writer — a writing instance on a machine that is nobody's
- Prender Markets — a bet is a post
- authError
- assemble.mjs
- pin.test.ts
- ipfs-pack.mjs
- adminMetrics
- build-pools.js
- peer-agent (ICEsoul)
- Mirrors: where this project lives when any one host disappears
- sw.js
- serve-deploy.mjs
- build-deploy-page.js
- Peer Network Lab
- renders.test.ts

## God Nodes (most connected - your core abstractions)
1. `server` - 52 edges
2. `handleBotApi()` - 20 edges
3. `applyActInner()` - 16 edges
4. `seed()` - 16 edges
5. `RawGraph` - 15 edges
6. `demoteTo()` - 14 edges
7. `electionTick()` - 14 edges
8. `AttestationLedger` - 14 edges
9. `verifyChain()` - 13 edges
10. `Running the network on your own machine` - 13 edges

## Surprising Connections (you probably didn't know these)
- `actCommitments()` --indirect_call--> `act()`  [INFERRED]
  webapp/chain/acts.mjs → agent/agent.mjs
- `renderThread()` --indirect_call--> `c()`  [INFERRED]
  agent/agent.mjs → webapp/tests/election.test.ts
- `validate()` --indirect_call--> `c()`  [INFERRED]
  agent/agent.mjs → webapp/tests/election.test.ts
- `pickWriter()` --indirect_call--> `c()`  [INFERRED]
  webapp/chain/election.mjs → webapp/tests/election.test.ts
- `server` --calls--> `validBtcAddress()`  [EXTRACTED]
  webapp/server.mjs → webapp/ads.mjs

## Import Cycles
- None detected.

## Communities (84 total, 1 thin omitted)

### Community 0 - "chain.mjs"
Cohesion: 0.06
Nodes (73): actCommitments(), MENTION_KINDS, PAYLOAD_FIELDS, payloadMayDiffer(), payloadProjection(), SEED_HANDLES, structuralProjection(), blockDigest() (+65 more)

### Community 1 - "server.mjs"
Cohesion: 0.03
Nodes (68): ACT_FIELDS, ACT_KINDS, acts, adStore, API_DOC, banned, BTC_ADDRESS_RAW, BURN_ADDRESS_RAW (+60 more)

### Community 2 - "world.ts"
Cohesion: 0.06
Nodes (32): act(), post(), ROOT, total(), world(), contentIds(), { create }, Edge (+24 more)

### Community 3 - "agent.mjs"
Cohesion: 0.08
Nodes (42): acquireLock(), act(), clamp(), cycle(), decide(), digest(), DIR, dry (+34 more)

### Community 4 - "chain.ts"
Cohesion: 0.07
Nodes (20): fileSeed(), world(), Block, blockMod, build(), canonicalMod, ChainApi, chainMod (+12 more)

### Community 5 - "devDependencies"
Cohesion: 0.06
Nodes (34): blockstore-core, esbuild, @ethereumjs/vm, ipfs-unixfs-importer, @ipld/car, jsdom, multiformats, solc (+26 more)

### Community 6 - "stream.mjs"
Cohesion: 0.10
Nodes (13): RFC-6455, acceptUpgrade(), BlindWatcher, CLUSTER_CHILDREN, createHub(), frame(), isWebSocketUpgrade(), LIMITS (+5 more)

### Community 7 - "standing.ts"
Cohesion: 0.13
Nodes (27): ACT_EXPONENT, BETA, DEPTH_MASS, ETA, HOP_MAX, KAPPA_SELF, NU, OMEGA_DOMAIN (+19 more)

### Community 8 - "main.ts"
Cohesion: 0.14
Nodes (31): binaryEntropy(), boltzmann(), coherence(), evaluateGates(), actLog, AUTHORABLE, bar(), clip() (+23 more)

### Community 9 - "server"
Cohesion: 0.09
Nodes (30): refusal(), adLimiter, adminAuth(), adminBans(), adminIps(), adminLimiter, banCheck(), burnAddressTxs() (+22 more)

### Community 10 - "webauthn.mjs"
Cohesion: 0.12
Nodes (23): CONFUSABLE, handleClash(), handleSkeleton(), takenHandles(), issueChallenge(), act(), jget(), ROOT (+15 more)

### Community 11 - "onchain.mjs"
Cohesion: 0.14
Nodes (28): addrFromWord(), balanceOf(), BTC_ADDR, bytes32Name(), call(), CHAIN_ID, chainCheck(), clean() (+20 more)

### Community 12 - "Running the network on your own machine"
Cohesion: 0.08
Nodes (26): 1. On the new PC — start as a mirror, 2. Publish it as the fallback, 3. Let it run, 4. Swap the roles, Addresses, Decentralisation: what works, and what this log cannot do, Emergency promotion, Environment (+18 more)

### Community 13 - "archive-sync.mjs"
Cohesion: 0.08
Nodes (19): acts, archDir, candidates, cfg, DRY, fetchJson(), fetchRaw(), have (+11 more)

### Community 14 - "cogra.ts"
Cohesion: 0.13
Nodes (22): buildHops(), BuildOpts, clip(), COGRA_DEFAULTS, CograConfig, CograPath, cograRank(), foldBundles() (+14 more)

### Community 15 - "stream.test.ts"
Cohesion: 0.13
Nodes (13): block(), el(), maskFrame(), openEl(), sizeVint(), UNKNOWN_SIZE, webmCluster(), webmHeader() (+5 more)

### Community 16 - "cloud-writer-boot.mjs"
Cohesion: 0.15
Nodes (21): ARCHIVE, bootstrapFromArchive(), BRANCH, DATA, fetchBuf(), git(), here, INTERVAL (+13 more)

### Community 17 - "stress.mjs"
Cohesion: 0.10
Nodes (14): badRefusal, BASE, born, junk, junkRows, pct(), PEERS, READ_PATHS (+6 more)

### Community 18 - "demoteTo"
Cohesion: 0.17
Nodes (19): num(), outranks(), pickWriter(), strictlyLonger(), strId(), demoteTo(), electionTick(), electionTickSafe() (+11 more)

### Community 19 - "AttestationLedger"
Cohesion: 0.16
Nodes (5): AttestationLedger, L0_DEFAULTS, L0Balance, L0Config, OPERATOR

### Community 20 - "compilerOptions"
Cohesion: 0.11
Nodes (18): DOM, DOM.Iterable, ES2022, src, tests, vite/client, compilerOptions, isolatedModules (+10 more)

### Community 21 - "graph.ts"
Cohesion: 0.25
Nodes (15): HALF_FLOOR, FAMILIES, FamilySpec, EdgeInput, EdgeRecord, NodeKind, det2(), detScore() (+7 more)

### Community 22 - "pools-onchain.test.ts"
Cohesion: 0.18
Nodes (13): addrWord(), BLOCK, CallResult, makeWorld(), name32(), poolsBuild, reason(), S0 (+5 more)

### Community 23 - "liveness-check.mjs"
Cohesion: 0.12
Nodes (12): before, candidates, cfg, DIR, get(), hostPath, live, next (+4 more)

### Community 24 - "repoint-log-2026-08-03.mjs"
Cohesion: 0.12
Nodes (16): acts, after, before, certA, certB, da, dangling(), db (+8 more)

### Community 25 - "admin.test.ts"
Cohesion: 0.17
Nodes (11): base58checkOk(), bech32PolymodOk(), createAdStore(), PLACEMENTS, validBtcAddress(), act(), admin(), adminJson() (+3 more)

### Community 26 - "applyActInner"
Cohesion: 0.16
Nodes (15): CATALOGUE, catalogueDocument(), statusFor(), applyAct(), applyActInner(), classify(), flushPinUpgrades(), handlesAt() (+7 more)

### Community 27 - "make-icons.mjs"
Cohesion: 0.17
Nodes (14): chunk(), CRC, crc32(), draw(), drawMark(), EMBER, fillPath(), flatten() (+6 more)

### Community 28 - "RawGraph"
Cohesion: 0.21
Nodes (7): REFERENCE_EPOCH, REFERENCE_SEEDS, referenceGraph(), RawGraph, resolveMask(), FoldCell, Ledger

### Community 29 - "engine.test.ts"
Cohesion: 0.29
Nodes (10): CanNode, canValue(), dependencyWeights(), transmission(), fpl(), fpm(), sigmoid(), pathView() (+2 more)

### Community 30 - "feed.ts"
Cohesion: 0.20
Nodes (10): CograScore, FEED_DEPTH, contentNorm(), FeedEntry, rankFeed(), STANCE_FAMILIES, NodeInfo, frobenius() (+2 more)

### Community 31 - "agent/package.json"
Cohesion: 0.15
Nodes (12): dependencies, node-llama-cpp, description, node-llama-cpp, name, private, scripts, dry (+4 more)

### Community 32 - "Sending in changes"
Cohesion: 0.15
Nodes (13): A note on what this is, Building a bot, Conventions, Rules this project learned the hard way, Running calls that cross networks, Running it locally, Sending code, Sending in changes (+5 more)

### Community 33 - "handleBotApi"
Cohesion: 0.22
Nodes (13): actLimiter, contentView(), ensureEngine(), handleBotApi(), isDeleted(), nameOf(), rankFeed(), readBody() (+5 more)

### Community 34 - "Putting PEER on a real chain — the runbook"
Cohesion: 0.17
Nodes (11): 1. Deploy PEER (~$0.04), 2. Deploy the pools factory (~$0.08), 3. The Uniswap alternative (~$0.20), 4. Point the network at it, A pool name is a label, not a namespace, Deploying it, Putting PEER on a real chain — the runbook, What stays impossible, and why that is correct (+3 more)

### Community 35 - "Decentralization: the chain, the CAR, and what each one actually claims"
Cohesion: 0.17
Nodes (12): Decentralization: the chain, the CAR, and what each one actually claims, Deletion does not break it, Known limits, stated rather than hidden, No silent change, The epoch chain, The IPFS pack, The writer is an office, not a machine, Using it (+4 more)

### Community 36 - "onchain-pools-decode.test.ts"
Cohesion: 0.26
Nodes (8): addrWord(), DATA_TMP, info5(), Log, name32(), poolLog(), SCAN_FILE, uint()

### Community 37 - "beacon.mjs"
Cohesion: 0.21
Nodes (11): acted, DRY, getJson(), HANDLE, here, http(), INVITE, main() (+3 more)

### Community 38 - "media.test.ts"
Cohesion: 0.27
Nodes (5): act(), get(), post(), ROOT, total()

### Community 39 - "Peer Network — Working System"
Cohesion: 0.20
Nodes (10): CoGra feed ranking (Layer 2), Coverage honestly stated, How the pieces fit, Layout, Peer Network — Working System, Quickstart, Repository scope, The protocol in five sentences (+2 more)

### Community 40 - "validate"
Cohesion: 0.24
Nodes (10): contentExists(), freshState(), handleExists(), isRegistered(), marketDoor(), marketResolveMs(), mintIndexOf(), unknownTarget() (+2 more)

### Community 41 - "burn-watch.test.ts"
Cohesion: 0.22
Nodes (5): burnsOf(), chain, FakeTx, get(), ROOT

### Community 42 - "markets-host.test.ts"
Cohesion: 0.33
Nodes (8): act(), ask(), get(), marketCid(), post(), ROOT, total(), WHO

### Community 43 - "Bots: the network's other residents"
Cohesion: 0.22
Nodes (9): 1. Fork this repo (free, no machine of yours), 2. Any runtime, ~20 lines, 3. A scheduled cloud agent, 4. A local model, Bots: the network's other residents, Bring your own — free options first, The bar to clear, The residents (+1 more)

### Community 44 - "mirrorSync"
Cohesion: 0.28
Nodes (9): gcMedia(), mediaRefsOf(), mirrorAdopt(), mirrorAdoptSafely(), mirrorGet(), mirrorMedia(), mirrorSync(), rewriteLog() (+1 more)

### Community 45 - "host.test.ts"
Cohesion: 0.36
Nodes (6): act(), get(), post(), postThenRevise(), ROOT, total()

### Community 47 - "Peer Network — Development Roadmap"
Cohesion: 0.25
Nodes (8): Peer Network — Development Roadmap, Phase 0 — Spec tooling ✅ (done), Phase 1 — Reference engine (v0) ⏳ (this iteration), Phase 2 — Interactive explorer website (v0) ⏳ (this iteration), Phase 3 — Persistent sandbox network, Phase 4 — Layer-0 seam and integrity, Phase 5 — Centralized deployment (the spec's calibration phase), Phase 6 — Certification, guilds, decentralization

### Community 48 - "The cloud writer — a writing instance on a machine that is nobody's"
Cohesion: 0.25
Nodes (7): Deploying (any Docker platform), Environment, Handing the pen back, One writer at a time still holds, The cloud writer — a writing instance on a machine that is nobody's, The three pieces, Where to run it (scanned + verified against official pages, 2026-08-07)

### Community 49 - "Prender Markets — a bet is a post"
Cohesion: 0.25
Nodes (7): How one runs, Prender Markets — a bet is a post, The acts, The one rule everything else protects, What this does not stop, Where the clock lives, Who may not do what

### Community 50 - "authError"
Cohesion: 0.29
Nodes (8): authError(), fnvHash(), hasHistory(), newPinHash(), pbkdf2Pin(), pinMatches(), pinNeedsUpgrade(), takeChallenge()

### Community 51 - "assemble.mjs"
Cohesion: 0.25
Nodes (7): enginePath, here, out, replaySrc, splashes, splashLinks, template

### Community 52 - "pin.test.ts"
Cohesion: 0.29
Nodes (4): lift(), PAGE, pageVerifier(), ROOT

### Community 53 - "ipfs-pack.mjs"
Cohesion: 0.29
Nodes (6): here, main(), outPath, srcDir, walk(), webappDir

### Community 54 - "adminMetrics"
Cohesion: 0.33
Nodes (7): activeAuthors(), adminMetrics(), chainHeadInfo(), liveNow(), mediaDirSize(), selfCandidate(), topMap()

### Community 55 - "build-pools.js"
Cohesion: 0.29
Nodes (5): artifact, input, out, source, version

### Community 56 - "peer-agent (ICEsoul)"
Cohesion: 0.33
Nodes (5): Guardrails (code, not trust), Notes, peer-agent (ICEsoul), Run, Setup

### Community 57 - "Mirrors: where this project lives when any one host disappears"
Cohesion: 0.40
Nodes (5): Becoming a mirror, If everything above is down, Mirrors: where this project lives when any one host disappears, Reaching each one, The copies

### Community 58 - "sw.js"
Cohesion: 0.60
Nodes (4): mediaKey(), serveMedia(), SHELL, withRange()

### Community 59 - "serve-deploy.mjs"
Cohesion: 0.40
Nodes (4): here, PORT, server, TYPES

### Community 60 - "build-deploy-page.js"
Cohesion: 0.50
Nodes (3): build, pools, poolsFp

### Community 61 - "Peer Network Lab"
Cohesion: 0.50
Nodes (4): Peer Network Lab, Run, Validation, What's here

## Knowledge Gaps
- **434 isolated node(s):** `DIR`, `envFile`, `EVERY`, `MEM_PATH`, `LOCK_PATH` (+429 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `c()` connect `agent.mjs` to `demoteTo`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `pickWriter()` connect `demoteTo` to `server.mjs`, `agent.mjs`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `world()` connect `agent.mjs` to `RawGraph`, `cogra.ts`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **What connects `DIR`, `envFile`, `EVERY` to the rest of the system?**
  _434 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `chain.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.055600106923282544 - nodes in this community are weakly interconnected._
- **Should `server.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.0273972602739726 - nodes in this community are weakly interconnected._
- **Should `world.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05974025974025974 - nodes in this community are weakly interconnected._
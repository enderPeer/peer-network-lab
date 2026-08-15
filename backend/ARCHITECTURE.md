# Ender Net — the Rust era architecture

**Decision, 2026-08-14.** The prototype (TS/JS reference implementation in
`webapp/`) is finished and live. The next architecture is: a **deterministic
Rust backend**, **GraphQL** as the query/mutation API, and **Postgres** as
the graph store. This document is the binding plan: what changes, what is
frozen forever, in what order, and what only the owner may decide.

It was produced from a 12-agent survey of the running system (9 subsystem
readers, 3 independent architecture proposals) plus a working proof: the
canonical layer is already ported and passing bit-parity against the live
chain (see "Already proven" below).

---

## 1. The bet

**Bit-parity, no new era.** The canonical layer was designed for exactly
this migration: declared ordering (UTF-16 code-unit key sort), declared
representation (ECMA-262 shortest round-trip number printing), declared
rounding (the 1e-9 quantum sealed into every block). All three architecture
proposals independently concluded — and the working port now demonstrates —
that a Rust engine can reproduce today's bytes exactly. Therefore:

- `acts.jsonl` + `blocks.jsonl` **remain the only authoritative bytes**.
  Postgres is a disposable projection. GraphQL is an additive surface.
- The existing chain survives **byte-identical**: same `producer.pem`, same
  `NET_ID` (`peernetwork-sandbox/v0.24.1-dev`), same `CHAIN_VERSION 1`,
  same prev-links. No genesis-2, no migration block.
- **Correct means byte-identical.** Every phase gates on zero-byte-diff
  parity against the real logs and chains — never on tolerances. The chain
  itself compares canonical strings; a tolerance-based test would pass code
  the chain calls tampering.
- The frozen JS files (`public/peer-engine.mjs`, `social/replay.cjs`) stay
  in-repo as the **normative spec artifacts**. New blocks keep sealing
  `editions` = sha256 of those exact bytes: the edition names the rulebook,
  and the rulebook hasn't changed — only its executor. `verify.mjs` and the
  Rust verifier both exit 0 on both eras of block production, with zero
  drift warnings. (This requires the parity gate to be a merge-blocking CI
  job forever — that is the price of the claim, and it is worth it.)
- A dormant **era-2 boundary spec** is written but not deployed: a block
  committing to {era-1 head hash, act count, editions} with a float-free
  canonical format. It activates only on explicit owner decision or if
  parity ever fails on real data — divergence becomes a signed protocol
  event, never silent corruption.

## 2. Already proven (working code in `backend/`)

The parity harness (`backend/parity/*.mjs` → `cargo test`) generates
golden vectors **from the real JS code over real data** — never from a
reimplementation — and the Rust crates reproduce them:

| Surface | Status |
|---|---|
| Canonical encoding, 48 adversarial values | byte-identical |
| Merkle roots (0–9 leaves, domain-separated) | byte-identical |
| quantize / JS `Math.round` semantics, 19 bit-exact doubles | bit-identical |
| All 48 live acts: canonical bytes + hashes | byte-identical |
| All live signed blocks: digest, hash, Ed25519 verify | byte-identical, sigs verify |
| parseMentions (14 collision/unicode cases, real engine) | identical |
| Structural + payload commitments over the live log | identical |
| Transcendentals (V8 fdlibm exp/log/tanh/pow), 19,515 vectors | bit-identical |
| **The full fold: every epoch package, live (3) + genesis-0 (60 closes)** | **byte-identical** |
| Act-level trace digests over every log prefix | identical |
| **`verify_chain` — the COMPLETE verifyChain incl. replay** | live: strict-path ok; genesis-0: ok + 60 drift warnings, matching JS verdict exactly |
| Tamper detection (forged act / signature / link) | all detected, attributed |

**Phase-2 status: the engine port is DONE and gated.** `ender-engine`
replays both production logs and reproduces every sealed epoch package
byte-for-byte; `ender-jsmath` vendors V8's fdlibm (ieee754.cc @
12.4.254.21). Out of phase-2 scope by design: chron/display state, the
browser-only engine modules (cogra, community, feed, traversal), and the
retired AttestationLedger — they belong to the host phase (3).

Traps the harness already caught — each would have silently forked the
chain if the port had been "reviewed" instead of byte-diffed:

1. `serde_json`'s default float parse is not correctly rounded; JS
   `JSON.parse` is. The `float_roundtrip` feature is mandatory — without it
   real block digests diverge.
2. JS sorts keys by UTF-16 code unit; Rust string order is scalar order.
   They disagree on astral-plane keys.
3. JS `Math.round` ties toward +∞ and returns -0 on (-0.5, 0);
   `f64::round` ties away from zero.
4. ECMA-262 number printing (`1e21`/`1e-7` thresholds, `-0` → `"0"`) is
   supplied by the `ryu-js` crate, which exists precisely because Rust JS
   engines need it.

## 3. Invariants the migration must not break

From the system survey — these are load-bearing today:

- **One door.** Every write funnels through applyAct → sanitize → validate
  → authError → solvency gate → append. Three host-minted kinds (`btcBurn`,
  `peerBurn`, `resetTokens`) are unreachable from any API. GraphQL
  mutations must enter the SAME door — no second validation path, ever.
- **One writer.** role.json outranks env; mirrors and quarantined boots
  refuse writes (`MIRROR_READONLY`, `ELECTION_PENDING`); the writer is an
  elected office; forks heal by deterministic rebase. Cutover uses this
  machinery rather than bypassing it.
- **Redaction is in-place, line-count preserving.** Structural hashes are
  redaction-invariant; payload hashes become sealed residue. Nothing that
  scores, mints, or escrows ever moves when content is erased.
- **The client is thick.** The page downloads the whole log and replays it
  locally with the same inlined engine; it verifies chain blocks in
  WebCrypto. The server is a dumb append-log + blob store + relay. Nothing
  may make the server's opinion authoritative over replay.
- **The REST surface, `PEER_*` env names, stable error codes, and even the
  quirks are frozen.** External residents branch on exact field names and
  codes: the local LLM resident, the claude.ai cloud resident, three GitHub
  Actions jobs (liveness every 15 min, archive-sync every 6 h with a
  producer pin, Beacon every 6 h), mirrors, the PWA, burn claimants, and
  the on-chain merkle claimants. **The residents are the acceptance test.**
- **No SSE exists.** Real-time is polling, long-poll mailboxes, and one
  bespoke binary WebSocket relay. GraphQL subscriptions are a new
  capability, not a port.
- **Privacy invariants.** IP telemetry, bans, rate buckets, signal
  mailboxes, the live registry stay in process memory on purpose. The
  migration must not "helpfully" persist them.

## 4. Target shape

```
backend/
  crates/
    ender-canonical   canonical bytes, merkle, quantize, block hash/verify   [DONE]
    ender-chain       commitments, parseMentions, structural verifier        [DONE]
    ender-jsmath      JS float kernel: js_round (done), toFixed(6),
                      pow/exp/tanh vendored from V8's fdlibm ieee754 —
                      system libm and f64::round lint-banned in the fold
    ender-engine      the deterministic fold: full replay.cjs port —
                      IndexMap insertion-order state, sequential folds,
                      BigInt peerBurn/earnings, memoized epoch certificates,
                      refusal sentences byte-for-byte
    ender-store       Postgres projection (sqlx; no ORM) + operational tables
    ender-graphql     async-graphql schema; mutations compile to acts
    ender-host        axum: byte-compatible REST + /graphql + WS relay +
                      watchers + election/mirror/quarantine machinery
    ender-parity      the conformance harness; gates every merge
  parity/gen-vectors.mjs   golden vectors from the real JS over real data
```

Dataflow: acts in (REST or GraphQL, one door) → append to the log →
`ender-engine` folds → immutable `Arc<WorldState>` snapshot swapped per
append → GraphQL/REST reads resolve from the snapshot (no N+1 by
construction) → a projector writes Postgres read models → chain sealing on
`closeEpoch` exactly as today.

## 5. Determinism doctrine

1. **One encoder.** Every hash preimage flows through `ender-canonical`.
   Stored acts and blocks are carried as **verbatim bytes and never
   re-serialized** — incremental sealing reuses lines exactly as chain.mjs
   does, so a float round-trip can never corrupt a blockHash link.
2. **One float kernel.** All fold arithmetic routes through `ender-jsmath`;
   JS evaluation order is preserved token-for-token (e.g.
   `Math.floor(pool*tw/twTotal*1e6)/1e6` stays a four-op chain); no
   fast-math, no auto-FMA, no parallel or SQL summation anywhere near
   money; insertion-ordered maps everywhere JS objects accumulate.
3. **The harness is the definition of done.** Frozen micro-vectors; whole
   golden corpora (live chain, the 60-block genesis-0 archive,
   site/archive) must verify exit-0 AND reseal byte-identically;
   differential fuzzing Node-vs-Rust on generated logs; REST byte-diff of
   every GET between hosts; `node chain/verify.mjs` exit-0 on Rust-sealed
   output and vice versa. Red parity blocks merge unconditionally.
4. **Bounded blast radius.** The 1e-9 quantum absorbs sub-ulp drift inside
   packages; the dormant era-2 spec is the escape hatch that turns any
   unfixable divergence into an explicit signed event.

## 6. Postgres model — projection, not source of truth

**Apache AGE is rejected** (all three proposals, same reasons): the
expensive graph math — the standing fixed-point solve, cograRank,
modularity, the mint walk — is order-sensitive f64 arithmetic that must run
in the deterministic engine and is not expressible in Cypher; the workload
is tiny by design (MAX_ACTS = 50,000, hundreds of edges — the whole graph
folds in memory in microseconds); and the doctrine "SQL never computes
protocol values" leaves Cypher nothing to do. Plain tables + recursive CTEs
for ad-hoc traversal cover everything else.

Three strata:

- **A. Log mirror** (authoritative-adjacent): `act_log(idx PK, line BYTEA
  /* exact JSON.stringify bytes */, kind, author, ts, structural_hash,
  payload_hash, redacted, body JSONB /* read index ONLY — jsonb reorders
  keys and normalizes numbers, so it is never hashed, never re-serialized,
  never exported */)`. idx = file line index; seedWorld is synthetic and
  never a row; redaction is an in-place UPDATE at the same idx; triggers
  forbid DELETE. `blocks(height PK, line BYTEA)` verbatim. Through cutover
  the **files stay primary** (append + file first, row second; on
  divergence the file wins and the table rebuilds). Whether Postgres ever
  becomes primary-with-byte-exact-export is an explicit owner decision.
- **B. Projection** (rebuildable, written only from engine deltas):
  accounts, nodes, edges (indexed src/tgt/family), follows, content, DMs,
  events, markets + stakes, pools + shares, token balances, token dist,
  epoch history + packages, bindings, addr-at-epoch. `float8` columns are
  display caches; a projector-only role grant plus convention forbids SQL
  arithmetic on them. Watermark = (log_len, engine_edition); retroactive
  acts (deletePost, deleteAccount, resetTokens) trigger TRUNCATE + refold —
  mirroring replay's own pre-scan model instead of fighting it.
  **Rebuild-from-zero is a drilled, timed operation.**
- **C. Operational** (never protocol): `burn_claims(txid UNIQUE, …)` — the
  unique constraint replaces the single-thread TOCTOU await-recheck
  pattern; burn intents, scan cursors, contacts, ads, webauthn challenges.
  Deliberately NOT in Postgres: IPs, bans, rate buckets, mailboxes, live
  registry, view dedupe (tested privacy invariants).

## 7. GraphQL design

`async-graphql` + `async-graphql-axum` (juniper rejected: no `@oneOf`,
weaker subscriptions/dataloader). `sqlx` raw SQL (an ORM adds nothing when
SQL is forbidden from computing). Endpoint `/graphql` — deliberately
outside `/api/` so the deployed service worker's never-cache rule ignores
it. Strictly additive: **the REST surface is frozen and served forever.**

- **Reads**: `state`, `account(id)`, `feed(as, sort: COGRA|L1|NEW)`,
  `content(cid, depth)`, `acts(after, first)`, `chain { head, blocks }`,
  `markets`, `pools`, `epoch(n)` with claim trees, `election`,
  `errorsCatalogue`. Hot resolvers read the `Arc<WorldState>` snapshot —
  pure map lookups, zero DB; DataLoader batches only Postgres-backed
  history fields. Cursors encode act indices — stable forever because
  redaction preserves positions.
- **Scalars that make corruption unrepresentable**: `RawAmount` (decimal
  string — 18-decimal raws never travel as Float), `Cursor`, `Hex32`.
- **Mutations compile to acts**, one field per whitelisted kind, plus
  `submitAct(act, auth)` as the raw escape hatch — ALL entering the same
  applyAct door as REST. Host-minted kinds have no mutation, unreachable by
  construction. `auth: AuthInput! @oneOf { pin | passkey | operatorToken }`
  — fixing at the type level the historical polymorphic-pin bug that once
  locked passkey-only handles out. No cookies, no sessions: credential-in-
  body preserves the CSRF-immunity-under-wildcard-CORS posture.
- **Refusals** surface as GraphQL errors with `extensions {code, why, fix}`
  copied verbatim from the errors.mjs catalogue — `NO_ENERGY`,
  `MIRROR_READONLY` (+mirrorOf), `ELECTION_PENDING` keep their identities
  so a client can run the same follow-the-pen state machine on either
  surface.
- **Subscriptions** (graphql-ws): `actAppended(after)` — replacing the
  5-second polling loop, `alerts`, `inbox`, `marketChanged(cid)`,
  `epochSealed`, `signal` — replacing the long-poll mailboxes. New
  capability; nothing existing depends on it.
- **Explicitly not GraphQL**: media upload/serve (Range/206 bytes), the
  binary stream relay WS, `/api/acts` + `/api/chain` raw-file serving —
  clients depend on their exact byte/transport semantics.

## 8. Migration phases — each gated, each with a rollback

**0. Freeze the oracle** — **DONE.** Golden vectors from the real JS over
real data, committed; live + genesis-0 logs/chains snapshotted as
fixtures.

**1. Rust verifier** — **DONE.** `verify_chain` performs the complete
verifyChain (structure + per-block replay + edition-drift attribution) and
lands on the identical verdict as the JS verifier on both real chains.

**2. Engine parity — the hard gate** — **PASSED** for the fold core:
`ender-engine` (replay.cjs + the consumed engine surface) reproduces every
epoch package byte-identically on both production logs; `ender-jsmath`
vendors V8's fdlibm, proven on 19,515 recorded transcendental vectors.
Remaining phase-2 tail, rolled into phase 3: refusal-sentence surface
testing over the vitest semantics, differential fuzzer soak, full-chain
reseal (needs the Ed25519 signing side), chron/display state.

**3. Rust host as read-only mirror in production.** Joins the federation
under role.json; serves the full REST read surface + `/graphql` reads;
shadow byte-diff of sampled GETs against the JS primary; the three CI
residents + liveness probes validated against it. *Rollback: remove from
host.json candidates. Zero writes at risk.*

**4. Postgres projection + GraphQL mutations (still refused as mirror) +
subscriptions.** Rebuild drill documented and timed. *Rollback: TRUNCATE;
the files are untouched.*

**5. Write-path shadow, then promotion.** Shadow: for every act the JS
primary appends, Rust re-runs the full door and asserts same verdict, same
code, same stamped bytes — ≥2 weeks clean including a closeEpoch and a
redaction. Then cutover with the system's own machinery, in order: stop the
old watchdog → JS role.json → mirrorOf Rust → Rust adopts tail to parity →
Rust role.json → primary (boot quarantine honored, watchers start after) →
republish host.json → `producer.pem` moves so sealing continues under the
same key and the archive-sync producer pin never trips. JS host stays
running as mirror = instant rollback; any Rust-appended acts are
byte-compatible lines the JS host re-adopts by normal sync. *Risk: the
two-writer window — the historical failure mode; mitigated by role-file
precedence, quarantine ordering, strictlyLonger-only dethroning, and a
manual ordered flip.*

**6. Consolidation.** JS host retired to pinned spec artifact + CI oracle;
browser endgame decided (WASM vs frozen inlined JS); deliberate protocol
fixes batched into one explicit edition event using the chain's
drift-attribution path.

## 9. Decisions only the owner can make

1. **Editions semantics blessing** — keep sealing the frozen JS files'
   hashes with Rust as the proven-equal executor (recommended; zero drift
   warnings; requires the parity gate forever) vs. minting a Rust edition
   id (every historical block then verifies via the drift-warning path).
2. **The defect register** (below): reproduce bug-for-bug (default) or fix
   — every fix changes observable bytes/behavior; some deserve a batched
   edition event.
3. **Store of record**: files-primary forever, or Postgres-primary with
   continuous byte-exact export after cutover proves out.
4. **Browser endgame**: frozen inlined JS replay (permanent dual-
   implementation parity duty, status quo) vs. WASM build of
   `ender-engine` (ends the duty; changes page bytes → pinned IPFS CID,
   nsite, every static mirror republish — coordinated event).
5. **Hosting at cutover**: same Windows box behind the tunnel (key stays
   put) vs. a stable domain — which will, for the first time, ACTIVATE the
   dormant cloud resident that has never reached the host. Decide
   supervision before, not after.
6. **Promotion freeze window**: a few minutes of `ELECTION_PENDING`
   materially simplifies the final tail-parity check. Recommended: yes.
7. **GraphQL status**: additive convenience vs. eventually the documented
   bot surface (REST frozen either way; publishing GraphQL creates a
   second frozen contract).
8. **MAX_ACTS 50,000**: keep (Rust makes the whole-log-in-memory design
   cheap) or raise — touches federation caps, mirror adoption, and the
   browser's full-log download; should be its own later decision.
9. **closeEpoch stays communal/unauthenticated** (any client can close an
   epoch)? Hardening it refuses acts today's network accepts.

## 10. Defect register (found by the survey; decide, don't discover)

- **Redaction blanks `act.opts` although `opts` sits in the STRUCTURAL
  projection** — redacting a sealed market act would trip "structural hash
  mismatch": a latent chain-break, currently untested. Highest priority
  decision; probably deserves a guard today in the JS host regardless of
  the port.
- `byOperator` on operator `setPin` is whitelisted but never persisted.
- `/api/ads` serves `paidTbtc` while the client reads `ad.paid` (renders 0).
- Unmatched `POST /api/v1/*` answers `410 FAUCET_GONE` instead of 404 —
  load-bearing quirk, keep.
- `/api/v1/alerts` mixes two index scales in `at` — a resident's
  high-water marks depend on the current behavior, keep until coordinated.
- Fail-open `solvency()`/`contentExists()` when the engine bundle is
  missing ("a missing build must never silence the network") — a Rust host
  always has its engine; preserve the semantics or declare always-strict.

---

*Working code and harness: `backend/` in this repo. Regenerate vectors
with `node backend/parity/gen-vectors.mjs`; run parity with `cargo test`.
The full 12-agent survey (route inventories, act catalog, consumer
contracts, per-file determinism notes) is preserved in the session
scratchpad and distilled here.*

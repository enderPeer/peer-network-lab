# Decentralization: the chain, the CAR, and what each one actually claims

Two additions move this network from "one machine, honestly described" toward
the spec's decentralized phase:

1. **The epoch chain** (`webapp/chain/`) — every closed epoch is sealed into a
   signed, hash-linked block: the epoch's act range, its full economic state
   (ledgers, standing, certificate, PEER distribution, balances, pools), the
   constant set, and the exact source editions that computed it.
2. **The IPFS pack** (`publish-ipfs.ps1`) — the whole site (app, act log,
   media, chain) as one content-addressed archive anyone can pin, so the
   network stays readable and *verifiable* with every machine this project
   owns switched off.

Honesty first, as everywhere in this repo: **writes are still centralized on
one host.** That is not concealed by the word "chain" — see "What is and is
not decentralized" below.

## The epoch chain

### What a block is

The epoch clock is already the only clock here: nothing advances until a
`closeEpoch` act lands in the log. At each close, the host now seals:

```
{
  v, net,                     — format and network id
  height, epoch, time,        — position; time is the closeEpoch act's own stamp
  prev,                       — hash of the previous block: the chain
  range: {start, end},        — the act indices this block covers
  acts[], actsRoot,           — structural hash per act + merkle root
  payloads[], payloadsRoot,   — payload commitment per act + merkle root
  package, stateRoot,         — the epoch's full economic state, canonically
                                encoded, and its hash
  constants,                  — θ, ν, the PEER curve, the rounding quantum
  editions,                   — sha256 of peer-engine.mjs and replay.cjs
  producer, sig               — Ed25519: who published this, attributably
}
```

The state package is what the economic layer computed at that close: every
ledger (burn, act count), every solved standing, the epoch certificate
(stamp, headroom, pass), the PEER mint and its per-creator distribution,
every token balance, every pool. All of it is derived by the same
`social/replay.cjs` the browser inlines and the host imports — the chain adds
a third reader of the one rulebook, not a second rulebook.

### What a block claims — and what it deliberately does not

A block claims exactly: *"at this epoch close, the producer named here
observed this ordered act range, computed this state from it under these
constants and these formula editions, and signs that publication."*

It does **not** decide what is true. The spec's Public-Object Replay
postulate (Appendix I) is explicit: no hash, merkle root, or content address
may carry normative meaning at Layer 1 — replay decides, hashes only carry.
A verifier who disagrees with a block does not argue with its signature; they
replay the log and publish the discrepancy. The chain makes silent rewriting
DETECTABLE and publication ATTRIBUTABLE. That is all, and it is a lot.

### Deletion does not break it

Deletion here is redaction: payload bytes leave the stored log, structure
stays. A chain that hashed whole acts would read every lawful deletion as
tampering, so each act is committed twice, the way the spec's
payload-isolation rule prescribes:

- the **structural hash** covers the act minus its payload (`text`, `media`,
  `place`), with resolved mentions materialised exactly the way redaction
  itself materialises them — invariant under every lawful deletion;
- the **payload hash** is sealed at close and simply *kept* after a
  redaction: the retained commitment residue. It proves a payload existed
  and what it was, without the bytes.

The state side needs no such care, because removal was already
scoring-neutral: a deletion moves no ledger, no standing, no minted token.
`npm test` holds all of this (`tests/chain.test.ts` — the redaction tests).

### No silent change

The block seals θ, ν, the PEER emission curve, and the sha256 of the two
files that ARE the formulas (`public/peer-engine.mjs`, `social/replay.cjs`).
Change a constant or edit the engine and the next verification says so, per
block, attributed as edition drift — the roadmap's Phase-5
constant-transparency rule, implemented.

Numbers are committed under a declared encoding: canonical JSON (sorted
keys, shortest round-trip decimals, non-finite values refused) with every
inexact value rounded to the quantum published in the block (1e-9). That is
the spec's canonical-publication postulate: two verifiers either match bits
or can attribute the difference — no third outcome.

### Using it

```bash
node chain/build.mjs              # seal every closed epoch (incremental, refuses forks)
node chain/verify.mjs             # replay everything, check every root and signature
node chain/build.mjs --rebuild    # reseal from genesis — byte-identical if nothing changed
node chain/verify.mjs --acts ../site/archive/acts.jsonl --chain ../site/archive/chain/blocks.jsonl
                                  # verify the PUBLISHED archive with no host's help
```

The host seals automatically at every `closeEpoch` (off the request path;
mirrors never seal — a mirror signing blocks would be a second writer wearing
a different hat) and publishes:

- `GET /api/chain` — every block, height order
- `GET /api/chain/head` — the tip and the producer key

The producer key lives in `server-data/chain/producer.pem`, next to the log
it attests, and is never served, synced, or exported. It signs epoch blocks
and does only that: this codebase still holds no wallet and no spendable key.

## The IPFS pack

```powershell
.\publish-ipfs.ps1        # build app, refresh archive + chain, pack a CAR
```

This produces `webapp/dist/peer-site.car` and prints its root CID. It
**publishes nothing by itself** — pinning is the deliberate, separate step:

```bash
ipfs dag import dist/peer-site.car && ipfs pin add <cid>    # your own node
# or upload the .car to any pinning service (Pinata, Filebase, web3.storage)
```

Then the whole network is at `https://<gateway>/ipfs/<cid>/` — the app, the
log, the media, the chain. The pack is deterministic: same site bytes, same
CID, same CAR bytes, on any machine — pinned to kubo's own defaults (CIDv1,
raw leaves, 256 KiB chunks, width-174 balanced DAG), so a mirror operator can
rebuild the pack from the published site and *know* it is the same site
before fetching a byte from anyone.

What a visitor gets from a gateway: the app probes `host.json` for live
hosts, and when none answers it loads the packed archive — the real network,
read-only, with the chain sitting beside it for anyone who wants to check
the numbers rather than trust them. Prefer the subdomain gateway form
(`https://<cid>.ipfs.<gateway>/`): it gives the app its own origin, so
browser storage is not shared with every other site on that gateway.

### What a snapshot carries — read before the first pin

The act log is public by design, and the archive has been published on Pages
all along. But **an IPFS pin is a ratchet**: content under a CID that others
pin cannot be recalled, ever. Two things in today's log deserve a conscious
decision before the first pin, not after:

- the log contains **PIN hashes** (unsalted SHA-256) for secured handles —
  offline-guessable for short PINs, forever, by anyone holding the snapshot;
- **DMs are plaintext** in the log, and the page says so — but "public on a
  tunnel you can turn off" and "immutable under a content address" are
  different bargains.

Redaction-after-pin removes bytes from *future* packs only. If that risk
reads as too sharp, pin with `-SkipMedia`, or wait for keypair auth to
replace PINs before the first public pin.

## What is and is not decentralized

| | state |
|---|---|
| the app | anyone can host it: Pages, any static server, any IPFS gateway |
| the record | anyone can hold it: archive + CAR; integrity by hash, not trust |
| the numbers | anyone can check them: replay + the chain's signed roots |
| reads | mirrors, archive, IPFS — no single machine required |
| **writes** | **one host, one writer — unchanged, and stated plainly** |

The chain realizes four of the spec's five substrate postulates for the
record as published — public accessibility, record integrity, irrevocability,
epoch edge-set provision — and pins the fifth (authoritative ordering) to a
*named, signed* single producer rather than an anonymous file on one disk.

The step that would decentralize writes is the one HOSTING.md has always
named: **content-addressed act ids**. Acts reference each other by log index
today, so two writers' logs cannot merge; ids derived from content would let
independent logs converge under canonical order and make the producer role
rotatable. That is the authored-act substrate of roadmap Phase 3/4 — a
migration, not a patch, and it is still ahead, not smuggled in here.

Until then, the honest formula: **one writer, whom you no longer have to
trust about the past.** A producer can still choose what enters the log
(censorship is visible to its victims); it can no longer rewrite what it
already published without every holder of one block being able to prove it.

## Known limits, stated rather than hidden

- **Cross-engine float reproducibility.** The standing solve uses
  transcendental math; V8-to-V8 replay reproduces bit-for-bit (the rebuild
  test proves it), other engines may land ±1 ulp. The 1e-9 quantum absorbs
  that in practice; the spec's own frontier entry (canonical-standing-replay)
  owns the full answer.
- **PEER distribution is sybil-farmable** on this test network, per
  TOKEN.md's own numbers. The chain seals that distribution honestly; it
  does not fix its economics.
- **`closeEpoch` is communal and unauthenticated** — anyone may close an
  epoch at any time. The chain seals whatever the log says; boundary policy
  is a calibration obligation (spec G.2), not a chain feature.
- **The producer key is a file on the primary.** Compromise of that machine
  is compromise of the signature — not of the record (replay still catches
  a rewrite), but of attribution going forward.

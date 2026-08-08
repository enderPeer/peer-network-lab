# Decentralization: the chain, the CAR, and what each one actually claims

Three additions move this network from "one machine, honestly described"
toward the spec's decentralized phase:

1. **The epoch chain** (`webapp/chain/`) — every closed epoch is sealed into a
   signed, hash-linked block: the epoch's act range, its full economic state
   (ledgers, standing, certificate, PEER distribution, balances, pools), the
   constant set, and the exact source editions that computed it.
2. **The IPFS pack** (`publish-ipfs.ps1`) — the whole site (app, act log,
   media, chain) as one content-addressed archive anyone can pin, so the
   network stays readable and *verifiable* with every machine this project
   owns switched off.
3. **The writer election** (`chain/election.mjs`, `reconcile.mjs`,
   `merge.mjs`) — the writer is an office, not a machine: federated hosts
   elect it, liveness rotates it, any mirror can inherit it, and a fork
   heals by deterministic rebase.

Honesty first, as everywhere in this repo: **writes still pass through
exactly one host at a time — an elected, rotating office now, but never
concurrent.** That is not concealed by the word "chain" — see "What is and
is not decentralized" below.

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

## The writer is an office, not a machine

One writer at a time is still the law — two simultaneous writers fork the
log. What changed is WHO holds the pen and what happens when it drops:

**Election** (`chain/election.mjs`). Federated hosts rank each other by the
longest sealed chain, then the longest log, then the most distinct authors
in the last hour of the public record, then a meaningless stable tiebreak.
Every ranking field is verifiable from data the candidate already serves —
an election two honest observers cannot disagree about. A mirror that
cannot reach its primary (both by probe and by its own sync loop) promotes
itself once it ranks first; the client follows automatically, because a
demoted host names the current writer in its refusal and the app retries
there — but only to an address the published `host.json` vouches for, since
following a stranger would post the user's PIN to it.

Four rules hold it up, and every one of them is a bug that was found and
closed rather than a principle stated up front:

1. **Silence is not a mandate.** A federated host that has heard from no
   peer does not write — quarantine lifts on a successful probe round,
   never on a failed one. Otherwise a watchdog restart *inside* a partition
   hands the isolated side a second pen, which is the exact split the
   feature exists to prevent. A genuinely last-host-standing is promoted
   deliberately by its operator (stop, delete `role.json`, unset the
   federation, restart), and the log says so while it waits.
2. **An incumbent keeps the pen.** A seated writer yields only to a
   *strictly longer* record; a host still in boot quarantine yields to any
   live writer whose record is *at least as long*. Conflating those two
   thresholds made two identical hosts demote into each other's mirrors —
   a network nobody could write to.
3. **Never follow someone who follows you.** A peer that reports it mirrors
   anyone is not a writer, and a host that finds itself set to mirror
   *itself* drops the role and re-decides. Without this, a
   restored-from-backup primary and its mirror seated each other forever.
4. **Claims are checked, not believed.** A peer's advertised numbers only
   start a handover. Before yielding, the host fetches the record and
   verifies what was actually delivered — length, shared prefix, and the
   sealed chain — with a byte ceiling on every federation fetch. Anyone can
   claim a million acts; nobody can produce them on demand. Roster
   addresses coming from a network-fetched `host.json` are stripped to bare
   origins and may not point at private or loopback ranges: that list is
   untrusted input aimed at a `fetch()`.

**Boot quarantine.** The two-writer split always began the same way: a
watchdog restarting a stale primary that took writes it should not. A
federated primary now starts read-only and asks the federation before its
first act. `role.json` outranks `PEER_MIRROR_OF` on restart, so a stale
environment variable cannot resurrect a role the election already retired.

**Two signed histories freeze the host.** If a returning host and the
winner both sealed blocks the other does not have, nothing is adopted and
nothing is written: the host says so and waits for a person. Code does not
choose between two attributable records — the same rule `reconcile.mjs`
enforces for merges.

**Fork healing** (`chain/reconcile.mjs`, `chain/merge.mjs`). A partition
can still produce two writers — CAP is not negotiable — but "there is no
merge" is no longer true. References only point backward, so the losing
tail rebases deterministically onto the longer log: content ids and act
indexes are rewritten through the same replay everyone runs, whatever no
longer applies is dropped WITH a reason, and the demoted host saves its
diverged tail to a fork file before yielding. One command heals it:

```bash
node chain/merge.mjs --base acts.jsonl --fork fork-<ts>.jsonl --apply
```

Same inputs, same merged bytes, on any machine. What the merge refuses, and
says out loud rather than papering over: a handle registered on both sides
(an id is a name, not a position — the losing registration is dropped, or
its PIN would overwrite the winner's), an advert that cannot be told apart
from its own retry, and any merge across DIVERGED SEALED blocks. Carried
epoch closes are renumbered into one sequence, because two writers both
closing "epoch 61" would mint two full PEER pools for one epoch. Anything
that lands in the log but no longer *applies* — a message its author can no
longer afford, an rsvp to an event that filled on the winning side — is
reported as effect-lost rather than vanishing quietly.

To federate a host: set `PEER_FEDERATION` (comma-separated peer URLs), or
drop `server-data/federation.json` (`{"urls":[...]}`), or set
`PEER_SITE_URL` so the roster comes from the published site's `host.json` —
every static mirror carries the same file, so discovery has no single home.
A host with none of these behaves exactly as before.

## What is and is not decentralized

| | state |
|---|---|
| the app | anyone can host it: Pages, any static server, any IPFS gateway |
| the record | anyone can hold it: archive + CAR; integrity by hash, not trust |
| the numbers | anyone can check them: replay + the chain's signed roots |
| reads | mirrors, archive, IPFS — no single machine required |
| **writes** | **one writer at a time — but the writer is now an elected, rotating office, and a fork heals by deterministic rebase instead of being forever** |

The chain realizes four of the spec's five substrate postulates for the
record as published — public accessibility, record integrity, irrevocability,
epoch edge-set provision — and pins the fifth (authoritative ordering) to a
*named, signed* producer whose office now rotates by election, each handoff
attributable in the chain itself (`verifyChain` reports every producer
change).

Still ahead, and still named rather than smuggled: **content-addressed act
ids** (roadmap Phase 3/4). Today's reconciliation rewrites position-based
references at merge time; ids derived from content would make acts location-
independent from birth, shrink merges to set union under canonical order,
and open the door past one-writer-at-a-time entirely. What exists now is the
honest middle: **an elected writer, whom you no longer have to trust about
the past, holding an office any participant can inherit.** Known limits of
the election, stated plainly: the active-author count can be inflated only
with real acts (which cost θ), but registrations are cheap on this test
network — the same sybil surface TOKEN.md already documents; and a
partition elects one writer per side until it heals, which is the price of
staying available.

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

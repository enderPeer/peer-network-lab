# Mirrors: where this project lives when any one host disappears

The network's record is an append-only log, its numbers are a replayable
formula, and its app is a static file. That means the whole thing can be
copied without permission and verified without trust. This page lists every
place a copy lives, how to reach one when another is down, and how to become
a mirror yourself. No copy below requires an account to read, and none of the
decentralized ones required an account to publish.

**One writer at a time — but the writer is an elected office.** Audited
live (2026-08-06): of every copy below, exactly one accepts new acts (the
current primary; its write door answers 400 to bad input, not 404), the
static copies (Pages, nsite, IPFS, bundles) have no write door at all, and
live mirrors answer 503 naming the current writer. That is the design, not
a gap: two simultaneous writers fork the log. What is no longer true is
that the writer is a fixed machine — federated hosts elect it (longest
sealed chain, then longest log, then liveness), a dead writer's office
passes to the best-placed mirror automatically, a stale one quarantines
itself on return, and a partition that wrote on both sides heals by
deterministic rebase (`webapp/chain/merge.mjs`). Every mirror is one
`role.json` away from holding the pen, and every copy can verify the
record it holds: replay the log and you recompute every standing, feed and
balance, then check the epoch chain's signed roots
([webapp/DECENTRALIZATION.md](webapp/DECENTRALIZATION.md)).

## The copies

| channel | address | what it is |
|---|---|---|
| Web (canonical) | https://enderpeer.github.io/peer-network-lab/ | app + landing + published archive + chain |
| GitHub | https://github.com/enderPeer/peer-network-lab | source of everything |
| Radicle | `rad:z2suiiv5cu2DWLQ1zmHG5d12Wy4pL` | the repo on a peer-to-peer network — replicated by public seed nodes and by everyone who clones it |
| IPFS | `bafybeid6p5djjo3xo256p3dw3vppx7mwpyiowc5apb6cpmzj7ygr3z3w6y` | the whole site (app, log, media, chain) under one content address |
| nsite (Nostr) | https://npub1jdtd0md8gy5zjd7gghqn9kr9jekmczp6hc3spy5n5nftvdd47urq8px80w.nsite.lol/ | the site published as signed Nostr events + hash-addressed blobs |
| Software Heritage | https://archive.softwareheritage.org/browse/origin/?origin_url=https://github.com/enderPeer/peer-network-lab | permanent academic archive of the git history |
| Snapshot release | https://github.com/enderPeer/peer-network-lab/releases | one-file `git bundle` + IPFS `.car` + torrent (magnet link in the release notes) |

### Reaching each one

**Radicle** — with Radicle installed (`rad clone rad:z2suiiv5cu2DWLQ1zmHG5d12Wy4pL`),
or with plain git, no Radicle needed:

```bash
git clone https://iris.radicle.network/z2suiiv5cu2DWLQ1zmHG5d12Wy4pL.git
```

Browse it at
https://radicle.network/nodes/iris.radicle.network/rad:z2suiiv5cu2DWLQ1zmHG5d12Wy4pL

**IPFS** — from any gateway once at least one node pins it:

```
https://bafybeid6p5djjo3xo256p3dw3vppx7mwpyiowc5apb6cpmzj7ygr3z3w6y.ipfs.dweb.link/
```

Prefer the subdomain form above: it gives the app its own origin, so your
browser storage is not shared with every other site on the gateway. The CID
is deterministic — rebuild the pack from any copy of the site
(`webapp/publish-ipfs.ps1`) and you must get this exact CID, which is how
you know a gateway handed you the real thing.

**nsite** —
https://npub1jdtd0md8gy5zjd7gghqn9kr9jekmczp6hc3spy5n5nftvdd47urq8px80w.nsite.lol/
(the npub works on any nsite gateway, not just this one; the address
survives any single gateway's death). The blobs are sha256-addressed, so
anyone can re-upload them to more Blossom servers and the site heals —
same hash, same address.

**Snapshot** — download `peer-network-lab.bundle` from the release, then:

```bash
git clone peer-network-lab.bundle peer-network-lab
```

That is the entire project — code, site, archive, history — from one file,
offline.

## Becoming a mirror

Any one of these makes the project harder to lose. Pick by effort:

- **One command, one-off** — pin the site on IPFS:
  `ipfs dag import peer-site.car && ipfs pin add bafybeid6p5djjo3xo256p3dw3vppx7mwpyiowc5apb6cpmzj7ygr3z3w6y`
  (the `.car` is in the release, or rebuild it from the site). While your
  node runs, you are a host.
- **One command, ongoing** — seed the repo on Radicle: `rad seed
  rad:z2suiiv5cu2DWLQ1zmHG5d12Wy4pL` (cloning already seeds by default).
- **Any torrent client** — keep the release torrent seeding. The magnet is
  in the release notes; the GitHub download URL doubles as a webseed, so the
  torrent stays alive even with no human seeds while GitHub lives.
- **A machine that stays on** — run a live mirror of the act log itself:
  the runbook is [webapp/HOSTING.md](webapp/HOSTING.md). Mirrors serve
  readers when the primary is down and hold complete, verified copies of
  log + media — and a federated mirror is in the line of succession: if the
  writer dies, the election seats the best-placed mirror automatically.
  Running a mirror IS hosting the network.

## If everything above is down

Any surviving copy — a git clone, the bundle, a pinned CAR, one mirror's
`server-data/` — contains the complete network. Recovery is:

1. get the code (clone from any channel above),
2. verify the record you hold: `node webapp/chain/verify.mjs --acts
   site/archive/acts.jsonl --chain site/archive/chain/blocks.jsonl` — no
   host's help needed,
3. host it anywhere static for readers, and follow
   [webapp/HOSTING.md](webapp/HOSTING.md) to bring a writer back for
   participants.

The identifiers in this file are reproducible or keypair-bound: the IPFS CID
can be rebuilt and checked by anyone from the site bytes; the Radicle RID
and the nsite npub belong to their keys, so updates under those names are
signed; the Software Heritage archive can be re-triggered by anyone, no
account, at https://archive.softwareheritage.org/save/.

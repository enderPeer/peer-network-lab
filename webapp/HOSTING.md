# Running the network on your own machine

The act log is the network. Everything else — standings, feeds, the chronicle
— is a pure function of it, so hosting is mostly about keeping one log safe
and reachable, and about never letting a second machine write to it.

**The one rule: one network, one writer.** A mirror reads everything and
writes nothing. Two hosts accepting acts fork the log the moment both are
reachable, and there is no merge — the acts are ordered, and two orders are
two networks. Everything below exists to make that impossible by accident.

## The shape

| | primary | mirror (fallback) |
|---|---|---|
| accepts acts | yes | no — answers `503` naming the primary |
| serves the record | yes | yes |
| log + media | authoritative | synced every 5s |
| snapshots | on rewrite | seven rolling daily copies |
| set by | no `role.json`, or empty `mirrorOf` | `role.json` with `mirrorOf` |

The app reads `host.json` from the permanent address and probes `urls` **in
order**: primary first, mirror second. The mirror therefore only ever answers
people the primary has already failed. When neither answers, the app runs its
own private copy of the network in the browser — the address is never dead.

## The writer is elected now

Everything below still works by hand, but a FEDERATED host does it by
itself. Give each host the others' addresses — `PEER_FEDERATION` (comma
URLs), or `server-data/federation.json` (`{"urls":[...]}`), or
`PEER_SITE_URL` pointing at the published site so the roster comes from its
`host.json` — and:

- a **mirror** whose primary stops answering (checked two independent ways:
  the election probe on `/api/election` and its own act-sync loop) promotes
  itself once it ranks first — longest sealed chain, longest log, most
  distinct authors in the last hour of the public record, stable tiebreak;
- a **primary** that starts up checks the federation BEFORE accepting its
  first act (boot quarantine), and stays read-only until at least one peer
  answers — silence is not permission, because a restart inside a partition
  is exactly when writing would fork the network. `role.json` outranks
  `PEER_MIRROR_OF`, so a stale environment variable cannot undo an election;
- if a host is genuinely the **last one left** and the federation is gone
  for good, promotion is deliberate: stop it, delete `server-data/role.json`,
  unset `PEER_FEDERATION`, restart. The host prints this instruction itself
  while it waits;
- a live primary that MEETS a strictly longer record demotes itself to a
  mirror of the winner. If it wrote past the split, its unsynced tail is
  saved to `server-data/fork-<ts>.jsonl` first, and the log prints the one
  command that heals it: `node chain/merge.mjs --base <winner's acts.jsonl>
  --fork <fork file> --apply` — a deterministic rebase of the losing tail,
  same merged bytes on any machine, with a report of anything dropped;
- the app follows the pen on its own: a demoted host's refusal names the
  current writer, and the client retries there.

Tuning: `PEER_ELECTION_INTERVAL` (default 15s) and `PEER_PROMOTE_AFTER`
(default 8 consecutive failed probes ≈ 2 minutes). A host with no
federation configured behaves exactly as this file always described.

## Moving to a dedicated machine

Do it in this order. The new machine proves itself as a mirror first; nothing
is switched over until the record is provably complete.

### 1. On the new PC — start as a mirror

```powershell
git clone https://github.com/enderPeer/peer-network-lab.git
cd peer-network-lab\webapp
.\setup-host.ps1 -MirrorOf https://<current-primary-url>
```

That checks the prerequisites (node ≥ 18, cloudflared, and whether the machine
is set to fall asleep — the most common reason a home server "randomly" stops
answering), installs, builds, writes the role, starts host + tunnel +
watchdog, and waits until the mirror reports the same act count as the
primary. It prints the publish command for its own URL.

### 2. Publish it as the fallback

```powershell
.\publish-site.ps1 -UpdateSlot fallback -HostUrl https://<new-machine-url>
```

`-UpdateSlot` reads the currently published `host.json` first and changes only
its own slot, so neither machine can wipe the other's entry. From here the
network already survives the old machine dying: readers fall through.

### 3. Let it run

A day is plenty. Check it is keeping up:

```bash
curl -s https://<new-machine-url>/api/acts?since=999999
```

`total` must track the primary and `mirror` must name it. The host log says
`[mirror] in sync` once, and says so again after any outage — it is quiet
while things are fine.

### 4. Swap the roles

On the **old** machine, stop the host so it cannot take writes:

```powershell
Get-Process node | Where-Object { $_.CommandLine -match 'server.mjs' } | Stop-Process
```

On the **new** machine, promote it and restart:

```powershell
Remove-Item server-data\role.json
.\setup-host.ps1
```

Then publish the swap — new machine primary, old machine fallback:

```powershell
.\publish-site.ps1 -HostUrl https://<new-machine-url> -FallbackUrl https://<old-machine-url>
```

Finally turn the old machine into the mirror it now is:

```powershell
.\serve-public.ps1 -MirrorOf https://<new-machine-url>
```

The old log stays on disk. It is reconciled against the new primary on the
first sync, and it remains a full offline copy of everything up to the swap.

## Emergency promotion

The primary is gone and not coming back. On the mirror:

```powershell
Remove-Item server-data\role.json
.\setup-host.ps1
.\publish-site.ps1 -UpdateSlot primary -HostUrl https://<this-machine-url>
```

**Before promoting, make sure the old primary cannot come back up.** A
watchdog that restarts it after you have promoted the mirror gives you two
writers, which is the one failure this design cannot repair. If the old
machine is merely unreachable rather than dead, stop its watchdog first.

Acts written to the old primary after the mirror's last successful sync are
lost. That window is the sync interval — seconds — and it is the honest cost
of not having a consensus protocol here.

## What is actually backed up

- **`acts.jsonl`** — the network. Synced continuously; the mirror keeps seven
  rolling daily snapshots (`acts.jsonl.daily-0` … `-6`, one per weekday).
- **`media/`** — content-addressed blobs, pulled on demand and **verified**:
  a blob that does not hash to its own filename is not written, whatever the
  primary claims.
- **Deletions propagate.** Redaction rewrites lines that were already synced,
  so the mirror detects a shrink or a tombstone and re-adopts the whole log. A
  backup that quietly refused to forget would be a liability, not a backup —
  there is a test for exactly this.

Not backed up, deliberately: PINs (they exist only as hashes inside the log),
call signalling and the live registry (both in memory, both ephemeral by
design), and view counts (telemetry, never protocol).

## Keeping a home server up

- **Disable sleep.** `powercfg /change standby-timeout-ac 0`. `setup-host.ps1`
  warns when this is not set.
- **The watchdog** (`watchdog.ps1`, started automatically) restarts host and
  tunnel every 30s if either dies. It reads the role from `role.json`, so a
  restart can never turn a mirror into a second writer.
- **Quick tunnels mint a new URL on every restart.** After an unattended
  tunnel restart, republish that machine's slot with `-UpdateSlot`. A named
  Cloudflare tunnel with your own domain removes this entirely and is the
  right next step for a permanent server.
- **Ports:** nothing needs forwarding. The tunnel dials out.

## Environment

| variable | meaning |
|---|---|
| `PEER_DATA_DIR` | where the log lives — **use this for anything destructive** |
| `PEER_BTC_ADDRESS` | receive address for paid placements. **Paste it from your own wallet** — see below. Checksum-validated at boot; a bad one turns adverts off rather than displaying it |
| `PEER_AD_SATS_PER_DAY` | price per day, default 20000 sats |
| `PEER_AD_RATE` | advert proposals per hour per address, default 6 |
| `PEER_MIRROR_OF` | run as a read-only mirror of that URL (overrides `role.json`; the file is what survives restarts) |
| `PEER_MIRROR_INTERVAL` | sync period in ms, default 5000, floor 300 |
| `PEER_OPERATOR_TOKEN` | opens the operator panel at `/admin` and lets the operator set a first PIN on a handle that has already posted. **Without it there is no admin surface at all** — not an open one |
| `PEER_ACT_RATE` | acts per minute per IP, default 20 |
| `PEER_TURN_URL` / `_USER` / `_PASS` | TURN relay, without which **calls** fail between networks with no direct path. Live streaming no longer needs it — see below |
| `PEER_STREAM_ORIGINS` | extra origins allowed to open a live-stream socket, comma separated. This host's own origin, localhost and the published Pages copy are always allowed |

## The operator panel

`/admin` on any host that has `PEER_OPERATOR_TOKEN` set. Without that variable
the panel and its whole API answer `404` — closed rather than open, because an
admin surface that answers because nobody configured it is the same defect as
a rule the interface states and the code does not apply.

```powershell
$env:PEER_OPERATOR_TOKEN = 'a long random string'
node server.mjs 5210
```

The token is checked in constant time (a plain comparison leaks it one
character at a time to anyone patient enough to measure) and is accepted only
in a header — `Authorization: Bearer …` or `X-Operator-Token` — never in a URL,
where it would end up in logs, history and referrers. The page keeps it in
`sessionStorage` and nowhere else.

It shows the network (acts, actors, content, epoch, secured handles, live
streams), traffic since boot (requests by status, accepted vs refused acts,
rate-limit hits, PIN failures, peak acts/min), storage against its caps, why
acts were refused, the addresses seen, and the advert queue. It can ban and
unban an address, collect unreferenced media, and approve, reject, mark paid
or stop an advert.

### Addresses

The panel lists caller addresses with request and act counts, which handles
acted from each, and when they were last seen. Two rules hold that in place:

- **In memory only.** Capped at 800 addresses, swept after six idle hours,
  gone when the process stops.
- **Never in the act log.** That log is public at `/api/acts`; an address that
  reached it could never be taken back out. There is a test asserting no
  address appears in any public endpoint or on disk.

A ban answers `403` with the reason rather than dropping the connection. A
blocked tester who can read why can argue with it, and an abuser learning they
are blocked is not a secret worth keeping.

## Paid placements

Adverts are the one thing here that money buys, and the design is built so it
buys nothing else. An advert **is not an act**: it appends nothing to the log,
mints no node, holds no standing, is in no graph, and therefore cannot enter
any feed score — not even its own. It lives in `server-data/ads.json`, and the
card in the feed says all of this out loud. If that ever stops being true, the
network's central claim becomes marketing copy.

### The payment address is yours, not the host's

Set `PEER_BTC_ADDRESS` to a **receive address copied from your own wallet**.

This codebase contains no private key and no key generation, deliberately. A
key generated by a build would be a key that had passed through a terminal, a
log and possibly a git history — and an address whose key is not already in a
wallet you can spend from is money that arrives and cannot leave. The host only
ever displays the address; it never signs, never spends, and never holds funds.

The address is validated by its own checksum at boot (base58check and
bech32/bech32m, including the mixed-case rule). A typo turns adverts **off**
and says so in the log, rather than displaying an address whose key nobody
holds — a mistyped address is not a failed payment, it is money gone.

### Targeting, and the line it does not cross

An advertiser picks **where** (feed, live, record — or nothing, meaning
everywhere) and **what subject** (commons tags people have engaged with).

Both are matched **in the reader's browser**, not on the host. The browser
already holds the whole public act log, so it can answer "have I engaged with
#photography?" locally, and the host serves the identical advert list to
everybody. Consequences worth stating:

- No profile is built anywhere. The host never learns who saw what.
- The reader is told **why** they were shown something, in the card itself.
- It works in the offline sandbox, where there is no server to ask.
- **The address watcher is never a targeting input.** Aiming adverts by where
  someone connects from is exactly the surveillance business this network
  argues against, and that data is kept where no advertising code reaches it.

Tests assert two callers with different addresses and user agents receive
byte-identical advert lists, and that passing a reader identity to `/api/ads`
changes nothing.

### How a placement runs

1. Anyone `POST`s `/api/ads` with `{text, url, days, contact}` and gets back a
   quote — but is told plainly **not to pay yet**.
2. You read it in the panel and approve or reject it. Approval is what tells
   the advertiser to pay; nothing is automatic, because the text goes in front
   of real people.
3. They send the quoted amount. Each advert is quoted a **unique amount** — the
   day price plus a small fixed offset derived from its number — so a payment
   into one address identifies which advert it settles, without deriving fresh
   addresses from an extended key.
4. You confirm receipt in your own wallet and press *Mark paid*. It goes live
   for the days bought, then expires by itself.

The host never watches the chain. It cannot: it holds no key and no wallet, and
polling a public explorer for your address would tell that explorer your
server's IP is interested in it. Confirming a payment is one glance at the
wallet you actually control.

## Live streaming

Video does not travel between browsers. The broadcaster's browser encodes it,
sends it up one WebSocket, and this host sends it out to everyone watching.

**Why it was changed.** The old version was a WebRTC mesh, and it failed in the
field exactly as reported: viewers joined and the picture stayed black. The
host's own `/api/ice` endpoint had said why the whole time — `"relay": "none"`.
Two ends behind carrier-grade NAT, which is most mobile networks, have no route
to each other at all, and no amount of retrying finds a path that does not
exist. It also multiplied the broadcaster's upload by the size of the audience.
Relaying costs one upload from the broadcaster no matter how many watch.

**Why a WebSocket and not a plain streaming response.** Measured through the
Cloudflare quick tunnel this host runs behind: a never-ending chunked HTTP
response is released in ~128 KB bursts no matter how often the server flushes.
At 4 KB every 250 ms the first thirty-four frames arrived together after 8.65
seconds. The same frames over a WebSocket arrived flat at ~430 ms with no
bursts. A quiet webcam compresses small, so chunked HTTP would have put a
stream ten seconds behind and still called it live.

**Endpoints**

| route | what it does |
|---|---|
| `POST /api/stream/open` | authenticates the broadcaster once and returns a short-lived key. Requires a **PIN-protected** handle: a broadcast puts a face and a voice on a name, and nothing afterwards could show it was not the owner |
| `GET /api/stream/ws?role=push&s=<cid>` | the broadcaster's socket. First message is the key; media frames carry a one-byte format index |
| `GET /api/stream/ws?role=watch&s=<cid>` | a viewer's socket. First message says which formats the browser can decode |
| `GET /api/stream/list` | what is live, with formats, viewer counts and bitrate |

**Two formats, on demand.** No single container reaches every browser: iPhone
Safari will not play WebM, and Firefox cannot record MP4. So the broadcaster
streams the fast one — WebM pieces arrive every 400 ms, an MP4 fragment cannot
leave the encoder until a whole group of pictures is done, which measured at
one and a half to two seconds — and starts a second format only when somebody
joins who cannot play the first. Nobody's upload is spent on a copy nobody is
watching. Measured cost of that switch: about seven seconds before the first
picture, against 0.2 seconds for a viewer who can play what is already flowing.

**Limits**, in `stream.mjs`, derived from what this machine actually does
(~18-20 MB/s sustained out through the tunnel, measured):

| limit | value | why |
|---|---|---|
| concurrent streams | 8 | video is the only thing here that can take the upstream from everyone else |
| viewers per stream / total | 200 / 400 | ~95 viewers at 1.5 Mbps, ~250 at 600 kbps, before the line is the wall |
| broadcast bitrate | 4000 kbps summed over formats | above it the push is closed, with the number in the refusal |
| stream length | 4 hours | |
| how far back a joiner may start | 12 s or 8 MB | a joiner is given the header and the newest **keyframe**, not whatever byte was passing |
| slow viewer | 4 MB backlog, 8 s grace | then dropped with a reason, and the app rejoins at the live edge. Never a gap: a gap in a media stream is not recoverable |

**Metrics** appear in the operator panel under `stream`: counts, bytes and
rates only. No addresses, no per-viewer identity. The address watcher exists
for abuse control and this subsystem does not feed it, here as everywhere else.

**What is not proven.** iPhone playback is written against
`ManagedMediaSource` and could not be tested on a real iPhone from this
machine; it is built and said plainly rather than claimed. A Firefox
broadcaster cannot produce MP4 at all, so an iPhone cannot watch a Firefox
broadcast — the app says so instead of showing a spinner.

## Decentralisation: what works, and what this log cannot do

### The archive — the network readable with every machine switched off

```powershell
.\publish-site.ps1 -HostUrl https://<primary> -Archive -ArchiveMedia
```

This publishes the act log itself next to the app, on the same free static
hosting. When no host answers, the app loads it instead of falling back to an
empty private sandbox — which is a working app but somebody *else's* network,
with none of these people in it.

The manifest carries the act count and a SHA-256 of the file. The app **refuses
a snapshot that does not match**, because a truncated archive that looks live is
worse than none: everything computed from it would be wrong and nothing would
say so. `site/.gitattributes` stops git rewriting line endings, since a
published hash describing a file nobody receives is an integrity claim that
quietly does not hold.

This is also the security copy. Anyone can download `archive/acts.jsonl`,
replay it with `social/replay.cjs`, and get the same standings, feeds and
balances the live host computes. That is what makes it a *verifiable* copy
rather than a backup you have to trust.

### The epoch chain — the record, signed

Every `closeEpoch` now seals a block: the epoch's act range (committed so
that lawful redaction cannot break it), the full economic state (ledgers,
standing, certificate, PEER distribution, pools), the constant set and the
exact engine/replay editions, hash-linked to the previous block and signed
with the producer key in `server-data/chain/`. Published at `GET /api/chain`
and copied into `site/archive/chain/` beside the log. Anyone who holds log
plus chain can run

```bash
node chain/verify.mjs --acts site/archive/acts.jsonl --chain site/archive/chain/blocks.jsonl
```

and needs no further word from any host. What this buys, precisely: the one
writer can still choose what enters the log, but can no longer rewrite what
it already published without every holder of one block being able to prove
it. See [DECENTRALIZATION.md](DECENTRALIZATION.md).

### IPFS — the site under a content address

`.\publish-ipfs.ps1` packs the whole site — app, archive, media, chain —
into a deterministic CAR file and prints its CID. Pin that anywhere (your
own node, any pinning service) and the network is readable and verifiable at
`https://<gateway>/ipfs/<cid>/` with every machine here switched off. The
script publishes nothing by itself; read the "what a snapshot carries" note
in [DECENTRALIZATION.md](DECENTRALIZATION.md) before the first pin — a pin
is a ratchet, and today's log carries PIN hashes and plaintext DMs.

### Free infrastructure that actually works here

| what | where | cost |
|---|---|---|
| the app | GitHub Pages | free, permanent |
| the archive (log + media) | GitHub Pages, beside the app | free |
| the live host | any machine you own, behind a Cloudflare quick tunnel | free |
| read-only mirrors | any other machine, `-MirrorOf` | free |
| a permanent hostname | a named Cloudflare tunnel + a domain | domain only |

`host.json` now carries an ordered `urls` list of any length — primary first,
then every mirror — so `-Mirrors https://a,https://b` adds as many read
fallbacks as you have machines. The app walks the list top to bottom and stops
at the first that answers.

### What CANNOT be done: merging two write-accepting hosts

Not a missing feature. Acts reference each other **by index**: a deletion names
the position of the post it removes, a revision names the position of the post
it supersedes, a comment edit names the position of the comment. Merging two
logs means interleaving them, and interleaving changes every index after the
first insertion — so every deletion and every revision in the merged log would
point at a different act than the one its author meant.

That is why there is exactly one writer, and why a mirror refuses writes rather
than queueing them for reconciliation. A queue would imply a merge that cannot
be performed.

**What would unlock it: content-addressed act ids.** If each act named its
referents by a hash of their content rather than by position, the union of two
logs could be sorted into one canonical order and both sides would converge —
because replay is already a pure function of an ordered list. The specification
calls for exactly this (the authored-act substrate, Phase 3/4), and it is a
migration rather than a patch: every existing reference would have to be
rewritten once, and the whole point of this record is that it does not get
rewritten.

So the honest position today: **writes are centralised on one host, reads are
decentralised across mirrors and a free static archive, and the record itself is
portable and verifiable by anyone.** The step that would make writes
decentralised is named above rather than pretended at.

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
| `PEER_TURN_URL` / `_USER` / `_PASS` | TURN relay, without which calls fail between networks with no direct path |

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

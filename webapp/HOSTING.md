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
| `PEER_MIRROR_OF` | run as a read-only mirror of that URL (overrides `role.json`; the file is what survives restarts) |
| `PEER_MIRROR_INTERVAL` | sync period in ms, default 5000, floor 300 |
| `PEER_OPERATOR_TOKEN` | lets the operator set a first PIN on a handle that has already posted |
| `PEER_ACT_RATE` | acts per minute per IP, default 20 |
| `PEER_TURN_URL` / `_USER` / `_PASS` | TURN relay, without which calls fail between networks with no direct path |

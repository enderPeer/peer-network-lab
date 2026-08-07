# The cloud writer — a writing instance on a machine that is nobody's

When the desktop is off, the network today is *readable* (the published
archive on GitHub Pages, which the app falls back to by itself) but nobody
can post. This kit runs the same `server.mjs` on an off-machine box so the
pen survives the desktop sleeping.

It is built for the worst host imaginable — an ephemeral free-tier container
that forgets its disk and sleeps when idle — because everything better than
that is then also covered.

## The three pieces

| piece | what it does |
| --- | --- |
| `tools/cloud-writer-boot.mjs` | boot: adopt the journal branch (seconds-fresh) or the published archive (verified against manifest + chain before a byte is served). Run: start `server.mjs`, restart it if it dies. Persist: commit + push `acts.jsonl`, `media/`, `chain/` to a git branch every ~10 s. |
| `Dockerfile` | packages the above; build-time npm is only for assembling the app page — the runtime carries no node_modules. |
| `PEER_SEAL=off` (in `server.mjs`) | the keyless mode: without the producer key the chain **pauses** at its last sealed height instead of minting a new key whose blocks the producer-pinned archive would rightly refuse. The desktop seals the backlog when it returns. |

Verified end-to-end locally (2026-08-07): empty dir + empty journal →
adopted the live archive (60 blocks verified, 17 media blobs, 801 acts),
served, journalled; killed, wiped, rebooted → adopted the journal branch,
no archive fetch, served again.

## Environment

| var | meaning | default |
| --- | --- | --- |
| `PORT` | listen port (platforms inject this) | `5210` |
| `PEER_DATA_DIR` | the writable dir | `/data` in the image |
| `PEER_PERSIST_REPO` | journal repo, e.g. `github.com/enderPeer/peer-network-lab` | *(empty = no journal)* |
| `PEER_PERSIST_BRANCH` | journal branch | `writer-log` |
| `GIT_TOKEN` | fine-grained PAT, **contents: read/write on that one repo only** | — |
| `PEER_ARCHIVE_URL` | bootstrap source | the published Pages archive |
| `PEER_SITE_URL` | published site (feeds the election roster) | the Pages site |
| `PEER_PRODUCER_PEM` | the producer key PEM; **providing it re-enables sealing** | *(unset = keyless, chain paused)* |
| `PEER_OPERATOR_TOKEN` | operator panel token (optional) | — |

Never bake `GIT_TOKEN` or `PEER_PRODUCER_PEM` into the image or the repo —
platform secret store only. The boot script scrubs the token from every log
line and keeps both out of the server's environment.

## One writer at a time still holds

- The instance starts with `PEER_SITE_URL`, so the election sees the
  published roster; a freshly returned desktop and the cloud writer rank
  each other instead of both writing (`chain/reconcile.mjs` heals the
  overlap window deterministically).
- The liveness workflow probes candidates and repoints the published
  `host.json` writer-first; the app follows it — including mid-session.
- The **stable URL** of a cloud instance belongs in `host.json`'s
  candidates. After the first deploy, publish once from the desktop:
  `publish-site.ps1 -HostUrl <cloud url> -FallbackUrl <tunnel url>` —
  cloud primary, desktop fallback — and from then on set the desktop's
  `server-data/role.json` to `{"mirrorOf":"<cloud url>"}` so a reboot
  cannot silently become a second writer. Mirror first, promote second —
  same migration rule as ever (`HOSTING.md`).
- A non-fast-forward on the journal branch means **two instances share one
  journal** — the boot script refuses to auto-heal that on purpose; it
  stays loud in the logs until a human looks.

## Deploying (any Docker platform)

The image needs: the `webapp/` build context, one exposed HTTP port, ~256 MB
RAM, outbound HTTPS, and the env above. Sleep-on-idle platforms are fine —
the app's clients retry and reconnect by themselves, and a request wakes the
instance. Ephemeral disks are fine — that is the journal's whole job.

### Where to run it (scanned + verified against official pages, 2026-08-07)

**Recommended first: Render free web service.** The only surveyed platform
still running a real container on a genuinely free tier with **no card**:
750 instance-hours/month (a full month), stable `https://<name>.onrender.com`
URL, single instance (the one-writer rule likes that), spins down after 15
idle minutes and wakes on the next request in ~1 minute — which the app
absorbs by itself. Ephemeral disk is exactly what the journal branch exists
for. **The one real limit: 5 GB/month outbound.** Media served straight from
this host counts against it — the 51 MB media set ~100 times over. Fine for
a small tester community (content-addressed media is served `immutable`, so
repeat views cost nothing); watch it as the network grows.

Deploy: Render dashboard → New Web Service → this repo → root directory
`webapp` (it finds the Dockerfile) → add env `PEER_PERSIST_REPO`,
`GIT_TOKEN` (secret) → create. Then wire the address book as above.

**If sleep is unacceptable: Google Cloud e2-micro** — the always-free VM
(since 2017; official doc re-checked 2026-08-05): 1 GB RAM, 30 GB persistent
disk, free stable external IPv4, **no idle-reclaim policy**. Card required
at signup (never charged within limits); only 1 GB/month free egress, so
batch the journal pushes and keep media reads on Pages. Run the same image,
or plain `node tools/cloud-writer-boot.mjs` under systemd.

**Nearly-free, best pure fit: Fly.io** — stable `*.fly.dev` URL, no tunnel,
suspend-until-request with sub-second-ish resume. Card required, ~cents/month
while mostly asleep. **Benchmarks:** RackNerd promo KVM (~$11-22/year, when
in stock) and Hetzner CX23 (€5.49/month since the June 2026 price rise) buy
total absence of reclaim/sleep anxiety.

**$0 and account-free: an old Android phone on a shelf** (Termux from
F-Droid + Termux:Boot + wake-lock + the Android-12+ phantom-process fix)
runs `server.mjs` unmodified as a co-writer — same house, though, so it
covers the desktop being off, not the power being out.

**Closed doors, for honesty's sake:** GitHub Actions as a chained 24/7
writer violates the Actions terms ("serverless computing" is explicitly
disallowed — the scheduled workflows here stay what they are: probes and
archive sync). Oracle's Always Free reclaims instances this idle. Cloudflare
**named** tunnels are free and permanent but require a domain you own —
worth doing for the desktop the day a domain exists; it removes URL rotation
entirely.

## Handing the pen back

Nothing to do: while both are up, election + `host.json` order decide; when
one dies the liveness job repoints within its cadence. To retire the cloud
writer, delete the service, publish `host.json` from the desktop again, and
keep the journal branch — it is a complete, replayable copy of the record up
to its last push.

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

Platform notes and the current recommendation live in the repo discussion /
MIRRORS.md as the landscape shifts; the kit itself is platform-agnostic on
purpose.

## Handing the pen back

Nothing to do: while both are up, election + `host.json` order decide; when
one dies the liveness job repoints within its cadence. To retire the cloud
writer, delete the service, publish `host.json` from the desktop again, and
keep the journal branch — it is a complete, replayable copy of the record up
to its last push.

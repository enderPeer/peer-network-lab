# Every file-backed setting, loaded into the environment. One copy.
#
# Dot-source it, so the assignments land in the caller's scope:
#
#   . (Join-Path $here 'load-config.ps1') -DataDir $logDir
#
# WHY THIS FILE EXISTS. This block used to be pasted into each script that
# starts the host, and start-host.ps1 said so out loud: "kept in step with
# them by hand, which is a real hazard: a setting one script loads and
# another forgets changes behaviour silently on the next restart." That was
# not hypothetical. setup-host.ps1 - the script HOSTING.md gives as START
# HERE for a fresh machine, and as the promotion command in both "Swap the
# roles" and "Emergency promotion" - started the host with NONE of these
# set. server.mjs never reads these .txt files itself; they exist only to
# become environment variables, so on that path the operator token, the
# passkey origin, proof of burn and the whole on-chain surface were off,
# on a host that looked completely healthy.
#
# A promotion is exactly when nobody is watching closely, so that was the
# worst possible path for it to be missing from. Now there is one list, and
# a new launcher that forgets to dot-source this cannot quietly half-work:
# it fails the same way for every setting at once, which is noticeable.
#
# Nothing here is secret to the repository - every value lives in
# server-data\, which is gitignored, and an address baked into source is one
# nobody verified.
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  [Parameter(Mandatory = $true)][string]$DataDir
)

# name -> environment variable. Read as raw text and trimmed, because a
# trailing newline in an address is not an address.
$peerConfigFiles = @(
  @{ f = 'operator-token.txt';    v = 'PEER_OPERATOR_TOKEN' },
  @{ f = 'token-address.txt';     v = 'PEER_TOKEN_ADDR' },
  @{ f = 'btc-token-address.txt'; v = 'PEER_BTC_ADDR' },
  # THE pool: one PeerPool contract holding PEER and cbBTC. Anyone may add
  # liquidity to it and every add makes it bigger, so there is nothing to
  # choose between and nothing to enumerate - one address is the whole of it.
  # Unset means the host reads no pool AND burning PEER for reserve is off,
  # both said in words: with no pool there is no price.
  #
  # This replaced pools-address.txt (PEER_POOLS_ADDR) and its companion
  # pools-from-block.txt, which existed because pools used to be MANY, found
  # by walking the factory's PoolCreated logs from a block an operator had to
  # supply. Nothing scans for a pool any more; both files are ignored, and a
  # host upgrading across this change can delete them along with
  # server-data\pools-scan.json.
  @{ f = 'pool-address.txt';      v = 'PEER_POOL_ADDR' },
  # The epoch chain on Base: PeerAnchor timestamps each closed epoch's block
  # id and earnings root, PeerClaim pays those earnings out as real PEER.
  # Both are OFF when unset and GET /api/token/onchain says so in words.
  @{ f = 'anchor-address.txt';    v = 'PEER_ANCHOR_ADDR' },
  @{ f = 'claim-address.txt';     v = 'PEER_CLAIM_ADDR' },
  # ONE from-block for both of those scans - the two contracts are deployed
  # in the same sitting, so use the LOWER of their two deployment blocks.
  # Err LOW: too low costs a little scanning; too high silently hides
  # everything anchored or opened before it.
  @{ f = 'epoch-from-block.txt';  v = 'PEER_EPOCH_FROM_BLOCK' },
  @{ f = 'burn-address.txt';      v = 'PEER_BURN_ADDRESS' },
  @{ f = 'btc-address.txt';       v = 'PEER_BTC_ADDRESS' },
  # The SECOND door into reserve: burning PEER instead of bitcoin. A PEER
  # burn is priced by THE pool, which is pool-address.txt above - one file,
  # because there is one pool. peerburn-factory.txt and peerburn-pool-id.txt
  # used to live here and are gone: they existed only to answer 'which pool
  # is the official one' in a world where pools were many and a NAME could
  # not answer it. An address answers it now.
  #
  # Unset means burning PEER is OFF and every route says so in words - with
  # no pool there is no price, and a host that guessed one would be inventing
  # the exchange rate at which speech is sold. Burning bitcoin is unaffected
  # and needs no pool at all.
  #
  # The block the TOKEN was deployed in - the burn scan walks the token's
  # own Transfer logs, not the pool's. Same err-LOW rule as the other
  # from-blocks: too low costs a little scanning, too high silently hides
  # burns made before it, and a burn this scan never sees is reserve
  # somebody destroyed PEER for and never received.
  @{ f = 'peerburn-from-block.txt'; v = 'PEER_PEERBURN_FROM_BLOCK' }
)

foreach ($c in $peerConfigFiles) {
  $p = Join-Path $DataDir $c.f
  if (Test-Path $p) {
    Set-Item -Path ('Env:' + $c.v) -Value ((Get-Content $p -Raw).Trim())
  }
}

# Passkeys are bound to an origin. Behind the tunnel that is the public
# hostname, not localhost, and a wrong value makes every passkey silently
# unusable - so it is read from a file rather than guessed. The id is the
# host part of the origin, derived here so the two cannot disagree.
$rpFile = Join-Path $DataDir 'rp-origin.txt'
if (Test-Path $rpFile) {
  $rp = (Get-Content $rpFile -Raw).Trim()
  $env:PEER_RP_ORIGIN = $rp
  $env:PEER_RP_ID = ($rp -replace '^https?://', '' -replace '/.*$', '')
}

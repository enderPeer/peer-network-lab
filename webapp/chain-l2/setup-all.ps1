# One command. One page. Every signature still yours.
#
# This is auto-deploy.ps1's successor, and it keeps that script's one rule
# exactly as it was: the transactions are signed in MetaMask, by you, because
# a script that could sign them would be a script holding your key and nothing
# in this repository is allowed to become that. What changes is everything
# either side of the signature. auto-deploy.ps1 opened a page, then stopped and
# asked you to read addresses off it and type them back in - and every one of
# those hand-copies is a chance to write down a real address that is the wrong
# one. Here setup.html tells this script what it deployed, this script checks
# that claim against Base itself before believing any of it, writes the files,
# and restarts the host. You press buttons in MetaMask and read what happened.
#
#   powershell -ExecutionPolicy Bypass -File .\chain-l2\setup-all.ps1
#
# WHAT IT SETS UP, IN WHICH ORDER, AND WHY THAT ORDER.
#   PeerAnchor and PeerClaim first, then every closed epoch that has something
#   to pay. That path needs PEER and nothing else, and the operator holds the
#   whole supply, so it can finish today.
#   Pools second, and only if the wallet actually holds cbBTC. A pool is PEER
#   on one side and cbBTC on the other; cbBTC has to be BOUGHT, and buying is
#   not something a script may do on your behalf, so when there is none the
#   page does not offer the step and this script says why. Neither of them
#   pretends it could get you some.
#
# WHAT IT REFUSES TO DO.
#   Handle a key, a seed phrase or a signature, in any form, for any reason.
#   Write an address it has not just read code from on Base. That is not
#   caution for its own sake: a PeerPools factory was deployed once on this
#   network with its immutable peer address set to the operator's WALLET
#   instead of the token. It is real, it has code, it answers, and every
#   createPool on it reverts forever. A 40-hex regex says yes to that address.
#   Asking the contract what it thinks its own token is says no, and this
#   script asks - of the claim contract too, where the same mistake would be
#   the same kind of permanent.
#   Replace an anchor or claim contract that is already configured without
#   asking first. A second claim contract is not an error to make quietly: the
#   epochs opened on the old one stay there, and its steward and token are
#   immutable, so nothing migrates.
#
# THE FILES IT WRITES are anchor-address.txt, claim-address.txt,
# epoch-from-block.txt, and on the pools path pools-address.txt,
# pools-from-block.txt and btc-token-address.txt. Every one is an entry in
# webapp\load-config.ps1 - the one list every launcher dot-sources - and that
# is the only reason this script is allowed to write anything. A file only one
# launcher reads configures the host until the next watchdog restart and then
# quietly stops, which is worse than never having worked.
#
# THE PROTOCOL BETWEEN THE TWO FILES, so they cannot drift apart. The listener
# is loopback-only and setup.html is written to exactly this:
#   GET  /  and  /setup.html      the page, byte for byte as fingerprinted below
#   GET  /api/setup/status        { state, note } - narration the page prints
#                                 beside its own, so one window tells the story
#   POST /api/setup/deployed      the hand-over. Cumulative and idempotent: the
#                                 page posts anchor+claim, and later posts the
#                                 same body again with pools added, so this
#                                 writes what is present and never erases what
#                                 an earlier post set.
#     { kind, v, chainId, nonce, account, token, btc,
#       builds: { anchor, claim, pools },        each "sha256:..."
#       anchor?: { address, block, tx },
#       claim?:  { address, block, tx },
#       pools?:  { address, block, tx },
#       epochFromBlock? }
#   GET  /state                   not used by the page: it is how a person can
#                                 see what this script decided, with one curl.
#
# THERE IS NO "DONE" MESSAGE, ON PURPOSE. The page never tells this script that
# an epoch was funded, and this script never asks it. It watches Base instead:
# epochInfo(n) on the claim contract, until the deposit is really there, and
# then it checks that epoch's root and total against what the host computes
# from the act log - two answers derived from completely different things, one
# a chain and one a replayed log. Agreement is worth something. The page's word
# for it would be worth nothing.
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  # Run every check, print what is configured, and stop. Nothing is served,
  # no browser opens, nothing is written. Safe to run any time.
  [switch]$PreflightOnly,
  # Serve and wait, but do not open a browser - for a machine where the wallet
  # lives in a browser that is not the default one. The URL is printed; it
  # carries the nonce, so open that one and not a bare port.
  [switch]$NoBrowser,
  # Answer "yes" in advance to the question about replacing an anchor or claim
  # contract that is already configured. There is no flag for skipping the
  # on-chain checks, and there will not be one.
  [switch]$ReplaceExisting,
  # 0 picks the first free port in a small range.
  [int]$Port = 0,
  # How long to wait with nothing happening before giving up and printing the
  # ledger. A browser that was closed looks exactly like a browser nobody has
  # touched yet, so time is the only signal there is.
  [int]$IdleMinutes = 20
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # chain-l2
$webapp = Split-Path -Parent $here                            # webapp
$logDir = Join-Path $webapp 'server-data'

$CHAIN_ID = 8453                                              # Base
$RPC = $env:PEER_L2_RPC
if (-not $RPC) { $RPC = 'https://mainnet.base.org' }
# The host, where it always is. Overridable only so the refusal path can be
# exercised without stopping the real one; the files this script writes are
# still the ones webapp\server-data holds and the host reads.
$HOSTBASE = $env:PEER_HOST_BASE
if (-not $HOSTBASE) { $HOSTBASE = 'http://localhost:5210' }
$CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'         # cbBTC on Base, 8 decimals
$ADDR_RE = '^0x[0-9a-fA-F]{40}$'
$ZERO_ADDR = '0x0000000000000000000000000000000000000000'

# Hardcoded 4-byte selectors, each with the signature it is the hash of, taken
# from the `hashes` table solc itself writes into the build.json files beside
# this script. No ABI library and no keccak in PowerShell: the house rule
# everywhere in this repo, and an auditor checks these against the compiler's
# word rather than against a dependency.
$SEL_anchorOf   = '0x75834a61'   # anchorOf(address,uint256)
$SEL_claimToken = '0xfc0c546a'   # token()
$SEL_steward    = '0x637eea19'   # steward()
$SEL_epochInfo  = '0x3894228e'   # epochInfo(uint256)
$SEL_poolsPeer  = '0x11cda415'   # peer()
$SEL_poolsBtc   = '0xa28d57d8'   # btc()
$SEL_balanceOf  = '0x70a08231'   # balanceOf(address)

function Say($m) { Write-Output $m }

# Everything below that both narrates and answers puts its answer in
# $script:reply rather than returning it. In PowerShell a function's output IS
# its return value, so a `return @{ ok = $false }` from a function that has
# also called Say hands the caller an ARRAY of narration with the answer at the
# end - and the page would have been sent that array as its JSON. This is not a
# style preference; it is the shape of the language, and the two jobs have to
# be kept in different channels.
$script:reply = $null
$script:replyCode = 200
$script:hostBackUp = $false

# The ledger. Every irreversible thing gets one line here the moment it is
# true, so that whichever way the run ends - finished, refused, browser closed,
# MetaMask rejected - the last thing printed is an accurate account of what
# landed rather than a guess about what probably did.
$script:landed = New-Object System.Collections.ArrayList
function Landed($m) { [void]$script:landed.Add($m); Say ('  + ' + $m) }

function Fail($lines) {
  Say ''
  foreach ($l in $lines) { Say $l }
  Say ''
  Say 'Nothing was written and nothing was restarted.'
  exit 1
}

# -- small helpers over the chain and the host ----------------------------
function Rpc($method, $paramsJson) {
  $body = '{"jsonrpc":"2.0","id":1,"method":"' + $method + '","params":' + $paramsJson + '}'
  $r = Invoke-RestMethod -Uri $RPC -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 25
  if ($r.error) { throw ($method + ' was refused by the RPC: ' + $r.error.message) }
  return $r.result
}
function EthCall($to, $data) {
  return (Rpc 'eth_call' ('[{"to":"' + $to + '","data":"' + $data + '"},"latest"]'))
}
function Has-Code($addr) {
  $c = Rpc 'eth_getCode' ('["' + $addr + '","latest"]')
  if (-not $c) { return $false }
  return (([string]$c).Length -gt 2)
}
# The low 20 bytes of a returned word, as an address. Lowercase on purpose:
# every comparison in this script is between lowercase strings, because the
# checksum casing a wallet shows is keccak-based and nothing here hashes.
function Word-Addr($word) {
  $h = ([string]$word)
  if ($h.Length -lt 40) { return '' }
  return ('0x' + $h.Substring($h.Length - 40).ToLowerInvariant())
}
function Word-Uint($hex64) {
  return [System.Numerics.BigInteger]::Parse(('0' + $hex64), [System.Globalization.NumberStyles]::HexNumber)
}
function Pad-Addr($addr) { return ('0' * 24) + $addr.ToLowerInvariant().Substring(2) }
function Pad-Uint($n) { return ('{0:x}' -f [int64]$n).PadLeft(64, '0') }

function Get-Json($url, $timeout) { return (Invoke-RestMethod -Uri $url -TimeoutSec $timeout) }
function Host-Answers() {
  try { $null = Get-Json ($HOSTBASE + '/api/v1/state') 5; return $true } catch { return $false }
}
function Read-Cfg($name) {
  $p = Join-Path $logDir $name
  if (-not (Test-Path $p)) { return $null }
  $v = (Get-Content $p -Raw).Trim()
  if ($v -eq '') { return $null }
  return $v
}
function Write-Cfg($name, $value) {
  Set-Content -Path (Join-Path $logDir $name) -Value $value -Encoding Ascii
  Landed ('server-data\' + $name + '  ' + $value)
}
function Shown($v) { if ($v) { return $v } else { return '(not set)' } }

# Copied out of auto-deploy.ps1 rather than shared, because the two scripts
# must be able to disagree about nothing: this is the same normalisation
# build-deploy-page.js uses in Node - trim, lowercase, hash the ASCII - so a
# fingerprint computed in .NET and one computed in JS are the same number, or
# the artifacts really did differ.
function Get-BytecodeFingerprint($jsonPath) {
  if (-not (Test-Path $jsonPath)) { return $null }
  $j = Get-Content -Raw -Path $jsonPath | ConvertFrom-Json
  if (-not $j.bytecode) { return $null }
  $norm = ([string]$j.bytecode).Trim().ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($norm)) } finally { $sha.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

Say ''
Say 'PEER one-click setup'
Say '===================='
Say ('chain ' + $CHAIN_ID + ' (Base) via ' + $RPC)
Say ''

# -- 1. Preflight. Refuse early, in a sentence, rather than late ----------
# Everything here fails the run before a browser is open and before a byte is
# written. The order is deliberate - cheapest and most local first - so the
# message names the thing nearest to you that is wrong.

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail @(
    'ERROR: node is not on PATH.',
    'The host and the page builders are Node programs. Install Node 18 or newer.'
  )
}

$artifacts = @('PeerAnchor.build.json', 'PeerClaim.build.json', 'PeerPools.build.json', 'PeerToken.build.json')
$missing = @()
foreach ($a in $artifacts) { if (-not (Test-Path (Join-Path $here $a))) { $missing += $a } }
if ($missing.Count -gt 0) {
  Fail @(
    ('ERROR: these compiled artifacts are not in chain-l2\: ' + ($missing -join ', ')),
    'They are what gets deployed, so there is nothing to check the page against.',
    'Rebuild them:  node chain-l2\build-epoch.js   and   node chain-l2\build-pools.js'
  )
}

# The page. Read once into bytes, and served later from those same bytes, so
# unlike auto-deploy.ps1 - which had to check a page some other process was
# serving, and could not be certain the bytes it checked were the bytes you saw
# - there is no gap here between what was fingerprinted and what MetaMask is
# handed. Nothing is rewritten into the file either: where the page should
# point is passed in the URL, which the page prefers over its own metas.
# PEER_SETUP_PAGE exists so this script can be tested before the page is built;
# it smuggles nothing past the check, because the check runs on whatever page
# is served, wherever it came from.
$pagePath = $env:PEER_SETUP_PAGE
if (-not $pagePath) { $pagePath = Join-Path $here 'setup.html' }
if (-not (Test-Path $pagePath)) {
  $builder = Join-Path $here 'build-setup-page.js'
  $lines = @(
    ('ERROR: there is no page to open - ' + $pagePath + ' is not here.'),
    'This script is the runner; the page is what MetaMask talks to.'
  )
  if (Test-Path $builder) { $lines += 'Build it:  node chain-l2\build-setup-page.js' }
  else { $lines += 'Neither the page nor chain-l2\build-setup-page.js is in this checkout.' }
  Fail $lines
}
$pageBytes = [System.IO.File]::ReadAllBytes($pagePath)
$pageText = [System.Text.Encoding]::UTF8.GetString($pageBytes)

# The same check auto-deploy.ps1 makes for the pools factory, extended to all
# three contracts this page can deploy, and for the same reason: a stale copy
# of the page deploys a PREVIOUS immutable contract, silently, with real gas,
# over an interface the host's calls would not reach. PeerAnchor and PeerClaim
# are required because this flow deploys them. PeerPools is checked when the
# page carries its fingerprint, and demanded when the page carries the pools
# BYTECODE without one - a page that can deploy a factory has to say which
# factory that is.
$wantAnchor = Get-BytecodeFingerprint (Join-Path $here 'PeerAnchor.build.json')
$wantClaim  = Get-BytecodeFingerprint (Join-Path $here 'PeerClaim.build.json')
$wantPools  = Get-BytecodeFingerprint (Join-Path $here 'PeerPools.build.json')
if (-not $wantAnchor -or -not $wantClaim -or -not $wantPools) {
  Fail @('ERROR: an artifact in chain-l2\ has no bytecode field. Rebuild: node chain-l2\build-epoch.js')
}
function Page-Fingerprint($name) {
  if ($pageText -match ('name="' + $name + '"[^>]*content="sha256:([0-9a-f]{64})"')) { return $Matches[1] }
  return $null
}
$sawAnchor = Page-Fingerprint 'peeranchor-build'
$sawClaim  = Page-Fingerprint 'peerclaim-build'
$sawPools  = Page-Fingerprint 'peerpools-build'

$mismatch = @()
if (-not $sawAnchor) { $mismatch += '  peeranchor-build:  the page carries no fingerprint at all' }
elseif ($sawAnchor -ne $wantAnchor) {
  $mismatch += ('  peeranchor-build:  page ' + $sawAnchor)
  $mismatch += ('                     here ' + $wantAnchor)
}
if (-not $sawClaim) { $mismatch += '  peerclaim-build:   the page carries no fingerprint at all' }
elseif ($sawClaim -ne $wantClaim) {
  $mismatch += ('  peerclaim-build:   page ' + $sawClaim)
  $mismatch += ('                     here ' + $wantClaim)
}
if ($sawPools -and $sawPools -ne $wantPools) {
  $mismatch += ('  peerpools-build:   page ' + $sawPools)
  $mismatch += ('                     here ' + $wantPools)
}
if (-not $sawPools) {
  # A distinctive slice of the compiled factory, not its first bytes - every
  # solc output starts alike, and a marker that matches every contract catches
  # nothing.
  $poolsJson = Get-Content -Raw -Path (Join-Path $here 'PeerPools.build.json') | ConvertFrom-Json
  $poolsCode = ([string]$poolsJson.bytecode).Trim().ToLowerInvariant()
  if ($poolsCode.Length -gt 400) {
    $marker = $poolsCode.Substring(200, 64)
    if ($pageText.ToLowerInvariant().Contains($marker)) {
      $mismatch += '  peerpools-build:   the page embeds the pools bytecode but names no fingerprint for it'
    }
  }
}
if ($mismatch.Count -gt 0) {
  $lines = @('ERROR: SETUP PAGE IDENTITY MISMATCH - refusing to go on.', '')
  $lines += ('The page at ' + $pagePath + ' is not the one this checkout builds:')
  $lines += $mismatch
  $lines += ''
  $lines += 'Those are different contracts. Deploying is irreversible and the app would'
  $lines += 'call functions the other one does not have, so nothing is opened.'
  $lines += ''
  $lines += 'Regenerate the page:  node chain-l2\build-setup-page.js'
  $lines += 'If the .sol files changed, compile first: node chain-l2\build-epoch.js'
  Fail $lines
}
Say 'page verified against this checkout:'
Say ('  PeerAnchor  sha256 ' + $wantAnchor)
Say ('  PeerClaim   sha256 ' + $wantClaim)
if ($sawPools) { Say ('  PeerPools   sha256 ' + $wantPools) }
else { Say '  PeerPools   not offered by this page' }

# The host. Everything after this reads facts out of it - the epoch roots, the
# totals - and restarts it once the contracts exist, so a host that is down is
# a refusal now rather than a confusing failure in twenty minutes.
if (-not (Host-Answers)) {
  Fail @(
    ('ERROR: nothing is answering ' + $HOSTBASE + '/api/v1/state.'),
    'This script reads the epoch roots from the running host and restarts it when',
    'the contracts are deployed, and the page reads the same host directly. It has',
    'to be up first.',
    'Start it:  .\start-host.ps1        then run this again.'
  )
}
Say ('host up on ' + $HOSTBASE)
Say ''

# -- 2. What is already set up -------------------------------------------
# Printed before anything else happens, so a second run cannot quietly deploy
# a duplicate of something that exists. These files ARE the host's on-chain
# configuration; there is no other copy of it.
$cfgToken  = Read-Cfg 'token-address.txt'
$cfgBtc    = Read-Cfg 'btc-token-address.txt'
$cfgAnchor = Read-Cfg 'anchor-address.txt'
$cfgClaim  = Read-Cfg 'claim-address.txt'
$cfgEpochB = Read-Cfg 'epoch-from-block.txt'
$cfgPools  = Read-Cfg 'pools-address.txt'
$cfgPoolsB = Read-Cfg 'pools-from-block.txt'
Say 'already configured, from server-data\:'
Say ('  PEER token        ' + (Shown $cfgToken))
Say ('  BTC token         ' + (Shown $cfgBtc))
Say ('  PeerAnchor        ' + (Shown $cfgAnchor))
Say ('  PeerClaim         ' + (Shown $cfgClaim))
Say ('  epoch from block  ' + (Shown $cfgEpochB))
Say ('  PeerPools         ' + (Shown $cfgPools))
Say ('  pools from block  ' + (Shown $cfgPoolsB))
Say ''

if (-not $cfgToken) {
  Fail @(
    'ERROR: server-data\token-address.txt is not set, so there is no PEER token.',
    'Every check below hangs off it: PeerClaim is deployed against that address and',
    'checked against it afterwards, and an epoch is funded in that coin.',
    'Deploy or record the token first - chain-l2\auto-deploy.ps1 writes this file.'
  )
}

# -- 3. Which epochs could be funded, and which cannot -------------------
# Asked of the host rather than assumed, and then checked rather than
# believed. An epoch whose tree has no leaf can never be claimed by anybody -
# everyone who earned it was unbound when it closed - so funding it would lock
# PEER up for the whole claim window and hand it back at sweep. And an epoch
# whose leaves do not add up to its total pays first-come and then reverts for
# everyone after the money runs out. Nothing on-chain can check that sum: the
# leaves live nowhere but here, so this is the last free moment to do it. The
# page makes the same two checks in its own code. Two implementations, one
# answer, or somebody looks.
$fundable = @()
$notFundable = @()
try {
  $state = Get-Json ($HOSTBASE + '/api/v1/state') 10
  $current = [int]$state.epoch
  $first = 1
  if ($current -gt 25) { $first = $current - 24 }
  for ($n = $first; $n -lt $current; $n++) {
    try {
      $e = Get-Json ($HOSTBASE + '/api/v1/epoch/' + $n + '/claim') 20
      $leaves = [int]$e.leafCount
      $tot = [System.Numerics.BigInteger]::Parse([string]$e.total)
      $sum = [System.Numerics.BigInteger]::Zero
      foreach ($lf in $e.leaves) { $sum = $sum + [System.Numerics.BigInteger]::Parse([string]$lf.amount) }
      if ($leaves -le 0 -or $tot -le 0) {
        $notFundable += [pscustomobject]@{
          epoch = $n
          why = 'no leaf in its tree - every handle that earned it was unbound when it closed, so nobody could ever claim it'
        }
      } elseif ($sum -ne $tot) {
        $notFundable += [pscustomobject]@{
          epoch = $n
          why = ('its leaves add up to ' + $sum.ToString() + ' raw and its total says ' + $tot.ToString() + ' - a root that oversums its deposit pays first-come and reverts for everyone after, so it is not offered')
        }
      } else {
        $fundable += [pscustomobject]@{
          epoch = $n; root0x = [string]$e.root0x; total = [string]$e.total
          totalPeer = [double]$e.totalPeer; leafCount = $leaves
        }
      }
    } catch { }
  }
} catch {
  Fail @('ERROR: the host answered /api/v1/state but not the epoch reads: ' + $_.Exception.Message)
}
Say 'closed epochs:'
foreach ($f in $fundable) {
  Say ('  epoch ' + $f.epoch + '  fundable   ' + $f.totalPeer + ' PEER over ' + $f.leafCount + ' leaf/leaves, and the leaves add up to exactly that')
  Say ('                       root ' + $f.root0x)
}
foreach ($f in $notFundable) { Say ('  epoch ' + $f.epoch + '  skipped    ' + $f.why) }
if ($fundable.Count -eq 0) {
  Say '  nothing to fund. The contracts can still be deployed; an epoch becomes'
  Say '  fundable when one closes with at least one bound address in it.'
}
Say ''

# -- 4. Do not replace a live contract by accident -----------------------
$skipDeploy = $false
$allowReplace = $ReplaceExisting.IsPresent
if ($cfgAnchor -or $cfgClaim) {
  Say 'An epoch contract is ALREADY configured on this host.'
  if ($cfgAnchor) { Say ('  PeerAnchor ' + $cfgAnchor) }
  if ($cfgClaim)  { Say ('  PeerClaim  ' + $cfgClaim) }
  Say 'Deploying again gives you a second, unrelated contract: the epochs opened on'
  Say 'the old claim contract stay there, and its steward and token are immutable, so'
  Say 'nothing migrates. Almost always the right answer here is no - the page adopts'
  Say 'what exists and goes straight to funding.'
  if ($allowReplace) {
    Say 'Continuing anyway: -ReplaceExisting was passed.'
  } else {
    # Wrapped, because this script can be started with no console attached -
    # from a shortcut, from a scheduler - and there Read-Host throws rather
    # than waiting. An unanswerable question has exactly one safe answer, and
    # it is the one that changes nothing.
    $ans = ''
    try { $ans = Read-Host 'Record NEW epoch contracts over those, if the page deploys them? (yes/N)' }
    catch { Say 'No console to ask on, so taking that as no. Pass -ReplaceExisting if you meant yes.' }
    if ($ans -eq 'yes') { $allowReplace = $true }
    else { $skipDeploy = $true; Say 'Keeping the contracts above.' }
  }
  Say ''
}

if ($PreflightOnly) {
  Say 'preflight only - nothing served, nothing written.'
  exit 0
}

# -- 5. The listener, on loopback and nowhere else -----------------------
# 127.0.0.1 rather than 0.0.0.0 for two reasons that both matter. MetaMask
# refuses to inject into file:// pages, so the page has to come from an http
# origin - and this is the only http origin that no other machine can reach.
# And this listener accepts a POST that makes this script write the host's
# on-chain configuration and restart it; bound to a routable address that would
# be a remote configuration endpoint with no authentication on it.
#
# Three checks on every request, because loopback alone is not the whole story:
#   Host: must be 127.0.0.1:<port>. A page on the open internet can point a
#   name it controls at 127.0.0.1 and script requests to it from its own origin
#   - DNS rebinding - and the Host header is the one thing that attack cannot
#   forge into the literal loopback address.
#   Origin: on every POST, must be exactly the origin this script served the
#   page from. Browsers send Origin on POST whether or not it is cross-site, so
#   a POST with somebody else's, or none, is not the page this script served.
#   A nonce in the URL, echoed in the body: this is what tells THIS press from
#   another copy of setup.html left open in a tab from an older run, pointed at
#   this callback by hand. The page reads it from the query string and says out
#   loud whether it got one.
# What none of this stops is another program already running as you on this
# machine. Nothing on loopback can, and this script holds no secret worth
# taking anyway - the worst it can be made to do is offer an address that fails
# its own on-chain check a moment later.
$listener = $null
$chosen = 0
$candidates = @()
if ($Port -gt 0) { $candidates = @($Port) } else { $candidates = 8930..8949 }
foreach ($p in $candidates) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add('http://127.0.0.1:' + $p + '/')
  try { $l.Start(); $listener = $l; $chosen = $p; break } catch { }
}
if ($chosen -eq 0) {
  Fail @(
    'ERROR: could not open a loopback port for the page.',
    'Every port in 8930-8949 was taken or refused. Pin a free one: -Port 8960'
  )
}
$selfOrigin = 'http://127.0.0.1:' + $chosen
$selfHost = '127.0.0.1:' + $chosen
$rngBytes = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($rngBytes) } finally { $rng.Dispose() }
$nonce = (($rngBytes | ForEach-Object { $_.ToString('x2') }) -join '')
$pageUrl = $selfOrigin + '/?host=' + [uri]::EscapeDataString($HOSTBASE) +
           '&callback=' + [uri]::EscapeDataString($selfOrigin) + '&nonce=' + $nonce
Say ('serving the setup page at ' + $selfOrigin + '/  (loopback only)')

# -- 6. Response plumbing ------------------------------------------------
function Send-Bytes($ctx, $code, $type, $bytes) {
  try {
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = $type
    $ctx.Response.Headers['Cache-Control'] = 'no-store'
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch { } finally { try { $ctx.Response.Close() } catch { } }
}
function Send-Json($ctx, $code, $obj) {
  $json = ($obj | ConvertTo-Json -Depth 8 -Compress)
  Send-Bytes $ctx $code 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($json))
}
function Read-Body($ctx) {
  if ($ctx.Request.ContentLength64 -gt 65536) { return $null }
  $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
  try { $raw = $sr.ReadToEnd() } finally { $sr.Close() }
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}
# A named field off a JSON object, trimmed, or $null. Tolerant about which of
# two spellings arrived: "address" and "addr" are the same fact and a run
# should not die on which one somebody typed.
function Field($obj, $names) {
  if ($null -eq $obj) { return $null }
  foreach ($n in $names) {
    if ($obj.PSObject.Properties.Name -contains $n) {
      $v = $obj.$n
      if ($null -ne $v -and ([string]$v).Trim() -ne '') { return ([string]$v).Trim() }
    }
  }
  return $null
}
function To-BlockNumber($v) {
  if (-not $v) { return $null }
  $s = ([string]$v).Trim()
  if ($s -match '^0x[0-9a-fA-F]+$') { return [System.Convert]::ToUInt64($s.Substring(2), 16) }
  if ($s -match '^[0-9]+$') { return [uint64]$s }
  return $null
}
# One place that builds a refusal, so each one reaches the page in the same
# shape and the terminal in the same words. The status code matters: the page
# treats any non-2xx as "the addresses were not taken" and prints the three
# filenames and the restart command instead of a stack trace, which is exactly
# right - a refused hand-over undid nothing, and those contracts are still
# deployed and still yours.
function Refuse($msg) { $script:reply = @{ ok = $false; error = $msg }; $script:replyCode = 400 }

# -- 7. The host restart, and proving it came back -----------------------
function Restart-TheHost() {
  $script:hostBackUp = $false
  Say ''
  Say 'restarting the host so the new configuration is live ...'
  & (Join-Path $webapp 'start-host.ps1') | ForEach-Object { Say ('  host: ' + $_) }
  foreach ($i in 1..20) {
    if (Host-Answers) { Landed 'host restarted and answering'; $script:hostBackUp = $true; return }
    Start-Sleep -Seconds 1
  }
  Say 'WARNING: the host did not answer after the restart. Look at server-data\host.err.log.'
}

# -- 8. What this script knows, for the page and for a person ------------
$script:note = 'waiting for the page'
$script:cfgAnchorNow = $cfgAnchor
$script:cfgClaimNow = $cfgClaim
$script:cfgPoolsNow = $cfgPools
$script:stewardSeen = $null
$script:verified = @()
$script:winding = $false

function Build-State() {
  $fund = @()
  foreach ($f in $fundable) {
    $fund += @{ epoch = $f.epoch; root0x = $f.root0x; total = $f.total; totalPeer = $f.totalPeer; leafCount = $f.leafCount }
  }
  $skipped = @()
  foreach ($f in $notFundable) { $skipped += @{ epoch = $f.epoch; why = $f.why } }
  return @{
    ok = $true
    chainId = $CHAIN_ID
    rpc = $RPC
    hostBase = $HOSTBASE
    origin = $selfOrigin
    token = $cfgToken
    btc = $CBBTC
    configured = @{ anchor = $script:cfgAnchorNow; claim = $script:cfgClaimNow; pools = $script:cfgPoolsNow }
    fundable = $fund
    skipped = $skipped
    verified = $script:verified
    note = $script:note
    # The claim window PeerClaim enforces, from the contract's own constants.
    minWindowSeconds = 604800      # MIN_WINDOW = 7 days
    maxWindowSeconds = 31536000    # MAX_WINDOW = 365 days
  }
}

# -- 9. The hand-over ----------------------------------------------------
# The page's message is a claim to be checked, not news. The order is fixed:
# EVERY on-chain check runs before ANY file is written, so a callback that is
# wrong changes nothing at all - not one file, not one restart.
function Handle-Setup($body) {
  # Is this the page this script served, from the press this script opened?
  $gotNonce = Field $body @('nonce')
  if ($gotNonce -ne $nonce) {
    Refuse ('this callback carries no nonce, or a different one. It did not come from the page this run opened. Open the URL this script printed - it carries the nonce in its query string - rather than a copy of setup.html left over in another tab.')
    return
  }
  # And is it built from the contracts this checkout compiled? The page sends
  # the same three fingerprints it prints, so this is the same check as the one
  # made against the file on disk, made again against the page that is actually
  # running in the browser. Cheap, and it catches the case where the page on
  # disk was replaced after this run started.
  $bAnchor = Field $body.builds @('anchor')
  $bClaim = Field $body.builds @('claim')
  if ($bAnchor -and $bAnchor -ne ('sha256:' + $wantAnchor)) { Refuse ('the page that posted was built from a different PeerAnchor (' + $bAnchor + ') than this checkout compiles. Nothing was written.'); return }
  if ($bClaim -and $bClaim -ne ('sha256:' + $wantClaim)) { Refuse ('the page that posted was built from a different PeerClaim (' + $bClaim + ') than this checkout compiles. Nothing was written.'); return }
  $bChain = Field $body @('chainId')
  if ($bChain -and $bChain -ne ([string]$CHAIN_ID)) { Refuse ('the page says it deployed on chain ' + $bChain + ', and this script configures the host for chain ' + $CHAIN_ID + '. Nothing was written.'); return }

  $anchor = Field $body.anchor @('address', 'addr')
  $claim  = Field $body.claim  @('address', 'addr')
  $pools  = Field $body.pools  @('address', 'addr')
  $account = Field $body @('account')
  if (-not $anchor -and -not $claim -and -not $pools) { Refuse 'that hand-over named no addresses at all.'; return }

  # Cumulative: the page posts anchor+claim, then posts the same body again
  # with pools added. An address already recorded and identical is not a change
  # and is not a replacement - it is the second post saying the same true thing.
  $wroteSomething = $false
  $notes = @()

  # -- the epoch pair ----------------------------------------------------
  $pairNew = ($anchor -and $anchor.ToLowerInvariant() -ne [string]$script:cfgAnchorNow) -or
             ($claim -and $claim.ToLowerInvariant() -ne [string]$script:cfgClaimNow)
  if ($pairNew) {
    if (-not $anchor -or $anchor -notmatch $ADDR_RE) { Refuse ('anchor is not an address: ' + $anchor); return }
    if (-not $claim -or $claim -notmatch $ADDR_RE) { Refuse ('claim is not an address: ' + $claim); return }
    $anchor = $anchor.ToLowerInvariant()
    $claim = $claim.ToLowerInvariant()
    if (($script:cfgAnchorNow -or $script:cfgClaimNow) -and -not $allowReplace) {
      Refuse ('this host is already configured for anchor ' + $script:cfgAnchorNow + ' and claim ' + $script:cfgClaimNow + ', and this run was told not to replace them. What you deployed is deployed and is yours; nothing here was changed. Re-run with -ReplaceExisting if replacing them is really what you want.')
      return
    }
    Say ''
    Say 'the page hands over:'
    Say ('  PeerAnchor ' + $anchor)
    Say ('  PeerClaim  ' + $claim)
    Say 'checking that against Base before writing anything ...'
    $script:note = 'checking those two addresses against Base'

    # (a) Is there code there at all? The cheapest way to catch a typo that is
    #     still 40 valid hex characters - and the one check the dead factory
    #     would have passed, which is why it is the first of four and not the
    #     only one.
    try {
      if (-not (Has-Code $anchor)) { Refuse ('nothing is deployed at ' + $anchor + ' on chain ' + $CHAIN_ID + ' - eth_getCode came back empty'); return }
      if (-not (Has-Code $claim))  { Refuse ('nothing is deployed at ' + $claim + ' on chain ' + $CHAIN_ID + ' - eth_getCode came back empty'); return }
    } catch { Refuse ('could not reach ' + $RPC + ': ' + $_.Exception.Message); return }
    Say '  code present at both addresses'

    # (b) Is the anchor a PeerAnchor? anchorOf() over an address and an epoch
    #     nobody could have posted answers three zero words on the real
    #     contract, and something else - or nothing - on anything else. "No
    #     anchors yet" and "wrong address" are different answers, and this is
    #     what tells them apart.
    try { $probe = [string](EthCall $anchor ($SEL_anchorOf + (Pad-Addr $ZERO_ADDR) + (Pad-Uint 0))) } catch { $probe = '' }
    if ($probe.Length -ne 194 -or ($probe.Substring(2) -notmatch '^0+$')) {
      Refuse ('the contract at ' + $anchor + ' did not answer anchorOf(address,uint256) the way a PeerAnchor does. That address is something else - nothing was written.')
      return
    }
    Say '  PeerAnchor answers anchorOf() as an empty anchor should'

    # (c) Is the claim contract paying out OUR token? This is the check the
    #     dead pools factory needed and did not have: its immutable peer
    #     address was the operator's wallet, so it had code, it answered, and
    #     every call reverted forever. An immutable argument is checkable
    #     exactly once - now - and fixable never.
    try { $tokWord = [string](EthCall $claim $SEL_claimToken) } catch { $tokWord = '' }
    $tokSeen = Word-Addr $tokWord
    if (-not $tokSeen) { Refuse ('the contract at ' + $claim + ' does not answer token(), so it is not a PeerClaim. Nothing was written.'); return }
    if ($tokSeen -ne $cfgToken.ToLowerInvariant()) {
      Refuse ('the claim contract at ' + $claim + ' says its token is ' + $tokSeen + ', and this host''s PEER is ' + $cfgToken + '. Those are different coins and the pairing is immutable, so that contract can never settle these epochs. Nothing was written.')
      return
    }
    Say ('  PeerClaim pays out ' + $tokSeen + ' - this host''s PEER')

    # (d) Who is the steward? Not a refusal, because a steward on a hardware
    #     wallet or a second account is a legitimate choice - but only that
    #     address can ever open an epoch, so if it is not the wallet standing
    #     in front of the funding step, saying so now saves a reverted
    #     transaction and the gas it costs.
    try { $stewWord = [string](EthCall $claim $SEL_steward) } catch { $stewWord = '' }
    $steward = Word-Addr $stewWord
    if (-not $steward -or $steward -eq $ZERO_ADDR) { Refuse ('the claim contract at ' + $claim + ' has no steward. Nothing was written.'); return }
    $script:stewardSeen = $steward
    Say ('  steward ' + $steward)
    if ($account -and $account.ToLowerInvariant() -ne $steward) {
      Say ('  NOTE: the wallet on the page is ' + $account.ToLowerInvariant())
      Say '        Only the steward can open an epoch. Funding from any other account reverts.'
      $notes += 'the steward is not the wallet on the page'
    }

    # (e) The blocks. Missing is allowed and costs scanning time; WRONG in the
    #     high direction silently hides everything anchored or opened before
    #     it, so a guess is never substituted for a number read off a receipt.
    #     The page computes the lower of the two itself and sends it; this
    #     computes it again from the two blocks rather than taking that word,
    #     because it is one comparison and the failure is silent.
    $ab = To-BlockNumber (Field $body.anchor @('block', 'blockNumber'))
    $cb = To-BlockNumber (Field $body.claim @('block', 'blockNumber'))
    $from = $null
    if ($ab -and $cb) { if ($ab -lt $cb) { $from = $ab } else { $from = $cb } }
    elseif ($ab) { $from = $ab }
    elseif ($cb) { $from = $cb }
    $said = To-BlockNumber (Field $body @('epochFromBlock'))
    if ($from -and $said -and $said -ne $from) {
      Say ('  NOTE: the page called the from-block ' + $said + '; the lower of the two deployment blocks is ' + $from + '. Using ' + $from + '.')
    }

    # Everything above passed. Now, and only now, the files.
    Write-Cfg 'anchor-address.txt' $anchor
    Write-Cfg 'claim-address.txt' $claim
    if ($from) {
      Write-Cfg 'epoch-from-block.txt' ([string]$from)
    } else {
      Say '  no deployment block came with that, so epoch-from-block.txt is left alone.'
      Say '  The scan then walks from block 0: slower, never wrong. Put the LOWER of'
      Say '  the two deployment blocks in server-data\epoch-from-block.txt to fix it.'
    }
    $script:cfgAnchorNow = $anchor
    $script:cfgClaimNow = $claim
    $wroteSomething = $true
  } elseif ($anchor -or $claim) {
    $notes += 'the epoch pair was already recorded and matches'
  }

  # -- the pools factory -------------------------------------------------
  if ($pools -and $pools.ToLowerInvariant() -ne [string]$script:cfgPoolsNow) {
    if ($pools -notmatch $ADDR_RE) { Refuse ('pools is not an address: ' + $pools); return }
    $pools = $pools.ToLowerInvariant()
    Say ''
    Say ('the page hands over a pools factory at ' + $pools + ' - checking ...')
    try { if (-not (Has-Code $pools)) { Refuse ('nothing is deployed at ' + $pools); return } }
    catch { Refuse ('could not reach ' + $RPC + ': ' + $_.Exception.Message); return }
    # The two immutable constructor arguments, read back from the factory
    # itself. This is the exact check whose absence produced a factory on this
    # very network whose peer() is a wallet and whose every createPool reverts.
    try { $fp = Word-Addr ([string](EthCall $pools $SEL_poolsPeer)) } catch { $fp = '' }
    try { $fb = Word-Addr ([string](EthCall $pools $SEL_poolsBtc)) } catch { $fb = '' }
    # "Answered a different address" and "did not answer at all" are two
    # different mistakes with two different repairs, so they do not share one
    # sentence with an empty space where an address should be.
    if (-not $fp -or -not $fb) { Refuse ('the contract at ' + $pools + ' does not answer peer() and btc(), so it is not a PeerPools factory. Nothing was written.'); return }
    if ($fp -ne $cfgToken.ToLowerInvariant()) {
      Refuse ('that factory says peer() is ' + $fp + ', not ' + $cfgToken + '. Both sides are fixed at deployment, so every createPool on it would revert forever - this is exactly the dead factory this network already has one of. Nothing was written.')
      return
    }
    if ($fb -ne $CBBTC.ToLowerInvariant()) {
      Refuse ('that factory says btc() is ' + $fb + ', not cbBTC (' + $CBBTC + '). Nothing was written.')
      return
    }
    Say ('  the factory pairs ' + $fp + ' with ' + $fb + ' - correct')
    $pb = To-BlockNumber (Field $body.pools @('block', 'blockNumber'))
    Write-Cfg 'pools-address.txt' $pools
    if ($pb) { Write-Cfg 'pools-from-block.txt' ([string]$pb) }
    if (-not (Test-Path (Join-Path $logDir 'btc-token-address.txt'))) { Write-Cfg 'btc-token-address.txt' $CBBTC }
    $script:cfgPoolsNow = $pools
    $wroteSomething = $true
  } elseif ($pools) {
    $notes += 'the pools factory was already recorded and matches'
  }

  if (-not $wroteSomething) {
    # The files already said this. That is not the same as the host having
    # READ them: a previous run could have written them and failed to restart,
    # and the page only hands over when the host is missing something - so it
    # would then wait four minutes for a restart nobody was going to do. One
    # question to the host settles it.
    $live = $false
    try {
      $oc = Get-Json ($HOSTBASE + '/api/token/onchain') 20
      $live = (([string]$oc.anchors.contract).ToLowerInvariant() -eq ([string]$script:cfgAnchorNow).ToLowerInvariant()) -and
              (([string]$oc.claimState.contract).ToLowerInvariant() -eq ([string]$script:cfgClaimNow).ToLowerInvariant())
    } catch { $live = $false }
    if ($live) {
      $script:note = 'nothing to change - the host already has those addresses'
      $script:reply = @{ ok = $true; note = ('nothing to change: ' + ($notes -join '; ')) }
      $script:replyCode = 200
      return
    }
    Say ''
    Say 'those addresses are already in server-data but the host is not reporting them,'
    Say 'so this restarts it rather than leaving the page waiting for a restart that'
    Say 'was never going to come.'
    $wroteSomething = $true
  }

  $script:note = 'restarting the host onto the new configuration'
  Restart-TheHost
  $reported = ''
  try {
    $oc = Get-Json ($HOSTBASE + '/api/token/onchain') 30
    $reported = 'anchor ' + $oc.anchors.contract + ', claim ' + $oc.claimState.contract
    Say ('  /api/token/onchain now reports ' + $reported)
  } catch { Say ('  could not read /api/token/onchain yet: ' + $_.Exception.Message) }
  if ($fundable.Count -gt 0) { $script:note = 'host is up; watching Base for the epoch deposit' }
  else { $script:note = 'host is up; there is no epoch with anything to pay, so nothing is expected on chain' }
  # Short on purpose: the page prints this answer verbatim, and 300 characters
  # of it.
  $script:reply = @{ ok = $true; note = ('written and the host restarted: ' + $reported) }
  $script:replyCode = 200
}

# -- 10. The chain is the witness ----------------------------------------
# Called from the wait loop rather than from a callback, because the page never
# says "done" and is never asked to. An epoch is funded when the claim contract
# says it holds the deposit, and not one second before.
function Check-Epoch($f) {
  if (-not $script:cfgClaimNow) { return }
  try { $info = [string](EthCall $script:cfgClaimNow ($SEL_epochInfo + (Pad-Uint $f.epoch))) } catch { return }
  if ($info.Length -lt 322) { return }
  # Five 32-byte words, in the order epochInfo declares them:
  # (bytes32 root, uint256 total, uint256 paid, uint64 claimUntil, bool open).
  # Parenthesised on purpose - an unparenthesised .Substring(a, b) in argument
  # position is read as two arguments by PowerShell, silently.
  $h = $info.Substring(2)
  $root = '0x' + $h.Substring(0, 64)
  if ($root -match '^0x0+$') { return }        # never opened; keep waiting
  $total = Word-Uint ($h.Substring(64, 64))
  $paid = Word-Uint ($h.Substring(128, 64))
  $until = [int64](Word-Uint ($h.Substring(192, 64)))
  $deadlineText = ([datetime]'1970-01-01').AddSeconds($until).ToString('yyyy-MM-dd HH:mm:ss') + ' UTC'
  Say ''
  Say ('epoch ' + $f.epoch + ' is open on ' + $script:cfgClaimNow + ' - reading it off Base, not off the page:')
  Say ('  root       ' + $root)
  Say ('  total      ' + $total.ToString() + ' raw')
  Say ('  paid       ' + $paid.ToString() + ' raw')
  Say ('  claim ends ' + $deadlineText)
  # The same epoch as the act log computes it. Two answers derived from
  # completely different things, so agreement is worth something and
  # disagreement is worth stopping for.
  $rootOk = ($root.ToLowerInvariant() -eq $f.root0x.ToLowerInvariant())
  if ($rootOk) { Say ('  the root matches the tree this host computes for epoch ' + $f.epoch) }
  else {
    Say  '  ROOT MISMATCH - the chain and this host disagree about that epoch:'
    Say ('    host  ' + $f.root0x)
    Say ('    chain ' + $root)
    Say  '  Proofs computed here will not verify against that root, and nothing on chain'
    Say  '  can be changed now: the epoch would have to be opened again under a new number.'
  }
  $owed = [System.Numerics.BigInteger]::Parse($f.total)
  if ($total -eq $owed) { Say ('  the deposit is exactly what the tree owes: ' + $f.totalPeer + ' PEER') }
  elseif ($total -lt $owed) {
    Say ('  UNDERFUNDED: the tree owes ' + $owed.ToString() + ' raw and the epoch holds ' + $total.ToString() + '.')
    Say  '  That epoch pays first-come and reverts for everyone after it runs out.'
  } else {
    Say ('  overfunded: the epoch holds ' + $total.ToString() + ' raw against a tree owing ' + $owed.ToString() + '.')
    Say  '  The remainder returns to the steward at sweep, after the deadline.'
  }
  $script:verified += @{ epoch = $f.epoch; root = $root; total = $total.ToString(); rootMatches = $rootOk; claimUntil = $deadlineText }
  Landed ('epoch ' + $f.epoch + ' open on chain with ' + $total.ToString() + ' raw behind it, claims until ' + $deadlineText)
}

# -- 11. Open the browser and wait ---------------------------------------
if (-not $NoBrowser) {
  Say 'opening it in your browser. It reads the host and the chain first and shows'
  Say 'you the whole plan before anything is signed; MetaMask asks once per step and'
  Say 'the page says which step it is asking about.'
  Start-Process $pageUrl
} else {
  Say '-NoBrowser: open this exact URL yourself, in the browser MetaMask lives in.'
  Say '(The nonce in it is how this script tells your press from an old tab.)'
  Say ('  ' + $pageUrl)
}
Say ''
Say 'waiting. Ctrl-C stops this at any time; nothing half-written is left behind.'
Say ''

$stopped = $null
$deadline = (Get-Date).AddMinutes($IdleMinutes)
$lastBeat = Get-Date
$lastPoll = Get-Date
try {
  while ($true) {
    $task = $listener.GetContextAsync()
    $ctx = $null
    while ($null -eq $ctx) {
      if ($task.Wait(500)) { $ctx = $task.Result; break }
      if ((Get-Date) -gt $deadline) { break }

      # Between requests, ask the chain. Every ten seconds, and only about the
      # epochs that have something to pay and are not confirmed yet.
      if ($script:cfgClaimNow -and ((Get-Date) - $lastPoll).TotalSeconds -ge 10) {
        $lastPoll = Get-Date
        foreach ($f in $fundable) {
          $seen = $false
          foreach ($v in $script:verified) { if ($v.epoch -eq $f.epoch) { $seen = $true } }
          if (-not $seen) { Check-Epoch $f }
        }
        if ($fundable.Count -gt 0 -and $script:verified.Count -ge $fundable.Count -and -not $script:winding) {
          # Everything expected has landed. The listener stays up a little
          # longer because the pools step, when there is one, comes after this
          # in the page's plan - and then it ends by itself rather than sitting
          # there until a twenty-minute timeout somebody has to wait out.
          $script:winding = $true
          $script:note = 'every fundable epoch is open on chain'
          $deadline = (Get-Date).AddMinutes(3)
          Say ''
          Say 'Every epoch that had something to pay is now open on chain and checked.'
          Say 'Staying up three more minutes in case the pools step follows, then closing.'
        }
      }

      if (((Get-Date) - $lastBeat).TotalSeconds -ge 120) {
        $lastBeat = Get-Date
        $left = [int]([Math]::Max(0, ($deadline - (Get-Date)).TotalMinutes))
        Say ('  still waiting - ' + $left + ' minutes before this closes by itself.')
      }
    }
    if ($null -eq $ctx) {
      if ($script:winding) { $stopped = 'nothing further arrived' }
      else { $stopped = 'nothing happened for ' + $IdleMinutes + ' minutes' }
      break
    }
    $deadline = (Get-Date).AddMinutes($IdleMinutes)
    if ($script:winding) { $deadline = (Get-Date).AddMinutes(3) }

    $req = $ctx.Request
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod

    # DNS-rebinding guard, on every request including the page itself.
    if ($req.UserHostName -ne $selfHost) {
      Say ('  refused a request addressed to "' + $req.UserHostName + '" rather than ' + $selfHost)
      Send-Json $ctx 403 @{ ok = $false; error = 'wrong Host header' }
      continue
    }
    if ($method -eq 'POST' -and $req.Headers['Origin'] -ne $selfOrigin) {
      Say ('  refused a POST to ' + $path + ' from origin "' + $req.Headers['Origin'] + '"')
      Send-Json $ctx 403 @{ ok = $false; error = 'this endpoint only answers the page it served - open the URL this script printed' }
      continue
    }

    if ($method -eq 'GET') {
      if ($path -eq '/' -or $path -eq '/setup.html') { Send-Bytes $ctx 200 'text/html; charset=utf-8' $pageBytes; continue }
      if ($path -eq '/api/setup/status') { Send-Json $ctx 200 @{ state = 'ok'; note = $script:note }; continue }
      if ($path -eq '/state') { Send-Json $ctx 200 (Build-State); continue }
      Send-Json $ctx 404 @{ ok = $false; error = 'no such endpoint' }
      continue
    }
    if ($method -ne 'POST' -or $path -ne '/api/setup/deployed') {
      Send-Json $ctx 404 @{ ok = $false; error = 'no such endpoint' }
      continue
    }

    $body = Read-Body $ctx
    if ($null -eq $body) {
      Send-Json $ctx 400 @{ ok = $false; error = 'expected a small JSON body' }
      continue
    }
    $script:reply = $null
    $script:replyCode = 200
    Handle-Setup $body
    if (-not $script:reply.ok) {
      Say ('  REFUSED: ' + $script:reply.error)
      $script:note = 'refused that hand-over: ' + $script:reply.error
    }
    Send-Json $ctx $script:replyCode $script:reply
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
}

# -- 12. The closing account ---------------------------------------------
Say ''
Say '========================================================================'
if ($stopped) { Say ('Closed: ' + $stopped); Say '' }
if ($script:landed.Count -eq 0) {
  Say 'Nothing landed. No file was written, the host was not restarted, and nothing'
  Say 'was deployed by this run.'
} else {
  Say 'What landed:'
  foreach ($l in $script:landed) { Say ('  ' + $l) }
}
Say ''
Say 'Configuration now in server-data\:'
Say ('  PEER token        ' + (Shown (Read-Cfg 'token-address.txt')))
Say ('  BTC token         ' + (Shown (Read-Cfg 'btc-token-address.txt')))
Say ('  PeerAnchor        ' + (Shown (Read-Cfg 'anchor-address.txt')))
Say ('  PeerClaim         ' + (Shown (Read-Cfg 'claim-address.txt')))
Say ('  epoch from block  ' + (Shown (Read-Cfg 'epoch-from-block.txt')))
Say ('  PeerPools         ' + (Shown (Read-Cfg 'pools-address.txt')))
Say ('  pools from block  ' + (Shown (Read-Cfg 'pools-from-block.txt')))

# Is the host actually up, whichever way this ended? A run that leaves the
# network down is worse than a run that did nothing.
Say ''
if (Host-Answers) { Say ('The host is up on ' + $HOSTBASE + '.') }
else {
  Say ('WARNING: the host is NOT answering on ' + $HOSTBASE + '.')
  Say 'Start it by hand:  .\start-host.ps1     and read server-data\host.err.log.'
}

if ($script:verified.Count -gt 0) {
  Say ''
  Say 'Epochs open on chain and checked against this host:'
  foreach ($v in $script:verified) {
    $tail = ''
    if (-not $v.rootMatches) { $tail = '   ROOT DOES NOT MATCH THIS HOST - read the lines above' }
    Say ('  epoch ' + $v.epoch + '  ' + $v.total + ' raw  claims until ' + $v.claimUntil + $tail)
  }
  Say 'In the app, anyone who earned in those epochs with an address bound at the'
  Say 'time can claim their PEER now: the proof comes from GET /api/v1/epoch/<n>/claim'
  Say 'and the claim is their own transaction, from their own wallet. Whatever'
  Say 'nobody claims returns to the steward after the deadline, by one sweep() call'
  Say 'that reverts before it.'
} elseif ($fundable.Count -gt 0) {
  Say ''
  Say 'No epoch was funded in this run. The tree for each of these is unchanged and'
  Say 'can be funded whenever you like - a published root does not expire:'
  foreach ($f in $fundable) { Say ('  epoch ' + $f.epoch + '  ' + $f.totalPeer + ' PEER over ' + $f.leafCount + ' leaf/leaves') }
}

# Pools, and the honest reason they are not set up. The balance is read off the
# chain for the steward this run actually saw, so this is a measurement rather
# than an assumption.
Say ''
if (Read-Cfg 'pools-address.txt') {
  Say 'Pools: a factory is configured and the host can see it. Opening a pool is a'
  Say 'separate act: it puts PEER on one side and cbBTC on the other, at a price you'
  Say 'choose by picking the two amounts, and no script here will pick them.'
} else {
  $btcBal = $null
  if ($script:stewardSeen) {
    try {
      $balWord = [string](EthCall $CBBTC ($SEL_balanceOf + (Pad-Addr $script:stewardSeen)))
      $btcBal = Word-Uint ($balWord.Substring(2))
    } catch { $btcBal = $null }
  }
  Say 'Pools: NOT set up, and this script cannot finish that part.'
  if ($null -ne $btcBal) {
    $human = [double]$btcBal / 100000000.0
    Say ('  ' + $script:stewardSeen + ' holds ' + $human.ToString('0.00000000') + ' cbBTC.')
  }
  Say '  A pool is PEER on one side and cbBTC on the other. cbBTC has to be bought -'
  Say '  on an exchange, or by bridging bitcoin - and withdrawn to Base. That is your'
  Say '  transaction with your exchange and not something this script may do for you.'
  Say '  Nothing here can obtain it.'
  Say '  When you hold some, run this again: the page offers the pool steps only when'
  Say '  the connected wallet has a cbBTC balance, and this script reads the new'
  Say '  factory''s own peer() and btc() before it writes the address down.'
}
Say ''
Say 'Every signature in this run was yours. No key, seed phrase or signature was'
Say 'handled, stored or seen by this script, and none ever will be.'
Say '========================================================================'

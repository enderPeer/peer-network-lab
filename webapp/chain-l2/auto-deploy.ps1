# Auto-deploy: the pools factory from page to live host, one sitting.
#
# What this script does and does not automate, stated plainly: it brings the
# deploy page up, checks the page it found is the one THIS checkout builds,
# opens it in your browser, and afterwards writes what you deployed - the
# addresses and the block - into server-data and restarts the host so
# /api/token/onchain reports it. Signing the deployment - the one
# step in the middle, and the only one that costs anything - is YOURS,
# in MetaMask, on purpose. A script that could do that step would be a script
# holding your key, and nothing in this repository is allowed to become that.
#
# The four files it writes - server-data\token-address.txt,
# pools-address.txt, pools-from-block.txt and btc-token-address.txt - are
# exactly the four that start-host.ps1, watchdog.ps1 and serve-public.ps1 all
# read on startup, and that is the only reason this script is allowed to
# write anything. A file only one launcher reads would configure the host
# until the next watchdog restart and then quietly stop, which is worse than
# never having worked.
#
#   powershell -ExecutionPolicy Bypass -File .\chain-l2\auto-deploy.ps1
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # chain-l2
$webapp = Split-Path -Parent $here                            # webapp
$logDir = Join-Path $webapp 'server-data'
# Made here rather than assumed: the very next thing this script does is
# redirect a child process's output into this directory, and Start-Process
# fails outright if it does not exist - which on a fresh clone it does not.
New-Item -ItemType Directory -Force $logDir | Out-Null
$CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'         # cbBTC on Base, 8 decimals

function Say($m) { Write-Output $m }

# -- 0. Which contract is the page offering? ------------------------------
# Step 1 below adopts whatever already answers on port 8899, which is
# convenient and, unchecked, the most dangerous line in this file.
# serve-deploy.mjs serves deploy.html from ITS OWN directory, and this
# machine has more than one of those: a git worktree under
# webapp\.claude\worktrees holds a full second copy of the repo whose
# deploy.html embeds the PREVIOUS immutable contract. Adopt that server and
# this script walks you confidently through deploying the wrong factory -
# real gas, permanently, over an interface the app's calls would not reach.
#
# So do not trust the port, and do not special-case the worktree either:
# hash the bytecode THIS checkout would deploy, and refuse any served page
# that does not carry the same fingerprint. That catches every stale copy,
# including the ones nobody has noticed yet, and it costs one GET.
function Get-BytecodeFingerprint($jsonPath) {
  if (-not (Test-Path $jsonPath)) { return $null }
  $j = Get-Content -Raw -Path $jsonPath | ConvertFrom-Json
  if (-not $j.bytecode) { return $null }
  # Trim and lowercase before hashing so this and build-deploy-page.js hash
  # the same bytes; ASCII because the string is hex, which keeps PowerShell
  # 5.1 out of an encoding question it answers differently from Node.
  $norm = ([string]$j.bytecode).Trim().ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($norm)) } finally { $sha.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}
$buildJson = Join-Path $here 'PeerPools.build.json'
$wantFp = Get-BytecodeFingerprint $buildJson
if (-not $wantFp) {
  Say ('ERROR: could not read the PeerPools bytecode out of ' + $buildJson)
  Say 'Rebuild it first:  node chain-l2\build-pools.js'
  exit 1
}

# -- 1. The deploy page, on loopback --------------------------------------
# MetaMask only injects into http(s) origins, so file:// would show a page
# that truthfully reports "no wallet". 127.0.0.1 fixes that and keeps the
# page unreachable from outside this machine.
$pageUp = $false
$pageHtml = ''
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8899/' -UseBasicParsing -TimeoutSec 2
  if ($r.StatusCode -eq 200) { $pageUp = $true; $pageHtml = [string]$r.Content }
} catch { }
# Remembered because it changes which remedy to lead with below: a page we
# started ourselves that fails the check is a stale build in THIS directory,
# not somebody else's server.
$adopted = $pageUp
if (-not $pageUp) {
  Say 'starting the deploy page server on 127.0.0.1:8899 ...'
  Start-Process -FilePath 'node' -ArgumentList (Join-Path $here 'serve-deploy.mjs') -WorkingDirectory $webapp -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'burnpage.log') -RedirectStandardError (Join-Path $logDir 'burnpage.err.log')
  foreach ($i in 1..10) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8899/' -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $pageUp = $true; $pageHtml = [string]$r.Content; break }
    } catch { }
  }
}
if (-not $pageUp) { Say 'ERROR: the deploy page did not come up. Run: node chain-l2\serve-deploy.mjs and look at its output.'; exit 1 }

# The page prints this same number next to the factory card, so an operator
# who did not run this script can make the comparison by eye.
$servedFp = $null
if ($pageHtml -match 'name="peerpools-build"[^>]*content="sha256:([0-9a-f]{64})"') { $servedFp = $Matches[1] }
if ($servedFp -ne $wantFp) {
  Say ''
  Say 'ERROR: DEPLOY PAGE IDENTITY MISMATCH - refusing to go on.'
  Say ''
  Say 'The page answering http://127.0.0.1:8899/ is not the one this checkout builds.'
  Say ('  this checkout (chain-l2\PeerPools.build.json):  ' + $wantFp)
  if ($servedFp) {
    Say ('  the page being served:                         ' + $servedFp)
  } else {
    Say '  the page being served:                         no fingerprint at all'
    Say '  A page with no fingerprint was generated before this check existed,'
    Say '  which means it also predates the contract this checkout builds.'
  }
  Say ''
  Say 'Those are two different contracts. Deploying is irreversible and the app'
  Say 'would call functions the other one does not have, so nothing is opened.'
  Say ''
  if ($adopted) {
    Say 'Something else was already holding port 8899 - most likely a second copy'
    Say 'of this repo (a git worktree) serving its own older deploy.html. Either:'
    Say '  1. Stop it and run this script again - it will then serve this'
    Say '     directory itself:'
    Say '       Get-NetTCPConnection -LocalPort 8899 -State Listen | Select-Object OwningProcess'
    Say '       Get-Process -Id <that id>        # see what it is before killing it'
    Say '       Stop-Process -Id <that id>'
    Say '  2. If it turns out that page IS this directory, it is simply out of'
    Say '     date - regenerate it:  node chain-l2\build-deploy-page.js'
    Say ''
    Say 'To leave the other server alone, serve this one beside it and deploy by'
    Say 'hand:  $env:DEPLOY_PORT=8900; node chain-l2\serve-deploy.mjs'
    Say 'This script only ever checks 8899, but re-running it afterwards with the'
    Say 'addresses typed in still writes the four files and restarts the host.'
  } else {
    Say 'This script started that server itself, from this directory, so the page'
    Say 'on disk is out of date with the compiled bytecode beside it. Regenerate'
    Say 'it and run this script again:'
    Say '     node chain-l2\build-deploy-page.js'
    Say 'If PeerPools.sol changed, compile it first: node chain-l2\build-pools.js'
  }
  exit 1
}
Say ('deploy page verified: PeerPools sha256 ' + $wantFp)

# -- 2. Open it where MetaMask lives --------------------------------------
Say ''
Say 'Opening  http://127.0.0.1:8899/  - the page numbers its own cards; do them in order:'
Say '  card 1  Connect MetaMask (account with ~2 USD of ETH on Base).'
Say '  cards 2-3  Deploy PEER if you have not already - copy the address it prints.'
Say '  card 4  Paste that PEER address. The cbBTC field is already filled in.'
Say '  card 5  Deploy the pools factory - copy ITS address AND the block number'
Say '          it prints underneath. Both are asked for below.'
Say ''
Say 'Deploying the factory opens no pool and moves no coin. It is an empty'
Say 'factory until somebody calls createPool from the app.'
Say ''
Start-Process 'http://127.0.0.1:8899/'

# -- 3. Take the addresses, validate, write the files the host reads ------
# Empty input skips a step, so this script is safe to re-run later for just
# one of the three values it asks for.
$addrRe = '^0x[0-9a-fA-F]{40}$'

$tokIn = Read-Host 'PEER token address (Enter to keep current / skip)'
if ($tokIn) {
  if ($tokIn -notmatch $addrRe) { Say ('not an address: ' + $tokIn); exit 1 }
  Set-Content -Path (Join-Path $logDir 'token-address.txt') -Value $tokIn.Trim() -Encoding Ascii
  Say 'wrote server-data\token-address.txt'
}
$poolsIn = Read-Host 'Pools factory address (Enter to skip)'
if ($poolsIn) {
  if ($poolsIn -notmatch $addrRe) { Say ('not an address: ' + $poolsIn); exit 1 }
  Set-Content -Path (Join-Path $logDir 'pools-address.txt') -Value $poolsIn.Trim() -Encoding Ascii
  Say 'wrote server-data\pools-address.txt'
}
# The deploy page prints this beside the address, and any explorer shows it
# on the deployment transaction. Skipping it is allowed and costs you the
# pool list: the reader would then ask a public RPC for the whole chain's
# logs, which most refuse. A number that is too HIGH is worse than none,
# because it hides pools opened before it - so paste the one the page gave
# you rather than a round number near it.
$blkIn = Read-Host 'Block the factory was deployed in (Enter to skip)'
if ($blkIn) {
  if ($blkIn -notmatch '^(0x[0-9a-fA-F]+|[0-9]+)$') { Say ('not a block number: ' + $blkIn); exit 1 }
  Set-Content -Path (Join-Path $logDir 'pools-from-block.txt') -Value $blkIn.Trim() -Encoding Ascii
  Say 'wrote server-data\pools-from-block.txt'
}
if (-not (Test-Path (Join-Path $logDir 'btc-token-address.txt'))) {
  # The pair's other side. Written only if absent - if you ever point this at
  # something other than cbBTC on purpose, a re-run will not undo that.
  Set-Content -Path (Join-Path $logDir 'btc-token-address.txt') -Value $CBBTC -Encoding Ascii
  Say ('wrote server-data\btc-token-address.txt (cbBTC ' + $CBBTC + ')')
}
if (-not $tokIn -and -not $poolsIn -and -not $blkIn) { Say 'nothing entered, nothing restarted.'; exit 0 }

# -- 4. Restart the host so the config is live ----------------------------
Say ''
Say 'restarting the host with the new on-chain config ...'
& (Join-Path $webapp 'start-host.ps1')

# -- 5. Prove it, rather than promise it ----------------------------------
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:5210/api/token/onchain' -UseBasicParsing -TimeoutSec 15
  Say ''
  Say 'GET /api/token/onchain says:'
  Say $r.Content
  Say ''
  # How to read that, since this is the step that catches a wrong-but-real
  # address - the regex above only ever proved it was 40 hex characters.
  Say 'Reading the namedPools object above:'
  Say '  "total":0 with an empty "pools" list is a live, EMPTY factory. That is'
  Say '  what a fresh deployment looks like and it is correct.'
  Say '  "tokens" is the pair the factory itself names. Check it is your PEER and'
  Say '  cbBTC. A "mismatch" key means it is not, and that the address you pasted'
  Say '  is a real factory over different coins - stop and fix that one now.'
  Say '  "total" above "discovered" means pools exist that the log scan did not'
  Say '  see: pools-from-block.txt starts too late. Lower it.'
  Say '  An "error" key means nothing answered there on this chain at all.'
  Say 'None of this is urgent while the factory is empty. All of it is urgent'
  Say 'once somebody has put coins in.'
} catch {
  Say ('the endpoint did not answer cleanly: ' + $_.Exception.Message)
  Say 'check server-data\host.err.log - and note the RPC needs a moment on first read.'
}

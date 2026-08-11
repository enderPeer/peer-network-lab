# Start the host with every file-backed setting loaded, and nothing else.
#
# serve-public.ps1 also starts a tunnel and a watchdog; this is the piece that
# just brings the HOST up on an existing tunnel - which is what a code deploy
# needs, since the quick-tunnel address survives a host restart but not a
# cloudflared restart.
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here 'server-data'

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# Same files serve-public.ps1 and watchdog.ps1 read. Kept in step with them by
# hand, which is a real hazard: a setting one script loads and another forgets
# changes behaviour silently on the next restart.
$tok = Join-Path $logDir 'operator-token.txt'
if (Test-Path $tok) { $env:PEER_OPERATOR_TOKEN = (Get-Content $tok -Raw).Trim() }
# The PEER token on Base, and the asset it is paired against. Files like the
# rest of server-data, so a watchdog restart cannot silently unconfigure the
# on-chain surface. An address baked into source is one nobody verified.
$tokFile2 = Join-Path $logDir 'token-address.txt'
if (Test-Path $tokFile2) { $env:PEER_TOKEN_ADDR = (Get-Content $tokFile2 -Raw).Trim() }
$btcTok = Join-Path $logDir 'btc-token-address.txt'
if (Test-Path $btcTok) { $env:PEER_BTC_ADDR = (Get-Content $btcTok -Raw).Trim() }
$poolsF = Join-Path $logDir 'pools-address.txt'
if (Test-Path $poolsF) { $env:PEER_POOLS_ADDR = (Get-Content $poolsF -Raw).Trim() }
# The block the factory was deployed in. Without it the pool scan asks every
# public RPC for the whole chain's logs, which most refuse outright - so the
# pool list comes back empty on a factory that is working perfectly.
$poolsBlk = Join-Path $logDir 'pools-from-block.txt'
if (Test-Path $poolsBlk) { $env:PEER_POOLS_FROM_BLOCK = (Get-Content $poolsBlk -Raw).Trim() }
$burn = Join-Path $logDir 'burn-address.txt'
if (Test-Path $burn) { $env:PEER_BURN_ADDRESS = (Get-Content $burn -Raw).Trim() }
$btc = Join-Path $logDir 'btc-address.txt'
if (Test-Path $btc) { $env:PEER_BTC_ADDRESS = (Get-Content $btc -Raw).Trim() }
$rp = Join-Path $logDir 'rp-origin.txt'
if (Test-Path $rp) {
  $o = (Get-Content $rp -Raw).Trim()
  $env:PEER_RP_ORIGIN = $o
  $env:PEER_RP_ID = ($o -replace '^https?://', '' -replace '/.*$', '')
}

Start-Process -FilePath 'node' -ArgumentList 'server.mjs', '5210' `
  -WorkingDirectory $here -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'host.log') `
  -RedirectStandardError (Join-Path $logDir 'host.err.log')

# The burn page, on loopback. MetaMask's multichain content script reaches
# http origins, so the one-click signing flow only works from here - not from
# the published https site. Started beside the host so the in-app hand-off
# link is never dead. Idempotent: if 8899 already answers, nothing happens.
$burnUp = $false
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8899/burn.html' -UseBasicParsing -TimeoutSec 2; $burnUp = ($r.StatusCode -eq 200) } catch { }
if (-not $burnUp) {
  Start-Process -FilePath 'node' -ArgumentList (Join-Path $here 'chain-l2\serve-deploy.mjs') -WorkingDirectory $here -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'burnpage.log') -RedirectStandardError (Join-Path $logDir 'burnpage.err.log')
}

foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:5210/api/v1/state' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { Write-Output ('host up: ' + $r.Content.Substring(0, 60)); exit 0 }
  } catch { }
}
Write-Output 'WARNING: host did not answer within 20s'
exit 1

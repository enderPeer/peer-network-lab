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

# Every file-backed setting, from the one list all four launchers share.
. (Join-Path $here 'load-config.ps1') -DataDir $logDir

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

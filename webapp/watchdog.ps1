# Keeps the Peer host and Cloudflare tunnel alive: checks every 30s and
# restarts whichever is down. Started detached by serve-public.ps1, or run
# directly:  powershell -ExecutionPolicy Bypass -File .\watchdog.ps1
# ASCII-only on purpose (Windows PowerShell 5.1 misparses BOM-less UTF-8).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here 'server-data'
New-Item -ItemType Directory -Force $logDir | Out-Null
$wdLog = Join-Path $logDir 'watchdog.log'

function Log($msg) {
  ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) | Add-Content -Path $wdLog
}

Log 'watchdog started'
while ($true) {
  # 1. host healthy?
  # The role lives in server-data\role.json and server.mjs reads it on boot,
  # so a restart from here cannot silently turn a mirror into a second writer.
  # That mattered enough to write down: two hosts accepting acts would fork
  # the log the first time both were reachable.
  $hostOk = $false
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:5210/api/acts?since=999999' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $hostOk = $true }
  } catch {}
  if (-not $hostOk) {
    Log 'host down - restarting node server.mjs'
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match 'server\.mjs' } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false } catch {} }
    # The token lives in a file in the (gitignored) data directory, so a restart
    # from here does not silently drop the admin panel - and no path exists by
    # which the token could reach the repository.
    $tokFile = Join-Path $logDir 'operator-token.txt'
    if (Test-Path $tokFile) { $env:PEER_OPERATOR_TOKEN = (Get-Content $tokFile -Raw).Trim() }
    Start-Process -FilePath 'node' -ArgumentList 'server.mjs', '5210' -WorkingDirectory $here -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'host.log') -RedirectStandardError (Join-Path $logDir 'host.err.log')
  }

  # 2. tunnel process alive?
  $cf = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if (-not $cf) {
    Log 'tunnel down - restarting cloudflared (NOTE: quick tunnels mint a NEW url; see tunnel.log)'
    $cfLog = Join-Path $logDir 'tunnel.log'
    if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
    Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', 'http://localhost:5210' -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'tunnel.out.log') -RedirectStandardError $cfLog
  }

  Start-Sleep -Seconds 30
}

# Brings the shared Peer sandbox online:
#   1. builds the page, 2. starts the act-log host (port 5210) detached,
#   3. opens a Cloudflare quick tunnel (throwaway *.trycloudflare.com domain).
# Usage:  powershell -ExecutionPolicy Bypass -File .\serve-public.ps1
# Stop:   stop the node server.mjs and cloudflared processes (log persists in server-data\)
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8 scripts.
param(
  # URL of the primary host to mirror. Empty = this host IS the primary.
  # The role is written to server-data
ole.json, which server.mjs reads on
  # every boot - so watchdog restarts keep the role without carrying any
  # environment. A mirror syncs log+media from the primary and refuses writes.
  [string]$MirrorOf = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

node social/assemble.mjs | Out-Host

$logDir = Join-Path $here 'server-data'
New-Item -ItemType Directory -Force $logDir | Out-Null

# Record the role BEFORE the host starts, so the first boot already has it.
$role = [ordered]@{
  mirrorOf = $MirrorOf.TrimEnd('/')
  note     = 'Read by server.mjs on every boot. Non-empty mirrorOf = read-only mirror of that primary. To promote this mirror to primary: empty this value (or delete the file) and restart the host.'
}
[System.IO.File]::WriteAllText((Join-Path $logDir 'role.json'), ($role | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
if ($MirrorOf) { Write-Output "role: read-only MIRROR of $MirrorOf" } else { Write-Output 'role: PRIMARY (accepts writes)' }

# The operator token lives in a file in the (gitignored) data directory, not in
# this script and not in a checked-in config. Every place that starts the host
# reads it from there, so a watchdog restart does not silently drop the admin
# panel - and there is no path by which the token reaches the repository.
$tokFile = Join-Path $logDir 'operator-token.txt'
if (Test-Path $tokFile) { $env:PEER_OPERATOR_TOKEN = (Get-Content $tokFile -Raw).Trim() }
Start-Process -FilePath 'node' -ArgumentList 'server.mjs', '5210' -WorkingDirectory $here -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'host.log') -RedirectStandardError (Join-Path $logDir 'host.err.log')
Start-Sleep -Seconds 2

$cfLog = Join-Path $logDir 'tunnel.log'
if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', 'http://localhost:5210' -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'tunnel.out.log') -RedirectStandardError $cfLog

# cloudflared prints the assigned URL on stderr within a few seconds
$url = $null
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  if (Test-Path $cfLog) {
    $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}
if ($url) {
  Write-Output "PUBLIC URL: $url"
  Write-Output "Local:      http://localhost:5210"
  Write-Output "Note: quick-tunnel domains are throwaway; a restart mints a new URL."
} else {
  Write-Warning "Tunnel URL not found yet - check $cfLog"
}

# Fallback layer: a detached watchdog restarts host/tunnel if either dies.
$already = Get-CimInstance Win32_Process -Filter "Name LIKE 'powershell%'" |
  Where-Object { $_.CommandLine -match 'watchdog\.ps1' }
if (-not $already) {
  Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'watchdog.ps1') `
    -WindowStyle Hidden
  Write-Output "Watchdog started (server-data\watchdog.log)."
}

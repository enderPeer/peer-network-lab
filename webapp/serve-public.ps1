# Brings the shared Peer sandbox online:
#   1. builds the page, 2. starts the act-log host (port 5210) detached,
#   3. opens a Cloudflare quick tunnel (throwaway *.trycloudflare.com domain).
# Usage:  powershell -ExecutionPolicy Bypass -File .\serve-public.ps1
# Stop:   stop the node server.mjs and cloudflared processes (log persists in server-data\)
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8 scripts.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

node social/assemble.mjs | Out-Host

$logDir = Join-Path $here 'server-data'
New-Item -ItemType Directory -Force $logDir | Out-Null

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

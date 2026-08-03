# Turns a fresh Windows PC into a Peer host.
#
#   .\setup-host.ps1 -MirrorOf https://<current-primary>   <- START HERE
#   .\setup-host.ps1                                       <- primary (after promotion)
#
# Run the MIRROR form first, always. A new machine that starts as a primary
# while the old one is still serving means two hosts accepting acts, and the
# log forks the moment both are reachable. As a mirror it syncs the whole
# record, proves itself for as long as you like, and is promoted in one step.
#
# What it does: checks the prerequisites, installs dependencies, builds the
# app, writes the role, starts host + tunnel + watchdog, and prints the exact
# publish command for the new URL.
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  [string]$MirrorOf = '',
  [int]$Port = 5210,
  [switch]$SkipTunnel
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Say($m) { Write-Output ("  " + $m) }
function Fail($m) { Write-Error $m; exit 1 }

Write-Output ''
Write-Output '=== Peer host setup ==='
if ($MirrorOf) { Write-Output ("Role: read-only MIRROR of " + $MirrorOf) }
else { Write-Output 'Role: PRIMARY - this host will accept acts.' }
Write-Output ''

# ---- 1. prerequisites ------------------------------------------------------
Write-Output '1. Checking prerequisites'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node is not installed. Get the LTS build from https://nodejs.org and re-run this script.' }
$nodeMajor = [int]((& node -v) -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 18) { Fail ("node " + (& node -v) + " is too old - this host needs 18 or newer (it uses fetch and AbortSignal.timeout).") }
Say ("node " + (& node -v))

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say 'git missing - fine for running, needed to publish. https://git-scm.com' }
else { Say ((& git --version)) }

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf -and -not $SkipTunnel) {
  Say 'cloudflared missing - needed to expose this host to the internet.'
  Say 'Install:  winget install --id Cloudflare.cloudflared'
  Say 'Then re-run, or pass -SkipTunnel to run on the local network only.'
  Fail 'cloudflared not found'
}
if ($cf) { Say 'cloudflared present' }

# A host that sleeps is a host that is down. This is the single most common
# reason a home server "randomly" stops answering.
$sleep = (& powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) 2>$null | Out-String
if ($sleep -match 'Current AC Power Setting Index:\s*0x0000000(\d+)') {
  if ([Convert]::ToInt32($Matches[1]) -ne 0) {
    Say 'WARNING: this PC is set to sleep on AC power. It will stop serving when it does.'
    Say 'Fix:  powercfg /change standby-timeout-ac 0'
  } else { Say 'sleep on AC: disabled (good)' }
}

# ---- 2. dependencies and build --------------------------------------------
Write-Output '2. Installing dependencies'
& npm install --no-audit --no-fund | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }

Write-Output '3. Building the app'
& node social/make-icons.mjs | Out-Host
& node social/assemble.mjs | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'build failed' }

# ---- 3. role ---------------------------------------------------------------
Write-Output '4. Writing the role'
$logDir = Join-Path $here 'server-data'
New-Item -ItemType Directory -Force $logDir | Out-Null
$role = [ordered]@{
  mirrorOf = $MirrorOf.TrimEnd('/')
  note     = 'Read by server.mjs on every boot. Non-empty mirrorOf = read-only mirror of that primary. To promote: empty this value (or delete the file) and restart the host.'
}
[System.IO.File]::WriteAllText((Join-Path $logDir 'role.json'), ($role | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
Say (Join-Path $logDir 'role.json')

# A mirror pulls the whole record itself, so an empty data dir is correct and
# expected. Refuse to overwrite an existing log without the operator saying so.
$logFile = Join-Path $logDir 'acts.jsonl'
if ($MirrorOf -and (Test-Path $logFile)) {
  Say ('existing log found (' + (Get-Content $logFile | Measure-Object -Line).Lines + ' acts) - the mirror will reconcile it against the primary')
}

# ---- 4. start --------------------------------------------------------------
Write-Output '5. Starting host'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.mjs' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false } catch {} }
Start-Process -FilePath 'node' -ArgumentList 'server.mjs', "$Port" -WorkingDirectory $here -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'host.log') -RedirectStandardError (Join-Path $logDir 'host.err.log')
Start-Sleep -Seconds 3

$ok = $false
try {
  $r = Invoke-RestMethod ("http://localhost:$Port/api/acts?since=999999") -TimeoutSec 10
  $ok = $true
  Say ("host up - " + $r.total + " acts" + $(if ($r.mirror) { " (mirror of " + $r.mirror + ")" } else { " (primary)" }))
} catch { Fail ("host did not answer on port " + $Port + " - see " + (Join-Path $logDir 'host.err.log')) }

if ($MirrorOf -and $ok) {
  Write-Output '   waiting for the first sync...'
  $before = $r.total
  foreach ($i in 1..24) {
    Start-Sleep -Seconds 5
    try {
      $now = Invoke-RestMethod ("http://localhost:$Port/api/acts?since=999999") -TimeoutSec 10
      $up = Invoke-RestMethod ($MirrorOf.TrimEnd('/') + '/api/acts?since=999999') -TimeoutSec 10
      Say ("   " + $now.total + " / " + $up.total + " acts")
      if ($now.total -ge $up.total -and $up.total -gt 0) { Say 'IN SYNC with the primary.'; break }
    } catch { Say '   primary not answering yet - the mirror keeps retrying on its own' }
  }
}

# ---- 5. tunnel -------------------------------------------------------------
if (-not $SkipTunnel) {
  Write-Output '6. Opening the tunnel'
  $cfLog = Join-Path $logDir 'tunnel.log'
  if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
  Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', "http://localhost:$Port" -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'tunnel.out.log') -RedirectStandardError $cfLog
  $url = $null
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    if (Test-Path $cfLog) {
      $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
      if ($m) { $url = $m.Matches[0].Value; break }
    }
  }
  if ($url) { Say ("PUBLIC URL: " + $url) } else { Say ("tunnel URL not printed yet - check " + $cfLog) }
}

# ---- 6. watchdog -----------------------------------------------------------
$already = Get-CimInstance Win32_Process -Filter "Name LIKE 'powershell%'" |
  Where-Object { $_.CommandLine -match 'watchdog\.ps1' }
if (-not $already) {
  Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'watchdog.ps1') -WindowStyle Hidden
  Write-Output '7. Watchdog started (server-data\watchdog.log)'
}

Write-Output ''
Write-Output '=== Done ==='
if ($url) {
  if ($MirrorOf) {
    Write-Output 'This machine is a read-only mirror. Publish it as the fallback slot:'
    Write-Output ("  .\publish-site.ps1 -UpdateSlot fallback -HostUrl " + $url)
  } else {
    Write-Output 'This machine is the primary. Publish it as the primary slot:'
    Write-Output ("  .\publish-site.ps1 -UpdateSlot primary -HostUrl " + $url)
  }
}
Write-Output 'Promotion, migration and the full runbook: webapp\HOSTING.md'
Write-Output ''

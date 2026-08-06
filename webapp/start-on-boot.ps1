# Bring the whole thing back after a reboot, in one step and idempotently.
#
# The watchdog keeps the host and tunnel alive while Windows is running, but
# nothing survived a shutdown: after a reboot somebody had to remember to
# start the host, notice that the quick tunnel had minted a NEW address, and
# publish that address before anyone could reach the network again. This
# script is that memory, and register-boot-task.ps1 hands it to the Task
# Scheduler so it happens at logon without anyone present.
#
# Safe to run at any time: every step checks whether it is already done.
#
#   powershell -ExecutionPolicy Bypass -File .\start-on-boot.ps1
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  # Skip republishing the address (useful when testing offline).
  [switch]$NoPublish
)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$logDir = Join-Path $here 'server-data'
New-Item -ItemType Directory -Force $logDir | Out-Null
$bootLog = Join-Path $logDir 'boot.log'

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  $line | Add-Content -Path $bootLog
  Write-Output $line
}

function HostAnswers {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:5210/api/acts?since=999999' -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

Log '--- start-on-boot ---'

# 1. The host, the tunnel and the watchdog. serve-public.ps1 starts all three
#    and writes the role file first, so a restart cannot silently become a
#    second writer.
if (HostAnswers) {
  Log 'host already answering on 5210 - not starting a second one'
} else {
  Log 'host down - running serve-public.ps1'
  & (Join-Path $here 'serve-public.ps1') | Out-Host
  foreach ($i in 1..30) { Start-Sleep -Seconds 2; if (HostAnswers) { break } }
  if (HostAnswers) { Log 'host is up' } else { Log 'WARNING: host still not answering' }
}

# The watchdog is what keeps it up afterwards; serve-public starts it, but
# not if the host was already running when this script began.
$wd = Get-CimInstance Win32_Process -Filter "Name LIKE 'powershell%'" |
  Where-Object { $_.CommandLine -match 'watchdog\.ps1' }
if (-not $wd) {
  Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'watchdog.ps1') -WindowStyle Hidden
  Log 'watchdog started'
} else {
  Log 'watchdog already running'
}

# 2. The address. A quick tunnel mints a new hostname on every start, so the
#    published address book is stale the moment this machine reboots. Publish
#    only when it actually changed: every publish is a commit on gh-pages.
if (-not $NoPublish) {
  $cfLog = Join-Path $logDir 'tunnel.log'
  $url = $null
  foreach ($i in 1..30) {
    if (Test-Path $cfLog) {
      $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
      if ($m) { $url = $m.Matches[$m.Matches.Count - 1].Value }
    }
    if ($url) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $url) {
    Log 'WARNING: no tunnel URL yet - address not published (the liveness workflow will point the app at the archive meanwhile)'
  } else {
    $published = ''
    try { $published = [string](Invoke-RestMethod 'https://enderpeer.github.io/peer-network-lab/host.json' -TimeoutSec 20).url } catch {}
    if ($published -eq $url) {
      Log "address unchanged ($url) - nothing to publish"
    } else {
      Log "address changed: '$published' -> '$url' - publishing"
      & (Join-Path $here 'publish-site.ps1') -UpdateSlot primary -HostUrl $url -Archive | Out-Host
      Log 'published'
    }
  }
}

# 3. The resident bot. Its loop does not survive a reboot either, and it is
#    the only account that keeps the network moving while nobody is at the
#    keyboard.
$agentDir = Join-Path $repo 'agent'
if (Test-Path (Join-Path $agentDir '.env')) {
  $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'agent\.mjs --forever' }
  if ($running) {
    Log 'ICEsoul already running'
  } elseif (Test-Path (Join-Path $agentDir 'run-forever.ps1')) {
    Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $agentDir 'run-forever.ps1') -WindowStyle Hidden
    Log 'ICEsoul started'
  }
} else {
  Log 'no agent/.env - skipping the local bot'
}

Log '--- done ---'

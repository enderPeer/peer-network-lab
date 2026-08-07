# Ask Windows to run start-on-boot.ps1 at logon, so a reboot brings the
# network back without anybody remembering to.
#
#   powershell -ExecutionPolicy Bypass -File .\register-boot-task.ps1
#   powershell -ExecutionPolicy Bypass -File .\register-boot-task.ps1 -Remove
#
# No administrator rights needed: the task runs as the logged-in user, which
# is the same account that owns the data directory, the git credentials and
# the tunnel binary. A SYSTEM-level task would have none of those.
#
# ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'PeerNetworkHost'
$script = Join-Path $here 'start-on-boot.ps1'
# The no-privilege route. Creating a scheduled task needs rights this account
# does not always have (it answered "Zugriff verweigert" on the machine this
# was written for), and a startup shortcut needs none: the Startup folder
# belongs to the user, runs at logon, and is trivial to inspect or delete.
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupCmd = Join-Path $startupDir 'peer-network-host.cmd'
# The user-level autostart registry key - the SECOND redundant trigger. On
# 2026-08-07 the Startup-folder entry silently did not fire after a real
# shutdown (boot.log empty for that boot, cause unknown), and the host stayed
# dark until a hand started it. Two independent triggers into one idempotent
# script: whichever fires second finds the host answering and logs that.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'PeerNetworkHost'

if ($Remove) {
  schtasks /Query /TN $taskName > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Host
    Write-Output "removed the '$taskName' scheduled task"
  }
  if (Test-Path $startupCmd) {
    Remove-Item $startupCmd -Force
    Write-Output "removed $startupCmd"
  }
  try { Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop; Write-Output "removed the $runName Run entry" } catch {}
  Write-Output 'the network no longer starts at logon'
  return
}

if (-not (Test-Path $script)) { throw "missing $script" }

# Try the scheduled task first: it can carry a start delay, which gives the
# network stack and the tunnel binary a moment to settle before an address
# is requested. /RL LIMITED = no elevation. /F = replace, never stack.
$cmd = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$registered = $null
# Through cmd, so schtasks' stderr is swallowed THERE: in PowerShell 5.1 a
# native command writing to a redirected stderr becomes an ErrorRecord, and
# under ErrorActionPreference=Stop the denial would kill the script before
# the fallback below ever ran.
cmd /c "schtasks /Create /TN $taskName /TR `"$cmd`" /SC ONLOGON /RL LIMITED /DELAY 0001:00 /F >nul 2>nul"
if ($LASTEXITCODE -eq 0) {
  $registered = "scheduled task '$taskName'"
} else {
  # Denied - use the Startup folder instead, and do the waiting ourselves.
  New-Item -ItemType Directory -Force $startupDir | Out-Null
  $body = @(
    '@echo off',
    'rem Starts the Peer Network host at logon. Written by register-boot-task.ps1.',
    'rem Delete this file to stop it.',
    'timeout /t 60 /nobreak > nul',
    ('powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)
  ) -join "`r`n"
  [System.IO.File]::WriteAllText($startupCmd, $body + "`r`n", (New-Object System.Text.ASCIIEncoding))
  $registered = "startup entry $startupCmd (a scheduled task was denied, which needs no explaining: this route needs no rights at all)"
}

# The Run key fires at logon regardless of what the Startup folder does -
# observed necessary, not theoretical (see the note at the top). The .cmd's
# own 60s delay is reused when it exists; otherwise call the script directly.
$runTarget = if (Test-Path $startupCmd) { ('cmd /c "{0}"' -f $startupCmd) } else { $cmd }
Set-ItemProperty -Path $runKey -Name $runName -Value $runTarget
$registered = "$registered + the $runName Run entry (two triggers, one idempotent script)"

Write-Output ''
Write-Output "Registered: $registered"
Write-Output 'At every logon, one minute in, this machine will'
Write-Output '  - start the host, the tunnel and the watchdog if they are not running'
Write-Output '  - publish the new tunnel address if it changed'
Write-Output '  - restart the local bot'
Write-Output ''
Write-Output 'Run it now without waiting for a logon:'
Write-Output "  powershell -ExecutionPolicy Bypass -File `"$script`""
Write-Output 'See what it did:  webapp\server-data\boot.log'
Write-Output "Undo:             .\register-boot-task.ps1 -Remove"
# A refused schtasks left its exit code behind; the fallback succeeded, so
# say so with the exit code too, or a caller checking $LASTEXITCODE reads a
# success as a failure.
exit 0

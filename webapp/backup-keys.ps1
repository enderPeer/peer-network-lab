# The go-bag: every key and credential this project cannot regenerate,
# gathered into one dated zip you can carry off this machine.
#
#   .\backup-keys.ps1                 -> writes to the Desktop
#   .\backup-keys.ps1 -To E:\         -> writes to a USB stick
#   .\backup-keys.ps1 -NoLog          -> skip the act log (smaller; the log
#                                        is public and published anyway)
#
# Why a script rather than "copy the folder": the things that matter are
# scattered by design - the producer key lives beside the log it signs, the
# bot's PIN lives with the bot, the mirror identities live in their own
# folder - and a backup that silently misses one is worse than no backup,
# because it is believed. This checks every entry and refuses to write a
# half-empty archive.
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  [string]$To = [Environment]::GetFolderPath('Desktop'),
  [switch]$NoLog
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$data = Join-Path $here 'server-data'

# name -> @(path, required, what is lost without it)
$items = @(
  @{ n = 'decentral-keys\nsite-secret-hex.txt';        p = (Join-Path $data 'decentral-keys\nsite-secret-hex.txt');        req = $true;  why = 'the nsite mirror can never be updated again' },
  @{ n = 'decentral-keys\radicle-identity-backup.tar.gz'; p = (Join-Path $data 'decentral-keys\radicle-identity-backup.tar.gz'); req = $true; why = 'the Radicle repo can never be pushed to again' },
  @{ n = 'decentral-keys\radicle-passphrase.txt';      p = (Join-Path $data 'decentral-keys\radicle-passphrase.txt');      req = $true;  why = 'the Radicle key above cannot be unlocked' },
  @{ n = 'decentral-keys\README.md';                   p = (Join-Path $data 'decentral-keys\README.md');                   req = $true;  why = 'the instructions for using all of this' },
  @{ n = 'chain\producer.pem';                         p = (Join-Path $data 'chain\producer.pem');                         req = $true;  why = 'future epoch blocks are signed by a different producer' },
  @{ n = 'operator-token.txt';                         p = (Join-Path $data 'operator-token.txt');                         req = $false; why = 'the /admin panel answers 404 until a new token is set' },
  @{ n = 'btc-address.txt';                            p = (Join-Path $data 'btc-address.txt');                            req = $false; why = 'adverts stop being accepted until re-set' },
  @{ n = 'agent\.env';                                 p = (Join-Path $repo 'agent\.env');                                 req = $false; why = 'the resident bot cannot sign in as itself' },
  @{ n = 'role.json';                                  p = (Join-Path $data 'role.json');                                  req = $false; why = 'the host role has to be set by hand' }
)
if (-not $NoLog) {
  $items += @{ n = 'acts.jsonl'; p = (Join-Path $data 'acts.jsonl'); req = $true; why = 'THE NETWORK ITSELF (also public - see MIRRORS.md)' }
  $items += @{ n = 'chain\blocks.jsonl'; p = (Join-Path $data 'chain\blocks.jsonl'); req = $false; why = 'the sealed chain (re-sealable from the log)' }
}

$stamp = Get-Date -Format 'yyyy-MM-dd'
$stage = Join-Path $env:TEMP ("peer-keys-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $stage | Out-Null

$missingRequired = @()
$copied = 0
foreach ($it in $items) {
  $ok = (Test-Path $it.p) -and ((Get-Item $it.p).Length -gt 0)
  if (-not $ok) {
    if ($it.req) { $missingRequired += $it }
    else { Write-Output ("skip  " + $it.n + "  (not present - " + $it.why + ")") }
    continue
  }
  $dest = Join-Path $stage $it.n
  New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
  Copy-Item $it.p $dest -Force
  $copied++
  Write-Output ("copy  " + $it.n)
}

if ($missingRequired.Count -gt 0) {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output ''
  Write-Output 'REFUSING to write the archive: these are missing, and a backup believed to be complete is worse than none.'
  foreach ($m in $missingRequired) { Write-Output ("  " + $m.n + " - without it, " + $m.why) }
  throw 'incomplete key set'
}

# A plain-text index, so the archive explains itself to whoever opens it in
# a year without this repository at hand.
$index = @()
$index += "Peer Network - keys and credentials, $stamp"
$index += ''
$index += 'These cannot be regenerated. Restoring them is documented in'
$index += 'decentral-keys\README.md inside this archive, and at'
$index += 'https://github.com/enderPeer/peer-network-lab/blob/main/MIRRORS.md'
$index += ''
$index += 'Public identities these keys control:'
$index += '  nsite   npub1jdtd0md8gy5zjd7gghqn9kr9jekmczp6hc3spy5n5nftvdd47urq8px80w'
$index += '  Radicle rad:z2suiiv5cu2DWLQ1zmHG5d12Wy4pL'
$index += '  chain   producer key for the epoch blocks in this network'
$index += ''
$index += 'Contents:'
foreach ($it in $items) { if (Test-Path (Join-Path $stage $it.n)) { $index += ("  " + $it.n + "  -  " + $it.why) } }
[System.IO.File]::WriteAllText((Join-Path $stage 'WHAT-IS-THIS.txt'), ($index -join "`r`n"), (New-Object System.Text.UTF8Encoding $false))

if (-not (Test-Path $To)) { New-Item -ItemType Directory -Force $To | Out-Null }
$zip = Join-Path $To ("peer-network-keys-$stamp.zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$size = [Math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Output ''
Write-Output ("wrote $zip  ($size MB, $copied item(s))")
Write-Output 'Now put a copy somewhere that is not this disk: a USB stick, a phone, a password manager.'
Write-Output 'It is NOT encrypted - anyone holding it can publish as these identities.'

# Packs the whole site - app, archive, epoch chain - into a CAR file for IPFS.
#
#   .\publish-ipfs.ps1               -> rebuild app, refresh archive + chain, pack
#   .\publish-ipfs.ps1 -SkipMedia    -> refresh without copying media blobs
#
# This PUBLISHES NOTHING by itself. The output is a local .car file and the
# address it will have once pinned. Pinning is a separate, deliberate step
# (your own node, or any pinning service) because an IPFS publish is a
# ratchet: content under a CID that others pin cannot be taken back. Read the
# 'what a snapshot carries' note in DECENTRALIZATION.md before the first pin.
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  [switch]$SkipMedia
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$site = Join-Path $repo 'site'

# 1. The app, built fresh into the site folder.
Write-Output 'building app...'
node (Join-Path $here 'social\assemble.mjs') (Join-Path $site 'app.html') | Out-Host

# 2. The archive, refreshed from the live log - same shape publish-site.ps1
#    writes, so the snapshot in the CAR equals the snapshot on Pages.
$srcLog = Join-Path $here 'server-data\acts.jsonl'
if (Test-Path $srcLog) {
  $archDir = Join-Path $site 'archive'
  New-Item -ItemType Directory -Force $archDir | Out-Null
  Copy-Item $srcLog (Join-Path $archDir 'acts.jsonl') -Force
  $lineCount = (Get-Content $srcLog | Where-Object { $_.Trim() } | Measure-Object).Count
  $sha = (Get-FileHash (Join-Path $archDir 'acts.jsonl') -Algorithm SHA256).Hash.ToLower()

  if (-not $SkipMedia) {
    $srcMedia = Join-Path $here 'server-data\media'
    if (Test-Path $srcMedia) {
      $dstMedia = Join-Path $archDir 'media'
      New-Item -ItemType Directory -Force $dstMedia | Out-Null
      Copy-Item (Join-Path $srcMedia '*') $dstMedia -Force -ErrorAction SilentlyContinue
    }
  }
  $blobDir = Join-Path $archDir 'media'
  $hasMedia = (Test-Path $blobDir) -and ((Get-ChildItem $blobDir -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)

  # The chain: seal any uncovered epochs, export blocks + HEAD (never the key).
  $chainInfo = $null
  node (Join-Path $here 'chain\build.mjs') --export (Join-Path $archDir 'chain') | Out-Host
  if ($LASTEXITCODE -eq 0) {
    $headFile = Join-Path $archDir 'chain\HEAD.json'
    if (Test-Path $headFile) {
      $head = Get-Content $headFile -Raw | ConvertFrom-Json
      $chainInfo = [ordered]@{ height = $head.height; hash = $head.hash; producer = $head.producer }
    }
  } else {
    Write-Output 'chain export failed; packing without it'
  }

  # host.json stays whatever was last published: the snapshot keeps pointing
  # at the live host list, and falls through to the archive when none answers.
  $hostUrl = ''
  $hostFile = Join-Path $site 'host.json'
  if (Test-Path $hostFile) {
    try { $hostUrl = [string]((Get-Content $hostFile -Raw | ConvertFrom-Json).url) } catch {}
  }

  $man = [ordered]@{
    acts    = $lineCount
    sha256  = $sha
    at      = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    host    = $hostUrl
    media   = [bool]$hasMedia
    note    = 'A snapshot of the act log. Replay it with webapp/social/replay.cjs and you get the same standings, feeds and balances the live host computes - that is what makes this a verifiable copy rather than a backup you have to trust.'
  }
  if ($chainInfo) { $man.chain = $chainInfo }
  [System.IO.File]::WriteAllText(
    (Join-Path $archDir 'manifest.json'),
    ($man | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding $false))
  Write-Output ("archive -> $lineCount acts, sha256 " + $sha.Substring(0, 16) + '...')
} else {
  Write-Output 'no live log here; packing the site as it stands'
}

# 3. The CAR.
node (Join-Path $here 'tools\ipfs-pack.mjs') | Out-Host

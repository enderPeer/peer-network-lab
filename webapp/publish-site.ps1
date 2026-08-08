# Publishes the stable public site to the gh-pages branch.
#
#   .\publish-site.ps1                     -> app + landing page, no shared host
#   .\publish-site.ps1 -HostUrl https://x  -> also point the app at that host
#   .\publish-site.ps1 -FromTunnelLog      -> read the URL cloudflared just printed
#
# Why this exists: the app has a permanent address (GitHub Pages) while the
# host it talks to sits on a Cloudflare quick tunnel whose domain changes on
# every restart. The permanent side carries a host.json naming the current one;
# when no host answers, the app runs its in-browser sandbox instead, so the
# address is never dead.
#
# gh-pages is used rather than /docs because docs/ holds the spec author's
# material and is gitignored - it must never reach a public branch.
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 misparses BOM-less UTF-8.
param(
  [string]$HostUrl = '',
  # Second entry for host.json's urls list: the read-only mirror the app
  # falls back to when the primary does not answer.
  [string]$FallbackUrl = '',
  [switch]$FromTunnelLog,
  # Update only this machine's slot and keep the other one as published:
  #   -UpdateSlot primary  -FromTunnelLog   (the primary's tunnel changed)
  #   -UpdateSlot fallback -FromTunnelLog   (the mirror's tunnel changed)
  # Reads the currently published host.json from Pages first, so neither
  # machine can wipe the other's entry by publishing from its own folder.
  [ValidateSet('', 'primary', 'fallback')][string]$UpdateSlot = '',
  # Any number of read-only mirrors, tried in order after the primary.
  [string[]]$Mirrors = @(),
  # Publish the act log itself alongside the app, so the network stays
  # READABLE when every host is off. Costs nothing: it is a static file on
  # hosting that is already paid for by nobody.
  [switch]$Archive,
  # Include media blobs in the archive. Bigger, but it is the difference
  # between an archive you can read and one you can look at.
  [switch]$ArchiveMedia
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$site = Join-Path $repo 'site'

if ($FromTunnelLog) {
  $cfLog = Join-Path $here 'server-data\tunnel.log'
  if (-not (Test-Path $cfLog)) { throw "no tunnel log at $cfLog - start serve-public.ps1 first" }
  $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches
  if (-not $m) { throw "no tunnel URL in $cfLog yet" }
  $HostUrl = $m.Matches[$m.Matches.Count - 1].Value
  Write-Output "tunnel URL from log: $HostUrl"
}

# 1. Build the app straight into the site folder.
Write-Output 'building app...'
node (Join-Path $here 'social\assemble.mjs') (Join-Path $site 'app.html') | Out-Host

# 2. Record which host(s) the app should reach for (empty = sandbox only).
#    urls is ordered: primary first, mirror second. The app probes in order,
#    so the mirror only ever serves people the primary has already failed.
if ($UpdateSlot) {
  $liveCfg = $null
  try { $liveCfg = Invoke-RestMethod 'https://enderpeer.github.io/peer-network-lab/host.json' -TimeoutSec 15 } catch {}
  $curPrimary = ''
  $curFallback = ''
  if ($liveCfg) {
    $curPrimary = [string]$liveCfg.url
    if ($liveCfg.urls -and $liveCfg.urls.Count -gt 1) { $curFallback = [string]$liveCfg.urls[1] }
  }
  if ($UpdateSlot -eq 'primary') { $FallbackUrl = $curFallback }
  if ($UpdateSlot -eq 'fallback') { $FallbackUrl = $HostUrl; $HostUrl = $curPrimary }
  Write-Output "slots -> primary: $HostUrl | fallback: $FallbackUrl"
}
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$cfg = [ordered]@{
  url     = $HostUrl
  updated = $stamp
  note    = 'Written by publish-site.ps1. urls is ordered, primary first; a second entry is a read-only mirror the app falls back to when the primary does not answer. An empty url means no shared host is published; the app then runs entirely in your browser.'
}
# urls is the ordered probe list: primary, then every mirror. One entry or
# ten, the app walks it top to bottom and stops at the first that answers.
$allUrls = @()
if ($HostUrl) { $allUrls += $HostUrl.TrimEnd('/') }
if ($FallbackUrl) { $allUrls += $FallbackUrl.TrimEnd('/') }
foreach ($m in $Mirrors) { if ($m) { $allUrls += $m.TrimEnd('/') } }
$allUrls = $allUrls | Select-Object -Unique
if ($allUrls.Count -gt 1) { $cfg.Insert(1, 'urls', @($allUrls)) }

# ── The archive: the network as a file ───────────────────────────────────
#
# A snapshot of the act log published next to the app. When no host answers,
# the app loads this instead of falling back to an empty private sandbox, so
# the record survives every machine being switched off — and anyone can
# download it, replay it and check every number in it for themselves.
#
# The manifest carries the act count and a SHA-256 of the file. The app
# refuses a snapshot that does not match, because a truncated archive that
# looks live is worse than none: everything computed from it would be wrong
# and nothing would say so.
if ($Archive) {
  $srcLog = Join-Path $here 'server-data\acts.jsonl'
  if (-not (Test-Path $srcLog)) { throw "no act log at $srcLog" }
  $archDir = Join-Path $site 'archive'
  New-Item -ItemType Directory -Force $archDir | Out-Null
  Copy-Item $srcLog (Join-Path $archDir 'acts.jsonl') -Force
  $lineCount = (Get-Content $srcLog | Where-Object { $_.Trim() } | Measure-Object).Count
  $sha = (Get-FileHash (Join-Path $archDir 'acts.jsonl') -Algorithm SHA256).Hash.ToLower()

  # Copy the blobs BEFORE the manifest is written, so the manifest can describe
  # what is actually published instead of which switch was passed. The app now
  # reads this flag to resolve archive/media/<hash>, so a `true` beside an empty
  # folder is a promise of pictures that 404.
  if ($ArchiveMedia) {
    $srcMedia = Join-Path $here 'server-data\media'
    if (Test-Path $srcMedia) {
      $dstMedia = Join-Path $archDir 'media'
      New-Item -ItemType Directory -Force $dstMedia | Out-Null
      Copy-Item (Join-Path $srcMedia '*') $dstMedia -Force -ErrorAction SilentlyContinue
      $mb = [math]::Round(((Get-ChildItem $dstMedia -File | Measure-Object Length -Sum).Sum / 1MB), 1)
      Write-Output "archive -> media included ($mb MB)"
    }
  }
  $blobDir = Join-Path $archDir 'media'
  $hasMedia = (Test-Path $blobDir) -and ((Get-ChildItem $blobDir -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  if (-not $ArchiveMedia -and $hasMedia) {
    Write-Output 'archive -> media already published from an earlier run; the manifest says so'
  }

  # The epoch chain, published beside the log it attests. Seals any closed
  # epochs the chain has not covered yet, then exports blocks.jsonl and
  # HEAD.json only - the producer key never leaves server-data. A verifier
  # holding this folder needs no further word from any host:
  #   node chain/verify.mjs --acts site/archive/acts.jsonl --chain site/archive/chain/blocks.jsonl
  $chainInfo = $null
  node (Join-Path $here 'chain\build.mjs') --export (Join-Path $archDir 'chain') | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Output 'archive -> chain export failed; publishing without it'
  } else {
    $headFile = Join-Path $archDir 'chain\HEAD.json'
    if (Test-Path $headFile) {
      $head = Get-Content $headFile -Raw | ConvertFrom-Json
      $chainInfo = [ordered]@{ height = $head.height; hash = $head.hash; producer = $head.producer }
      Write-Output ("archive -> chain at height " + $head.height + ", head " + $head.hash.Substring(0, 16) + '...')
    }
  }

  $man = [ordered]@{
    acts    = $lineCount
    sha256  = $sha
    at      = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    host    = $HostUrl
    media   = [bool]$hasMedia
    note    = 'A snapshot of the act log. Replay it with webapp/social/replay.cjs and you get the same standings, feeds and balances the live host computes - that is what makes this a verifiable copy rather than a backup you have to trust.'
  }
  if ($chainInfo) { $man.chain = $chainInfo }
  [System.IO.File]::WriteAllText(
    (Join-Path $archDir 'manifest.json'),
    ($man | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding $false))
  Write-Output ("archive -> $lineCount acts, sha256 " + $sha.Substring(0, 16) + '...')
}
# WriteAllText with an explicit no-BOM encoder: PowerShell 5.1's -Encoding utf8
# emits a byte-order mark, and a BOM in front of JSON breaks strict parsers.
[System.IO.File]::WriteAllText(
  (Join-Path $site 'host.json'),
  ($cfg | ConvertTo-Json),
  (New-Object System.Text.UTF8Encoding $false))
if ($HostUrl) { Write-Output "host.json -> $HostUrl" } else { Write-Output 'host.json -> (none; sandbox only)' }

# 3. Push the site folder to gh-pages via a detached worktree, so nothing about
#    the working tree or the main branch is disturbed.
$wt = Join-Path $env:TEMP ('peer-ghpages-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# ls-remote is the safe probe: it prints nothing and succeeds when the branch is
# absent, whereas `fetch` on a missing ref is a hard failure that would abort
# the whole script on the very first publish.
$remoteRef = git -C $repo ls-remote --heads origin gh-pages
$hasBranch = -not [string]::IsNullOrWhiteSpace(($remoteRef -join ''))

if ($hasBranch) {
  git -C $repo fetch origin gh-pages | Out-Host
  git -C $repo worktree add --detach $wt FETCH_HEAD | Out-Host
} else {
  Write-Output 'gh-pages does not exist yet - creating it'
  git -C $repo worktree add --detach $wt | Out-Host
  Push-Location $wt
  try {
    git checkout --orphan gh-pages | Out-Host
    # An orphan checkout still carries the index from main; empty it so the
    # published branch contains only the site.
    git reset --hard | Out-Null
    # Sealed records survive a publish. genesis-N/ holds a finished network,
  # kept at a permanent address precisely so a later restart cannot erase
  # what came before it - and this line used to delete exactly that.
  Get-ChildItem $wt -Force | Where-Object { $_.Name -ne '.git' -and $_.Name -notlike 'genesis-*' } | Remove-Item -Recurse -Force
  } finally { Pop-Location }
}

try {
  # Sealed records survive a publish. genesis-N/ holds a finished network,
  # kept at a permanent address precisely so a later restart cannot erase
  # what came before it - and this line used to delete exactly that.
  Get-ChildItem $wt -Force | Where-Object { $_.Name -ne '.git' -and $_.Name -notlike 'genesis-*' } | Remove-Item -Recurse -Force
  Copy-Item (Join-Path $site '*') $wt -Recurse -Force
  # Tell GitHub Pages not to run Jekyll: it would drop files starting with _
  # and rewrite things we hand-authored.
  New-Item -ItemType File -Path (Join-Path $wt '.nojekyll') -Force | Out-Null

  git -C $wt add -A | Out-Host
  $dirty = git -C $wt status --porcelain
  if (-not $dirty) {
    Write-Output 'site unchanged - nothing to publish'
  } else {
    git -C $wt commit -m "Publish site$(if ($HostUrl) { " - host $HostUrl" } else { '' }) ($stamp)" | Out-Host
    git -C $wt push origin HEAD:gh-pages | Out-Host
    Write-Output ''
    Write-Output 'Published: https://enderpeer.github.io/peer-network-lab/'
    Write-Output 'If this is the first publish, enable Pages once:'
    Write-Output '  GitHub -> Settings -> Pages -> Source: deploy from branch -> gh-pages / (root)'
  }
} finally {
  git -C $repo worktree remove $wt --force 2>$null | Out-Null
}

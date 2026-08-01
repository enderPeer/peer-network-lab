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
  [switch]$FromTunnelLog
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

# 2. Record which host the app should reach for (empty = sandbox only).
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$cfg = [ordered]@{
  url     = $HostUrl
  updated = $stamp
  note    = 'Written by publish-site.ps1. An empty url means no shared host is published; the app then runs entirely in your browser.'
}
$cfg | ConvertTo-Json | Set-Content (Join-Path $site 'host.json') -Encoding utf8
if ($HostUrl) { Write-Output "host.json -> $HostUrl" } else { Write-Output 'host.json -> (none; sandbox only)' }

# 3. Push the site folder to gh-pages via a detached worktree, so nothing about
#    the working tree or the main branch is disturbed.
$wt = Join-Path $env:TEMP ('peer-ghpages-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
git -C $repo fetch origin gh-pages 2>$null | Out-Null
$hasBranch = (git -C $repo ls-remote --heads origin gh-pages) -ne $null -and (git -C $repo ls-remote --heads origin gh-pages).Length -gt 0

if ($hasBranch) {
  git -C $repo worktree add --detach $wt origin/gh-pages | Out-Host
} else {
  Write-Output 'gh-pages does not exist yet - creating it'
  git -C $repo worktree add --detach $wt | Out-Host
  git -C $wt checkout --orphan gh-pages | Out-Host
  git -C $wt rm -rf . 2>$null | Out-Null
}

try {
  Get-ChildItem $wt -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
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

# Builds the Peer Network spec PDF using TeX Live inside WSL Ubuntu.
# Usage:  powershell -ExecutionPolicy Bypass -File .\build.ps1
# Output: PeerNetwork_PeerNetwork_v0.24.1-dev.pdf next to this script.

$ErrorActionPreference = 'Stop'
$texName = 'PeerNetwork_PeerNetwork_v0.24.1-dev_flat.tex'
$jobName = 'PeerNetwork_PeerNetwork_v0.24.1-dev'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path

# Compile in a WSL-native directory (much faster than /mnt/c), then copy back.
$winSrc = (Join-Path $here $texName) -replace '\\','/' -replace '^C:','/mnt/c'
wsl -d Ubuntu -- bash -c "set -e; mkdir -p ~/peernetwork-build; cp '$winSrc' ~/peernetwork-build/; cd ~/peernetwork-build; latexmk -lualatex -jobname='$jobName' -interaction=nonstopmode -file-line-error '$texName'"
if ($LASTEXITCODE -ne 0) { Write-Warning "latexmk exited with code $LASTEXITCODE (check log)"; }

$winDst = $here -replace '\\','/' -replace '^C:','/mnt/c'
wsl -d Ubuntu -- bash -c "cp ~/peernetwork-build/'$jobName'.pdf '$winDst'/ 2>/dev/null; cp ~/peernetwork-build/'$jobName'.log '$winDst'/build.log 2>/dev/null; true"
Write-Output "Done. PDF: $here\$jobName.pdf   Log: $here\build.log"

# Keeps the local Relay agent alive 24/7. Restarts it if it ever exits.
# Start detached (survives closing this session, not a reboot):
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"C:\Users\User\Desktop\ToRuleThemAll\agent\run-forever.ps1"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
while ($true) {
  if ((Test-Path agent.log) -and ((Get-Item agent.log).Length -gt 20MB)) { Move-Item -Force agent.log agent.log.1 }
  cmd /c "node agent.mjs --forever >> agent.log 2>&1"
  Add-Content agent.log "$(Get-Date -Format o) agent exited (code $LASTEXITCODE) - restarting in 30s"
  Start-Sleep -Seconds 30
}

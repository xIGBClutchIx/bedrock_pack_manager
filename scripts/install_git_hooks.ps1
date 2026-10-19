$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

git config core.hooksPath .githooks

Write-Host "Installed repository Git hooks:"
Write-Host "  pre-commit -> npm run lint && npm run typecheck"
Write-Host "  pre-push   -> npm test"

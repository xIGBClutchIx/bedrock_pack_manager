$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

git config core.hooksPath .githooks

Write-Host "Installed repository Git hooks:"
Write-Host "  pre-commit -> python -m ruff check . (from .venv)"
Write-Host "  pre-push   -> python -m pytest (from .venv)"

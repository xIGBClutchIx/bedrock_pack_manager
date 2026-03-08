$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

python -m PyInstaller `
  --onefile `
  --name bedrock-pack-installer `
  bedrock_pack_installer.py

Write-Host ""
Write-Host "Built executable:"
Write-Host "  $RootDir\\dist\\bedrock-pack-installer.exe"

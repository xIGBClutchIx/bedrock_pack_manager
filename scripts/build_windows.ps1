$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

python -m PyInstaller `
  --onefile `
  --name bedrock-pack-manager `
  --add-data "bedrock_pack_manager/web/static;bedrock_pack_manager/web/static" `
  --collect-submodules paramiko `
  bedrock_pack_manager.py

Write-Host ""
Write-Host "Built executable:"
Write-Host "  $RootDir\\dist\\bedrock-pack-manager.exe"

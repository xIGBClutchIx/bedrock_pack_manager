#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python -m PyInstaller \
  --onefile \
  --name bedrock-pack-manager \
  bedrock_pack_manager.py

echo
echo "Built executable:"
echo "  $ROOT_DIR/dist/bedrock-pack-manager"

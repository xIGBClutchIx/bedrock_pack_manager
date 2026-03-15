#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push

echo "Installed repository Git hooks:"
echo "  pre-commit -> python -m ruff check . (from .venv)"
echo "  pre-push   -> python -m pytest (from .venv)"

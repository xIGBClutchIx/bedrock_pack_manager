#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push

echo "Installed repository Git hooks:"
echo "  pre-commit -> npm run lint && npm run typecheck"
echo "  pre-push   -> npm test"

#!/usr/bin/env bash
# ValidatorShift agent installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/Eternally-black/validator-shift/main/scripts/install.sh | bash
set -euo pipefail

if ! command -v node >/dev/null; then
  echo "Node.js 20+ required. Install from https://nodejs.org first." >&2
  exit 1
fi

echo "Installing @validator-shift/agent globally..."
npm install -g @validator-shift/agent

echo ""
echo "Done. Run: validator-shift agent --role <source|target> --session <code> --hub <wssUrl> ..."
echo "Repo: https://github.com/Eternally-black/validator-shift"

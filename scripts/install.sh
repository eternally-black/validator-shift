#!/usr/bin/env bash
# ValidatorShift agent installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/Eternally-black/validator-shift/main/scripts/install.sh | bash
set -euo pipefail

# Pin the agent version we install. Bump on each release.
AGENT_VERSION="${VALIDATOR_SHIFT_AGENT_VERSION:-0.1.0}"

if ! command -v node >/dev/null; then
  echo "Node.js 20+ required. Install from https://nodejs.org first." >&2
  exit 1
fi

# Verify Node major version (>= 20) before doing anything else.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "Node.js 20+ required. Detected major version ${NODE_MAJOR}." >&2
  exit 1
fi

if ! command -v npm >/dev/null; then
  echo "npm required. Install Node.js (which ships npm) from https://nodejs.org." >&2
  exit 1
fi

echo "Installing @validator-shift/agent@${AGENT_VERSION} globally..."
# --ignore-scripts blocks postinstall hooks from any transitive dep — the agent
# itself does not require native compilation, so this is safe and dramatically
# reduces supply-chain blast radius.
npm install -g --ignore-scripts "@validator-shift/agent@${AGENT_VERSION}"

echo ""
echo "Done. Run: validator-shift agent --role <source|target> --session <code> --hub <wssUrl> ..."
echo "Repo: https://github.com/Eternally-black/validator-shift"

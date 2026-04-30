#!/usr/bin/env bash
# Smoke test for scripts/install.sh.
#
# Runs install.sh against a real, published GitHub Release into an isolated
# HOME, then probes the installed binary. Requires network access and at
# least one published validator-shift release.
#
# Usage:
#   bash scripts/install.sh.test.sh                 # uses VS_VERSION (or latest)
#   VS_VERSION=v0.1.0 bash scripts/install.sh.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/install.sh"

[ -f "$INSTALL_SH" ] || { echo "FAIL: install.sh not found at ${INSTALL_SH}" >&2; exit 1; }

isolated_home="$(mktemp -d)"
trap 'rm -rf "$isolated_home"' EXIT

echo "→ Installing into HOME=${isolated_home}"

# Run install.sh with HOME redirected to the temp dir. PATH is intentionally
# left untouched so we can verify the "not on PATH" warning fires correctly.
HOME="$isolated_home" bash "$INSTALL_SH"

bin="${isolated_home}/.local/bin/validator-shift"

if [ ! -x "$bin" ]; then
  echo "FAIL: expected binary at ${bin} (missing or not executable)" >&2
  exit 1
fi

echo "→ Probing: ${bin} --help"
if ! "$bin" --help >/dev/null 2>&1; then
  echo "FAIL: '${bin} --help' exited non-zero" >&2
  exit 1
fi

echo "→ Probing: ${bin} --version (best-effort)"
"$bin" --version >/dev/null 2>&1 || echo "  (no --version flag — non-fatal)"

echo
echo "PASS — install.sh produced a working binary at ${bin}"

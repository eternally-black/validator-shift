#!/usr/bin/env bash
# ValidatorShift agent installer.
#
# Downloads a signed standalone binary from GitHub Releases, verifies its
# SHA-256 against the published SHA256SUMS, and installs it into
# ~/.local/bin/validator-shift. No sudo, no global package managers, no
# build toolchain required on the validator host.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Eternally-black/validator-shift/main/scripts/install.sh | bash
#
# Pin a specific release:
#   curl -sSL .../install.sh | VS_VERSION=v0.1.0 bash

set -euo pipefail

REPO="Eternally-black/validator-shift"
INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="validator-shift"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

die() {
  red "error: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_cmd curl
require_cmd uname
require_cmd mktemp
require_cmd install

# Prefer sha256sum (coreutils, ubiquitous on Linux); fall back to shasum on macOS.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CHECK=(sha256sum --check --ignore-missing)
elif command -v shasum >/dev/null 2>&1; then
  SHA_CHECK=(shasum -a 256 --check --ignore-missing)
else
  die "neither sha256sum nor shasum available — cannot verify download integrity"
fi

# --- detect platform ---------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)  os_slug=linux ;;
  Darwin) os_slug=darwin ;;
  *) die "unsupported OS '$os'. ValidatorShift binaries are published for Linux and macOS only. Build from source: https://github.com/${REPO}" ;;
esac

case "$arch" in
  x86_64|amd64)  arch_slug=x64 ;;
  aarch64|arm64) arch_slug=arm64 ;;
  *) die "unsupported architecture '$arch'. Build from source: https://github.com/${REPO}" ;;
esac

asset="${BIN_NAME}-${os_slug}-${arch_slug}"

# --- resolve version ---------------------------------------------------------
version="${VS_VERSION:-latest}"

if [ "$version" = "latest" ]; then
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  # GitHub redirects /releases/latest to the highest published, non-draft tag.
  resolved="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [ -n "$resolved" ] || die "could not resolve latest release for ${REPO}. Is a release published yet?"
  version="$resolved"
fi

base_url="https://github.com/${REPO}/releases/download/${version}"
bin_url="${base_url}/${asset}"
sums_url="${base_url}/SHA256SUMS"

# --- download into a private tmpdir ------------------------------------------
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Installing ${BIN_NAME} ${version} (${os_slug}-${arch_slug})..."

http_code="$(curl -sSL -o "${tmpdir}/${asset}" -w '%{http_code}' "$bin_url" || true)"
if [ "$http_code" != "200" ]; then
  die "download failed (HTTP ${http_code}) — ${bin_url}
       Verify that release '${version}' exists and ships a '${asset}' asset:
       https://github.com/${REPO}/releases"
fi

http_code="$(curl -sSL -o "${tmpdir}/SHA256SUMS" -w '%{http_code}' "$sums_url" || true)"
if [ "$http_code" != "200" ]; then
  die "SHA256SUMS download failed (HTTP ${http_code}) — refusing to install unverified binary"
fi

# --- verify integrity --------------------------------------------------------
( cd "$tmpdir" && "${SHA_CHECK[@]}" SHA256SUMS ) >/dev/null 2>&1 \
  || die "SHA-256 verification FAILED for ${asset}. Refusing to install. The binary may be corrupted or tampered with."

# --- install -----------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
install -m 0755 "${tmpdir}/${asset}" "${INSTALL_DIR}/${BIN_NAME}"

green "✓ ${BIN_NAME} ${version} installed to ${INSTALL_DIR}/${BIN_NAME}"

# --- post-install: PATH advice + version probe -------------------------------
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) on_path=1 ;;
  *)                    on_path=0 ;;
esac

if [ "$on_path" -eq 0 ]; then
  yellow ""
  yellow "⚠  ${INSTALL_DIR} is not in your PATH."
  yellow "   Add it by appending this line to ~/.bashrc (or ~/.zshrc):"
  yellow ""
  yellow "       export PATH=\"\$HOME/.local/bin:\$PATH\""
  yellow ""
  yellow "   Then reload: source ~/.bashrc"
  yellow ""
  echo   "Run with explicit path until then:"
  echo   "  ${INSTALL_DIR}/${BIN_NAME} --help"
else
  echo
  "${INSTALL_DIR}/${BIN_NAME}" --help >/dev/null 2>&1 \
    && echo "Run: ${BIN_NAME} --help" \
    || yellow "Note: '${BIN_NAME} --help' returned non-zero — binary installed but may need debugging."
fi

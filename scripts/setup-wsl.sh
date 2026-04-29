#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# ValidatorShift — WSL2 Ubuntu provisioning script
# ----------------------------------------------------------------------------
# Run inside the WSL2 Ubuntu shell after first user creation:
#   bash /mnt/c/Users/Valera/Desktop/Solana\ Validator/scripts/setup-wsl.sh
#
# Installs:
#   • Build essentials (curl, git, build-essential, ca-certificates)
#   • Node.js 20 (NodeSource)
#   • Claude Code CLI (@anthropic-ai/claude-code)
#   • XFCE4 desktop environment
#   • xrdp (so Windows mstsc.exe can connect to a real Linux desktop)
#
# Solana CLI + Tailscale are installed in Phase C4 (separate concerns).
# ----------------------------------------------------------------------------
set -euo pipefail

log() { printf '\033[36m[setup-wsl]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[setup-wsl]\033[0m %s\n' "$*" >&2; }

# Sanity check: must run inside WSL
if ! grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
  err "This script is intended for WSL2 Ubuntu only. Detected: $(uname -a)"
  exit 1
fi

if [ "${EUID}" -eq 0 ]; then
  err "Run as your normal user (not root). The script will use sudo where needed."
  exit 1
fi

# ----------------------------------------------------------------------------
# 1. Base packages
# ----------------------------------------------------------------------------
log "updating apt indices"
sudo apt-get update -y

log "installing build essentials"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  curl ca-certificates git build-essential gnupg lsb-release software-properties-common

# ----------------------------------------------------------------------------
# 2. Node.js 20 (NodeSource)
# ----------------------------------------------------------------------------
if command -v node >/dev/null && node -v | grep -q '^v20\.'; then
  log "Node.js 20 already installed: $(node -v)"
else
  log "installing Node.js 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
log "node: $(node -v)  npm: $(npm -v)"

# ----------------------------------------------------------------------------
# 3. Claude Code CLI
# ----------------------------------------------------------------------------
# npm global root in /usr (managed by NodeSource); allow user-writable global
# install dir under ~/.npm-global to avoid sudo on every npm i -g.
if [ ! -d "${HOME}/.npm-global" ]; then
  mkdir -p "${HOME}/.npm-global"
  npm config set prefix "${HOME}/.npm-global"
  if ! grep -q 'npm-global/bin' "${HOME}/.bashrc" 2>/dev/null; then
    {
      echo ''
      echo '# Added by ValidatorShift WSL setup'
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"'
    } >>"${HOME}/.bashrc"
  fi
fi
export PATH="${HOME}/.npm-global/bin:${PATH}"

log "installing Claude Code CLI"
npm install -g @anthropic-ai/claude-code
log "claude: $(claude --version 2>&1 | head -1)"

# ----------------------------------------------------------------------------
# 4. XFCE4 desktop + xrdp (option 2 — full Linux desktop via Windows RDP)
# ----------------------------------------------------------------------------
log "installing XFCE4 + xrdp"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  xfce4 xfce4-goodies xrdp dbus-x11

# Tell xrdp to start XFCE for our user.
if [ ! -f "${HOME}/.xsession" ]; then
  echo 'startxfce4' >"${HOME}/.xsession"
  chmod +x "${HOME}/.xsession"
fi

# Default xrdp port is 3389 — same as Windows RDP, so we shift WSL's xrdp to
# 3390 to avoid clashing with the host's mstsc service.
sudo sed -i 's/^port=.*/port=3390/' /etc/xrdp/xrdp.ini || true

# Ensure dbus and xrdp are running (systemd is now standard in WSL Ubuntu).
sudo systemctl enable xrdp 2>/dev/null || true
sudo systemctl restart xrdp 2>/dev/null || sudo /etc/init.d/xrdp restart || true

log "xrdp listening on port 3390 (connect via mstsc.exe → localhost:3390)"

# ----------------------------------------------------------------------------
# 5. Summary
# ----------------------------------------------------------------------------
cat <<EOF

──────────────────────────────────────────────────────────────────────
WSL Ubuntu base setup complete.

Installed:
  • Node $(node -v) + npm $(npm -v)
  • Claude Code CLI ($(claude --version 2>&1 | head -1))
  • XFCE4 desktop + xrdp on port 3390

Next steps:
  1. (optional) Connect to the Linux desktop:
       Open Windows "Подключение к удалённому рабочему столу" / mstsc.exe
       Computer: localhost:3390
       Username + password: your Linux user (just created)
  2. Tell the Windows-side Claude Code "готово" — it will continue with
     Phase C3 (project context handoff to a Claude Code instance running
     here in WSL).

EOF

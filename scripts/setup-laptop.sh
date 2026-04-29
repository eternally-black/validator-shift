#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# ValidatorShift — Laptop (Phase C1+C2+C3+C4 in one shot)
# ----------------------------------------------------------------------------
# Run inside WSL2 Ubuntu on the laptop, after first user creation.
# Idempotent: safe to re-run on partial failure.
#
#   curl -fsSL https://gist.github.com/.../setup-laptop.sh | bash    # if hosted
#   # OR after manual download:
#   bash ~/setup-laptop.sh
#
# What it does (all interactive prompts are flagged):
#   1. apt base + Node 20 + Claude Code CLI
#   2. (optional) XFCE4 + xrdp on port 3390
#   3. GitHub CLI + browser login    [INTERACTIVE]
#   4. git clone Eternally-black/validator-shift -> ~/validator-shift
#   5. npm install (rebuilds better-sqlite3 for Linux)
#   6. Solana CLI v2.3.13 (last prebuilt with agave-validator)
#   7. Tailscale install + tailscale up [INTERACTIVE — browser login]
#   8. Prints the laptop handoff prompt for the WSL Claude
#
# Note: anza-xyz/agave v3.x does not ship agave-validator in the prebuilt
# tarball any more (official policy as of v3.0.0). v2.3.13 is the last
# release with the production validator binary. For our localnet (custom
# genesis) version compatibility is irrelevant.
# ----------------------------------------------------------------------------
set -euo pipefail

log() { printf '\033[36m[setup-laptop]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[setup-laptop]\033[0m %s\n' "$*" >&2; }
hr()  { printf '\033[2m%s\033[0m\n' "----------------------------------------------------------------------"; }

if ! grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
  err "WSL2 only."
  exit 1
fi
if [ "${EUID}" -eq 0 ]; then
  err "Run as your normal user (not root). The script will use sudo where needed."
  exit 1
fi

# ----------------------------------------------------------------------------
# Step 1: apt base + Node 20 + Claude Code
# ----------------------------------------------------------------------------
hr
log "Step 1/7: apt base + Node 20 + Claude Code CLI"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  curl ca-certificates git build-essential gnupg lsb-release software-properties-common wget rsync

if ! command -v node >/dev/null || ! node -v | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
log "node: $(node -v)  npm: $(npm -v)"

if [ ! -d "${HOME}/.npm-global" ]; then
  mkdir -p "${HOME}/.npm-global"
  npm config set prefix "${HOME}/.npm-global"
  if ! grep -q 'npm-global/bin' "${HOME}/.bashrc" 2>/dev/null; then
    {
      echo ''
      echo '# Added by ValidatorShift laptop setup'
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"'
    } >>"${HOME}/.bashrc"
  fi
fi
export PATH="${HOME}/.npm-global/bin:${PATH}"

if ! command -v claude >/dev/null; then
  log "installing Claude Code CLI"
  npm install -g @anthropic-ai/claude-code
fi
log "claude: $(claude --version 2>&1 | head -1)"

# ----------------------------------------------------------------------------
# Step 2: XFCE + xrdp (optional but already in spec — installs by default)
# ----------------------------------------------------------------------------
hr
log "Step 2/7: XFCE4 desktop + xrdp on port 3390"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  xfce4 xfce4-goodies xrdp dbus-x11
if [ ! -f "${HOME}/.xsession" ]; then
  echo 'startxfce4' >"${HOME}/.xsession"
  chmod +x "${HOME}/.xsession"
fi
sudo sed -i 's/^port=.*/port=3390/' /etc/xrdp/xrdp.ini || true
sudo systemctl enable xrdp 2>/dev/null || true
sudo systemctl restart xrdp 2>/dev/null || sudo /etc/init.d/xrdp restart || true

# ----------------------------------------------------------------------------
# Step 3: GitHub CLI + browser login
# ----------------------------------------------------------------------------
hr
log "Step 3/7: GitHub CLI"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gh
fi
log "gh: $(gh --version 2>&1 | head -1)"

if ! gh auth status >/dev/null 2>&1; then
  hr
  log "Step 3a: gh auth login (browser flow). Pick: github.com / HTTPS / Login with browser."
  log "       If the browser doesn't auto-open, copy the URL printed below into your Windows browser."
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git
log "github auth: $(gh auth status 2>&1 | grep 'Logged in' | head -1)"

# ----------------------------------------------------------------------------
# Step 4: clone repo
# ----------------------------------------------------------------------------
hr
log "Step 4/7: clone Eternally-black/validator-shift -> ~/validator-shift"
if [ -d "${HOME}/validator-shift/.git" ]; then
  log "repo already cloned, pulling latest"
  ( cd "${HOME}/validator-shift" && git pull --ff-only )
else
  rm -rf "${HOME}/validator-shift"
  gh repo clone Eternally-black/validator-shift "${HOME}/validator-shift"
fi

# ----------------------------------------------------------------------------
# Step 5: npm install
# ----------------------------------------------------------------------------
hr
log "Step 5/7: npm install (compiling better-sqlite3 for Linux ABI)"
cd "${HOME}/validator-shift"
npm install --no-audit --no-fund 2>&1 | tail -3

# ----------------------------------------------------------------------------
# Step 6: Solana CLI v2.3.13 (last release with agave-validator binary)
# ----------------------------------------------------------------------------
hr
log "Step 6/7: Solana CLI v2.3.13 (Anza dropped agave-validator binary in v3.0+)"
if ! command -v solana-validator >/dev/null; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"
fi
SOLANA_BIN="${HOME}/.local/share/solana/install/active_release/bin"
if ! grep -q 'solana/install/active_release/bin' "${HOME}/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo '# Added by ValidatorShift laptop setup'
    echo "export PATH=\"${SOLANA_BIN}:\$PATH\""
  } >>"${HOME}/.bashrc"
fi
export PATH="${SOLANA_BIN}:${PATH}"
log "solana: $(solana --version 2>&1 | head -1)"
log "solana-validator: $(solana-validator --version 2>&1 | head -1)"

# ----------------------------------------------------------------------------
# Step 7: Tailscale
# ----------------------------------------------------------------------------
hr
log "Step 7/7: Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if ! tailscale status >/dev/null 2>&1; then
  log "Step 7a: starting tailscale up (will open browser for account login)"
  log "         Use the SAME Tailscale account that's on the PC."
  sudo tailscale up
fi
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || echo "(not yet up)")
log "tailscale ip: ${TS_IP}"

# ----------------------------------------------------------------------------
# Step 8: write laptop handoff prompt
# ----------------------------------------------------------------------------
HANDOFF="${HOME}/validator-shift/HANDOFF-LAPTOP.md"
cat >"${HANDOFF}" <<'PROMPT'
# Laptop handoff — Claude Code (target role)

You are the **WSL-side Claude Code on the laptop**. You're the second of two validator hosts. The PC-side Claude Code is the **source role** (validator #1, bootstrap), you are **target role** (validator #2, joining).

## Project context (recap)

ValidatorShift — off-chain TS tool that migrates a Solana validator's staked identity between two servers. Three packages: agent (CLI), hub (Fastify+WS), web (Next.js). Architecture spec: `SOLSHIFT_Architecture.md`.

GitHub: `Eternally-black/validator-shift` (private, you have gh auth).
Working dir: `~/validator-shift`.
Hub: `https://hub-production-88a0.up.railway.app` (Railway, live).
Web: `https://web-production-797fb.up.railway.app` (Railway, live).

## Your responsibilities (Phase D + E, target side)

### Phase D — join the local validator cluster

1. Tailscale should already be up. Confirm with `tailscale ip -4` — note your IP.
2. Get the PC's Tailscale IP from the user (the PC-side Claude already recorded it).
3. **Generate target-side keypairs** with `solana-keygen new`:
   - identity keypair → `~/validator-keypair.json` (this is the **target's local** identity, before migration). The agent will replace it with the **source's staked** keypair during step 5 of the migration.
   - vote keypair → `~/vote-account-keypair.json` (target won't actually use this until after migration completes; can stay unstaked).
4. **Start solana-validator as a joining node**, using the PC's Tailscale IP as `--known-validator` and `--entrypoint`. Bind to your own Tailscale IP for gossip. Coordinate with the user — the PC must already be up (the bootstrap validator must produce the genesis hash that you join against).
5. Verify with `solana gossip --output json` and `solana validators` (against your local RPC, e.g. `solana --url http://localhost:8899 validators`) that:
   - both validators are visible in gossip
   - PC's source identity is producing slots / voting

### Phase E — receive the migrated identity

1. **Run the agent** with `--role target`:
   ```
   npx tsx packages/agent/src/bin.ts agent \
     --role target \
     --session <code-from-web-wizard> \
     --hub https://hub-production-88a0.up.railway.app \
     --ledger ~/ledger \
     --keypair ~/validator-keypair.json
   ```
2. The agent will pair via SAS, do preflight, then receive the encrypted tower file (step 4) + staked keypair (step 5), then activate identity (step 6 + 7), verify voting (step 8), and emit `voting_confirmed` back to the source so it can secure-wipe its key (step 9).
3. Operator drives the wizard at the web URL, observes the live migration page.

## Hard rules (same as PC-side)

- Never decrypt `agent:encrypted_payload` outside the agent process.
- Never `git push --force`, never skip pre-commit hooks.
- Never bypass operator confirmation (`--yes` is for unattended automation only).
- Architecture invariants: `SOLSHIFT_Architecture.md` sections 3, 4, 10. Read them before changing agent flow.

## First message to the user

> Я WSL-side Claude Code на ноутбуке (target role). Контекст принят. Готов к Phase D — joining validator + получение IP бутстрапа от ПК. Какой Tailscale IP у ПК?
PROMPT

# ----------------------------------------------------------------------------
# Final summary
# ----------------------------------------------------------------------------
hr
cat <<EOF

Laptop bootstrap complete.

Installed:
  • Node $(node -v) + npm $(npm -v)
  • Claude Code CLI
  • GitHub CLI + auth
  • XFCE4 + xrdp on port 3390 (mstsc.exe -> localhost:3390)
  • Solana CLI v2.3.13 (with solana-validator binary)
  • Tailscale: ${TS_IP}

Repo: ~/validator-shift

Next steps:
  1. Open a NEW terminal (so PATH is reloaded) — or run \`source ~/.bashrc\`
  2. cd ~/validator-shift
  3. claude          # first run will open browser for Anthropic login
  4. In the Claude REPL, send: "read HANDOFF-LAPTOP.md and start phase D"

EOF

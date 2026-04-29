#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# ValidatorShift — Phase C3 handoff: prep WSL-side Claude Code env
# ----------------------------------------------------------------------------
# Run inside the WSL2 Ubuntu shell:
#   bash /mnt/c/Users/Valera/Desktop/Solana\ Validator/scripts/setup-wsl-2.sh
#
# What it does:
#   1. Installs GitHub CLI (gh) — needed for git push from WSL
#   2. Prompts you to log in to GitHub (browser-based) — once
#   3. Copies project memory from Windows-side Claude Code so the WSL-side
#      Claude has the same long-term context (project_solshift.md etc)
#   4. Runs npm install inside ~/validator-shift (Linux native node_modules,
#      including a fresh better-sqlite3 build for the Linux ABI)
#   5. Prints the prompt you should paste into the WSL Claude when it opens
# ----------------------------------------------------------------------------
set -euo pipefail

log() { printf '\033[36m[setup-wsl-2]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[setup-wsl-2]\033[0m %s\n' "$*" >&2; }

if ! grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
  err "WSL2 only."
  exit 1
fi
if [ "${EUID}" -eq 0 ]; then
  err "Run as your normal user (not root)."
  exit 1
fi

PROJECT_DIR="${HOME}/validator-shift"
WIN_MEM="/mnt/c/Users/Valera/.claude/projects/c--Users-Valera-Desktop-Solana-Validator/memory"
LIN_MEM="${HOME}/.claude/projects/-home-valera-validator-shift/memory"

# ----------------------------------------------------------------------------
# 1. GitHub CLI
# ----------------------------------------------------------------------------
if ! command -v gh >/dev/null; then
  log "installing GitHub CLI (will prompt for sudo password)"
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

# ----------------------------------------------------------------------------
# 2. GitHub login (browser-based)
# ----------------------------------------------------------------------------
if ! gh auth status >/dev/null 2>&1; then
  log "launching gh auth login (browser flow). Choose: github.com, HTTPS, login with browser, then paste the one-time code shown."
  gh auth login --hostname github.com --git-protocol https --web
fi
log "github auth: $(gh auth status 2>&1 | grep 'Logged in' | head -1)"

# Wire git so push uses the gh credential helper.
gh auth setup-git

# ----------------------------------------------------------------------------
# 3. Project memory transfer
# ----------------------------------------------------------------------------
mkdir -p "${LIN_MEM}"
if [ -d "${WIN_MEM}" ]; then
  cp -v "${WIN_MEM}/"*.md "${LIN_MEM}/" 2>&1 | sed 's/^/[memory] /'
else
  log "no Windows-side project memory found at ${WIN_MEM} — skipping."
fi

# ----------------------------------------------------------------------------
# 4. npm install in the Linux-native repo copy
# ----------------------------------------------------------------------------
if [ ! -d "${PROJECT_DIR}" ]; then
  err "Expected ${PROJECT_DIR} to already exist (rsync'd from Windows path). Re-run the rsync step first."
  exit 1
fi
cd "${PROJECT_DIR}"
log "running npm install (rebuilds better-sqlite3 native bindings for Linux)"
npm install --no-audit --no-fund 2>&1 | tail -3

# ----------------------------------------------------------------------------
# 5. Print the handoff prompt
# ----------------------------------------------------------------------------
cat <<'EOF'

──────────────────────────────────────────────────────────────────────
Phase C3 setup done.

Now do this manually:

  1. cd ~/validator-shift
  2. claude          # first run will open a browser for Anthropic login
  3. Once the Claude REPL is up, paste the handoff prompt below
     (also written to ~/validator-shift/HANDOFF.md):

──────────────────────────────────────────────────────────────────────
EOF

cat >"${PROJECT_DIR}/HANDOFF.md" <<'PROMPT'
# Handoff from Windows-side Claude Code

You are the **WSL-side** Claude Code instance. The Windows-side Claude (running in `c:\Users\Valera\Desktop\Solana Validator\`) just finished Phases A, B, C1–C3 of a multi-phase plan and handed control to you. Read this file end-to-end before doing anything.

## Project context

ValidatorShift — off-chain TypeScript tool that migrates a Solana validator's staked identity between two servers. Three packages (agent CLI, hub Fastify+WS server, web Next.js dashboard) plus shared types/protocol. Architecture spec: `SOLSHIFT_Architecture.md` in this repo.

GitHub: `Eternally-black/validator-shift` (private). Working name "ValidatorShift" — never mention "SolShift" or `solshift.app` (deprecated copy from the spec).

Working directory: `~/validator-shift` (Linux-native copy, rsynced from `/mnt/c/Users/Valera/Desktop/Solana Validator/`). Project memory has been copied to `~/.claude/projects/-home-valera-validator-shift/memory/`.

## What's already deployed

- **Hub** at `https://hub-production-88a0.up.railway.app` (Railway Docker, Fastify + better-sqlite3 + WS). HTTP+WS on a single port.
- **Web** at `https://web-production-797fb.up.railway.app` (Railway, Next.js 15 standalone).
- Both auto-deploy on `git push origin main` via Railway's GitHub integration.

## What you must do (Phase C4 → D → E)

### Phase C4 — install Solana CLI + Tailscale on this WSL host

This machine is the PC and will host **validator #1 (source role)**. The laptop (separate WSL2 install, not yet provisioned) will host **validator #2 (target role)**. Both validators will reach each other through a Tailscale mesh (UDP gossip; LAN/NAT not assumed).

Step-by-step:
1. Install **Tailscale** via the official apt repo, then `sudo tailscale up` and surface the resulting `tailscale0` IP. The user logs in interactively in a browser.
2. Install **Solana CLI** (Anza release, stable channel): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`. Verify both `solana --version` AND `solana-validator --version` resolve in PATH (after `~/.local/share/solana/install/active_release/bin` is added to PATH).
3. Confirm both binaries work and the Tailscale IP is recorded somewhere the user can see (we'll need it on the laptop).

### Phase D — bring up a 2-node localnet through Tailscale

This is bespoke, not covered by `solana-test-validator`. Plan:
1. Generate a faucet-funded **identity keypair** + **vote keypair** on this PC (validator #1, source). Use `solana-keygen new` for both.
2. Start `solana-validator` here as a **bootstrap validator**, binding gossip to `<tailscale-ip>:8001`, with `--rpc-port 8899`, ledger at `~/ledger`. Stake account creation comes after we have the laptop joined.
3. On the laptop (separate Claude Code instance — wait for the user to spin it up): generate identity+vote keypairs, start `solana-validator` with `--known-validator <tailscale-ip-of-PC>` + `--entrypoint <tailscale-ip-of-PC>:8001`. Joining validator (target role).
4. Verify both nodes see each other in `solana gossip --output json` and that validator #1 is producing slots (`solana validators`).

### Phase E — run the agent + execute a real migration

Once both validators are voting:
1. PC: `npx tsx packages/agent/src/bin.ts agent --role source --session <code> --hub https://hub-production-88a0.up.railway.app --ledger ~/ledger --keypair <staked-kp> --identity-pubkey <pk>`.
2. Laptop: same with `--role target` and target ledger.
3. Operator drives the wizard at `https://web-production-797fb.up.railway.app`, walks through SAS, preflight, Start Migration.
4. Observe the live migration view. Expected outcome: state reaches **COMPLETE**, source keypair is securely wiped, target is voting under the staked identity. Failure modes (anti-dual-identity gate, voting_confirmed timeout, tower hash mismatch) are all instrumented — log them faithfully.

## Hard rules

- **Never** propose changes that bypass the operator-confirmation prompts (`--yes` is for unattended only) or shorten the gossip-quiet wait window. Those gates are the only thing standing between this tool and a dual-signing slashing event.
- **Never** decrypt `agent:encrypted_payload` on the hub side. The hub is a relay-only.
- **Never** `git push --force` or skip pre-commit hooks. Use the `gh` credentials we just set up.
- The architecture invariants are in `SOLSHIFT_Architecture.md` sections 3 (security model), 4 (state machine + steps), 10 (edge cases). Read them before you touch agent flow logic.

## First message to send to the user when you start

> Я WSL-side Claude Code, контекст принят. Готов к Phase C4 — установить Solana CLI + Tailscale на этом ПК. Начинать?

Wait for the user's "yes" before running anything destructive (apt install is fine, but `tailscale up` and any keygen should be confirmed).
PROMPT

cat <<EOF

──────────────────────────────────────────────────────────────────────
The handoff prompt is also saved to:
  ${PROJECT_DIR}/HANDOFF.md

After you start \`claude\` in ${PROJECT_DIR}, send it the contents of
HANDOFF.md (or just say: "read HANDOFF.md and start phase C4").

EOF

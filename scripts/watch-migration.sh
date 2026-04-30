#!/usr/bin/env bash
# watch-migration.sh — live monitor for the staked identity's physical
# location in gossip. One refreshing line, color-coded by whether the
# identity is currently running on THIS host. Designed for a small
# terminal pane during a migration demo: run it on BOTH source and
# target side-by-side, and watch the color flip at step 6 when identity
# physically transfers.
#
# Color legend:
#   green  ✓ HERE          — staked identity is running on this host.
#   yellow ✗ on other host  — running, but on the OTHER host.
#   yellow (not in gossip)  — identity exists in vote-account but no
#                             validator is currently advertising it
#                             (typical mid-migration window between
#                             source set-identity unstaked and target
#                             set-identity staked).
#   red    (no voting val.) — cluster has no voting validator at all
#                             (single-validator localnet is halted).
#
# Override the RPC endpoint if needed:
#   SOLANA_RPC=http://other-host:8899 bash scripts/watch-migration.sh
set -euo pipefail

RPC="${SOLANA_RPC:-http://localhost:8899}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}
require solana
require jq

# Collect ALL non-loopback IPv4 addresses on this host (one per line)
# so we match correctly on multi-NIC setups: WSL2 (which has both an
# internal 192.168.x.x adapter and the Tailscale 100.x.x.x adapter), VMs
# with overlay networks, etc. Picking just one IP causes false negatives
# when the validator binds to a different adapter than what we picked.
my_ips=$(
  { ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $4}' | cut -d/ -f1; } \
  || { hostname -I 2>/dev/null | tr ' ' '\n'; } \
  || echo ""
)
my_ip_summary=$(echo "$my_ips" | paste -sd, -)

GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

trap 'printf "\n"; exit 0' INT TERM

echo "Watching staked identity location via $RPC"
echo "This host's IPv4 addresses: ${my_ip_summary:-unknown}"
echo "Press Ctrl-C to stop."
echo

while true; do
  pk=$(solana --url "$RPC" validators --output json 2>/dev/null \
    | jq -r '.validators[]? | select(.delinquent==false) | .identityPubkey' \
    | head -1 || true)

  if [ -z "$pk" ]; then
    line="${RED}(no voting validator — cluster halted or pre-migration)${RESET}"
  else
    ip=$(solana --url "$RPC" gossip --output json 2>/dev/null \
      | jq -r --arg pk "$pk" '.[] | select(.identityPubkey==$pk) | .ipAddress' \
      | head -1 || true)
    if [ -z "$ip" ]; then
      line="${YELLOW}${pk:0:12}… → (not in gossip yet)${RESET}"
    elif echo "$my_ips" | grep -qFx "$ip"; then
      line="${GREEN}${pk:0:12}… → ${ip}  ✓ HERE${RESET}"
    else
      line="${YELLOW}${pk:0:12}… → ${ip}  ✗ on other host${RESET}"
    fi
  fi

  printf "\033[2K\r%b  ${DIM}[%s]${RESET}" "$line" "$(date +%H:%M:%S)"
  sleep 1
done

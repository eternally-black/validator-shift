#!/usr/bin/env bash
# verify-migration.sh — prove which physical host is running the staked
# Solana validator identity right now. Run from BOTH the source and
# target hosts after a migration; both must report the SAME IP, and that
# IP must match the target host's address. Anything else means the
# migration didn't fully take effect — go to docs/RECOVERY.md.
#
# No arguments. Auto-detects the (only) currently-voting identity from
# the cluster's validators list, then resolves where in gossip that
# identity lives. Designed to print exactly one line of output for video
# / screenshot use.
#
# Override the RPC endpoint if needed:
#   SOLANA_RPC=http://other-host:8899 bash scripts/verify-migration.sh
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

PK=$(solana --url "$RPC" validators --output json \
  | jq -r '.validators[] | select(.delinquent==false) | .identityPubkey' \
  | head -1)
[ -z "$PK" ] && {
  echo "no currently-voting validator visible via $RPC" >&2
  echo "(cluster may still be catching up, or the identity is delinquent)" >&2
  exit 1
}

ip=$(solana --url "$RPC" gossip --output json \
  | jq -r --arg pk "$PK" '.[] | select(.identityPubkey==$pk) | .ipAddress // "<not in gossip>"')

vote=$(solana --url "$RPC" validators --output json \
  | jq -r --arg pk "$PK" '.validators[] | select(.identityPubkey==$pk) | "lastVote=\(.lastVote) delinquent=\(.delinquent)"')

echo "${PK:0:12}… → ${ip} (${vote})"

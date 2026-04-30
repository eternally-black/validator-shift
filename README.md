# ValidatorShift

Securely migrate a Solana validator's identity between servers without dual-signing risk.

> Today's options: scp the keypair (no integrity check, no audit trail), bash scripts shared as gists (no operator confirmation gates), Ansible playbooks (assume root SSH and full trust). ValidatorShift is end-to-end encrypted, operator-confirmed at every destructive step, and produces a structured audit log.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/Eternally-black/validator-shift/actions/workflows/ci.yml/badge.svg)](https://github.com/Eternally-black/validator-shift/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

---

## Why

Migrating a Solana validator's staked identity between servers is currently a manual, error-prone ritual: raw bash scripts, unencrypted `scp` of private keys, and zero protection against dual-signing or partial failures. A single mistake can mean lost stake, slashing-style downtime, or a private key leaked to a transit machine.

ValidatorShift replaces that ritual with a hardened, observable, end-to-end encrypted pipeline. Two CLI agents — one on the source server, one on the target — perform an X25519 key exchange via a relay Hub that **never sees the plaintext keypair**. Operators verify a 3-word Short Authentication String (SAS), watch a guided wizard run pre-flight checks, and execute the migration as a deterministic state machine with automatic rollback. Tower file integrity is checked, the source keypair is securely wiped on success, and an anti-dual-identity protocol guarantees only one server is ever voting.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Web UI (Next.js)                     │
│  Dashboard · Migration Wizard · Real-time Status · Logs  │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Hub Server (Node.js)                   │
│  Session Manager · Orchestrator · Relay (E2E encrypted)  │
└───────┬─────────────────────────────────────┬───────────┘
        │ WSS                                 │ WSS
        ▼                                     ▼
┌───────────────────┐               ┌───────────────────┐
│  Agent (Source)   │               │  Agent (Target)   │
│  CLI on Server A  │◄────────────►│  CLI on Server B  │
│  runs solana CLI  │  E2E Encrypted│  runs solana CLI  │
└───────────────────┘   Key Transfer └───────────────────┘
```

For the full specification — threat model, state machine, message protocol, deployment topology — see the [Architecture document](./SOLSHIFT_Architecture.md).

## Quick start

On both your source and target validator hosts:

```bash
curl -sSL https://raw.githubusercontent.com/Eternally-black/validator-shift/main/scripts/install.sh | bash
```

This installs the `validator-shift` binary to `~/.local/bin/`. The script verifies SHA-256 against the tagged GitHub Release before installing — see [scripts/install.sh](./scripts/install.sh).

Then open the wizard at <https://web-production-797fb.up.railway.app/migrate> and follow the on-screen instructions. The wizard generates the exact `validator-shift agent ...` commands you paste into each host.

Full walkthrough (local development, self-hosting the hub): [docs/QUICKSTART.md](./docs/QUICKSTART.md).

## Security model & trade-offs

### What the Hub sees
- Session pairing metadata (6-char code, agent IPs, connection timing, current state).
- Encrypted payload bytes (X25519 + XChaCha20-Poly1305) and SHA-256 hashes — never decrypted.
- Structured log events from both agents.

### What the Hub does NOT see
- The validator identity keypair, in plaintext or any reversible form.
- The X25519 ephemeral private keys (only public keys cross the Hub).
- The XChaCha20-Poly1305 session key (derived locally by each agent via HKDF).
- The tower file contents.
- Any operator credentials.

### Why a Hub at all? Why not pure peer-to-peer?
Validator operators run nodes behind tight firewalls — typically only Solana gossip and RPC ports are exposed. Forcing them to open a custom port for a one-shot migration is a worse trade-off than a well-designed relay.

The Hub is a coordination plane, not a trust plane:
- Both ends authenticate each other via SAS comparison, not via the Hub.
- Encryption keys are derived from X25519 ECDH — Hub compromise reveals only ciphertext.
- Audit trail is structured events; no raw error strings, no stack traces.

### Residual risks the operator owns
- Storage-layer wipe on COW filesystems and SSDs is best-effort. For high-value identities, operators should rotate identity keypairs post-migration.
- A compromised Hub can refuse service (DoS); it cannot exfiltrate keys.
- Operator-side compromise (malicious shell on either validator host) is out of scope.

See [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the full STRIDE breakdown.

## Tech stack

- **Agent** (`@validator-shift/agent`) — TypeScript on Node.js 20+, `commander` CLI, `ws` WebSocket client, `tweetnacl` / `@noble/ciphers` for X25519 + XChaCha20-Poly1305, `chalk` / `ora` / `inquirer` for terminal UX.
- **Hub** (`@validator-shift/hub`) — Fastify HTTP API, `ws` WebSocket server, SQLite (sessions and audit log only — **no keys**), `nanoid` session codes, `zod` validation.
- **Web** (`@validator-shift/web`) — Next.js 15 (App Router), Tailwind CSS design system, Zustand state, native WebSocket, `framer-motion` animations, `lucide-react` icons.

## Project structure

```
validator-shift/
├── packages/
│   ├── agent/                    # CLI Agent (@validator-shift/agent)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/         # CLI commands
│   │   │   ├── solana/           # solana CLI wrapper, keypair I/O
│   │   │   ├── crypto/           # X25519, XChaCha20-Poly1305, SAS
│   │   │   ├── transport/        # WebSocket client
│   │   │   └── ui/               # Terminal UI (chalk, ora)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── hub/                      # Hub Server (@validator-shift/hub)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── api/              # Fastify routes + middleware
│   │   │   ├── ws/               # WebSocket handler, session rooms
│   │   │   ├── orchestrator/     # State machine, steps, rollback
│   │   │   └── db/               # SQLite schema and queries
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── web/                      # Web UI (@validator-shift/web)
│   │   ├── app/                  # Next.js App Router pages
│   │   ├── components/           # ui/, wizard/, migration/, layout/
│   │   ├── lib/                  # ws client, Zustand store
│   │   ├── package.json
│   │   └── next.config.js
│   │
│   └── shared/                   # Shared types & protocol
│       ├── src/                  # types, protocol messages, constants
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   ├── QUICKSTART.md
│   ├── RECOVERY.md
│   ├── SECURITY.md
│   └── THREAT_MODEL.md
├── SOLSHIFT_Architecture.md      # Full architecture specification
├── package.json                  # npm workspaces root
└── README.md
```

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run -ws build

# Run the full test suite
npm test -ws
```

Per-package dev servers:

```bash
npm run dev -w @validator-shift/hub
npm run dev -w @validator-shift/web
```

## How to evaluate

- **Live wizard:** <https://web-production-797fb.up.railway.app/migrate>
- **Recovery runbook:** [docs/RECOVERY.md](./docs/RECOVERY.md)
- **Threat model:** [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md)
- **Tests:** `npm test -ws`

## Contributing

PRs are welcome. Start with [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) to get a local environment running, then read [`SOLSHIFT_Architecture.md`](./SOLSHIFT_Architecture.md) for the design rationale before sending a patch.

Issues and feature requests: <https://github.com/Eternally-black/validator-shift/issues>.

For security disclosures, do **not** file a public issue — see [docs/SECURITY.md](./docs/SECURITY.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

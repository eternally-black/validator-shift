# ValidatorShift

> Secure end-to-end encrypted Solana validator identity transfer

[![License: MIT](https://img.shields.io/badge/License-MIT%20(TBD)-yellow.svg)](#license)
[![CI](https://github.com/Eternally-black/validator-shift/actions/workflows/ci.yml/badge.svg)](https://github.com/Eternally-black/validator-shift/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

---

## What it does

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

Full walkthrough: [docs/QUICKSTART.md](./docs/QUICKSTART.md).

```bash
git clone https://github.com/Eternally-black/validator-shift
cd validator-shift
docker-compose up -d
# On each validator server:
npx @validator-shift/agent --role source --session <code> --hub wss://...
```

## Security

- **End-to-end encryption** — X25519 key exchange + XChaCha20-Poly1305 between agents.
- **Hub never sees keys** — only encrypted blobs are relayed; even a fully compromised Hub cannot leak the validator keypair.
- **Anti-dual-identity protocol** — sequential deactivate/activate, gossip verification, and automatic lockout-on-disconnect prevent two servers from ever voting with the same identity.

Details, threat model, and responsible disclosure: [docs/SECURITY.md](./docs/SECURITY.md).

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
│   └── SECURITY.md
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

# Run the full test suite (191 tests across packages)
npm run -ws test
```

Per-package dev servers:

```bash
npm run dev -w @validator-shift/hub
npm run dev -w @validator-shift/web
```

## Contributing

PRs are welcome. Start with [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) to get a local environment running, then read [`SOLSHIFT_Architecture.md`](./SOLSHIFT_Architecture.md) for the design rationale before sending a patch.

Issues and feature requests: <https://github.com/Eternally-black/validator-shift/issues>.

For security disclosures, do **not** file a public issue — see [docs/SECURITY.md](./docs/SECURITY.md).

## License

MIT (TBD — license file pending finalization).

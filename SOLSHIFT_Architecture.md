# SolShift — Solana Validator Identity Transfer Tool

## Architecture Document v1.0

---

## 1. Problem Statement

Transferring a Solana validator's identity between servers is currently a manual, error-prone process involving raw bash scripts, unencrypted `scp` transfers of private keys, and no safety guarantees against dual-signing or failed migrations.

### Existing Solutions & Their Gaps

| Solution | Format | Encryption | UI | Safety Checks | Rollback |
|----------|--------|------------|-----|---------------|----------|
| STEVLTH script | Bash script | None (SSH only) | ❌ | ❌ | ❌ |
| mvines demo | Manual steps | None | ❌ | Partial | ❌ |
| backbone-link | Ansible playbook | None (SSH only) | ❌ | Partial | ❌ |
| **SolShift** | **CLI + Web UI** | **E2E encrypted** | **✅** | **Full suite** | **✅** |

### Target User

Solana validator operators who need to migrate their staked identity to a new server — for hardware upgrades, datacenter moves, software updates, or disaster recovery. Ranges from solo operators to institutional staking providers managing multiple validators.

---

## 2. High-Level Architecture

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
│  Agent (Source)    │               │  Agent (Target)    │
│  CLI on Server A   │◄────────────►│  CLI on Server B   │
│  runs solana CLI   │  E2E Encrypted│  runs solana CLI   │
└───────────────────┘   Key Transfer └───────────────────┘
```

### Three Components

1. **Agent** — Lightweight CLI binary installed on validator servers. Executes local Solana CLI commands, handles encrypted key transfer. Written in TypeScript/Node.js.

2. **Hub** — Central coordination server. Manages sessions, orchestrates migration steps, relays encrypted data between agents. Provides API for Web UI. **Never sees the private key** (end-to-end encryption between agents).

3. **Web UI** — React/Next.js dashboard. Migration wizard, real-time status tracking, pre-flight checks, logs. The operator's control center.

---

## 3. Security Model

### 3.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Key interception during transfer | E2E encryption (X25519 + XChaCha20-Poly1305) |
| Compromised Hub server | Hub never sees plaintext key; only encrypted blobs pass through |
| Man-in-the-middle on pairing | Short Authentication String (SAS) verification, like Signal |
| Dual-signing / double identity | Anti-dual-identity protocol with lockout verification |
| Failed migration leaves orphaned state | Automatic rollback with state machine |
| Key remains on source after transfer | Secure wipe with verification |

### 3.2 Key Exchange Protocol

```
Agent A (Source)                Hub                Agent B (Target)
    │                           │                        │
    │  1. Generate X25519 keypair                        │
    │     pubA ──────────────────────────────────► pubB  │
    │                           │   2. Generate X25519   │
    │  pubB ◄──────────────────────────────────── pubB   │
    │                           │                        │
    │  3. Derive shared secret: X25519(privA, pubB)      │
    │                           │   3. Same shared secret│
    │                           │                        │
    │  4. Display SAS (e.g. "ALPHA-BRAVO-CHARLIE")       │
    │                           │   4. Display SAS       │
    │                           │                        │
    │  ─── Operator verifies SAS matches on both ───     │
    │                           │                        │
    │  5. Encrypt keypair with XChaCha20-Poly1305        │
    │     encrypted_blob ───────►───────────────► decrypt │
    │                           │                        │
```

The Hub only relays encrypted blobs. Even if the Hub is fully compromised, the validator's private key remains secure.

### 3.3 Pairing Mechanism

- Operator creates a migration session in the Web UI → gets a **Session Code** (6-character alphanumeric, e.g. `X7K9M2`)
- Runs agent on both servers with the same session code
- Both agents connect to the Hub, perform X25519 key exchange
- **SAS verification**: Both agents display a 3-word code derived from the shared secret. Operator visually confirms they match (shown in both terminals and the Web UI)
- Only then does the key transfer proceed

---

## 4. Migration Flow (State Machine)

```
┌──────────┐
│  IDLE    │ ← Session created, waiting for agents
└────┬─────┘
     ▼
┌──────────────┐
│  PAIRING     │ ← Both agents connected, SAS verification
└────┬─────────┘
     ▼
┌──────────────┐
│  PREFLIGHT   │ ← Running pre-flight checks
└────┬─────────┘
     ▼
┌──────────────────┐
│  AWAITING_WINDOW │ ← Waiting for restart window (no leader slots)
└────┬─────────────┘
     ▼
┌──────────────┐
│  MIGRATING   │ ← Active migration (steps 1-7)
└────┬─────────┘
     ├──── success ────► ┌──────────┐
     │                   │ COMPLETE │
     │                   └──────────┘
     └──── failure ────► ┌──────────┐
                         │ ROLLBACK │ → FAILED
                         └──────────┘
```

### 4.1 Pre-flight Checks

Before migration begins, the system verifies:

| Check | Source Server | Target Server |
|-------|-------------|---------------|
| Solana CLI installed & accessible | ✅ | ✅ |
| Validator process running | ✅ | ✅ |
| Validator caught up to cluster | ✅ | ✅ |
| Identity keypair accessible | ✅ | — |
| Vote account matches identity | ✅ | — |
| Sufficient SOL for vote txns | ✅ | ✅ |
| Disk space for tower file | — | ✅ |
| Ledger path exists & writable | — | ✅ |
| No existing staked identity on target | — | ✅ |

### 4.2 Migration Steps (MIGRATING state)

```
Step 1: Wait for restart window
         └─ `solana-validator -l <ledger> wait-for-restart-window --min-idle-time 2 --skip-new-snapshot-check`
         └─ Ensures no leader slots are imminent

Step 2: Set unstaked identity on SOURCE
         └─ `solana-validator -l <ledger> set-identity <unstaked-keypair>`
         └─ Source stops signing with staked identity

Step 3: Remove authorized voters on SOURCE
         └─ `solana-validator -l <ledger> authorized-voter remove-all`
         └─ Source fully deactivated from voting

Step 4: Transfer tower file
         └─ Read tower-1_9-<pubkey>.bin from SOURCE
         └─ Encrypt with session key
         └─ Transfer via Hub relay
         └─ Write to TARGET ledger directory
         └─ Verify integrity (SHA-256 hash check)

Step 5: Transfer identity keypair
         └─ Read validator-keypair.json from SOURCE
         └─ Encrypt with E2E key (XChaCha20-Poly1305)
         └─ Transfer via Hub relay
         └─ Write to TARGET (temp location first, then move)
         └─ Verify: pubkey matches expected identity

Step 6: Set staked identity on TARGET
         └─ `solana-validator -l <ledger> set-identity <staked-keypair>`

Step 7: Add authorized voter on TARGET
         └─ `solana-validator -l <ledger> authorized-voter add <staked-keypair>`

Step 8: Post-migration verification
         └─ Verify TARGET is voting (check gossip)
         └─ Verify SOURCE is NOT voting with staked identity
         └─ Check vote credits are being earned
         └─ Confirm no delinquency

Step 9: Cleanup
         └─ Secure wipe of keypair on SOURCE (overwrite + unlink)
         └─ Rewrite identity symlink on SOURCE to unstaked
```

### 4.3 Rollback Protocol

If any step fails after Step 2:

```
Rollback Step 1: Restore staked identity on SOURCE
                  └─ `solana-validator -l <ledger> set-identity <staked-keypair>`

Rollback Step 2: Re-add authorized voter on SOURCE
                  └─ `solana-validator -l <ledger> authorized-voter add <staked-keypair>`

Rollback Step 3: Remove any transferred files from TARGET

Rollback Step 4: Verify SOURCE is voting normally
```

The keypair always has at least one copy until migration is verified. No deletion occurs until Step 9.

---

## 5. Tech Stack

### 5.1 Agent (CLI)

```
Language:       TypeScript (compiled with tsx/esbuild for easy distribution)
Runtime:        Node.js 20+
Key libraries:
  - commander    — CLI argument parsing
  - ws           — WebSocket client
  - tweetnacl    — X25519 key exchange + XChaCha20-Poly1305 encryption
  - chalk        — Terminal coloring
  - ora          — Spinner/progress indicators
  - inquirer     — Interactive prompts
```

**Installation**: `npx solshift-agent` or `npm i -g solshift-agent`

**Usage**:
```bash
# On source server
solshift agent --role source --session X7K9M2 --hub wss://solshift.app

# On target server  
solshift agent --role target --session X7K9M2 --hub wss://solshift.app
```

### 5.2 Hub Server

```
Language:       TypeScript
Framework:      Fastify (HTTP API) + ws (WebSocket server)
Database:       SQLite (sessions, audit log — no keys stored)
Key libraries:
  - fastify      — REST API for Web UI
  - ws           — WebSocket server for agents
  - nanoid       — Session code generation
  - zod          — Request validation
```

**API Routes**:
```
POST   /api/sessions              — Create migration session
GET    /api/sessions/:id          — Get session status
DELETE /api/sessions/:id          — Cancel session
WS     /ws/session/:code          — Agent WebSocket connection
WS     /ws/dashboard/:id          — Web UI real-time updates
```

### 5.3 Web UI

```
Framework:      Next.js 15 (App Router)
Styling:        Tailwind CSS + custom design system
State:          Zustand (lightweight, WebSocket-friendly)
Real-time:      Native WebSocket
Skill:          vercel-react-best-practices (62 perf rules)
Key libraries:
  - framer-motion — Animations
  - lucide-react  — Icons
  - recharts      — Validator metrics charts (optional)
```

---

## 6. Web UI Design

### 6.1 Design Direction

**Aesthetic**: Terminal-meets-dashboard. Dark theme with phosphor green (#00FF41) accents on deep black (#0A0A0A). Monospace typography for data, clean sans-serif for UI. The feeling of a mission control center — professional, precise, trustworthy.

**Key screens**:

#### Screen 1: Dashboard / New Migration
- Welcome screen with validator stats (if connected)
- "Start Migration" CTA → opens wizard
- History of past migrations (from SQLite)

#### Screen 2: Migration Wizard (3 steps)
1. **Configure**: Enter source/target server details, select keypair path, ledger path
2. **Connect Agents**: Display session code, show connection status for both agents, SAS verification UI
3. **Pre-flight**: Checklist with green/red status for each check, "Start Migration" button

#### Screen 3: Live Migration
- State machine visualization (current step highlighted)
- Real-time log stream from both agents
- Progress indicators for file transfers
- Timer showing elapsed time
- Big status indicator: IN PROGRESS / SUCCESS / ROLLBACK / FAILED
- Abort button (triggers rollback)

#### Screen 4: Complete
- Migration summary (time taken, steps completed)
- Validator health check results
- "Verify on Explorer" link to solana.fm/validators/<pubkey>

### 6.2 Responsive Design
- Desktop-first (operators are on laptops/desktops)
- Mobile-friendly for monitoring on the go
- Key info visible at a glance on any screen size

---

## 7. Project Structure

```
solshift/
├── packages/
│   ├── agent/                    # CLI Agent
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── commands/
│   │   │   │   └── agent.ts      # Main agent command
│   │   │   ├── solana/
│   │   │   │   ├── cli.ts        # Solana CLI wrapper
│   │   │   │   ├── validator.ts  # Validator operations
│   │   │   │   └── keypair.ts    # Keypair read/write/wipe
│   │   │   ├── crypto/
│   │   │   │   ├── exchange.ts   # X25519 key exchange
│   │   │   │   ├── encrypt.ts    # XChaCha20-Poly1305
│   │   │   │   └── sas.ts        # Short Authentication String
│   │   │   ├── transport/
│   │   │   │   └── ws-client.ts  # WebSocket client
│   │   │   └── ui/
│   │   │       └── terminal.ts   # Terminal UI (chalk, ora)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── hub/                      # Hub Server
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── api/
│   │   │   │   ├── routes.ts     # REST API routes
│   │   │   │   └── middleware.ts # Auth, rate limiting
│   │   │   ├── ws/
│   │   │   │   ├── handler.ts    # WebSocket message handler
│   │   │   │   └── rooms.ts     # Session room management
│   │   │   ├── orchestrator/
│   │   │   │   ├── state-machine.ts  # Migration state machine
│   │   │   │   ├── steps.ts          # Step definitions
│   │   │   │   └── rollback.ts       # Rollback logic
│   │   │   └── db/
│   │   │       ├── schema.ts     # SQLite schema
│   │   │       └── queries.ts    # Database queries
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── web/                      # Web UI
│   │   ├── app/
│   │   │   ├── page.tsx          # Dashboard
│   │   │   ├── migrate/
│   │   │   │   └── page.tsx      # Migration wizard
│   │   │   ├── session/
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx  # Live migration view
│   │   │   └── history/
│   │   │       └── page.tsx      # Past migrations
│   │   ├── components/
│   │   │   ├── ui/               # Design system primitives
│   │   │   ├── wizard/           # Wizard step components
│   │   │   ├── migration/        # Live migration components
│   │   │   └── layout/           # Layout components
│   │   ├── lib/
│   │   │   ├── ws.ts             # WebSocket client
│   │   │   └── store.ts          # Zustand store
│   │   ├── package.json
│   │   └── next.config.js
│   │
│   └── shared/                   # Shared types & constants
│       ├── types.ts              # Common TypeScript types
│       ├── protocol.ts           # WebSocket message protocol
│       └── constants.ts          # Shared constants
│
├── docker-compose.yml            # Hub + Web deployment
├── Dockerfile.hub
├── Dockerfile.web
├── package.json                  # Workspace root (npm workspaces)
└── README.md
```

---

## 8. WebSocket Protocol

### Message Types

```typescript
// Agent → Hub
type AgentMessage =
  | { type: 'agent:hello'; role: 'source' | 'target'; sessionCode: string; publicKey: string }
  | { type: 'agent:sas_confirmed' }
  | { type: 'agent:preflight_result'; checks: PreflightCheck[] }
  | { type: 'agent:step_complete'; step: number; result: StepResult }
  | { type: 'agent:step_failed'; step: number; error: string }
  | { type: 'agent:encrypted_payload'; payload: string; hash: string } // base64 encrypted data
  | { type: 'agent:log'; level: 'info' | 'warn' | 'error'; message: string }

// Hub → Agent
type HubToAgentMessage =
  | { type: 'hub:peer_connected'; peerPublicKey: string }
  | { type: 'hub:verify_sas'; sas: string }
  | { type: 'hub:run_preflight' }
  | { type: 'hub:execute_step'; step: number }
  | { type: 'hub:rollback' }
  | { type: 'hub:relay_payload'; payload: string; hash: string } // relayed from peer
  | { type: 'hub:session_cancelled' }

// Hub → Web UI
type HubToDashboardMessage =
  | { type: 'dashboard:state_change'; state: MigrationState; prevState: MigrationState }
  | { type: 'dashboard:agents_status'; source: AgentStatus; target: AgentStatus }
  | { type: 'dashboard:preflight_update'; checks: PreflightCheck[] }
  | { type: 'dashboard:step_progress'; step: number; status: 'running' | 'complete' | 'failed' }
  | { type: 'dashboard:log'; agent: 'source' | 'target'; level: string; message: string; ts: number }
  | { type: 'dashboard:migration_complete'; summary: MigrationSummary }

// Web UI → Hub
type DashboardMessage =
  | { type: 'dashboard:start_migration' }
  | { type: 'dashboard:abort' }
  | { type: 'dashboard:confirm_sas' }
```

---

## 9. Deployment

### 9.1 Self-hosted (recommended for production)

```bash
# Clone and deploy
git clone https://github.com/YMprobot/solshift
cd solshift
docker-compose up -d
```

`docker-compose.yml`:
```yaml
services:
  hub:
    build:
      context: .
      dockerfile: Dockerfile.hub
    ports:
      - "3001:3001"      # HTTP API
      - "3002:3002"      # WebSocket
    volumes:
      - ./data:/app/data  # SQLite DB
    environment:
      - NODE_ENV=production
      
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_HUB_URL=wss://your-domain:3002
      - HUB_API_URL=http://hub:3001
```

### 9.2 Hosted version (for demo / bounty submission)

Deploy Hub + Web on a VPS (Fly.io, Railway, or DigitalOcean). Provide a public URL.

Agent is always self-hosted (runs on the validator's own servers).

### 9.3 Agent installation

```bash
# Option 1: npx (no install)
npx solshift-agent --role source --session X7K9M2

# Option 2: global install
npm i -g solshift-agent
solshift agent --role source --session X7K9M2

# Option 3: download binary
curl -fsSL https://solshift.app/install.sh | bash
```

---

## 10. Edge Cases & Safety

### 10.1 Anti-Dual-Identity Protocol

The most dangerous scenario is two validators voting with the same staked identity simultaneously. SolShift prevents this by:

1. **Sequential execution**: Steps 2-3 (deactivate source) must complete before Steps 6-7 (activate target)
2. **Verification gate**: After deactivating source, the Hub queries gossip to confirm the source is no longer voting before proceeding
3. **Lockout**: If the Hub loses connection to either agent during MIGRATING state, it triggers automatic rollback

### 10.2 Network Failure Handling

| Scenario | Response |
|----------|---------|
| Agent disconnects during PAIRING | Session expires after 5 min, retry |
| Agent disconnects during PREFLIGHT | Return to PAIRING, re-verify |
| Source agent disconnects during MIGRATING (before step 5) | Rollback: restore source identity |
| Target agent disconnects during MIGRATING (after step 5) | CRITICAL: manual intervention required. Key exists on both. Alert operator. |
| Hub crashes during MIGRATING | Agents detect disconnect, enter SAFE mode (no further actions). Operator reconnects and resolves manually. |

### 10.3 Tower File Integrity

The tower file (`tower-1_9-<pubkey>.bin`) preserves voting lockouts. If corrupted, the validator could violate lockout rules. SolShift:

- Computes SHA-256 hash before transfer
- Verifies hash after transfer
- If mismatch → abort transfer, retry or rollback

### 10.4 Keypair Secure Wipe

After successful migration and verification:

```typescript
// Overwrite file with random bytes before unlinking
const fileSize = fs.statSync(keypairPath).size;
const randomBytes = crypto.randomBytes(fileSize);
fs.writeFileSync(keypairPath, randomBytes);
fs.unlinkSync(keypairPath);
```

---

## 11. Development Plan

### Phase 1: Core CLI Agent (Week 1)
- [ ] Solana CLI wrapper (set-identity, authorized-voter, wait-for-restart-window)
- [ ] X25519 key exchange + XChaCha20-Poly1305 encryption
- [ ] WebSocket client
- [ ] Terminal UI (chalk, ora, inquirer)
- [ ] Basic agent flow (connect, pair, transfer)

### Phase 2: Hub Server (Week 1-2)
- [ ] Session management (create, join, expire)
- [ ] WebSocket rooms (agent + dashboard connections)
- [ ] State machine orchestrator
- [ ] REST API for Web UI
- [ ] Encrypted relay (pass-through, no decryption)
- [ ] SQLite audit log

### Phase 3: Web UI (Week 2-3)
- [ ] Design system (dark theme, components)
- [ ] Dashboard + migration wizard
- [ ] Live migration view with real-time logs
- [ ] SAS verification UI
- [ ] Pre-flight checklist UI
- [ ] Migration history

### Phase 4: Safety & Polish (Week 3-4)
- [ ] Rollback protocol implementation
- [ ] Anti-dual-identity verification
- [ ] Tower file integrity checks
- [ ] Secure wipe
- [ ] Error handling & edge cases
- [ ] Docker deployment
- [ ] Demo video
- [ ] Documentation

### Phase 5: Demo & Submission
- [ ] Deploy hosted Hub + Web UI
- [ ] Testnet migration demo (full E2E)
- [ ] Record demo video
- [ ] Write submission (product explanation, target user)
- [ ] Publish to GitHub

---

## 12. Competitive Advantages for Judging

| Criterion | How SolShift Excels |
|-----------|-------------------|
| **Execution Quality & Completeness** | Full-stack solution (CLI + Hub + Web UI), not just a bash script. State machine with edge case handling, rollback, audit logs. |
| **Security** | E2E encryption — Hub never sees the private key. X25519 key exchange with SAS verification. Secure wipe. Anti-dual-identity. |
| **Clarity of UX** | Web dashboard with step-by-step wizard, real-time migration tracking, pre-flight checklist. Terminal UI with clear progress for CLI users. |
| **Live, Working Application** | Deployed Hub + Web UI. Agent installable via npx. Full E2E demo on testnet. |

---

## 13. Agent Skills for Development

### Vercel React Best Practices (UI)

62 rules across 8 categories for React/Next.js performance optimization from Vercel Engineering. Covers async waterfalls, bundle size, RSC boundaries, re-render prevention, and Core Web Vitals.

```bash
npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices
```

### Solana Dev Skill (Backend/Agent)

From [solana.com/skills](https://solana.com/skills) — core Solana development patterns:

- **solana-dev-skill** (Foundation) — @solana/kit v5.x, Anchor, testing, security
- **Frontend with framework-kit** — Wallet connection patterns (for future wallet-auth feature)
- **Security Checklist** — Account validation patterns
- **Common Errors & Solutions** — Troubleshooting reference
- **Version Compatibility Matrix** — Toolchain version matching

```bash
npx skills add https://github.com/solana-foundation/solana-dev-skill
```

---

## 14. Naming & Branding

**SolShift** — short, memorable, descriptive.

- Logo concept: A stylized arrow/shift icon with Solana's gradient
- Tagline: *"Secure validator identity migration for Solana"*
- Domain: solshift.app (or solshift.dev)
- GitHub: github.com/YMprobot/solshift

---

*Document created: April 2026*
*Author: YM × Claude*

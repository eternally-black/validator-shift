# ValidatorShift — Specification

> Working name: **ValidatorShift** (`@validator-shift/*`, CLI `validator-shift`).
> Repository: <https://github.com/Eternally-black/validator-shift>.
> Status: living spec, reflects the current monorepo at `c:/Users/Valera/Desktop/Solana Validator/` (April 2026).
> The original architecture document [`SOLSHIFT_Architecture.md`](./SOLSHIFT_Architecture.md) remains as a v1.0 design artifact; this `SPEC.md` is the source of truth for what is actually implemented.

---

## 1. Problem & scope

Migrating a Solana validator's **staked identity** between two servers is a high-risk operation. Existing tooling (STEVLTH bash, mvines manual steps, Ansible playbooks) suffers from:

- Plaintext `scp` of the validator keypair.
- No protection against **dual-signing** (two nodes voting under the same identity).
- No deterministic **rollback** on partial failure.
- No verifiable **integrity** of the tower file.
- No human-verifiable **MITM check** on the transit channel.

ValidatorShift replaces this with a CLI + Hub + Web stack where the keypair is end-to-end encrypted between the two operator-controlled agents and the central Hub never sees plaintext key material.

**Target user.** Solana validator operators (solo through institutional) performing hardware refreshes, datacenter moves, OS / `solana-validator` upgrades, or disaster recovery.

**Out of scope.** Stake delegation operations; vote-account creation; multisig/HSM custody; long-term backup of operator keypairs; modifications to on-chain consensus.

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Web UI (Next.js 15)                  │
│   Dashboard · Wizard · Live state · Logs · History       │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (HTTP+WS share one port)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Hub (Fastify + ws)                      │
│  Sessions · Orchestrator · Encrypted Relay (E2E opaque)  │
│  SQLite (sessions, audit, step status — NEVER keys)      │
└───────┬─────────────────────────────────────┬───────────┘
        │  WSS                                │  WSS
        ▼                                     ▼
┌────────────────────┐                ┌────────────────────┐
│  Agent  (source)   │                │  Agent  (target)   │
│  TS / Node 20+     │◄──────────────►│  TS / Node 20+     │
│  solana CLI driver │  E2E encrypted │  solana CLI driver │
└────────────────────┘   key transfer └────────────────────┘
```

**Three components, three deployment surfaces:**

| Component | Package | Transport in | Transport out | Persistence |
|-----------|--------------------------|------------------------|------------------------|--------------------|
| Agent     | `@validator-shift/agent` | local CLI args / stdin | WSS to Hub             | tmp files only     |
| Hub       | `@validator-shift/hub`   | HTTP REST + WS         | WS broadcast           | SQLite (no keys)   |
| Web       | `@validator-shift/web`   | HTTP from operator     | WSS to Hub             | none               |
| Shared    | `@validator-shift/shared`| —                      | —                      | n/a (types only)   |

---

## 3. Security model

### 3.1 Threat model

| Threat | Mitigation |
|--------|------------|
| Key interception in transit | X25519 ECDH + XChaCha20-Poly1305 between agents |
| Compromised Hub | Hub never decrypts payloads; relay-only invariant enforced architecturally (no symmetric primitive linked into hub binary) |
| MITM substitution at pairing | Operator-verified 3-word **SAS** displayed on both terminals + Web UI |
| Dual-signing | Sequential state machine + gossip "source quiet" gate + voting-confirmed envelope gate |
| Failed migration leaving orphaned state | Deterministic state machine + 4-step rollback sequence |
| Source keypair lingering after success | Random-overwrite + `unlink` secure wipe gated by target-voting-confirmed signal |
| Unauthorized dashboard control | Per-session bearer token returned by `POST /api/sessions`, required on `/ws/dashboard/:id` |
| Plaintext WS to non-loopback hub | CLI rejects `ws://`/`http://` to non-loopback hosts unless `--insecure-ws` |
| Brute-force session-code guessing | WS connection rate limit (30/min per IP) + REST rate limit |
| Secret leakage via logs | `redactSecrets()` on every agent log + re-redaction at Hub boundary |

### 3.2 Cryptographic primitives

| Purpose | Algorithm | Library | Notes |
|---------|-----------|---------|-------|
| Key agreement | X25519 (Curve25519 ECDH) | `tweetnacl` (`nacl.box.before`) | Ephemeral per session |
| KDF | HKDF-SHA256 | `@noble/hashes/hkdf` | Distinct `info` labels per use |
| AEAD | XChaCha20-Poly1305 | `@noble/ciphers/chacha` | 24-byte random nonce, 16-byte tag |
| File integrity | SHA-256 | `node:crypto` | Pre-transfer + post-write read-back |
| Pubkey derivation | Ed25519 (sign keypair pubkey) | `tweetnacl` | For source-identity verification |

**KDF separation.** The X25519 shared secret feeds two derivations with disjoint `info` strings:

- `validator-shift-session-v1` → 32-byte AEAD session key (tower + identity payloads + voting-confirmed envelope).
- `validator-shift-sas-v1` → 3-byte SAS seed; each byte modulo 26 maps to NATO phonetic word.

### 3.3 Hub invariant (architectural)

> **The Hub never decrypts payloads and never stores private key material.**

Enforced by:

- The hub binary does **not** import `@noble/ciphers` for decryption. The `agent:encrypted_payload` handler in `packages/hub/src/ws/handler.ts` is opaque: it only repacks `{ payload, hash }` into `hub:relay_payload` and forwards to the peer.
- The SQLite schema (`packages/hub/src/db/schema.ts`) has no `keypair`, `secret`, `private_key`, or `payload` columns. Any PR adding such a column should be rejected at review.
- Audit log messages from agents are **re-redacted** at the hub boundary via `redactSecrets()` before persistence/broadcast.

### 3.4 SAS verification

The 3-word SAS (e.g. `ALPHA-BRAVO-CHARLIE`) is computed identically on both agents from the X25519 shared secret. It must be visually compared in **three** places before the operator confirms:

1. Source agent terminal.
2. Target agent terminal.
3. Web UI wizard step 2.

A mismatch in any of the three indicates an active MITM at the Hub level. In the agent, `confirmSAS()` (inquirer prompt) sends `agent:sas_confirmed` only when the operator types matching confirmation; both agents must confirm before the orchestrator transitions to `PREFLIGHT`.

### 3.5 Anti-dual-identity protocol

Three overlapping defenses guarantee that two servers never vote with the same staked identity:

1. **Sequential execution.** The state machine emits `execute_step` for steps 1→9 in order, with steps 2–3 (deactivate source) preceding steps 6–7 (activate target) and step 8 (post-flight verify) preceding step 9 (wipe). The orchestrator ignores step results that do not match `_currentStep`.
2. **Source-quiet gossip gate** (`waitForSourceQuiet` in `packages/agent/src/commands/agent.ts`). Before step 6, the target polls `solana validators --output json` until the source pubkey is either gone from the validator set or marked `delinquent`. Hard 60 s timeout → throw → step 6 fails → rollback.
3. **Voting-confirmed envelope gate**. Step 8 (target) emits an encrypted `{kind:'voting_confirmed', ...}` envelope back through the relay. Source's step 9 will not execute the secure wipe until that envelope arrives within 60 s; otherwise it throws and the keypair is preserved.
4. **Lockout on disconnect.** If either agent's WS drops during `MIGRATING`:
   - source disconnects with `currentStep < 5` → orchestrator triggers rollback.
   - target disconnects with `currentStep ≥ 5` → orchestrator emits `critical_alert` and refuses further actions; manual operator intervention required (target may already hold the keypair).

### 3.6 Tower file integrity

The tower file (`tower-1_9-<pubkey>.bin`) records voting lockouts and is the second piece of state that must transit reliably. Source computes SHA-256 over the file bytes, sends it as `hash` alongside the encrypted payload; target computes SHA-256 of decrypted bytes, then performs a **read-back-after-fsync** check (re-reads the file from disk and re-hashes) before declaring step 4 complete. Any mismatch → throw → rollback.

### 3.7 Secure wipe

Step 9 (source-only):

```ts
const fileSize = fs.statSync(keypairPath).size
const randomBytes = crypto.randomBytes(fileSize)
fs.writeFileSync(keypairPath, randomBytes)
fs.unlinkSync(keypairPath)
```

Wipe runs only after `peerVotingConfirmed === true` (see §3.5) and operator confirmation (unless `--yes`). On COW filesystems / wear-leveled SSDs this is best-effort; operators with stronger threat models must wipe at the storage layer.

A `SIGINT` / `SIGTERM` handler also fires `secureWipe()` on every tmp file the agent created during the session (unstaked keypair, received target keypair).

---

## 4. State machine

```
        ┌──────┐                  abort / fatal preflight
        │ IDLE │ ─────────────────────────────────────────► FAILED
        └──┬───┘
           │ both agents connected
           ▼
       ┌─────────┐  agent disconnect
       │ PAIRING │ ──────────────► IDLE
       └────┬────┘  abort
            │ both SAS confirmed
            ▼
      ┌───────────┐  preflight fail / abort
      │ PREFLIGHT │ ──────────────► FAILED
      └─────┬─────┘  agent disconnect
            │ all checks ok        ──────────────► IDLE
            ▼
   ┌────────────────┐  abort
   │ AWAITING_WINDOW│ ──────────► FAILED
   └───────┬────────┘
           │ dashboard:start_migration
           ▼
      ┌───────────┐  step 1 fail / fatal abort
      │ MIGRATING │ ─────────────────────────────► FAILED
      └─────┬─────┘  step ≥2 fail / abort post-step-2
            │ step 9 ok                ──────────► ROLLBACK
            ▼
       ┌──────────┐                                   │
       │ COMPLETE │                                   ▼
       └──────────┘                              ┌────────┐
                                                 │ FAILED │
                                                 └────────┘
```

**Allowed transitions** (from `state-machine.ts`):

| From | To |
|------|----|
| `IDLE`            | `PAIRING`, `FAILED` |
| `PAIRING`         | `PREFLIGHT`, `IDLE` (disconnect), `FAILED` (abort) |
| `PREFLIGHT`       | `AWAITING_WINDOW`, `IDLE` (disconnect), `FAILED` |
| `AWAITING_WINDOW` | `MIGRATING`, `FAILED` |
| `MIGRATING`       | `COMPLETE`, `ROLLBACK`, `FAILED` |
| `ROLLBACK`        | `FAILED` |
| `COMPLETE`        | (terminal) |
| `FAILED`          | (terminal) |

Self-loops are no-ops; any other edge throws `InvalidTransitionError`.

**Cancellable states** (REST `DELETE /api/sessions/:id`): `IDLE`, `PAIRING` only. Anything later goes through orchestrator abort + rollback semantics.

---

## 5. Migration steps

Defined in `@validator-shift/shared` as `MIGRATION_STEPS`. Hub-side timeouts in `packages/hub/src/orchestrator/steps.ts`:

| # | Name                              | Executor | Timeout | Action |
|---|-----------------------------------|----------|---------|--------|
| 1 | `wait_for_restart_window`         | source   | 30 min  | `solana-validator -l <ledger> wait-for-restart-window --min-idle-time 2 [--skip-new-snapshot-check]` |
| 2 | `set_unstaked_identity_source`    | source   | 30 s    | Generate (or load) unstaked keypair → `set-identity` on source |
| 3 | `remove_authorized_voters_source` | source   | 30 s    | `authorized-voter remove-all` |
| 4 | `transfer_tower_file`             | source   | 120 s   | Read `tower-1_9-<pubkey>.bin` → SHA-256 → encrypt → relay → target writes + fsync + read-back hash |
| 5 | `transfer_identity_keypair`       | source   | 120 s   | Encrypt staked keypair (with embedded pubkey + sha256) → relay → target writes to tmp, verifies pubkey derivation |
| 6 | `set_staked_identity_target`      | target   | 30 s    | `waitForSourceQuiet` gossip gate → operator confirmation → `set-identity` on target |
| 7 | `add_authorized_voter_target`     | target   | 30 s    | `authorized-voter add` |
| 8 | `post_migration_verify`           | target   | 30 s    | `getValidatorInfo` → assert `isVoting` → emit `voting_confirmed` envelope back to source |
| 9 | `cleanup_source`                  | source   | 30 s    | Wait ≤ 60 s for `voting_confirmed` → operator confirmation → `secureWipe(keypair)` |

### 5.1 Rollback sequence

Triggered when `currentStep ≥ 2` fails or operator aborts post-step-2:

| # | Name                                | Executor | Description |
|---|-------------------------------------|----------|-------------|
| 1 | `restore_source_identity`           | source   | `set-identity <staked-keypair>` on source |
| 2 | `readd_authorized_voter_source`     | source   | `authorized-voter add` on source |
| 3 | `remove_transferred_files_target`   | target   | Unlink received tower + identity tmp files |
| 4 | `verify_source_voting`              | source   | Confirm source is voting again via gossip |

Failure on step 1 (`wait_for_restart_window`) → straight to `FAILED`, **no rollback** (no validator state was mutated).

### 5.2 Pre-flight checks

Per-role, run inside agent on `hub:run_preflight`:

| Check | Source | Target |
|-------|:------:|:------:|
| `solana --version` succeeds | ✅ | ✅ |
| validator process running (`getValidatorInfo`) | ✅ | ✅ |
| validator caught up to gossip | ✅ | ✅ |
| identity keypair file readable | ✅ | — |
| keypair pubkey matches `--identity-pubkey` flag | ✅ | — |
| ledger path writable | — | ✅ |

Both agents' results are aggregated by orchestrator. Any `ok:false` → `FAILED` (with reason text); all green → `AWAITING_WINDOW`.

---

## 6. Tech stack

### 6.1 Agent (`@validator-shift/agent`)

- **Runtime**: Node.js 20+; ESM; bin entry `validator-shift`.
- **CLI**: `commander` v12.
- **Transport**: `ws` v8.16; reconnect with bounded retries (`PAIRING_RECONNECT_MAX_ATTEMPTS = 5`).
- **Crypto**: `tweetnacl` (X25519, Ed25519 pubkey derivation) + `@noble/ciphers` (XChaCha20-Poly1305) + `@noble/hashes` (HKDF-SHA256, SHA-256).
- **Terminal UX**: `chalk`, `ora`, `inquirer`.
- **Validation**: `zod` on inbound hub messages.

### 6.2 Hub (`@validator-shift/hub`)

- **Runtime**: Node.js 20+; ESM.
- **HTTP + WS server**: Fastify v4 + `@fastify/websocket` on **a single TCP port** (default 3001). Single-port design means any HTTP/WS-aware reverse proxy (Caddy, nginx, Cloudflare, fly.io, Railway) works out of the box.
- **Middleware**: `@fastify/cors`, `@fastify/rate-limit`.
- **Persistence**: `better-sqlite3` v11 with `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`.
- **Session codes**: `nanoid/customAlphabet` over `[A-Z0-9]^6`.
- **Validation**: `zod` schemas in `packages/shared/src/protocol.ts`.

### 6.3 Web (`@validator-shift/web`)

- **Framework**: Next.js 15 (App Router).
- **Styling**: Tailwind CSS + custom dark/phosphor design system.
- **State**: Zustand store + native WebSocket.
- **Animations / icons**: `framer-motion`, `lucide-react`.
- **Build**: standalone output baked into `validator-shift/web:local` Docker image.

### 6.4 Shared (`@validator-shift/shared`)

Type/protocol-only package; no runtime dependencies beyond `zod`. Re-exported subpaths:

- `@validator-shift/shared` → `types.ts` (enums, interfaces).
- `@validator-shift/shared/protocol` → `protocol.ts` (zod schemas + parser).
- `@validator-shift/shared/constants` → `constants.ts` (steps, TTLs, ports).
- `@validator-shift/shared/redact` → `redact.ts` (`redactSecrets`, `isValidSessionCode`).

---

## 7. Project layout

```
validator-shift/
├── packages/
│   ├── agent/
│   │   ├── src/
│   │   │   ├── bin.ts                # commander entry; CLI flag validation, ws:// guard
│   │   │   ├── index.ts              # programmatic re-export
│   │   │   ├── commands/agent.ts     # runAgent(): pairing, preflight, step loop, cleanup hooks
│   │   │   ├── crypto/
│   │   │   │   ├── exchange.ts       # generateKeyPair, deriveSharedSecret, deriveSessionKey
│   │   │   │   ├── encrypt.ts        # encrypt/decrypt, encodePayload/decodePayload
│   │   │   │   └── sas.ts            # NATO_ALPHABET, deriveSAS
│   │   │   ├── solana/
│   │   │   │   ├── cli.ts            # runSolanaCli(), SolanaCliError
│   │   │   │   ├── validator.ts      # set-identity, authorized-voter, wait-for-restart-window, getValidatorInfo
│   │   │   │   └── keypair.ts        # readKeypair/writeKeypair/secureWipe/derivePubkey
│   │   │   ├── transport/ws-client.ts
│   │   │   └── ui/terminal.ts        # printBanner, confirmSAS, confirmDestructive, log helpers
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── hub/
│   │   ├── src/
│   │   │   ├── index.ts              # main(): fastify init, WS routes, graceful shutdown
│   │   │   ├── session-manager.ts    # SessionManager: orchestrator wiring, dashboard tokens
│   │   │   ├── api/
│   │   │   │   ├── routes.ts         # POST/GET/DELETE /api/sessions[…]
│   │   │   │   ├── schemas.ts        # zod request/response schemas
│   │   │   │   └── middleware.ts     # CORS, rate-limit
│   │   │   ├── ws/
│   │   │   │   ├── handler.ts        # handleAgentSocket / handleDashboardSocket
│   │   │   │   └── rooms.ts          # Room registry, broadcast, relay helpers
│   │   │   ├── orchestrator/
│   │   │   │   ├── state-machine.ts  # MigrationOrchestrator + InvalidTransitionError
│   │   │   │   ├── steps.ts          # MIGRATION_STEPS metadata + timeouts
│   │   │   │   └── rollback.ts       # ROLLBACK_SEQUENCE, shouldRollback, getRollbackSteps
│   │   │   └── db/
│   │   │       ├── schema.ts         # initDb(), DDL — NO key columns
│   │   │       └── queries.ts        # createSession, append/getRecent audit logs, etc.
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── web/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx              # Dashboard / "Start Migration" CTA
│   │   │   ├── providers.tsx
│   │   │   ├── globals.css
│   │   │   ├── loading.tsx
│   │   │   ├── migrate/page.tsx      # 3-step wizard
│   │   │   ├── session/[id]/…        # Live migration view
│   │   │   └── history/…             # Past sessions list
│   │   ├── components/
│   │   │   ├── ui/                   # Button, Card, Input, Spinner, StatusDot, Badge, CodeBlock
│   │   │   ├── wizard/               # WizardShell, Step1Configure, Step2Connect, Step3Preflight
│   │   │   ├── migration/            # StateMachineViz, StepList, LiveLogStream, BigStatus, Timer, AbortButton
│   │   │   └── layout/               # Header, Footer
│   │   ├── lib/
│   │   │   ├── ws.ts                 # WS client + dashboard token plumbing
│   │   │   └── store.ts              # Zustand state
│   │   ├── next.config.js / tailwind.config.ts / tsconfig.json
│   │   └── package.json
│   │
│   └── shared/
│       ├── src/
│       │   ├── index.ts
│       │   ├── types.ts              # MigrationState enum, AgentRole, PreflightCheck, etc.
│       │   ├── protocol.ts           # zod schemas + parseMessage
│       │   ├── constants.ts          # MIGRATION_STEPS, TTLs, ports, regex
│       │   └── redact.ts             # redactSecrets, isValidSessionCode
│       └── package.json
│
├── docs/
│   ├── QUICKSTART.md
│   └── SECURITY.md
├── e2e/
│   ├── README.md
│   └── run.ts                        # tsx-based smoke harness (mock-mode E2E pending)
├── scripts/
│   ├── install.sh                    # curl | bash agent installer (placeholder)
│   ├── setup-laptop.sh               # Phase C laptop bootstrap
│   ├── setup-wsl.sh / setup-wsl-2.sh
├── Dockerfile.hub / Dockerfile.web
├── docker-compose.yml                # Single-port hub (3001) + web (3000), localhost-bound
├── SOLSHIFT_Architecture.md          # v1.0 design artifact (kept for reference)
├── SPEC.md                           # ← this document
├── README.md
├── package.json                      # npm workspaces root
└── tsconfig.base.json
```

---

## 8. WebSocket protocol

All WS messages are JSON, validated against zod discriminated unions in `@validator-shift/shared/protocol`. An invalid message is logged + dropped — agents and dashboards never crash on a single bad frame.

### 8.1 Agent → Hub (`AgentMessage`)

| Type | Payload |
|------|---------|
| `agent:hello`              | `role`, `sessionCode`, `publicKey` (base64 X25519 pubkey) |
| `agent:sas_confirmed`      | — |
| `agent:preflight_result`   | `checks: PreflightCheck[]` |
| `agent:step_complete`      | `step`, `result: StepResult` |
| `agent:step_failed`        | `step`, `error` |
| `agent:encrypted_payload`  | `payload` (base64 nonce.ciphertext), `hash` (sha256 hex) |
| `agent:log`                | `level: info|warn|error`, `message` (re-redacted at hub) |

### 8.2 Hub → Agent (`HubToAgentMessage`)

| Type | Payload |
|------|---------|
| `hub:peer_connected`     | `peerPublicKey` |
| `hub:verify_sas`         | `sas` |
| `hub:run_preflight`      | — |
| `hub:execute_step`       | `step` |
| `hub:rollback`           | — |
| `hub:relay_payload`      | `payload`, `hash` (verbatim from peer) |
| `hub:session_cancelled`  | — |

### 8.3 Hub → Dashboard (`HubToDashboardMessage`)

| Type | Payload |
|------|---------|
| `dashboard:state_change`        | `state`, `prevState` |
| `dashboard:agents_status`       | `source: AgentStatus`, `target: AgentStatus` |
| `dashboard:preflight_update`    | `checks: PreflightCheck[]` |
| `dashboard:step_progress`       | `step`, `status: running|complete|failed` |
| `dashboard:log`                 | `agent`, `level`, `message`, `ts` |
| `dashboard:migration_complete`  | `summary: MigrationSummary` |

### 8.4 Dashboard → Hub (`DashboardMessage`)

| Type | Payload |
|------|---------|
| `dashboard:start_migration` | — |
| `dashboard:abort`           | — |
| `dashboard:confirm_sas`     | informational only — agents are authoritative |

### 8.5 WS endpoints

| Path | Auth | Purpose |
|------|------|---------|
| `GET /ws/session/:code`    | session code (DB lookup, expiry check) | Agent connection |
| `GET /ws/dashboard/:id?token=…` | session id + bearer token (constant-time compare) | Web UI live updates |

### 8.6 WS close codes

| Code | Reason |
|------|--------|
| 4400 | `invalid_session_code` |
| 4401 | `unauthorized` (dashboard token missing/invalid) |
| 4404 | `session_not_found` |
| 4409 | `role_already_taken` (another agent claimed this role) |
| 4410 | `session_expired` |
| 4429 | `rate_limited` (per-IP WS rate limit) |

---

## 9. REST API

Base path `/api`. All bodies JSON. Errors: `{ error: string, message: string, details?: object }`.

### `POST /api/sessions`

Create a session.

- Body (optional): `{ ttlMs?: number }` (default 30 min).
- 201 → `{ id, code, expiresAt, dashboardToken }`.

`dashboardToken` is a 24-byte base64url string, kept in-memory only (never persisted). It is required as `?token=…` on `/ws/dashboard/:id`. Lose it → operator must abort by other means; no recovery path.

### `GET /api/sessions/:id`

200 → `{ id, code, state, createdAt, expiresAt, completedAt?, agents: AgentStatus[], recentLogs: LogEntry[] }`.

`recentLogs` returns the last 50 audit-log rows for the session.

### `GET /api/sessions?limit=20`

200 → `Session[]`. Default `limit=20`.

### `DELETE /api/sessions/:id`

Cancel an idle/pairing session. 204 on success, 404 if missing, 409 if not in a cancellable state (anything past `PAIRING`).

### Liveness

`GET /` (Fastify default) is sufficient for TCP-probe healthchecks; the docker-compose healthcheck uses a `net.createConnection` probe rather than an HTTP path.

---

## 10. Persistence (SQLite, hub-only)

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_sessions_code  ON sessions(code);
CREATE INDEX idx_sessions_state ON sessions(state);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL,         -- info|warn|error
  agent      TEXT NOT NULL,         -- source|target|hub
  message    TEXT NOT NULL,         -- redacted
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_audit_log_session_ts ON audit_log(session_id, ts);

CREATE TABLE migration_steps (
  session_id  TEXT    NOT NULL,
  step_number INTEGER NOT NULL,
  status      TEXT    NOT NULL,     -- pending|running|complete|failed
  started_at  INTEGER,
  finished_at INTEGER,
  error       TEXT,
  PRIMARY KEY (session_id, step_number),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

**Hard invariant**: no column may store `keypair`, `secret`, `private_key`, or any plaintext payload. Reviewers MUST reject changes that violate this.

---

## 11. Web UI

### 11.1 Pages

| Route                | Purpose |
|----------------------|---------|
| `/`                  | Dashboard. Active/recent sessions, "Start Migration" CTA. |
| `/migrate`           | 3-step wizard. |
| `/session/[id]`      | Live migration view. State machine viz, step list, log stream, abort. |
| `/history`           | Past sessions, filterable. |

### 11.2 Wizard

- **Step 1 — Configure.** Source/target labels, ledger paths, keypair paths, `--identity-pubkey`. Submits `POST /api/sessions`, persists `dashboardToken` in store.
- **Step 2 — Connect agents.** Displays session code + `npx @validator-shift/agent …` command snippets per role. Auto-advances on `dashboard:agents_status` showing both connected. Renders the SAS displayed by the orchestrator and asks operator to compare against both terminals.
- **Step 3 — Preflight.** Renders `dashboard:preflight_update` checks; "Start Migration" button is disabled until all are green.

### 11.3 Live migration

- `StateMachineViz` highlights current state (IDLE → … → COMPLETE).
- `StepList` renders steps 1–9 with running/complete/failed badges from `dashboard:step_progress`.
- `LiveLogStream` streams `dashboard:log` (color-coded by level, role-tagged).
- `AbortButton` sends `dashboard:abort`.
- `BigStatus` mirrors the current `MigrationState`.
- `Timer` is driven by `summary.startedAt`/now until COMPLETE.

### 11.4 WS resilience

`packages/web/lib/ws.ts` reconnects with exponential backoff and reapplies the `dashboardToken` query string. The Hub sends a snapshot (state, agents_status, recent logs) on every dashboard connect, so a UI reconnect is idempotent.

---

## 12. CLI surface

```
validator-shift agent
  --role <source|target>         required
  --session <code>               required (6-char [A-Z0-9])
  --hub <wssUrl>                 required (https://, wss://, or http(s)://localhost)
  --ledger <path>                required (absolute)
  --keypair <path>               required when --role=source
  --identity-pubkey <pk>         required when --role=source — base58 of running validator's --identity
  --unstaked-keypair <path>      optional (generated to tmp if omitted)
  --skip-snapshot-check          pass through to wait-for-restart-window
  -y, --yes                      auto-confirm destructive prompts
  --insecure-ws                  allow ws:///http:// to non-loopback (NOT recommended)
```

**Hub URL guard.** Plain `ws://`/`http://` is refused unless host is `localhost`/`127.0.0.1`/`[::1]` or `--insecure-ws` is set. SAS still detects MITM, but plaintext is never normalized in production paths.

**Pubkey discipline.** `--identity-pubkey` is mandatory on source because `solana address` returns the operator's default keypair, **not** the validator's `--identity`. Preflight cross-checks the loaded keypair against `--identity-pubkey`; mismatch → preflight fails before any state mutation.

---

## 13. Deployment

### 13.1 Self-hosted (recommended)

```bash
git clone https://github.com/Eternally-black/validator-shift
cd validator-shift
docker-compose up -d
```

Services (defined in `docker-compose.yml`):

| Service | Image | Ports (host) | Volumes | Caps |
|---------|-------------------------|---------------|------------|--------------------|
| `hub`   | `validator-shift/hub:local`  | `127.0.0.1:3001` | `validator-shift-hub-data` | `cap_drop ALL`, `read_only`, `no-new-privileges`, tmpfs `/tmp`, 0.5 CPU / 512 M |
| `web`   | `validator-shift/web:local`  | `127.0.0.1:3000` | tmpfs only | `cap_drop ALL`, `read_only`, `no-new-privileges`, tmpfs `/tmp` + `/app/packages/web/.next/cache`, 1.0 CPU / 1 G |

Host-bound to loopback by default. Front with TLS via Caddy / nginx / Cloudflare and override `NEXT_PUBLIC_HUB_URL` to the public hub origin (e.g. `https://hub.your-domain`). The hub uses **one** TCP port for both REST and WS.

### 13.2 Hosted (demo)

Single-port hub deploys cleanly on Railway, fly.io, DigitalOcean Apps. Honour `PORT` env (cloud convention) over `HUB_HTTP_PORT`. The agent always self-hosts on the operator's validator boxes.

### 13.3 Agent install

```bash
# Recommended — no install
npx @validator-shift/agent agent --role source --session ABC123 --hub wss://hub …

# Global
npm i -g @validator-shift/agent
validator-shift agent --role source …

# Curl (if/when scripts/install.sh is published)
curl -fsSL https://raw.githubusercontent.com/Eternally-black/validator-shift/main/scripts/install.sh | bash
```

---

## 14. Testing

| Layer | Tool | Files |
|-------|------|-------|
| Shared types/protocol | vitest | `packages/shared/src/{types,protocol,constants}.test.ts` |
| Agent crypto | vitest | `packages/agent/src/crypto/{encrypt,exchange,sas}.test.ts` |
| Agent solana wrappers | vitest | `packages/agent/src/solana/{cli,keypair}.test.ts` |
| Hub orchestrator | vitest | `packages/hub/src/orchestrator/{state-machine,rollback}.test.ts` |
| End-to-end smoke | tsx script | `e2e/run.ts` (manual / CI) |

Run all unit tests: `npm run -ws test`.

The E2E harness (`e2e/run.ts`) currently runs in **smoke mode**: hub bootstrap, session creation, dashboard WS open, both agents spawn. Full happy-path / rollback E2E is gated on adding a `mockMode` to `packages/agent/src/solana/cli.ts` so the agent can be driven without a real `solana` binary on the test host (see `e2e/README.md`).

---

## 15. Operational invariants (review checklist)

When reviewing changes, verify each of the following still holds:

1. **Hub does not import any AEAD decryption primitive** (`@noble/ciphers`, `tweetnacl.secretbox`, etc.) in `packages/hub/`.
2. **No SQLite column** named `keypair`, `secret`, `private_key`, `payload`, or storing base64 ciphertext.
3. **`agent:encrypted_payload` handler in the hub is byte-identical relay**: only repackages to `hub:relay_payload`; never base64-decodes, parses, or logs payload contents.
4. **`redactSecrets()` is applied** to every `agent:log` at the hub boundary before persist + broadcast.
5. **Dashboard token is required** for `/ws/dashboard/:id`; constant-time compare; never persisted.
6. **WS rate limit** (30/min/IP) gates both agent and dashboard endpoints.
7. **CLI refuses plaintext WS** to non-loopback hosts unless `--insecure-ws`.
8. **`--identity-pubkey` is required on source** and is cross-checked against the loaded keypair in preflight.
9. **Step 6 is preceded by `waitForSourceQuiet`** with a 60 s hard timeout.
10. **Step 9 will not run** until `peerVotingConfirmed === true` from the relayed envelope (60 s timeout).
11. **`SIGINT`/`SIGTERM` handlers** secure-wipe every tmp file the agent created (`tmpFilesToWipe` set in `commands/agent.ts`).
12. **State transitions** are validated against `ALLOWED_TRANSITIONS`; only the documented edges are allowed.
13. **Rollback fires for any failure on step ≥ 2**, never on step 1.
14. **Web UI uses no environment-leaking deps** in client components (e.g. fetcher must not embed `HUB_URL` server-side var).

---

## 16. Naming & branding

- **Working name**: `ValidatorShift` (camel) / `validator-shift` (kebab, packages + repo).
- **GitHub**: `Eternally-black/validator-shift`.
- **NPM**: `@validator-shift/{agent,hub,web,shared}`.
- **CLI bin**: `validator-shift` (installed via `@validator-shift/agent`).
- **Deprecated**: `SolShift` / `solshift` / `solshift.app` / `YMprobot/solshift`. The architecture file's literal name `SOLSHIFT_Architecture.md` is preserved as a historical artifact only — its branding contents are superseded by this document.
- **Domain**: not yet chosen. Keep all docs/copy domain-neutral.

---

## 17. Roadmap

| Wave | Status | Notes |
|------|--------|-------|
| 1 — Bootstrapping & Hub MVP | done | npm workspaces, fastify single-port, sessions, audit log, dashboard token |
| 2 — Agent + crypto + state machine | done | X25519 + XChaCha20, SAS, all 9 steps, rollback, voting_confirmed gate |
| 3 — Web wizard + live view | done | wizard auto-advances on agent connect; SAS displayed in three places |
| 4 — Hardening & polish | in progress | E2E mock mode, install.sh, license decision, demo video |
| 5 — Submission | pending | hosted hub + recorded testnet migration |

Open work tracked in `c:/Users/Valera/Desktop/Solana Validator/` git history; see also `e2e/README.md` for the mock-mode TODO list.

# ValidatorShift — E2E Test Harness (Wave 3 / D3)

This directory contains a self-contained Node script that boots the hub
and (in mock mode) two agent processes against ephemeral ports + an
in-memory SQLite database, then drives the migration state machine
end-to-end and asserts the dashboard observes
`IDLE → PAIRING → PREFLIGHT → AWAITING_WINDOW → MIGRATING → COMPLETE`.

## Run

From the repository root:

```bash
npx tsx e2e/run.ts
```

The script does **not** modify any package's `package.json` and is not
wired into `npm test` — it is intended for manual / CI smoke runs.

## What it does

1. Generates fixtures under `e2e/`:
   - `fake-source-keypair.json` (64-byte Solana keypair, generated via
     `nacl.sign.keyPair()` and serialised as a JSON byte array)
   - `fake-target-keypair.json` (dummy — Solana CLI requires `--keypair`
     even though the target receives the real one over the relay)
   - `fake-ledger/` directory
   - `fake-ledger/tower-1_9-<sourcePubkey>.bin` — 32 random bytes that
     stand in for the real tower file
2. Spawns the hub via `npx tsx packages/hub/src/index.ts` with:
   ```
   HUB_HTTP_PORT=13001
   HUB_WS_PORT=13002
   HUB_DB_PATH=:memory:
   ```
   and polls `GET http://localhost:13001/api/sessions` until it answers.
3. Calls `POST /api/sessions` to obtain `{ id, code }`.
4. Opens `ws://localhost:13002/ws/dashboard/<id>` and pretty-prints
   every `dashboard:state_change` / `dashboard:log` / `dashboard:step_progress`
   message.
5. Spawns two agents through `npx tsx packages/agent/src/bin.ts agent …`,
   one per role, both with `VALIDATOR_SHIFT_E2E_MOCK=1` in their env.
6. Waits up to 60 s for the dashboard to observe `state -> COMPLETE`.
   Cleans up child processes on exit.

## Acceptance

| Check | Pass condition |
|-------|----------------|
| Hub starts | `GET /api/sessions` answers within 30 s |
| Session created | `POST /api/sessions` returns 201 with `{id, code}` |
| Both agents connect | `dashboard:agents_status` shows both `connected` |
| SAS auto-confirmed | Mock mode bypasses the inquirer prompt |
| Preflight passes | `dashboard:preflight_update` reports all checks ok |
| Migration completes | Final `dashboard:state_change` is `COMPLETE` within 60 s |

## Known limitations / TODO

> The full happy-path is currently **disabled by default** because
> the agent's Solana CLI wrapper does not yet honour any mock flag.

`packages/agent/src/solana/cli.ts` exports
`runSolanaCli(args, opts?: { timeoutMs?, cwd? })` and unconditionally
shells out to `solana`. There is **no** `mockMode` option and **no**
recognition of the `VALIDATOR_SHIFT_E2E_MOCK` env-flag. Until that lands,
spawning the real agent would fail at the very first preflight check
(`solana --version`) on any host without the Solana CLI installed.

The harness therefore probes `process.env.E2E_FORCE_MOCK === '1'` and,
when unset, **falls back to a smoke-test** that only verifies:

- the hub spawns and starts listening,
- `POST /api/sessions` returns a fresh `{id, code}` pair,
- the dashboard WebSocket opens cleanly.

This already validates the end-to-end wiring of Wave 1 + Wave 2 without
depending on the Solana toolchain.

### To enable the full happy-path

1. Add a `mockMode` option (or honour `VALIDATOR_SHIFT_E2E_MOCK=1`) in
   `packages/agent/src/solana/cli.ts` so each Solana subcommand returns
   canned output instead of spawning the binary.
2. In `packages/agent/src/commands/agent.ts`:
   - skip / auto-resolve `confirmSAS()` when the env flag is set
     (inquirer would otherwise block the test forever);
   - have `getValidatorInfo()` return a stub `{ identityPubkey, isVoting,
     isCaughtUp, voteAccount }` in mock mode so preflight + step 8 pass.
3. Re-run with `E2E_FORCE_MOCK=1 npx tsx e2e/run.ts`.

### Future work — rollback test

Once the mock layer exists, add a sibling script (`e2e/run-rollback.ts`)
that injects a deterministic failure at step 6 (target `set-identity`)
and asserts the dashboard observes `MIGRATING → ROLLBACK → FAILED`,
plus that the source's `set-identity` was reissued with the staked
keypair. The plumbing in `run.ts` (hub bootstrap, dashboard observer,
agent spawn) is reusable as-is.

## Files

- `run.ts` — the harness itself
- `fake-source-keypair.json` *(generated on first run)*
- `fake-target-keypair.json` *(generated on first run)*
- `fake-ledger/` *(generated on first run)*

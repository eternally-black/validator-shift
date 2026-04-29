# Handoff — Windows-side Claude Code (coordinator role)

Read this end-to-end. You are the **third** Windows-side Claude Code instance for this project. The previous one ran out of context mid-debugging Phase E. The user is **Valera** (`eternally-black` on GitHub, `eternally.black.ai@gmail.com`), Russian-speaking, prefers terse responses and pasteable command blocks. Don't over-explain.

---

## 1. Project at a glance

**ValidatorShift** — off-chain TypeScript tool that securely migrates a Solana validator's staked identity between two servers. Three packages + shared:

- `packages/agent` — Node CLI (`validator-shift agent --role source|target`). Runs on each validator host. Calls `solana-validator` subcommands.
- `packages/hub` — Fastify + WebSocket server. Pairs source/target agents via session code, relays encrypted payloads (NEVER decrypts), drives migration state machine.
- `packages/web` — Next.js 15 wizard + live migration view.
- `packages/shared` — zod-typed WS protocol, MigrationState enum, redactSecrets, base58.

**Working name:** ValidatorShift. **DEPRECATED & forbidden in code/copy:** `SolShift`, `solshift.app`, `YMprobot/solshift` (legacy from `SOLSHIFT_Architecture.md` section 14). The architecture md filename itself stays.

**Repo:** `Eternally-black/validator-shift` (private GitHub). Coordinator (you) is on the Windows-side and does git push to main from `c:/Users/Valera/Desktop/Solana Validator/`. Auto-deploy from main → Railway.

---

## 2. What's deployed (live)

| Service | URL | Container | Notes |
|---|---|---|---|
| Hub | https://hub-production-88a0.up.railway.app | Railway, `Dockerfile.hub` | Single port (3001). HTTP API + WebSocket `@fastify/websocket`. SQLite at `/app/data/hub.db` on Railway named volume `validator-shift-hub-data`. Runs `npx tsx packages/hub/src/index.ts` (NOT compiled — see §6). Has `su-exec` chown init for volume perms. |
| Web | https://web-production-797fb.up.railway.app | Railway, `Dockerfile.web` | Next.js 15 standalone. `NEXT_PUBLIC_HUB_URL=https://hub-production-88a0.up.railway.app` injected via Docker `ARG` at build time (must — Next.js inlines NEXT_PUBLIC_*). |

Auto-deploy: every `git push origin main` rebuilds the changed service via Railway's GitHub integration. ~2-3 min per service rebuild.

Background watcher running in this conversation (`bs47oidq0`) — pings both URLs every 15s. You'll see notifications if anything goes red. Kill it if it's noisy: `KillShell bs47oidq0`.

---

## 3. Local 2-node localnet (Phase D state — DONE)

| Host | Tailscale IP | Role | Identity pubkey | Vote pubkey |
|---|---|---|---|---|
| PC (Win + WSL2 Ubuntu) | `100.109.146.80` | source (validator #1, bootstrap, staked) | `3bhqcx44qBrpNXoC2j33hLWEy2Tdp8rjzBsiD5QDSZhq` | `3hQmQxCB4g6MCZkwAZhC6Rias3BUv1A5vDQseULoTjHh` |
| Laptop (Win + WSL2 Ubuntu) | `100.119.10.14` | target (validator #2, joining, unstaked) | `5WtS2nyLxp6FaYFNkSMKQCKG9Sb4orWpWvUqdDMPYDe1` | (uses PC's vote pubkey for post-migration) |

Both run `agave-validator 2.3.13` (NOT v3.x — see §4). Cluster genesis hash: `BFUVMdb4HWbSRvezRqYvcyQJzsFh76fvFFoNPUUYDxwJ`. `shred_version=36548`. RPC at `:8899`, gossip at `:8001-8020`. Linked by Tailscale mesh (UDP gossip works across NAT). PC bootstrap uses `--full-rpc-api`; laptop joined with `--vote-account ~/validator/vote-account.json` (copy of PC's) and **without `--no-voting`** so it can vote post-migration.

Scripts that brought this up:
- `scripts/setup-wsl.sh` — base provisioning (Node + Claude Code + XFCE+xrdp).
- `scripts/setup-wsl-2.sh` — gh + project clone + memory mirror.
- `scripts/setup-laptop.sh` — single-shot for laptop (everything end-to-end including Solana CLI v2.3.13 + Tailscale).

genesis.bin shared between PC and laptop via `python3 -m http.server 8000 --bind 100.109.146.80 --directory ~/ledger`.

---

## 4. CRITICAL solana-cli version constraint

**Anza dropped `agave-validator` (production validator binary) from prebuilt tarballs as of v3.0.0** (official policy, see [docs.anza.xyz/cli/install#build-from-source](https://docs.anza.xyz/cli/install#build-from-source)). Stable channel from `release.anza.xyz/stable/install` ships `solana`/`solana-keygen`/`solana-test-validator` etc. but NOT `agave-validator` / `solana-validator` / `solana-genesis` / `solana-gossip`.

**v2.3.13 is the last release with the production validator binary.** We pin to it on both hosts:
```
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"
```

In v2.3.13, the binary is `agave-validator` (renamed from `solana-validator` in v1.18). On v2.3.13 there is **no symlink** named `solana-validator`. Our `packages/agent/src/solana/validator.ts::runSolanaValidator()` calls `agave-validator` directly. Don't change that without checking the user's environment first.

For real testnet/mainnet (Phase F if it ever comes), validator must be built from source. We're not there.

---

## 5. WebSocket protocol — what hub actually sends today

Listed in `packages/shared/src/protocol.ts`. After Phase E gap-fixes:

| Message | Sender | Implemented? | Notes |
|---|---|---|---|
| `agent:hello` | agent | ✅ | role + sessionCode + publicKey |
| `agent:sas_confirmed` | agent | ✅ | after operator confirmation |
| `agent:preflight_result` | agent | ✅ | array of PreflightCheck |
| `agent:step_complete` | agent | ✅ | step + StepResult |
| `agent:step_failed` | agent | ✅ | triggers rollback (step ≥ 2) |
| `agent:encrypted_payload` | agent | ✅ | hub relays opaque (NEVER decrypts) |
| `agent:log` | agent | ✅ | hub-side `redactSecrets` before broadcast |
| `hub:peer_connected` | hub | ✅ FIX in `1c480bf` | sent when both agents have hello'd |
| `hub:verify_sas` | hub | ❌ NOT IMPLEMENTED | wizard would show SAS — would need broadcast from orchestrator |
| `hub:run_preflight` | hub | ✅ FIX in `1c480bf` | sent on PAIRING→PREFLIGHT transition |
| `hub:execute_step` | hub | ✅ | sent to executor — and to BOTH on steps 4/5 (FIX in `9c9bf4e`) |
| `hub:rollback` | hub | ✅ | broadcast to both on failed step ≥ 2 |
| `hub:relay_payload` | hub | ✅ | source's encrypted_payload → target verbatim |
| `hub:session_cancelled` | hub | ✅ | on `cancel()` |
| `dashboard:state_change` | hub | ✅ | broadcast on every transition |
| `dashboard:agents_status` | hub | ✅ | snapshot on dashboard connect |
| `dashboard:preflight_update` | hub | ❌ MISSING | orchestrator gets per-role results but doesn't broadcast checks to dashboard |
| `dashboard:step_progress` | hub | ✅ | running on execute_step, complete via state |
| `dashboard:log` | hub | ✅ | redacted-on-hub-side |
| `dashboard:migration_complete` | hub | ✅ | with summary |
| `dashboard:start_migration` | wizard | ✅ | wizard Step 3 click |
| `dashboard:abort` | wizard | ✅ | AbortButton |
| `dashboard:confirm_sas` | wizard | ✅ but useless | wizard never had SAS to confirm — see §7 |

---

## 6. Hub deployment quirks (DO NOT undo)

- `Dockerfile.hub` runs `npx tsx packages/hub/src/index.ts` instead of `tsc → node dist/`. Reason: tsc without `rootDir` (we removed it in Audit 5 because path-aliased monorepo) emits to `dist/hub/src/index.js`, AND the workspace's `@validator-shift/shared` package.json points main at `./src/index.ts` so Node's ESM loader can't resolve it post-build. Running tsx in prod sidesteps both. `tsx` was moved from `devDependencies` to `dependencies` in `packages/hub/package.json`.
- `EntryPoint = /sbin/tini -- sh -c "chown -R nodejs:nodejs /app/data && exec su-exec nodejs npx tsx packages/hub/src/index.ts"`. Init runs as root because Railway/compose volumes mount as root, then drops privs. Don't add `USER nodejs` back at the top.
- `Dockerfile.web` — `ARG NEXT_PUBLIC_HUB_URL` + `ENV NEXT_PUBLIC_HUB_URL=$ARG` in BUILD stage (commit `14338c9`). Without this Next.js inlines empty string into the client bundle and the wizard 404s on `POST /api/sessions`.
- BuildKit `--mount=type=cache` mounts removed (commit `0c6bf0e`). Railway requires `s/<cacheKey>` prefix on id; not worth the friction.
- Docker `VOLUME` directive removed (Railway rejects it).

---

## 7. Phase E status — IN PROGRESS, current bug iteration

**End-to-end migration through wizard.** Goal: source PC → target laptop migration completes successfully (state reaches COMPLETE), source's keypair securely wiped, target voting under PC's staked identity.

**What works:**
- Pairing (X25519 key exchange, SAS via NATO 3-word).
- Operator confirms SAS in BOTH terminals (PC `y`, laptop `y`). Wizard auto-advances Step 2 → Step 3 (commit `51a5748`) since SAS card never renders (wizard SAS broadcast is the unimplemented `hub:verify_sas` — §5).
- Wizard auto-allows Start Migration on AWAITING_WINDOW (Step 3 fix, same commit).
- Steps 1-5 execute on source (with `VS_SKIP_WAIT_WINDOW=1` env var because single-staked-validator localnet is leader every slot and `wait-for-restart-window` never returns — commit `99419fc`).
- Step 2 set-identity to unstaked tmp keypair WITHOUT `--require-tower` (commit `faf6971` — fresh unstaked has no tower).
- Hub now broadcasts execute_step:4 and :5 to BOTH agents (commit `9c9bf4e`).
- Pending payload now a queue with kind-matching consumer (commit `4ee9060`) — fixes step 4/5 race where both async handlers grabbed the wrong envelope.

**Last test result (before user paused for handoff):** Steps 1-5 completed on source, but on target step 5 grabbed the tower payload (wrong) and threw, then step 4 grabbed identity (wrong) → step 6 had no staked path → rollback. Commit `4ee9060` should fix it; **NOT YET TESTED** post-deploy.

**Immediate next action when user says "проверим":**
1. Confirm PC validator restored to staked identity (last attempt left it unstaked):
   ```bash
   # On PC interactive Ubuntu shell:
   solana-validator -l ~/ledger set-identity --require-tower ~/validator/identity.json
   solana-validator -l ~/ledger authorized-voter add ~/validator/vote-account.json
   solana --url http://localhost:8899 validators
   # Expect: 3bhqcx44q... delinquent=false, lastVote growing
   ```
   ⚠ NOTE: on Windows-WSL, command is `agave-validator`, NOT `solana-validator`. The user has been running both in his terminals successfully via prior validator setup but you should verify which one is in PATH (`which agave-validator solana-validator`).
2. `cd ~/validator-shift && git pull` on **both** PC and laptop (last fix is in agent code, both need it).
3. Hard-refresh wizard (`Ctrl+Shift+R` on `/migrate`).
4. Step 1 → enter the three values below → Continue → new session code.
5. Run agents in interactive Ubuntu terminals (NOT through `wsl.exe -- bash -lc` — inquirer needs TTY):

   **PC source** (note `VS_SKIP_WAIT_WINDOW=1`):
   ```bash
   cd ~/validator-shift
   VS_SKIP_WAIT_WINDOW=1 npx tsx packages/agent/src/bin.ts agent \
     --role source \
     --session <NEW_CODE> \
     --hub https://hub-production-88a0.up.railway.app \
     --ledger /home/valera/ledger \
     --keypair /home/valera/validator/identity.json \
     --identity-pubkey 3bhqcx44qBrpNXoC2j33hLWEy2Tdp8rjzBsiD5QDSZhq
   ```

   **Laptop target**:
   ```bash
   cd ~/validator-shift
   npx tsx packages/agent/src/bin.ts agent \
     --role target \
     --session <NEW_CODE> \
     --hub https://hub-production-88a0.up.railway.app \
     --ledger /home/valera/ledger
   ```
6. SAS appears in both terminals. User compares (3 NATO words) and answers `y` in both. NOT in wizard — wizard auto-advances on state change.
7. Each `confirmDestructive` prompt on PC (steps 2, 6 on target, 9 on source): user types `y`. Source has steps 2 and 9; target has step 6. 5 confirmations total in this single test (steps 2, 6, 8 voting_confirmed envelope, 9 — actually 2 on source + 6 on target + 9 on source = 3 confirms).
8. After step 9 source-side wipes `~/validator/identity.json`. ⚠ On localnet that's fine; user can regenerate. **Don't run this on a real validator without operator's explicit confirmation.**

**Wizard form Step 1 values for the user** (paste these):
- Ledger path: `/home/valera/ledger`
- Keypair path: `/home/valera/validator/identity.json`
- Hub URL: `https://hub-production-88a0.up.railway.app`

**If step 6 on target fails** with anything other than what we've already fixed — likely candidates:
- Tower file pubkey mismatch (target tries to set staked identity but tower file in ledger is for source's pubkey, which is the same actually since source migrates **its** identity to target).
- vote-account on laptop not synced — re-copy `~/validator/vote-account.json` from PC over Tailscale.
- target validator wasn't running with `--vote-account` from start (Phase D fix already applied — see §3).

---

## 8. Known unfixed gaps (don't break sweat over them today, but document them)

1. **`hub:verify_sas` not implemented** — wizard SAS card never renders, operator can only compare SAS on 2 terminals (not 3). Low priority for a real-world security audit (operator sees SAS in both terminals); for spec compliance, orchestrator would need to broadcast SAS to dashboard. SAS is derived from shared secret which only agents have.
2. **`dashboard:preflight_update` not broadcast** — orchestrator collects results but only the aggregate state_change to AWAITING_WINDOW reaches dashboard. Wizard Step 3 shows "Awaiting checks…" forever; it's been patched to enable Start Migration on AWAITING_WINDOW state instead.
3. **Wizard local state lost on F5** — `useState`-based current step. Refresh during an active session means user fills Step 1 again, gets a NEW session code, old sessions's agents are orphaned. No `?session=...` URL recovery. Annoying when debugging.
4. **agent's preflight 'caught up' check uses default RPC** — `solana gossip --output json` without `--url`, fails unless user has `solana config set --url localhost:8899` first. We told the user to do this on both hosts. If a future iteration fails preflight — verify config first.
5. **agent's `getValidatorInfo` on target falls back to `solana address`** when `--identity-pubkey` not given. Returns CLI default keypair, not running validator's identity.
6. **Real rollback flow not implemented** — orchestrator emits `hub:rollback` but agent's `executeStep` `default:` arm returns `unknown step ${step}; no-op`. So after a failure, neither side actually undoes anything; user manually runs `set-identity` to recover (we did this between attempts).
7. **`--require-tower` on step 6** — target setIdentity uses requireTower=true (default). Tower file was just transferred in step 4, so it should be there. Untested end-to-end.
8. **Step 7 `addAuthorizedVoter`** — runs `agave-validator -l <ledger> authorized-voter add <staked-keypair>`. Requires laptop's running validator to accept admin RPC commands. Untested.
9. **Step 8 `getValidatorInfo` voting check** — target queries its local validator. After set-identity (step 6) the agent calls `getValidatorInfo(sourcePk)` to check `isVoting`. Validator may not pick up the new identity instantly; we may need a poll loop with timeout (currently single shot).
10. **agent's `--require-tower` only on default-true** — `setIdentity(opts.ledger, stakedPath)` on step 6 = require-tower=true. If target tower was only just written and validator hasn't ingested it, command may fail. May need explicit retry.

If user reports a bug at step N, look at `packages/agent/src/commands/agent.ts` `case N:` block first.

---

## 9. Files for future-you to actually read (not just skim)

In rough priority order:

1. `packages/agent/src/commands/agent.ts` — heart of the migration logic (~660 lines). Every step handler is here. The `client.on('hub:relay_payload', ...)` async handler is at line ~230. The execute_step dispatcher at ~258. The 9-step switch at ~475.
2. `packages/hub/src/orchestrator/state-machine.ts` — `MigrationOrchestrator` class. Transitions, events emitted, sas_confirmed counting, step_complete idempotency.
3. `packages/hub/src/session-manager.ts::wireOrchestrator` — what the orchestrator's events translate into for agents and dashboards. Recent changes here (`hub:run_preflight`, broadcast steps 4/5).
4. `packages/hub/src/ws/handler.ts` — agent + dashboard WS connection lifecycles. agent:hello peer-connected fan-out at line ~200.
5. `packages/web/components/wizard/Step2Connect.tsx` and `Step3Preflight.tsx` — the auto-advance hacks. Don't over-engineer them; they're glue until SAS broadcast is real.
6. `packages/shared/src/protocol.ts` — zod schemas. Single source of truth for protocol shape.
7. `SOLSHIFT_Architecture.md` — original spec. The branding sections (1, 14) are deprecated. Sections 3 (security model), 4 (state machine + 9-step migration), 8 (WS protocol), 10 (edge cases) are the contract.
8. `SPEC.md` (in repo root, committed) — older auto-generated spec, ignore in favor of this handoff.

Recent commit history (last ~15) tells the story:
```
4ee9060 fix(agent): pending payload as kind-matched queue, not single slot
9c9bf4e fix(hub): broadcast execute_step to both agents on bilateral relays (4, 5)
faf6971 fix(agent): drop --require-tower on step 2 set-identity (unstaked has no tower)
99419fc feat(agent): VS_SKIP_WAIT_WINDOW env escape hatch for single-validator localnet
51a5748 fix(web): wizard auto-advances on orchestrator state changes
1c480bf fix(hub): send hub:peer_connected + hub:run_preflight (Wave 1 H3 gap)
2d372f3 fix(web): accept http(s):// in hub URL field (single-port hub)
14338c9 fix(web): pass NEXT_PUBLIC_HUB_URL into build stage as ARG
9d10b03 chore: add scripts/setup-laptop.sh
ab05f29 chore: add scripts/setup-wsl-2.sh
89e976a chore: add scripts/setup-wsl.sh
```

---

## 10. Communication topology

You coordinate **3 humans/agents**:
1. **Valera** — the human user, in Russian, in this Claude Code chat (your stdin).
2. **PC-WSL-CC** — Claude Code running natively in WSL2 Ubuntu on Valera's PC. Project at `~/validator-shift`. Has its own context with project memory. Does Phase D bootstrap, validator restarts, and runs source-role agent in interactive terminal.
3. **Laptop instance** — Valera reported that on the laptop he runs Claude Code on **Windows-side** with UNC path into WSL filesystem, and gates all WSL commands through `wsl.exe -d Ubuntu -- ...`. Functionally equivalent to PC-WSL-CC but slightly more clunky.

You don't talk to PC-CC or laptop-CC directly — you give Valera bash blocks to paste into the right terminal. Identify the host explicitly each time ("на PC" / "на laptop" / "interactive WSL terminal" / "wsl.exe из Windows").

---

## 11. User preferences (saved memories from prior sessions)

- **GitHub:** `Eternally-black/validator-shift`. NOT `YMprobot`.
- **Working name:** ValidatorShift. NEVER use `SolShift`/`solshift.app`/`solshift-agent`.
- **Git config:** `claude@anthropic.com` / `Claude` for commits in this repo.
- Settings.local.json has `defaultMode: bypassPermissions`.
- The whole `.claude/` is gitignored.
- User wants terse responses for repeated patterns (paste-blocks). For investigations / decisions, more detail OK.
- User explicitly said "не так сильно экономь" — don't over-truncate when complex stuff is at stake.
- Prefer `agave-install init <version>` over generic stable-channel installs (Anza dropped agave-validator from stable).

---

## 12. First message you should send to Valera

Once you start: greet briefly, confirm you've read this handoff, ask whether he wants to resume Phase E migration test (the `4ee9060` agent fix is pushed but never tested with a fresh session). Don't repeat all the context above — he lived through it. Confirm the PC validator state and laptop validator state, then proceed. He'll paste a new session code.

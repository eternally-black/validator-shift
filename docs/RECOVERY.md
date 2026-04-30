# Recovery runbook

When a ValidatorShift migration fails midway, the operator is left with a running validator (or two) in some intermediate state. This runbook tells you exactly what to do for every failure point in the 9-step migration. Each row of the matrix below corresponds to a step handler in [`packages/agent/src/commands/agent.ts`](../packages/agent/src/commands/agent.ts) and to a transition in [`packages/hub/src/orchestrator/state-machine.ts`](../packages/hub/src/orchestrator/state-machine.ts).

> **Scope.** This document covers manual operator recovery. The Hub's automatic rollback (see [`packages/hub/src/orchestrator/rollback.ts`](../packages/hub/src/orchestrator/rollback.ts)) emits the right *intent* for steps 2 and later, but the agent's `executeStep` switch returns `unknown step ${step}; no-op` on rollback opcodes today (handoff §8 item 6). Treat the procedures below as the source of truth until the rollback executor is implemented end-to-end.

---

## Critical: dual-identity risk window

**Steps 5 through 8 are the window during which both source and target may simultaneously hold the staked keypair.** Step 5 transfers the keypair to target; step 6 activates it on target; step 8 verifies target is voting; step 9 wipes the keypair on source. Until step 9 completes, the staked private key exists on **two** machines.

If a network partition or Hub outage occurs between steps 5 and 9:

1. **Do NOT restart either validator.** A restart will replay the on-disk identity, and on the target that is now the staked identity. If both validators come back up with the staked keypair, you risk dual-signing — exactly the failure ValidatorShift exists to prevent.
2. **Do NOT run `set-identity` on either host yet.** First determine which validator the cluster currently believes is voting (instructions below).
3. **From a third host** (a workstation, a monitoring box, anything with `solana` CLI and an RPC endpoint), determine ground truth before touching either validator.
4. The validator that is **not** currently voting — and whose `lastVote` is stale — secure-wipes its copy of the staked keypair. The validator that **is** voting keeps its keypair and continues operating.
5. Only after the dual-identity condition is resolved do you proceed with manual recovery from the table below.

If you cannot determine which validator is voting (e.g. the cluster itself is partitioned from your viewpoint), shut down the validator you trust *less* (typically the target, which has been running shorter) by stopping its `agave-validator` process — but **do not** wipe its keypair yet. Wait until cluster visibility is restored, then re-evaluate.

---

## Verifying validator state from a third host

Use a host that is **not** either of the two migration validators. From there:

```bash
solana --url https://api.testnet.solana.com validators --output json \
  | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>")'
```

Replace `<STAKED_PUBKEY>` with the base58 staked identity. The fields that matter:

- **`delinquent`** — `true` means the cluster has not seen a vote from this identity in the last few slots. A freshly deactivated source goes delinquent within ~30 seconds.
- **`lastVote`** — the most recent slot this identity voted on. Watch it for 30–60 seconds: if it advances, the validator is alive. If it freezes, the validator is silent.
- **`rootSlot`** — the slot up through which the validator has rooted its fork. Must advance for the validator to be participating in consensus, not just observing.

A healthy, voting validator: `delinquent=false`, `lastVote` advancing, `rootSlot` advancing.
A silent validator (the desired post-migration source state): `delinquent=true` or absent from the list entirely.
The dangerous case: **both** target *and* source pubkey-equal entries, both with `delinquent=false` and both `lastVote` advancing — this is dual-signing in progress and you must immediately stop one of them.

For mainnet substitute `--url https://api.mainnet-beta.solana.com`. For your own RPC, substitute the appropriate URL.

---

## Recovery matrix

The matrix has 11 rows: one per migration step (1–9) plus the two non-step failure modes (operator abort and connection loss). For each, the source and target columns describe the state at the moment of failure, and the **Recovery** column gives the exact commands to run.

> **Command convention.** All commands assume `agave-validator` is in `$PATH` (Solana v2.3.13+; on older toolchains the binary was named `solana-validator`). `<LEDGER>` is the validator's ledger directory (e.g. `/home/sol/ledger`). `<STAKED_KEYPAIR>` is the path to the original staked identity keypair. `<UNSTAKED_KEYPAIR>` is any unstaked keypair (e.g. a freshly generated one from `solana-keygen new -o /tmp/unstaked.json --no-bip39-passphrase`).

### Failure at step 1: `wait_for_restart_window`

- **Source state:** still running with staked identity. No mutations yet.
- **Target state:** unchanged.
- **What happened:** the wait-for-restart-window CLI returned an error or the timeout expired. The validator never stopped voting.
- **Recovery:** none required. The validator is in its original state. Investigate the underlying error (RPC unreachable, validator process crashed, ledger locked) and re-run the migration.

```bash
# On source — verify still voting normally:
solana --url http://localhost:8899 validators --output json \
  | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>")'
# Expect: delinquent=false, lastVote advancing.
```

### Failure at step 2: `set_unstaked_identity_source`

- **Source state:** unknown — the `set-identity` call may have succeeded partially, or the operator may have declined the destructive prompt. Validator may now be running unstaked.
- **Target state:** unchanged.
- **Recovery:** restore the staked identity on source.

```bash
# On source:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>

# Verify (from a third host):
solana --url <CLUSTER_RPC> validators --output json \
  | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>")'
```

If `set-identity --require-tower` fails because the tower file was rotated or removed, drop the flag (`agave-validator -l <LEDGER> set-identity <STAKED_KEYPAIR>`) — accept the brief lockout-violation risk and resume normal voting.

### Failure at step 3: `remove_authorized_voters_source`

- **Source state:** unstaked identity active, but authorized-voter removal may have succeeded or partially completed. Source is not voting.
- **Target state:** unchanged.
- **Recovery:** restore staked identity, then re-add the authorized voter.

```bash
# On source:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>
```

Verify voting resumes (see "Verifying validator state from a third host" above).

### Failure at step 4: `transfer_tower_file`

- **Source state:** unstaked identity active, no authorized voters, not voting.
- **Target state:** may have a partial tower file written to its ledger (or none).
- **Recovery:** remove any partial tower file from target, then restore source.

```bash
# On target — remove any tower file that was written:
rm -f <LEDGER>/tower-1_9-*.bin

# On source — restore staked identity:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>
```

The source's own tower file in its ledger is untouched — step 4 only *reads* it from source. Source's tower remains valid.

### Failure at step 5: `transfer_identity_keypair`

- **Source state:** unstaked, voters removed, not voting. Source's staked keypair file still on disk.
- **Target state:** tower file is on target; staked keypair may or may not have been received and written to a temp file under `$TMPDIR`.
- **Recovery:** **dual-identity risk window has begun.** Wipe target's temp keypair before restoring source.

```bash
# On target — securely remove any temp staked keypair:
find /tmp -maxdepth 1 -name 'staked-*.json' -print -exec shred -u {} \;
rm -f <LEDGER>/tower-1_9-*.bin

# On source — restore staked identity:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>
```

If the agent process on target crashed before cleanup hooks ran, the temp keypair may persist after reboot — `shred -u` it explicitly. Verify source is voting again before declaring recovery complete.

### Failure at step 6: `set_staked_identity_target`

- **Source state:** unstaked, voters removed, not voting. Staked keypair file still on disk.
- **Target state:** has the staked keypair in `$TMPDIR/staked-*.json` and the tower file in its ledger. The `set-identity` call may have succeeded (target is now running staked) or failed mid-way.
- **Recovery:** this is the highest-risk failure. Determine target state from a third host before touching either validator.

```bash
# From a third host — check what each pubkey is doing:
solana --url <CLUSTER_RPC> validators --output json \
  | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>")'
```

**Case A: target is voting under the staked identity.** The migration effectively succeeded for activation. Continue manually with steps 7–9 (re-add voter on target, verify, wipe source) — see procedures for steps 7, 8, 9 below.

**Case B: target is NOT voting under the staked identity.** Target's `set-identity` call did not take effect. Restore source.

```bash
# On target — clean up:
agave-validator -l <LEDGER> set-identity <UNSTAKED_KEYPAIR>
find /tmp -maxdepth 1 -name 'staked-*.json' -print -exec shred -u {} \;
rm -f <LEDGER>/tower-1_9-*.bin

# On source — restore:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>
```

### Failure at step 7: `add_authorized_voter_target`

- **Source state:** unstaked, voters removed, not voting. Staked keypair still on disk.
- **Target state:** running with staked identity but `authorized-voter add` failed — target is not yet voting.
- **Recovery:** retry the voter add on target. If it persistently fails, abort migration and restore source.

```bash
# On target — retry:
agave-validator -l <LEDGER> authorized-voter add /tmp/staked-XXXX.json

# If retry fails — abort:
agave-validator -l <LEDGER> set-identity <UNSTAKED_KEYPAIR>
find /tmp -maxdepth 1 -name 'staked-*.json' -print -exec shred -u {} \;
rm -f <LEDGER>/tower-1_9-*.bin

# On source — restore:
agave-validator -l <LEDGER> set-identity --require-tower <STAKED_KEYPAIR>
agave-validator -l <LEDGER> authorized-voter add <STAKED_KEYPAIR>
```

### Failure at step 8: `verify_target_voting`

- **Source state:** unstaked, voters removed, not voting. Staked keypair still on disk.
- **Target state:** running with staked identity, voter added, but `getValidatorInfo` did not yet observe `isVoting=true`. Target may simply need more time, or may be misconfigured.
- **Recovery:** poll voting status manually. If target becomes visible voting within ~5 minutes, complete the migration manually (step 9 wipe). If not, abort.

```bash
# From a third host — poll for 5 minutes:
for i in {1..30}; do
  solana --url <CLUSTER_RPC> validators --output json \
    | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>") | {delinquent, lastVote, rootSlot}'
  sleep 10
done
```

If `lastVote` advances and `delinquent=false`, the migration succeeded — proceed to manual step 9 wipe (see the step 9 row). If `delinquent=true` or pubkey absent for the full 5 minutes, abort using the step 7 abort sequence above.

### Failure at step 9: `wipe_source_keypair`

- **Source state:** unstaked, voters removed, not voting. Staked keypair file still on disk (wipe failed).
- **Target state:** running with staked identity, voting normally.
- **Recovery:** the migration succeeded; only the cleanup step failed. Manually wipe the source keypair.

```bash
# On source — securely wipe:
shred -u <STAKED_KEYPAIR>

# Verify file is gone:
ls -la <STAKED_KEYPAIR> 2>&1 | grep -q 'No such file' && echo OK
```

If `shred` is unavailable (e.g. on macOS), use `dd if=/dev/urandom of=<STAKED_KEYPAIR> bs=4k count=1 conv=notrunc && rm -f <STAKED_KEYPAIR>`. Note storage-layer caveats in [docs/THREAT_MODEL.md](./THREAT_MODEL.md) — for high-value identities, plan an identity rotation post-migration regardless.

### Failure: operator abort (any state)

- **Source / target state:** depends on which step was active when the operator hit Abort.
- **Recovery:** identify the most recently completed step from the wizard log, then follow the recovery row for the *next* step (the one that was in flight when abort fired). If the abort fired during AWAITING_WINDOW (before step 1), no recovery is needed.

### Failure: connection loss during MIGRATING

- **Source / target state:** depends on `currentStep` at the moment of disconnect.
- **Recovery:** the orchestrator's `onAgentDisconnected` handler (see [`state-machine.ts`](../packages/hub/src/orchestrator/state-machine.ts)) handles the partition between safe disconnects (source before step 5 → automatic rollback signal emitted) and dangerous ones (target after step 5 → `critical_alert` emitted, no automatic action). For the dangerous case:

  1. Read "Critical: dual-identity risk window" at the top of this document.
  2. From a third host, determine which validator is voting.
  3. Apply the recovery row for the step that was active at disconnect.

If the Hub itself crashed (rather than an agent connection), both agents enter SAFE mode and stop issuing commands. Re-pair when Hub is healthy and continue from the appropriate row above.

---

## Sanity checks after any recovery

After any recovery procedure, confirm from a third host:

```bash
solana --url <CLUSTER_RPC> validators --output json \
  | jq '[.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>")] | length'
# Expect: 1 (exactly one validator advertising this identity).

solana --url <CLUSTER_RPC> validators --output json \
  | jq '.validators[] | select(.identityPubkey == "<STAKED_PUBKEY>") | .delinquent'
# Expect: false (validator is voting).
```

If the count is `0`, no validator is voting — investigate before doing anything else. If the count is `2` or more, dual-identity is active — stop one of them immediately.

---

## Unresolved cases

If your situation does not match any row above, or if the recovery commands fail in an unexpected way, file an issue at <https://github.com/eternally-black/validator-shift/issues> with:

- The wizard's session code and the timestamp of the failure.
- The last `agent:step_complete` and `agent:step_failed` log lines from both agents.
- The output of `solana validators` from a third host.

Do **not** include the staked keypair, the tower file contents, or any other private material in a public issue.

See also: [README](../README.md) · [docs/THREAT_MODEL.md](./THREAT_MODEL.md) · [docs/SECURITY.md](./SECURITY.md).

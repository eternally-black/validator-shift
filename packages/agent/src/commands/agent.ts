import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import nacl from 'tweetnacl'
import { nanoid } from 'nanoid'

import type { AgentRole, PreflightCheck, StepResult } from '@validator-shift/shared'
import { MIGRATION_STEPS } from '@validator-shift/shared/constants'

import { runSolanaCli, SolanaCliError } from '../solana/cli.js'
import {
  waitForRestartWindow,
  setIdentity,
  addAuthorizedVoter,
  removeAllAuthorizedVoters,
  getValidatorInfo,
} from '../solana/validator.js'
import {
  readKeypair,
  writeKeypair,
  secureWipe,
  derivePubkey,
} from '../solana/keypair.js'
import { generateKeyPair, deriveSharedSecret, deriveSessionKey } from '../crypto/exchange.js'
import {
  encrypt,
  decrypt,
  encodePayload,
  decodePayload,
  CryptoError,
} from '../crypto/encrypt.js'
import { deriveSAS } from '../crypto/sas.js'
import { HubClient } from '../transport/ws-client.js'
import {
  printBanner,
  printPreflightTable,
  confirmSAS,
  confirmDestructive,
  printStepProgress,
  printError,
  printLog,
} from '../ui/terminal.js'
import { redactSecrets } from '@validator-shift/shared/redact'

export interface AgentOpts {
  role: AgentRole
  session: string
  hub: string
  ledger: string
  keypair?: string
  unstakedKeypair?: string
  /**
   * Base58 pubkey of the running validator's --identity. Required on source.
   * Avoids relying on `solana address` which returns the operator's default
   * CLI keypair (NOT necessarily the running validator's identity).
   */
  identityPubkey?: string
  /** Pass --skip-new-snapshot-check to wait-for-restart-window. Default: false. */
  skipSnapshotCheck?: boolean
  /** Skip operator confirmation prompts for destructive operations. */
  yes?: boolean
}

interface PendingPayload {
  payload: string
  hash: string
}

const STEP_LABELS: Record<number, string> = Object.fromEntries(
  MIGRATION_STEPS.map(s => [s.number, s.name]),
)

// Window we wait for the source to drop out of voting before activating target.
const SOURCE_QUIET_TIMEOUT_MS = 60_000
// Window source waits for target's voting_confirmed before allowing wipe.
const VOTING_CONFIRMED_TIMEOUT_MS = 60_000

function nowMs(): number {
  return Date.now()
}

function sha256Hex(data: Uint8Array | Buffer): string {
  const h = createHash('sha256')
  h.update(data)
  return h.digest('hex')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function logBoth(client: HubClient, level: 'info' | 'warn' | 'error', message: string): void {
  const safe = redactSecrets(message)
  printLog(level, safe)
  try {
    client.send({ type: 'agent:log', level, message: safe })
  } catch {
    // socket may not be open during error paths; printLog already happened
  }
}

/**
 * Top-level agent entry point invoked by bin.ts.
 */
export async function runAgent(opts: AgentOpts): Promise<void> {
  printBanner()

  // Track temp files we've created so we can secure-wipe on exit.
  const tmpFilesToWipe = new Set<string>()
  installCleanupHooks(tmpFilesToWipe)

  // ----- Pairing: generate ephemeral X25519 keys -----
  const ourKp = generateKeyPair()
  const ourPubB64 = Buffer.from(ourKp.publicKey).toString('base64')

  const client = new HubClient({
    hubUrl: opts.hub,
    sessionCode: opts.session,
    role: opts.role,
    publicKey: ourPubB64,
  })

  // ----- Critical lifecycle handlers -----
  client.on('disconnected_unsafe', () => {
    printError(
      'CRITICAL: connection lost during migration. Manual intervention required. See logs.',
    )
    runCleanup(tmpFilesToWipe)
    process.exit(2)
  })

  client.on('hub:session_cancelled', () => {
    printLog('warn', 'session cancelled by hub')
    try {
      client.close('session_cancelled')
    } catch {
      // ignore
    }
    runCleanup(tmpFilesToWipe)
    process.exit(0)
  })

  client.on('error', (err: unknown) => {
    printLog('error', `transport error: ${redactSecrets(errorMessage(err))}`)
  })

  client.on('protocol_error', (err: unknown) => {
    printLog('error', `protocol error: ${redactSecrets(errorMessage(err))}`)
  })

  client.on('timeout', () => {
    printLog('warn', 'hub heartbeat timeout')
  })

  // ----- State for migration session -----
  let sessionKey: Uint8Array | null = null
  // Queue (not slot) — orchestrator may broadcast execute_step to source and
  // target almost simultaneously for steps 4 and 5, causing both to land in
  // the agent before either is consumed. A single-slot pendingPayload would
  // overwrite the first with the second and the matching step would fail.
  const pendingPayloads: PendingPayload[] = []
  let receivedStakedKeypairPath: string | null = null
  let receivedTowerFilePath: string | null = null
  // CR-1: target needs to know source identity pubkey to verify it stops voting.
  // Source already knows it from --identity-pubkey; target learns it from step 5 payload.
  let sourceIdentityPubkey: string | null =
    opts.role === 'source' ? (opts.identityPubkey ?? null) : null
  // CR-2: source must wait for target to confirm voting before wiping the keypair.
  let peerVotingConfirmed = false

  client.setStage('pairing')
  await client.connect()

  // Wait for peer connection
  const peerPubBytes = await waitForPeer(client)
  const shared = deriveSharedSecret(ourKp.secretKey, peerPubBytes)
  sessionKey = deriveSessionKey(shared, 'validator-shift-session-v1')
  const sas = deriveSAS(shared)

  const confirmed = await confirmSAS(sas)
  if (!confirmed) {
    logBoth(client, 'error', 'SAS mismatch')
    try {
      client.close('sas_mismatch')
    } catch {
      // ignore
    }
    printError('SAS mismatch')
    runCleanup(tmpFilesToWipe)
    process.exit(1)
  }

  client.send({ type: 'agent:sas_confirmed' })
  logBoth(client, 'info', 'SAS confirmed')

  // ----- Preflight -----
  client.setStage('preflight')

  await new Promise<void>(resolve => {
    client.once('hub:run_preflight', () => resolve())
  })

  const checks = await runPreflight(opts)
  printPreflightTable(checks)
  client.send({ type: 'agent:preflight_result', checks })

  // ----- Migrating loop -----
  client.setStage('migrating')

  // Listen for relayed payloads from peer. We peek at the kind to dispatch
  // voting_confirmed envelopes (which never reach the step handler) separately
  // from tower / identity payloads (which do).
  client.on('hub:relay_payload', (msg: { payload: string; hash: string }) => {
    if (sessionKey) {
      try {
        const decoded = decodePayload(msg.payload)
        const plaintext = decrypt(decoded.ciphertext, decoded.nonce, sessionKey)
        const json = new TextDecoder().decode(plaintext)
        const meta = JSON.parse(json) as { kind?: string }
        if (meta?.kind === 'voting_confirmed') {
          peerVotingConfirmed = true
          logBoth(client, 'info', 'peer confirmed voting active')
          return
        }
      } catch {
        // Not a peek-able envelope (e.g. corruption / wrong key) — fall through
        // and let the step handler surface the error when it tries to consume.
      }
    }
    pendingPayloads.push({ payload: msg.payload, hash: msg.hash })
  })

  // Rollback signal — Hub continues to drive execute_step messages for the
  // recovery flow; this is just for logging.
  client.on('hub:rollback', () => {
    logBoth(client, 'warn', 'hub requested rollback')
  })

  // Indefinite loop processing execute_step events.
  await new Promise<void>(resolve => {
    client.on('hub:execute_step', (msg: { step: number }) => {
      const step = msg.step
      const label = STEP_LABELS[step] ?? `step_${step}`
      const startedAt = nowMs()

      void (async () => {
        try {
          printStepProgress(step, label)
          const result = await executeStep(step, opts, client, {
            sessionKey: sessionKey!,
            takePendingOfKind: (expectedKind: string) =>
              takePendingOfKind(pendingPayloads, sessionKey!, expectedKind),
            setReceivedStakedKeypairPath: (p: string) => {
              receivedStakedKeypairPath = p
              tmpFilesToWipe.add(p)
            },
            getReceivedStakedKeypairPath: () => receivedStakedKeypairPath,
            setReceivedTowerFilePath: (p: string) => {
              receivedTowerFilePath = p
            },
            getReceivedTowerFilePath: () => receivedTowerFilePath,
            setSourceIdentityPubkey: (p: string) => {
              sourceIdentityPubkey = p
            },
            getSourceIdentityPubkey: () => sourceIdentityPubkey,
            getPeerVotingConfirmed: () => peerVotingConfirmed,
            registerTmpFile: (p: string) => tmpFilesToWipe.add(p),
            unregisterTmpFile: (p: string) => tmpFilesToWipe.delete(p),
          })

          const stepResult: StepResult = {
            ok: true,
            output: result ? redactSecrets(result) : undefined,
            durationMs: nowMs() - startedAt,
          }
          client.send({ type: 'agent:step_complete', step, result: stepResult })
          logBoth(client, 'info', `step ${step} (${label}) complete`)
        } catch (err) {
          const message = redactSecrets(errorMessage(err))
          logBoth(client, 'error', `step ${step} (${label}) failed: ${message}`)
          try {
            client.send({ type: 'agent:step_failed', step, error: message })
          } catch {
            // ignore
          }
          // Do NOT exit — Hub decides whether to rollback or continue.
        }
      })()
    })

    void resolve
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function runCleanup(tmpFiles: Set<string>): void {
  for (const path of tmpFiles) {
    try {
      // Best-effort secure wipe; fire-and-forget since we may be in a SIGINT path.
      void secureWipe(path).catch(() => {
        /* ignore */
      })
    } catch {
      /* ignore */
    }
  }
  tmpFiles.clear()
}

function installCleanupHooks(tmpFiles: Set<string>): void {
  const handler = (signal: NodeJS.Signals) => {
    runCleanup(tmpFiles)
    // Use signal-conventional exit codes (128 + signum).
    const code = signal === 'SIGINT' ? 130 : 143
    process.exit(code)
  }
  process.once('SIGINT', () => handler('SIGINT'))
  process.once('SIGTERM', () => handler('SIGTERM'))
  process.once('beforeExit', () => runCleanup(tmpFiles))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForPeer(client: HubClient): Promise<Uint8Array> {
  return new Promise<Uint8Array>(resolve => {
    client.once('hub:peer_connected', (msg: { peerPublicKey: string }) => {
      const peerPubBytes = new Uint8Array(Buffer.from(msg.peerPublicKey, 'base64'))
      resolve(peerPubBytes)
    })
  })
}

async function runPreflight(opts: AgentOpts): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []

  try {
    const { stdout } = await runSolanaCli(['--version'])
    checks.push({
      name: 'solana CLI installed',
      ok: true,
      detail: stdout.trim().slice(0, 80),
    })
  } catch (err) {
    checks.push({
      name: 'solana CLI installed',
      ok: false,
      detail: err instanceof SolanaCliError ? err.message : errorMessage(err),
    })
  }

  // validator process running — use explicit identityPubkey when provided.
  try {
    const info = await getValidatorInfo(opts.identityPubkey)
    const ok = !!info.identityPubkey
    checks.push({
      name: 'validator process running',
      ok,
      detail: ok ? `identity=${info.identityPubkey.slice(0, 8)}…` : 'no identity detected',
    })
    checks.push({
      name: 'validator caught up',
      ok: info.isCaughtUp,
      detail: info.isCaughtUp ? undefined : 'not present in gossip',
    })
  } catch (err) {
    checks.push({ name: 'validator process running', ok: false, detail: errorMessage(err) })
    checks.push({
      name: 'validator caught up',
      ok: false,
      detail: 'skipped (validator info unavailable)',
    })
  }

  if (opts.role === 'source') {
    if (opts.keypair) {
      try {
        accessSync(opts.keypair, fsConstants.R_OK)
        checks.push({ name: 'identity keypair accessible', ok: true })
      } catch (err) {
        checks.push({
          name: 'identity keypair accessible',
          ok: false,
          detail: errorMessage(err),
        })
      }
    } else {
      checks.push({
        name: 'identity keypair accessible',
        ok: false,
        detail: '--keypair not provided',
      })
    }

    // Vote-account match — verifies the keypair we have IS the validator's identity
    // by deriving the pubkey and comparing to --identity-pubkey.
    if (opts.keypair && opts.identityPubkey) {
      try {
        const bytes = readKeypair(opts.keypair)
        const derived = derivePubkey(bytes)
        const ok = derived === opts.identityPubkey
        checks.push({
          name: 'keypair matches --identity-pubkey',
          ok,
          detail: ok ? undefined : `keypair=${derived.slice(0, 8)}… vs flag=${opts.identityPubkey.slice(0, 8)}…`,
        })
      } catch (err) {
        checks.push({
          name: 'keypair matches --identity-pubkey',
          ok: false,
          detail: errorMessage(err),
        })
      }
    }
  } else {
    try {
      accessSync(opts.ledger, fsConstants.W_OK)
      checks.push({ name: 'ledger path exists & writable', ok: true })
    } catch (err) {
      checks.push({
        name: 'ledger path exists & writable',
        ok: false,
        detail: errorMessage(err),
      })
    }
  }

  return checks
}

interface StepCtx {
  sessionKey: Uint8Array
  /**
   * Atomically take and remove the first queued payload whose decrypted
   * envelope.kind matches `expectedKind`. Polls for up to 30s. Returns
   * raw {payload, hash} so the caller can independently verify the SHA
   * against pending.hash before persisting.
   */
  takePendingOfKind: (expectedKind: string) => Promise<PendingPayload>
  setReceivedStakedKeypairPath: (p: string) => void
  getReceivedStakedKeypairPath: () => string | null
  setReceivedTowerFilePath: (p: string) => void
  getReceivedTowerFilePath: () => string | null
  setSourceIdentityPubkey: (p: string) => void
  getSourceIdentityPubkey: () => string | null
  getPeerVotingConfirmed: () => boolean
  registerTmpFile: (p: string) => void
  unregisterTmpFile: (p: string) => void
}

async function executeStep(
  step: number,
  opts: AgentOpts,
  client: HubClient,
  ctx: StepCtx,
): Promise<string | undefined> {
  const role = opts.role

  switch (step) {
    case 1: {
      if (role !== 'source') return 'noop (target waits)'
      // Escape hatch for single-staked-validator localnet tests, where the
      // sole voter is leader every slot and `wait-for-restart-window` never
      // observes the required idle gap. Production migrations MUST NOT set
      // this flag — the wait window is the only safe handoff opportunity.
      if (process.env.VS_SKIP_WAIT_WINDOW === '1') {
        return 'restart window skipped via VS_SKIP_WAIT_WINDOW=1 (UNSAFE outside localnet)'
      }
      await waitForRestartWindow(opts.ledger, {
        minIdleTime: 2,
        skipNewSnapshotCheck: opts.skipSnapshotCheck === true,
      })
      return 'restart window reached'
    }

    case 2: {
      if (role !== 'source') return 'noop (target waits)'
      if (!opts.yes) {
        const ok = await confirmDestructive(
          `Set unstaked identity on SOURCE (ledger=${opts.ledger})? Validator will stop signing with the staked identity.`,
        )
        if (!ok) throw new Error('operator declined step 2')
      }
      const unstakedPath = ensureUnstakedKeypair(opts, ctx)
      // requireTower=false: a freshly generated unstaked keypair has no
      // tower file. --require-tower would always fail here.
      await setIdentity(opts.ledger, unstakedPath, { requireTower: false })
      return 'set-identity unstaked'
    }

    case 3: {
      if (role !== 'source') return 'noop (target waits)'
      await removeAllAuthorizedVoters(opts.ledger)
      return 'authorized-voter remove-all'
    }

    case 4: {
      if (role === 'source') {
        if (!opts.keypair) throw new Error('source --keypair required to locate tower file')
        const stakedBytes = readKeypair(opts.keypair)
        const stakedPubkey = derivePubkey(stakedBytes)
        const towerPath = pathJoin(opts.ledger, `tower-1_9-${stakedPubkey}.bin`)
        if (!existsSync(towerPath)) {
          let found: string | null = null
          try {
            const entries = readdirSync(opts.ledger)
            const match = entries.find(f => /^tower-1_9-.*\.bin$/.test(f))
            if (match) found = pathJoin(opts.ledger, match)
          } catch {
            // ignore
          }
          if (!found) throw new Error(`tower file not found at ${towerPath}`)
          return await sendTowerFile(client, ctx, found, stakedPubkey)
        }
        return await sendTowerFile(client, ctx, towerPath, stakedPubkey)
      } else {
        const pending = await ctx.takePendingOfKind('tower')
        const decryptedJson = decryptPending(pending, ctx.sessionKey)
        const meta = JSON.parse(decryptedJson) as {
          kind: 'tower'
          filename: string
          contentB64: string
        }
        const fileBytes = Buffer.from(meta.contentB64, 'base64')
        const dest = pathJoin(opts.ledger, meta.filename)
        const expectedHash = sha256Hex(fileBytes)
        if (expectedHash !== pending.hash) {
          throw new Error(
            `tower hash mismatch: expected=${expectedHash} got=${pending.hash}`,
          )
        }
        // H-2: write + fsync, then read-back and re-verify hash on disk.
        const fd = openSync(dest, 'w', 0o600)
        try {
          writeFileSync(fd, fileBytes)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        const onDisk = readFileSync(dest)
        const onDiskHash = sha256Hex(onDisk)
        if (onDiskHash !== expectedHash) {
          throw new Error(
            `tower file corrupted on disk: expected=${expectedHash} read=${onDiskHash}`,
          )
        }
        ctx.setReceivedTowerFilePath(dest)
        return `tower written to ${dest}`
      }
    }

    case 5: {
      if (role === 'source') {
        if (!opts.keypair) throw new Error('source --keypair required for step 5')
        const stakedBytes = readKeypair(opts.keypair)
        const stakedPubkey = derivePubkey(stakedBytes)
        const meta = JSON.stringify({
          kind: 'identity',
          pubkey: stakedPubkey,
          secretKeyBytes: Array.from(stakedBytes.values()),
        })
        const plaintext = new TextEncoder().encode(meta)
        const enc = encrypt(plaintext, ctx.sessionKey)
        const hash = sha256Hex(stakedBytes)
        client.send({
          type: 'agent:encrypted_payload',
          payload: encodePayload(enc),
          hash,
        })
        return 'identity sent'
      } else {
        const pending = await ctx.takePendingOfKind('identity')
        const json = decryptPending(pending, ctx.sessionKey)
        const meta = JSON.parse(json) as {
          kind: 'identity'
          pubkey: string
          secretKeyBytes: number[]
        }
        const secretBuf = Buffer.from(meta.secretKeyBytes)
        const expectedHash = sha256Hex(secretBuf)
        if (expectedHash !== pending.hash) throw new Error('identity keypair hash mismatch')
        const derived = derivePubkey(secretBuf)
        if (derived !== meta.pubkey) {
          throw new Error('identity pubkey mismatch')
        }
        const tmpPath = pathJoin(tmpdir(), `staked-${nanoid(8)}.json`)
        writeKeypair(tmpPath, secretBuf)
        ctx.setReceivedStakedKeypairPath(tmpPath)
        ctx.setSourceIdentityPubkey(meta.pubkey)
        return 'identity stored'
      }
    }

    case 6: {
      if (role !== 'target') return 'noop (source waits)'
      const stakedPath = ctx.getReceivedStakedKeypairPath()
      if (!stakedPath) throw new Error('staked keypair not received before step 6')
      const sourcePk = ctx.getSourceIdentityPubkey()
      if (!sourcePk) {
        throw new Error('source identity pubkey unknown — refusing to activate without anti-dual-identity check')
      }
      // CR-1: poll gossip / validators until source has stopped voting.
      // This is the critical anti-dual-identity gate.
      //
      // Single-validator localnet escape hatch: a localnet with only one
      // staked validator stalls the moment source switches to unstaked
      // identity (no quorum left). `lastVote` and `current_slot` freeze
      // together, so `delinquent` never flips and the gate hangs forever.
      // Production migrations MUST NOT set this flag — bypassing the
      // anti-dual-identity gate is the dual-signing scenario this whole
      // tool is designed to avoid.
      if (process.env.VS_SKIP_QUIET_GATE === '1') {
        logBoth(
          client,
          'warn',
          'anti-dual-identity gate skipped via VS_SKIP_QUIET_GATE=1 (UNSAFE outside localnet)',
        )
      } else {
        await waitForSourceQuiet(sourcePk, SOURCE_QUIET_TIMEOUT_MS)
      }
      if (!opts.yes) {
        const ok = await confirmDestructive(
          `Activate staked identity on TARGET (ledger=${opts.ledger}, identity=${sourcePk.slice(0, 8)}…)? Source has been verified inactive.`,
        )
        if (!ok) throw new Error('operator declined step 6')
      }
      await setIdentity(opts.ledger, stakedPath)
      return 'set-identity staked'
    }

    case 7: {
      if (role !== 'target') return 'noop (source waits)'
      const stakedPath = ctx.getReceivedStakedKeypairPath()
      if (!stakedPath) throw new Error('staked keypair path missing for step 7')
      await addAuthorizedVoter(opts.ledger, stakedPath)
      return 'authorized-voter add'
    }

    case 8: {
      if (role !== 'target') return 'noop (source waits)'
      const sourcePk = ctx.getSourceIdentityPubkey()
      // Verify TARGET is now voting under the staked identity.
      const info = await getValidatorInfo(sourcePk ?? undefined)
      if (!info.isVoting) {
        throw new Error(
          `target not voting yet (identity=${(info.identityPubkey || 'unknown').slice(0, 8)}…)`,
        )
      }
      // CR-2: notify SOURCE that voting is confirmed so it can run step 9 wipe.
      const meta = JSON.stringify({
        kind: 'voting_confirmed',
        step: 8,
        identityPubkey: info.identityPubkey,
        voteAccount: info.voteAccount,
        ts: Date.now(),
      })
      const plaintext = new TextEncoder().encode(meta)
      const enc = encrypt(plaintext, ctx.sessionKey)
      const hash = sha256Hex(plaintext)
      client.send({
        type: 'agent:encrypted_payload',
        payload: encodePayload(enc),
        hash,
      })
      return `voting=true vote_account=${info.voteAccount ? info.voteAccount.slice(0, 8) + '…' : 'unknown'}`
    }

    case 9: {
      if (role !== 'source') return 'noop (target waits)'
      if (!opts.keypair) throw new Error('source --keypair required for step 9 cleanup')
      // CR-2: wait for target's voting_confirmed envelope. Refuse to wipe
      // if target has not positively confirmed voting within the timeout.
      const deadline = nowMs() + VOTING_CONFIRMED_TIMEOUT_MS
      while (nowMs() < deadline && !ctx.getPeerVotingConfirmed()) {
        await new Promise(r => setTimeout(r, 200))
      }
      if (!ctx.getPeerVotingConfirmed()) {
        throw new Error(
          'cannot wipe: target voting not confirmed within timeout — keypair preserved',
        )
      }
      if (!opts.yes) {
        const ok = await confirmDestructive(
          `Securely wipe staked keypair at ${opts.keypair}? This is irreversible.`,
        )
        if (!ok) throw new Error('operator declined step 9')
      }
      await secureWipe(opts.keypair)
      ctx.unregisterTmpFile(opts.keypair)
      return 'wiped staked keypair'
    }

    default:
      return `unknown step ${step}; no-op`
  }
}

// ---------------------------------------------------------------------------
// CR-1 helper: poll until source has stopped voting (or fall through with throw).
// ---------------------------------------------------------------------------

async function waitForSourceQuiet(
  sourcePubkey: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = nowMs() + timeoutMs
  while (nowMs() < deadline) {
    try {
      // Check `solana validators` for delinquent flag — a deactivated source
      // becomes delinquent within seconds.
      const { stdout } = await runSolanaCli(['validators', '--output', 'json'])
      const parsed = JSON.parse(stdout) as {
        validators?: Array<{
          identityPubkey?: string
          delinquent?: boolean
          lastVote?: number
        }>
      }
      const match = parsed.validators?.find(v => v.identityPubkey === sourcePubkey)
      if (!match) return // source is no longer in the validators set — quiet.
      if (match.delinquent === true) return // source is delinquent — not voting.
    } catch {
      // ignore poll error and retry
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error(
    `anti-dual-identity gate: source ${sourcePubkey.slice(0, 8)}… still appears active after ${timeoutMs}ms`,
  )
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

async function sendTowerFile(
  client: HubClient,
  ctx: StepCtx,
  towerPath: string,
  stakedPubkey: string,
): Promise<string> {
  let content: Buffer
  try {
    content = readFileSync(towerPath)
  } catch (err) {
    throw new Error(`failed to read tower file ${towerPath}: ${errorMessage(err)}`)
  }
  const hash = sha256Hex(content)
  const meta = JSON.stringify({
    kind: 'tower',
    filename: `tower-1_9-${stakedPubkey}.bin`,
    contentB64: content.toString('base64'),
  })
  const plaintext = new TextEncoder().encode(meta)
  const enc = encrypt(plaintext, ctx.sessionKey)
  client.send({
    type: 'agent:encrypted_payload',
    payload: encodePayload(enc),
    hash,
  })
  return `tower sent (${content.length} bytes, sha256=${hash.slice(0, 12)}…)`
}

function decryptPending(pending: PendingPayload, key: Uint8Array): string {
  let decoded
  try {
    decoded = decodePayload(pending.payload)
  } catch (err) {
    throw new CryptoError(`failed to decode payload: ${errorMessage(err)}`)
  }
  const plaintext = decrypt(decoded.ciphertext, decoded.nonce, key)
  return new TextDecoder().decode(plaintext)
}

/**
 * Atomically peek-decrypt each queued relay payload, return + remove the
 * first one whose envelope.kind matches `expectedKind`. Polls 50ms ticks
 * until 30s deadline. Wrong-kind entries are LEFT in the queue so a
 * concurrent step waiting for that other kind can pick them up.
 */
async function takePendingOfKind(
  queue: PendingPayload[],
  sessionKey: Uint8Array,
  expectedKind: string,
): Promise<PendingPayload> {
  const deadline = nowMs() + 30_000
  while (nowMs() < deadline) {
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]
      try {
        const decoded = decodePayload(p.payload)
        const plaintext = decrypt(decoded.ciphertext, decoded.nonce, sessionKey)
        const meta = JSON.parse(new TextDecoder().decode(plaintext)) as {
          kind?: string
        }
        if (meta?.kind === expectedKind) {
          queue.splice(i, 1)
          return p
        }
      } catch {
        // Bad / corrupted envelope. Drop it; the matching step will
        // eventually time out if its payload never arrives.
        queue.splice(i, 1)
        i--
      }
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${expectedKind} payload`)
}

function ensureUnstakedKeypair(opts: AgentOpts, ctx: StepCtx): string {
  if (opts.unstakedKeypair) {
    if (existsSync(opts.unstakedKeypair)) return opts.unstakedKeypair
    const kp = nacl.sign.keyPair()
    writeKeypair(opts.unstakedKeypair, Buffer.from(kp.secretKey))
    return opts.unstakedKeypair
  }
  // Generated to tmp — track for cleanup on exit.
  const tmpPath = pathJoin(tmpdir(), `unstaked-${nanoid(8)}.json`)
  const kp = nacl.sign.keyPair()
  writeKeypair(tmpPath, Buffer.from(kp.secretKey))
  ctx.registerTmpFile(tmpPath)
  return tmpPath
}

// Re-exports so that bin.ts and external callers can pick up the error types
// without reaching into the lower modules.
export { SolanaCliError } from '../solana/cli.js'
export { KeypairError } from '../solana/keypair.js'
export { CryptoError } from '../crypto/encrypt.js'

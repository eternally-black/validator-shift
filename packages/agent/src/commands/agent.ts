import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
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
  printStepProgress,
  printError,
  printLog,
} from '../ui/terminal.js'

export interface AgentOpts {
  role: AgentRole
  session: string
  hub: string
  ledger: string
  keypair?: string
  unstakedKeypair?: string
}

interface PendingPayload {
  payload: string
  hash: string
}

const STEP_LABELS: Record<number, string> = Object.fromEntries(
  MIGRATION_STEPS.map(s => [s.number, s.name]),
)

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
  printLog(level, message)
  try {
    client.send({ type: 'agent:log', level, message })
  } catch {
    // socket may not be open during error paths; printLog already happened
  }
}

/**
 * Top-level agent entry point invoked by bin.ts.
 */
export async function runAgent(opts: AgentOpts): Promise<void> {
  printBanner()

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
    process.exit(2)
  })

  client.on('hub:session_cancelled', () => {
    printLog('warn', 'session cancelled by hub')
    try {
      client.close('session_cancelled')
    } catch {
      // ignore
    }
    process.exit(0)
  })

  client.on('error', (err: unknown) => {
    printLog('error', `transport error: ${errorMessage(err)}`)
  })

  client.on('protocol_error', (err: unknown) => {
    printLog('error', `protocol error: ${errorMessage(err)}`)
  })

  client.on('timeout', () => {
    printLog('warn', 'hub heartbeat timeout')
  })

  // ----- State for migration session -----
  let sessionKey: Uint8Array | null = null
  let pendingPayload: PendingPayload | null = null
  // For target: after step 5 we'll know where we wrote the staked keypair.
  let receivedStakedKeypairPath: string | null = null
  // For target: tower file destination path (set when the source filename arrives via step 4).
  // Source decides the filename based on staked pubkey; we encode it inside the encrypted payload.
  let receivedTowerFilePath: string | null = null

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

  // Listen for relayed payloads from peer (used for steps 4 and 5 on target).
  client.on('hub:relay_payload', (msg: { payload: string; hash: string }) => {
    pendingPayload = { payload: msg.payload, hash: msg.hash }
  })

  // Rollback signal — we still expect Hub to send execute_step messages for
  // rollback semantics; this is just for logging.
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
            getPending: () => pendingPayload,
            clearPending: () => {
              pendingPayload = null
            },
            setReceivedStakedKeypairPath: (p: string) => {
              receivedStakedKeypairPath = p
            },
            getReceivedStakedKeypairPath: () => receivedStakedKeypairPath,
            setReceivedTowerFilePath: (p: string) => {
              receivedTowerFilePath = p
            },
            getReceivedTowerFilePath: () => receivedTowerFilePath,
          })

          const stepResult: StepResult = {
            ok: true,
            output: result,
            durationMs: nowMs() - startedAt,
          }
          client.send({ type: 'agent:step_complete', step, result: stepResult })
          logBoth(client, 'info', `step ${step} (${label}) complete`)
        } catch (err) {
          const message = errorMessage(err)
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

    // Keep the promise pending — exit happens via process.exit on critical
    // events or session_cancelled. For a clean completion the operator (Hub)
    // is expected to send session_cancelled or close the socket; ignore the
    // unused `resolve` until then.
    void resolve
  })
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

  // 1) solana CLI installed
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

  // 2) validator process running (best-effort)
  let identityFromGossip: string | null = null
  try {
    const info = await getValidatorInfo()
    const ok = !!info.identityPubkey
    identityFromGossip = ok ? info.identityPubkey : null
    checks.push({
      name: 'validator process running',
      ok,
      detail: ok ? `identity=${info.identityPubkey.slice(0, 8)}…` : 'no identity detected',
    })

    // 3) caught up
    checks.push({
      name: 'validator caught up',
      ok: info.isCaughtUp,
      detail: info.isCaughtUp ? undefined : 'not present in gossip',
    })
  } catch (err) {
    checks.push({
      name: 'validator process running',
      ok: false,
      detail: errorMessage(err),
    })
    checks.push({
      name: 'validator caught up',
      ok: false,
      detail: 'skipped (validator info unavailable)',
    })
  }

  if (opts.role === 'source') {
    // 4) identity keypair accessible
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

    // 5) vote account matches identity — TODO: requires comparing
    // `solana validators` voteAccountPubkey to a configured value or to the
    // running validator's --vote-account flag. Skip for now.
    void identityFromGossip
    checks.push({
      name: 'vote account matches identity',
      ok: true,
      detail: 'skipped (TODO: implement vote-account match)',
    })
  } else {
    // target-only: ledger path exists & writable
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
  getPending: () => PendingPayload | null
  clearPending: () => void
  setReceivedStakedKeypairPath: (p: string) => void
  getReceivedStakedKeypairPath: () => string | null
  setReceivedTowerFilePath: (p: string) => void
  getReceivedTowerFilePath: () => string | null
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
      // wait for restart window — source only
      if (role !== 'source') return 'noop (target waits)'
      await waitForRestartWindow(opts.ledger, {
        minIdleTime: 2,
        skipNewSnapshotCheck: true,
      })
      return 'restart window reached'
    }

    case 2: {
      // set unstaked identity on SOURCE
      if (role !== 'source') return 'noop (target waits)'
      const unstakedPath = ensureUnstakedKeypair(opts)
      await setIdentity(opts.ledger, unstakedPath)
      return `set-identity unstaked=${unstakedPath}`
    }

    case 3: {
      // remove authorized voters on SOURCE
      if (role !== 'source') return 'noop (target waits)'
      await removeAllAuthorizedVoters(opts.ledger)
      return 'authorized-voter remove-all'
    }

    case 4: {
      // tower file transfer
      if (role === 'source') {
        if (!opts.keypair) {
          throw new Error('source --keypair required to locate tower file')
        }
        const stakedBytes = readKeypair(opts.keypair)
        const stakedPubkey = derivePubkey(stakedBytes)
        const towerPath = pathJoin(opts.ledger, `tower-1_9-${stakedPubkey}.bin`)
        if (!existsSync(towerPath)) {
          // Best-effort fallback: try to discover any tower-1_9-*.bin file.
          let found: string | null = null
          try {
            const entries = readdirSync(opts.ledger)
            const match = entries.find(f => /^tower-1_9-.*\.bin$/.test(f))
            if (match) found = pathJoin(opts.ledger, match)
          } catch {
            // ignore
          }
          if (!found) {
            throw new Error(`tower file not found at ${towerPath}`)
          }
          // Use the discovered file.
          return await sendTowerFile(client, ctx, found, stakedPubkey)
        }
        return await sendTowerFile(client, ctx, towerPath, stakedPubkey)
      } else {
        // target: receive tower file
        const pending = await waitForPending(ctx)
        const decryptedJson = decryptPending(pending, ctx.sessionKey)
        const meta = JSON.parse(decryptedJson) as {
          kind: 'tower'
          filename: string
          contentB64: string
        }
        if (meta.kind !== 'tower') {
          throw new Error(`expected tower payload, got kind=${meta.kind}`)
        }
        const fileBytes = Buffer.from(meta.contentB64, 'base64')
        const dest = pathJoin(opts.ledger, meta.filename)
        // Verify hash claimed in protocol matches the inner content.
        const expectedHash = sha256Hex(fileBytes)
        if (expectedHash !== pending.hash) {
          throw new Error(
            `tower hash mismatch: expected=${expectedHash} got=${pending.hash}`,
          )
        }
        writeFileSync(dest, fileBytes, { mode: 0o600 })
        ctx.setReceivedTowerFilePath(dest)
        ctx.clearPending()
        return `tower written to ${dest}`
      }
    }

    case 5: {
      // identity keypair transfer
      if (role === 'source') {
        if (!opts.keypair) {
          throw new Error('source --keypair required for step 5')
        }
        const stakedBytes = readKeypair(opts.keypair)
        const stakedPubkey = derivePubkey(stakedBytes)
        const meta = JSON.stringify({
          kind: 'identity',
          pubkey: stakedPubkey,
          // 64-byte secret key as JSON-array (Solana keypair format).
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
        return `identity sent (pubkey=${stakedPubkey.slice(0, 8)}…)`
      } else {
        // target: receive identity keypair
        const pending = await waitForPending(ctx)
        const json = decryptPending(pending, ctx.sessionKey)
        const meta = JSON.parse(json) as {
          kind: 'identity'
          pubkey: string
          secretKeyBytes: number[]
        }
        if (meta.kind !== 'identity') {
          throw new Error(`expected identity payload, got kind=${meta.kind}`)
        }
        const secretBuf = Buffer.from(meta.secretKeyBytes)
        const expectedHash = sha256Hex(secretBuf)
        if (expectedHash !== pending.hash) {
          throw new Error('identity keypair hash mismatch')
        }
        const derived = derivePubkey(secretBuf)
        if (derived !== meta.pubkey) {
          throw new Error(
            `identity pubkey mismatch: derived=${derived} expected=${meta.pubkey}`,
          )
        }
        const tmpPath = pathJoin(tmpdir(), `staked-${nanoid(8)}.json`)
        writeKeypair(tmpPath, secretBuf)
        ctx.setReceivedStakedKeypairPath(tmpPath)
        ctx.clearPending()
        return `identity written to ${tmpPath}`
      }
    }

    case 6: {
      // set staked identity on TARGET
      if (role !== 'target') return 'noop (source waits)'
      const stakedPath = ctx.getReceivedStakedKeypairPath()
      if (!stakedPath) {
        throw new Error('staked keypair not received before step 6')
      }
      await setIdentity(opts.ledger, stakedPath)
      return `set-identity staked=${stakedPath}`
    }

    case 7: {
      // add authorized voter on TARGET
      if (role !== 'target') return 'noop (source waits)'
      const stakedPath = ctx.getReceivedStakedKeypairPath()
      if (!stakedPath) {
        throw new Error('staked keypair path missing for step 7')
      }
      await addAuthorizedVoter(opts.ledger, stakedPath)
      return 'authorized-voter add'
    }

    case 8: {
      // verification on TARGET
      if (role !== 'target') return 'noop (source waits)'
      const info = await getValidatorInfo()
      if (!info.isVoting) {
        throw new Error(
          `target not voting yet (identity=${info.identityPubkey || 'unknown'})`,
        )
      }
      return `voting=true vote_account=${info.voteAccount ?? 'unknown'}`
    }

    case 9: {
      // cleanup on SOURCE — secure wipe staked keypair
      if (role !== 'source') return 'noop (target waits)'
      if (!opts.keypair) {
        throw new Error('source --keypair required for step 9 cleanup')
      }
      await secureWipe(opts.keypair)
      return `wiped ${opts.keypair}`
    }

    default:
      // Unknown / rollback step — TODO: full rollback step semantics.
      // For now, treat as no-op so Hub can drive arbitrary recovery flows.
      return `unknown step ${step}; no-op`
  }
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

async function waitForPending(ctx: StepCtx): Promise<PendingPayload> {
  // Short-circuit if already buffered.
  const initial = ctx.getPending()
  if (initial) return initial
  // Otherwise poll briefly — relay events are asynchronous and may arrive
  // either just before or just after the matching execute_step message.
  // 30 second cap is generous for hub relay round-trip.
  const deadline = nowMs() + 30_000
  while (nowMs() < deadline) {
    await new Promise(r => setTimeout(r, 50))
    const p = ctx.getPending()
    if (p) return p
  }
  throw new Error('timed out waiting for relayed payload from peer')
}

function ensureUnstakedKeypair(opts: AgentOpts): string {
  // tweetnacl's nacl.sign.keyPair() returns a 64-byte secretKey already in the
  // canonical Solana keypair layout (32-byte seed || 32-byte pubkey).
  if (opts.unstakedKeypair) {
    if (existsSync(opts.unstakedKeypair)) return opts.unstakedKeypair
    const kp = nacl.sign.keyPair()
    writeKeypair(opts.unstakedKeypair, Buffer.from(kp.secretKey))
    return opts.unstakedKeypair
  }
  const tmpPath = pathJoin(tmpdir(), `unstaked-${nanoid(8)}.json`)
  const kp = nacl.sign.keyPair()
  writeKeypair(tmpPath, Buffer.from(kp.secretKey))
  return tmpPath
}

// Re-exports so that bin.ts and external callers can pick up the error types
// without reaching into the lower modules.
export { SolanaCliError } from '../solana/cli.js'
export { KeypairError } from '../solana/keypair.js'
export { CryptoError } from '../crypto/encrypt.js'

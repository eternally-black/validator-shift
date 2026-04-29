/**
 * ValidatorShift — End-to-end test harness (Wave 3 / D3)
 *
 * Boots the hub on memory-backed SQLite + ephemeral ports, opens a
 * dashboard WebSocket, starts a session over the REST API, and (in mock
 * mode) launches two agent child processes that drive the migration
 * happy-path to COMPLETE.
 *
 * Usage:
 *   npx tsx e2e/run.ts
 *
 * Exit codes:
 *   0 — happy-path reached COMPLETE  (or smoke-test passed when mock unavailable)
 *   1 — failure  (timeout, hub crash, unexpected state)
 *
 * NOTE on mock-mode (IMPORTANT):
 *   The implemented `runSolanaCli` in packages/agent/src/solana/cli.ts
 *   does NOT recognise any environment flag — it always shells out to a
 *   real `solana` binary. Until a mock layer lands, the agent processes
 *   will fail at the very first preflight check (`solana --version`) on
 *   any host without the Solana CLI installed.
 *
 *   This script therefore probes for the existence of mock support and
 *   falls back to a SMOKE-TEST when it isn't there:
 *     - hub spawns and starts listening
 *     - POST /api/sessions returns a {id,code} pair
 *     - dashboard WS opens cleanly
 *   ...which still validates Wave 1 + Wave 2 wiring without depending on
 *   the Solana toolchain. See e2e/README.md for the path to enable the
 *   full happy-path once the mock lands.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import WebSocket from 'ws'

// ---------- Inline base58 (Bitcoin alphabet — used by Solana) -------------
// Mirrors packages/agent/src/solana/keypair.ts to avoid pulling a dep.
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(buf: Buffer | Uint8Array): string {
  if (buf.length === 0) return ''
  let zeros = 0
  while (zeros < buf.length && buf[zeros] === 0) zeros++

  let n = 0n
  for (const b of buf) n = (n << 8n) | BigInt(b)

  let out = ''
  const fiftyEight = 58n
  while (n > 0n) {
    const rem = Number(n % fiftyEight)
    n = n / fiftyEight
    out = BASE58_ALPHABET[rem] + out
  }
  return '1'.repeat(zeros) + out
}

// ---------- Paths ----------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const E2E_DIR = __dirname
const FAKE_LEDGER = join(E2E_DIR, 'fake-ledger')
const FAKE_SOURCE_KP = join(E2E_DIR, 'fake-source-keypair.json')
const FAKE_TARGET_KP = join(E2E_DIR, 'fake-target-keypair.json')

// Hub now serves HTTP + WebSocket on a single port.
const HUB_PORT = '13001'

const HUB_ENTRY = join(ROOT, 'packages', 'hub', 'src', 'index.ts')
const AGENT_ENTRY = join(ROOT, 'packages', 'agent', 'src', 'bin.ts')

// Whether the agent's runSolanaCli supports a mock-mode env-flag.
// This is the *intended* contract; if/when it lands the agent CI flag
// can be flipped to true and the script will exercise the full happy-path.
// We default to "false" because the current Wave 1+2 code does NOT
// implement it.
const MOCK_FLAG_NAME = 'VALIDATOR_SHIFT_E2E_MOCK'
const MOCK_SUPPORTED = process.env.E2E_FORCE_MOCK === '1'

// ---------- Logging --------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ${line}`)
}

function logErr(line: string): void {
  // eslint-disable-next-line no-console
  console.error(`[${ts()}] ${line}`)
}

// ---------- Process management --------------------------------------------

const children = new Set<ChildProcess>()

function trackChild(child: ChildProcess, label: string): void {
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    log(`[child:${label}] exited code=${code} signal=${signal}`)
  })
}

function killAll(): void {
  for (const c of children) {
    if (c.killed) continue
    try {
      c.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  // Hard-kill stragglers shortly after.
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 2000).unref()
}

function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').replace(/\r?\n$/, '')
    if (text) log(`[${label}] ${text}`)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').replace(/\r?\n$/, '')
    if (text) logErr(`[${label}:stderr] ${text}`)
  })
}

// ---------- Fixture preparation --------------------------------------------

function ensureFixtures(): { sourcePubkey: string } {
  if (!existsSync(FAKE_LEDGER)) {
    mkdirSync(FAKE_LEDGER, { recursive: true })
  }

  // Generate a deterministic-enough source keypair (or reuse).
  let sourceSecret: Uint8Array
  let sourcePub: Uint8Array

  if (existsSync(FAKE_SOURCE_KP)) {
    const arr = JSON.parse(
      readFileSync(FAKE_SOURCE_KP, 'utf8'),
    ) as number[]
    sourceSecret = Uint8Array.from(arr)
    sourcePub = sourceSecret.slice(32, 64)
  } else {
    const kp = nacl.sign.keyPair()
    sourceSecret = kp.secretKey // 64 bytes (seed||pub) — Solana format
    sourcePub = kp.publicKey
    writeFileSync(
      FAKE_SOURCE_KP,
      JSON.stringify(Array.from(sourceSecret)),
      { mode: 0o600 },
    )
  }

  if (!existsSync(FAKE_TARGET_KP)) {
    // Target only needs a dummy file (bin.ts may require the option but
    // the agent does not touch it on the target path until it receives
    // the staked keypair via relay).
    const kp = nacl.sign.keyPair()
    writeFileSync(
      FAKE_TARGET_KP,
      JSON.stringify(Array.from(kp.secretKey)),
      { mode: 0o600 },
    )
  }

  // Tower file named after source pubkey, 32 random bytes.
  const sourcePubBs58 = base58Encode(sourcePub)
  const towerPath = join(FAKE_LEDGER, `tower-1_9-${sourcePubBs58}.bin`)
  if (!existsSync(towerPath)) {
    writeFileSync(towerPath, randomBytes(32))
  }

  log(`fixtures ready (source pubkey=${sourcePubBs58.slice(0, 8)}…)`)
  return { sourcePubkey: sourcePubBs58 }
}

// ---------- Hub bootstrap --------------------------------------------------

async function startHub(): Promise<void> {
  log('starting hub…')
  const env = {
    ...process.env,
    PORT: HUB_PORT,
    HUB_DB_PATH: ':memory:',
    NODE_ENV: 'test',
  }

  const child = spawn('npx', ['tsx', HUB_ENTRY], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  trackChild(child, 'hub')
  pipeOutput(child, 'hub')

  // Poll the HTTP port until it accepts requests.
  const url = `http://localhost:${HUB_PORT}/api/sessions`
  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`hub exited prematurely (code=${child.exitCode})`)
    }
    try {
      const res = await fetch(url, { method: 'GET' })
      // We accept any HTTP-level response (even 4xx) — it means the
      // server is up. We only care about reachability here.
      if (res.status >= 200 && res.status < 600) {
        log(`hub is up (HTTP ${res.status} from GET ${url})`)
        return
      }
    } catch (err) {
      lastErr = err
    }
    await delay(250)
  }
  throw new Error(
    `hub did not start within 30s: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  )
}

// ---------- Session creation -----------------------------------------------

interface CreatedSession {
  id: string
  code: string
}

async function createSession(): Promise<CreatedSession> {
  const url = `http://localhost:${HUB_PORT}/api/sessions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status !== 201) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST /api/sessions failed: ${res.status} ${text}`)
  }
  const body = (await res.json()) as { id: string; code: string }
  log(`session created: id=${body.id} code=${body.code}`)
  return { id: body.id, code: body.code }
}

// ---------- Dashboard WS observer ------------------------------------------

interface Observer {
  ws: WebSocket
  states: string[]
  /** Resolves when state === COMPLETE; rejects on FAILED / timeout. */
  done: Promise<'COMPLETE'>
}

function observeDashboard(sessionId: string): Observer {
  const url = `ws://localhost:${HUB_PORT}/ws/dashboard/${encodeURIComponent(sessionId)}`
  log(`opening dashboard WS: ${url}`)
  const ws = new WebSocket(url)
  const states: string[] = []

  const done = new Promise<'COMPLETE'>((resolveDone, reject) => {
    let settled = false
    const settleResolve = (v: 'COMPLETE'): void => {
      if (settled) return
      settled = true
      resolveDone(v)
    }
    const settleReject = (e: Error): void => {
      if (settled) return
      settled = true
      reject(e)
    }

    ws.on('open', () => log('dashboard WS open'))
    ws.on('error', err => log(`dashboard WS error: ${err.message}`))
    ws.on('close', (code, reason) =>
      log(`dashboard WS closed code=${code} reason=${reason.toString()}`),
    )
    ws.on('message', (data: WebSocket.RawData) => {
      let msg: { type?: string; [k: string]: unknown }
      try {
        msg = JSON.parse(data.toString()) as typeof msg
      } catch {
        return
      }
      if (msg.type === 'dashboard:state_change') {
        const state = String(msg.state ?? '')
        states.push(state)
        log(`state -> ${state}`)
        if (state === 'COMPLETE') settleResolve('COMPLETE')
        if (state === 'FAILED') settleReject(new Error('migration FAILED'))
      } else if (msg.type === 'dashboard:log') {
        const agent = String(msg.agent ?? '?')
        const lvl = String(msg.level ?? 'info')
        const m = String(msg.message ?? '')
        log(`log[${agent}/${lvl}]: ${m}`)
      } else if (msg.type === 'dashboard:step_progress') {
        log(`step ${String(msg.step)} → ${String(msg.status)}`)
      } else if (msg.type === 'dashboard:migration_complete') {
        log('migration_complete event received')
        settleResolve('COMPLETE')
      }
    })
  })

  return { ws, states, done }
}

// ---------- Agent bootstrap ------------------------------------------------

function startAgent(
  role: 'source' | 'target',
  sessionCode: string,
): ChildProcess {
  const args = [
    'tsx',
    AGENT_ENTRY,
    'agent',
    '--role',
    role,
    '--session',
    sessionCode,
    '--hub',
    `http://localhost:${HUB_PORT}`,
    '--ledger',
    FAKE_LEDGER,
    '--keypair',
    role === 'source' ? FAKE_SOURCE_KP : FAKE_TARGET_KP,
  ]
  const env = {
    ...process.env,
    [MOCK_FLAG_NAME]: '1',
    // Auto-confirm SAS in mock mode — inquirer would otherwise block.
    // Once mock-mode is implemented in agent.ts, it should bypass the
    // interactive prompt when this flag is set.
    NODE_ENV: 'test',
  }
  log(`spawning agent (${role})`)
  const child = spawn('npx', args, {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  trackChild(child, `agent:${role}`)
  pipeOutput(child, `agent:${role}`)
  return child
}

// ---------- Main flow ------------------------------------------------------

async function main(): Promise<number> {
  log(`E2E starting (mock-supported=${MOCK_SUPPORTED})`)
  ensureFixtures()

  await startHub()
  const session = await createSession()
  const observer = observeDashboard(session.id)

  // Give the dashboard WS a moment to connect.
  await delay(500)

  if (!MOCK_SUPPORTED) {
    log('--- MOCK MODE NOT AVAILABLE ---')
    log(
      'runSolanaCli has no mock hook; skipping agent spawn to avoid hard ' +
        'dependency on the solana binary. See e2e/README.md.',
    )
    log('SMOKE-TEST: hub up + POST /api/sessions ok + dashboard WS connected.')
    // Wait briefly to ensure WS open succeeded.
    await delay(1000)
    if (observer.ws.readyState === WebSocket.OPEN) {
      log('SMOKE-TEST PASSED')
      try {
        observer.ws.close()
      } catch {
        // ignore
      }
      return 0
    }
    log('SMOKE-TEST FAILED: dashboard WS never opened')
    return 1
  }

  // ---------- Full happy-path (gated on mock support) -----------------
  log('spawning agents in mock mode…')
  startAgent('source', session.code)
  startAgent('target', session.code)

  const timeoutMs = 60_000
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`E2E timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ).unref()
  })

  try {
    await Promise.race([observer.done, timeout])
  } catch (err) {
    logErr(
      `E2E failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    logErr(`states observed: ${observer.states.join(' -> ') || '(none)'}`)
    try {
      observer.ws.close()
    } catch {
      // ignore
    }
    return 1
  }

  log(
    `happy-path reached COMPLETE. states: ${observer.states.join(' -> ')}`,
  )
  try {
    observer.ws.close()
  } catch {
    // ignore
  }
  return 0
}

// ---------- Entry-point ----------------------------------------------------

let exiting = false
function onExit(code: number): void {
  if (exiting) return
  exiting = true
  killAll()
  process.exit(code)
}

process.on('SIGINT', () => onExit(1))
process.on('SIGTERM', () => onExit(1))

main().then(
  code => onExit(code),
  err => {
    logErr(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    onExit(1)
  },
)

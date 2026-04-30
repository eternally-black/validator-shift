/**
 * WebSocket connection handlers for the ValidatorShift hub.
 *
 * Two entrypoints:
 *   - `handleAgentSocket(ws, code, deps)`     — used by `/ws/agent?code=...`
 *   - `handleDashboardSocket(ws, sessionId, deps)` — used by `/ws/dashboard?id=...`
 *
 * CRITICAL INVARIANT (architecture section 3.1): the Hub NEVER decrypts,
 * decodes, or otherwise inspects `agent:encrypted_payload`. The hub only
 * repackages it as `hub:relay_payload` and forwards to the peer agent.
 * Any change that introduces decoding here MUST be rejected.
 */
import { WebSocket } from 'ws'
import type { Database } from 'better-sqlite3'
import type { AgentRole } from '@validator-shift/shared'
import {
  AgentMessageSchema,
  DashboardMessageSchema,
  parseMessage,
  type AgentMessage,
  type DashboardMessage,
  type HubToAgentMessage,
  type HubToDashboardMessage,
} from '@validator-shift/shared/protocol'
import { MIGRATION_STEPS } from '@validator-shift/shared/constants'
import { MigrationState } from '@validator-shift/shared'
import { redactSecrets, isValidSessionCode } from '@validator-shift/shared/redact'
import {
  appendAuditLog as dbAppendAuditLog,
  getRecentAuditLogs,
  getSessionById,
  getSessionByCode,
} from '../db/queries.js'
import { type Room, type RoomRegistry, safeSend } from './rooms.js'

// ---------- Dependency contract ----------

export interface HandlerDeps {
  db: Database
  registry: RoomRegistry
  orchestrator: {
    handleAgentMessage(
      sessionId: string,
      role: AgentRole,
      msg: AgentMessage,
    ): void
    handleDashboardMessage(sessionId: string, msg: DashboardMessage): void
    handleAgentDisconnect(sessionId: string, role: AgentRole): void
    /**
     * Returns the current step the orchestrator is dispatching, or 0 if
     * the session is not currently MIGRATING. Used by the dashboard
     * snapshot path to reconstruct per-step progress for late-joining
     * dashboards.
     */
    getCurrentStep(sessionId: string): number
  }
  /**
   * Verifies a dashboard bearer token issued at session creation. Required
   * for /ws/dashboard/:id connections — without this gate, anyone who
   * discovers a session id can drive `dashboard:abort`.
   */
  verifyDashboardToken: (sessionId: string, token: string) => boolean
}

// ---------- WS connection rate-limit (defence against brute-force) ----------

interface WsRateState {
  count: number
  windowStart: number
}
const WS_RATE_WINDOW_MS = 60_000
const WS_RATE_MAX = 30 // connections per minute per IP
const wsRate: Map<string, WsRateState> = new Map()

function wsRateLimitExceeded(ip: string | undefined): boolean {
  if (!ip) return false
  const now = Date.now()
  const cur = wsRate.get(ip)
  if (!cur || now - cur.windowStart > WS_RATE_WINDOW_MS) {
    wsRate.set(ip, { count: 1, windowStart: now })
    return false
  }
  cur.count++
  return cur.count > WS_RATE_MAX
}

// ---------- Internal helpers ----------

/** Append an audit-log row using the canonical query helper. Returns ts. */
function appendAuditLog(
  db: Database,
  sessionId: string,
  agent: AgentRole | 'hub',
  level: 'info' | 'warn' | 'error',
  message: string,
): number {
  const ts = Date.now()
  dbAppendAuditLog(db, { sessionId, ts, agent, level, message })
  return ts
}

function logWarn(prefix: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(`[hub/ws] ${prefix}`, ...args)
}

function logInfo(prefix: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[hub/ws] ${prefix}`, ...args)
}

// ---------- Agent socket ----------

/**
 * Handle a single agent connection. The agent connects with only a session
 * `code` (6-char). We resolve the session via `db`, attach the socket to a
 * Room, then dispatch parsed messages either to the orchestrator or — for
 * encrypted payloads — relay verbatim to the peer agent.
 */
export function handleAgentSocket(
  ws: WebSocket,
  code: string,
  deps: HandlerDeps,
  ip?: string,
): void {
  if (!isValidSessionCode(code)) {
    try {
      ws.close(4400, 'invalid_session_code')
    } catch {
      // ignore
    }
    return
  }
  if (wsRateLimitExceeded(ip)) {
    try {
      ws.close(4429, 'rate_limited')
    } catch {
      // ignore
    }
    return
  }
  const session = getSessionByCode(deps.db, code)
  if (!session) {
    try {
      ws.close(4404, 'session_not_found')
    } catch {
      // ignore
    }
    return
  }
  if (session.expiresAt <= Date.now()) {
    try {
      ws.close(4410, 'session_expired')
    } catch {
      // ignore
    }
    return
  }

  const room: Room = deps.registry.getOrCreate(session.id, session.code)

  // Role is set on receipt of `agent:hello`. Until then, this socket is
  // anonymous and cannot be targeted by relays.
  let role: AgentRole | undefined

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text =
      typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8')
    const parsed = parseMessage(text)
    if (!parsed.ok) {
      logWarn('agent: malformed message', {
        sessionId: session.id,
        error: parsed.error,
      })
      return
    }

    // Narrow to AgentMessage — anything else from an agent socket is invalid.
    const agentParsed = AgentMessageSchema.safeParse(parsed.data)
    if (!agentParsed.success) {
      logWarn('agent: non-agent message on agent socket', {
        sessionId: session.id,
        error: agentParsed.error.message,
      })
      return
    }
    const msg = agentParsed.data

    switch (msg.type) {
      case 'agent:hello': {
        const helloRole = msg.role
        // Reject if a peer with this role is already present.
        const existing = room.agents[helloRole]
        if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
          logWarn('agent: duplicate role attempt', {
            sessionId: session.id,
            role: helloRole,
          })
          try {
            ws.close(4409, 'role_already_taken')
          } catch {
            // ignore
          }
          return
        }
        role = helloRole
        room.addAgent(role, ws)
        room.setAgentPubkey(role, msg.publicKey)
        deps.orchestrator.handleAgentMessage(session.id, role, msg)

        // If both agents have now sent their hello, fan out hub:peer_connected
        // so each side learns the peer's X25519 public key and can derive the
        // shared secret + SAS. This is the missing piece without which the
        // agent's `await waitForPeer(...)` blocks forever (architecture §3.2).
        if (room.hasBothPubkeys()) {
          const sourcePk = room.agentPubkeys.source!
          const targetPk = room.agentPubkeys.target!
          room.sendToAgent('source', {
            type: 'hub:peer_connected',
            peerPublicKey: targetPk,
          })
          room.sendToAgent('target', {
            type: 'hub:peer_connected',
            peerPublicKey: sourcePk,
          })
        }
        return
      }

      case 'agent:encrypted_payload': {
        // Section 3.1: opaque blob — DO NOT decrypt, decode, or inspect.
        // Only relay verbatim to the peer agent.
        if (!role) {
          logWarn('agent: encrypted_payload before hello', {
            sessionId: session.id,
          })
          return
        }
        const relay: HubToAgentMessage = {
          type: 'hub:relay_payload',
          payload: msg.payload,
          hash: msg.hash,
        }
        const ok = room.relayToPeer(role, relay)
        if (!ok) {
          logWarn('agent: relay failed (peer absent or closed)', {
            sessionId: session.id,
            fromRole: role,
          })
        }
        return
      }

      case 'agent:log': {
        if (!role) {
          logWarn('agent: log before hello', { sessionId: session.id })
          return
        }
        // M-1: hub-side defence in depth. Even though the agent is supposed
        // to redact its own logs, a malicious peer could craft an unredacted
        // payload to leak through dashboards. Re-redact on the boundary.
        const safeMessage = redactSecrets(msg.message)
        const ts = appendAuditLog(
          deps.db,
          session.id,
          role,
          msg.level,
          safeMessage,
        )
        const broadcast: HubToDashboardMessage = {
          type: 'dashboard:log',
          agent: role,
          level: msg.level,
          message: safeMessage,
          ts,
        }
        room.broadcastToDashboards(broadcast)
        return
      }

      default: {
        if (!role) {
          logWarn('agent: message before hello', {
            sessionId: session.id,
            type: msg.type,
          })
          return
        }
        deps.orchestrator.handleAgentMessage(session.id, role, msg)
        return
      }
    }
  })

  const onGone = (): void => {
    if (role) {
      // Only detach this socket if it is still the registered one for the
      // role (a fresh reconnect could have replaced it).
      if (room.agents[role] === ws) {
        room.removeAgent(role)
      }
      deps.orchestrator.handleAgentDisconnect(session.id, role)
    }
  }

  ws.on('close', onGone)
  ws.on('error', (err) => {
    logWarn('agent: socket error', { sessionId: session.id, err: String(err) })
    onGone()
  })

  logInfo('agent: connected', { sessionId: session.id, code: session.code })
}

// ---------- Dashboard socket ----------

/**
 * Handle a single dashboard observer connection. On connect we send a
 * snapshot built from the DB + in-memory Room so the UI can render the
 * current session state without waiting for the next event.
 */
export function handleDashboardSocket(
  ws: WebSocket,
  sessionId: string,
  token: string | undefined,
  deps: HandlerDeps,
  ip?: string,
): void {
  if (wsRateLimitExceeded(ip)) {
    try {
      ws.close(4429, 'rate_limited')
    } catch {
      // ignore
    }
    return
  }
  // H-4: every dashboard connection must carry the bearer token returned
  // by POST /api/sessions. Anyone who only knows the session id (which
  // leaks via the public list endpoint) cannot abort or eavesdrop.
  if (!token || !deps.verifyDashboardToken(sessionId, token)) {
    try {
      ws.close(4401, 'unauthorized')
    } catch {
      // ignore
    }
    return
  }
  const session = getSessionById(deps.db, sessionId)
  if (!session) {
    try {
      ws.close(4404, 'session_not_found')
    } catch {
      // ignore
    }
    return
  }
  if (session.expiresAt <= Date.now() && session.completedAt == null) {
    try {
      ws.close(4410, 'session_expired')
    } catch {
      // ignore
    }
    return
  }

  const room: Room = deps.registry.getOrCreate(session.id, session.code)
  room.addDashboard(ws)

  // Snapshot: state_change (prev=current), agents_status, recent logs.
  const stateMsg: HubToDashboardMessage = {
    type: 'dashboard:state_change',
    state: session.state,
    prevState: session.state,
  }
  safeSend(ws, stateMsg)

  const agentsMsg: HubToDashboardMessage = {
    type: 'dashboard:agents_status',
    source: {
      role: 'source',
      connected: room.agents.source?.readyState === WebSocket.OPEN,
    },
    target: {
      role: 'target',
      connected: room.agents.target?.readyState === WebSocket.OPEN,
    },
  }
  safeSend(ws, agentsMsg)

  // Per-step snapshot. Without this, a dashboard connecting AFTER the
  // migration finished sees the COMPLETE state badge but every step in
  // the StepList stays "pending" because `dashboard:step_progress`
  // messages only get fan-out at the moment they fire (not replayed).
  // For a session in COMPLETE state we mark all steps complete; for
  // MIGRATING we mark the current step as running (and any prior ones
  // as complete — the orchestrator's currentStep tells us how far we
  // got, which is the only state we can reliably reconstruct without a
  // dedicated step-state column in the DB).
  if (session.state === MigrationState.COMPLETE) {
    for (const step of MIGRATION_STEPS) {
      const msg: HubToDashboardMessage = {
        type: 'dashboard:step_progress',
        step: step.number,
        status: 'complete',
      }
      safeSend(ws, msg)
    }
  } else if (session.state === MigrationState.MIGRATING) {
    const currentStep = deps.orchestrator.getCurrentStep(session.id)
    for (const step of MIGRATION_STEPS) {
      let status: 'pending' | 'running' | 'complete' | 'failed'
      if (step.number < currentStep) status = 'complete'
      else if (step.number === currentStep) status = 'running'
      else status = 'pending'
      if (status === 'pending') continue
      const msg: HubToDashboardMessage = {
        type: 'dashboard:step_progress',
        step: step.number,
        status,
      }
      safeSend(ws, msg)
    }
  }

  for (const entry of getRecentAuditLogs(deps.db, session.id, 200)) {
    if (entry.agent === 'hub') continue // dashboard:log only carries agent roles
    const logMsg: HubToDashboardMessage = {
      type: 'dashboard:log',
      agent: entry.agent,
      level: entry.level,
      message: entry.message,
      ts: entry.ts,
    }
    safeSend(ws, logMsg)
  }

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text =
      typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      logWarn('dashboard: invalid JSON', {
        sessionId: session.id,
        error: (e as Error).message,
      })
      return
    }
    const result = DashboardMessageSchema.safeParse(parsed)
    if (!result.success) {
      logWarn('dashboard: invalid message', {
        sessionId: session.id,
        error: result.error.message,
      })
      return
    }
    deps.orchestrator.handleDashboardMessage(session.id, result.data)
  })

  const onGone = (): void => {
    room.removeDashboard(ws)
  }

  ws.on('close', onGone)
  ws.on('error', (err) => {
    logWarn('dashboard: socket error', {
      sessionId: session.id,
      err: String(err),
    })
    onGone()
  })

  logInfo('dashboard: connected', { sessionId: session.id })
}

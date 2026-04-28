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
import type { AgentRole, LogEntry, Session } from '@validator-shift/shared'
import { MigrationState } from '@validator-shift/shared'
import {
  AgentMessageSchema,
  DashboardMessageSchema,
  parseMessage,
  type AgentMessage,
  type DashboardMessage,
  type HubToAgentMessage,
  type HubToDashboardMessage,
} from '@validator-shift/shared/protocol'
import type { Room, RoomRegistry } from './rooms.js'

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
  }
}

// ---------- Internal helpers ----------

interface SessionRow {
  id: string
  code: string
  state: string
  created_at: number
  expires_at: number
  completed_at: number | null
}

function findSessionByCode(db: Database, code: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, code, state, created_at, expires_at, completed_at
       FROM sessions WHERE code = ?`,
    )
    .get(code) as SessionRow | undefined
}

function findSessionById(db: Database, id: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, code, state, created_at, expires_at, completed_at
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    code: row.code,
    state: row.state as MigrationState,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at ?? undefined,
  }
}

/** Append a single audit-log row. Returns the row's monotonic ts. */
function appendAuditLog(
  db: Database,
  sessionId: string,
  agent: AgentRole | 'hub',
  level: 'info' | 'warn' | 'error',
  message: string,
): number {
  const ts = Date.now()
  db.prepare(
    `INSERT INTO audit_log (session_id, ts, level, agent, message)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, ts, level, agent, message)
  return ts
}

function recentLogs(
  db: Database,
  sessionId: string,
  limit: number = 200,
): LogEntry[] {
  const rows = db
    .prepare(
      `SELECT ts, agent, level, message FROM audit_log
       WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{
    ts: number
    agent: string
    level: string
    message: string
  }>
  // Return in chronological (ascending) order.
  return rows.reverse().map((r) => ({
    ts: r.ts,
    agent: r.agent as AgentRole | 'hub',
    level: r.level as 'info' | 'warn' | 'error',
    message: r.message,
  }))
}

function safeSend(
  ws: WebSocket,
  msg: HubToAgentMessage | HubToDashboardMessage,
): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // best-effort
  }
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
): void {
  const row = findSessionByCode(deps.db, code)
  if (!row) {
    try {
      ws.close(4404, 'session_not_found')
    } catch {
      // ignore
    }
    return
  }
  if (row.expires_at <= Date.now()) {
    try {
      ws.close(4410, 'session_expired')
    } catch {
      // ignore
    }
    return
  }

  const session = rowToSession(row)
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
        deps.orchestrator.handleAgentMessage(session.id, role, msg)
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
        const ts = appendAuditLog(
          deps.db,
          session.id,
          role,
          msg.level,
          msg.message,
        )
        const broadcast: HubToDashboardMessage = {
          type: 'dashboard:log',
          agent: role,
          level: msg.level,
          message: msg.message,
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
  deps: HandlerDeps,
): void {
  const row = findSessionById(deps.db, sessionId)
  if (!row) {
    try {
      ws.close(4404, 'session_not_found')
    } catch {
      // ignore
    }
    return
  }
  if (row.expires_at <= Date.now() && !row.completed_at) {
    try {
      ws.close(4410, 'session_expired')
    } catch {
      // ignore
    }
    return
  }

  const session = rowToSession(row)
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

  for (const entry of recentLogs(deps.db, session.id)) {
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

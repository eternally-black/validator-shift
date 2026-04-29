/**
 * SessionManager — coordinates session creation/lookup/cancellation and
 * owns one MigrationOrchestrator per active session.
 *
 * It is the glue between three otherwise-independent layers:
 *   - REST API (`api/routes.ts` consumes us via its `RouteDeps.sessionManager`).
 *   - WebSocket layer (`ws/handler.ts` consumes us via its
 *     `HandlerDeps.orchestrator`, which only requires three message-routing
 *     methods — exposed at the bottom of this module).
 *   - Persistence (`db/queries.ts`) and broadcast (`ws/rooms.ts`).
 *
 * CRITICAL INVARIANT (architecture section 3): no private keys, keypairs,
 * or secrets ever pass through this manager. We deal in session metadata
 * + state-machine events only.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { customAlphabet } from 'nanoid'
import {
  MigrationState,
  type AgentRole,
  type AgentStatus,
  type Session,
} from '@validator-shift/shared'
import { SESSION_CODE_LENGTH } from '@validator-shift/shared/constants'
import type {
  AgentMessage,
  DashboardMessage,
  HubToAgentMessage,
  HubToDashboardMessage,
} from '@validator-shift/shared/protocol'
import { WebSocket } from 'ws'

import type { SessionWithAgents } from './api/routes.js'
import {
  createSession as dbCreateSession,
  getSessionById as dbGetSessionById,
  listRecentSessions as dbListRecentSessions,
  markSessionCompleted as dbMarkSessionCompleted,
  updateSessionState as dbUpdateSessionState,
} from './db/queries.js'
import { MigrationOrchestrator } from './orchestrator/state-machine.js'
import type { RoomRegistry } from './ws/rooms.js'

/**
 * Session-code alphabet: upper-case letters + digits, deliberately NOT
 * full base58 — we want codes that are safe to read out loud over a
 * phone call without collisions (no l/I/0/O ambiguity is acceptable
 * for an operator UX, though we keep it simple here).
 */
const SESSION_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const generateSessionCode = customAlphabet(
  SESSION_CODE_ALPHABET,
  SESSION_CODE_LENGTH,
)

/**
 * States from which the public DELETE /api/sessions/:id is allowed to cancel.
 * Exported so api/routes.ts can re-use the same gate without drift.
 */
export const CANCELLABLE_STATES: ReadonlySet<MigrationState> = new Set([
  MigrationState.IDLE,
  MigrationState.PAIRING,
])

export class SessionManager {
  private readonly db: Database.Database
  private readonly registry: RoomRegistry
  private readonly orchestrators: Map<string, MigrationOrchestrator> = new Map()
  /**
   * Per-session bearer token returned to the wizard on POST /api/sessions
   * and required on the dashboard WS query string. Lives in-memory only
   * (intentionally NOT persisted) — token is the only authorization the
   * hub has for `dashboard:abort` and live-log streaming.
   */
  private readonly dashboardTokens: Map<string, string> = new Map()

  constructor(db: Database.Database, registry: RoomRegistry) {
    this.db = db
    this.registry = registry
  }

  // ------------------------------------------------------------------
  // RouteDeps surface
  // ------------------------------------------------------------------

  /**
   * Allocate a new session: pick a unique code, persist the row, and
   * spin up an orchestrator wired to broadcast to the session's room.
   *
   * The room itself is lazily created — we pre-create it here so events
   * that fire before the first dashboard connects (e.g. an agent that
   * connects before the operator opens the wizard) still have a target.
   */
  create(opts: { ttlMs: number }): {
    id: string
    code: string
    expiresAt: number
    dashboardToken: string
  } {
    const code = this.allocateUniqueCode()
    const session = dbCreateSession(this.db, { code, ttlMs: opts.ttlMs })

    // Pre-create the room so orchestrator events have a broadcast target.
    this.registry.getOrCreate(session.id, session.code)

    const orchestrator = new MigrationOrchestrator(session.id)
    this.orchestrators.set(session.id, orchestrator)
    this.wireOrchestrator(session.id, orchestrator)
    orchestrator.start()

    // 24 random bytes → 32-char base64url token. Never persisted.
    const dashboardToken = randomBytes(24).toString('base64url')
    this.dashboardTokens.set(session.id, dashboardToken)

    return {
      id: session.id,
      code: session.code,
      expiresAt: session.expiresAt,
      dashboardToken,
    }
  }

  /**
   * Constant-time comparison of a candidate token against the stored one.
   * Returns false if the session is unknown.
   */
  verifyDashboardToken(sessionId: string, token: string): boolean {
    const expected = this.dashboardTokens.get(sessionId)
    if (!expected) return false
    if (expected.length !== token.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
    }
    return diff === 0
  }

  /**
   * Read a session by id and enrich with the in-memory room state for
   * agent connectivity. Returns null if the session row is gone (e.g.
   * after a TTL purge or manual delete).
   */
  getById(id: string): SessionWithAgents | null {
    const session = dbGetSessionById(this.db, id)
    if (!session) return null

    const room = this.registry.get(id)
    const sourceConnected =
      room?.agents.source?.readyState === WebSocket.OPEN
    const targetConnected =
      room?.agents.target?.readyState === WebSocket.OPEN

    const agents: AgentStatus[] = [
      { role: 'source', connected: sourceConnected },
      { role: 'target', connected: targetConnected },
    ]

    return { ...session, agents }
  }

  listRecent(limit: number): Session[] {
    return dbListRecentSessions(this.db, limit)
  }

  /**
   * Cancel a session. Only valid in IDLE / PAIRING — any later state
   * means a migration is in flight and must run through orchestrator
   * abort + rollback semantics, not a route-level cancel.
   *
   * Returns false if the session is missing or the state has moved on
   * since the route layer's pre-check (race-safe).
   */
  cancel(id: string): boolean {
    const session = dbGetSessionById(this.db, id)
    if (!session) return false
    if (!CANCELLABLE_STATES.has(session.state)) return false

    const orchestrator = this.orchestrators.get(id)
    if (orchestrator) {
      orchestrator.abort('cancelled')
    }
    dbUpdateSessionState(this.db, id, MigrationState.FAILED)

    // Notify any connected agents that the session is gone, so they
    // can shut down without waiting for the WS to close.
    const room = this.registry.get(id)
    if (room) {
      const cancelMsg: HubToAgentMessage = { type: 'hub:session_cancelled' }
      room.sendToAgent('source', cancelMsg)
      room.sendToAgent('target', cancelMsg)
    }
    return true
  }

  /** Lookup helper for callers that need to drive the orchestrator directly. */
  getOrchestrator(sessionId: string): MigrationOrchestrator | undefined {
    return this.orchestrators.get(sessionId)
  }

  // ------------------------------------------------------------------
  // HandlerDeps.orchestrator surface
  // ------------------------------------------------------------------

  /**
   * Translate a parsed agent message into the matching orchestrator
   * call. Unknown / hub-relayed types (e.g. `agent:encrypted_payload`)
   * are silently ignored here — the WS handler relays those directly.
   */
  handleAgentMessage(
    sessionId: string,
    role: AgentRole,
    msg: AgentMessage,
  ): void {
    const orchestrator = this.getOrRevive(sessionId)
    if (!orchestrator) return

    switch (msg.type) {
      case 'agent:hello':
        orchestrator.onAgentConnected(role)
        return
      case 'agent:sas_confirmed':
        orchestrator.onSasConfirmed(role)
        return
      case 'agent:preflight_result':
        orchestrator.onPreflightResult(role, msg.checks)
        return
      case 'agent:step_complete':
        orchestrator.onStepComplete(msg.step, msg.result)
        return
      case 'agent:step_failed':
        orchestrator.onStepFailed(msg.step, msg.error)
        return
      // `agent:encrypted_payload` and `agent:log` are handled in the WS
      // layer (relay + audit-log respectively) and never reach us.
      default:
        return
    }
  }

  /**
   * Translate a dashboard control message into the matching orchestrator
   * call. The WS layer guarantees the message has already been parsed
   * + schema-validated.
   */
  handleDashboardMessage(sessionId: string, msg: DashboardMessage): void {
    const orchestrator = this.getOrRevive(sessionId)
    if (!orchestrator) return

    switch (msg.type) {
      case 'dashboard:start_migration':
        orchestrator.startMigration()
        return
      case 'dashboard:abort':
        orchestrator.abort('dashboard_abort')
        return
      case 'dashboard:confirm_sas':
        // The dashboard's "I confirmed SAS" click is informational only —
        // the authoritative confirmations come from the agents themselves.
        return
      default:
        return
    }
  }

  /**
   * Forward a socket-level disconnect into orchestrator state. This is
   * how PAIRING/PREFLIGHT roll back to IDLE, and how a mid-migration
   * source disconnect triggers ROLLBACK (see state-machine.ts).
   */
  handleAgentDisconnect(sessionId: string, role: AgentRole): void {
    const orchestrator = this.getOrRevive(sessionId)
    if (!orchestrator) return
    orchestrator.onAgentDisconnected(role)
  }

  /**
   * Look up the orchestrator for a session; if it's missing (most likely
   * because the hub process was restarted between session creation and
   * agent connect — Railway redeploys, crashes, etc.), revive it from the
   * persisted session row. Returns null if the session itself is gone.
   *
   * Note: revival starts the orchestrator in IDLE so onAgentConnected can
   * still drive IDLE->PAIRING when the second agent reconnects. The DB
   * state column is updated by the wireOrchestrator state_change hook on
   * the next legitimate transition.
   */
  private getOrRevive(sessionId: string): MigrationOrchestrator | null {
    const existing = this.orchestrators.get(sessionId)
    if (existing) return existing

    const session = dbGetSessionById(this.db, sessionId)
    if (!session) return null

    const orchestrator = new MigrationOrchestrator(sessionId)
    this.orchestrators.set(sessionId, orchestrator)
    this.wireOrchestrator(sessionId, orchestrator)
    orchestrator.start()
    return orchestrator
  }

  // ------------------------------------------------------------------
  // Internal: orchestrator → room/db wiring
  // ------------------------------------------------------------------

  private wireOrchestrator(
    sessionId: string,
    orchestrator: MigrationOrchestrator,
  ): void {
    orchestrator.on('state_change', (payload) => {
      // Persist the new state and broadcast to dashboards.
      dbUpdateSessionState(this.db, sessionId, payload.to)
      const room = this.registry.get(sessionId)
      if (!room) return
      const msg: HubToDashboardMessage = {
        type: 'dashboard:state_change',
        state: payload.to,
        prevState: payload.from,
      }
      room.broadcastToDashboards(msg)

      // On entering PREFLIGHT, request both agents to run their checklists.
      // Without this, agents block at `await client.once('hub:run_preflight')`
      // forever and the wizard never advances to step 3.
      if (payload.to === MigrationState.PREFLIGHT) {
        const runPreflight: HubToAgentMessage = { type: 'hub:run_preflight' }
        room.sendToAgent('source', runPreflight)
        room.sendToAgent('target', runPreflight)
      }
    })

    orchestrator.on('execute_step', (payload) => {
      const room = this.registry.get(sessionId)
      if (!room) return
      const agentMsg: HubToAgentMessage = {
        type: 'hub:execute_step',
        step: payload.step,
      }
      // Steps 4 and 5 are bilateral relays: source encrypts and sends, target
      // decrypts, verifies hash + pubkey, and persists. Both sides need the
      // execute_step trigger so target's `waitForPending` actually runs and
      // the staked path/source pubkey land in StepCtx before step 6.
      if (payload.step === 4 || payload.step === 5) {
        room.sendToAgent('source', agentMsg)
        room.sendToAgent('target', agentMsg)
      } else {
        room.sendToAgent(payload.role, agentMsg)
      }
      const dashMsg: HubToDashboardMessage = {
        type: 'dashboard:step_progress',
        step: payload.step,
        status: 'running',
      }
      room.broadcastToDashboards(dashMsg)
    })

    orchestrator.on('rollback', () => {
      const room = this.registry.get(sessionId)
      if (!room) return
      // Tell BOTH agents to enter rollback mode; each will inspect the
      // step list and execute only the actions assigned to its role.
      const msg: HubToAgentMessage = { type: 'hub:rollback' }
      room.sendToAgent('source', msg)
      room.sendToAgent('target', msg)
    })

    orchestrator.on('session_complete', (summary) => {
      const completedAt = Date.now()
      dbMarkSessionCompleted(this.db, sessionId, completedAt)
      dbUpdateSessionState(this.db, sessionId, MigrationState.COMPLETE)

      const room = this.registry.get(sessionId)
      if (room) {
        const msg: HubToDashboardMessage = {
          type: 'dashboard:migration_complete',
          summary,
        }
        room.broadcastToDashboards(msg)
      }
      this.orchestrators.delete(sessionId)
    })

    orchestrator.on('session_failed', () => {
      dbUpdateSessionState(this.db, sessionId, MigrationState.FAILED)
      this.orchestrators.delete(sessionId)
    })

    orchestrator.on('critical_alert', (payload) => {
      // Surface as an error-level dashboard log so the operator sees it
      // immediately without having to wait for any state transition.
      const room = this.registry.get(sessionId)
      if (!room) return
      const msg: HubToDashboardMessage = {
        type: 'dashboard:log',
        agent: 'source', // placeholder — the alert originates inside the hub
        level: 'error',
        message: `CRITICAL: ${payload.reason}`,
        ts: Date.now(),
      }
      room.broadcastToDashboards(msg)
    })
  }

  /**
   * Generate a fresh session code. We retry on the (extremely unlikely)
   * collision of a 6-char alphanumeric code in an active session set.
   * Bounded at 16 attempts to avoid pathological loops.
   */
  private allocateUniqueCode(): string {
    for (let i = 0; i < 16; i++) {
      const code = generateSessionCode()
      // Cheap check via the registry first (covers in-flight sessions);
      // the DB UNIQUE constraint on `code` is the durable backstop.
      if (!this.registry.get(code)) return code
    }
    // Last-resort fall-through — let SQLite enforce uniqueness if we
    // somehow exhausted the (36^6 ≈ 2.1B) space in a single process.
    return generateSessionCode()
  }
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  MigrationState,
  type AgentStatus,
  type LogEntry,
  type Session,
} from '@validator-shift/shared'
import {
  CreateSessionBodySchema,
  ListSessionsQuerySchema,
  SessionIdParamsSchema,
  type CreateSessionResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
} from './schemas.js'

/**
 * Default session TTL when the client doesn't request a custom one.
 * 30 minutes is enough for an operator to install + connect both agents.
 */
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * How many audit-log rows to attach to GET /api/sessions/:id.
 */
const RECENT_LOGS_LIMIT = 50

/**
 * Default page size for GET /api/sessions when `limit` is omitted.
 */
const DEFAULT_LIST_LIMIT = 20

/**
 * A session enriched with the connected agents view, returned by
 * `sessionManager.getById`. Kept structural to avoid coupling to
 * a particular implementation in the manager package.
 */
export interface SessionWithAgents extends Session {
  agents: AgentStatus[]
}

export interface RouteDeps {
  db: import('better-sqlite3').Database
  sessionManager: {
    create(opts: { ttlMs: number }): {
      id: string
      code: string
      expiresAt: number
      dashboardToken: string
    }
    getById(id: string): SessionWithAgents | null
    listRecent(limit: number): Session[]
    cancel(id: string): boolean
  }
}

/**
 * States from which a session may still be cancelled. Anything past
 * PAIRING is in-flight migration territory and must not be cancelled
 * via the public API to avoid creating dual-identity hazards.
 */
const CANCELLABLE_STATES: ReadonlySet<MigrationState> = new Set([
  MigrationState.IDLE,
  MigrationState.PAIRING,
])

/**
 * Pulls the most recent audit-log entries for a session out of SQLite.
 *
 * The audit-log table is owned by the persistence layer and may not yet
 * exist when this module is loaded in isolation (e.g. unit tests with
 * an empty DB). We treat any failure here as "no logs available" rather
 * than propagating it to the caller, since the session payload itself
 * is still valid without them.
 */
function fetchRecentLogs(
  db: import('better-sqlite3').Database,
  sessionId: string,
  limit: number,
): LogEntry[] {
  try {
    const rows = db
      .prepare(
        `SELECT ts, agent, level, message
           FROM audit_log
          WHERE session_id = ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
      ts: number
      agent: string
      level: string
      message: string
    }>

    // Re-sort ascending so the UI can append-render in chronological order.
    return rows
      .map((r) => ({
        ts: Number(r.ts),
        agent: r.agent as LogEntry['agent'],
        level: r.level as LogEntry['level'],
        message: String(r.message),
      }))
      .reverse()
  } catch {
    return []
  }
}

/**
 * Maps a `ZodError` into the JSON body we send with HTTP 400.
 */
function zodErrorBody(err: z.ZodError) {
  return {
    error: 'ValidationError',
    message: 'Request failed schema validation.',
    details: err.flatten(),
  }
}

/**
 * Registers the public REST API under /api/*.
 *
 * The caller is responsible for creating the Fastify instance, wiring
 * CORS / rate-limit (see ./middleware.ts) and starting `listen`. This
 * module is intentionally side-effect free.
 */
export async function registerRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { db, sessionManager } = deps

  // ---- POST /api/sessions ------------------------------------------------
  fastify.post(
    '/api/sessions',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateSessionBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send(zodErrorBody(parsed.error))
      }

      const ttlMs = parsed.data?.ttlMs ?? DEFAULT_SESSION_TTL_MS
      const created = sessionManager.create({ ttlMs })

      const body: CreateSessionResponse = {
        id: created.id,
        code: created.code,
        expiresAt: created.expiresAt,
        dashboardToken: created.dashboardToken,
      }
      return reply.code(201).send(body)
    },
  )

  // ---- GET /api/sessions/:id --------------------------------------------
  fastify.get(
    '/api/sessions/:id',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParamsSchema.safeParse(req.params)
      if (!parsed.success) {
        return reply.code(400).send(zodErrorBody(parsed.error))
      }

      const session = sessionManager.getById(parsed.data.id)
      if (!session) {
        return reply
          .code(404)
          .send({ error: 'NotFound', message: `Session ${parsed.data.id} not found.` })
      }

      const body: GetSessionResponse = {
        id: session.id,
        code: session.code,
        state: session.state,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        completedAt: session.completedAt,
        agents: session.agents,
        recentLogs: fetchRecentLogs(db, session.id, RECENT_LOGS_LIMIT),
      }
      return reply.code(200).send(body)
    },
  )

  // ---- GET /api/sessions?limit=20 ---------------------------------------
  fastify.get(
    '/api/sessions',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListSessionsQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.code(400).send(zodErrorBody(parsed.error))
      }

      const limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT
      const sessions: ListSessionsResponse = sessionManager.listRecent(limit)
      return reply.code(200).send(sessions)
    },
  )

  // ---- DELETE /api/sessions/:id -----------------------------------------
  fastify.delete(
    '/api/sessions/:id',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParamsSchema.safeParse(req.params)
      if (!parsed.success) {
        return reply.code(400).send(zodErrorBody(parsed.error))
      }

      const session = sessionManager.getById(parsed.data.id)
      if (!session) {
        return reply
          .code(404)
          .send({ error: 'NotFound', message: `Session ${parsed.data.id} not found.` })
      }

      if (!CANCELLABLE_STATES.has(session.state)) {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Session in state ${session.state} cannot be cancelled.`,
        })
      }

      const ok = sessionManager.cancel(parsed.data.id)
      if (!ok) {
        // Race: state moved on between the read and the cancel.
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Session could not be cancelled (state changed concurrently).',
        })
      }

      return reply.code(204).send()
    },
  )
}

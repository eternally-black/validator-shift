/**
 * ValidatorShift hub — process entry-point.
 *
 * Wires together:
 *   - SQLite (initDb)              — sessions + audit log
 *   - RoomRegistry                 — in-memory WS rooms
 *   - SessionManager               — code generation + per-session orchestrators
 *   - Fastify (HTTP API)           — POST/GET/DELETE /api/sessions
 *   - ws WebSocketServer           — /ws/session/:code, /ws/dashboard/:id
 *
 * The HTTP and WS servers listen on separate ports (DEFAULT_HUB_HTTP_PORT
 * and DEFAULT_HUB_WS_PORT respectively) — keeping them split lets us put
 * a TLS terminator in front of the WS without it caring about the REST
 * API and vice versa.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Fastify from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  DEFAULT_HUB_HTTP_PORT,
  DEFAULT_HUB_WS_PORT,
} from '@validator-shift/shared/constants'

import { registerCors, registerRateLimit } from './api/middleware.js'
import { registerRoutes } from './api/routes.js'
import { initDb } from './db/schema.js'
import { RoomRegistry } from './ws/rooms.js'
import { handleAgentSocket, handleDashboardSocket } from './ws/handler.js'
import { SessionManager } from './session-manager.js'

// ---------- URL parsing helpers --------------------------------------

const AGENT_PATH_RE = /^\/ws\/session\/([^/?#]+)\/?$/
const DASHBOARD_PATH_RE = /^\/ws\/dashboard\/([^/?#]+)\/?$/

/**
 * Extract the path portion of a request URL without throwing on
 * relative inputs. ws gives us `req.url` as a path-relative string,
 * so we have to provide a synthetic base for `URL`.
 */
function pathOf(rawUrl: string | undefined): string {
  if (!rawUrl) return '/'
  try {
    return new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return rawUrl.split('?')[0] ?? '/'
  }
}

// ---------- Main -----------------------------------------------------

export async function main(): Promise<void> {
  // 1. Open / create the SQLite database. Ensure the parent directory
  //    exists — better-sqlite3 will not create it for us.
  const dbPath = process.env.HUB_DB_PATH ?? './data/hub.db'
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
  } catch {
    // best-effort: a permissions issue here will surface immediately
    // when better-sqlite3 tries to open the file.
  }
  const db = initDb(dbPath)

  // 2. In-memory state.
  const registry = new RoomRegistry()
  const sessionManager = new SessionManager(db, registry)

  // 3. Fastify HTTP server.
  const fastify = Fastify({ logger: true })
  await registerCors(fastify)
  await registerRateLimit(fastify)
  await registerRoutes(fastify, { db, sessionManager })

  const httpPort = process.env.HUB_HTTP_PORT
    ? Number(process.env.HUB_HTTP_PORT)
    : DEFAULT_HUB_HTTP_PORT
  await fastify.listen({ port: httpPort, host: '0.0.0.0' })

  // 4. WS server on its own port. Dispatch by URL pattern.
  const wsPort = process.env.HUB_WS_PORT
    ? Number(process.env.HUB_WS_PORT)
    : DEFAULT_HUB_WS_PORT
  const wsServer = new WebSocketServer({ port: wsPort, host: '0.0.0.0' })

  wsServer.on('connection', (ws: WebSocket, req) => {
    const path = pathOf(req.url)

    const agentMatch = AGENT_PATH_RE.exec(path)
    if (agentMatch) {
      const code = decodeURIComponent(agentMatch[1] ?? '')
      handleAgentSocket(ws, code, {
        db,
        registry,
        orchestrator: {
          handleAgentMessage: (sessionId, role, msg) =>
            sessionManager.handleAgentMessage(sessionId, role, msg),
          handleDashboardMessage: (sessionId, msg) =>
            sessionManager.handleDashboardMessage(sessionId, msg),
          handleAgentDisconnect: (sessionId, role) =>
            sessionManager.handleAgentDisconnect(sessionId, role),
        },
      })
      return
    }

    const dashboardMatch = DASHBOARD_PATH_RE.exec(path)
    if (dashboardMatch) {
      const id = decodeURIComponent(dashboardMatch[1] ?? '')
      handleDashboardSocket(ws, id, {
        db,
        registry,
        orchestrator: {
          handleAgentMessage: (sessionId, role, msg) =>
            sessionManager.handleAgentMessage(sessionId, role, msg),
          handleDashboardMessage: (sessionId, msg) =>
            sessionManager.handleDashboardMessage(sessionId, msg),
          handleAgentDisconnect: (sessionId, role) =>
            sessionManager.handleAgentDisconnect(sessionId, role),
        },
      })
      return
    }

    // Unknown path — close with HTTP-style 1008 policy violation.
    try {
      ws.close(1008, 'unknown_path')
    } catch {
      // ignore
    }
  })

  fastify.log.info({ port: wsPort }, 'WebSocket server listening')

  // 5. Graceful shutdown.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    fastify.log.info({ signal }, 'shutdown initiated')

    // Close all open rooms first so agents/dashboards see a clean close.
    registry.forEach((room) => room.closeAll('hub_shutdown'))

    // Close the WS server. We wrap in a promise because ws's close()
    // is callback-based.
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve())
    })

    try {
      await fastify.close()
    } catch (err) {
      fastify.log.error({ err }, 'fastify close failed')
    }

    try {
      db.close()
    } catch (err) {
      fastify.log.error({ err }, 'db close failed')
    }

    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('hub failed to start:', err)
  process.exit(1)
})

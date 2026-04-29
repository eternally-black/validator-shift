/**
 * ValidatorShift hub — process entry-point.
 *
 * Single Fastify server hosts BOTH the REST API (POST/GET/DELETE
 * /api/sessions, etc.) and the WebSocket endpoints (/ws/session/:code,
 * /ws/dashboard/:id) on one TCP port. This works behind any HTTP/WS-aware
 * reverse proxy (Railway, fly.io, Cloudflare, nginx) without needing two
 * public hostnames or a TCP-passthrough port.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Fastify, { type FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'

import { DEFAULT_HUB_HTTP_PORT } from '@validator-shift/shared/constants'

import { registerCors, registerRateLimit } from './api/middleware.js'
import { registerRoutes } from './api/routes.js'
import { initDb } from './db/schema.js'
import { RoomRegistry } from './ws/rooms.js'
import { handleAgentSocket, handleDashboardSocket } from './ws/handler.js'
import { SessionManager } from './session-manager.js'

// ---------- Main -----------------------------------------------------

export async function main(): Promise<void> {
  // 1. Open / create the SQLite database. Ensure the parent directory
  //    exists — better-sqlite3 will not create it for us.
  const dbPath = process.env.HUB_DB_PATH ?? './data/hub.db'
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
  } catch {
    // best-effort
  }
  const db = initDb(dbPath)

  // 2. In-memory state.
  const registry = new RoomRegistry()
  const sessionManager = new SessionManager(db, registry)

  // 3. Fastify HTTP+WS server (single port).
  const fastify = Fastify({ logger: true })
  await registerCors(fastify)
  await registerRateLimit(fastify)
  await fastify.register(websocket)
  await registerRoutes(fastify, { db, sessionManager })

  const handlerDeps = {
    db,
    registry,
    orchestrator: {
      handleAgentMessage: sessionManager.handleAgentMessage.bind(sessionManager),
      handleDashboardMessage: sessionManager.handleDashboardMessage.bind(sessionManager),
      handleAgentDisconnect: sessionManager.handleAgentDisconnect.bind(sessionManager),
    },
    verifyDashboardToken: sessionManager.verifyDashboardToken.bind(sessionManager),
  }

  function clientIp(req: FastifyRequest): string | undefined {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0]?.trim()
    }
    return req.ip
  }

  // 4. WebSocket routes on the same Fastify instance.
  fastify.get<{ Params: { code: string } }>(
    '/ws/session/:code',
    { websocket: true },
    (socket: WebSocket, req) => {
      const code = decodeURIComponent(req.params.code)
      handleAgentSocket(socket, code, handlerDeps, clientIp(req))
    },
  )

  fastify.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/ws/dashboard/:id',
    { websocket: true },
    (socket: WebSocket, req) => {
      const id = decodeURIComponent(req.params.id)
      const token = req.query.token
      handleDashboardSocket(socket, id, token, handlerDeps, clientIp(req))
    },
  )

  // 5. Listen — Railway / fly / heroku style PORT env wins over the
  //    legacy HUB_HTTP_PORT for cloud deployments.
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : process.env.HUB_HTTP_PORT
      ? Number(process.env.HUB_HTTP_PORT)
      : DEFAULT_HUB_HTTP_PORT
  await fastify.listen({ port, host: '0.0.0.0' })

  // 6. Graceful shutdown.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    fastify.log.info({ signal }, 'shutdown initiated')

    registry.forEach((room) => room.closeAll('hub_shutdown'))

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

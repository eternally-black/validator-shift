import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

/**
 * Registers CORS on the given Fastify instance. Origin is read from
 * `process.env.CORS_ORIGIN`. **Defaults to deny** (no `Access-Control-Allow-Origin`
 * header emitted) — operators must explicitly allowlist origins.
 *
 * Multiple origins may be supplied as a comma-separated list.
 * Wildcard `*` is supported but discouraged for production: combined with the
 * unauthenticated session API, it enables cross-origin abort/spam attacks.
 */
export async function registerCors(fastify: FastifyInstance): Promise<void> {
  const raw = process.env.CORS_ORIGIN
  if (!raw) {
    // No CORS_ORIGIN set → don't register CORS at all (default deny).
    return
  }

  let origin: string | string[] | boolean
  if (raw === '*') {
    origin = true
  } else if (raw.includes(',')) {
    origin = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } else {
    origin = raw
  }

  await fastify.register(cors, {
    origin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: false,
  })
}

/**
 * Registers a per-IP rate limiter capped at 60 requests/minute.
 */
export async function registerRateLimit(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })
}

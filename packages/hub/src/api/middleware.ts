import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

/**
 * Registers permissive-by-default CORS on the given Fastify instance.
 * Origin is read from `process.env.CORS_ORIGIN`, falling back to '*'.
 *
 * Multiple origins may be supplied as a comma-separated list.
 */
export async function registerCors(fastify: FastifyInstance): Promise<void> {
  const raw = process.env.CORS_ORIGIN ?? '*'

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

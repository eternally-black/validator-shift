import { z } from 'zod'
import { MigrationState, type AgentRole } from '@validator-shift/shared'

/**
 * Path params: { id: string }
 */
export const SessionIdParamsSchema = z.object({
  id: z.string().min(1),
})
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>

/**
 * Query params: { limit?: number }
 */
export const ListSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
})
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>

/**
 * Body for POST /api/sessions (currently empty — server allocates id/code).
 */
export const CreateSessionBodySchema = z
  .object({
    ttlMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional()
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>

/**
 * Response for POST /api/sessions
 */
export const CreateSessionResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  expiresAt: z.number().int(),
})
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

/**
 * Migration state — mirrors @validator-shift/shared MigrationState enum.
 */
export const MigrationStateSchema = z.nativeEnum(MigrationState)

/**
 * Agent status in a session.
 */
export const AgentRoleSchema = z.enum(['source', 'target']) satisfies z.ZodType<AgentRole>
export const AgentStatusSchema = z.object({
  role: AgentRoleSchema,
  connected: z.boolean(),
  publicKey: z.string().optional(),
  lastSeen: z.number().int().optional(),
})

/**
 * Recent log entry attached to GetSession response.
 */
export const LogEntrySchema = z.object({
  ts: z.number().int(),
  agent: z.union([AgentRoleSchema, z.literal('hub')]),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
})

/**
 * Response for GET /api/sessions/:id
 */
export const GetSessionResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  state: MigrationStateSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  completedAt: z.number().int().optional(),
  agents: z.array(AgentStatusSchema),
  recentLogs: z.array(LogEntrySchema),
})
export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>

/**
 * Plain Session shape returned by GET /api/sessions list endpoint.
 */
export const SessionSchema = z.object({
  id: z.string(),
  code: z.string(),
  state: MigrationStateSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  completedAt: z.number().int().optional(),
})
export const ListSessionsResponseSchema = z.array(SessionSchema)
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>

/**
 * Generic error response shape used by the routes for 4xx replies.
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

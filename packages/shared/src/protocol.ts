import { z } from 'zod'
import { MigrationState } from './types'

// ---------- Reusable sub-schemas ----------

const AgentRoleSchema = z.enum(['source', 'target'])

const MigrationStateSchema = z.nativeEnum(MigrationState)

const PreflightCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
})

const StepResultSchema = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
})

const AgentStatusSchema = z.object({
  role: AgentRoleSchema,
  connected: z.boolean(),
  publicKey: z.string().optional(),
  lastSeen: z.number().optional(),
})

const MigrationSummarySchema = z.object({
  startedAt: z.number(),
  finishedAt: z.number(),
  durationMs: z.number(),
  stepsCompleted: z.number(),
  finalState: MigrationStateSchema,
  sourcePubkey: z.string().optional(),
  targetPubkey: z.string().optional(),
})

// ---------- Agent → Hub ----------

export const AgentHelloSchema = z.object({
  type: z.literal('agent:hello'),
  role: AgentRoleSchema,
  sessionCode: z.string(),
  publicKey: z.string(),
})

export const AgentSasConfirmedSchema = z.object({
  type: z.literal('agent:sas_confirmed'),
})

export const AgentPreflightResultSchema = z.object({
  type: z.literal('agent:preflight_result'),
  checks: z.array(PreflightCheckSchema),
})

export const AgentStepCompleteSchema = z.object({
  type: z.literal('agent:step_complete'),
  step: z.number(),
  result: StepResultSchema,
})

export const AgentStepFailedSchema = z.object({
  type: z.literal('agent:step_failed'),
  step: z.number(),
  error: z.string(),
})

export const AgentEncryptedPayloadSchema = z.object({
  type: z.literal('agent:encrypted_payload'),
  payload: z.string(),
  hash: z.string(),
})

export const AgentLogSchema = z.object({
  type: z.literal('agent:log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
})

export const AgentMessageSchema = z.discriminatedUnion('type', [
  AgentHelloSchema,
  AgentSasConfirmedSchema,
  AgentPreflightResultSchema,
  AgentStepCompleteSchema,
  AgentStepFailedSchema,
  AgentEncryptedPayloadSchema,
  AgentLogSchema,
])

export type AgentMessage = z.infer<typeof AgentMessageSchema>

// ---------- Hub → Agent ----------

export const HubPeerConnectedSchema = z.object({
  type: z.literal('hub:peer_connected'),
  peerPublicKey: z.string(),
})

export const HubVerifySasSchema = z.object({
  type: z.literal('hub:verify_sas'),
  sas: z.string(),
})

export const HubRunPreflightSchema = z.object({
  type: z.literal('hub:run_preflight'),
})

export const HubExecuteStepSchema = z.object({
  type: z.literal('hub:execute_step'),
  step: z.number(),
})

export const HubRollbackSchema = z.object({
  type: z.literal('hub:rollback'),
})

export const HubRelayPayloadSchema = z.object({
  type: z.literal('hub:relay_payload'),
  payload: z.string(),
  hash: z.string(),
})

export const HubSessionCancelledSchema = z.object({
  type: z.literal('hub:session_cancelled'),
})

export const HubToAgentMessageSchema = z.discriminatedUnion('type', [
  HubPeerConnectedSchema,
  HubVerifySasSchema,
  HubRunPreflightSchema,
  HubExecuteStepSchema,
  HubRollbackSchema,
  HubRelayPayloadSchema,
  HubSessionCancelledSchema,
])

export type HubToAgentMessage = z.infer<typeof HubToAgentMessageSchema>

// ---------- Hub → Dashboard ----------

export const DashboardStateChangeSchema = z.object({
  type: z.literal('dashboard:state_change'),
  state: MigrationStateSchema,
  prevState: MigrationStateSchema,
})

export const DashboardAgentsStatusSchema = z.object({
  type: z.literal('dashboard:agents_status'),
  source: AgentStatusSchema,
  target: AgentStatusSchema,
})

export const DashboardPreflightUpdateSchema = z.object({
  type: z.literal('dashboard:preflight_update'),
  checks: z.array(PreflightCheckSchema),
})

export const DashboardStepProgressSchema = z.object({
  type: z.literal('dashboard:step_progress'),
  step: z.number(),
  status: z.enum(['running', 'complete', 'failed']),
})

export const DashboardLogSchema = z.object({
  type: z.literal('dashboard:log'),
  agent: AgentRoleSchema,
  level: z.string(),
  message: z.string(),
  ts: z.number(),
})

export const DashboardMigrationCompleteSchema = z.object({
  type: z.literal('dashboard:migration_complete'),
  summary: MigrationSummarySchema,
})

export const HubToDashboardMessageSchema = z.discriminatedUnion('type', [
  DashboardStateChangeSchema,
  DashboardAgentsStatusSchema,
  DashboardPreflightUpdateSchema,
  DashboardStepProgressSchema,
  DashboardLogSchema,
  DashboardMigrationCompleteSchema,
])

export type HubToDashboardMessage = z.infer<typeof HubToDashboardMessageSchema>

// ---------- Dashboard → Hub ----------

export const DashboardStartMigrationSchema = z.object({
  type: z.literal('dashboard:start_migration'),
})

export const DashboardAbortSchema = z.object({
  type: z.literal('dashboard:abort'),
})

export const DashboardConfirmSasSchema = z.object({
  type: z.literal('dashboard:confirm_sas'),
})

export const DashboardMessageSchema = z.discriminatedUnion('type', [
  DashboardStartMigrationSchema,
  DashboardAbortSchema,
  DashboardConfirmSasSchema,
])

export type DashboardMessage = z.infer<typeof DashboardMessageSchema>

// ---------- Combined union for parseMessage ----------

export const AnyMessageSchema = z.union([
  AgentMessageSchema,
  HubToAgentMessageSchema,
  HubToDashboardMessageSchema,
  DashboardMessageSchema,
])

export type AnyMessage = z.infer<typeof AnyMessageSchema>

// ---------- parseMessage helper ----------

export type ParseResult =
  | { ok: true; data: AnyMessage }
  | { ok: false; error: string }

export function parseMessage(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }

  const result = AnyMessageSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, data: result.data }
}

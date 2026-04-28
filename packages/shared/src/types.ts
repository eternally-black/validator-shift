export type AgentRole = 'source' | 'target'

export enum MigrationState {
  IDLE = 'IDLE',
  PAIRING = 'PAIRING',
  PREFLIGHT = 'PREFLIGHT',
  AWAITING_WINDOW = 'AWAITING_WINDOW',
  MIGRATING = 'MIGRATING',
  COMPLETE = 'COMPLETE',
  ROLLBACK = 'ROLLBACK',
  FAILED = 'FAILED',
}

export interface PreflightCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface StepResult {
  ok: boolean
  output?: string
  error?: string
  durationMs: number
}

export interface AgentStatus {
  role: AgentRole
  connected: boolean
  publicKey?: string
  lastSeen?: number
}

export interface MigrationSummary {
  startedAt: number
  finishedAt: number
  durationMs: number
  stepsCompleted: number
  finalState: MigrationState
  sourcePubkey?: string
  targetPubkey?: string
}

export interface Session {
  id: string
  code: string
  state: MigrationState
  createdAt: number
  expiresAt: number
  completedAt?: number
}

export interface LogEntry {
  ts: number
  agent: AgentRole | 'hub'
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface StepProgress {
  step: number
  status: 'pending' | 'running' | 'complete' | 'failed'
}

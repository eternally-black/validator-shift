/**
 * Typed query helpers for the ValidatorShift hub SQLite store.
 *
 * Reminder: NO PRIVATE KEYS pass through this module. Sessions, audit logs,
 * and migration step status only.
 */
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import {
  MigrationState,
  type LogEntry,
  type Session,
} from '@validator-shift/shared'

// ---------- Public types ---------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'complete' | 'failed'

export interface RecordedStep {
  sessionId: string
  stepNumber: number
  status: StepStatus
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

export interface CreateSessionOpts {
  code: string
  ttlMs: number
}

export interface RecordStepOpts {
  sessionId: string
  stepNumber: number
  status: StepStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

// ---------- Row shapes (raw SQLite) ---------------------------------------

interface SessionRow {
  id: string
  code: string
  state: string
  created_at: number
  expires_at: number
  completed_at: number | null
}

interface AuditRow {
  ts: number
  agent: string
  level: string
  message: string
}

interface StepRow {
  session_id: string
  step_number: number
  status: string
  started_at: number | null
  finished_at: number | null
  error: string | null
}

// ---------- Prepared-statement memoization --------------------------------

interface Stmts {
  insertSession: Database.Statement
  selectSessionById: Database.Statement
  selectSessionByCode: Database.Statement
  updateSessionState: Database.Statement
  markSessionCompleted: Database.Statement
  insertAudit: Database.Statement
  selectAuditBySession: Database.Statement
  selectAuditBySessionLimited: Database.Statement
  upsertStep: Database.Statement
  selectStepsBySession: Database.Statement
  selectRecentSessions: Database.Statement
}

const stmtCache = new WeakMap<Database.Database, Stmts>()

function stmts(db: Database.Database): Stmts {
  let s = stmtCache.get(db)
  if (s) return s

  s = {
    insertSession: db.prepare(
      `INSERT INTO sessions (id, code, state, created_at, expires_at, completed_at)
       VALUES (@id, @code, @state, @created_at, @expires_at, NULL)`,
    ),
    selectSessionById: db.prepare(
      `SELECT id, code, state, created_at, expires_at, completed_at
         FROM sessions WHERE id = ?`,
    ),
    selectSessionByCode: db.prepare(
      `SELECT id, code, state, created_at, expires_at, completed_at
         FROM sessions WHERE code = ?`,
    ),
    updateSessionState: db.prepare(
      `UPDATE sessions SET state = ? WHERE id = ?`,
    ),
    markSessionCompleted: db.prepare(
      `UPDATE sessions SET completed_at = ? WHERE id = ?`,
    ),
    insertAudit: db.prepare(
      `INSERT INTO audit_log (session_id, ts, level, agent, message)
       VALUES (@session_id, @ts, @level, @agent, @message)`,
    ),
    selectAuditBySession: db.prepare(
      `SELECT ts, agent, level, message
         FROM audit_log WHERE session_id = ? ORDER BY ts ASC, id ASC`,
    ),
    selectAuditBySessionLimited: db.prepare(
      `SELECT ts, agent, level, message
         FROM audit_log WHERE session_id = ?
         ORDER BY ts ASC, id ASC LIMIT ?`,
    ),
    upsertStep: db.prepare(
      `INSERT INTO migration_steps
         (session_id, step_number, status, started_at, finished_at, error)
       VALUES (@session_id, @step_number, @status, @started_at, @finished_at, @error)
       ON CONFLICT(session_id, step_number) DO UPDATE SET
         status      = excluded.status,
         started_at  = COALESCE(excluded.started_at,  migration_steps.started_at),
         finished_at = COALESCE(excluded.finished_at, migration_steps.finished_at),
         error       = COALESCE(excluded.error,       migration_steps.error)`,
    ),
    selectStepsBySession: db.prepare(
      `SELECT session_id, step_number, status, started_at, finished_at, error
         FROM migration_steps WHERE session_id = ? ORDER BY step_number ASC`,
    ),
    selectRecentSessions: db.prepare(
      `SELECT id, code, state, created_at, expires_at, completed_at
         FROM sessions ORDER BY created_at DESC LIMIT ?`,
    ),
  }
  stmtCache.set(db, s)
  return s
}

// ---------- Row -> domain mappers -----------------------------------------

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    code: row.code,
    state: row.state as MigrationState,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.completed_at != null ? { completedAt: row.completed_at } : {}),
  }
}

function rowToLog(row: AuditRow): LogEntry {
  return {
    ts: row.ts,
    agent: row.agent as LogEntry['agent'],
    level: row.level as LogEntry['level'],
    message: row.message,
  }
}

function rowToStep(row: StepRow): RecordedStep {
  return {
    sessionId: row.session_id,
    stepNumber: row.step_number,
    status: row.status as StepStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

// ---------- Sessions -------------------------------------------------------

export function createSession(
  db: Database.Database,
  opts: CreateSessionOpts,
): Session {
  const id = nanoid()
  const now = Date.now()
  const session: Session = {
    id,
    code: opts.code,
    state: MigrationState.IDLE,
    createdAt: now,
    expiresAt: now + opts.ttlMs,
  }
  stmts(db).insertSession.run({
    id: session.id,
    code: session.code,
    state: session.state,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
  })
  return session
}

export function getSessionById(
  db: Database.Database,
  id: string,
): Session | null {
  const row = stmts(db).selectSessionById.get(id) as SessionRow | undefined
  return row ? rowToSession(row) : null
}

export function getSessionByCode(
  db: Database.Database,
  code: string,
): Session | null {
  const row = stmts(db).selectSessionByCode.get(code) as SessionRow | undefined
  return row ? rowToSession(row) : null
}

export function updateSessionState(
  db: Database.Database,
  id: string,
  state: MigrationState,
): void {
  stmts(db).updateSessionState.run(state, id)
}

export function markSessionCompleted(
  db: Database.Database,
  id: string,
  completedAt: number,
): void {
  stmts(db).markSessionCompleted.run(completedAt, id)
}

export function listRecentSessions(
  db: Database.Database,
  limit: number,
): Session[] {
  const rows = stmts(db).selectRecentSessions.all(limit) as SessionRow[]
  return rows.map(rowToSession)
}

// ---------- Audit log ------------------------------------------------------

export interface AuditEntryInput extends LogEntry {
  sessionId: string
}

export function appendAuditLog(
  db: Database.Database,
  entry: AuditEntryInput,
): void {
  stmts(db).insertAudit.run({
    session_id: entry.sessionId,
    ts: entry.ts,
    level: entry.level,
    agent: entry.agent,
    message: entry.message,
  })
}

export function getAuditLogs(
  db: Database.Database,
  sessionId: string,
  limit?: number,
): LogEntry[] {
  const rows =
    limit == null
      ? (stmts(db).selectAuditBySession.all(sessionId) as AuditRow[])
      : (stmts(db).selectAuditBySessionLimited.all(
          sessionId,
          limit,
        ) as AuditRow[])
  return rows.map(rowToLog)
}

// ---------- Migration steps -----------------------------------------------

export function recordStep(
  db: Database.Database,
  opts: RecordStepOpts,
): void {
  stmts(db).upsertStep.run({
    session_id: opts.sessionId,
    step_number: opts.stepNumber,
    status: opts.status,
    started_at: opts.startedAt ?? null,
    finished_at: opts.finishedAt ?? null,
    error: opts.error ?? null,
  })
}

export function getStepsFor(
  db: Database.Database,
  sessionId: string,
): RecordedStep[] {
  const rows = stmts(db).selectStepsBySession.all(sessionId) as StepRow[]
  return rows.map(rowToStep)
}

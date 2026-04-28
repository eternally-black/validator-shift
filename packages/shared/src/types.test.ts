import { describe, it, expect } from 'vitest'
import { MigrationState } from './types.js'
import type {
  PreflightCheck,
  StepResult,
  AgentStatus,
  MigrationSummary,
  Session,
  LogEntry,
  StepProgress,
  AgentRole,
} from './types.js'

describe('MigrationState enum', () => {
  it('has exact set of values in declared order (snapshot)', () => {
    expect(Object.values(MigrationState)).toEqual([
      'IDLE',
      'PAIRING',
      'PREFLIGHT',
      'AWAITING_WINDOW',
      'MIGRATING',
      'COMPLETE',
      'ROLLBACK',
      'FAILED',
    ])
  })

  it('has exact set of keys (catches accidental rename)', () => {
    expect(Object.keys(MigrationState)).toEqual([
      'IDLE',
      'PAIRING',
      'PREFLIGHT',
      'AWAITING_WINDOW',
      'MIGRATING',
      'COMPLETE',
      'ROLLBACK',
      'FAILED',
    ])
  })

  it('each key maps to its string literal', () => {
    expect(MigrationState.IDLE).toBe('IDLE')
    expect(MigrationState.PAIRING).toBe('PAIRING')
    expect(MigrationState.PREFLIGHT).toBe('PREFLIGHT')
    expect(MigrationState.AWAITING_WINDOW).toBe('AWAITING_WINDOW')
    expect(MigrationState.MIGRATING).toBe('MIGRATING')
    expect(MigrationState.COMPLETE).toBe('COMPLETE')
    expect(MigrationState.ROLLBACK).toBe('ROLLBACK')
    expect(MigrationState.FAILED).toBe('FAILED')
  })
})

describe('PreflightCheck shape', () => {
  it('accepts minimal required fields and exposes expected keys', () => {
    const check: PreflightCheck = { name: 'cli_installed', ok: true }
    expect(Object.keys(check).sort()).toEqual(['name', 'ok'])
  })

  it('accepts optional detail', () => {
    const check: PreflightCheck = {
      name: 'caught_up',
      ok: false,
      detail: 'behind by 100 slots',
    }
    expect(Object.keys(check).sort()).toEqual(['detail', 'name', 'ok'])
    expect(typeof check.name).toBe('string')
    expect(typeof check.ok).toBe('boolean')
    expect(typeof check.detail).toBe('string')
  })
})

describe('StepResult shape', () => {
  it('exposes ok and durationMs as required, output/error optional', () => {
    const result: StepResult = {
      ok: true,
      output: 'done',
      durationMs: 1234,
    }
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'ok', 'output'])
    expect(typeof result.ok).toBe('boolean')
    expect(typeof result.durationMs).toBe('number')
  })

  it('accepts error variant', () => {
    const result: StepResult = { ok: false, error: 'boom', durationMs: 0 }
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'error', 'ok'])
  })
})

describe('AgentStatus shape', () => {
  it('has role/connected required, publicKey/lastSeen optional', () => {
    const status: AgentStatus = {
      role: 'source',
      connected: true,
      publicKey: 'pubkey-1',
      lastSeen: 1700000000,
    }
    expect(Object.keys(status).sort()).toEqual([
      'connected',
      'lastSeen',
      'publicKey',
      'role',
    ])
    const role: AgentRole = status.role
    expect(['source', 'target']).toContain(role)
  })

  it('works without optional fields', () => {
    const status: AgentStatus = { role: 'target', connected: false }
    expect(Object.keys(status).sort()).toEqual(['connected', 'role'])
  })
})

describe('MigrationSummary shape', () => {
  it('contains all expected required fields', () => {
    const summary: MigrationSummary = {
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      stepsCompleted: 9,
      finalState: MigrationState.COMPLETE,
    }
    expect(Object.keys(summary).sort()).toEqual([
      'durationMs',
      'finalState',
      'finishedAt',
      'startedAt',
      'stepsCompleted',
    ])
    expect(summary.finalState).toBe('COMPLETE')
  })

  it('accepts optional pubkey fields', () => {
    const summary: MigrationSummary = {
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      stepsCompleted: 9,
      finalState: MigrationState.COMPLETE,
      sourcePubkey: 'src',
      targetPubkey: 'tgt',
    }
    expect(Object.keys(summary)).toContain('sourcePubkey')
    expect(Object.keys(summary)).toContain('targetPubkey')
  })
})

describe('Session shape', () => {
  it('has id/code/state/createdAt/expiresAt required', () => {
    const session: Session = {
      id: 'sess-1',
      code: 'X7K9M2',
      state: MigrationState.IDLE,
      createdAt: 100,
      expiresAt: 400,
    }
    expect(Object.keys(session).sort()).toEqual([
      'code',
      'createdAt',
      'expiresAt',
      'id',
      'state',
    ])
  })

  it('accepts completedAt optional', () => {
    const session: Session = {
      id: 'sess-1',
      code: 'X7K9M2',
      state: MigrationState.COMPLETE,
      createdAt: 100,
      expiresAt: 400,
      completedAt: 350,
    }
    expect(Object.keys(session)).toContain('completedAt')
  })
})

describe('LogEntry shape', () => {
  it('has ts/agent/level/message required', () => {
    const entry: LogEntry = {
      ts: 123,
      agent: 'source',
      level: 'info',
      message: 'hi',
    }
    expect(Object.keys(entry).sort()).toEqual([
      'agent',
      'level',
      'message',
      'ts',
    ])
  })

  it('accepts agent="hub" and level variants', () => {
    const warn: LogEntry = { ts: 1, agent: 'hub', level: 'warn', message: 'w' }
    const err: LogEntry = {
      ts: 2,
      agent: 'target',
      level: 'error',
      message: 'e',
    }
    expect(warn.agent).toBe('hub')
    expect(err.level).toBe('error')
  })
})

describe('StepProgress shape', () => {
  it('has step number and status', () => {
    const p: StepProgress = { step: 1, status: 'pending' }
    expect(Object.keys(p).sort()).toEqual(['status', 'step'])
    expect(typeof p.step).toBe('number')
  })

  it('accepts all status variants', () => {
    const states: StepProgress['status'][] = [
      'pending',
      'running',
      'complete',
      'failed',
    ]
    for (const s of states) {
      const p: StepProgress = { step: 1, status: s }
      expect(p.status).toBe(s)
    }
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MigrationState, type PreflightCheck } from '@validator-shift/shared'
import {
  MigrationOrchestrator,
  InvalidTransitionError,
} from './state-machine.js'

const okCheck = (name: string): PreflightCheck => ({ name, ok: true })
const failCheck = (name: string, detail = 'bad'): PreflightCheck => ({
  name,
  ok: false,
  detail,
})

const okResult = { ok: true, durationMs: 10 }

/**
 * Drive an orchestrator from IDLE all the way to MIGRATING (step 1
 * dispatched). Used by most happy-path tests.
 */
function driveToMigrating(o: MigrationOrchestrator) {
  o.start()
  o.onAgentConnected('source')
  o.onAgentConnected('target')
  o.onSasConfirmed('source')
  o.onSasConfirmed('target')
  o.onPreflightResult('source', [okCheck('source-cli')])
  o.onPreflightResult('target', [okCheck('target-cli')])
  o.startMigration()
}

describe('MigrationOrchestrator / lifecycle', () => {
  let o: MigrationOrchestrator
  beforeEach(() => {
    o = new MigrationOrchestrator('session-1')
  })

  it('starts in IDLE', () => {
    expect(o.state).toBe(MigrationState.IDLE)
  })

  it('throws if start() is called twice', () => {
    o.start()
    expect(() => o.start()).toThrow(/already started/)
  })

  it('exposes sessionId', () => {
    expect(o.sessionId).toBe('session-1')
  })
})

describe('MigrationOrchestrator / pairing transitions', () => {
  let o: MigrationOrchestrator
  beforeEach(() => {
    o = new MigrationOrchestrator('s')
    o.start()
  })

  it('does not move to PAIRING with only one agent connected', () => {
    o.onAgentConnected('source')
    expect(o.state).toBe(MigrationState.IDLE)
  })

  it('moves IDLE → PAIRING once both agents connected', () => {
    const onChange = vi.fn()
    o.on('state_change', onChange)
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    expect(o.state).toBe(MigrationState.PAIRING)
    expect(onChange).toHaveBeenCalledWith({
      from: MigrationState.IDLE,
      to: MigrationState.PAIRING,
    })
  })

  it('SAS confirmation from one agent alone does not advance', () => {
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    o.onSasConfirmed('source')
    expect(o.state).toBe(MigrationState.PAIRING)
  })

  it('SAS from both agents advances PAIRING → PREFLIGHT', () => {
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    o.onSasConfirmed('source')
    o.onSasConfirmed('target')
    expect(o.state).toBe(MigrationState.PREFLIGHT)
  })
})

describe('MigrationOrchestrator / preflight transitions', () => {
  let o: MigrationOrchestrator
  beforeEach(() => {
    o = new MigrationOrchestrator('s')
    o.start()
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    o.onSasConfirmed('source')
    o.onSasConfirmed('target')
  })

  it('all-ok preflight from both agents → AWAITING_WINDOW', () => {
    o.onPreflightResult('source', [okCheck('a'), okCheck('b')])
    o.onPreflightResult('target', [okCheck('c')])
    expect(o.state).toBe(MigrationState.AWAITING_WINDOW)
  })

  it('any failed preflight check → FAILED with session_failed', () => {
    const onFailed = vi.fn()
    o.on('session_failed', onFailed)
    o.onPreflightResult('source', [okCheck('a')])
    o.onPreflightResult('target', [failCheck('disk', 'low')])
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onFailed).toHaveBeenCalled()
    expect(onFailed.mock.calls[0][0].reason).toMatch(/disk/)
  })

  it('only one agent reporting preflight does not advance', () => {
    o.onPreflightResult('source', [okCheck('a')])
    expect(o.state).toBe(MigrationState.PREFLIGHT)
  })
})

describe('MigrationOrchestrator / migrating + steps', () => {
  let o: MigrationOrchestrator
  beforeEach(() => {
    o = new MigrationOrchestrator('s')
  })

  it('emits execute_step for step 1 when MIGRATING starts', () => {
    const onExec = vi.fn()
    o.on('execute_step', onExec)
    driveToMigrating(o)
    expect(o.state).toBe(MigrationState.MIGRATING)
    expect(onExec).toHaveBeenCalledWith({ role: 'source', step: 1 })
  })

  it('advances through all 9 steps and emits session_complete', () => {
    const onExec = vi.fn()
    const onComplete = vi.fn()
    o.on('execute_step', onExec)
    o.on('session_complete', onComplete)
    driveToMigrating(o)
    for (let step = 1; step <= 9; step += 1) {
      o.onStepComplete(step, okResult)
    }
    expect(o.state).toBe(MigrationState.COMPLETE)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0].stepsCompleted).toBe(9)
    // 9 dispatches: step 1 on entry to MIGRATING, then 2..9 after each complete
    expect(onExec).toHaveBeenCalledTimes(9)
  })

  it('startMigration from any non-AWAITING_WINDOW state throws', () => {
    o.start()
    expect(() => o.startMigration()).toThrow(InvalidTransitionError)
  })
})

describe('MigrationOrchestrator / step failures', () => {
  it('step 1 failure → FAILED (no rollback)', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    const onFailed = vi.fn()
    o.on('rollback', onRollback)
    o.on('session_failed', onFailed)
    driveToMigrating(o)
    o.onStepFailed(1, 'restart window timeout')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalled()
  })

  it('step 4 failure → ROLLBACK → FAILED, emits all rollback steps', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    const onFailed = vi.fn()
    const onState = vi.fn()
    o.on('rollback', onRollback)
    o.on('session_failed', onFailed)
    o.on('state_change', onState)
    driveToMigrating(o)
    // advance through steps 1..3 successfully
    o.onStepComplete(1, okResult)
    o.onStepComplete(2, okResult)
    o.onStepComplete(3, okResult)
    o.onStepFailed(4, 'transfer hash mismatch')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).toHaveBeenCalledTimes(4)
    expect(onFailed).toHaveBeenCalled()
    // we should have observed a ROLLBACK transition
    const rollbackTransition = onState.mock.calls.find(
      ([p]) => p.to === MigrationState.ROLLBACK,
    )
    expect(rollbackTransition).toBeTruthy()
  })

  it('out-of-order onStepComplete is ignored (defensive)', () => {
    const o = new MigrationOrchestrator('s')
    driveToMigrating(o)
    // currentStep is 1; reporting step 5 done shouldn't advance.
    o.onStepComplete(5, okResult)
    expect(o.currentStep).toBe(1)
  })
})

describe('MigrationOrchestrator / abort', () => {
  it('abort from IDLE → FAILED', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    const onFailed = vi.fn()
    o.on('session_failed', onFailed)
    o.abort('user cancelled')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onFailed).toHaveBeenCalled()
  })

  it('abort from MIGRATING (past step 2) → ROLLBACK → FAILED', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    o.on('rollback', onRollback)
    driveToMigrating(o)
    o.onStepComplete(1, okResult)
    o.onStepComplete(2, okResult) // currentStep = 3
    o.abort('operator stopped')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).toHaveBeenCalled()
  })

  it('abort from MIGRATING at step 1 → FAILED (no rollback needed)', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    o.on('rollback', onRollback)
    driveToMigrating(o)
    // currentStep is 1, no state mutated yet
    o.abort('operator stopped')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).not.toHaveBeenCalled()
  })

  it('abort from a terminal state is a no-op', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    o.abort('first')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(() => o.abort('second')).not.toThrow()
    expect(o.state).toBe(MigrationState.FAILED)
  })
})

describe('MigrationOrchestrator / disconnects', () => {
  it('source disconnect during PAIRING → IDLE (and resets SAS)', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    o.onSasConfirmed('source')
    o.onAgentDisconnected('source')
    expect(o.state).toBe(MigrationState.IDLE)
    // re-pair: SAS state should have reset, so a single confirmation
    // must not pop us into PREFLIGHT.
    o.onAgentConnected('source')
    expect(o.state).toBe(MigrationState.PAIRING)
    o.onSasConfirmed('target')
    expect(o.state).toBe(MigrationState.PAIRING)
  })

  it('disconnect during PREFLIGHT → IDLE', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    o.onSasConfirmed('source')
    o.onSasConfirmed('target')
    expect(o.state).toBe(MigrationState.PREFLIGHT)
    o.onAgentDisconnected('target')
    expect(o.state).toBe(MigrationState.IDLE)
  })

  it('source disconnect during MIGRATING before step 5 → ROLLBACK', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    o.on('rollback', onRollback)
    driveToMigrating(o)
    o.onStepComplete(1, okResult)
    o.onStepComplete(2, okResult)
    o.onStepComplete(3, okResult) // currentStep = 4, < 5
    o.onAgentDisconnected('source')
    expect(o.state).toBe(MigrationState.FAILED) // ROLLBACK → FAILED
    expect(onRollback).toHaveBeenCalled()
  })

  it('target disconnect after step 5 → critical_alert, stays in MIGRATING', () => {
    const o = new MigrationOrchestrator('s')
    const onAlert = vi.fn()
    o.on('critical_alert', onAlert)
    driveToMigrating(o)
    for (let step = 1; step <= 5; step += 1) o.onStepComplete(step, okResult)
    // currentStep is now 6 (>= 5)
    o.onAgentDisconnected('target')
    expect(o.state).toBe(MigrationState.MIGRATING)
    expect(onAlert).toHaveBeenCalled()
    expect(onAlert.mock.calls[0][0].reason).toMatch(/manual intervention/)
  })

  it('source disconnect after step 5 does not auto-rollback', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    o.on('rollback', onRollback)
    driveToMigrating(o)
    for (let step = 1; step <= 5; step += 1) o.onStepComplete(step, okResult)
    o.onAgentDisconnected('source')
    // source-side rollback isn't safe at this point either, since the
    // keypair has already moved. We stay put and wait for the operator.
    expect(o.state).toBe(MigrationState.MIGRATING)
    expect(onRollback).not.toHaveBeenCalled()
  })
})

describe('MigrationOrchestrator / forbidden transitions', () => {
  it('startMigration from IDLE throws InvalidTransitionError', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    expect(() => o.startMigration()).toThrow(InvalidTransitionError)
  })

  it('startMigration from PAIRING throws InvalidTransitionError', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    o.onAgentConnected('source')
    o.onAgentConnected('target')
    expect(() => o.startMigration()).toThrow(InvalidTransitionError)
  })

  it('terminal states reject further transitions internally', () => {
    const o = new MigrationOrchestrator('s')
    o.start()
    o.abort('done')
    expect(o.state).toBe(MigrationState.FAILED)
    // late events on terminal state are ignored without throwing
    expect(() => o.onAgentConnected('source')).not.toThrow()
    expect(() => o.onSasConfirmed('source')).not.toThrow()
    expect(() => o.onStepComplete(1, okResult)).not.toThrow()
    expect(o.state).toBe(MigrationState.FAILED)
  })
})

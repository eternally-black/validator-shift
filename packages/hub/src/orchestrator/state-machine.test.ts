import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  MigrationState,
  type AgentRole,
  type PreflightCheck,
} from '@validator-shift/shared'
import {
  MigrationOrchestrator,
  InvalidTransitionError,
} from './state-machine.js'
import { BILATERAL_STEPS, getExecutor } from './steps.js'

const okCheck = (name: string): PreflightCheck => ({ name, ok: true })
const failCheck = (name: string, detail = 'bad'): PreflightCheck => ({
  name,
  ok: false,
  detail,
})

const okResult = { ok: true, durationMs: 10 }

/**
 * Ack a step completion. For bilateral steps both source and target
 * acks are required to advance — passing both keeps tests focused on
 * lifecycle rather than two-phase plumbing.
 */
function ackStep(o: MigrationOrchestrator, step: number): void {
  if (BILATERAL_STEPS.has(step)) {
    o.onStepComplete(step, 'source', okResult)
    o.onStepComplete(step, 'target', okResult)
  } else {
    o.onStepComplete(step, getExecutor(step), okResult)
  }
}

function failStep(
  o: MigrationOrchestrator,
  step: number,
  role: AgentRole,
  err: string,
): void {
  o.onStepFailed(step, role, err)
}

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
      ackStep(o, step)
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
    failStep(o, 1, 'source', 'restart window timeout')
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
    ackStep(o, 1)
    ackStep(o, 2)
    ackStep(o, 3)
    failStep(o, 4, 'target', 'transfer hash mismatch')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).toHaveBeenCalledTimes(4)
    expect(onFailed).toHaveBeenCalled()
    const rollbackTransition = onState.mock.calls.find(
      ([p]) => p.to === MigrationState.ROLLBACK,
    )
    expect(rollbackTransition).toBeTruthy()
  })

  it('bilateral step waits for BOTH agents before advancing', () => {
    const o = new MigrationOrchestrator('s')
    const onExec = vi.fn()
    o.on('execute_step', onExec)
    driveToMigrating(o)
    ackStep(o, 1)
    ackStep(o, 2)
    ackStep(o, 3)
    onExec.mockClear()
    // Source acks step 4 first — orchestrator must NOT dispatch step 5 yet.
    o.onStepComplete(4, 'source', okResult)
    expect(o.currentStep).toBe(4)
    expect(onExec).not.toHaveBeenCalled()
    // Target acks step 4 — now the gate opens.
    o.onStepComplete(4, 'target', okResult)
    expect(o.currentStep).toBe(5)
    expect(onExec).toHaveBeenCalledWith({ role: 'source', step: 5 })
  })

  it('bilateral step fails on target after source ok → rollback', () => {
    const o = new MigrationOrchestrator('s')
    const onRollback = vi.fn()
    o.on('rollback', onRollback)
    driveToMigrating(o)
    ackStep(o, 1)
    ackStep(o, 2)
    ackStep(o, 3)
    o.onStepComplete(4, 'source', okResult)
    // target reports failure on the same step → must rollback even though
    // source has already acked OK.
    failStep(o, 4, 'target', 'tower hash mismatch')
    expect(o.state).toBe(MigrationState.FAILED)
    expect(onRollback).toHaveBeenCalled()
  })

  it('out-of-order onStepComplete is ignored (defensive)', () => {
    const o = new MigrationOrchestrator('s')
    driveToMigrating(o)
    // currentStep is 1; reporting step 5 done shouldn't advance.
    o.onStepComplete(5, 'source', okResult)
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
    ackStep(o, 1)
    ackStep(o, 2) // currentStep = 3
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
    ackStep(o, 1)
    ackStep(o, 2)
    ackStep(o, 3) // currentStep = 4, < 5
    o.onAgentDisconnected('source')
    expect(o.state).toBe(MigrationState.FAILED) // ROLLBACK → FAILED
    expect(onRollback).toHaveBeenCalled()
  })

  it('target disconnect after step 5 → critical_alert, stays in MIGRATING', () => {
    const o = new MigrationOrchestrator('s')
    const onAlert = vi.fn()
    o.on('critical_alert', onAlert)
    driveToMigrating(o)
    for (let step = 1; step <= 5; step += 1) ackStep(o, step)
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
    for (let step = 1; step <= 5; step += 1) ackStep(o, step)
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
    expect(() => o.onStepComplete(1, 'source', okResult)).not.toThrow()
    expect(o.state).toBe(MigrationState.FAILED)
  })
})

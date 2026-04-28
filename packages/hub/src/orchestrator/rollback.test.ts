import { describe, it, expect } from 'vitest'
import {
  shouldRollback,
  getRollbackSteps,
  ROLLBACK_STEPS,
  type RollbackStep,
} from './rollback.js'

describe('rollback / shouldRollback', () => {
  it('returns false for step 1 (no state mutation yet)', () => {
    expect(shouldRollback(1)).toBe(false)
  })

  it('returns false for non-positive step numbers (defensive)', () => {
    expect(shouldRollback(0)).toBe(false)
    expect(shouldRollback(-1)).toBe(false)
  })

  it('returns true for steps 2 through 9', () => {
    for (let step = 2; step <= 9; step += 1) {
      expect(shouldRollback(step)).toBe(true)
    }
  })
})

describe('rollback / getRollbackSteps', () => {
  it('returns an empty array when rollback is not required', () => {
    expect(getRollbackSteps(1)).toEqual([])
  })

  it('returns the full 4-step rollback sequence when failed at step 4', () => {
    const steps = getRollbackSteps(4)
    expect(steps).toHaveLength(4)
    expect(steps.map((s) => s.name)).toEqual([
      'restore_source_identity',
      'readd_authorized_voter_source',
      'remove_transferred_files_target',
      'verify_source_voting',
    ])
  })

  it('returns the full sequence regardless of which post-step-2 step failed', () => {
    for (let step = 2; step <= 9; step += 1) {
      const steps = getRollbackSteps(step)
      expect(steps).toHaveLength(4)
    }
  })

  it('returns a fresh array (callers may mutate without side-effects)', () => {
    const a = getRollbackSteps(5)
    const b = getRollbackSteps(5)
    expect(a).not.toBe(b)
    a.pop()
    expect(getRollbackSteps(5)).toHaveLength(4)
  })

  it('every rollback step has a defined executor and description', () => {
    const steps = getRollbackSteps(9)
    for (const s of steps) {
      expect(['source', 'target']).toContain(s.executor)
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.name.length).toBeGreaterThan(0)
    }
  })

  it('exposes ROLLBACK_STEPS as a stable readonly view', () => {
    expect(ROLLBACK_STEPS).toHaveLength(4)
    const first = ROLLBACK_STEPS[0] as RollbackStep
    expect(first.executor).toBe('source')
  })
})

import { describe, it, expect } from 'vitest'
import {
  SESSION_CODE_LENGTH,
  SESSION_TTL_MS,
  MIGRATION_STEPS,
  TOWER_FILE_REGEX,
  DEFAULT_HUB_HTTP_PORT,
  DEFAULT_HUB_WS_PORT,
  HEARTBEAT_INTERVAL_MS,
  PAIRING_RECONNECT_MAX_ATTEMPTS,
} from './constants.js'

describe('SESSION_CODE_LENGTH', () => {
  it('equals 6', () => {
    expect(SESSION_CODE_LENGTH).toBe(6)
  })
})

describe('SESSION_TTL_MS', () => {
  it('equals 5 minutes in milliseconds', () => {
    expect(SESSION_TTL_MS).toBe(5 * 60_000)
    expect(SESSION_TTL_MS).toBe(300_000)
  })
})

describe('MIGRATION_STEPS', () => {
  it('has exactly 9 steps', () => {
    expect(MIGRATION_STEPS.length).toBe(9)
  })

  it('numbers are 1..9 in order', () => {
    expect(MIGRATION_STEPS.map((s) => s.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it('every step has executor of "source" or "target"', () => {
    for (const step of MIGRATION_STEPS) {
      expect(['source', 'target']).toContain(step.executor)
    }
  })

  it('every step has a non-empty name string', () => {
    for (const step of MIGRATION_STEPS) {
      expect(typeof step.name).toBe('string')
      expect(step.name.length).toBeGreaterThan(0)
    }
  })

  it('step names are unique', () => {
    const names = MIGRATION_STEPS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('TOWER_FILE_REGEX', () => {
  it('matches well-formed tower file: tower-1_9-Abc123.bin', () => {
    expect(TOWER_FILE_REGEX.test('tower-1_9-Abc123.bin')).toBe(true)
  })

  it('does NOT match tower-1_8-Abc.bin (wrong version)', () => {
    expect(TOWER_FILE_REGEX.test('tower-1_8-Abc.bin')).toBe(false)
  })

  it('does NOT match tower-1_9-.bin (empty pubkey portion)', () => {
    expect(TOWER_FILE_REGEX.test('tower-1_9-.bin')).toBe(false)
  })

  it('does NOT match completely unrelated names', () => {
    expect(TOWER_FILE_REGEX.test('random.bin')).toBe(false)
    expect(TOWER_FILE_REGEX.test('')).toBe(false)
    expect(TOWER_FILE_REGEX.test('tower.bin')).toBe(false)
  })
})

describe('hub default ports', () => {
  it('DEFAULT_HUB_HTTP_PORT is a number in [1024, 65535]', () => {
    expect(typeof DEFAULT_HUB_HTTP_PORT).toBe('number')
    expect(Number.isInteger(DEFAULT_HUB_HTTP_PORT)).toBe(true)
    expect(DEFAULT_HUB_HTTP_PORT).toBeGreaterThanOrEqual(1024)
    expect(DEFAULT_HUB_HTTP_PORT).toBeLessThanOrEqual(65535)
  })

  it('DEFAULT_HUB_WS_PORT is a number in [1024, 65535]', () => {
    expect(typeof DEFAULT_HUB_WS_PORT).toBe('number')
    expect(Number.isInteger(DEFAULT_HUB_WS_PORT)).toBe(true)
    expect(DEFAULT_HUB_WS_PORT).toBeGreaterThanOrEqual(1024)
    expect(DEFAULT_HUB_WS_PORT).toBeLessThanOrEqual(65535)
  })

  it('HTTP and WS ports differ', () => {
    expect(DEFAULT_HUB_HTTP_PORT).not.toBe(DEFAULT_HUB_WS_PORT)
  })
})

describe('heartbeat / reconnect tunables', () => {
  it('HEARTBEAT_INTERVAL_MS > 0', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('PAIRING_RECONNECT_MAX_ATTEMPTS > 0', () => {
    expect(PAIRING_RECONNECT_MAX_ATTEMPTS).toBeGreaterThan(0)
    expect(Number.isInteger(PAIRING_RECONNECT_MAX_ATTEMPTS)).toBe(true)
  })
})

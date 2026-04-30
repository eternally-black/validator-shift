import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validateTowerFile } from './validator.js'

let workdir: string
let towerPath: string

function makeTower(size: number, ageMs = 0): void {
  writeFileSync(towerPath, randomBytes(size))
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000
    utimesSync(towerPath, t, t)
  }
}

describe('validateTowerFile', () => {
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vs-tower-test-'))
    towerPath = join(workdir, 'tower-1_9-fakepubkey.bin')
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('rejects a missing file', () => {
    const r = validateTowerFile(join(workdir, 'nope.bin'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/i)
  })

  it('rejects an empty file', () => {
    makeTower(0)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too small/i)
  })

  it('rejects a 1-byte file as too small', () => {
    makeTower(1)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too small/i)
  })

  it('accepts a fresh, plausibly-sized file', () => {
    makeTower(256)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
  })

  it('rejects an oversized file (>10 KB)', () => {
    makeTower(20 * 1024)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too large/i)
  })

  it('rejects a stale file older than 7 days', () => {
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000
    makeTower(256, eightDaysMs)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/days old/i)
  })

  it('accepts a file at the lower size boundary', () => {
    makeTower(100)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(true)
  })

  it('accepts a file at the upper size boundary', () => {
    makeTower(10 * 1024)
    const r = validateTowerFile(towerPath)
    expect(r.ok).toBe(true)
  })
})

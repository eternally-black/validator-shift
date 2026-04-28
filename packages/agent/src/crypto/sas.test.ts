import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { deriveSAS, NATO_ALPHABET } from './sas.js'

const SAS_FORMAT = /^[A-Z]+-[A-Z]+-[A-Z]+$/

describe('NATO_ALPHABET', () => {
  it('contains exactly 26 entries', () => {
    expect(NATO_ALPHABET.length).toBe(26)
  })

  it('every entry is uppercase letters only', () => {
    for (const word of NATO_ALPHABET) {
      expect(word).toMatch(/^[A-Z]+$/)
    }
  })
})

describe('deriveSAS', () => {
  it('returns a 3-word hyphenated uppercase string', () => {
    const sas = deriveSAS(new Uint8Array(32).fill(0x42))
    expect(sas).toMatch(SAS_FORMAT)
    expect(sas.split('-').length).toBe(3)
  })

  it('every word is from the NATO alphabet', () => {
    const sas = deriveSAS(new Uint8Array(32).fill(0x99))
    for (const word of sas.split('-')) {
      expect(NATO_ALPHABET).toContain(word)
    }
  })

  it('is deterministic: same secret produces the same SAS', () => {
    const secret = new Uint8Array(32)
    for (let i = 0; i < 32; i++) secret[i] = i
    const a = deriveSAS(secret)
    const b = deriveSAS(secret)
    expect(a).toBe(b)
  })

  it('different secrets produce different SAS over 100 random samples', () => {
    const seen = new Map<string, Buffer>()
    let collisions = 0
    for (let i = 0; i < 100; i++) {
      const secret = new Uint8Array(randomBytes(32))
      const sas = deriveSAS(secret)
      expect(sas).toMatch(SAS_FORMAT)
      const prev = seen.get(sas)
      if (prev && !prev.equals(Buffer.from(secret))) {
        collisions++
      }
      seen.set(sas, Buffer.from(secret))
    }
    // 26^3 = 17576 possible SAS values; collisions across 100 random samples
    // should be vanishingly rare. Allow a tiny margin to keep the test stable.
    expect(collisions).toBeLessThanOrEqual(1)
  })

  it('flipping a single bit in the secret changes the SAS', () => {
    const secret = new Uint8Array(32).fill(0x10)
    const a = deriveSAS(secret)
    secret[0] ^= 0x01
    const b = deriveSAS(secret)
    expect(a).not.toBe(b)
  })
})

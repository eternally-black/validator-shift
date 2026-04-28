import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  deriveSharedSecret,
  deriveSessionKey,
} from './exchange.js'

describe('exchange — X25519 key exchange', () => {
  it('generates 32-byte public and secret keys', () => {
    const kp = generateKeyPair()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.secretKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.secretKey.length).toBe(32)
  })

  it('produces different keypairs on each call', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    expect(Buffer.from(a.secretKey).equals(Buffer.from(b.secretKey))).toBe(
      false,
    )
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(
      false,
    )
  })

  it('derives a 32-byte shared secret', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const shared = deriveSharedSecret(a.secretKey, b.publicKey)
    expect(shared).toBeInstanceOf(Uint8Array)
    expect(shared.length).toBe(32)
  })

  it('symmetric DH: a→b shared secret equals b→a shared secret', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const sharedAB = deriveSharedSecret(a.secretKey, b.publicKey)
    const sharedBA = deriveSharedSecret(b.secretKey, a.publicKey)
    expect(Buffer.from(sharedAB).equals(Buffer.from(sharedBA))).toBe(true)
  })

  it('rejects invalid key lengths', () => {
    expect(() =>
      deriveSharedSecret(new Uint8Array(16), new Uint8Array(32)),
    ).toThrow()
    expect(() =>
      deriveSharedSecret(new Uint8Array(32), new Uint8Array(16)),
    ).toThrow()
  })
})

describe('deriveSessionKey — HKDF-SHA256', () => {
  const shared = new Uint8Array(32).fill(7)

  it('returns a 32-byte key', () => {
    const k = deriveSessionKey(shared, 'session-1')
    expect(k.length).toBe(32)
  })

  it('is deterministic for the same input and info', () => {
    const k1 = deriveSessionKey(shared, 'session-1')
    const k2 = deriveSessionKey(shared, 'session-1')
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true)
  })

  it('different info strings produce different keys', () => {
    const k1 = deriveSessionKey(shared, 'session-1')
    const k2 = deriveSessionKey(shared, 'session-2')
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false)
  })

  it('different shared secrets produce different keys', () => {
    const s1 = new Uint8Array(32).fill(1)
    const s2 = new Uint8Array(32).fill(2)
    const k1 = deriveSessionKey(s1, 'info')
    const k2 = deriveSessionKey(s2, 'info')
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false)
  })

  it('integrates: both peers derive the same session key from DH output', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const sharedA = deriveSharedSecret(a.secretKey, b.publicKey)
    const sharedB = deriveSharedSecret(b.secretKey, a.publicKey)
    const keyA = deriveSessionKey(sharedA, 'transfer')
    const keyB = deriveSessionKey(sharedB, 'transfer')
    expect(Buffer.from(keyA).equals(Buffer.from(keyB))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import {
  encrypt,
  decrypt,
  encodePayload,
  decodePayload,
  CryptoError,
} from './encrypt.js'

const KEY = new Uint8Array(32).fill(0xab)

describe('encrypt / decrypt — XChaCha20-Poly1305', () => {
  it('round-trips an arbitrary plaintext', () => {
    const plaintext = new TextEncoder().encode('hello validator-shift')
    const { ciphertext, nonce } = encrypt(plaintext, KEY)
    const decrypted = decrypt(ciphertext, nonce, KEY)
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true)
  })

  it('round-trips an empty plaintext', () => {
    const plaintext = new Uint8Array(0)
    const { ciphertext, nonce } = encrypt(plaintext, KEY)
    const decrypted = decrypt(ciphertext, nonce, KEY)
    expect(decrypted.length).toBe(0)
  })

  it('produces a 24-byte nonce', () => {
    const { nonce } = encrypt(new Uint8Array([1, 2, 3]), KEY)
    expect(nonce.length).toBe(24)
  })

  it('two encryptions of the same plaintext produce different ciphertexts (nonce randomness)', () => {
    const pt = new Uint8Array([1, 2, 3, 4, 5])
    const a = encrypt(pt, KEY)
    const b = encrypt(pt, KEY)
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false)
    expect(
      Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext)),
    ).toBe(false)
  })

  it('throws CryptoError when ciphertext is modified', () => {
    const pt = new TextEncoder().encode('tamper-me')
    const { ciphertext, nonce } = encrypt(pt, KEY)
    ciphertext[0] ^= 0xff
    expect(() => decrypt(ciphertext, nonce, KEY)).toThrow(CryptoError)
  })

  it('throws CryptoError when nonce is modified', () => {
    const pt = new TextEncoder().encode('tamper-nonce')
    const { ciphertext, nonce } = encrypt(pt, KEY)
    nonce[0] ^= 0xff
    expect(() => decrypt(ciphertext, nonce, KEY)).toThrow(CryptoError)
  })

  it('throws CryptoError when key is wrong', () => {
    const pt = new TextEncoder().encode('wrong-key')
    const { ciphertext, nonce } = encrypt(pt, KEY)
    const wrongKey = new Uint8Array(32).fill(0x01)
    expect(() => decrypt(ciphertext, nonce, wrongKey)).toThrow(CryptoError)
  })

  it('throws CryptoError on bad key length for encrypt', () => {
    expect(() =>
      encrypt(new Uint8Array([1]), new Uint8Array(16)),
    ).toThrow(CryptoError)
  })

  it('throws CryptoError on bad nonce length for decrypt', () => {
    expect(() =>
      decrypt(new Uint8Array(16), new Uint8Array(12), KEY),
    ).toThrow(CryptoError)
  })
})

describe('encodePayload / decodePayload', () => {
  it('round-trips through the base64 string format', () => {
    const pt = new TextEncoder().encode('encode me')
    const payload = encrypt(pt, KEY)
    const encoded = encodePayload(payload)
    expect(typeof encoded).toBe('string')
    expect(encoded.includes('.')).toBe(true)
    const decoded = decodePayload(encoded)
    expect(
      Buffer.from(decoded.ciphertext).equals(Buffer.from(payload.ciphertext)),
    ).toBe(true)
    expect(Buffer.from(decoded.nonce).equals(Buffer.from(payload.nonce))).toBe(
      true,
    )
    const decrypted = decrypt(decoded.ciphertext, decoded.nonce, KEY)
    expect(Buffer.from(decrypted).equals(Buffer.from(pt))).toBe(true)
  })

  it('throws CryptoError on a malformed string (no separator)', () => {
    expect(() => decodePayload('no-dot-here')).toThrow(CryptoError)
  })

  it('throws CryptoError on empty segments', () => {
    expect(() => decodePayload('.abc')).toThrow(CryptoError)
    expect(() => decodePayload('abc.')).toThrow(CryptoError)
  })
})

import { randomBytes } from 'node:crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

export interface EncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
}

const NONCE_LENGTH = 24
const KEY_LENGTH = 32

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new CryptoError(`key must be ${KEY_LENGTH} bytes`)
  }
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== NONCE_LENGTH) {
    throw new CryptoError(`nonce must be ${NONCE_LENGTH} bytes`)
  }
}

/**
 * Encrypt a plaintext with XChaCha20-Poly1305 using a freshly generated 24-byte
 * random nonce. The returned ciphertext includes the Poly1305 authentication tag.
 */
export function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): EncryptedPayload {
  assertKey(key)
  const nonce = new Uint8Array(randomBytes(NONCE_LENGTH))
  const cipher = xchacha20poly1305(key, nonce)
  const ciphertext = cipher.encrypt(plaintext)
  return { ciphertext, nonce }
}

/**
 * Decrypt an XChaCha20-Poly1305 ciphertext. Throws CryptoError if the auth tag
 * is invalid (i.e. the ciphertext or nonce was tampered with).
 */
export function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  assertKey(key)
  assertNonce(nonce)
  try {
    const cipher = xchacha20poly1305(key, nonce)
    return cipher.decrypt(ciphertext)
  } catch (err) {
    throw new CryptoError(
      `decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

/**
 * Encode an encrypted payload as `base64(nonce).base64(ciphertext)`.
 */
export function encodePayload(payload: EncryptedPayload): string {
  return `${toBase64(payload.nonce)}.${toBase64(payload.ciphertext)}`
}

/**
 * Decode the string format produced by `encodePayload`.
 */
export function decodePayload(s: string): EncryptedPayload {
  const idx = s.indexOf('.')
  if (idx < 0) {
    throw new CryptoError('invalid payload format: missing separator')
  }
  const nonceB64 = s.slice(0, idx)
  const ctB64 = s.slice(idx + 1)
  if (!nonceB64 || !ctB64) {
    throw new CryptoError('invalid payload format: empty segment')
  }
  const nonce = fromBase64(nonceB64)
  const ciphertext = fromBase64(ctB64)
  if (nonce.length !== NONCE_LENGTH) {
    throw new CryptoError('invalid payload format: bad nonce length')
  }
  return { ciphertext, nonce }
}

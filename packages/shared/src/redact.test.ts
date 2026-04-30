import { describe, it, expect } from 'vitest'
import {
  redactSecrets,
  hasLongToken,
  sanitizeErrorMessage,
  isValidSessionCode,
} from './redact.js'

// A canonical Solana keypair file is a JSON array of 64 bytes.
const KEYPAIR_JSON = `[${Array(64).fill(0).map((_, i) => i).join(',')}]`

// 64 random-ish base58 chars (Solana secret-key rendering uses base58 too).
const BASE58_KEY = '5Kj7QZN1QvQRxmvTtdoXGN8wKqRJqAEnZqKR6BsX9pTuWv2DJTaQR1nXhKy3Yks'
// 88 base64 chars (64 raw bytes encoded — typical Solana b64 secret key).
const BASE64_KEY =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('redactSecrets', () => {
  it('redacts a 64-byte JSON keypair array', () => {
    const out = redactSecrets(`secret=${KEYPAIR_JSON} done`)
    expect(out).not.toContain(KEYPAIR_JSON)
    expect(out).toMatch(/REDACTED:secret-bytes/)
  })

  it('redacts a long base64 run', () => {
    const out = redactSecrets(`payload: ${BASE64_KEY} end`)
    expect(out).not.toContain(BASE64_KEY)
    expect(out).toMatch(/REDACTED:base64/)
  })

  it('redacts a 60-char alphanumeric token via the long-token catchall', () => {
    const out = redactSecrets(`tok: ${BASE58_KEY} end`)
    expect(out).not.toContain(BASE58_KEY)
    expect(out).toMatch(/REDACTED/)
  })

  it('preserves short non-secret content', () => {
    const out = redactSecrets('step 1 (wait_for_restart_window) complete')
    expect(out).toBe('step 1 (wait_for_restart_window) complete')
  })

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('')
  })

  it('redacts a keypair embedded mid-stack-trace', () => {
    const stack = `Error: failed at\n  at run (file.ts:1:1)\n  data=${BASE58_KEY}\n  at next`
    const out = redactSecrets(stack)
    expect(out).not.toContain(BASE58_KEY)
  })

  it('redacts multiple long tokens in one string', () => {
    const out = redactSecrets(`a=${BASE58_KEY} b=${BASE58_KEY} done`)
    expect(out.match(/REDACTED/g)?.length).toBeGreaterThanOrEqual(2)
    expect(out).not.toContain(BASE58_KEY)
  })
})

describe('hasLongToken', () => {
  it('flags a 40-char alphanumeric run', () => {
    expect(hasLongToken('A'.repeat(40))).toBe(true)
  })

  it('does not flag a 39-char run', () => {
    expect(hasLongToken('A'.repeat(39))).toBe(false)
  })

  it('flags a base58 secret key', () => {
    expect(hasLongToken(`prefix ${BASE58_KEY} suffix`)).toBe(true)
  })

  it('does not flag a 6-char session code', () => {
    expect(hasLongToken('ABC123')).toBe(false)
  })

  it('does not flag a 64-char hex with hyphens (would be broken into pieces)', () => {
    // SHA-256 hex (no separators) is 64 chars and DOES match — that's
    // intentional; SHA hex is hard to distinguish from secret-encoded
    // base16 without context, and over-redacting hashes is acceptable
    // (hashes are still useful as redacted markers).
    expect(hasLongToken('abc123def456'.repeat(6))).toBe(true)
    // With dashes inserted, runs are short enough — not flagged.
    const dashed = 'abc-123-def-456-abc-123-def-456-abc-123-def-456-abc-123-def-456'
    expect(hasLongToken(dashed)).toBe(false)
  })
})

describe('sanitizeErrorMessage', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })

  it('takes only the first line', () => {
    expect(sanitizeErrorMessage('first\nsecond\nthird')).toBe('first')
  })

  it('truncates at 200 chars', () => {
    // Build a long benign message — words separated by spaces so no
    // single contiguous run trips the long-token detector.
    const long = ('lorem ipsum '.repeat(50)).trim()
    expect(long.length).toBeGreaterThan(200)
    const out = sanitizeErrorMessage(long)
    expect(out.length).toBeLessThanOrEqual(201) // 200 + ellipsis
    expect(out).toContain('…')
  })

  it('replaces the whole message if it contains a long token', () => {
    const out = sanitizeErrorMessage(`failed: ${BASE58_KEY}`)
    expect(out).not.toContain(BASE58_KEY)
    expect(out).toMatch(/long token/i)
  })

  it('preserves a clean error message verbatim', () => {
    const msg = 'tower file not found at /home/sol/ledger/tower-1_9-X.bin'
    expect(sanitizeErrorMessage(msg)).toBe(msg)
  })

  it('catches a keypair embedded in an Error.message simulation', () => {
    const e = new Error(
      `validator unreachable: identity=${BASE58_KEY} status=500`,
    )
    expect(sanitizeErrorMessage(e.message)).not.toContain(BASE58_KEY)
  })
})

describe('isValidSessionCode', () => {
  it('accepts a 6-char [A-Z0-9] code', () => {
    expect(isValidSessionCode('ABC123')).toBe(true)
  })

  it('rejects lowercase', () => {
    expect(isValidSessionCode('abc123')).toBe(false)
  })

  it('rejects non-6-length', () => {
    expect(isValidSessionCode('ABC12')).toBe(false)
    expect(isValidSessionCode('ABC1234')).toBe(false)
  })

  it('rejects punctuation', () => {
    expect(isValidSessionCode('ABC-12')).toBe(false)
  })

  it('rejects Unicode lookalikes (Cyrillic А)', () => {
    expect(isValidSessionCode('А' + 'BC123')).toBe(false)
  })
})

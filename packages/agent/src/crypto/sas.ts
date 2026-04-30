import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

/**
 * Short Authentication String — derived from the X25519 shared secret and
 * displayed simultaneously in both terminals. Operators visually compare
 * the two and confirm they match; this defeats a man-in-the-middle who
 * has otherwise terminated both legs of the WebSocket relay (because the
 * MITM cannot produce a SAS that matches both legitimate ends).
 *
 * Format: `XXX-XXX` — 6 decimal digits in two groups. 10^6 = 1,000,000
 * possible values ≈ 19.93 bits of entropy, which exceeds the 20-bit
 * baseline used by Signal / WhatsApp safety numbers. Decimal was chosen
 * over phonetic words because operators verify it across two terminals
 * 1-2 seconds — digits read faster and have lower mis-read rates than
 * 6 phonetic words.
 *
 * The previous implementation used 3 NATO words (~14.1 bits, 26^3 ≈ 17.5k
 * values). The HKDF info tag is bumped to v2 to ensure outputs from the
 * old and new code never collide for the same shared secret.
 */
const SAS_INFO = 'validator-shift-sas-v2'

/** Number of decimal digits rendered. 6 → 10^6 = 1,000,000 ≈ 19.93 bits. */
const SAS_DIGITS = 6

/** Number of HKDF output bytes consumed. 4 bytes = 32 bits, plenty for 6 decimal digits. */
const SAS_HKDF_BYTES = 4

/**
 * Derive the Short Authentication String from the X25519 shared secret.
 *
 * Determinism: identical secret → identical SAS on both sides. HKDF-SHA256
 * with a fixed info tag means an attacker cannot bias the output without
 * compromising the underlying KEX.
 */
export function deriveSAS(sharedSecret: Uint8Array): string {
  const infoBytes = new TextEncoder().encode(SAS_INFO)
  const bytes = hkdf(
    sha256,
    sharedSecret,
    new Uint8Array(0),
    infoBytes,
    SAS_HKDF_BYTES,
  )
  // Big-endian read of the 4 HKDF bytes into a 32-bit unsigned integer,
  // then modulo 10^SAS_DIGITS to land in [0, 1_000_000). We use `>>> 0`
  // to keep the shift unsigned (JS bit ops are 32-bit signed otherwise).
  const n =
    (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0)
  const modulus = 10 ** SAS_DIGITS
  const code = (n % modulus).toString().padStart(SAS_DIGITS, '0')
  // Group into XXX-XXX for easier visual comparison across terminals.
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

/**
 * Strict format check used in tests and at message boundaries. Matches
 * exactly six digits in two hyphen-separated groups of three.
 */
export const SAS_FORMAT = /^\d{3}-\d{3}$/

/**
 * Number of bits of entropy in the rendered SAS. Exposed for documentation
 * and audit-log use, not for any runtime decision.
 */
export const SAS_BITS = Math.log2(10 ** SAS_DIGITS)

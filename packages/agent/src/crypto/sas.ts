import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

/**
 * NATO phonetic alphabet — used to render the Short Authentication String
 * derived from the shared secret. 26 entries, indexed by `byte % 26`.
 */
export const NATO_ALPHABET: readonly string[] = [
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIET',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
  'QUEBEC',
  'ROMEO',
  'SIERRA',
  'TANGO',
  'UNIFORM',
  'VICTOR',
  'WHISKEY',
  'XRAY',
  'YANKEE',
  'ZULU',
] as const

const SAS_INFO = 'validator-shift-sas-v1'
const SAS_WORDS = 3

/**
 * Derive a 3-word Short Authentication String from the shared secret using
 * HKDF-SHA256 with a fixed `info` tag. The two operators verify that the SAS
 * matches on both terminals to defeat man-in-the-middle attacks during pairing.
 */
export function deriveSAS(sharedSecret: Uint8Array): string {
  const infoBytes = new TextEncoder().encode(SAS_INFO)
  const bytes = hkdf(
    sha256,
    sharedSecret,
    new Uint8Array(0),
    infoBytes,
    SAS_WORDS,
  )
  const words: string[] = []
  for (let i = 0; i < SAS_WORDS; i++) {
    const idx = bytes[i]! % NATO_ALPHABET.length
    words.push(NATO_ALPHABET[idx]!)
  }
  return words.join('-')
}

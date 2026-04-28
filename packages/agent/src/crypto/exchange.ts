import nacl from 'tweetnacl'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/**
 * Generate an X25519 keypair for ECDH key exchange.
 * Wraps tweetnacl's nacl.box.keyPair (Curve25519).
 */
export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

/**
 * Compute the X25519 shared secret given our secret key and the peer's public key.
 * Returns 32 raw bytes (the precomputed shared key from `nacl.box.before`).
 */
export function deriveSharedSecret(
  mySecret: Uint8Array,
  peerPublic: Uint8Array,
): Uint8Array {
  if (mySecret.length !== 32) {
    throw new Error('mySecret must be 32 bytes')
  }
  if (peerPublic.length !== 32) {
    throw new Error('peerPublic must be 32 bytes')
  }
  return nacl.box.before(peerPublic, mySecret)
}

/**
 * HKDF-SHA256 derivation of a 32-byte session key from the shared secret.
 * Uses an empty salt and the supplied `info` parameter as domain separation.
 */
export function deriveSessionKey(
  sharedSecret: Uint8Array,
  info: string,
): Uint8Array {
  const infoBytes = new TextEncoder().encode(info)
  return hkdf(sha256, sharedSecret, new Uint8Array(0), infoBytes, 32)
}

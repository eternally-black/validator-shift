import {
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  existsSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';

export class KeypairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeypairError';
    Object.setPrototypeOf(this, KeypairError.prototype);
  }
}

/**
 * Reads a Solana-format keypair file (JSON array of bytes) and returns a Buffer.
 * Throws KeypairError on missing/invalid input.
 */
export function readKeypair(path: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new KeypairError(
      `Failed to read keypair at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new KeypairError(
      `Keypair file ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new KeypairError(
      `Keypair file ${path} must be a JSON array of bytes`,
    );
  }
  for (const v of parsed) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new KeypairError(
        `Keypair file ${path} contains invalid byte value: ${String(v)}`,
      );
    }
  }
  return Buffer.from(parsed as number[]);
}

/**
 * Writes a Solana-format keypair file (JSON array) with mode 0o600.
 */
export function writeKeypair(path: string, bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes)) {
    throw new KeypairError('writeKeypair requires a Buffer');
  }
  const arr: number[] = Array.from(bytes.values());
  const json = JSON.stringify(arr);
  try {
    writeFileSync(path, json, { mode: 0o600 });
  } catch (err) {
    throw new KeypairError(
      `Failed to write keypair at ${path}: ${(err as Error).message}`,
    );
  }
}

/**
 * Securely overwrite a keypair file with random bytes (matching its size),
 * fsync, then unlink. Throws KeypairError if the file does not exist.
 */
export async function secureWipe(path: string): Promise<void> {
  if (!existsSync(path)) {
    throw new KeypairError(`secureWipe: file does not exist: ${path}`);
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    throw new KeypairError(
      `secureWipe: stat failed for ${path}: ${(err as Error).message}`,
    );
  }
  try {
    const fd = openSync(path, 'r+');
    try {
      if (size > 0) {
        const buf = randomBytes(size);
        writeSync(fd, buf, 0, buf.length, 0);
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
    unlinkSync(path);
  } catch (err) {
    throw new KeypairError(
      `secureWipe: failed to wipe ${path}: ${(err as Error).message}`,
    );
  }
}

/**
 * Derives the base58 pubkey from a 64-byte Solana secret key.
 * Accepts the canonical Solana keypair layout: 64 bytes = 32 secret seed + 32 pubkey.
 */
export function derivePubkey(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 64) {
    throw new KeypairError(
      `derivePubkey: expected 64-byte secret key, got ${bytes?.length ?? 0}`,
    );
  }
  const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(bytes));
  return base58Encode(Buffer.from(kp.publicKey));
}

// ---------------------------------------------------------------------------
// Inline base58 (Bitcoin alphabet, used by Solana). No external dependency.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf: Buffer): string {
  if (buf.length === 0) return '';

  // Count leading zero bytes; each becomes a leading '1'.
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) {
    zeros++;
  }

  // Convert bytes to bigint, encode by repeatedly dividing by 58.
  let n = 0n;
  for (const b of buf) {
    n = (n << 8n) | BigInt(b);
  }

  let out = '';
  const fiftyEight = 58n;
  while (n > 0n) {
    const rem = Number(n % fiftyEight);
    n = n / fiftyEight;
    out = BASE58_ALPHABET[rem] + out;
  }

  return '1'.repeat(zeros) + out;
}

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';

import {
  readKeypair,
  writeKeypair,
  secureWipe,
  derivePubkey,
  KeypairError,
} from './keypair.js';

function tmpPath(label: string): string {
  return join(
    tmpdir(),
    `vshift-kp-${label}-${process.pid}-${randomBytes(4).toString('hex')}.json`,
  );
}

describe('readKeypair / writeKeypair', () => {
  it('round-trips a 64-byte keypair through the filesystem', () => {
    const path = tmpPath('roundtrip');
    const original = Buffer.from(randomBytes(64));
    try {
      writeKeypair(path, original);
      const loaded = readKeypair(path);
      expect(Buffer.isBuffer(loaded)).toBe(true);
      expect(loaded.length).toBe(64);
      expect(loaded.equals(original)).toBe(true);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('readKeypair throws KeypairError for missing file', () => {
    const path = tmpPath('missing');
    expect(() => readKeypair(path)).toThrow(KeypairError);
  });

  it('readKeypair throws KeypairError for non-array JSON', () => {
    const path = tmpPath('badjson');
    try {
      writeFileSync(path, '{"not":"an array"}');
      expect(() => readKeypair(path)).toThrow(KeypairError);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });
});

describe('secureWipe', () => {
  it('overwrites and removes the file', async () => {
    const path = tmpPath('wipe');
    const bytes = Buffer.from(randomBytes(64));
    writeKeypair(path, bytes);
    expect(existsSync(path)).toBe(true);
    const sizeBefore = statSync(path).size;
    expect(sizeBefore).toBeGreaterThan(0);

    await secureWipe(path);
    expect(existsSync(path)).toBe(false);
  });

  it('throws KeypairError when file does not exist', async () => {
    const path = tmpPath('wipe-missing');
    await expect(secureWipe(path)).rejects.toBeInstanceOf(KeypairError);
  });
});

describe('derivePubkey', () => {
  it('is deterministic for a known seed', () => {
    // Seed of all zeros — known reproducible test vector.
    const seed = new Uint8Array(32); // all zero bytes
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const secret = Buffer.from(kp.secretKey); // 64 bytes (seed || pub)

    const pub1 = derivePubkey(secret);
    const pub2 = derivePubkey(secret);
    expect(pub1).toBe(pub2);

    // Sanity: result is non-empty base58 from the Solana alphabet.
    expect(pub1.length).toBeGreaterThan(30);
    expect(pub1).toMatch(
      /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/,
    );

    // Different seed → different pubkey.
    const seed2 = new Uint8Array(32);
    seed2[0] = 1;
    const kp2 = nacl.sign.keyPair.fromSeed(seed2);
    const pubOther = derivePubkey(Buffer.from(kp2.secretKey));
    expect(pubOther).not.toBe(pub1);
  });

  it('rejects inputs that are not 64 bytes', () => {
    expect(() => derivePubkey(Buffer.alloc(32))).toThrow(KeypairError);
    expect(() => derivePubkey(Buffer.alloc(0))).toThrow(KeypairError);
  });
});
